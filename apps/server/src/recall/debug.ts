import { randomUUID } from 'node:crypto'

import type {
  BootPreview,
  BootPreviewRequest,
  LifecycleProject,
  RecallDebug,
  RecallDebugRequest,
  SessionContextInput,
} from '@kioku/contracts'
import { eq, inArray } from 'drizzle-orm'

import { readDenial, type Access } from '../access/access'
import { defaultSession, resolveKeySession } from '../access/session'
import { nowOf, withCircles, type Tx } from '../db/client'
import { circles, entries } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { PROMPT_SEMANTIC_TIMEOUT_MS, recallBlock, sessionStart } from '../lifecycle/lifecycle'
import { accessForKey, recallScopeForKey, semanticFor } from '../memory/context'
import { visibleCircleSlug } from '../memory/links'
import { parseEntryFacts } from '../memory/service'
import { loadClientSettings, weightsOf } from '../settings/advanced'
import { CHAT_FAMILIES } from '../lifecycle/lifecycle'
import { bootEntryChars, bootHeading, OMITTED_TITLES } from './boot'
import {
  normalizeQuery,
  publicCandidate,
  scoreRecall,
  scoreRecallWithMeta,
  type ScoredCandidate,
} from './recall'

const DEBUG_LIMIT = 30

export async function bootPreview(
  deps: Deps,
  key: KeyPrincipal,
  request: BootPreviewRequest,
  options: { context?: SessionContextInput } = {},
): Promise<BootPreview> {
  const session = options.context
    ? await resolveKeySession(deps, key, options.context)
    : defaultSession(key)
  const scope = recallScopeForKey(deps, key, session, {
    ...(request.deviceKey !== undefined ? { deviceKey: request.deviceKey } : {}),
    ...(request.project !== undefined ? { project: request.project } : {}),
    recordEvents: false,
  })
  const start = await sessionStart(scope, key.client.runtimeFamily, {
    project: request.project,
    sessionId: request.sessionId ?? randomUUID(),
  })
  const resolvedFacets = await scope.focus()
  return {
    runtimeFamily: key.client.runtimeFamily,
    limit: start.limit,
    context: start.context,
    resolvedFacets,
    personaTraits: start.boot.personaTraits,
    entries: start.boot.entries.map((e) => ({
      shortId: e.shortId,
      title: e.title,
      circleId: e.circleId,
      circleSlug: e.circleSlug,
      chars: bootEntryChars(bootHeading(e.shortId, e.title), e.content),
    })),
    omitted: start.boot.omitted.map((shortId, i) => ({
      shortId,
      title: start.boot[OMITTED_TITLES][i] ?? '',
    })),
    summaries: start.summaries,
    recent: start.recent,
    related: start.related,
    dropped: start.dropped,
  }
}

export async function recallDebug(
  deps: Deps,
  key: KeyPrincipal,
  memberAccess: Access,
  request: RecallDebugRequest,
  options: { project?: LifecycleProject; context?: SessionContextInput } = {},
): Promise<RecallDebug> {
  const query = normalizeQuery(request.query)
  const session = options.context
    ? await resolveKeySession(deps, key, options.context)
    : defaultSession(key)
  const keyAccess = accessForKey(key, session)
  const scope = recallScopeForKey(deps, key, session, {
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(request.facets !== undefined ? { facets: request.facets } : {}),
    crossCircle: request.crossCircle,
    recordEvents: false,
  })

  const chat = CHAT_FAMILIES.has(key.client.runtimeFamily)
  const { values } = await withCircles(deps.db, { read: [key.circleId] }, (tx) =>
    loadClientSettings(tx, key.circleId, key.client.id, chat),
  )
  const minScore = request.minScore ?? values['recall.minScore']
  const limit = request.limit ?? values['recall.limit']
  const relevanceFloor = values['recall.relevanceFloor']
  const weights = weightsOf(values)

  const [semantic, baseFocus] = await Promise.all([
    semanticFor(deps, query, PROMPT_SEMANTIC_TIMEOUT_MS, key.circleId),
    scope.focus(),
  ])

  const readIds = [...new Set([...memberAccess.circles.keys(), ...keyAccess.circles.keys()])]
  const { visible, meta, filtered } = await withCircles(deps.db, { read: readIds }, async (tx) => {
    const visible = await scoreRecall(tx, memberAccess, semantic, query, {
      limit: DEBUG_LIMIT,
      minScore: 0,
      relevanceFloor: 0,
      crossCircle: request.crossCircle,
      weights,
    })
    const meta = await scoreRecallWithMeta(tx, keyAccess, semantic, query, {
      limit: DEBUG_LIMIT,
      minScore: 0,
      relevanceFloor,
      crossCircle: request.crossCircle,
      focus: baseFocus,
      weights,
    })
    const seen = new Set(meta.candidates.map((c) => c.entryId))
    const missing = visible.filter((c) => !seen.has(c.entryId)).map((c) => c.entryId)
    return { visible, meta, filtered: await explainHidden(tx, keyAccess, missing) }
  })

  void visible
  const injected = meta.candidates.filter((c) => c.rawScore >= minScore).slice(0, limit)
  const shown = new Set(injected.map((c) => c.entryId))
  const toDebug = (c: ScoredCandidate) => ({
    ...publicCandidate(c),
    breakdown: c.breakdown,
    rawScore: c.rawScore,
  })

  return {
    injected: injected.map(toDebug),
    others: meta.candidates.filter((c) => !shown.has(c.entryId)).map(toDebug),
    minScore,
    limit,
    block: await recallBlock(scope, key.client.runtimeFamily, injected.map(publicCandidate)),
    semantic: semantic !== null,
    resolvedFacets: meta.resolvedFacets,
    flippedTerms: meta.flippedTerms,
    filtered,
  }
}

async function explainHidden(
  tx: Tx,
  keyAccess: Access,
  ids: string[],
): Promise<RecallDebug['filtered']> {
  if (!ids.length) return []
  const now = nowOf(tx)
  const rows = await tx
    .select({
      entry: entries,
      circleSlug: circles.slug,
    })
    .from(entries)
    .innerJoin(circles, eq(circles.id, entries.circleId))
    .where(inArray(entries.id, ids))

  const byId = new Map(rows.map((r) => [r.entry.id, r]))
  return ids.flatMap((id) => {
    const item = byId.get(id)
    if (!item) return []
    const reason = readDenial(keyAccess, parseEntryFacts(item.entry), { now })
    if (!reason) return []
    return [
      {
        shortId: item.entry.shortId,
        title: item.entry.title,
        circleSlug: visibleCircleSlug(keyAccess, item.entry.circleId, item.circleSlug),
        kind: item.entry.kind,
        sensitivity: item.entry.sensitivity,
        reason,
      },
    ]
  })
}
