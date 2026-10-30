import type { ChatType, SessionContextInput } from '@kioku/contracts'

// 调用台的表单：页面上的会话上下文

export interface ContextForm {
  // null：不带会话上下文，本机 agent 的钩子就是这样
  chatType: ChatType | null
  platform: string
  groupId: string
  groupName: string
  senderId: string
  senderName: string
}

// 默认用和内置场景相同的固定账号：对象没有删除接口，真实模式下随手填的账号会留下永久的假对象
export const contextDefaults = (): ContextForm => ({
  chatType: null,
  platform: 'bench',
  groupId: 'bench-group',
  groupName: '测试台的群',
  senderId: 'bench-user',
  senderName: '测试台的群友',
})

export const chatTypeLabels: Record<ChatType, string> = {
  direct: '私聊',
  group: '群聊',
  channel: '频道',
  cron: '定时任务',
  subagent: '子 agent',
}

export const usesGroup = (chatType: ChatType | null) =>
  chatType === 'group' || chatType === 'channel'
export const usesSender = (chatType: ChatType | null) =>
  chatType === 'direct' || usesGroup(chatType)

const platformRef = (id: string, name: string) => ({ id, ...(name ? { name } : {}) })

// 表单换成请求里的 context。不校验：缺群、缺平台的请求也是要测的，服务端返回和 REST 相同的错误。
// 定时任务与子 agent 不看别的字段，私聊不看群
export function contextOf(form: ContextForm): SessionContextInput | undefined {
  if (!form.chatType) return undefined
  const { chatType } = form
  if (!usesSender(chatType)) return { chatType }
  return {
    chatType,
    ...(form.platform ? { platform: form.platform } : {}),
    ...(usesGroup(chatType) && form.groupId
      ? { group: platformRef(form.groupId, form.groupName) }
      : {}),
    ...(form.senderId ? { sender: platformRef(form.senderId, form.senderName) } : {}),
  }
}

// 折叠时显示的一句话
export function contextSummary(form: ContextForm): string {
  if (!form.chatType) return '不带（本机 agent 的钩子就是这样）'
  const parts: string[] = [chatTypeLabels[form.chatType]]
  if (usesSender(form.chatType) && form.platform) parts.push(form.platform)
  if (usesGroup(form.chatType) && form.groupId) parts.push(`群 ${form.groupName || form.groupId}`)
  if (usesSender(form.chatType) && form.senderId) {
    parts.push(`发言人 ${form.senderName || form.senderId}`)
  }
  return parts.join(' · ')
}
