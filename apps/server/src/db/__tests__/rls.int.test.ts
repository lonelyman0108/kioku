import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { assertRuntimeRole, withSpace, type Database } from '../client'
import { accounts, memories, personas, RLS_TABLES, spaces } from '../schema'

describe.skipIf(!testDatabaseUrl)('数据层与空间隔离', () => {
  let database: Database
  let spaceA: string
  let spaceB: string
  let accountId: string

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    const { db } = database
    await resetDatabase(database)
    const [a, b] = await db
      .insert(spaces)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning({ id: spaces.id })
    spaceA = a!.id
    spaceB = b!.id
    const [acc] = await db
      .insert(accounts)
      .values({ username: 'alice', displayName: 'Alice', passwordHash: 'x' })
      .returning({ id: accounts.id })
    accountId = acc!.id
  })

  const baseMemory = (spaceId: string, path: string) => ({
    spaceId,
    form: 'curated' as const,
    layer: 'base' as const,
    sensitivity: 'public' as const,
    provenance: 'owner' as const,
    domain: 'core',
    path,
    content: `内容 ${path}`,
  })

  it('应用角色不是超级用户，也没有 BYPASSRLS', async () => {
    await expect(assertRuntimeRole(database.db)).resolves.toBeUndefined()
  })

  it('每张带 space_id 的内容表都开启并强制了 RLS', async () => {
    const rows = await database.db.execute<{ relname: string }>(sql`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity
      order by c.relname`)
    expect(rows.map((r) => r.relname).sort()).toEqual([...RLS_TABLES].sort())

    const withSpaceId = await database.db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'space_id'`)
    const identityTables = ['api_keys', 'space_members']
    expect(
      withSpaceId
        .map((r) => r.table_name)
        .filter((t) => !identityTables.includes(t))
        .sort(),
    ).toEqual([...RLS_TABLES].sort())
  })

  it('没有声明空间时读不到任何内容，也写不进去', async () => {
    await withSpace(database.db, spaceA, (tx) =>
      tx.insert(memories).values(baseMemory(spaceA, 'a')),
    )
    const visible = await database.db.select().from(memories)
    expect(visible).toHaveLength(0)
    await expect(database.db.insert(memories).values(baseMemory(spaceA, 'b'))).rejects.toThrow()
  })

  it('一个空间看不到另一个空间的记忆', async () => {
    await withSpace(database.db, spaceA, (tx) =>
      tx.insert(memories).values(baseMemory(spaceA, 'a')),
    )
    await withSpace(database.db, spaceB, (tx) =>
      tx.insert(memories).values(baseMemory(spaceB, 'b')),
    )

    const inA = await withSpace(database.db, spaceA, (tx) => tx.select().from(memories))
    expect(inA.map((m) => m.path)).toEqual(['a'])
    const inB = await withSpace(database.db, spaceB, (tx) => tx.select().from(memories))
    expect(inB.map((m) => m.path)).toEqual(['b'])
  })

  it('在 A 空间的事务里写 B 空间的数据会被拒绝', async () => {
    await expect(
      withSpace(database.db, spaceA, (tx) => tx.insert(memories).values(baseMemory(spaceB, 'x'))),
    ).rejects.toThrow()
  })

  it('记忆不能挂到别的空间的人格上', async () => {
    const [persona] = await withSpace(database.db, spaceB, (tx) =>
      tx
        .insert(personas)
        .values({ spaceId: spaceB, slug: 'doubao', name: '豆包' })
        .returning({ id: personas.id }),
    )
    await expect(
      withSpace(database.db, spaceA, (tx) =>
        tx.insert(memories).values({
          ...baseMemory(spaceA, 'soul'),
          layer: 'persona',
          personaId: persona!.id,
        }),
      ),
    ).rejects.toThrow()
  })

  it('secret 级不允许存明文', async () => {
    await expect(
      withSpace(database.db, spaceA, (tx) =>
        tx.insert(memories).values({
          ...baseMemory(spaceA, 'pw'),
          layer: 'private',
          ownerAccountId: accountId,
          sensitivity: 'secret',
        }),
      ),
    ).rejects.toThrow()
  })

  it('untrusted 来源不能写私人层', async () => {
    await expect(
      withSpace(database.db, spaceA, (tx) =>
        tx.insert(memories).values({
          ...baseMemory(spaceA, 'p'),
          layer: 'private',
          ownerAccountId: accountId,
          provenance: 'untrusted',
        }),
      ),
    ).rejects.toThrow()
  })

  it('中文全文检索配置能分词', async () => {
    const rows = await database.db.execute<{ v: string }>(
      sql`select to_tsvector('kioku_zh', '记忆分层与授权')::text as v`,
    )
    expect(rows[0]!.v).toContain('记忆')
  })
})
