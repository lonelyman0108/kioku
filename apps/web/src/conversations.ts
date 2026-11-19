import type {
  ConversationInfo,
  ConversationKind,
  ExtractionRunInfo,
  OriginScope,
} from '@kioku/contracts'

import { originScopeText } from './labels'

// 对话页的说法：会话是哪一种、列表上一项怎么写、事实听自哪里

export const conversationKindLabels: Record<ConversationKind, string> = {
  group: '群聊',
  direct: '私聊',
  channel: '频道',
  none: '本地会话',
}

// 列表上的名字：群名、私聊的人、频道名；本地会话按接入实例、项目与设备区分
export function conversationTitle(
  c: Pick<
    ConversationInfo,
    'kind' | 'client' | 'deviceKey' | 'projectSlug' | 'subject' | 'displayName'
  >,
): string {
  if (c.kind === 'none') {
    const suffix = [c.projectSlug, c.deviceKey].filter(Boolean).join(' · ')
    if (c.client?.name) return suffix ? `${c.client.name} · ${suffix}` : c.client.name
    return c.displayName.trim() || suffix || conversationKindLabels.none
  }
  return c.displayName.trim() || c.subject?.displayName || conversationKindLabels[c.kind]
}

// 群聊、私聊或频道；不带会话上下文的写「本人」
export const conversationKind = (c: Pick<ConversationInfo, 'kind'>) =>
  c.kind === 'none' ? '本人' : conversationKindLabels[c.kind]

// 第二行：哪个接入实例、会话类型；本地会话写「本人」
export const conversationSubline = (c: Pick<ConversationInfo, 'kind' | 'client'>) =>
  c.kind === 'none' ? '本人' : `${c.client?.name ?? '已删除的接入实例'} · ${conversationKind(c)}`

// 列表或详情里的附加信息标签：接入实例、项目、设备
export function conversationMeta(
  c: Pick<ConversationInfo, 'client' | 'deviceKey' | 'projectSlug'>,
): string[] {
  return [
    c.client?.name ?? null,
    c.projectSlug ? `项目 ${c.projectSlug}` : null,
    c.deviceKey ? `设备 ${c.deviceKey}` : null,
  ].filter((v): v is string => Boolean(v))
}

// 事实听自哪里：群或私聊前面写「听自」，全局与接入实例写下的照原样说
export function heardFrom(scope: OriginScope): string {
  const place = originScopeText(scope)
  return scope.kind === 'group' || scope.kind === 'direct' ? `听自${place}` : place
}

// 地址里的会话：对话页的会话分页打开某个会话
export const conversationRoute = (circleId: string, id: string) => ({
  name: 'conversations',
  params: { circleId },
  query: { id },
})

// 一批抽取的结果：只列不为零的几项
export function runCounts(run: ExtractionRunInfo): string {
  const parts = [`${run.turns} 轮`]
  if (run.added) parts.push(`新增 ${run.added}`)
  if (run.updated) parts.push(`更新 ${run.updated}`)
  if (run.unchanged) parts.push(`已有 ${run.unchanged}`)
  if (run.dropped) parts.push(`丢弃 ${run.dropped}`)
  if (run.limited) parts.push(`超出每日上限 ${run.limited}`)
  if (run.skippedTurns) parts.push(`${run.skippedTurns} 轮的访问密钥已失效`)
  return parts.join(' · ')
}
