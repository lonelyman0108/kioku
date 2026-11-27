import { describe, expect, it, vi } from 'vitest'

import type { Db } from '../../db/client'
import type { EntryService } from '../../memory/service'
import type { ChatMessage } from '../../models/client'

const capturedMessages: ChatMessage[][] = []

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
        content: JSON.stringify({
          title: 'home-24 本机代理端口',
          summary: '仅适用于 home-24 机器，本地代理端口调整为 7890。',
        }),
      }
    }),
  }
})

import { extractEpisodeBatch } from '../extract'

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
})
