import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEGACY_ADMIN_INVALID,
  LEGACY_DATABASE_CODE,
  LEGACY_KEY_CODE,
  type LegacyUpgradeResult,
  type SetupStatus,
} from '@kioku/contracts'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { generateApiKey } from '../../auth/keys'
import { hashPassword } from '../../auth/password'
import { runMigrateLegacy } from '../../cli/commands/migrateLegacy'
import { loadConfig, type Config } from '../../config'
import { encryptSecret } from '../../crypto/envelope'
import { keyIdOf } from '../../crypto/keyring'
import type { Database } from '../../db/client'
import { applyMigrations, migrationStateIn, runMigrations } from '../../db/migrate'
import { staticEmbedderSource } from '../../embedding/source'
import { startRuntime, type Runtime } from '../../runtime'
import { openTestDatabase, testDatabaseUrl } from '../../testing/db'
import { LegacyUpgradeError, migrateLegacyInPlace, moveOwnedPublicObjects } from '../legacyInPlace'

const migrationsFolder = fileURLToPath(new URL('../../../migrations', import.meta.url))
// v0.5.0 的迁移原样拷贝：在测试库里建出真实的重构之前的结构（含行级安全、全文检索配置与迁移记录）
const legacyMigrationsFolder = fileURLToPath(
  new URL('./fixtures/legacy-v0.5.0-migrations', import.meta.url),
)
const PARKED = 'kioku_test_parked'
const PASSWORD = 'legacy admin password'

interface Seeded {
  accountId: string
  spaceId: string
  oldKey: string
  revokedKey: string
}

describe.skipIf(!testDatabaseUrl)('旧版就地升级', { timeout: 120_000 }, () => {
  let database: Database
  const masterKey = randomBytes(32)

  // 把 public 里的东西（这个版本的结构或者上一个用例留下的）清掉，换成 v0.5.0 的结构并写入旧数据
  async function prepareLegacy(): Promise<Seeded> {
    const passwordHash = await hashPassword(PASSWORD)
    const key = generateApiKey()
    const revoked = generateApiKey()
    const ids = { accountId: randomUUID(), spaceId: randomUUID(), appId: randomUUID() }
    const secretId = randomUUID()
    const sealed = encryptSecret(masterKey, '机密正文 legacy-secret-body', secretId)
    await database.db.transaction(async (tx) => {
      await clearInstance(tx)
      await applyMigrations(tx, readMigrationFiles({ migrationsFolder: legacyMigrationsFolder }))
      await tx.execute(sql`
        insert into accounts (id, username, display_name, password_hash, is_admin)
        values (${ids.accountId}, 'alice', 'Alice', ${passwordHash}, true),
               (${randomUUID()}, 'bob', 'Bob', ${passwordHash}, false)`)
      await tx.execute(sql`insert into spaces (id, name) values (${ids.spaceId}, '旧工作室')`)
      await tx.execute(sql`
        insert into space_members (space_id, account_id, role)
        values (${ids.spaceId}, ${ids.accountId}, 'owner')`)
      await tx.execute(sql`select set_config('app.space_id', ${ids.spaceId}, true)`)
      await tx.execute(sql`
        insert into apps (id, space_id, slug, name, runtime_family, owner_account_id)
        values (${ids.appId}, ${ids.spaceId}, 'claude', 'Claude Code', 'claude-code', ${ids.accountId})`)
      await tx.execute(sql`
        insert into api_keys (space_id, app_id, name, prefix, secret_hash, scopes)
        values (${ids.spaceId}, ${ids.appId}, '笔记本', ${key.prefix}, ${key.secretHash}, '{}'::jsonb),
               (${ids.spaceId}, ${ids.appId}, '旧电脑', ${revoked.prefix}, ${revoked.secretHash}, '{}'::jsonb)`)
      await tx.execute(sql`update api_keys set revoked_at = now() where prefix = ${revoked.prefix}`)
      await tx.execute(sql`
        insert into memories (space_id, form, layer, sensitivity, provenance, owner_account_id, domain, path, title, content)
        values (${ids.spaceId}, 'curated', 'core', 'internal', 'owner', null, 'core', 'profile/name', '称呼', '叫我阿丽'),
               (${ids.spaceId}, 'curated', 'user', 'private', 'owner', ${ids.accountId}, 'user', 'habits/coffee', '咖啡', '只喝美式')`)
      await tx.execute(sql`
        insert into memories (id, space_id, form, layer, sensitivity, provenance, domain, path, title,
          ciphertext, wrapped_key, key_id)
        values (${secretId}, ${ids.spaceId}, 'curated', 'core', 'secret', 'owner', 'core', 'vault/pin', '密码',
          ${sealed.ciphertext}, ${sealed.wrappedKey}, ${keyIdOf(masterKey)})`)
    })
    return { ...ids, oldKey: key.plaintext, revokedKey: revoked.plaintext }
  }

  // public、迁移记录与改名的 schema 都清掉。扩展留在 public 里不动
  async function clearInstance(tx: Parameters<Parameters<Database['db']['transaction']>[0]>[0]) {
    await tx.execute(sql.raw(`drop schema if exists ${PARKED} cascade`))
    await tx.execute(sql.raw(`create schema ${PARKED}`))
    await moveOwnedPublicObjects(tx, PARKED)
    await tx.execute(sql.raw(`drop schema ${PARKED} cascade`))
    await tx.execute(sql`drop table if exists drizzle.__drizzle_migrations`)
    await tx.execute(sql`drop schema if exists kioku_legacy cascade`)
    await tx.execute(sql`drop schema if exists kioku_legacy_pgboss cascade`)
  }

  const state = () =>
    database.db.transaction((tx) => migrationStateIn(tx, readMigrationFiles({ migrationsFolder })))
  const exists = async (name: string) => {
    const [row] = await database.db.execute<{ found: boolean }>(
      sql`select to_regclass(${name}) is not null as found`,
    )
    return row!.found
  }

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  // 还原成这个版本的空库，后面的测试文件照常用
  afterAll(async () => {
    await database.db.transaction((tx) => clearInstance(tx))
    await runMigrations(database, migrationsFolder)
    await database.close()
  })

  it('预览把整套迁移跑完再回滚：统计与执行一致，库保持原样', async () => {
    await prepareLegacy()
    const result = await migrateLegacyInPlace(database.db, {
      migrationsFolder,
      masterKey,
      apply: false,
    })
    expect(result.applied).toBe(false)
    expect(result.summary).toMatchObject({
      accounts: 2,
      legacyKeys: 1,
      entries: { entry: 3, secret: 1 },
    })
    expect(result.summary.sharedCircles).toEqual([{ name: '旧工作室', memberCount: 1 }])
    expect(await state()).toBe('pre_baseline')
    expect(await exists('public.spaces')).toBe(true)
    expect(await exists('kioku_legacy.spaces')).toBe(false)
  })

  it('执行之后旧对象保留在 kioku_legacy，新结构可用，旧访问密钥回 legacy_key', async () => {
    const seeded = await prepareLegacy()
    const result = await migrateLegacyInPlace(database.db, {
      migrationsFolder,
      masterKey,
      apply: true,
    })
    expect(result.applied).toBe(true)
    expect(await state()).toBe('known')
    expect(await exists('public.circles')).toBe(true)
    expect(await exists('public.spaces')).toBe(false)
    expect(await exists('kioku_legacy.spaces')).toBe(true)
    expect(await exists('kioku_legacy.__drizzle_migrations')).toBe(true)

    const [account] = await database.db.execute<{ id: string; is_admin: boolean }>(
      sql`select id, is_admin from accounts where username = 'alice'`,
    )
    expect(account).toEqual({ id: seeded.accountId, is_admin: true })
    const legacyKeys = await database.db.execute<{ name: string; owner_account_id: string }>(
      sql`select name, owner_account_id from legacy_api_keys`,
    )
    expect([...legacyKeys]).toEqual([{ name: '笔记本', owner_account_id: seeded.accountId }])
    // 旧库的数据原样留着
    const [old] = await database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from kioku_legacy.accounts`,
    )
    expect(old!.n).toBe(2)

    const app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
    const whoami = (key: string) =>
      app.request('/v1/whoami', { headers: { authorization: `Bearer ${key}` } })
    const legacy = await whoami(seeded.oldKey)
    expect(legacy.status).toBe(401)
    expect(await legacy.json()).toMatchObject({ code: LEGACY_KEY_CODE })
    // 吊销过的旧密钥不记，和随便一串一样
    const revoked = await whoami(seeded.revokedKey)
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).not.toHaveProperty('code')
    // 前缀对得上、密钥不对的也不算旧密钥
    const forged = `${seeded.oldKey.slice(0, -4)}AAAA`
    expect(await (await whoami(forged)).json()).not.toHaveProperty('code')

    await expect(
      migrateLegacyInPlace(database.db, { migrationsFolder, masterKey, apply: true }),
    ).rejects.toThrow(LegacyUpgradeError)
  })

  it('同库里其他应用的无关表留在 public 不动，不移进 kioku_legacy', async () => {
    await prepareLegacy()
    await database.db.execute(
      sql`create table public.unrelated_notes (id int primary key, note text)`,
    )
    await database.db.execute(
      sql`insert into public.unrelated_notes (id, note) values (1, 'keep-me')`,
    )
    try {
      const result = await migrateLegacyInPlace(database.db, {
        migrationsFolder,
        masterKey,
        apply: true,
      })
      expect(result.applied).toBe(true)
      expect(await exists('public.unrelated_notes')).toBe(true)
      expect(await exists('kioku_legacy.unrelated_notes')).toBe(false)
      const [row] = await database.db.execute<{ note: string }>(
        sql`select note from public.unrelated_notes where id = 1`,
      )
      expect(row?.note).toBe('keep-me')
    } finally {
      await database.db.execute(sql`drop table if exists public.unrelated_notes`)
    }
  })

  it('命令行 kioku-ctl migrate-legacy --in-place 支持干跑预览与 --apply 执行', async () => {
    await prepareLegacy()
    const prevDb = process.env.DATABASE_URL
    const prevKey = process.env.KIOKU_MASTER_KEY
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.KIOKU_MASTER_KEY = masterKey.toString('base64')
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '))
    })
    try {
      expect(await runMigrateLegacy(['--in-place', '--json'])).toBe(0)
      const dryRun = JSON.parse(logs.pop()!) as LegacyUpgradeResult
      expect(dryRun.applied).toBe(false)
      expect(dryRun.summary.accounts).toBe(2)
      expect(await state()).toBe('pre_baseline')

      expect(await runMigrateLegacy(['--in-place', '--apply', '--json'])).toBe(0)
      const applied = JSON.parse(logs.pop()!) as LegacyUpgradeResult
      expect(applied.applied).toBe(true)
      expect(applied.summary.legacyKeys).toBe(1)
      expect(await state()).toBe('known')
    } finally {
      spy.mockRestore()
      if (prevDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevDb
      if (prevKey === undefined) delete process.env.KIOKU_MASTER_KEY
      else process.env.KIOKU_MASTER_KEY = prevKey
    }
  })

  it('核对管理员失败、kioku_legacy 已存在时整体撤销', async () => {
    await prepareLegacy()
    await expect(
      migrateLegacyInPlace(database.db, {
        migrationsFolder,
        masterKey,
        apply: true,
        authorize: () => Promise.reject(new Error('拒绝')),
      }),
    ).rejects.toThrow('拒绝')
    expect(await state()).toBe('pre_baseline')

    await database.db.execute(sql`create schema kioku_legacy`)
    await expect(
      migrateLegacyInPlace(database.db, { migrationsFolder, masterKey, apply: true }),
    ).rejects.toThrow(/已经有 kioku_legacy/)
    expect(await state()).toBe('pre_baseline')
    expect(await exists('public.spaces')).toBe(true)
  })

  describe('服务按待迁移启动，在升级页迁移后切换', () => {
    let dataDir: string
    let runtime: Runtime | null = null

    const configFor = (): Config => ({
      ...loadConfig({
        KIOKU_DATA_DIR: dataDir,
        DATABASE_URL: testDatabaseUrl!,
        KIOKU_MASTER_KEY: masterKey.toString('base64'),
      }),
      migrationsFolder,
      webDir: '',
    })
    const call = (path: string, body?: unknown) =>
      runtime!.fetch(
        new Request(`http://localhost/v1${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'kioku-legacy-'))
    })
    afterEach(async () => {
      await runtime?.stop()
      runtime = null
      await rm(dataDir, { recursive: true, force: true })
    })

    it('健康检查回 503 带 legacy_database；管理员核对通过后迁移并接上', async () => {
      await prepareLegacy()
      runtime = await startRuntime(configFor(), { log: () => {}, onFatal: () => {} })
      expect(runtime.state()).toBe('legacy')
      expect(runtime.gate.isOpen).toBe(false)

      const health = await call('/health')
      expect(health.status).toBe(503)
      expect(await health.json()).toMatchObject({ database: 'legacy', code: LEGACY_DATABASE_CODE })
      const status = (await (await call('/setup/status')).json()) as SetupStatus
      expect(status).toMatchObject({ needsSetup: false, database: { state: 'legacy' } })
      expect((await call('/entries')).status).toBe(503)

      const wrong = await call('/legacy-upgrade/preview', { username: 'alice', password: 'nope' })
      expect(wrong.status).toBe(403)
      expect(await wrong.json()).toMatchObject({ code: LEGACY_ADMIN_INVALID })
      // 不是管理员的旧账号也不行
      const member = await call('/legacy-upgrade/apply', { username: 'bob', password: PASSWORD })
      expect(member.status).toBe(403)

      const preview = await call('/legacy-upgrade/preview', {
        username: 'alice',
        password: PASSWORD,
      })
      expect(preview.status).toBe(200)
      expect(((await preview.json()) as LegacyUpgradeResult).applied).toBe(false)
      expect(runtime.state()).toBe('legacy')

      const applied = await call('/legacy-upgrade/apply', {
        username: 'Alice',
        password: PASSWORD,
      })
      expect(applied.status).toBe(200)
      expect(((await applied.json()) as LegacyUpgradeResult).applied).toBe(true)
      expect(runtime.state()).toBe('ready')
      const after = await call('/health')
      expect(after.status).toBe(200)
      expect(await after.json()).toMatchObject({ status: 'ok', api: 2 })
    })
  })
})
