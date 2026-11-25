import {
  normalizeProjectSlug,
  type LifecycleEventRequest,
  type LifecycleEventResponse,
} from '@kioku/contracts'

import { synthesizeFocus } from '../access/scope'
import { bufferTurn } from '../extraction/buffer'
import type { Deps, KeyPrincipal } from '../http/env'
import {
  BOOT_CHAR_BUDGET,
  compileBoot,
  formatBootBlock,
  formatRecentBlock,
  formatSummaryBlock,
  loadRecentEntries,
} from '../recall/boot'
import { formatRecallBlock, recallEntries } from '../recall/recall'
import {
  CONTEXT_RESERVE,
  GUIDANCE,
  HOST_CONTEXT_LIMIT,
  hostOutput,
  projectQuery,
  PROMPT_SEMANTIC_TIMEOUT_MS,
} from './lifecycle'

const SESSION_EPISODE_LIMIT = 3
const SESSION_RELATED_LIMIT = 5
const SESSION_RECENT_LIMIT = 5
const PROMPT_RECALL_LIMIT = 8

function appendWithinLimit(base: string, extra: string, limit: number | undefined): string {
  if (!extra) return base
  const joined = `${base}\n\n${extra}`
  if (limit !== undefined && joined.length > limit) return base
  return joined
}

export async function handleLifecycleEvent(
  deps: Deps,
  key: KeyPrincipal,
  event: LifecycleEventRequest,
): Promise<LifecycleEventResponse> {
  if (event.event === 'session.start') {
    const limit = HOST_CONTEXT_LIMIT[key.runtimeFamily]
    const budget = Math.min(
      BOOT_CHAR_BUDGET,
      limit ? Math.max(limit - GUIDANCE.length - CONTEXT_RESERVE, 1_000) : Infinity,
    )
    const focus = synthesizeFocus(key, { project: event.project })
    const projectSlug = normalizeProjectSlug(event.project) ?? ''
    const deviceKey = (event.deviceKey ?? '').trim()

    const bootResult = await compileBoot(deps.db, key, {
      focus,
      budget,
      deviceKey,
      projectSlug,
      episodeLimit: SESSION_EPISODE_LIMIT,
    })

    const bootedIds = bootResult.entries.map((e) => e.shortId)
    const bootedSet = new Set(bootedIds)
    const pQuery = projectQuery(event.project)

    const [related, recent] = await Promise.all([
      pQuery
        ? recallEntries(deps.db, deps.masterKey, key, pQuery, {
            focus,
            limit: SESSION_RELATED_LIMIT + bootedSet.size,
            useSemantic: false,
            includeLinks: false,
          }).then((list) =>
            list.filter((c) => !bootedSet.has(c.shortId)).slice(0, SESSION_RELATED_LIMIT),
          )
        : Promise.resolve([]),
      loadRecentEntries(deps.db, key, {
        limit: SESSION_RECENT_LIMIT,
        excludeShortIds: bootedIds,
      }),
    ])

    let context = formatBootBlock(bootResult, GUIDANCE)
    const summaryBlock = formatSummaryBlock(bootResult.episodes)
    const relatedBlock = related.length
      ? `## 当前项目相关记忆\n\n${formatRecallBlock(related, event.sessionId)}`
      : ''
    const recentBlock = formatRecentBlock(recent)

    context = appendWithinLimit(context, summaryBlock, limit)
    context = appendWithinLimit(context, relatedBlock, limit)
    context = appendWithinLimit(context, recentBlock, limit)

    const shortIds = [
      ...new Set([
        ...bootedIds,
        ...bootResult.episodes.map((e) => e.shortId),
        ...related.map((c) => c.shortId),
      ]),
    ]

    return {
      hostOutput: hostOutput(key.runtimeFamily, 'session.start', context),
      shortIds,
    }
  }

  if (event.event === 'prompt.submit') {
    const focus = synthesizeFocus(key, { project: event.project })
    const candidates = await recallEntries(deps.db, deps.masterKey, key, event.prompt, {
      focus,
      limit: PROMPT_RECALL_LIMIT,
      semanticTimeoutMs: PROMPT_SEMANTIC_TIMEOUT_MS,
    })
    const block = formatRecallBlock(candidates, event.sessionId)
    return {
      hostOutput: hostOutput(key.runtimeFamily, 'prompt.submit', block),
      shortIds: candidates.map((c) => c.shortId),
    }
  }

  await bufferTurn(deps, key, event)
  return {
    hostOutput: { mode: 'none', value: null },
    shortIds: [],
  }
}
