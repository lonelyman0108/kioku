import { describe, expect, it, vi } from 'vitest'

import type { Db } from '../../db/client'
import type { EntryService } from '../../memory/service'
import type { ChatMessage } from '../../models/client'

const capturedMessages: ChatMessage[][] = []
let nextChatPayload: unknown = {
  title: 'home-24 本机代理端口',
  summary: '仅适用于 home-24 机器，本地代理端口调整为 7890。',
}

vi.mock('../../models/store', () => ({
  CHAT_LLM_SETTING_KEY: 'chat_llm',
  loadResolvedModel: vi.fn(async () => ({
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    apiKey: 'test-key',
  })),
}))

vi.mock('../../models/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../models/client')>()
  return {
    ...actual,
    chatComplete: vi.fn(async (_conn: unknown, messages: ChatMessage[]) => {
      capturedMessages.push(messages)
      return {
        content: JSON.stringify(nextChatPayload),
      }
    }),
  }
})

import { resolveAllowedRealmsWithFocus } from '../../access/scope'
import { extractEpisodeBatch } from '../extract'
import { buildEpisodeMessages, evaluateEpisodeResponse } from '../prompt'

describe('extractEpisodeBatch 透传设备标识与终端名称', () => {
  it('查询 api_keys.name 与 bucket.deviceKey 并写入会话摘要提示词头部', async () => {
    capturedMessages.length = 0
    let selectCall = 0
    const fakeDb = {
      select: vi.fn(() => {
        selectCall++
        if (selectCall === 1) {
          return {
            from: () => ({
              where: () => ({
                orderBy: async () => [
                  {
                    id: 11,
                    keyId: '00000000-0000-4000-8000-000000000011',
                    deviceKey: 'home-24',
                    projectSlug: 'kioku',
                    sessionId: 'sess-home',
                    userText: '家里 .24 这台 macOS 本地代理端口改为 7890',
                    replyText: '已确认仅在 home-24 本机使用 7890 端口。',
                    createdAt: new Date('2026-10-01T00:00:00Z'),
                  },
                ],
              }),
            }),
          }
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [
                {
                  name: 'Claude Code（home-24）',
                  envs: ['mac', 'home-24'],
                  allowedRealms: ['work'],
                },
              ],
            }),
          }),
        }
      }),
      delete: vi.fn(() => ({
        where: async () => undefined,
      })),
    } as unknown as Db

    const writeEpisode = vi.fn(async () => ({ shortId: 'm-234abc' }))
    const fakeEntryService = { writeEpisode } as unknown as EntryService

    const outcome = await extractEpisodeBatch(fakeDb, null, fakeEntryService, {
      deviceKey: 'home-24',
      projectSlug: 'kioku',
    })

    expect(outcome).toEqual({ turns: 1, createdShortId: 'm-234abc' })
    expect(capturedMessages).toHaveLength(1)
    const [systemMsg, userMsg] = capturedMessages[0]!
    expect(systemMsg?.content).toContain('单机配置')
    expect(systemMsg?.content).toContain('不得泛化为通用系统或全局配置')
    expect(userMsg?.content).toContain('项目：kioku · 设备：home-24（Claude Code（home-24））')
    expect(writeEpisode).toHaveBeenCalledWith({
      title: 'home-24 本机代理端口',
      content: '仅适用于 home-24 机器，本地代理端口调整为 7890。',
      deviceKey: 'home-24',
      projectSlug: 'kioku',
      envs: ['mac', 'home-24'],
      realms: ['work'],
      projects: ['kioku'],
    })
  })

  it('api_keys 行缺少 name 字段时安全降级且不抛异常', async () => {
    capturedMessages.length = 0
    let selectCall = 0
    const fakeDb = {
      select: vi.fn(() => {
        selectCall++
        if (selectCall === 1) {
          return {
            from: () => ({
              where: () => ({
                orderBy: async () => [
                  {
                    id: 12,
                    keyId: '00000000-0000-4000-8000-000000000012',
                    deviceKey: 'home-24',
                    projectSlug: 'kioku',
                    sessionId: 'sess-fallback',
                    userText: '单机端口配置',
                    replyText: '已记录。',
                    createdAt: new Date('2026-10-01T00:00:00Z'),
                  },
                ],
              }),
            }),
          }
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [{ envs: ['mac'], allowedRealms: null }],
            }),
          }),
        }
      }),
      delete: vi.fn(() => ({
        where: async () => undefined,
      })),
    } as unknown as Db

    const writeEpisode = vi.fn(async () => ({ shortId: 'm-345bcd' }))
    const fakeEntryService = { writeEpisode } as unknown as EntryService

    const outcome = await extractEpisodeBatch(fakeDb, null, fakeEntryService, {
      deviceKey: 'home-24',
      projectSlug: 'kioku',
    })

    expect(outcome).toEqual({ turns: 1, createdShortId: 'm-345bcd' })
    expect(capturedMessages[0]?.[1]?.content).toMatch(/^项目：kioku · 设备：home-24\n\n/)
  })

  it('按 sessionId 分段标注会话边界、输出三槽结构化信号并按 focusRealms ∩ allowedRealms 归因场域', async () => {
    capturedMessages.length = 0
    nextChatPayload = {
      title: '拆 PR 规范与测试库端口',
      summary: '确认按职责拆分 PR 提交，并记录测试库端口 55432。',
      facts: ['本地测试 PostgreSQL 映射端口为 55432'],
      directives: ['按职责拆分 PR 提交', 'PR 合并后清理工作区与本地分支'],
    }
    try {
      let selectCall = 0
      const fakeDb = {
        select: vi.fn(() => {
          selectCall++
          if (selectCall === 1) {
            return {
              from: () => ({
                where: () => ({
                  orderBy: async () => [
                    {
                      id: 21,
                      keyId: '00000000-0000-4000-8000-000000000021',
                      deviceKey: 'mac-work',
                      projectSlug: 'kioku',
                      sessionId: 'sess-alpha',
                      userText: '以后修改记得按职责拆分 PR',
                      replyText: '好的，会拆分 PR 并清理工作区。',
                      createdAt: new Date('2026-10-01T00:00:00Z'),
                    },
                    {
                      id: 22,
                      keyId: '00000000-0000-4000-8000-000000000021',
                      deviceKey: 'mac-work',
                      projectSlug: 'kioku',
                      sessionId: 'sess-beta',
                      userText: '测试库端口改成 55432 了',
                      replyText: '已记录。',
                      createdAt: new Date('2026-10-01T01:00:00Z'),
                    },
                  ],
                }),
              }),
            }
          }
          return {
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    name: 'Work Mac',
                    envs: ['mac'],
                    allowedRealms: ['work', 'personal'],
                    focusRealms: ['work'],
                  },
                ],
              }),
            }),
          }
        }),
        delete: vi.fn(() => ({
          where: async () => undefined,
        })),
      } as unknown as Db

      const writeEpisode = vi.fn(async () => ({ shortId: 'm-456cde' }))
      const fakeEntryService = { writeEpisode } as unknown as EntryService

      const outcome = await extractEpisodeBatch(fakeDb, null, fakeEntryService, {
        deviceKey: 'mac-work',
        projectSlug: 'kioku',
      })

      expect(outcome).toEqual({ turns: 2, createdShortId: 'm-456cde' })
      const userContent = capturedMessages[0]?.[1]?.content ?? ''
      expect(userContent).toContain('--- 会话 1 ---')
      expect(userContent).toContain('--- 会话 2 ---')
      expect(writeEpisode).toHaveBeenCalledWith({
        title: '拆 PR 规范与测试库端口',
        content: '确认按职责拆分 PR 提交，并记录测试库端口 55432。',
        deviceKey: 'mac-work',
        projectSlug: 'kioku',
        envs: ['mac'],
        realms: ['work'],
        projects: ['kioku'],
        facts: ['本地测试 PostgreSQL 映射端口为 55432'],
        directives: ['按职责拆分 PR 提交', 'PR 合并后清理工作区与本地分支'],
      })
    } finally {
      nextChatPayload = {
        title: 'home-24 本机代理端口',
        summary: '仅适用于 home-24 机器，本地代理端口调整为 7890。',
      }
    }
  })

  it('严守仅通用密钥 allowedRealms=[] 边界，不被 focusRealms 绕过写入受限场域', async () => {
    expect(resolveAllowedRealmsWithFocus([], ['work'])).toEqual([])
    expect(resolveAllowedRealmsWithFocus(['work'], ['personal'])).toEqual(['work'])
    expect(resolveAllowedRealmsWithFocus(['work', 'personal'], ['work'])).toEqual(['work'])
    expect(resolveAllowedRealmsWithFocus(null, ['work'])).toEqual(['work'])

    capturedMessages.length = 0
    let selectCall = 0
    const fakeDb = {
      select: vi.fn(() => {
        selectCall++
        if (selectCall === 1) {
          return {
            from: () => ({
              where: () => ({
                orderBy: async () => [
                  {
                    id: 31,
                    keyId: '00000000-0000-4000-8000-000000000031',
                    deviceKey: 'mac-universal',
                    projectSlug: 'kioku',
                    sessionId: 'sess-u1',
                    userText: '通用脚本说明',
                    replyText: '已记录。',
                    createdAt: new Date('2026-10-01T00:00:00Z'),
                  },
                ],
              }),
            }),
          }
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [
                {
                  name: 'Universal Only Key',
                  envs: ['mac'],
                  allowedRealms: [],
                  focusRealms: ['work'],
                },
              ],
            }),
          }),
        }
      }),
      delete: vi.fn(() => ({
        where: async () => undefined,
      })),
    } as unknown as Db

    const writeEpisode = vi.fn(async () => ({ shortId: 'm-567def' }))
    const fakeEntryService = { writeEpisode } as unknown as EntryService

    const outcome = await extractEpisodeBatch(fakeDb, null, fakeEntryService, {
      deviceKey: 'mac-universal',
      projectSlug: 'kioku',
    })
    expect(outcome.createdShortId).toBe('m-567def')
    expect(writeEpisode).toHaveBeenCalledWith(
      expect.objectContaining({
        realms: [],
      }),
    )
  })
})

describe('buildEpisodeMessages 与 evaluateEpisodeResponse 细节边界', () => {
  it('交替 sessionId 复用原会话编号，混合空 sessionId 单独标注，并按上限保留最新轮次', () => {
    const msgs = buildEpisodeMessages(
      [
        { sessionId: 'sess-a', userText: '甲首轮', replyText: '答甲首轮' },
        { sessionId: 'sess-b', userText: '乙首轮', replyText: '答乙首轮' },
        { sessionId: '', userText: '未标识轮', replyText: '答未标识轮' },
        { sessionId: 'sess-a', userText: '甲次轮', replyText: '答甲次轮' },
      ],
      { projectSlug: 'kioku' },
    )
    const userContent = msgs[1]!.content
    const markers = userContent.match(/--- .* ---/g)
    expect(markers).toEqual([
      '--- 会话 1 ---',
      '--- 会话 2 ---',
      '--- 未标识会话 ---',
      '--- 会话 1 ---',
    ])

    // 超出 12,000 字符时保留最新轮次、裁掉较早轮次
    const longTurns = Array.from({ length: 20 }, (_, i) => ({
      sessionId: 'sess-long',
      userText: `第${i + 1}轮：${'甲'.repeat(800)}`,
      replyText: `答${i + 1}：${'乙'.repeat(200)}`,
    }))
    const clipped = buildEpisodeMessages(longTurns, {})[1]!.content
    expect(clipped).toContain('第20轮：')
    expect(clipped).not.toContain('第1轮：')
  })

  it('保留信号中的比较符与泛型尖括号，兼容空 summary 回退与旧版无信号响应', () => {
    const withAngles = evaluateEpisodeResponse(
      JSON.stringify({
        title: '版本约束',
        summary: '',
        facts: ['Node >= 22 且 valid_to <= now() 视为过期', '泛型使用 Array<string>'],
        directives: ['确保版本 >= 22 才发布'],
      }),
    )
    expect(withAngles.status).toBe('summary')
    if (withAngles.status === 'summary') {
      expect(withAngles.data.facts).toEqual([
        'Node >= 22 且 valid_to <= now() 视为过期',
        '泛型使用 Array<string>',
      ])
      expect(withAngles.data.directives).toEqual(['确保版本 >= 22 才发布'])
      expect(withAngles.data.summary).toContain('确保版本 >= 22 才发布')
    }

    const legacy = evaluateEpisodeResponse(
      JSON.stringify({
        title: '旧版格式',
        summary: '仅包含标题和摘要。',
      }),
    )
    expect(legacy).toEqual({
      status: 'summary',
      data: {
        title: '旧版格式',
        summary: '仅包含标题和摘要。',
        facts: [],
        directives: [],
      },
    })
  })
})
