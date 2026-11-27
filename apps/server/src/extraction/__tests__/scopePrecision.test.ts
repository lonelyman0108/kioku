import { DreamEntrySnapshot, mergeFallbackTopics } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  buildHabitClusters,
  computeNormalizedCentroid,
  countDistinctHabitSessions,
  habitClusterDiscriminator,
} from '../crossMemory'
import { toPromptItem } from '../dream'
import {
  buildDreamMessages,
  buildEpisodeReconcileMessages,
  buildHabitDistillMessages,
  buildTidyMessages,
  evaluateDreamResponse,
  evaluateTidyResponse,
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

  it('distill_episode 区分显式 [] 放宽与省略回退、支持 proposed_boot_mode 且严守 realms fail-closed', () => {
    const ep: DreamPromptItem = toPromptItem(
      makeRow({
        realms: ['work'],
        envs: ['mac'],
        projects: ['kioku'],
      }),
    )
    const catalog = new Map([[ep.shortId, ep]])
    const evaluated = evaluateDreamResponse(
      JSON.stringify({
        suggestions: [
          {
            kind: 'distill_episode',
            target_short_ids: [ep.shortId],
            title: '提交前拆分 PR 规范',
            summary: '代码修改按职责拆分 PR，合并后清理本地工作区与分支。',
            content: '涉及代码改动时统一拆分 PR 提交，合并后删除临时分支。',
            topics: ['git', 'workflow'],
            envs: [],
            projects: [],
            realms: [],
            proposed_boot_mode: 'full',
            reason: '跨项目高频工作流铁律，显式放宽项目与环境但保留 work 场域',
          },
        ],
      }),
      catalog,
    )
    expect(evaluated.status).toBe('ok')
    if (evaluated.status === 'ok') {
      expect(evaluated.proposals).toHaveLength(1)
      const prop = evaluated.proposals[0]!
      expect(prop.proposedProjects).toEqual([])
      expect(prop.proposedEnvs).toEqual([])
      // realms 空数组一律视为无效（null），应用时继续沿用源 episode 的 work 场域
      expect(prop.proposedRealms).toBeNull()
      expect(prop.proposedTopics).toEqual(['git', 'workflow'])
      expect(prop.proposedBootMode).toBe('full')
    }

    // update 与 merge_duplicates 输出占位 envs: [] / projects: [] / runtimes: [] / topics: [] 时一律视作 null，严禁静默清空既有作用域
    const entryA = toPromptItem(
      makeRow({
        id: '00000000-0000-4000-8000-000000000011',
        shortId: 'm-456cde',
        kind: 'entry',
        title: '单机服务规范 A',
        envs: ['home-24'],
        projects: ['kioku'],
        runtimes: ['claudecode'],
        topics: ['docker'],
      }),
    )
    const entryB = toPromptItem(
      makeRow({
        id: '00000000-0000-4000-8000-000000000012',
        shortId: 'm-567def',
        kind: 'entry',
        title: '单机服务规范 B',
        envs: ['home-24'],
        projects: ['kioku'],
        runtimes: ['claudecode'],
        topics: ['deploy'],
      }),
    )
    const entryCatalog = new Map([
      [entryA.shortId, entryA],
      [entryB.shortId, entryB],
    ])
    const evaluatedEntry = evaluateDreamResponse(
      JSON.stringify({
        suggestions: [
          {
            kind: 'update',
            target_short_ids: [entryA.shortId],
            content: '补充监听端口说明。',
            envs: [],
            projects: [],
            runtimes: [],
            topics: [],
            realms: [],
            reason: '补充端口',
          },
          {
            kind: 'merge_duplicates',
            target_short_ids: [entryA.shortId, entryB.shortId],
            keep_short_id: entryA.shortId,
            title: '单机服务规范',
            content: '合并后的完整单机服务规范。',
            envs: [],
            projects: [],
            runtimes: [],
            topics: [],
            reason: '合并重复',
          },
        ],
      }),
      entryCatalog,
    )
    expect(evaluatedEntry.status).toBe('ok')
    if (evaluatedEntry.status === 'ok') {
      expect(evaluatedEntry.proposals).toHaveLength(2)
      for (const p of evaluatedEntry.proposals) {
        expect(p.proposedEnvs).toBeNull()
        expect(p.proposedProjects).toBeNull()
        expect(p.proposedRuntimes).toBeNull()
        expect(p.proposedTopics).toBeNull()
        expect(p.proposedRealms).toBeNull()
      }
    }
  })

  it('buildTidyMessages 透传高频主题参考，evaluateTidyResponse 支持仅调整 topics 或 disclosure', () => {
    const entryItem: DreamPromptItem = toPromptItem(
      makeRow({
        kind: 'entry',
        title: '容器部署规范',
        summary: '轻应用统一用 compose 编排部署。',
        content: '## 现行规范\n- 使用 compose 管理容器。',
        disclosure: null,
        topics: ['docker', 'deploy', 'tmp1', 'tmp2', 'tmp3', 'tmp4', 'tmp5', 'tmp6', 'tmp7'],
      }),
    )

    const msgs = buildTidyMessages(entryItem, ['docker', 'postgres', 'network'])
    expect(msgs[1]?.content).toContain('库内高频主题参考')
    expect(msgs[1]?.content).toContain('docker、postgres、network')

    // 仅收敛主题与补齐触发场景，标题/概要/正文不变时也应产出 proposal
    const res = evaluateTidyResponse(
      JSON.stringify({
        needed: true,
        title: entryItem.title,
        summary: entryItem.summary,
        content: entryItem.content,
        topics: ['docker', 'deploy'],
        disclosure: '新增或调整容器编排配置时查阅',
        change_summary: '收敛主题标签并补齐触发场景',
        archived_notes: [],
        reason: '收敛膨胀主题并补充召回触发场景',
      }),
      entryItem,
    )
    expect(res.status).toBe('proposal')
    if (res.status === 'proposal') {
      expect(res.proposal.proposedTopics).toEqual(['deploy', 'docker'])
      expect(res.proposal.proposedDisclosure).toBe('新增或调整容器编排配置时查阅')
    }

    // 若 topics 与 disclosure 也均与原值相同，应判定为 not_needed
    const unchangedRes = evaluateTidyResponse(
      JSON.stringify({
        needed: true,
        title: entryItem.title,
        summary: entryItem.summary,
        content: entryItem.content,
        topics: entryItem.topics,
        disclosure: null,
      }),
      entryItem,
    )
    expect(unchangedRes.status).toBe('not_needed')

    // mergeFallbackTopics 优先保留共现与 keep 主题并上限收敛为 5 个
    expect(
      mergeFallbackTopics(
        ['docker', 'k1', 'k2', 'k3'],
        [
          ['docker', 'k1', 'k2', 'k3'],
          ['docker', 'shared', 'b1', 'b2', 'b3', 'b4'],
          ['shared', 'c1', 'c2'],
        ],
      ),
    ).toEqual(['docker', 'k1', 'k2', 'k3', 'shared'])
  })

  it('跨会话偏好聚簇严格区分独立会话、严守同场域边界并生成稳定簇指纹与提示词', () => {
    // 同一设备同一项目 15 分钟内连续落桶（即使跨 UTC 零点）仅计 1 次独立会话
    expect(
      countDistinctHabitSessions([
        {
          deviceKey: 'mac-home',
          projectSlug: 'kioku',
          createdAt: new Date('2026-11-26T23:55:00Z'),
        },
        {
          deviceKey: 'mac-home',
          projectSlug: 'kioku',
          createdAt: new Date('2026-11-27T00:05:00Z'),
        },
      ]),
    ).toBe(1)

    // 同设备同项目间隔 >= 2 小时计为 2 次独立会话
    expect(
      countDistinctHabitSessions([
        {
          deviceKey: 'mac-home',
          projectSlug: 'kioku',
          createdAt: new Date('2026-11-27T08:00:00Z'),
        },
        {
          deviceKey: 'mac-home',
          projectSlug: 'kioku',
          createdAt: new Date('2026-11-27T10:30:00Z'),
        },
      ]),
    ).toBe(2)

    // 不同项目或不同设备即使同分钟也计为独立会话
    expect(
      countDistinctHabitSessions([
        {
          deviceKey: 'mac-home',
          projectSlug: 'kioku',
          createdAt: new Date('2026-11-27T08:00:00Z'),
        },
        {
          deviceKey: 'mac-home',
          projectSlug: 'kioku-plugins',
          createdAt: new Date('2026-11-27T08:05:00Z'),
        },
      ]),
    ).toBe(2)

    const epWorkA = {
      id: '00000000-0000-4000-8000-000000000101',
      realms: ['work'],
      deviceKey: 'mac-work',
      projectSlug: 'repo-a',
      createdAt: new Date('2026-11-25T10:00:00Z'),
    }
    const epWorkB = {
      id: '00000000-0000-4000-8000-000000000102',
      realms: ['work'],
      deviceKey: 'mac-work',
      projectSlug: 'repo-b',
      createdAt: new Date('2026-11-26T10:00:00Z'),
    }
    const epPersonal = {
      id: '00000000-0000-4000-8000-000000000103',
      realms: ['personal'],
      deviceKey: 'mac-home',
      projectSlug: 'kioku',
      createdAt: new Date('2026-11-26T12:00:00Z'),
    }
    const epSameSession = {
      id: '00000000-0000-4000-8000-000000000104',
      realms: ['work'],
      deviceKey: 'mac-work',
      projectSlug: 'repo-a',
      createdAt: new Date('2026-11-25T10:15:00Z'),
    }

    // 跨场域边被拦截，仅同场域且跨 >= 2 次独立会话的 work 对成簇
    const clusters = buildHabitClusters(
      [epWorkA, epWorkB, epPersonal],
      [
        { a: epWorkA.id, b: epPersonal.id, score: 0.99 },
        { a: epWorkA.id, b: epWorkB.id, score: 0.88 },
      ],
    )
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.map((r) => r.id).sort()).toEqual([epWorkA.id, epWorkB.id])

    // 仅同一次会话的 2 条摘要被克制门槛拦截，不成簇
    expect(
      buildHabitClusters(
        [epWorkA, epSameSession],
        [{ a: epWorkA.id, b: epSameSession.id, score: 0.95 }],
      ),
    ).toEqual([])

    const centroid = computeNormalizedCentroid([
      [1, 0, 0],
      [0, 1, 0],
    ])
    expect(centroid).toBeTruthy()
    expect(centroid![0]).toBeCloseTo(Math.SQRT1_2, 5)
    expect(centroid![1]).toBeCloseTo(Math.SQRT1_2, 5)

    // 稳定簇指纹与成员顺序无关，随版本变化
    const discForward = habitClusterDiscriminator([
      { id: epWorkA.id, version: 1 },
      { id: epWorkB.id, version: 1 },
    ])
    const discReverse = habitClusterDiscriminator([
      { id: epWorkB.id, version: 1 },
      { id: epWorkA.id, version: 1 },
    ])
    const discBumped = habitClusterDiscriminator([
      { id: epWorkA.id, version: 2 },
      { id: epWorkB.id, version: 1 },
    ])
    expect(discForward).toBe(discReverse)
    expect(discForward).not.toBe(discBumped)

    const epItemA = toPromptItem(
      makeRow({
        id: epWorkA.id,
        shortId: 'm-234abc',
        disclosure: '偏好：公司项目直接提交开发分支不提 PR',
        projects: ['repo-a'],
      }),
    )
    const epItemB = toPromptItem(
      makeRow({
        id: epWorkB.id,
        shortId: 'm-345bcd',
        disclosure: '偏好：公司代码直接推送开发分支',
        projects: ['repo-b'],
      }),
    )
    const msgs = buildHabitDistillMessages([epItemA, epItemB], [], {
      realms: ['work'],
      episodeCount: 2,
      distinctSessions: 2,
      projects: ['repo-a', 'repo-b'],
      devices: ['mac-work'],
      dateRange: '2026-11-25 至 2026-11-26',
    })
    expect(msgs[0]?.content).toContain('优先检查下方既有正式记忆')
    expect(msgs[1]?.content).toContain('估算独立会话数：2 次')
    expect(msgs[1]?.content).toContain('涉及项目：repo-a、repo-b')
    expect(msgs[1]?.content).toContain('提取偏好与指令：公司项目直接提交开发分支不提 PR')
  })
})
