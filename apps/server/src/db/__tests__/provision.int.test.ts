import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DatabaseConnection } from '@kioku/contracts'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { loadConfig } from '../../config'
import { startRuntime, type Runtime } from '../../runtime'
import { connectionUrl, probeDatabase, summarize } from '../probe'

// 要超级用户才测得了：拒绝超级用户与 BYPASSRLS、缺扩展、代建。本地设 KIOKU_TEST_SUPERUSER_URL
// （例如 postgres://postgres:postgres@localhost:55432/postgres）；CI 不设时跳过。
// 建出的角色与库都带随机后缀，结束时删掉
const superuserUrl = process.env.KIOKU_TEST_SUPERUSER_URL
const migrationsFolder = fileURLToPath(new URL('../../../migrations', import.meta.url))
const CODE = 'TEST-SETUP-CODE-2'

function connectionOf(url: string): DatabaseConnection {
  const s = summarize(url)!
  return {
    host: s.host,
    port: s.port,
    database: s.database,
    username: s.username,
    password: decodeURIComponent(new URL(url).password),
    ssl: 'disable',
  }
}

describe.skipIf(!superuserUrl)('数据库检查与超级用户代建', () => {
  let admin: postgres.Sql
  const suffix = randomBytes(4).toString('hex')
  const roles: string[] = []
  const databases: string[] = []
  const name = (base: string) => `kioku_t_${base}_${suffix}`

  beforeAll(() => {
    admin = postgres(superuserUrl!, { max: 1, onnotice: () => {} })
  })
  afterAll(async () => {
    try {
      for (const db of databases) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
      for (const role of roles) await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`)
    } finally {
      await admin?.end()
    }
  })

  const superuser = () => connectionOf(superuserUrl!)

  it('拒绝超级用户与带 BYPASSRLS 的角色', async () => {
    const asSuper = await probeDatabase(superuserUrl!, migrationsFolder)
    expect(asSuper.role?.superuser).toBe(true)
    expect(asSuper.ready).toBe(false)

    const role = name('bypass')
    roles.push(role)
    await admin.unsafe(`CREATE ROLE "${role}" LOGIN BYPASSRLS PASSWORD 'bypass-pass'`)
    const asBypass = await probeDatabase(
      connectionUrl({ ...superuser(), username: role, password: 'bypass-pass' }),
      migrationsFolder,
    )
    expect(asBypass.role).toEqual({ name: role, superuser: false, bypassRls: true })
    expect(asBypass.ready).toBe(false)
  })

  it('库里没装扩展时拦住，说明服务器上有', async () => {
    const role = name('plain')
    const db = name('noext')
    roles.push(role)
    databases.push(db)
    await admin.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD 'plain-pass'`)
    await admin.unsafe(`CREATE DATABASE "${db}" OWNER "${role}"`)
    const check = await probeDatabase(
      connectionUrl({ ...superuser(), username: role, password: 'plain-pass', database: db }),
      migrationsFolder,
    )
    expect(check).toMatchObject({
      failure: null,
      existing: 'empty',
      extensions: [
        { name: 'vector', state: 'available' },
        { name: 'zhparser', state: 'available' },
      ],
      ready: false,
    })
  })

  describe('代建', () => {
    let dataDir: string
    let runtime: Runtime | null = null
    const call = (path: string, body?: unknown) =>
      runtime!.fetch(
        new Request(`http://localhost/v1${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    const start = async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'kioku-provision-'))
      runtime = await startRuntime(
        {
          ...loadConfig({ KIOKU_DATA_DIR: dataDir, KIOKU_SETUP_CODE: CODE }),
          migrationsFolder,
          webDir: '',
        },
        { log: () => {} },
      )
    }
    afterEach(async () => {
      await runtime?.stop()
      runtime = null
      await rm(dataDir, { recursive: true, force: true })
    })

    it('建应用角色与库、装扩展，只保存应用角色的连接，当场接上后能建管理员', async () => {
      await start()
      const role = name('app')
      const db = name('app')
      roles.push(role)
      databases.push(db)
      const res = await call('/setup/database/provision', {
        setupCode: CODE,
        superuser: superuser(),
        role,
        database: db,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        summary: { username: role, database: db, passwordSet: true },
        check: { ready: true, existing: 'empty' },
      })
      expect(runtime!.state()).toBe('ready')
      const saved = await readFile(join(dataDir, 'kioku.json'), 'utf8')
      expect(saved).toContain(`//${role}:`)
      expect(saved).not.toContain(`:${encodeURIComponent(superuser().password)}@`)

      const [created] = await admin<
        { super: boolean; bypass: boolean; createdb: boolean; createrole: boolean; owner: string }[]
      >`
        select r.rolsuper as super, r.rolbypassrls as bypass, r.rolcreatedb as createdb,
          r.rolcreaterole as createrole, pg_get_userbyid(d.datdba) as owner
        from pg_roles r, pg_database d where r.rolname = ${role} and d.datname = ${db}`
      expect(created).toEqual({
        super: false,
        bypass: false,
        createdb: false,
        createrole: false,
        owner: role,
      })

      const setup = await call('/setup', {
        setupCode: CODE,
        username: 'alice',
        displayName: 'Alice',
        password: 'correct horse battery',
        spaceName: '家',
      })
      expect(setup.status).toBe(201)
    })

    it('角色已存在、不是超级用户时什么都不建', async () => {
      await start()
      const db = name('unused')
      const exists = await call('/setup/database/provision', {
        setupCode: CODE,
        superuser: superuser(),
        role: 'postgres',
        database: db,
      })
      expect(exists.status).toBe(400)
      expect(await exists.json()).toMatchObject({ problem: 'role_exists' })

      const role = name('weak')
      roles.push(role)
      await admin.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD 'weak-pass'`)
      const weak = await call('/setup/database/provision', {
        setupCode: CODE,
        superuser: { ...superuser(), username: role, password: 'weak-pass' },
        role: name('never'),
        database: db,
      })
      expect(weak.status).toBe(400)
      expect(await weak.json()).toMatchObject({ problem: 'not_superuser' })
      expect(await admin`select 1 from pg_database where datname = ${db}`).toHaveLength(0)
      expect(runtime!.state()).toBe('missing')
    })
  })
})
