import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import * as schema from '../../db/schema'
import { BACKUP_TABLES } from '../tables'

const EXPECTED_EXCLUDED = new Set([
  'sessions',
  'account_links',
  'device_grants',
  'login_attempts',
  'conversation_turns',
  'entry_embeddings',
  'subject_bind_codes',
  'subject_bind_attempts',
])

const allSchemaTables = (Object.values(schema) as unknown[]).filter((v): v is PgTable =>
  is(v, PgTable),
)

describe('backup tables DAG 与基线覆盖', () => {
  it('涵盖全部 41 张表：除明确排除外全部进入 BACKUP_TABLES，且 perCircle 与 RLS_TABLES 一致', () => {
    expect(allSchemaTables).toHaveLength(41)

    const backupByName = new Map(BACKUP_TABLES.map((t) => [t.name, t]))
    const schemaNames = new Set(allSchemaTables.map((t) => getTableConfig(t).name))

    expect(backupByName.size + EXPECTED_EXCLUDED.size).toBe(schemaNames.size)
    for (const excluded of EXPECTED_EXCLUDED) {
      expect(schemaNames.has(excluded)).toBe(true)
      expect(backupByName.has(excluded)).toBe(false)
    }

    const rlsSet = new Set<string>(schema.RLS_TABLES)
    for (const table of BACKUP_TABLES) {
      expect(schemaNames.has(table.name)).toBe(true)
      expect(table.perCircle).toBe(rlsSet.has(table.name))
    }
  })

  it('生成列、自引用外键与外键拓扑顺序成立', () => {
    const entryVariants = BACKUP_TABLES.find((t) => t.name === 'entry_variants')
    expect(entryVariants?.omitted).toEqual(['fts'])

    const personas = BACKUP_TABLES.find((t) => t.name === 'personas')
    expect(personas?.selfRef).toEqual({ column: 'extends_id', references: 'id' })

    const orderIndex = new Map(BACKUP_TABLES.map((t, index) => [t.name, index]))
    for (const pgTable of allSchemaTables) {
      const cfg = getTableConfig(pgTable)
      const selfIdx = orderIndex.get(cfg.name)
      if (selfIdx === undefined) continue

      for (const fk of cfg.foreignKeys) {
        const targetName = getTableConfig(fk.reference().foreignTable).name
        expect(EXPECTED_EXCLUDED.has(targetName)).toBe(false)
        if (targetName === cfg.name) continue
        const targetIdx = orderIndex.get(targetName)
        expect(targetIdx).toBeDefined()
        expect(targetIdx!).toBeLessThan(selfIdx)
      }
    }
  })
})
