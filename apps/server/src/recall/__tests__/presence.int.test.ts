import { BootResponse, RecallResponse } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import { embedEntryIds } from '../../embedding/worker'
import type { Database } from '../../db/client'
import { EntryService } from '../../memory/service'
import { EMBEDDING_SETTING_KEY, saveModelEndpoint } from '../../models/store'
import {
  createTestApp,
  entryInput,
  issueTestApiKey,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'
import { startFakeOpenAi, type FakeOpenAiServer } from '../../testing/fakeOpenAi'
import { compileBoot, formatBootBlock } from '../boot'
import { formatRecallBlock, recallEntries } from '../recall'

describe.skipIf(!testDatabaseUrl)('Presence Engine：启动加载与混合召回', () => {
  let database: Database
  let fakeAi: FakeOpenAiServer

  beforeAll(async () => {
    database = await openTestDatabase()
    fakeAi = await startFakeOpenAi()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await fakeAi.close()
    await database.close()
  })

  it('boot 剥离互斥场景常驻词条、按确定性顺序裁剪预算并加载本设备本项目的近期摘要', async () => {
    const masterKey = testMasterKey()
    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    // 通用常驻（必进）
    const universal = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '全局习惯',
        content: '回答一律简洁直接。',
        isPinned: true,
      }),
    )
    // 匹配 env=mac & project=kioku（必进）
    const matching = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Mac Kioku 规范',
        content: '本地使用 pnpm 与 vitest 跑门禁。',
        isPinned: true,
        envs: ['mac'],
        projects: ['kioku'],
      }),
    )
    // 冲突 env=linux（必须被剥离）
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Linux 专用配置',
        content: '使用 systemd 管理服务。',
        isPinned: true,
        envs: ['linux'],
      }),
    )
    // 冲突 project=other（必须被剥离）
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '其他项目规范',
        content: '使用 cargo test。',
        isPinned: true,
        projects: ['other'],
      }),
    )
    // 冲突 realm=personal（焦点在 work 时必须被剥离）
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '个人生活习惯',
        content: '晚上十一点前休息。',
        isPinned: true,
        realms: ['personal'],
      }),
    )
    // 超大常驻词条，用于验证整条原子预算裁决
    const huge = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '超长架构文档',
        content: '详'.repeat(1_000),
        isPinned: true,
      }),
    )

    // 写入本设备本项目的会话摘要，以及其他设备的摘要（后者不该出现）
    const epMatch = await entrySvc.writeEpisode({
      title: '昨日调试',
      content: '完成了数据库迁移。',
      deviceKey: 'macbook-pro',
      projectSlug: 'kioku',
      ttlDays: 7,
    })
    await entrySvc.writeEpisode({
      title: '其他设备摘要',
      content: '另一台机器的记录。',
      deviceKey: 'office-linux',
      projectSlug: 'kioku',
      ttlDays: 7,
    })

    const key = await issueTestApiKey(database, {
      runtimeFamily: 'claudecode',
      envs: ['mac'],
      allowedRealms: ['work'],
    })
    const keyScope = {
      kind: 'key' as const,
      keyId: key.id,
      name: 'Test Terminal',
      prefix: key.prefix,
      runtimeFamily: 'claudecode' as const,
      envs: ['mac'],
      allowedRealms: ['work'],
      canWrite: true,
      canResolveCredentials: false,
    }

    // 设预算为 300 字符：前两条匹配常驻装得下，huge 装不下应整条进 omitted
    const boot = await compileBoot(database.db, keyScope, {
      focus: { envs: ['mac'], realms: ['work'], projects: ['kioku'], runtimes: ['claudecode'] },
      budget: 300,
      deviceKey: 'macbook-pro',
      projectSlug: 'kioku',
    })
    BootResponse.parse(boot)
    expect(boot.entries.map((e) => e.shortId)).toEqual([
      universal.entry.shortId,
      matching.entry.shortId,
    ])
    expect(boot.omitted).toEqual([huge.entry.shortId])
    expect(boot.episodes.map((e) => e.shortId)).toEqual([epMatch.shortId])

    // HTTP 接口 GET /v1/boot 返回一致结构
    const app = createTestApp(database, { masterKey })
    const res = await app.request('/v1/boot?project=kioku&deviceKey=macbook-pro', {
      headers: { authorization: `Bearer ${key.key}` },
    })
    expect(res.status).toBe(200)
    const body = BootResponse.parse(await res.json())
    expect(body.entries.map((e) => e.shortId)).toContain(universal.entry.shortId)
    expect(body.entries.map((e) => e.shortId)).toContain(matching.entry.shortId)
    expect(body.episodes.map((e) => e.shortId)).toEqual([epMatch.shortId])
  })

  it('recall 结合 pgvector + BM25、温和场景加减分、1-hop 双链扩散与 allowed_realms 边界', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, EMBEDDING_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-embed-1024',
      apiKey: 'sk-test',
      enabled: true,
    })

    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    // 邻居词条（无查询关键词，靠 1-hop 双链扩散带出）
    const neighborOk = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '证书续期脚本',
        content: '每周日凌晨自动执行 acme 续签。',
        envs: ['mac'],
        realms: ['work'],
      }),
    )
    // 冲突场景邻居（env=linux，不应被 1-hop 扩散带出）
    const neighborConflict = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Linux 内核参数',
        content: 'sysctl 调优笔记。',
        envs: ['linux'],
        realms: ['work'],
      }),
    )
    // 被 allowed_realms 封锁的邻居（realm=personal，绝对不能泄露）
    const neighborForbidden = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '私人银行备忘',
        content: '绝密个人财务记录。',
        realms: ['personal'],
      }),
    )

    // 主命中词条（env=mac，匹配焦点）并链接到三个邻居
    const macMatch = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Kubernetes 集群网关排错',
        content: `nginx ingress 502 排查步骤，参考 [[${neighborOk.entry.shortId}]]、[[${neighborConflict.entry.shortId}]] 与 [[${neighborForbidden.entry.shortId}]]。`,
        envs: ['mac'],
        realms: ['work'],
        projects: ['kioku'],
      }),
    )
    // 跨场景词条（env=linux，同类内容；在 mac 焦点下受温和扣分但显式查询时仍能浮出）
    const linuxCross = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Linux 集群网关排错',
        content: 'nginx ingress 502 在 linux 节点上的 conntrack 排错。',
        envs: ['linux'],
        realms: ['work'],
      }),
    )
    // 完全不相关词条（应该低于 0.15 相关性地板被过滤）
    const unrelated = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '红烧肉菜谱',
        content: '五花肉切块焯水加冰糖小火慢炖。',
        envs: ['mac'],
        realms: ['work'],
      }),
    )

    // 为全部词条生成确定性向量
    await embedEntryIds(
      database.db,
      masterKey,
      [neighborOk, neighborConflict, neighborForbidden, macMatch, linuxCross, unrelated].map(
        (item) => item.entry.id,
      ),
    )

    const workKey = await issueTestApiKey(database, {
      runtimeFamily: 'claudecode',
      envs: ['mac'],
      allowedRealms: ['work'],
    })
    const workScope = {
      kind: 'key' as const,
      keyId: workKey.id,
      name: 'Work Key',
      prefix: workKey.prefix,
      runtimeFamily: 'claudecode' as const,
      envs: ['mac'],
      allowedRealms: ['work'],
      canWrite: true,
      canResolveCredentials: false,
    }

    const recalled = await recallEntries(
      database.db,
      masterKey,
      workScope,
      'nginx ingress 502 网关排错',
      {
        focus: { envs: ['mac'], realms: ['work'], projects: ['kioku'], runtimes: ['claudecode'] },
        limit: 10,
      },
    )

    const ids = recalled.map((c) => c.shortId)
    // macMatch 得分最高排第一
    expect(ids[0]).toBe(macMatch.entry.shortId)
    // 跨场景 linuxCross 仍可浮出（温和惩罚非硬过滤），但排在 macMatch 之后
    expect(ids).toContain(linuxCross.entry.shortId)
    expect(ids.indexOf(macMatch.entry.shortId)).toBeLessThan(ids.indexOf(linuxCross.entry.shortId))
    // 1-hop 扩散带出不冲突的 neighborOk（via 含 link），但不带出冲突邻居和越权邻居
    const linked = recalled.find((c) => c.shortId === neighborOk.entry.shortId)
    expect(linked?.via).toContain('link')
    expect(ids).not.toContain(neighborConflict.entry.shortId)
    expect(ids).not.toContain(neighborForbidden.entry.shortId)
    // 不相关菜谱被相关性地板滤掉
    expect(ids).not.toContain(unrelated.entry.shortId)

    // HTTP POST /v1/recall 端到端校验
    const app = createTestApp(database, { masterKey })
    const res = await app.request('/v1/recall', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workKey.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'nginx ingress 502 网关排错' }),
    })
    expect(res.status).toBe(200)
    const parsed = RecallResponse.parse(await res.json())
    expect(parsed.candidates[0]?.shortId).toBe(macMatch.entry.shortId)
    expect(parsed.candidates[0]?.updatedAt).toBeTruthy()
    expect(formatRecallBlock(parsed.candidates)).toContain('更新 ')
  })

  it('两遍渐进式 Boot 保护短规则展开并把巨型常驻降级为可读目录，同时 BM25F 标题权重高于正文偶发提及', async () => {
    const masterKey = testMasterKey()
    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    // 先建巨型常驻手册（在旧算法下会抢占先机吃光预算），再建短规范
    const giant = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '核心运维总览手册',
        summary: '汇总全部节点拓扑与编排边界。',
        content: `# 核心运维总览手册\n\n${'详细端口配置与运维说明。'.repeat(240)}`,
        changeSummary: '迁至统一编排平台',
        isPinned: true,
      }),
    )
    const shortRule = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '全局协作约定',
        content: '# 全局协作约定\n\n所有提交信息使用中文。',
        changeSummary: '明确中文提交规范',
        isPinned: true,
      }),
    )

    const boot = await compileBoot(database.db, consoleScope, {
      focus: { envs: [], realms: [], projects: [], runtimes: [] },
      budget: 2_000,
    })
    expect(boot.entries.map((e) => e.shortId)).toEqual([shortRule.entry.shortId])
    expect(boot.omitted).toEqual([giant.entry.shortId])
    expect(boot.omittedItems?.[0]?.summary).toBe('汇总全部节点拓扑与编排边界。')

    const rendered = formatBootBlock(boot, 'GUIDANCE')
    expect(rendered).toContain('核心运维总览手册')
    expect(rendered).toContain('汇总全部节点拓扑与编排边界。')
    expect(rendered).toContain('迁至统一编排平台')
    // 展示层自动去重正文首行与标题相同的 # H1
    expect(rendered).not.toMatch(/^# 全局协作约定$/m)

    // BM25F 字段权重验证：标题含「故障恢复」应高于仅正文提一次「故障恢复」
    const titleHit = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '数据库故障恢复指南',
        content: '备份检查与恢复步骤说明。',
      }),
    )
    const bodyOnly = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '日常开发排程备忘',
        content: '周会同步进度，顺便提一句数据库故障恢复演练安排在月底。',
      }),
    )
    const hits = await recallEntries(database.db, masterKey, consoleScope, '数据库故障恢复', {
      focus: { envs: [], realms: [], projects: [], runtimes: [] },
      useSemantic: false,
      includeLinks: false,
      limit: 5,
    })
    expect(hits[0]?.shortId).toBe(titleHit.entry.shortId)
    expect(hits.findIndex((c) => c.shortId === titleHit.entry.shortId)).toBeLessThan(
      hits.findIndex((c) => c.shortId === bodyOnly.entry.shortId),
    )

    // 验证多条超软上限（2500字）常驻在 6850 预算下仍能展开合理条数而非全部跳过导致零展开
    for (let i = 1; i <= 3; i++) {
      await entrySvc.create(
        consoleScope,
        entryInput({
          title: `中型常驻手册${i}`,
          summary: `第 ${i} 份手册概要`,
          content: `第${i}份规则。`.repeat(420),
          isPinned: true,
          envs: ['linux'],
        }),
      )
    }
    const mediumBoot = await compileBoot(database.db, consoleScope, {
      focus: { envs: ['linux'], realms: [], projects: [], runtimes: [] },
      budget: 6_850,
    })
    expect(mediumBoot.entries.length).toBeGreaterThanOrEqual(2)
    expect(mediumBoot.omitted.length).toBeGreaterThanOrEqual(1)
  })
})
