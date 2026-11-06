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
  none: '不带会话上下文',
}

// 列表上的名字：群名或私聊的人。不带会话上下文的会话只有本人看得到，名字总是当前账号，写应用的名字才分得开
export const conversationTitle = (c: Pick<ConversationInfo, 'kind' | 'app' | 'displayName'>) =>
  c.kind === 'none' ? c.app.name : c.displayName

// 第二行：哪个应用、群聊还是私聊；不带会话上下文的写「本人」
export const conversationSubline = (c: Pick<ConversationInfo, 'kind' | 'app'>) =>
  c.kind === 'none' ? '本人' : `${c.app.name} · ${conversationKindLabels[c.kind]}`

// 事实听自哪里：群或私聊前面写「听自」，全局与应用写下的照原样说
export function heardFrom(scope: OriginScope): string {
  const place = originScopeText(scope)
  return scope.kind === 'group' || scope.kind === 'direct' ? `听自${place}` : place
}

// 地址里的会话：对话页的会话分页打开某个会话
export const conversationRoute = (spaceId: string, id: string) => ({
  name: 'conversations',
  params: { spaceId },
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
