import type { ExtractionUsage, SubjectBinding } from '@kioku/contracts'

import { accountText } from './bindings'
import { isConversationLayer, type StrataSelection } from './components/strata/strata'
import { memoryNodeRoute } from './routes'

// 来自对话的两类在对话页：会话在会话分页，联系人的事实在联系人分页
export const conversationTabRoute = (spaceId: string, layer: 'subject' | 'episode') => ({
  name: 'conversations',
  params: { spaceId },
  query: layer === 'subject' ? { tab: 'contacts' } : {},
})

// 概览页的说法和计算

// 本月抽取（含 Dream 的整理）的 token 用到八成时提醒；用完之后只写会话摘要、不再抽取事实，Dream 也不整理
export function budgetWarning(e: ExtractionUsage) {
  if (e.usedTokens < e.monthlyTokens * 0.8) return null
  const over = e.usedTokens >= e.monthlyTokens
  const used = `已用 ${e.usedTokens.toLocaleString()} / ${e.monthlyTokens.toLocaleString()} token。`
  return {
    over,
    title: over
      ? '本月抽取预算已用完'
      : `本月抽取预算已用 ${Math.floor((e.usedTokens / e.monthlyTokens) * 100)}%`,
    description: over
      ? `${used}本月仅写会话摘要，不再抽取事实，整理暂停，下月恢复。空间所有者可在空间设置中调高预算。`
      : `${used}用完后本月仅写会话摘要，不再抽取事实，整理暂停。`,
  }
}

// 系统提醒默认一句话，别的放进提示层：第一句和后面的分开，只有一句时 rest 为空
export function splitNote(text: string): { first: string; rest: string } {
  const stop = text.indexOf('。')
  if (stop < 0) return { first: text, rest: '' }
  return { first: text.slice(0, stop), rest: text.slice(stop + 1) }
}

// 账号绑定那一行的说明：有哪个账号申请绑定到谁；好几个时只说第一个和总数
export function bindingNote(items: readonly SubjectBinding[], total: number): string | null {
  const first = items[0]
  if (!first) return null
  const note = `${accountText(first.redeemedBy)} 申请绑定到「${first.subject.displayName}」`
  return total > 1 ? `${note}，共 ${total} 个` : note
}

// 点地层柱的一格：记忆列表按归属和敏感级筛选。
// 来自对话的两类不在记忆列表里（列表只列目录里的记忆），调用方带去对话页（conversationTabRoute）
export function strataFilterQuery({ layer, sensitivity }: StrataSelection) {
  return {
    view: 'list',
    ...(layer ? { layer } : {}),
    ...(sensitivity ? { sensitivity } : {}),
  }
}

// 点地层柱去哪里：点一行（只有归属）去记忆页对应的根，来自对话的两类去对话页对应的分页；
// 点一格或表头的一个敏感级，去记忆列表按归属与敏感级筛选
export function strataTarget(spaceId: string, selection: StrataSelection) {
  const { layer, sensitivity } = selection
  if (layer && isConversationLayer(layer)) {
    return conversationTabRoute(spaceId, layer as 'subject' | 'episode')
  }
  if (layer && !sensitivity) return memoryNodeRoute(spaceId, layer)
  return { name: 'memories', params: { spaceId }, query: strataFilterQuery(selection) }
}
