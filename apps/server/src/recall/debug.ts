import type { BootPreview, LifecycleProject, RecallDebug } from '@kioku/contracts'
import { and, eq, inArray, isNull, not, or } from 'drizzle-orm'

import { readDenial, type Access } from '../access/access'
import type { Tx } from '../db/client'
import { memories, personas } from '../db/schema'
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
import { DEFAULT_MIN_SCORE, formatRecallBlock, normalizeQuery, recall, scoreRecall } from './recall'

// 调试台多看一些候选：没注入的、以及管理界面搜得到这把 Key 却读不到的，都从这么多条里找
const DEBUG_LIMIT = 30

// 启动预览：按一把 Key 走一遍会话开始，和生命周期端点用同一段代码，看到的就是宿主收到的
export async function bootPreview(
  deps: Deps,
  key: KeyPrincipal,
  project: LifecycleProject | undefined,
): Promise<BootPreview> {
  const start = await sessionStart(recallScopeForKey(deps, key), key.app.runtimeFamily, {
    project,
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
    related: start.related,
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
      // 管理界面看得到全部人格，不按继承覆盖
      const allPersonas = await tx.select({ id: personas.id }).from(personas)
      const visible = await recall(tx, member, semantic, query, {
        limit: DEBUG_LIMIT,
        minScore: 0,
        personaIds: allPersonas.map((p) => p.id),
      })
      const seen = new Set(scored.map((c) => c.uri))
      const missing = visible.filter((c) => !seen.has(c.uri)).map((c) => c.uri)
      return { scored, filtered: await explainHidden(tx, keyAccess, chain, member, missing) }
    },
  )
  const injected = scored
    .filter((c) => c.rawScore >= DEFAULT_MIN_SCORE)
    .slice(0, PROMPT_RECALL_LIMIT)
  const shown = new Set(injected.map((c) => c.uri))
  // 取整前的总分只用来和阈值比较，不返回
  const strip = (c: (typeof scored)[number]) => ({
    uri: c.uri,
    layer: c.layer,
    priority: c.priority,
    disclosure: c.disclosure,
    score: c.score,
    via: c.via,
    cues: c.cues,
    breakdown: c.breakdown,
  })
  return {
    injected: injected.map(strip),
    others: scored.filter((c) => !shown.has(c.uri)).map(strip),
    minScore: DEFAULT_MIN_SCORE,
    block: formatRecallBlock(injected),
    semantic: semantic !== null,
    filtered,
  }
}

// 这些 URI 上查看者看得到的那条，这把 Key 为什么读不到：读权限的原因，或被继承链上更近的人格覆盖。
// 读得到又没被覆盖的只是分数排在后面，不算被过滤
async function explainHidden(
  tx: Tx,
  keyAccess: Access,
  chain: string[],
  member: Access,
  uris: string[],
): Promise<RecallDebug['filtered']> {
  if (!uris.length) return []
  const pairs = uris.map((uri) => {
    const [domain, path] = uri.split('://') as [string, string]
    return and(eq(memories.domain, domain), eq(memories.path, path))
  })
  const rows = await tx
    .select()
    .from(memories)
    .where(
      and(
        or(...pairs),
        isNull(memories.deletedAt),
        or(isNull(memories.ownerAccountId), eq(memories.ownerAccountId, member.ownerAccountId)),
      ),
    )
  const override = personaOverride(keyAccess, { personaIds: chain, inheritance: true })
  const overridden = new Set(
    override && rows.length
      ? (
          await tx
            .select({ id: memories.id })
            .from(memories)
            .where(
              and(
                inArray(
                  memories.id,
                  rows.map((r) => r.id),
                ),
                not(override),
              ),
            )
        ).map((r) => r.id)
      : [],
  )
  const order = new Map(uris.map((uri, i) => [uri, i]))
  return rows
    .map((row) => ({
      row,
      reason:
        readDenial(keyAccess, row, { personaIds: chain }) ??
        (overridden.has(row.id) ? ('override' as const) : null),
    }))
    .filter((r) => r.reason !== null)
    .map(({ row, reason }) => ({
      uri: formatUri(row.domain!, row.path!),
      layer: row.layer,
      sensitivity: row.sensitivity,
      reason: reason!,
    }))
    .sort((a, b) => order.get(a.uri)! - order.get(b.uri)!)
}
