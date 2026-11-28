import { BootResponse, RecallResponse } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import { embedEntryIds } from '../../embedding/worker'
import type { Database } from '../../db/client'
import { entries } from '../../db/schema'
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
import { compileBoot, compileBootDetailed, formatBootBlock, loadRecentEntries } from '../boot'
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
    // 全文展开严格按场景精准度分层输出（项目/客户端精准匹配排在全局通用之前）
    expect(boot.entries.map((e) => e.shortId)).toEqual([
      matching.entry.shortId,
      universal.entry.shortId,
    ])
    expect(boot.omitted).toEqual([huge.entry.shortId])
    expect(boot.episodes.map((e) => e.shortId)).toEqual([epMatch.shortId])

    const renderedBoot = formatBootBlock(boot, 'GUIDANCE')
    expect(renderedBoot).toContain('按场景优先级从高到低排列')
    expect(renderedBoot.indexOf(matching.entry.shortId)).toBeLessThan(
      renderedBoot.indexOf(universal.entry.shortId),
    )

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

    // 验证单条超过 2,400 字的全文常驻自动降级为目录行，而 2,400 字以内的场景常驻正常展开
    const overCap = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '超单条上限手册',
        summary: '超过 2,400 字的运维参考手册',
        content: '详细配置说明。'.repeat(420),
        bootMode: 'full',
        envs: ['linux'],
      }),
    )
    const normalLinuxA = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '常规 Linux 规范 A',
        content: '常规短规范。'.repeat(180),
        bootMode: 'full',
        envs: ['linux'],
      }),
    )
    const normalLinuxB = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '常规 Linux 规范 B',
        content: '常规短规范。'.repeat(180),
        bootMode: 'full',
        envs: ['linux'],
      }),
    )
    const mediumBoot = await compileBoot(database.db, consoleScope, {
      focus: { envs: ['linux'], realms: [], projects: [], runtimes: [] },
      budget: 6_850,
    })
    expect(mediumBoot.entries.map((e) => e.shortId)).toContain(normalLinuxA.entry.shortId)
    expect(mediumBoot.entries.map((e) => e.shortId)).toContain(normalLinuxB.entry.shortId)
    expect(mediumBoot.omitted).toContain(overCap.entry.shortId)
    expect(mediumBoot.omittedItems?.find((i) => i.shortId === overCap.entry.shortId)?.reason).toBe(
      'oversized',
    )
  })

  it('三态 boot_mode、精准场景优先分桶、全局 50% 上限、自定义客户端、focus_realms 解耦与近期记忆零串场', async () => {
    const masterKey = testMasterKey()
    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    // 1. 目录常驻：固定进目录，永不消耗全文展开预算
    const indexManual = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '基础设施参考手册',
        summary: '记录集群拓扑与网关分层。',
        content: '简短参考内容。',
        bootMode: 'index',
      }),
    )

    // 2. 较长的项目精准常驻（1,800 字）与两条较长全局常驻（各 1,200 字）
    const projectExact = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Alpha 项目核心规范',
        content: '项目规范。'.repeat(360),
        bootMode: 'full',
        projects: ['alpha-app'],
      }),
    )
    const globalRuleA = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '全局协作铁律 A',
        content: '全局约定。'.repeat(240),
        bootMode: 'full',
      }),
    )
    const globalRuleB = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '全局协作铁律 B',
        content: '全局约定。'.repeat(240),
        bootMode: 'full',
      }),
    )

    // 3. 自定义客户端 zcode 专属常驻 + 个人场域常驻 + 其他项目非常驻（验证 loadRecentEntries 零串场）
    const zcodeRule = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'ZCode 运行时约束',
        content: '仅在 zcode 终端生效的短约束。',
        bootMode: 'full',
        runtimes: ['zcode'],
      }),
    )
    const personalPinned = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '个人作息提醒',
        content: '仅个人场域常驻。',
        bootMode: 'full',
        realms: ['personal'],
      }),
    )
    const otherProjRecent = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Beta 项目最近改动',
        content: '属于另一个项目的近期记忆。',
        projects: ['beta-app'],
      }),
    )
    const sameProjRecent = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Alpha 项目最近改动',
        content: '属于当前项目的近期记忆。',
        projects: ['alpha-app'],
      }),
    )

    // 密钥不限 allowedRealms（可查全部），但设 focusRealms=['work']
    const key = await issueTestApiKey(database, {
      runtimeFamily: 'generic',
      envs: ['mac'],
      allowedRealms: null,
      focusRealms: ['work'],
    })
    const keyScope = {
      kind: 'key' as const,
      keyId: key.id,
      name: 'Flexible Key',
      prefix: key.prefix,
      runtimeFamily: 'generic' as const,
      envs: ['mac'],
      allowedRealms: null,
      focusRealms: ['work'],
      canWrite: true,
      canResolveCredentials: false,
    }

    // 预算 4,000（全局 50% 帽 = 2,000）：
    // - 桶 1（projectExact ~1,830 + zcodeRule ~45）优先展开，绝不被更短的全局项挤掉
    // - 桶 3（globalRuleA ~1,230 展开，globalRuleB ~1,230 超全局 2,000 帽被降级）
    // - indexManual 直接进目录（reason='index'），personalPinned 因 focus_realms=['work'] 在 boot 被排除
    const detailed = await compileBootDetailed(database.db, keyScope, {
      focus: {
        envs: ['mac'],
        realms: ['work'],
        projects: ['alpha-app', 'alpha-app-wt'],
        runtimes: ['zcode'],
      },
      budget: 4_000,
    })

    expect(detailed.expanded.map((e) => e.shortId)).toContain(projectExact.entry.shortId)
    expect(detailed.expanded.map((e) => e.shortId)).toContain(zcodeRule.entry.shortId)
    expect(detailed.expanded.map((e) => e.shortId)).toContain(globalRuleA.entry.shortId)
    expect(detailed.expanded.map((e) => e.shortId)).not.toContain(globalRuleB.entry.shortId)
    expect(detailed.expanded.map((e) => e.shortId)).not.toContain(indexManual.entry.shortId)
    expect(detailed.indexed.map((i) => i.shortId)).toEqual([indexManual.entry.shortId])
    expect(detailed.demoted.map((i) => i.shortId)).toEqual([globalRuleB.entry.shortId])
    expect(detailed.demoted[0]?.reason).toBe('budget')
    expect(detailed.excluded.map((i) => i.shortId)).toContain(personalPinned.entry.shortId)

    // GET /v1/boot 支持自定义 runtime=zcode 且继承 key.focusRealms
    const app = createTestApp(database, { masterKey })
    const bootRes = await app.request('/v1/boot?project=alpha-app&runtime=zcode', {
      headers: { authorization: `Bearer ${key.key}` },
    })
    expect(bootRes.status).toBe(200)
    const bootBody = BootResponse.parse(await bootRes.json())
    expect(bootBody.entries.map((e) => e.shortId)).toContain(zcodeRule.entry.shortId)
    expect(bootBody.entries.map((e) => e.shortId)).not.toContain(personalPinned.entry.shortId)
    expect(
      bootBody.omittedItems?.find((i) => i.shortId === indexManual.entry.shortId)?.reason,
    ).toBe('index')

    // 但 focus_realms 不改变安全硬边界：recall 仍能查到 personalPinned
    const recalledPersonal = await recallEntries(database.db, masterKey, keyScope, '个人作息提醒', {
      focus: { envs: ['mac'], realms: ['work'], projects: [], runtimes: [] },
      useSemantic: false,
      includeLinks: false,
    })
    expect(recalledPersonal.map((c) => c.shortId)).toContain(personalPinned.entry.shortId)

    // loadRecentEntries 过滤跨项目与互斥场景词条，避免串场
    const recent = await loadRecentEntries(database.db, keyScope, {
      limit: 10,
      focus: { envs: ['mac'], realms: ['work'], projects: ['alpha-app'], runtimes: ['codex'] },
    })
    const recentIds = recent.map((r) => r.shortId)
    expect(recentIds).toContain(sameProjRecent.entry.shortId)
    expect(recentIds).not.toContain(otherProjRecent.entry.shortId)
    expect(recentIds).not.toContain(zcodeRule.entry.shortId)
    expect(recentIds).not.toContain(personalPinned.entry.shortId)
  })

  it('混合检索中尚未完成异步嵌入的新词条不承受 0.35 混合折损，仍可按全文立即召回', async () => {
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

    // 已完成向量嵌入的既有词条，使本次检索进入 hybrid 分支（vectorHitCount > 0）
    const alreadyEmbedded = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '既有网络拓扑说明',
        content: '核心交换机与网关端口分配。',
      }),
    )
    await embedEntryIds(database.db, masterKey, [alreadyEmbedded.entry.id])

    // 刚刚写入、尚未生成向量的新词条，与查询高度匹配
    const freshUnembedded = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '量子编译流水线缓存键规范',
        content: '构建阶段统一使用量子编译流水线缓存键规范防止产物串用。',
      }),
    )

    const hits = await recallEntries(
      database.db,
      masterKey,
      consoleScope,
      '量子编译流水线缓存键规范',
      {
        focus: { envs: [], realms: [], projects: [], runtimes: [] },
        includeLinks: false,
        limit: 5,
      },
    )
    const hit = hits.find((c) => c.shortId === freshUnembedded.entry.shortId)
    expect(hit).toBeDefined()
    expect(hit!.via).toEqual(['fulltext'])
    // 若误施加 0.35 混合折扣，即使全文分 0.65 也会掉到 ~0.227；未嵌入新词条应保留完整全文基础分
    expect(hit!.score).toBeGreaterThan(0.4)
  })

  it('loadRecentEntries 按 verifiedAt ?? createdAt 语义时间排序并输出对应日期，避免结构清洗旧词条霸占近期列表', async () => {
    const masterKey = testMasterKey()
    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const olderCleaned = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '历史运维手册',
        content: '# 历史运维手册\n\n旧版服务器配置说明。',
      }),
    )
    const unverifiedLegacy = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '无核实时间旧记录',
        content: '只有创建时间的老记录。',
      }),
    )
    const freshEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '今日新决策',
        content: '今天刚定下来的部署策略。',
      }),
    )

    const oldVerifiedAt = new Date('2026-01-10T08:00:00.000Z')
    const midCreatedAt = new Date('2026-02-15T08:00:00.000Z')
    const freshVerifiedAt = new Date('2026-03-20T08:00:00.000Z')

    await database.db
      .update(entries)
      .set({ createdAt: oldVerifiedAt, verifiedAt: oldVerifiedAt, updatedAt: oldVerifiedAt })
      .where(eq(entries.id, olderCleaned.entry.id))
    await database.db
      .update(entries)
      .set({ createdAt: midCreatedAt, verifiedAt: null, updatedAt: midCreatedAt })
      .where(eq(entries.id, unverifiedLegacy.entry.id))
    await database.db
      .update(entries)
      .set({ createdAt: freshVerifiedAt, verifiedAt: freshVerifiedAt, updatedAt: freshVerifiedAt })
      .where(eq(entries.id, freshEntry.entry.id))

    // 对历史运维手册执行结构检查清洗：其 updatedAt 变为当前时间，但 verifiedAt 仍保持 2026-01-10
    const sweep = await entrySvc.applyHygieneSweep({ shortIds: [olderCleaned.entry.shortId] })
    expect(sweep.applied).toBe(1)

    const recent = await loadRecentEntries(database.db, consoleScope, { limit: 5 })
    expect(recent.map((r) => r.shortId)).toEqual([
      freshEntry.entry.shortId,
      unverifiedLegacy.entry.shortId,
      olderCleaned.entry.shortId,
    ])
    expect(recent[0]!.updatedAt).toBe(freshVerifiedAt.toISOString())
    expect(recent[1]!.updatedAt).toBe(midCreatedAt.toISOString())
    expect(recent[2]!.updatedAt).toBe(oldVerifiedAt.toISOString())
  })
})
