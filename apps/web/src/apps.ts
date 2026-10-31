import type { BootPreview, KeyInfo, Layer } from '@kioku/contracts'

import { sameScopes } from './components/keyPresets'
import { scopesSummary } from './labels'

// 应用页的说法和计算

// 没吊销的 Key 里最近一次使用的时间，都没用过时是 null
export function lastUsedAt(keys: readonly KeyInfo[]): string | null {
  return keys
    .filter((key) => !key.revokedAt && key.lastUsedAt)
    .reduce<string | null>(
      (latest, key) => (!latest || key.lastUsedAt! > latest ? key.lastUsedAt : latest),
      null,
    )
}

// 当前有效上限比签发上限小：所有者被降级了
export const isNarrowed = (key: KeyInfo) =>
  !key.revokedAt && !!key.effectiveScopes && !sameScopes(key.scopes, key.effectiveScopes)

// 当前有效上限与签发上限不同时，或 Key 已经作废（所有者离开了空间）时要说明
export function effectiveNote(key: KeyInfo): string | null {
  if (key.revokedAt) return null
  if (!key.effectiveScopes) return '已作废：应用所有者已不在此空间'
  if (!isNarrowed(key)) return null
  return `当前有效范围：${scopesSummary(key.effectiveScopes)}（已按所有者当前角色收紧）`
}

// 启动加载这一块现在是什么情况。没有选中的 Key 不等于没有有效 Key：还在读或者读取失败时也没有，
// 这时说「暂无有效 Key」可能让人多签一个
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
  uri: string
  layer: Layer
  chars: number
  // 占整条的百分比
  width: number
}

export interface BootUsage {
  // 客户端收到的字数
  used: number
  limit: number | null
  segments: BootSegment[]
  // 节点之外的部分（标题、近期更新、相关记忆）占整条的百分比
  other: number
  // 超出客户端能完整接收的字数
  over: boolean
}

// 用量条：整条是客户端能完整接收的字数，每个节点按字数占一段，没有上限或超出上限时整条就是用掉的字数
export function bootUsage(preview: BootPreview): BootUsage {
  const used = preview.context.length
  const limit = preview.limit
  const whole = Math.max(limit ?? used, used, 1)
  const segments = preview.entries.map((entry) => ({
    uri: entry.uri,
    layer: entry.layer,
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
