import { SessionContextInput } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { contextDefaults, contextOf, contextSummary } from '../benchForm'

describe('会话上下文', () => {
  const form = (chatType: Parameters<typeof contextOf>[0]['chatType']) => ({
    ...contextDefaults(),
    chatType,
  })

  it('不带时没有 context', () => {
    expect(contextOf(form(null))).toBeUndefined()
    expect(contextSummary(form(null))).toContain('不带')
  })

  it('群聊带平台、群与发言人，默认的固定账号过得了校验', () => {
    const context = contextOf(form('group'))
    expect(context).toEqual({
      chatType: 'group',
      platform: 'bench',
      group: { id: 'bench-group', name: '测试台的群' },
      sender: { id: 'bench-user', name: '测试台的群友' },
    })
    expect(SessionContextInput.safeParse(context).success).toBe(true)
    expect(contextSummary(form('group'))).toBe('群聊 · bench · 群 测试台的群 · 发言人 测试台的群友')
  })

  it('私聊不带群，定时任务与子 agent 只有类型', () => {
    expect(contextOf(form('direct'))).toEqual({
      chatType: 'direct',
      platform: 'bench',
      sender: { id: 'bench-user', name: '测试台的群友' },
    })
    expect(contextOf(form('cron'))).toEqual({ chatType: 'cron' })
    expect(contextOf(form('subagent'))).toEqual({ chatType: 'subagent' })
    expect(contextSummary(form('cron'))).toBe('定时任务')
  })

  it('没填的不带：缺群、缺平台的请求也要能发出去，由服务端报错', () => {
    const blank = { ...form('group'), platform: '', groupId: '', senderName: '' }
    const context = contextOf(blank)
    expect(context).toEqual({ chatType: 'group', sender: { id: 'bench-user' } })
    expect(SessionContextInput.safeParse(context).success).toBe(false)
  })
})
