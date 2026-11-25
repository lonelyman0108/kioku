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
import { compileBoot } from '../boot'
import { recallEntries } from '../recall'

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
  })
})
