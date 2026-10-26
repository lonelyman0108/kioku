import type { BootResponse, Layer } from '@kioku/contracts'
import { and, asc, eq, inArray, lte, ne, or } from 'drizzle-orm'

import type { Access } from '../access/access'
import type { Tx } from '../db/client'
import { memories } from '../db/schema'
import { readableConditions } from '../memory/filter'
import { formatUri } from '../memory/uri'

// boot 是会话开始时注入的固定基线：所有可读的 priority 0 节点，加上当前人格与本应用 priority ≤ 1 的节点。
// 按层排序（基础规则在前、个人信息在后），超出字数预算的只列 URI，模型需要时再读。
// boot 会被宿主当作指令级上下文，所以只收受信来源的策展层：对象与情节层、以及 untrusted 写入的内容一律不进，
// 否则群聊里的人可以把一条 priority 0 的「记忆」变成主人 agent 每次会话都读到的指令。
const BOOT_LAYERS: Layer[] = ['base', 'persona', 'app', 'owner', 'private']
export const BOOT_CHAR_BUDGET = 16_000

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

  rows.sort((a, b) => BOOT_LAYERS.indexOf(a.layer) - BOOT_LAYERS.indexOf(b.layer))
  const entries: BootResponse['entries'] = []
  const omitted: string[] = []
  let used = 0
  for (const r of rows) {
    const uri = formatUri(r.domain!, r.path!)
    const content = r.content ?? ''
    if (used + content.length > budget) {
      omitted.push(uri)
      continue
    }
    used += content.length
    entries.push({ uri, layer: r.layer, content })
  }
  return { entries, omitted }
}

export function formatBootBlock(result: BootResponse, guidance: string): string {
  if (!result.entries.length && !result.omitted.length) return guidance
  const sections = result.entries.map((e) => `## ${e.uri}\n\n${e.content}`)
  if (result.omitted.length) {
    sections.push(
      `## 未展开的启动节点\n\n超出字数预算，需要时用 kioku_get 读取：\n${result.omitted.map((u) => `- ${u}`).join('\n')}`,
    )
  }
  return `${guidance}\n\n<kioku-boot>\n${sections.join('\n\n')}\n</kioku-boot>`
}
