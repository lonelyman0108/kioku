import type { BootResponse, Layer } from '@kioku/contracts'
import { and, asc, inArray, lte, or, eq } from 'drizzle-orm'

import type { Access } from '../access/access'
import type { Tx } from '../db/client'
import { memories } from '../db/schema'
import { readableConditions } from '../memory/filter'
import { formatUri } from '../memory/uri'

// boot 是会话开始时注入的固定基线：所有可读的 priority 0 节点，加上当前人格与本应用 priority ≤ 1 的节点。
// 按层排序（基础规则在前、个人信息在后），超出字数预算的只列 URI，模型需要时再读。
const LAYER_ORDER: Layer[] = ['base', 'persona', 'app', 'owner', 'private', 'subject', 'episode']
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
        or(
          eq(memories.priority, 0),
          and(inArray(memories.layer, ['persona', 'app']), lte(memories.priority, 1)),
        ),
      ),
    )
    .orderBy(asc(memories.priority), asc(memories.domain), asc(memories.path))

  rows.sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer))
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
