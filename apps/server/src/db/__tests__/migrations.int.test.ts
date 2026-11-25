import { fileURLToPath } from 'node:url'

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Database } from '../client'
import { probeDatabase } from '../probe'
import { openTestDatabase, testDatabaseUrl } from '../../testing/db'

const migrationsFolder = fileURLToPath(new URL('../../../migrations', import.meta.url))

const EXPECTED_TABLES = [
  'accounts',
  'api_keys',
  'credentials',
  'device_grants',
  'dream_suggestions',
  'entries',
  'entry_embeddings',
  'entry_events',
  'entry_links',
  'sessions',
  'settings',
  'turn_buffer',
]

describe.skipIf(!testDatabaseUrl)('数据库迁移与探针', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(async () => {
    await database.close()
  })

  it('基线迁移只创建 12 张核心表，且不启用行级安全', async () => {
    const tables = await database.db.execute<{ tablename: string; rowsecurity: boolean }>(
      sql`select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename`,
    )
    const names = [...tables].map((r) => r.tablename)
    expect(names).toEqual(EXPECTED_TABLES)
    expect([...tables].every((r) => r.rowsecurity === false)).toBe(true)
  })

  it('已创建中文全文检索配置 kioku_zh 并支持中文分词检索', async () => {
    const rows = await database.db.execute<{ vec: string }>(
      sql`select to_tsvector('public.kioku_zh', '单人长期记忆系统部署指南')::text as vec`,
    )
    const vec = [...rows][0]?.vec ?? ''
    expect(vec).toContain('记忆')
    expect(vec).toContain('部署')
  })

  it('probeDatabase 对已迁移的库返回 ready 且允许超级用户或普通角色接入', async () => {
    const result = await probeDatabase(testDatabaseUrl!, migrationsFolder)
    expect(result.ready).toBe(true)
    expect(result.problems).toEqual([])
    expect(result.existing).toBe('migrated')
    expect(result.extensions.map((e) => `${e.name}:${e.state}`)).toEqual([
      'vector:installed',
      'zhparser:installed',
    ])
  })
})
