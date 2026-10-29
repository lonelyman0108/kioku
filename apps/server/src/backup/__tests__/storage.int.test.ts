import { randomBytes } from 'node:crypto'

import type { BackupObjectList, BackupSettingsView, BackupTestResult } from '@kioku/contracts'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { checkMasterKey, rotateMasterKey } from '../../crypto/rotation'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Jobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { startFakeS3Server, type FakeS3Server } from '../../testing/fakeS3Server'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { readBackup } from '../restore'
import { loadBackupConfig, loadBackupStatus } from '../settings'
import { backupJob, fetchBackup } from '../storage'

describe.skipIf(!testDatabaseUrl)('备份到对象存储', () => {
  let database: Database
  let s3: FakeS3Server
  let ws: Workspace
  let api: ReturnType<typeof createApp>
  let original: (typeof settings.$inferSelect)[] = []
  const masterKey = randomBytes(32)
  const accessKeyId = 'kioku-backup'
  const queued: string[] = []
  const jobs: Jobs = {
    enqueueEmbed() {},
    enqueueExtraction: async () => {},
    enqueueBackfill: async () => true,
    enqueueSwitch: async () => true,
    enqueuePrune: async () => true,
    enqueueBackup: async () => (queued.push('backup'), true),
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    original = await database.db.select().from(settings)
    s3 = await startFakeS3Server(accessKeyId)
    api = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs,
    })
  })
  afterAll(async () => {
    await s3?.close()
    if (!database) return
    await database.db.delete(settings)
    if (original.length) await database.db.insert(settings).values(original)
    await database.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    // 别的用例留下的、用别的主密钥加密的设置会让主密钥的核对与轮换多出几条
    await database.db.delete(settings)
    s3.objects.clear()
    s3.requests.length = 0
    s3.pageSize = 1000
    s3.fail(undefined)
    for (const method of ['PUT', 'GET', 'DELETE']) s3.fail(undefined, method)
    queued.length = 0
    ws = await bootstrap(api)
  })

  const send = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    api.request(
      `/v1/settings/backup${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const settingsInput = (extra: Record<string, unknown> = {}) => ({
    endpoint: s3.endpoint,
    bucket: 'kioku-test',
    prefix: 'kioku',
    accessKeyId,
    secretAccessKey: 'backup-secret',
    hour: 3,
    keep: 2,
    ...extra,
  })
  const save = async (extra: Record<string, unknown> = {}) => {
    const res = await send('PUT', '', settingsInput(extra))
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as BackupSettingsView
  }
  const keys = () => [...s3.objects.keys()].sort()

  it('保存设置：Secret 加密保存、不返回；同一个接口主机可以沿用，换了主机要重填；只有实例管理员能改', async () => {
    const first = await send('PUT', '', settingsInput({ secretAccessKey: undefined }))
    expect(first.status).toBe(400)
    expect(await first.text()).toContain('请填写 Secret Access Key')

    const view = await save()
    expect(view).toMatchObject({
      configured: true,
      endpoint: s3.endpoint,
      region: 'us-east-1',
      bucket: 'kioku-test',
      prefix: 'kioku',
      accessKeyId,
      hasSecret: true,
      hour: 3,
      keep: 2,
      status: { lastSuccess: null, lastError: null },
    })
    expect(JSON.stringify(view)).not.toContain('backup-secret')
    const [row] = await database.db
      .select()
      .from(settings)
      .where(inArray(settings.key, ['backup']))
    expect(JSON.stringify(row?.value)).not.toContain('backup-secret')

    // 同一个主机不填 Secret：沿用
    await save({ secretAccessKey: undefined, keep: 5 })
    expect((await loadBackupConfig(database.db, masterKey))?.secretAccessKey).toBe('backup-secret')
    // 换了主机不填 Secret：要重填
    const moved = await send(
      'PUT',
      '',
      settingsInput({ endpoint: 'https://s3.example.com', secretAccessKey: undefined }),
    )
    expect(moved.status).toBe(400)
    expect(await moved.text()).toContain('接口主机变了')

    const bad = await send('PUT', '', settingsInput({ prefix: '/kioku/' }))
    expect(bad.status).toBe(400)

    const member = await addMember(database.db, ws.spaceId, 'bob', 'owner')
    expect((await send('GET', '', undefined, member.cookie)).status).toBe(403)
    expect((await send('PUT', '', settingsInput(), member.cookie)).status).toBe(403)
    expect((await send('POST', '/run', undefined, member.cookie)).status).toBe(403)

    expect((await send('DELETE', '')).status).toBe(204)
    expect(((await (await send('GET', '')).json()) as BackupSettingsView).configured).toBe(false)
  })

  it('立即备份：备份传到前缀目录下，留最近几份，存储桶里别的文件不动；能取回来恢复', async () => {
    expect((await send('POST', '/run')).status).toBe(400)
    await save()
    // 已有的：两份更早的备份、同一目录下别的文件、别的目录下的备份
    const old = (name: string) =>
      s3.objects.set(`kioku-test/${name}`, { body: Buffer.from('old'), at: '2026-01-01T00:00:00Z' })
    old('kioku/kioku-2026-01-01T00-00-00Z.backup')
    old('kioku/kioku-2026-01-02T00-00-00Z.backup')
    old('kioku/notes.txt')
    old('other/kioku-2026-01-01T00-00-00Z.backup')

    expect((await send('POST', '/run')).status).toBe(202)
    expect(queued).toEqual(['backup'])
    expect(await backupJob(database.db, masterKey, true)).toBe('done')

    const status = await loadBackupStatus(database.db)
    expect(status.lastError).toBeNull()
    const made = status.lastSuccess!
    expect(made.object).toMatch(/^kioku\/kioku-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.backup$/)
    expect(keys()).toEqual([
      `kioku-test/kioku/kioku-2026-01-02T00-00-00Z.backup`,
      `kioku-test/${made.object}`,
      'kioku-test/kioku/notes.txt',
      'kioku-test/other/kioku-2026-01-01T00-00-00Z.backup',
    ])
    const uploaded = s3.objects.get(`kioku-test/${made.object}`)!.body
    expect(uploaded.length).toBe(made.bytes)
    expect(readBackup(masterKey, uploaded).header.format).toBe('kioku-backup')

    // 列出的只有备份，新的在前；分页列也取得全
    s3.pageSize = 1
    const listed = (await (await send('GET', '/objects')).json()) as BackupObjectList
    expect(listed.objects.map((o) => o.object)).toEqual([
      made.object,
      'kioku/kioku-2026-01-02T00-00-00Z.backup',
    ])

    // 恢复命令从存储桶取：默认最新的一份，也能指定
    const location = {
      endpoint: s3.endpoint,
      region: 'us-east-1',
      bucket: 'kioku-test',
      accessKeyId,
      secretAccessKey: 'backup-secret',
    }
    expect((await fetchBackup(location, 'kioku', null)).object).toBe(made.object)
    expect(
      (await fetchBackup(location, 'kioku', 'kioku/kioku-2026-01-02T00-00-00Z.backup')).file,
    ).toEqual(Buffer.from('old'))
    await expect(fetchBackup(location, 'nothing', null)).rejects.toThrow('下没有备份')
  })

  it('定时：到了钟点才做，做过了不重复做', async () => {
    const hour = new Date().getUTCHours()
    // 钟点设在下一个小时：昨天那个钟点之后做过的话就不用做
    await save({ hour: (hour + 1) % 24 })
    expect(await backupJob(database.db, masterKey, false)).toBe('done')
    expect(await backupJob(database.db, masterKey, false)).toBe('skipped')
    expect(s3.objects.size).toBe(1)
    // 没有设置时什么都不做
    expect((await send('DELETE', '')).status).toBe(204)
    expect(await backupJob(database.db, masterKey, true)).toBe('skipped')
  })

  it('传不上去时记下原因；删旧的出错时这份照样算做成，记下提醒', async () => {
    await save()
    s3.fail(403, 'PUT')
    expect(await backupJob(database.db, masterKey, true)).toBe('failed')
    let status = await loadBackupStatus(database.db)
    expect(status.lastSuccess).toBeNull()
    expect(status.lastError?.message).toContain('存储返回 403（AccessDenied：故意出错）')

    s3.fail(undefined, 'PUT')
    s3.objects.set('kioku-test/kioku/kioku-2026-01-01T00-00-00Z.backup', {
      body: Buffer.from('old'),
      at: '2026-01-01T00:00:00Z',
    })
    s3.objects.set('kioku-test/kioku/kioku-2026-01-02T00-00-00Z.backup', {
      body: Buffer.from('old'),
      at: '2026-01-02T00:00:00Z',
    })
    s3.fail(403, 'DELETE')
    expect(await backupJob(database.db, masterKey, true)).toBe('done')
    status = await loadBackupStatus(database.db)
    expect(status.lastSuccess).not.toBeNull()
    expect(status.lastError?.message).toContain('备份已经传上去，但删旧备份时出错')

    // 之后整次成功就清掉提醒
    s3.fail(undefined, 'DELETE')
    expect(await backupJob(database.db, masterKey, true)).toBe('done')
    expect((await loadBackupStatus(database.db)).lastError).toBeNull()
  })

  it('测试连通：放一个小文件、列一遍再删掉；出错时说清原因', async () => {
    expect((await send('POST', '/test')).status).toBe(400)
    await save()
    let result = (await (await send('POST', '/test')).json()) as BackupTestResult
    expect(result).toEqual({ ok: true, error: null })
    expect(s3.objects.size).toBe(0)
    expect(s3.requests.map((r) => r.method)).toEqual(['PUT', 'GET', 'DELETE'])

    s3.fail(403, 'DELETE')
    result = (await (await send('POST', '/test')).json()) as BackupTestResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('存储返回 403')
  })

  it('Secret 也在主密钥管的数据里：启动检查认得它，轮换时换成新密钥的包装', async () => {
    await save()
    await expect(checkMasterKey(database.db, randomBytes(32))).rejects.toThrow(
      '实例设置里的接口 Key 1 条解不开',
    )
    const newKey = randomBytes(32)
    expect(
      await rotateMasterKey(database.db, { current: newKey, previous: masterKey }),
    ).toMatchObject({ rewrapped: 1, remaining: 0 })
    expect((await loadBackupConfig(database.db, newKey))?.secretAccessKey).toBe('backup-secret')
  })
})
