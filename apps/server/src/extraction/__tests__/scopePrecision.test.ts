import { DreamEntrySnapshot } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { toPromptItem } from '../dream'
import {
  buildDreamMessages,
  buildEpisodeReconcileMessages,
  evaluateDreamResponse,
  type DreamPromptItem,
} from '../dreamPrompt'
import { buildEpisodeMessages } from '../prompt'

function makeRow(
  overrides: Partial<Parameters<typeof toPromptItem>[0]> = {},
): Parameters<typeof toPromptItem>[0] {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    shortId: 'm-234abc',
    kind: 'episode',
    title: '本机代理端口排查',
    summary: null,
    content: '在 home-24 局域网主机上代理监听 7890 端口。',
    disclosure: null,
    bootMode: 'none',
    envs: ['mac'],
    realms: ['work'],
    projects: ['kioku'],
    runtimes: [],
    topics: ['network'],
    deviceKey: 'home-24',
    version: 1,
    updatedAt: new Date('2026-10-02T08:00:00Z'),
    ...overrides,
  }
}

describe('会话摘要与整理提示词的主机边界透传', () => {
  it('buildEpisodeMessages 正确拼装设备与终端名头部并包含防泛化硬规则', () => {
    const turns = [
      { userText: '本机 /opt/local 目录挂载异常', replyText: '仅在 home-24 调整了 fstab。' },
    ]

    const withBoth = buildEpisodeMessages(turns, {
      projectSlug: '  kioku  ',
      deviceKey: 'home-24',
      deviceName: 'Home MacBook',
    })
    expect(withBoth[0]?.content).toContain('单机配置')
    expect(withBoth[0]?.content).toContain('明确注明适用设备、主机或前提条件')
    expect(withBoth[1]?.content).toMatch(/^项目：kioku · 设备：home-24（Home MacBook）\n\n/)

    const blankProject = buildEpisodeMessages(turns, {
      projectSlug: '   ',
      deviceKey: 'home-24',
    })
    expect(blankProject[1]?.content).toMatch(/^设备：home-24\n\n/)

    const sameName = buildEpisodeMessages(turns, {
      deviceKey: 'home-24',
      deviceName: 'home-24',
    })
    expect(sameName[1]?.content).toMatch(/^设备：home-24\n\n/)

    const nameOnly = buildEpisodeMessages(turns, {
      deviceName: 'Office Mini',
    })
    expect(nameOnly[1]?.content).toMatch(/^终端：Office Mini\n\n/)
  })

  it('toPromptItem 保留非空 deviceKey 并在 dream 与对账提示词中显式输出 device= 标签', () => {
    const episodeItem = toPromptItem(makeRow({ deviceKey: ' home-24 ' }))
    expect(episodeItem.deviceKey).toBe('home-24')

    const formalItem = toPromptItem(
      makeRow({
        id: '00000000-0000-4000-8000-000000000002',
        shortId: 'm-345bcd',
        kind: 'entry',
        title: '开发环境网络说明',
        deviceKey: '   ',
      }),
    )
    expect(formalItem.deviceKey).toBeUndefined()

    const dreamMsgs = buildDreamMessages([episodeItem], [formalItem])
    expect(dreamMsgs[0]?.content).toContain('禁止将特定机器、局域网主机')
    expect(dreamMsgs[0]?.content).toContain('明确保留适用机器与前提条件')
    expect(dreamMsgs[0]?.content).toContain('envs 中避免给单机特例盲目打上过于宽泛的通用标签')
    expect(dreamMsgs[1]?.content).toContain('env=mac device=home-24')
    expect(dreamMsgs[1]?.content).not.toContain(
      '[m-345bcd] (entry, 26字) 开发环境网络说明 | 更新于 2026-10-02 | project=kioku env=mac device=',
    )

    const reconcileMsgs = buildEpisodeReconcileMessages(episodeItem, [formalItem])
    expect(reconcileMsgs[0]?.content).toContain('禁止将特定机器、局域网主机')
    expect(reconcileMsgs[0]?.content).toContain('明确保留适用机器与前提条件')
    expect(reconcileMsgs[1]?.content).toContain('device=home-24')
  })

  it('evaluateDreamResponse 保留自定义主机标识 envs 并校验 DreamEntrySnapshot 兼容 deviceKey', () => {
    const ep: DreamPromptItem = toPromptItem(makeRow())
    const catalog = new Map([[ep.shortId, ep]])
    const raw = JSON.stringify({
      suggestions: [
        {
          kind: 'distill_episode',
          target_short_ids: ['m-234abc'],
          title: 'home-24 本机代理端口约定',
          summary: '仅适用于 home-24 局域网主机，代理端口为 7890。',
          content: '仅限家里 home-24 这台 macOS 机器生效：本地代理监听 127.0.0.1:7890。',
          disclosure: '在 home-24 机器排查或配置本地代理时参考',
          envs: ['home-24'],
          projects: ['kioku'],
          reason: '保留单机主机边界，避免泛化为全局 macOS 规则',
        },
      ],
    })
    const evaluated = evaluateDreamResponse(raw, catalog)
    expect(evaluated.status).toBe('ok')
    if (evaluated.status === 'ok') {
      expect(evaluated.proposals).toHaveLength(1)
      expect(evaluated.proposals[0]?.proposedEnvs).toEqual(['home-24'])
      expect(evaluated.proposals[0]?.proposedDisclosure).toContain('home-24')
    }

    const parsedWithDevice = DreamEntrySnapshot.parse({
      id: '00000000-0000-4000-8000-000000000001',
      shortId: 'm-234abc',
      kind: 'episode',
      title: '摘要',
      content: '正文',
      disclosure: null,
      isPinned: false,
      envs: ['mac'],
      realms: [],
      projects: [],
      runtimes: [],
      topics: [],
      deviceKey: 'home-24',
      version: 1,
      updatedAt: '2026-10-02T08:00:00Z',
    })
    expect(parsedWithDevice.deviceKey).toBe('home-24')

    const parsedWithoutDevice = DreamEntrySnapshot.parse({
      id: '00000000-0000-4000-8000-000000000002',
      shortId: 'm-345bcd',
      kind: 'entry',
      title: '正式记忆',
      content: '正文',
      disclosure: null,
      isPinned: false,
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      topics: [],
      version: 1,
      updatedAt: '2026-10-02T08:00:00Z',
    })
    expect(parsedWithoutDevice.deviceKey).toBeUndefined()
  })
})
