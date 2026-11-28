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

  it('已创建中文全文检索配置 kioku_zh 并支持中文分词与分级权重', async () => {
    const rows = await database.db.execute<{ vec: string }>(
      sql`select (setweight(to_tsvector('public.kioku_zh', '部署指南'), 'A') || setweight(to_tsvector('public.kioku_zh', '单人长期记忆系统'), 'C'))::text as vec`,
    )
    const vec = [...rows][0]?.vec ?? ''
    expect(vec).toContain('部署')
    expect(vec).toContain('A')
    expect(vec).toContain('记忆')
    expect(vec).toContain('C')
  })

  it('增量迁移新增了词条摘要、语义历史、双链语境与规范整理列', async () => {
    const cols = await database.db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'entries' and column_name in ('summary', 'verified_at', 'last_change_summary'))
          or (table_name = 'entry_events' and column_name in ('change_summary', 'diff_meta', 'occurred_at'))
          or (table_name = 'entry_links' and column_name in ('relation', 'context_snippet'))
          or (table_name = 'dream_suggestions' and column_name in ('proposed_summary', 'proposed_change_summary', 'archived_notes'))
        )
    `)
    expect([...cols]).toHaveLength(11)
  })

  it('增量迁移新增了三态启动加载列、同步约束与密钥默认聚焦场域列', async () => {
    const cols = await database.db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'entries' and column_name = 'boot_mode')
          or (table_name = 'api_keys' and column_name = 'focus_realms')
          or (table_name = 'device_grants' and column_name = 'focus_realms')
        )
    `)
    expect([...cols]).toHaveLength(3)

    const checks = await database.db.execute<{ conname: string }>(sql`
      select conname
      from pg_constraint
      where conname in ('entries_boot_mode_check', 'entries_boot_mode_pinned_sync')
    `)
    expect([...checks].map((r) => r.conname).sort()).toEqual([
      'entries_boot_mode_check',
      'entries_boot_mode_pinned_sync',
    ])
  })

  it('增量迁移新增了跨记忆整理建议列与补全双链、调整启动加载约束', async () => {
    const cols = await database.db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'dream_suggestions'
        and column_name in ('proposed_links', 'proposed_boot_mode')
    `)
    expect([...cols]).toHaveLength(2)

    const checks = await database.db.execute<{ conname: string; def: string }>(sql`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conname in ('dream_suggestions_kind_check', 'dream_suggestions_boot_mode_check')
      order by conname
    `)
    const list = [...checks]
    expect(list.map((r) => r.conname)).toEqual([
      'dream_suggestions_boot_mode_check',
      'dream_suggestions_kind_check',
    ])
    const kindDef = list.find((r) => r.conname === 'dream_suggestions_kind_check')?.def ?? ''
    expect(kindDef).toContain('link_entries')
    expect(kindDef).toContain('adjust_boot_mode')
  })

  it('增量迁移新增了复合凭据结构元数据列、约束与整理告警列', async () => {
    const cols = await database.db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'credentials' and column_name in ('kind', 'primary_field', 'field_meta', 'passkey_manual_only', 'provider', 'external_ref'))
          or (table_name = 'dream_suggestions' and column_name = 'secret_warnings')
        )
    `)
    expect([...cols]).toHaveLength(7)

    const checks = await database.db.execute<{ conname: string }>(sql`
      select conname
      from pg_constraint
      where conname in (
        'credentials_kind_check',
        'credentials_provider_check',
        'credentials_primary_field_format'
      )
      order by conname
    `)
    expect([...checks].map((r) => r.conname)).toEqual([
      'credentials_kind_check',
      'credentials_primary_field_format',
      'credentials_provider_check',
    ])
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
