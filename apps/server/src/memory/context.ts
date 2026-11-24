import {
  DEFAULT_CIRCLE_PRIVACY,
  normalizeWhen,
  type LifecycleProject,
  type RecallCandidate,
  type WhenCondition,
} from '@kioku/contracts'
import { and, eq, inArray, or } from 'drizzle-orm'

import type { Access } from '../access/access'
import { conversationRefOf, latestSummaries } from '../access/conversations'
import { accessForKey, defaultSession, type KeySession } from '../access/session'
import { loadOutboundRedactor, maskForOutbound } from '../credential/privacy'
import { loggableError, withCircles, type Tx } from '../db/client'
import { entries, entryVariants } from '../db/schema'
import type { Embedder } from '../embedding/provider'
import type { Deps, KeyPrincipal } from '../http/env'
import { CHAT_FAMILIES } from '../lifecycle/lifecycle'
import type { RecallScope } from '../lifecycle/scope'
import { boot, recentEntries } from '../recall/boot'
import { recordRecall } from '../recall/events'
import {
  DEFAULT_MIN_SCORE,
  DEFAULT_RELEVANCE_FLOOR,
  embedQuery,
  normalizeQuery,
  publicCandidate,
  recall,
  type QueryVector,
} from '../recall/recall'
import { subjectFacts } from '../recall/subjects'
import {
  loadClientSettings,
  loadInstanceSettings,
  weightsOf,
  type EffectiveSettings,
} from '../settings/advanced'
import {
  consoleAllCirclesAccessFor,
  consoleCircleFor,
  consoleMemberFor,
  consoleRoleFor,
  entryServiceForConsole,
  entryServiceForKey,
} from './entryContext'
import {
  ensureProjectTerm,
  loadCircleVocabularies,
  normalizeProjectSlug,
  synthesizePresenceFocus,
} from './facets'
import { readableConditions } from './filter'

export {
  accessForKey,
  consoleAllCirclesAccessFor,
  consoleCircleFor,
  consoleMemberFor,
  consoleRoleFor,
  entryServiceForConsole,
  entryServiceForKey,
}

const CONSOLE_SEMANTIC_TIMEOUT_MS = 2_000

export interface RecallScopeOptions {
  deviceKey?: string | undefined
  project?: LifecycleProject | undefined
  facets?: WhenCondition | undefined
  crossCircle?: boolean | undefined
  recordEvents?: boolean | undefined
}

// 计算请求向量：嵌入设置不可用或超时时退化为 null，只走全文与关键词
export async function semanticFor(
  deps: Deps,
  query: string,
  timeoutMs?: number,
  circleId?: string,
): Promise<QueryVector | null> {
  const budgetSignal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined
  const compute = async () => {
    const embedder: Embedder | null = await deps.embedder.get().catch((err: unknown) => {
      console.warn('读取嵌入设置失败，本次召回不使用向量', loggableError(err))
      return null
    })
    const redactor = circleId
      ? await loadOutboundRedactor(deps.db, deps.masterKey ?? null, circleId, budgetSignal).catch(
          () => (text: string) => maskForOutbound(text, DEFAULT_CIRCLE_PRIVACY),
        )
      : DEFAULT_CIRCLE_PRIVACY
    return embedQuery(embedder, query, redactor)
  }
  if (timeoutMs === undefined) return compute()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      compute(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function recallForConsole(
  deps: Deps,
  circleId: string,
  access: Access,
  rawQuery: string,
  limit: number,
): Promise<RecallCandidate[]> {
  const query = normalizeQuery(rawQuery)
  if (!query) return []
  const [semantic, settings] = await Promise.all([
    semanticFor(deps, query, CONSOLE_SEMANTIC_TIMEOUT_MS, circleId),
    loadInstanceSettings(deps.db),
  ])
  const weights = weightsOf(settings.values)
  const readIds = [...access.circles.keys()]
  return withCircles(deps.db, { read: readIds }, (tx) =>
    recall(tx, access, semantic, query, { limit, minScore: 0, relevanceFloor: 0, weights }),
  )
}

export async function resolveScopeFocusIn(
  tx: Tx,
  key: KeyPrincipal,
  access: Access,
  options: {
    project?: LifecycleProject | undefined
    explicitFacets?: WhenCondition | undefined
    canWritePrimary?: boolean
  } = {},
): Promise<WhenCondition> {
  const projectSlug = await ensureProjectTerm(
    tx,
    key.circleId,
    options.project,
    options.canWritePrimary ?? false,
  )
  const vocabs = await loadCircleVocabularies(tx, [key.circleId])
  const primaryVocab = vocabs.get(key.circleId)
  return synthesizePresenceFocus({
    contextFacets: key.contextFacets,
    runtimeFamily: key.client.runtimeFamily,
    projectSlug,
    ...(options.explicitFacets ? { explicitFacets: options.explicitFacets } : {}),
    ...(primaryVocab ? { primaryDefaultFacets: primaryVocab.defaultFacets } : {}),
    primaryTerms: primaryVocab?.terms ?? [],
  })
}

export function recallScopeForKey(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession = defaultSession(key),
  options: RecallScopeOptions = {},
): RecallScope {
  const access = accessForKey(key, session)
  const readIds = [...access.circles.keys()]
  const primaryWriteAllowed = (access.circles.get(key.circleId)?.writeKinds.size ?? 0) > 0
  const shouldRegisterProject = Boolean(
    options.recordEvents !== false &&
    primaryWriteAllowed &&
    normalizeProjectSlug(options.project) &&
    !session.context.chatType,
  )
  const circleScope = shouldRegisterProject
    ? { read: readIds, write: [key.circleId] }
    : { read: readIds }

  let loaded: EffectiveSettings | undefined
  let resolvedFocus: WhenCondition | undefined
  const chat = CHAT_FAMILIES.has(key.client.runtimeFamily)
  const settingsIn = async (tx: Tx) => {
    if (loaded) return loaded
    const read = await loadClientSettings(tx, key.circleId, key.client.id, chat)
    return (loaded ??= read)
  }
  const focusIn = async (tx: Tx, overrideFacets?: WhenCondition) => {
    if (!resolvedFocus) {
      resolvedFocus = await resolveScopeFocusIn(tx, key, access, {
        project: options.project,
        explicitFacets: options.facets,
        canWritePrimary: shouldRegisterProject,
      })
    }
    if (!overrideFacets) return resolvedFocus
    const vocabs = await loadCircleVocabularies(tx, [key.circleId])
    const primaryVocab = vocabs.get(key.circleId)
    return synthesizePresenceFocus({
      contextFacets: key.contextFacets,
      runtimeFamily: key.client.runtimeFamily,
      projectSlug: normalizeProjectSlug(options.project),
      explicitFacets: overrideFacets,
      ...(primaryVocab ? { primaryDefaultFacets: primaryVocab.defaultFacets } : {}),
      primaryTerms: primaryVocab?.terms ?? [],
    })
  }
  const settings = async () => loaded ?? withCircles(deps.db, circleScope, (tx) => settingsIn(tx))
  const focus = async () => resolvedFocus ?? withCircles(deps.db, circleScope, (tx) => focusIn(tx))

  return {
    primaryCircleId: key.circleId,
    focus,
    settings,
    async recall(rawQuery, { semantic: useSemantic = true, semanticTimeoutMs, ...recallOpts }) {
      const query = normalizeQuery(rawQuery)
      if (!query) return []
      const semantic = useSemantic
        ? await semanticFor(deps, query, semanticTimeoutMs, key.circleId)
        : null
      const scored = await withCircles(deps.db, circleScope, async (tx) => {
        const [{ values }, currentFocus] = await Promise.all([
          settingsIn(tx),
          focusIn(tx, recallOpts.facets),
        ])
        const crossCircle = recallOpts.crossCircle ?? options.crossCircle ?? true
        return recall(tx, access, semantic, query, {
          ...recallOpts,
          crossCircle,
          focus: normalizeWhen(currentFocus),
          limit: recallOpts.limit ?? values['recall.limit'],
          minScore: recallOpts.minScore ?? values['recall.minScore'] ?? DEFAULT_MIN_SCORE,
          relevanceFloor:
            recallOpts.relevanceFloor ?? values['recall.relevanceFloor'] ?? DEFAULT_RELEVANCE_FLOOR,
          weights: weightsOf(values),
        })
      })
      return scored
    },
    boot: (budget) =>
      withCircles(deps.db, circleScope, async (tx) => {
        const [current, currentFocus] = await Promise.all([settingsIn(tx), focusIn(tx)])
        const charBudget =
          typeof budget === 'function'
            ? budget(current)
            : (budget ?? current.values['boot.charBudget'])
        return boot(tx, access, {
          personaId: session.personaId,
          focus: currentFocus,
          budget: charBudget,
        })
      }),
    recent: (limit) =>
      withCircles(deps.db, { read: readIds }, (tx) => recentEntries(tx, access, limit)),
    summaries: async (limit) => {
      const projectSlug = normalizeProjectSlug(options.project) ?? ''
      const ref = conversationRefOf(session.context, key.client.ownerAccountId, {
        ...(options.deviceKey !== undefined ? { deviceKey: options.deviceKey } : {}),
        projectSlug,
      })
      if (!ref) return []
      return withCircles(deps.db, { read: [key.circleId] }, (tx) =>
        latestSummaries(tx, access, key.client.id, ref, limit),
      )
    },
    subjects: async () => {
      if (!session.subjects.length) return []
      try {
        return await withCircles(deps.db, { read: [key.circleId] }, async (tx) => {
          const perSubject = (await settingsIn(tx)).values['recall.subjectFacts']
          return perSubject ? subjectFacts(tx, access, session.subjects, perSubject) : []
        })
      } catch (err) {
        console.warn('读取对象直连的事实失败', loggableError(err))
        return []
      }
    },
    contents: async (ids) => {
      if (!ids.length) return new Map()
      const rows = await withCircles(deps.db, { read: readIds }, (tx, now) =>
        tx
          .select({
            variantId: entryVariants.id,
            entryId: entryVariants.entryId,
            content: entryVariants.content,
          })
          .from(entryVariants)
          .innerJoin(entries, eq(entries.id, entryVariants.entryId))
          .where(
            and(
              or(inArray(entryVariants.id, [...ids]), inArray(entryVariants.entryId, [...ids])),
              readableConditions(access, { now }),
            ),
          ),
      )
      const map = new Map<string, string>()
      for (const r of rows) {
        if (r.content === null) continue
        map.set(r.variantId, r.content)
        if (!map.has(r.entryId)) map.set(r.entryId, r.content)
      }
      return map
    },
    record: (source, query, hits) => {
      if (options.recordEvents === false) return
      void recordRecall(deps, key, source, query, hits)
    },
  }
}

export { publicCandidate }
