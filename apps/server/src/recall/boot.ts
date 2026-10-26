import type { BootResponse, Layer, RecentMemory } from '@kioku/contracts'
import { and, asc, desc, eq, inArray, lte, ne, or } from 'drizzle-orm'

import type { Access } from '../access/access'
import type { Tx } from '../db/client'
import { memories } from '../db/schema'
import { readableConditions } from '../memory/filter'
import { formatUri } from '../memory/uri'
import { inlineText } from './recall'

// boot 是会话开始时注入的固定基线：所有可读的 priority 0 节点，加上当前人格与本应用 priority ≤ 1 的节点。
// 按层排序（基础规则在前、个人信息在后），超出字数预算的只列 URI，模型需要时再读。
// boot 会被宿主当作指令级上下文，所以只收受信来源的策展层：对象与情节层、以及 untrusted 写入的内容一律不进，
// 否则群聊里的人可以把一条 priority 0 的「记忆」变成主人 agent 每次会话都读到的指令。
export const BOOT_LAYERS: Layer[] = ['base', 'persona', 'app', 'owner', 'private']
export const BOOT_CHAR_BUDGET = 16_000
// 未展开的节点最多列这么多个，其余只给个数，免得列表本身撑爆宿主的上下文长度
const MAX_OMITTED_LISTED = 20

export async function boot(
  tx: Tx,
  access: Access,
  personaIds: string[],
  budget = BOOT_CHAR_BUDGET,
): Promise<BootResponse> {
  const rows = await tx
    .select({
      domain: memories.domain,
      path: memories.path,
      layer: memories.layer,
      priority: memories.priority,
      content: memories.content,
    })
    .from(memories)
    .where(
      and(
        readableConditions(access, { personaIds }),
        eq(memories.form, 'curated'),
        inArray(memories.layer, BOOT_LAYERS),
        ne(memories.provenance, 'untrusted'),
        or(
          eq(memories.priority, 0),
          and(inArray(memories.layer, ['persona', 'app']), lte(memories.priority, 1)),
        ),
      ),
    )
    .orderBy(asc(memories.priority), asc(memories.domain), asc(memories.path))

  // 预算按 priority 分配（数字小的先放），放进来的再按层排序展示。
  // 每个节点的标题与分隔（「## <uri>」和空行）也算进预算，预算就是展开部分的实际长度
  const kept = new Set<string>()
  const omitted: string[] = []
  let used = 0
  for (const r of rows) {
    const uri = formatUri(r.domain!, r.path!)
    const length = (r.content?.length ?? 0) + uri.length + 7
    if (used + length > budget) {
      omitted.push(uri)
      continue
    }
    used += length
    kept.add(uri)
  }
  const entries: BootResponse['entries'] = rows
    .filter((r) => kept.has(formatUri(r.domain!, r.path!)))
    .sort((a, b) => BOOT_LAYERS.indexOf(a.layer) - BOOT_LAYERS.indexOf(b.layer))
    .map((r) => ({ uri: formatUri(r.domain!, r.path!), layer: r.layer, content: r.content ?? '' }))
  return { entries, omitted }
}

export function formatBootBlock(result: BootResponse, guidance: string): string {
  if (!result.entries.length && !result.omitted.length) return guidance
  const sections = result.entries.map((e) => `## ${e.uri}\n\n${e.content}`)
  if (result.omitted.length) {
    const listed = result.omitted.slice(0, MAX_OMITTED_LISTED).map((u) => `- ${u}`)
    const more = result.omitted.length - listed.length
    if (more > 0) listed.push(`- ……还有 ${more} 个，用 kioku_list 浏览`)
    sections.push(
      `## 未展开的启动节点\n\n超出字数预算，需要时用 kioku_get 读取：\n${listed.join('\n')}`,
    )
  }
  return `${guidance}\n\n<kioku-boot>\n${sections.join('\n\n')}\n</kioku-boot>`
}

// 最近更新的策展记忆，会话开始时列出 URI 与 disclosure，模型据此决定要不要读。
// 它和 boot 一起作为指令级上下文注入，所以过滤与 boot 一致：只收 BOOT_LAYERS 里的层、只收受信来源；
// 读权限与召回相同，所以不含 secret
export async function recentMemories(
  tx: Tx,
  access: Access,
  personaIds: string[],
  limit: number,
): Promise<RecentMemory[]> {
  const rows = await tx
    .select({
      domain: memories.domain,
      path: memories.path,
      priority: memories.priority,
      disclosure: memories.disclosure,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(
      and(
        readableConditions(access, { personaIds }),
        eq(memories.form, 'curated'),
        inArray(memories.layer, BOOT_LAYERS),
        ne(memories.provenance, 'untrusted'),
      ),
    )
    .orderBy(desc(memories.updatedAt), asc(memories.domain), asc(memories.path))
    .limit(limit)
  return rows.map((r) => ({
    uri: formatUri(r.domain!, r.path!),
    priority: r.priority,
    disclosure: r.disclosure,
    updatedAt: r.updatedAt.toISOString(),
  }))
}

export function formatRecentBlock(recent: RecentMemory[]): string {
  if (!recent.length) return ''
  const lines = recent.map((m) => {
    const note = m.disclosure ? `：${inlineText(m.disclosure)}` : ''
    return `- ${m.uri}（priority ${m.priority}，更新于 ${m.updatedAt.slice(0, 10)}）${note}`
  })
  return ['## 近期更新的记忆', '', ...lines].join('\n')
}
