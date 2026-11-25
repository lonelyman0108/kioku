import { EntryDetailResponse, EntryHistoryResponse, EntryListResponse } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { entries } from '../../db/schema'
import { EntryService } from '../../memory/service'
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
    expect(listAll.counts).toEqual({ all: 2, pinned: 1, episodes: 1, trash: 0 })
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
  })
})
