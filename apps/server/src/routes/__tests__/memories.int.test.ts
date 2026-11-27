import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  BootPreviewResponse,
  CapturePlanResponse,
  EntryDetailResponse,
  EntryHistoryResponse,
  EntryListResponse,
  HygieneSweepApplyResponse,
  HygieneSweepPreviewResponse,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { entries } from '../../db/schema'
import { EntryService } from '../../memory/service'
import { CHAT_LLM_SETTING_KEY, saveModelEndpoint } from '../../models/store'
import {
  consoleHeaders,
  createOwnerSession,
  createTestApp,
  entryInput,
  issueTestApiKey,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'
import { startFakeOpenAi, type FakeOpenAiServer } from '../../testing/fakeOpenAi'

describe.skipIf(!testDatabaseUrl)('扁平记忆 CRUD、双链、筛选、回收站与历史恢复', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('支持新建、双链出链/反链、凭据占位符状态、筛选计数、lookup、历史版本恢复与回收站', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)

    await credSvc.create({
      slug: 'prod-db',
      label: 'Prod DB',
      value: 'postgres://secret@example.com/db',
      allowedRealms: ['work'],
    })

    // 1. 新建常驻词条（从正文首行 # 推导标题）
    const createA = await app.request('/v1/console/entries', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        content:
          '# 生产数据库规范\n连接字符串使用 {{cred:prod-db}}，缺失凭据示例 {{cred:missing-key}}。',
        isPinned: true,
        envs: ['linux'],
        realms: ['work'],
        projects: ['kioku'],
        topics: ['postgres', 'deploy'],
      }),
    })
    expect(createA.status).toBe(201)
    const detailA = EntryDetailResponse.parse(await createA.json())
    expect(detailA.entry.title).toBe('生产数据库规范')
    expect(detailA.entry.version).toBe(1)
    expect(detailA.credentialRefs).toEqual([
      { slug: 'prod-db', field: null, label: 'Prod DB', available: true },
      { slug: 'missing-key', field: null, label: null, available: false },
    ])

    // 2. 新建普通词条，双链指向 A
    const createB = await app.request('/v1/console/entries', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        title: '运维手册',
        content: `部署前先核对 [[${detailA.entry.shortId}]] 中的数据库要求。`,
        realms: ['work'],
        projects: ['kioku'],
        topics: ['deploy'],
      }),
    })
    expect(createB.status).toBe(201)
    const detailB = EntryDetailResponse.parse(await createB.json())
    expect(detailB.outboundLinks.map((l) => l.shortId)).toEqual([detailA.entry.shortId])

    // 查 A 时反链应包含 B
    const detailARefresh = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${detailA.entry.shortId}`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(detailARefresh.backlinks.map((l) => l.shortId)).toEqual([detailB.entry.shortId])

    // 3. 写入一条会话摘要，验证 tabs 计数、dynamic facets 与 promoteToEntry
    const ep = await entrySvc.writeEpisode({
      title: '调试摘要',
      content: '排查了数据库超时问题。',
      deviceKey: 'dev-mac',
      projectSlug: 'kioku',
      envs: ['mac'],
      realms: ['work'],
      projects: ['kioku'],
      ttlDays: 7,
    })

    const listAll = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=all', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(listAll.counts).toMatchObject({ all: 2, pinned: 1, regular: 1, episodes: 1, trash: 0 })
    expect(listAll.counts.pinnedChars).toBeGreaterThan(0)

    const listRegular = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=regular', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(listRegular.items.map((i) => i.shortId)).toEqual([detailB.entry.shortId])
    expect(listAll.facets.projects).toContain('kioku')
    expect(listAll.facets.envs).toContain('linux')
    expect(listAll.facets.realms).toContain('work')
    expect(listAll.facets.topics).toContain('postgres')

    // mode=lookup 快速补全检索（供 [[ 双链补全用）
    const lookup = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?mode=lookup&q=数据库', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(lookup.items.some((i) => i.shortId === detailA.entry.shortId)).toBe(true)

    // 4. 编辑会话摘要时携带无操作的 isPinned: false 正常放行；直接传 isPinned: true 被 400 拒绝
    const editEpisodeOk = await app.request(`/v1/console/entries/${ep.shortId}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        content: '排查了数据库超时问题（已补充日志）。',
        isPinned: false,
      }),
    })
    expect(editEpisodeOk.status).toBe(200)

    const pinEpisodeDenied = await app.request(`/v1/console/entries/${ep.shortId}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ isPinned: true }),
    })
    expect(pinEpisodeDenied.status).toBe(400)

    // 升级会话摘要为正式记忆，同时清空有效截止时间并支持标为常驻
    const promotedRes = await app.request(`/v1/console/entries/${ep.shortId}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        promoteToEntry: true,
        isPinned: true,
        title: '数据库超时排查结论',
      }),
    })
    expect(promotedRes.status).toBe(200)
    const promoted = EntryDetailResponse.parse(await promotedRes.json())
    expect(promoted.entry.kind).toBe('entry')
    expect(promoted.entry.isPinned).toBe(true)
    expect(promoted.entry.validTo).toBeNull()
    expect(promoted.entry.version).toBe(3)

    // 5. 乐观锁冲突（提交过期 expectedVersion 返回 409）
    const conflict = await app.request(`/v1/console/entries/${promoted.entry.shortId}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        expectedVersion: 1,
        content: '过期覆盖',
      }),
    })
    expect(conflict.status).toBe(409)

    // 6. 变更历史与按版本号回退恢复
    const history = EntryHistoryResponse.parse(
      await (
        await app.request(`/v1/console/entries/${promoted.entry.shortId}/history`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(history.items.length).toBeGreaterThanOrEqual(3)

    const restoreV1 = await app.request(`/v1/console/entries/${promoted.entry.shortId}/restore`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ version: 1 }),
    })
    expect(restoreV1.status).toBe(200)
    const restoredV1 = EntryDetailResponse.parse(await restoreV1.json())
    expect(restoredV1.entry.title).toBe('调试摘要')
    expect(restoredV1.entry.version).toBe(4)

    // 7. 软删除 -> 回收站列表 -> 撤销删除 -> 永久删除
    const softDel = await app.request(`/v1/console/entries/${detailB.entry.shortId}`, {
      method: 'DELETE',
      headers: consoleHeaders(cookie),
    })
    expect(softDel.status).toBe(204)

    const trashList = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=trash', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(trashList.counts.trash).toBe(1)
    expect(trashList.items.map((i) => i.shortId)).toEqual([detailB.entry.shortId])

    const undelete = await app.request(`/v1/console/entries/${detailB.entry.shortId}/restore`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(undelete.status).toBe(200)
    expect(EntryDetailResponse.parse(await undelete.json()).entry.deletedAt).toBeNull()

    const permanentDel = await app.request(
      `/v1/console/entries/${detailB.entry.shortId}?permanent=true`,
      {
        method: 'DELETE',
        headers: consoleHeaders(cookie),
      },
    )
    expect(permanentDel.status).toBe(204)

    const afterPermanent = await app.request(`/v1/console/entries/${detailB.entry.shortId}`, {
      headers: { cookie },
    })
    expect(afterPermanent.status).toBe(404)
  })

  it('按标题读取或修改时先在 SQL 层过滤 allowed_realms，避免较新的跨场域同名词条遮蔽可见词条', async () => {
    const masterKey = testMasterKey()
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const workEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '重名发布清单',
        content: '工作区发布步骤',
        realms: ['work'],
      }),
    )
    // 随后写入一条更新的 personal 同名词条
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '重名发布清单',
        content: '个人项目发布步骤',
        realms: ['personal'],
      }),
    )

    const workKey = await issueTestApiKey(database, { allowedRealms: ['work'], canWrite: true })
    const workScope = {
      kind: 'key' as const,
      keyId: workKey.id,
      name: 'Work Key',
      prefix: workKey.prefix,
      runtimeFamily: 'claudecode' as const,
      envs: [],
      allowedRealms: ['work'],
      canWrite: true,
      canResolveCredentials: false,
    }

    const fetched = await entrySvc.get(workScope, '重名发布清单')
    expect(fetched.entry.shortId).toBe(workEntry.entry.shortId)
    expect(fetched.entry.content).toBe('工作区发布步骤')
  })

  it('并发更新或删除遭遇版本号已递增时，原子 WHERE 拦截并返回 409 version_conflict', async () => {
    const masterKey = testMasterKey()
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const created = await entrySvc.create(
      consoleScope,
      entryInput({ title: '并发更新词条', content: '初始内容' }),
    )

    // 持行锁等待并发操作完成前置读取并阻塞在写语句，再推进版本并提交，确定性触发原子条件拦截
    const runWhileVersionBumped = async (op: () => Promise<unknown>) => {
      let pending!: Promise<unknown>
      await database.db.transaction(async (tx) => {
        await tx
          .select({ id: entries.id })
          .from(entries)
          .where(eq(entries.id, created.entry.id))
          .for('update')
        pending = op().catch((err: unknown) => err)
        const deadline = Date.now() + 3_000
        while (Date.now() < deadline) {
          const [waiter] = await tx.execute<{ n: number }>(sql`
            select count(*)::int as n
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where a.datname = current_database()
              and not l.granted
          `)
          if ((waiter?.n ?? 0) > 0) break
          await new Promise((r) => setTimeout(r, 10))
        }
        await tx
          .update(entries)
          .set({ version: sql`${entries.version} + 1` })
          .where(eq(entries.id, created.entry.id))
      })
      return pending
    }

    const updateErr = await runWhileVersionBumped(() =>
      entrySvc.update(consoleScope, created.entry.shortId, { content: '并发写入' }),
    )
    expect(updateErr).toMatchObject({ status: 409, code: 'version_conflict' })

    const deleteErr = await runWhileVersionBumped(() =>
      entrySvc.remove(consoleScope, created.entry.shortId),
    )
    expect(deleteErr).toMatchObject({ status: 409, code: 'version_conflict' })

    // 验证词条未被上述冲突的写入或删除改动
    const latest = await entrySvc.get(consoleScope, created.entry.shortId)
    expect(latest.entry.content).toBe('初始内容')
    expect(latest.entry.deletedAt).toBeNull()
    expect(latest.entry.version).toBe(3)

    // restore 带 expectedVersion 遇到版本不匹配直接返 409 version_conflict；并发推进版本同样由原子 WHERE 拦截
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const staleRestore = await app.request(`/v1/console/entries/${created.entry.shortId}/restore`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ version: 1, expectedVersion: 2 }),
    })
    expect(staleRestore.status).toBe(409)
    expect(await staleRestore.json()).toMatchObject({ code: 'version_conflict' })

    const concurrentRestoreErr = await runWhileVersionBumped(() =>
      entrySvc.restore(consoleScope, created.entry.shortId, { version: 1, expectedVersion: 3 }),
    )
    expect(concurrentRestoreErr).toMatchObject({ status: 409, code: 'version_conflict' })
  })

  it('列表支持 projectScope、tab=regular 组合搜索、disclosure 子串搜索且 facets.topics 按频次排序', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const generalAlpha = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '通用开发约定',
        content: '无项目归属的通用约定',
        disclosure: '核对全局发布口径时查阅',
        isPinned: true,
        projects: [],
        topics: ['deploy', 'postgres'],
      }),
    )
    const generalBeta = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '个人通用笔记',
        content: '另一条无项目归属的记忆',
        disclosure: '仅在按需排障指南中提及的触发线索',
        isPinned: false,
        projects: [],
        topics: ['deploy', 'beta'],
      }),
    )
    const projectAlpha = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Kioku 架构记录',
        content: '归属于具体项目的记忆',
        isPinned: false,
        projects: ['kioku'],
        topics: ['deploy', 'beta', 'postgres'],
      }),
    )
    const projectBeta = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '外围工具配置',
        content: '另一个项目的配置说明',
        isPinned: false,
        projects: ['toolbox'],
        topics: ['zeta'],
      }),
    )

    // 1. projectScope=unassigned 仅返回 projects 为空的记忆
    const unassignedRes = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?projectScope=unassigned', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(unassignedRes.items.map((i) => i.shortId).sort()).toEqual(
      [generalAlpha.entry.shortId, generalBeta.entry.shortId].sort(),
    )
    // topics 频次：deploy(3) > beta(2) = postgres(2)（同频字典序 beta 在前） > zeta(1)
    expect(unassignedRes.facets.topics).toEqual(['deploy', 'beta', 'postgres', 'zeta'])

    // 2. projectScope=assigned 仅返回至少归属一个项目的记忆
    const assignedRes = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?projectScope=assigned', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(assignedRes.items.map((i) => i.shortId).sort()).toEqual(
      [projectAlpha.entry.shortId, projectBeta.entry.shortId].sort(),
    )

    // 3. 搜索模式下遵守 projectScope、tab=regular 与 disclosure 子串匹配
    const searchedUnassigned = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?projectScope=unassigned&q=记忆', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(searchedUnassigned.items.every((i) => i.projects.length === 0)).toBe(true)

    const regularDisclosureSearch = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=regular&q=排障指南中提及', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(regularDisclosureSearch.items.map((i) => i.shortId)).toEqual([generalBeta.entry.shortId])

    // 常驻词条即便 disclosure 命中，在 tab=regular 下也不应出现
    const regularExcludesPinned = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=regular&q=全局发布口径', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(regularExcludesPinned.items).toEqual([])

    // 回收站同样支持按 disclosure 子串搜索
    const trashed = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '即将归档条目',
        content: '普通正文内容',
        disclosure: '回收站专属触发短语',
      }),
    )
    await entrySvc.remove(consoleScope, trashed.entry.shortId)
    const trashDisclosureSearch = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=trash&q=回收站专属触发短语', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(trashDisclosureSearch.items.map((i) => i.shortId)).toEqual([trashed.entry.shortId])
  })

  it('记录语义变更历史、语境双链、verifiedAt 核实语义并支持存量确定性预清洗与历史恢复', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const dbGuide = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '统一数据层指南',
        summary: '统一数据库部署在 127.0.0.1，禁止新建重复副本。',
        content: '数据库连接统一走内网实例。',
        topics: ['databases', 'postgres'],
      }),
    )

    const messy = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '主机分工与部署规范',
        content: [
          '# 主机分工与部署规范',
          '',
          '数据层详见 infra://docker_hosts/databases 以及 [[databases]]。',
          '',
          'Glossary keywords: docker, databases',
        ].join('\n'),
        isPinned: true,
        topics: ['docker'],
      }),
    )

    // 仅改主题标签不刷新 verifiedAt；修改正文并填 changeSummary 刷新 verifiedAt 与 lastChangeSummary
    const initialVerifiedAt = messy.entry.verifiedAt
    const tagOnly = await entrySvc.update(consoleScope, messy.entry.shortId, {
      topics: ['docker', 'ops'],
    })
    expect(tagOnly.entry.verifiedAt).toBe(initialVerifiedAt)

    const previewRes = await app.request('/v1/console/entries/hygiene/preview', {
      method: 'POST',
      headers: consoleHeaders(cookie),
    })
    expect(previewRes.status).toBe(200)
    const preview = HygieneSweepPreviewResponse.parse(await previewRes.json())
    const cand = preview.deterministicCandidates.find((c) => c.shortId === messy.entry.shortId)
    expect(cand).toBeTruthy()
    expect(cand?.fixes).toEqual(
      expect.arrayContaining([
        'strip_duplicate_heading',
        'strip_legacy_glossary',
        'rewrite_legacy_links',
      ]),
    )

    const applyRes = await app.request('/v1/console/entries/hygiene/apply', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ shortIds: [messy.entry.shortId] }),
    })
    expect(applyRes.status).toBe(200)
    const applied = HygieneSweepApplyResponse.parse(await applyRes.json())
    expect(applied.applied).toBe(1)

    const cleanedDetail = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${messy.entry.shortId}`, { headers: { cookie } })
      ).json(),
    )
    expect(cleanedDetail.entry.content).not.toContain('# 主机分工与部署规范')
    expect(cleanedDetail.entry.content).not.toContain('Glossary keywords:')
    expect(cleanedDetail.entry.content).toContain(`[[${dbGuide.entry.shortId}|统一数据层指南]]`)
    expect(cleanedDetail.outboundLinks[0]?.shortId).toBe(dbGuide.entry.shortId)
    expect(cleanedDetail.outboundLinks[0]?.relation).toBe('统一数据层指南')
    expect(cleanedDetail.recentHistory?.length).toBeGreaterThanOrEqual(2)
    expect(cleanedDetail.recentHistory?.[0]?.actorMeta?.label).toBe('结构预清洗')
    // 结构预清洗不伪造新的核实时间
    expect(cleanedDetail.entry.verifiedAt).toBe(initialVerifiedAt)

    // 悬空断链扫描：目标已软删除（deleted）与目标不存在（missing）均应在 brokenLinks 中报告
    const tempTarget = await entrySvc.create(
      consoleScope,
      entryInput({ title: '临时引用目标', content: '即将删除。' }),
    )
    const missingId = 'm-zzzz99'
    const linker = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '包含断链的词条',
        content: `引用已删 [[${tempTarget.entry.shortId}]] 以及不存在 [[${missingId}]]。`,
      }),
    )
    await entrySvc.remove(consoleScope, tempTarget.entry.shortId)

    const brokenPreview = HygieneSweepPreviewResponse.parse(
      await (
        await app.request('/v1/console/entries/hygiene/preview', {
          method: 'POST',
          headers: consoleHeaders(cookie),
        })
      ).json(),
    )
    const brokenItem = brokenPreview.brokenLinks?.find((b) => b.shortId === linker.entry.shortId)
    expect(brokenItem).toBeTruthy()
    expect(brokenItem?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetShortId: tempTarget.entry.shortId,
          status: 'deleted',
          targetTitle: '临时引用目标',
        }),
        expect.objectContaining({
          targetShortId: missingId,
          status: 'missing',
          targetTitle: null,
        }),
      ]),
    )
  })

  it('控制台支持三态 bootMode、facets.runtimes、分层常驻计数与只读终端启动加载预览', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const globalShort = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '全局简洁铁律',
        content: '回答简洁直接。',
        bootMode: 'full',
      }),
    )
    const scopedRuntime = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'ZCode 专属约束',
        content: '仅限自定义客户端。',
        bootMode: 'full',
        runtimes: ['zcode'],
      }),
    )
    const indexDoc = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '运维参考手册',
        summary: '汇总端口与编排规则。',
        content: '详细参考内容。'.repeat(120),
        bootMode: 'index',
      }),
    )
    const personalRule = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '个人生活清单',
        content: '仅个人场域可见。',
        bootMode: 'full',
        realms: ['personal'],
      }),
    )

    // 列表返回 facets.runtimes 与真实分层常驻指标
    const listRes = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=pinned', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(listRes.facets.runtimes).toEqual(['zcode'])
    expect(listRes.counts).toMatchObject({
      pinned: 4,
      globalFullPinnedCount: 1,
      scopedFullPinnedCount: 2,
      indexPinnedCount: 1,
    })
    expect(listRes.counts.globalFullPinnedChars).toBe(
      globalShort.entry.title.length + globalShort.entry.content.length,
    )

    // 仅传 runtime=zcode 筛选精确命中自定义客户端词条
    const runtimeFiltered = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?runtime=zcode', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(runtimeFiltered.items.map((i) => i.shortId)).toEqual([scopedRuntime.entry.shortId])

    // 创建只允许 work 场域的 claudecode 密钥，验证只读预览接口返回展开/目录/排除明细
    const workKey = await issueTestApiKey(database, {
      name: 'Work Claude',
      runtimeFamily: 'claudecode',
      envs: ['mac'],
      allowedRealms: ['work'],
    })

    const previewRes = await app.request('/v1/console/boot/preview', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ keyId: workKey.id, project: 'kioku' }),
    })
    expect(previewRes.status).toBe(200)
    const preview = BootPreviewResponse.parse(await previewRes.json())
    expect(preview.keyName).toBe('Work Claude')
    expect(preview.hostLimit).toBe(9_500)
    expect(preview.expanded.map((e) => e.shortId)).toEqual([globalShort.entry.shortId])
    expect(preview.indexed.map((e) => e.shortId)).toEqual([indexDoc.entry.shortId])
    expect(preview.excluded.find((e) => e.shortId === scopedRuntime.entry.shortId)?.reason).toBe(
      'scene_conflict',
    )
    expect(preview.excluded.find((e) => e.shortId === personalRule.entry.shortId)?.reason).toBe(
      'realm_forbidden',
    )
  })

  it('常驻列表支持按 pinnedGroup 分组筛选并兼容关键词组合搜索', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const marker = '常驻分组哨兵'
    const globalFull = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '全局全文规范',
        content: `${marker}：所有场景均全文展开。`,
        bootMode: 'full',
      }),
    )
    const scopedProject = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '项目专属常驻',
        content: `${marker}：仅项目生效。`,
        bootMode: 'full',
        projects: ['kioku'],
      }),
    )
    const scopedEnv = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '环境专属常驻',
        content: `${marker}：仅 mac 生效。`,
        bootMode: 'full',
        envs: ['mac'],
      }),
    )
    const scopedRealm = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '场域专属常驻',
        content: `${marker}：仅工作场域生效。`,
        bootMode: 'full',
        realms: ['work'],
      }),
    )
    const scopedRuntime = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '客户端专属常驻',
        content: `${marker}：仅 claudecode 生效。`,
        bootMode: 'full',
        runtimes: ['claudecode'],
      }),
    )
    const indexGlobal = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '目录常驻通用',
        content: `${marker}：仅目录索引。`,
        bootMode: 'index',
      }),
    )
    const indexScoped = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '目录常驻项目',
        content: `${marker}：按项目索引。`,
        bootMode: 'index',
        projects: ['kioku'],
      }),
    )
    const regularEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '普通按需词条',
        content: `${marker}：不常驻。`,
        bootMode: 'none',
      }),
    )

    const scopedExpected = [
      scopedProject.entry.shortId,
      scopedEnv.entry.shortId,
      scopedRealm.entry.shortId,
      scopedRuntime.entry.shortId,
    ].sort()
    const indexExpected = [indexGlobal.entry.shortId, indexScoped.entry.shortId].sort()

    // 普通分页路径校验三种 pinnedGroup 分组
    const globalList = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=pinned&pinnedGroup=global_full', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(globalList.items.map((i) => i.shortId)).toEqual([globalFull.entry.shortId])
    expect(globalList.counts).toMatchObject({
      pinned: 7,
      globalFullPinnedCount: 1,
      scopedFullPinnedCount: 4,
      indexPinnedCount: 2,
    })

    const scopedList = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=pinned&pinnedGroup=scoped_full', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(scopedList.items.map((i) => i.shortId).sort()).toEqual(scopedExpected)

    const indexList = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=pinned&pinnedGroup=index', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(indexList.items.map((i) => i.shortId).sort()).toEqual(indexExpected)

    // 关键词搜索路径同样遵守 pinnedGroup 分组条件
    const encodedQ = encodeURIComponent(marker)
    const globalSearch = EntryListResponse.parse(
      await (
        await app.request(`/v1/console/entries?tab=pinned&pinnedGroup=global_full&q=${encodedQ}`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(globalSearch.items.map((i) => i.shortId)).toEqual([globalFull.entry.shortId])

    const scopedSearch = EntryListResponse.parse(
      await (
        await app.request(`/v1/console/entries?tab=pinned&pinnedGroup=scoped_full&q=${encodedQ}`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(scopedSearch.items.map((i) => i.shortId).sort()).toEqual(scopedExpected)

    const indexSearch = EntryListResponse.parse(
      await (
        await app.request(`/v1/console/entries?tab=pinned&pinnedGroup=index&q=${encodedQ}`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(indexSearch.items.map((i) => i.shortId).sort()).toEqual(indexExpected)

    // 非 pinned 标签页忽略 pinnedGroup，避免误过滤普通记忆
    const nonPinnedTab = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=all&pinnedGroup=index', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(nonPinnedTab.items.map((i) => i.shortId)).toContain(regularEntry.entry.shortId)
    expect(nonPinnedTab.items.map((i) => i.shortId)).toContain(globalFull.entry.shortId)
  })

  it('列表、详情与历史接口批量解析双链标题并过滤已删除目标，无引用时省略 linkedTitles', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const aliveTarget = await entrySvc.create(
      consoleScope,
      entryInput({ title: '活跃双链目标', content: '目标正文。' }),
    )
    const summaryTarget = await entrySvc.create(
      consoleScope,
      entryInput({ title: '概要关联目标', content: '概要引用目标正文。' }),
    )
    const olderHistoryTarget = await entrySvc.create(
      consoleScope,
      entryInput({ title: '早期历史引用目标', content: '早期历史引用的目标正文。' }),
    )
    const deletedTarget = await entrySvc.create(
      consoleScope,
      entryInput({ title: '已删目标标题', content: '即将被软删除。' }),
    )

    const source = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '双链来源词条',
        summary: `现行概要引用 [[${summaryTarget.entry.shortId}]]`,
        content: '初始正文内容。',
        changeSummary: `初版关联 [[${olderHistoryTarget.entry.shortId}]]`,
      }),
    )

    const searchToken = '双链标题解析哨兵'
    await entrySvc.update(consoleScope, source.entry.shortId, {
      content: `${searchToken}：正文已同步更新。`,
      changeSummary: `补全双链：[[${aliveTarget.entry.shortId}]]、[[${deletedTarget.entry.shortId}]]`,
    })
    await entrySvc.remove(consoleScope, deletedTarget.entry.shortId)

    const plain = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '无双链词条',
        summary: '普通概要，不含双链',
        content: '普通正文内容。',
        changeSummary: '普通变更说明',
      }),
    )

    // 普通分页列表路径
    const pagedList = EntryListResponse.parse(
      await (
        await app.request('/v1/console/entries?tab=all', {
          headers: { cookie },
        })
      ).json(),
    )
    expect(pagedList.linkedTitles).toEqual({
      [aliveTarget.entry.shortId]: '活跃双链目标',
      [summaryTarget.entry.shortId]: '概要关联目标',
    })
    expect(pagedList.linkedTitles?.[deletedTarget.entry.shortId]).toBeUndefined()

    // 关键词搜索列表路径
    const searchedList = EntryListResponse.parse(
      await (
        await app.request(`/v1/console/entries?tab=all&q=${encodeURIComponent(searchToken)}`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(searchedList.items.map((i) => i.shortId)).toContain(source.entry.shortId)
    expect(searchedList.linkedTitles).toEqual({
      [aliveTarget.entry.shortId]: '活跃双链目标',
      [summaryTarget.entry.shortId]: '概要关联目标',
    })
    expect(searchedList.linkedTitles?.[deletedTarget.entry.shortId]).toBeUndefined()

    // 词条详情接口：汇总 lastChangeSummary、summary 与 recentHistory 中的双链
    const detail = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${source.entry.shortId}`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(detail.linkedTitles).toEqual({
      [aliveTarget.entry.shortId]: '活跃双链目标',
      [summaryTarget.entry.shortId]: '概要关联目标',
      [olderHistoryTarget.entry.shortId]: '早期历史引用目标',
    })
    expect(detail.linkedTitles?.[deletedTarget.entry.shortId]).toBeUndefined()

    // 历史接口：汇总变更说明中的双链
    const history = EntryHistoryResponse.parse(
      await (
        await app.request(`/v1/console/entries/${source.entry.shortId}/history`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(history.linkedTitles).toEqual({
      [aliveTarget.entry.shortId]: '活跃双链目标',
      [olderHistoryTarget.entry.shortId]: '早期历史引用目标',
    })
    expect(history.linkedTitles?.[deletedTarget.entry.shortId]).toBeUndefined()

    // 无双链目标时响应中不写入 linkedTitles 键
    const plainDetailRaw = (await (
      await app.request(`/v1/console/entries/${plain.entry.shortId}`, {
        headers: { cookie },
      })
    ).json()) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(plainDetailRaw, 'linkedTitles')).toBe(false)

    const plainHistoryRaw = (await (
      await app.request(`/v1/console/entries/${plain.entry.shortId}/history`, {
        headers: { cookie },
      })
    ).json()) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(plainHistoryRaw, 'linkedTitles')).toBe(false)
  })

  it('场域受限的 API Key 调用详情与历史接口时 linkedTitles 不泄露越权场域词条标题', async () => {
    const masterKey = testMasterKey()
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const workTarget = await entrySvc.create(
      consoleScope,
      entryInput({ title: '工作区可见目标', content: '工作场域正文。', realms: ['work'] }),
    )
    const universalTarget = await entrySvc.create(
      consoleScope,
      entryInput({ title: '无场域通用目标', content: '通用正文。', realms: [] }),
    )
    const personalTarget = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '私有个人场域机密标题',
        content: '个人场域正文。',
        realms: ['personal'],
      }),
    )

    const workEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '工作区词条',
        summary: `参考 [[${universalTarget.entry.shortId}]] 与 [[${personalTarget.entry.shortId}]]`,
        content: '工作正文。',
        realms: ['work'],
        changeSummary: `补全双链：[[${workTarget.entry.shortId}]]、[[${personalTarget.entry.shortId}]]`,
      }),
    )
    const onlyForbiddenRefEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '仅引用越权目标的工作词条',
        content: '工作正文。',
        realms: ['work'],
        changeSummary: `补全双链：[[${personalTarget.entry.shortId}]]`,
      }),
    )

    const workKey = await issueTestApiKey(database, { allowedRealms: ['work'] })
    const workScope = {
      kind: 'key' as const,
      keyId: workKey.id,
      name: 'Work Restricted Key',
      prefix: workKey.prefix,
      runtimeFamily: 'claudecode' as const,
      envs: [],
      allowedRealms: ['work'],
      canWrite: false,
      canResolveCredentials: false,
    }

    const keyDetail = await entrySvc.get(workScope, workEntry.entry.shortId)
    expect(keyDetail.linkedTitles).toEqual({
      [workTarget.entry.shortId]: '工作区可见目标',
      [universalTarget.entry.shortId]: '无场域通用目标',
    })
    expect(keyDetail.linkedTitles?.[personalTarget.entry.shortId]).toBeUndefined()
    expect(JSON.stringify(keyDetail)).not.toContain('私有个人场域机密标题')

    const keyHistory = await entrySvc.history(workScope, workEntry.entry.shortId)
    expect(keyHistory.linkedTitles).toEqual({
      [workTarget.entry.shortId]: '工作区可见目标',
    })
    expect(keyHistory.linkedTitles?.[personalTarget.entry.shortId]).toBeUndefined()
    expect(JSON.stringify(keyHistory)).not.toContain('私有个人场域机密标题')

    // 当全部引用目标均越权时，省略 linkedTitles 键
    const forbiddenOnlyDetail = await entrySvc.get(workScope, onlyForbiddenRefEntry.entry.shortId)
    expect(Object.prototype.hasOwnProperty.call(forbiddenOnlyDetail, 'linkedTitles')).toBe(false)

    const forbiddenOnlyHistory = await entrySvc.history(
      workScope,
      onlyForbiddenRefEntry.entry.shortId,
    )
    expect(Object.prototype.hasOwnProperty.call(forbiddenOnlyHistory, 'linkedTitles')).toBe(false)

    // 控制台会话可正常解析全部场域目标
    const consoleDetail = await entrySvc.get(consoleScope, workEntry.entry.shortId)
    expect(consoleDetail.linkedTitles?.[personalTarget.entry.shortId]).toBe('私有个人场域机密标题')
  })
})

describe.skipIf(!testDatabaseUrl)('随手记局部补丁归并（POST /v1/console/entries/capture）', () => {
  let database: Database
  let fakeAi: FakeOpenAiServer

  beforeAll(async () => {
    database = await openTestDatabase()
    fakeAi = await startFakeOpenAi()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    fakeAi.requests.length = 0
  })

  afterAll(async () => {
    await fakeAi.close()
    await database.close()
  })

  it('覆盖 insert_under_heading、replace 与版本恢复、noop、create、targetShortId 及 mode=append', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-capture-test',
      enabled: true,
    })

    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const linkedRef = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '参考部署清单',
        content: '基础部署步骤说明。',
        projects: ['kioku'],
      }),
    )

    const tailMarker = '文末唯一校验标记-严禁截断'
    const longContent = [
      '## 提交规范',
      '- 使用中文提交说明',
      '',
      '## 调试方式',
      `- 排查界面时结合 [[${linkedRef.entry.shortId}]] 与 {{cred:dev-token}}`,
      '',
      '## 详述备忘',
      '这是一段超长常驻规范背景，用于确保随手记规划时完整传给对话模型。'.repeat(120),
      `- ${tailMarker}`,
    ].join('\n')
    expect(longContent.length).toBeGreaterThan(3_500)

    const coreBlock = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '日常协作与开发习惯',
        content: longContent,
        disclosure: '写代码、提 PR 与调试时遵守',
        isPinned: true,
        projects: [],
        topics: ['workflow'],
      }),
    )

    const secondaryBlock = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '本地环境端口记录',
        content: '## 服务端口\n- 后端默认端口 18920\n- 前端开发端口 5173',
        projects: ['kioku'],
        topics: ['dev'],
      }),
    )

    const episode = await entrySvc.writeEpisode({
      title: '临时排查摘要',
      content: '排查了一次偶发超时。',
      deviceKey: 'dev-box',
      projectSlug: 'kioku',
    })

    const deletedEntry = await entrySvc.create(
      consoleScope,
      entryInput({ title: '已删除旧文档', content: '不应被指定为归并目标' }),
    )
    await entrySvc.remove(consoleScope, deletedEntry.entry.shortId)

    // 1. insert_under_heading：验证超长正文未截断传入模型，并精准插入目标小节
    let capturedPrompt = ''
    fakeAi.setChatHandler((messages) => {
      capturedPrompt = messages.map((m) => m.content).join('\n')
      return JSON.stringify({
        action: 'update',
        targetShortId: coreBlock.entry.shortId,
        patch: {
          kind: 'insert_under_heading',
          heading: '提交规范',
          text: '- 评审对比优先使用表格呈现',
        },
        reason: '属于提交与评审规范，归入对应小节',
      })
    })

    const insertRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ text: '评审对比优先使用表格呈现' }),
    })
    expect(insertRes.status).toBe(200)
    const insertPlan = CapturePlanResponse.parse(await insertRes.json())
    expect(capturedPrompt).toContain(tailMarker)
    expect(insertPlan.mode).toBe('llm')
    expect(insertPlan.fallbackReason).toBeNull()
    expect(insertPlan.action).toBe('update')
    expect(insertPlan.patchKind).toBe('insert_under_heading')
    expect(insertPlan.patchHeading).toBe('提交规范')
    expect(insertPlan.targetShortId).toBe(coreBlock.entry.shortId)
    expect(insertPlan.targetVersion).toBe(1)
    expect(insertPlan.integrity?.intact).toBe(true)
    expect(insertPlan.integrity?.linksBefore).toBe(1)
    expect(insertPlan.integrity?.credsBefore).toBe(1)
    expect(insertPlan.proposedContent).toContain('- 评审对比优先使用表格呈现')
    expect(insertPlan.proposedContent).toContain(tailMarker)
    expect(insertPlan.proposedContent!.indexOf('评审对比优先使用表格呈现')).toBeLessThan(
      insertPlan.proposedContent!.indexOf('## 调试方式'),
    )
    // 召回不足 5 条时补充了常驻通用核心块，且项目专属常驻不会混入通用补充
    expect(insertPlan.candidates.some((c) => c.shortId === coreBlock.entry.shortId)).toBe(true)

    // 2. replace + PATCH 落盘 + 按版本一键回滚
    fakeAi.setChatHandler(() =>
      JSON.stringify({
        action: 'update',
        targetShortId: coreBlock.entry.shortId,
        patch: {
          kind: 'replace',
          oldText: '- 使用中文提交说明',
          text: '- 使用中文并附清晰类型前缀的提交说明',
        },
        reason: '细化提交说明要求',
      }),
    )

    const replaceRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ text: '提交说明改为中文并附类型前缀' }),
    })
    expect(replaceRes.status).toBe(200)
    const replacePlan = CapturePlanResponse.parse(await replaceRes.json())
    expect(replacePlan.patchKind).toBe('replace')
    expect(replacePlan.integrity?.intact).toBe(true)
    expect(replacePlan.proposedContent).toContain('- 使用中文并附清晰类型前缀的提交说明')
    expect(replacePlan.proposedContent).not.toContain('- 使用中文提交说明')

    const appliedPatch = await app.request(`/v1/console/entries/${replacePlan.targetShortId}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        expectedVersion: replacePlan.targetVersion,
        content: replacePlan.proposedContent,
      }),
    })
    expect(appliedPatch.status).toBe(200)
    const updatedDetail = EntryDetailResponse.parse(await appliedPatch.json())
    expect(updatedDetail.entry.version).toBe(2)

    const rollbackRes = await app.request(
      `/v1/console/entries/${replacePlan.targetShortId}/restore`,
      {
        method: 'POST',
        headers: consoleHeaders(cookie, true),
        body: JSON.stringify({ version: replacePlan.targetVersion }),
      },
    )
    expect(rollbackRes.status).toBe(200)
    const rolledBack = EntryDetailResponse.parse(await rollbackRes.json())
    expect(rolledBack.entry.version).toBe(3)
    expect(rolledBack.entry.content).toContain('- 使用中文提交说明')

    // 3. noop
    fakeAi.setChatHandler(() =>
      JSON.stringify({
        action: 'noop',
        targetShortId: coreBlock.entry.shortId,
        reason: '提交规范已包含该约定，无需重复写入',
      }),
    )
    const noopRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ text: '提交说明保持中文' }),
    })
    expect(noopRes.status).toBe(200)
    const noopPlan = CapturePlanResponse.parse(await noopRes.json())
    expect(noopPlan.action).toBe('noop')
    expect(noopPlan.patchKind).toBe('noop')
    expect(noopPlan.targetShortId).toBe(coreBlock.entry.shortId)
    expect(noopPlan.proposedContent).toBeNull()
    expect(noopPlan.beforeContent).toContain('- 使用中文提交说明')

    // 4. create
    fakeAi.setChatHandler(() =>
      JSON.stringify({
        action: 'create',
        targetShortId: null,
        reason: '与开发规范和端口清单均无关，建议独立建档',
        newEntry: {
          title: '咖啡风味记录',
          disclosure: '选购豆子时参考',
          topics: ['coffee', 'Life'],
          content: '偏好埃塞俄比亚水洗浅烘豆。',
        },
      }),
    )
    const createRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ text: '偏好埃塞俄比亚水洗浅烘豆' }),
    })
    expect(createRes.status).toBe(200)
    const createPlan = CapturePlanResponse.parse(await createRes.json())
    expect(createPlan.action).toBe('create')
    expect(createPlan.patchKind).toBe('create')
    expect(createPlan.targetShortId).toBeNull()
    expect(createPlan.proposedNew.title).toBe('咖啡风味记录')
    expect(createPlan.proposedNew.topics).toEqual(['coffee', 'life'])

    // 5. 指定 targetShortId 置顶并透传给模型；软删、会话摘要或不存在的短 ID 返回 404
    let targetedPrompt = ''
    fakeAi.setChatHandler((messages) => {
      targetedPrompt = messages.map((m) => m.content).join('\n')
      return JSON.stringify({
        action: 'update',
        targetShortId: secondaryBlock.entry.shortId,
        patch: {
          kind: 'insert_under_heading',
          heading: '服务端口',
          text: '- 测试数据库端口 55432',
        },
        reason: '按指定目标归入服务端口小节',
      })
    })
    const targetedRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        text: '测试数据库端口 55432',
        targetShortId: secondaryBlock.entry.shortId,
      }),
    })
    expect(targetedRes.status).toBe(200)
    const targetedPlan = CapturePlanResponse.parse(await targetedRes.json())
    expect(targetedPlan.candidates[0]?.shortId).toBe(secondaryBlock.entry.shortId)
    expect(targetedPlan.targetShortId).toBe(secondaryBlock.entry.shortId)
    expect(targetedPrompt).toContain(`用户指定目标`)
    expect(targetedPrompt).toContain(`[${secondaryBlock.entry.shortId}]`)

    for (const invalidTarget of [deletedEntry.entry.shortId, episode.shortId, 'm-234567']) {
      const badTargetRes = await app.request('/v1/console/entries/capture', {
        method: 'POST',
        headers: consoleHeaders(cookie, true),
        body: JSON.stringify({ text: '任意文本', targetShortId: invalidTarget }),
      })
      expect(badTargetRes.status).toBe(404)
    }

    // 6. mode='append' 绕过对话模型，fallbackReason 必须为 null
    const reqCountBeforeAppend = fakeAi.requests.length
    const appendRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        text: '测试端口优先检查占用',
        targetShortId: secondaryBlock.entry.shortId,
        mode: 'append',
        heading: '服务端口',
      }),
    })
    expect(appendRes.status).toBe(200)
    expect(fakeAi.requests.length).toBe(reqCountBeforeAppend)
    const appendPlan = CapturePlanResponse.parse(await appendRes.json())
    expect(appendPlan.mode).toBe('manual')
    expect(appendPlan.fallbackReason).toBeNull()
    expect(appendPlan.action).toBe('update')
    expect(appendPlan.patchKind).toBe('insert_under_heading')
    expect(appendPlan.patchHeading).toBe('服务端口')
    expect(appendPlan.proposedContent).toContain('- 测试端口优先检查占用')
  })

  it('无对话模型、模型返回非法 JSON 与模型服务报错时均安全降级且不泄露内部信息', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    // 1. 空库且未配置对话模型 -> 降级为新建草案
    const emptyRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ text: '第一条随手记录' }),
    })
    expect(emptyRes.status).toBe(200)
    const emptyPlan = CapturePlanResponse.parse(await emptyRes.json())
    expect(emptyPlan.mode).toBe('manual')
    expect(emptyPlan.fallbackReason).toBeTruthy()
    expect(emptyPlan.action).toBe('create')
    expect(emptyPlan.patchKind).toBe('create')
    expect(emptyPlan.candidates).toEqual([])

    // 写入一条通用常驻记忆与一条项目专属常驻记忆：无召回命中时仅补充通用常驻（低基线分 0.05）
    const pinned = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '个人偏好备忘',
        content: '## 常用工具\n- 编辑器偏好 Neovim',
        isPinned: true,
        projects: [],
      }),
    )
    const projectPinned = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '单项目常驻规范',
        content: '## 发布步骤\n- 仅限单一项目',
        isPinned: true,
        projects: ['kioku'],
      }),
    )

    const noModelRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ text: '周末骑行路线记录' }),
    })
    expect(noModelRes.status).toBe(200)
    const noModelPlan = CapturePlanResponse.parse(await noModelRes.json())
    expect(noModelPlan.mode).toBe('manual')
    expect(noModelPlan.fallbackReason).toContain('未配置对话模型')
    expect(noModelPlan.action).toBe('update')
    expect(noModelPlan.targetShortId).toBe(pinned.entry.shortId)
    expect(noModelPlan.candidates.map((c) => c.shortId)).toEqual([pinned.entry.shortId])
    expect(noModelPlan.candidates.some((c) => c.shortId === projectPinned.entry.shortId)).toBe(
      false,
    )
    expect(noModelPlan.candidates[0]?.score).toBe(0.05)
    expect(noModelPlan.proposedContent).toContain('- 周末骑行路线记录')
    expect(noModelPlan.integrity?.intact).toBe(true)

    // 2. 对话模型返回无法解析的非 JSON 文本 -> 降级为 manual
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-test',
      enabled: true,
    })
    fakeAi.setChatHandler(() => '抱歉，无法按格式输出 {{{')

    const badJsonRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ text: '终端配色采用浅色纸墨' }),
    })
    expect(badJsonRes.status).toBe(200)
    const badJsonPlan = CapturePlanResponse.parse(await badJsonRes.json())
    expect(badJsonPlan.mode).toBe('manual')
    expect(badJsonPlan.fallbackReason).toBeTruthy()
    expect(badJsonPlan.action).toBe('update')
    expect(badJsonPlan.proposedContent).toContain('- 终端配色采用浅色纸墨')

    // 3. 对话模型上游 HTTP 500 报错 -> 降级为 manual 且不泄露上游内部地址或错误堆栈
    const brokenServer = createServer((_, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('upstream error at http://internal.llm.example.com:9090/secret-stack')
    })
    await new Promise<void>((resolve) => brokenServer.listen(0, '127.0.0.1', () => resolve()))
    const { port } = brokenServer.address() as AddressInfo

    try {
      await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'broken-chat',
        apiKey: 'sk-broken',
        enabled: true,
      })

      const errRes = await app.request('/v1/console/entries/capture', {
        method: 'POST',
        headers: consoleHeaders(cookie, true),
        body: JSON.stringify({ text: '字体保持系统默认栈' }),
      })
      expect(errRes.status).toBe(200)
      const errPlan = CapturePlanResponse.parse(await errRes.json())
      expect(errPlan.mode).toBe('manual')
      expect(errPlan.fallbackReason).toBeTruthy()
      expect(errPlan.fallbackReason).not.toContain('internal.llm')
      expect(errPlan.fallbackReason).not.toContain('9090')
      expect(errPlan.fallbackReason).not.toContain('secret-stack')
      expect(errPlan.fallbackReason).not.toContain('500')
      expect(errPlan.proposedContent).toContain('- 字体保持系统默认栈')
    } finally {
      await new Promise<void>((resolve, reject) =>
        brokenServer.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })

  it('过期 targetShortId 返 404、BM25 下预留通用常驻保底名额，且客户端取消请求静默中止不打 warn/500', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    // 1. 显式 targetShortId 指向已过期正式词条应返回 404
    const expiring = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '短期活动备忘',
        content: '已过期内容',
        validTo: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    )
    await database.db
      .update(entries)
      .set({ validTo: sql`now() - interval '1 hour'` })
      .where(eq(entries.id, expiring.entry.id))

    const expiredRes = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ text: '补充活动细节', targetShortId: expiring.entry.shortId }),
    })
    expect(expiredRes.status).toBe(404)

    // 2. 仅 BM25 场景：5 条普通词条弱命中关键词，仍为 2 条未命中的通用常驻核心块预留保底名额（总计 6 条）
    const ordinaryIds: string[] = []
    for (let idx = 0; idx < 5; idx++) {
      const item = await entrySvc.create(
        consoleScope,
        entryInput({
          title: `流水线记录甲${idx}`,
          content: `关于部署流水线与构建缓存的第 ${idx} 条细节。\r\n第二行测试 CRLF。`,
          isPinned: false,
          projects: ['kioku'],
        }),
      )
      ordinaryIds.push(item.entry.shortId)
    }
    const coreOne = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '通用常驻规范甲',
        content: '## 协作习惯\r\n- 保持极简纸墨风格',
        isPinned: true,
        projects: [],
      }),
    )
    const coreTwo = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '通用常驻规范乙',
        content: '## 个人偏好\n- 终端统一使用深色字体',
        isPinned: true,
        projects: [],
      }),
    )

    const bm25Res = await app.request('/v1/console/entries/capture', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ text: '部署流水线构建缓存优化', mode: 'append' }),
    })
    expect(bm25Res.status).toBe(200)
    const bm25Plan = CapturePlanResponse.parse(await bm25Res.json())
    expect(bm25Plan.candidates).toHaveLength(6)
    // 前 4 条来自 BM25 召回，后 2 条为保底通用常驻核心块（低基线 0.05），且正文 CRLF 均已归一化
    expect(bm25Plan.candidates.slice(0, 4).every((c) => ordinaryIds.includes(c.shortId))).toBe(true)
    expect(
      bm25Plan.candidates
        .slice(4)
        .map((c) => c.shortId)
        .sort(),
    ).toEqual([coreOne.entry.shortId, coreTwo.entry.shortId].sort())
    expect(bm25Plan.candidates.slice(4).every((c) => c.score === 0.05)).toBe(true)
    expect(bm25Plan.beforeContent).not.toContain('\r\n')
    expect(bm25Plan.candidates.every((c) => !c.content.includes('\r\n'))).toBe(true)

    // 3. 客户端主动 AbortController 取消请求：静默中止（不打 warn / error，不返 500）
    let onUpstreamHit!: () => void
    const upstreamHit = new Promise<void>((resolve) => {
      onUpstreamHit = resolve
    })
    const openSockets = new Set<import('node:http').ServerResponse>()
    const slowServer = createServer((_, res) => {
      openSockets.add(res)
      res.on('close', () => openSockets.delete(res))
      onUpstreamHit()
    })
    await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()))
    const { port } = slowServer.address() as AddressInfo

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'slow-chat',
        apiKey: 'sk-slow',
        enabled: true,
      })

      const ac = new AbortController()
      const pendingReq = app.request('/v1/console/entries/capture', {
        method: 'POST',
        headers: consoleHeaders(cookie, true),
        body: JSON.stringify({ text: '验证取消请求时静默收尾' }),
        signal: ac.signal,
      })

      await upstreamHit
      ac.abort()

      const abortedRes = await pendingReq
      expect(abortedRes.status).toBe(499)
      expect(warnSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
      for (const res of openSockets) res.destroy()
      await new Promise<void>((resolve, reject) =>
        slowServer.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })

  it('OpenAPI 文档可正常生成并包含结构预清洗与历史查询路由', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const res = await app.request('/v1/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { paths?: Record<string, unknown> }
    expect(doc.paths?.['/v1/console/entries/hygiene/preview']).toBeDefined()
    expect(doc.paths?.['/v1/console/entries/hygiene/apply']).toBeDefined()
    expect(doc.paths?.['/v1/console/entries/{shortId}/history']).toBeDefined()
  })
})
