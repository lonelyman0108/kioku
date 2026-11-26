import type { EntryActorMeta } from '@kioku/contracts'
import { inArray } from 'drizzle-orm'

import type { Db, Tx } from '../db/client'
import { apiKeys } from '../db/schema'

const RUNTIME_DISPLAY: Record<string, string> = {
  claudecode: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  agy: 'Antigravity',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  opencode: 'OpenCode',
  pi: 'Pi',
  dsh: 'DSH',
  mcp: 'MCP 客户端',
  generic: '通用客户端',
}

export function runtimeDisplayName(family: string | null | undefined): string {
  if (!family) return '访问密钥'
  return RUNTIME_DISPLAY[family] ?? family
}

export function resolveStaticActorMeta(actor: string): EntryActorMeta | null {
  if (actor === 'console') return { kind: 'console', label: '本人 · 控制台', runtimeFamily: null }
  if (actor === 'dream') return { kind: 'dream', label: '后台整理', runtimeFamily: null }
  if (actor === 'extraction') return { kind: 'extraction', label: '自动摘要', runtimeFamily: null }
  if (actor === 'capture') return { kind: 'capture', label: '随手记', runtimeFamily: null }
  if (actor === 'hygiene:sweep') return { kind: 'system', label: '结构预清洗', runtimeFamily: null }
  if (actor === 'import:lore')
    return { kind: 'system', label: '数据导入（Lore）', runtimeFamily: null }
  if (actor === 'import:kioku') return { kind: 'system', label: '数据导入', runtimeFamily: null }
  return null
}

export interface ResolveActorMetaOptions {
  // 终端密钥视角下脱敏其他密钥的名称，仅保留当前密钥自身名称与其他密钥的客户端家族
  ownKeyPrefix?: string | null | undefined
  redactOtherKeyNames?: boolean | undefined
}

// 批量解析历史记录里的操作来源，向界面与 MCP 输出可读中文标识（不裸露内部 key: 前缀）
export async function resolveActorMetaMap(
  db: Db | Tx,
  actors: readonly string[],
  options: ResolveActorMetaOptions = {},
): Promise<Map<string, EntryActorMeta>> {
  const result = new Map<string, EntryActorMeta>()
  const prefixes = new Set<string>()

  for (const actor of actors) {
    if (result.has(actor)) continue
    const staticMeta = resolveStaticActorMeta(actor)
    if (staticMeta) {
      result.set(actor, staticMeta)
    } else if (actor.startsWith('key:')) {
      const prefix = actor.slice('key:'.length).trim()
      if (prefix) prefixes.add(prefix)
    } else {
      result.set(actor, { kind: 'system', label: '系统', runtimeFamily: null })
    }
  }

  if (prefixes.size) {
    const rows = await db
      .select({
        prefix: apiKeys.prefix,
        name: apiKeys.name,
        runtimeFamily: apiKeys.runtimeFamily,
      })
      .from(apiKeys)
      .where(inArray(apiKeys.prefix, [...prefixes]))
    const byPrefix = new Map(rows.map((r) => [r.prefix, r]))
    for (const prefix of prefixes) {
      const actor = `key:${prefix}`
      const hit = byPrefix.get(prefix)
      if (hit) {
        const runtimeLabel = runtimeDisplayName(hit.runtimeFamily)
        const allowName = !options.redactOtherKeyNames || prefix === options.ownKeyPrefix
        const namePart = allowName ? hit.name.trim() : ''
        const label =
          namePart && namePart.toLowerCase() !== runtimeLabel.toLowerCase()
            ? `Agent · ${runtimeLabel}（${namePart}）`
            : `Agent · ${runtimeLabel}`
        result.set(actor, { kind: 'agent', label, runtimeFamily: hit.runtimeFamily })
      } else {
        result.set(actor, { kind: 'agent', label: 'Agent · 访问密钥', runtimeFamily: null })
      }
    }
  }

  return result
}
