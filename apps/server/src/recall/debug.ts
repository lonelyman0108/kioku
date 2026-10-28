import { randomUUID } from 'node:crypto'

import type { BootPreview, BootPreviewRequest, RecallDebug } from '@kioku/contracts'
import { and, inArray, not } from 'drizzle-orm'

import { readDenial, type Access } from '../access/access'
import type { Tx } from '../db/client'
import { memories } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import {
  PROMPT_RECALL_LIMIT,
  PROMPT_SEMANTIC_TIMEOUT_MS,
  sessionStart,
} from '../lifecycle/lifecycle'
import { accessForKey, recallScopeForKey, semanticFor } from '../memory/context'
import { personaOverride, runInSpace } from '../memory/personas'
import { formatUri } from '../memory/uri'
import { bootEntryChars } from './boot'
import {
  DEFAULT_MIN_SCORE,
  formatRecallBlock,
  normalizeQuery,
  publicCandidate,
  scoreRecall,
  type ScoredCandidate,
} from './recall'

// 调试台多看一些候选：没注入的、以及管理界面搜得到这把 Key 却读不到的，都从这么多条里找
const DEBUG_LIMIT = 30

// 启动预览：按一把 Key 走一遍会话开始，和生命周期端点用同一段代码，看到的就是宿主收到的
export async function bootPreview(
  deps: Deps,
  key: KeyPrincipal,
  request: BootPreviewRequest,
): Promise<BootPreview> {
  const start = await sessionStart(recallScopeForKey(deps, key), key.app.runtimeFamily, {
    project: request.project,
    sessionId: request.sessionId ?? randomUUID(),
  })
  return {
    runtimeFamily: key.app.runtimeFamily,
    limit: start.limit,
    context: start.context,
    entries: start.boot.entries.map((e) => ({
      uri: e.uri,
      layer: e.layer,
      chars: bootEntryChars(e.uri, e.content),
    })),
    omitted: start.boot.omitted,
    recent: start.recent,
    related: start.related.map(publicCandidate),
    dropped: start.dropped,
  }
}

// 召回调试台：按一把 Key 模拟每轮输入时的召回，列出各路得分；再用管理界面的权限（member，查看者本人，
// 也就是应用主人）搜一遍，列出搜得到、这把 Key 却读不到的记忆与原因
export async function recallDebug(
  deps: Deps,
  key: KeyPrincipal,
  member: Access,
  rawQuery: string,
): Promise<RecallDebug> {
  const query = normalizeQuery(rawQuery)
  const keyAccess = accessForKey(key)
  // 向量只算一次，两边共用；和每轮输入时一样有时限
  const semantic = await semanticFor(deps, query, PROMPT_SEMANTIC_TIMEOUT_MS)
  // 管理界面看得到全部人格，不按继承覆盖，和管理界面的搜索一样
  const visible = await runInSpace(deps.db, key.spaceId, 'all', (tx, personaIds) =>
    scoreRecall(tx, member, semantic, query, { limit: DEBUG_LIMIT, minScore: 0, personaIds }),
  )
  const { scored, filtered } = await runInSpace(
    deps.db,
    key.spaceId,
    key.app.defaultPersonaId,
    async (tx, chain) => {
      const scored = await scoreRecall(tx, keyAccess, semantic, query, {
        limit: DEBUG_LIMIT,
        minScore: 0,
        personaIds: chain,
        inheritance: true,
      })
      // 按记忆 id 比对：同一个 URI 上可能还有别的记录（例如过期的共享记录），按 URI 会找错
      const seen = new Set(scored.map((c) => c.id))
      const missing = visible.filter((c) => !seen.has(c.id)).map((c) => c.id)
      return { scored, filtered: await explainHidden(tx, keyAccess, chain, missing) }
    },
  )
  const injected = scored
    .filter((c) => c.rawScore >= DEFAULT_MIN_SCORE)
    .slice(0, PROMPT_RECALL_LIMIT)
  const shown = new Set(injected.map((c) => c.id))
  const toDebug = (c: ScoredCandidate) => ({ ...publicCandidate(c), breakdown: c.breakdown })
  return {
    injected: injected.map(toDebug),
    others: scored.filter((c) => !shown.has(c.id)).map(toDebug),
    minScore: DEFAULT_MIN_SCORE,
    block: formatRecallBlock(injected),
    semantic: semantic !== null,
    filtered,
  }
}

// 查看者搜得到的这些记忆，这把 Key 为什么读不到：读权限的原因，或被继承链上更近的人格覆盖。
// 读得到又没被覆盖的只是分数排在后面，不算被过滤。顺序与管理界面的搜索结果一致
async function explainHidden(
  tx: Tx,
  keyAccess: Access,
  chain: string[],
  ids: string[],
): Promise<RecallDebug['filtered']> {
  if (!ids.length) return []
  const rows = await tx.select().from(memories).where(inArray(memories.id, ids))
  const override = personaOverride(keyAccess, { personaIds: chain, inheritance: true })
  const overridden = new Set(
    override
      ? (
          await tx
            .select({ id: memories.id })
            .from(memories)
            .where(and(inArray(memories.id, ids), not(override)))
        ).map((r) => r.id)
      : [],
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    if (!row) return []
    const reason =
      readDenial(keyAccess, row, { personaIds: chain }) ??
      (overridden.has(id) ? ('override' as const) : null)
    return reason
      ? [
          {
            uri: formatUri(row.domain!, row.path!),
            layer: row.layer,
            sensitivity: row.sensitivity,
            reason,
          },
        ]
      : []
  })
}
