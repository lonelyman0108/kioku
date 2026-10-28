import type { RecallSource } from '@kioku/contracts'

import { maskPlaintextCredentials } from '../credential/placeholders'
import { withSpace } from '../db/client'
import { recallEventHits, recallEvents } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import type { ScoredCandidate } from './recall'

// 召回事件里最多存提示语的这么多字
export const RECALL_QUERY_CHARS = 200

// 存下来的提示语：先打码再截断（截在值的中间时就认不出来了）；应用关掉了记录提示语时为空
export function storedQuery(query: string, recordPrompt: boolean | undefined): string | null {
  if (recordPrompt === false) return null
  return maskPlaintextCredentials(query).slice(0, RECALL_QUERY_CHARS)
}

// 还没写完的召回事件：服务退出前、测试清库前等它们写完，免得写到一半被打断，或和清库互相等锁
const pending = new Set<Promise<void>>()

export async function settleRecallEvents(): Promise<void> {
  await Promise.all([...pending])
}

// 记一条召回事件，调用方不等它写完：失败只记日志，不影响这次召回的结果。
// 记下事件发生时的应用主人，明细只给他看
export function recordRecall(
  deps: Deps,
  key: KeyPrincipal,
  source: RecallSource,
  query: string,
  hits: readonly ScoredCandidate[],
): Promise<void> {
  const write = withSpace(deps.db, key.spaceId, async (tx) => {
    const [event] = await tx
      .insert(recallEvents)
      .values({
        spaceId: key.spaceId,
        appId: key.app.id,
        keyId: key.keyId,
        ownerAccountId: key.app.ownerAccountId,
        source,
        query: storedQuery(query, key.app.config.recordPrompt),
      })
      .returning({ id: recallEvents.id })
    if (!hits.length) return
    await tx.insert(recallEventHits).values(
      hits.map((h, i) => ({
        eventId: event!.id,
        spaceId: key.spaceId,
        memoryId: h.id,
        rank: i + 1,
        score: h.score,
        via: h.via,
      })),
    )
  })
    .catch((err: unknown) => console.warn('记录召回事件失败', err))
    .finally(() => pending.delete(write))
  pending.add(write)
  return write
}
