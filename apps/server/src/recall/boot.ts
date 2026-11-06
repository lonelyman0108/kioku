import type { BootResponse, RecentMemory, SessionSummary } from '@kioku/contracts'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'

import type { Access } from '../access/access'
import type { Tx } from '../db/client'
import { memories } from '../db/schema'
import { BOOT_ELIGIBLE, BOOT_LAYERS, readableConditions } from '../memory/filter'
import { personaOverride, type PersonaSelection } from '../memory/personas'
import { formatUri } from '../memory/uri'
import { inlineText, titleSuffix } from './text'

// boot 是会话开始时注入的固定基线：所有可读的 priority 0 节点，加上当前人格与本应用 priority ≤ 1 的节点。
// 人格按 personas 挑选，接入方传当前人格的继承链、子人格覆盖祖先（见 personaOverride）。
// 按归属排序（通用规则在前、本人的在后），超出字数预算的只列坐标，模型需要时再读。
// boot 会被宿主当作指令级上下文，所以只收受信来源写下的、记下的四类（BOOT_LAYERS、BOOT_ELIGIBLE，在 memory/filter.ts）：
// 联系人的事实与会话摘要、以及 untrusted 写入的内容一律不进，否则群聊里的人可以把一条 priority 0 的「记忆」
// 变成本人 agent 每次会话都读到的指令。
export const BOOT_CHAR_BUDGET = 16_000

// 超出预算、没有展开的节点的标题，和 omitted 一一对应，只给启动预览显示。放在 Symbol 键上：
// JSON 序列化时不会带出去，接入方的 /boot 与 kioku_boot 仍然只有坐标
export const OMITTED_TITLES = Symbol('boot omitted titles')
export type BootResult = BootResponse & { readonly [OMITTED_TITLES]: readonly string[] }
// 未展开的节点最多列这么多个、合计这么多字，其余只给个数，免得列表本身撑爆宿主的上下文长度
const MAX_OMITTED_LISTED = 20
const MAX_OMITTED_CHARS = 1_200

export async function boot(
  tx: Tx,
  access: Access,
  personas: PersonaSelection,
  budget = BOOT_CHAR_BUDGET,
): Promise<BootResult> {
  const rows = await tx
    .select({
      domain: memories.domain,
      path: memories.path,
      title: memories.title,
      layer: memories.layer,
      priority: memories.priority,
      content: memories.content,
    })
    .from(memories)
    .where(
      and(
        readableConditions(access, { personaIds: personas.personaIds }),
        personaOverride(access, personas),
        BOOT_ELIGIBLE,
      ),
    )
    .orderBy(asc(memories.priority), asc(memories.domain), asc(memories.path))

  // 预算按 priority 分配（数字小的先放），放进来的再按归属排序展示。
  // 每个节点的标题行与分隔（「## <坐标>「<标题>」」和空行）也算进预算，预算就是展开部分的实际长度
  const kept = new Set<string>()
  const omitted: string[] = []
  const omittedTitles: string[] = []
  let used = 0
  for (const r of rows) {
    const uri = formatUri(r.domain!, r.path!)
    const length = bootEntryChars(bootHeading(uri, r.title!), r.content ?? '')
    if (used + length > budget) {
      omitted.push(uri)
      omittedTitles.push(r.title!)
      continue
    }
    used += length
    kept.add(uri)
  }
  const entries: BootResponse['entries'] = rows
    .filter((r) => kept.has(formatUri(r.domain!, r.path!)))
    .sort((a, b) => BOOT_LAYERS.indexOf(a.layer) - BOOT_LAYERS.indexOf(b.layer))
    .map((r) => ({
      uri: formatUri(r.domain!, r.path!),
      title: r.title!,
      layer: r.layer,
      content: r.content ?? '',
    }))
  return { entries, omitted, [OMITTED_TITLES]: omittedTitles }
}

// 启动节点的标题行：坐标，标题和标识不同时在后面带上
export function bootHeading(uri: string, title: string): string {
  return `${uri}${titleSuffix(uri, title)}`
}

// 一个展开的启动节点占的字数：正文加上标题行与分隔（「## <标题行>」和空行）
export function bootEntryChars(heading: string, content: string): number {
  return content.length + heading.length + 7
}

export function formatBootBlock(result: BootResponse, guidance: string): string {
  if (!result.entries.length && !result.omitted.length) return guidance
  const sections = result.entries.map((e) => `## ${bootHeading(e.uri, e.title)}\n\n${e.content}`)
  if (result.omitted.length) {
    const listed: string[] = []
    let chars = 0
    for (const uri of result.omitted.slice(0, MAX_OMITTED_LISTED)) {
      if (chars + uri.length + 3 > MAX_OMITTED_CHARS) break
      chars += uri.length + 3
      listed.push(`- ${uri}`)
    }
    const more = result.omitted.length - listed.length
    if (more > 0) listed.push(`- ……还有 ${more} 个，用 kioku_list 浏览`)
    sections.push(
      `## 未展开的启动节点\n\n超出字数预算，需要时用 kioku_get 读取：\n${listed.join('\n')}`,
    )
  }
  return `${guidance}\n\n<kioku-boot>\n${sections.join('\n\n')}\n</kioku-boot>`
}

// 最近更新的记忆，会话开始时列出坐标、标题与 disclosure，模型据此决定要不要读。
// 它和 boot 一起作为指令级上下文注入，所以过滤与 boot 一致：只收 BOOT_LAYERS 里的归属、只收受信来源；
// 读权限与召回相同，所以不含 secret；人格的覆盖与 boot 相同
export async function recentMemories(
  tx: Tx,
  access: Access,
  personas: PersonaSelection,
  limit: number,
): Promise<RecentMemory[]> {
  const rows = await tx
    .select({
      domain: memories.domain,
      path: memories.path,
      title: memories.title,
      priority: memories.priority,
      disclosure: memories.disclosure,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(
      and(
        readableConditions(access, { personaIds: personas.personaIds }),
        personaOverride(access, personas),
        eq(memories.form, 'curated'),
        inArray(memories.layer, BOOT_LAYERS),
        ne(memories.provenance, 'untrusted'),
      ),
    )
    .orderBy(desc(memories.updatedAt), asc(memories.domain), asc(memories.path))
    .limit(limit)
  return rows.map((r) => ({
    uri: formatUri(r.domain!, r.path!),
    title: r.title!,
    priority: r.priority,
    disclosure: r.disclosure,
    updatedAt: r.updatedAt.toISOString(),
  }))
}

// 同一会话最近的会话摘要，接着上次的话题。摘要压成一行：它和启动加载一起被当作指令级上下文
export function formatSummaryBlock(summaries: SessionSummary[]): string {
  if (!summaries.length) return ''
  const lines = summaries.map((s) => `- ${s.createdAt.slice(0, 10)}：${inlineText(s.content)}`)
  return ['## 最近的会话摘要', '', ...lines].join('\n')
}

export function formatRecentBlock(recent: RecentMemory[]): string {
  if (!recent.length) return ''
  const lines = recent.map((m) => {
    const note = m.disclosure ? `：${inlineText(m.disclosure)}` : ''
    return `- ${m.uri}${titleSuffix(m.uri, m.title)}（priority ${m.priority}，更新于 ${m.updatedAt.slice(0, 10)}）${note}`
  })
  return ['## 近期更新的记忆', '', ...lines].join('\n')
}
