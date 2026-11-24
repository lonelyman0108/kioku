import type { BootPreview, ClientInfo, KeyInfo } from '@kioku/contracts'

import { sameScopes } from './components/keyPresets'
import { scopesSummary } from './labels'

// 客户端页的说法与通用计算

export const ownedClients = (clients: readonly ClientInfo[], accountId: string | undefined) =>
  clients.filter((client) => client.ownerAccountId === accountId)

export const usableKeys = (keys: readonly KeyInfo[]) =>
  keys.filter((key) => Boolean(key.effectiveScopes))

// 没吊销的访问密钥里最近一次使用的时间，都没用过时是 null
export function lastUsedAt(keys: readonly KeyInfo[]): string | null {
  return keys
    .filter((key) => !key.revokedAt && key.lastUsedAt)
    .reduce<string | null>(
      (latest, key) => (!latest || key.lastUsedAt! > latest ? key.lastUsedAt : latest),
      null,
    )
}

// 当前有效上限比签发上限小：所有者被降级了；effectiveScopes 为 null 是已作废，不算收紧
export const isNarrowed = (key: Pick<KeyInfo, 'revokedAt' | 'scopes' | 'effectiveScopes'>) =>
  !key.revokedAt && !!key.effectiveScopes && !sameScopes(key.scopes, key.effectiveScopes)

// 当前有效上限与签发上限不同时，或访问密钥已经作废（所有者离开了记忆圈）时要说明
export function effectiveNote(
  key: Pick<KeyInfo, 'revokedAt' | 'scopes' | 'effectiveScopes'>,
): string | null {
  if (key.revokedAt) return null
  if (!key.effectiveScopes) return '已作废：客户端所有者已不在此记忆圈'
  if (!isNarrowed(key)) return null
  return `当前有效范围：${scopesSummary(key.effectiveScopes)}（已按所有者当前角色收紧）`
}

// 启动加载这一块现在是什么情况。没有选中的访问密钥不等于没有有效访问密钥
export type SimulatorState = 'ready' | 'none' | 'loading' | 'failed'
export function simulatorState(
  keys: { isPending: boolean; hasData: boolean },
  keyId: string | undefined,
): SimulatorState {
  if (keyId) return 'ready'
  if (keys.hasData) return 'none'
  return keys.isPending ? 'loading' : 'failed'
}

export interface BootSegment {
  shortId: string
  title: string
  circleId: string
  circleSlug: string | null
  chars: number
  // 占整条的百分比
  width: number
}

export interface BootUsage {
  // 客户端收到的字数
  used: number
  limit: number | null
  segments: BootSegment[]
  // 记忆之外的部分（标题、设定段、会话摘要、近期更新、相关记忆）占整条的百分比
  other: number
  // 超出客户端能完整接收的字数
  over: boolean
}

// 用量条：整条是客户端能完整接收的字数，每条记忆按字数占一段，没有上限或超出上限时整条就是用掉的字数
export function bootUsage(preview: BootPreview): BootUsage {
  const used = preview.context.length
  const limit = preview.limit
  const whole = Math.max(limit ?? used, used, 1)
  const segments: BootSegment[] = preview.entries.map((entry) => ({
    shortId: entry.shortId,
    title: entry.title,
    circleId: entry.circleId,
    circleSlug: entry.circleSlug,
    chars: entry.chars,
    width: (entry.chars / whole) * 100,
  }))
  const listed = preview.entries.reduce((sum, entry) => sum + entry.chars, 0)
  return {
    used,
    limit,
    segments,
    other: (Math.max(used - listed, 0) / whole) * 100,
    over: limit !== null && used > limit,
  }
}
