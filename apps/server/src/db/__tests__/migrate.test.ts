import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { readMigrationFiles } from 'drizzle-orm/migrator'
import { describe, expect, it } from 'vitest'

import { migrationsPrefix } from '../migrate'

const migrationsFolder = fileURLToPath(new URL('../../../migrations', import.meta.url))

describe('只执行前几个迁移', () => {
  it('临时目录里是前几个迁移，内容与哈希不变', async () => {
    const all = readMigrationFiles({ migrationsFolder })
    const folder = await migrationsPrefix(migrationsFolder, 3)
    try {
      expect(readMigrationFiles({ migrationsFolder: folder })).toEqual(all.slice(0, 3))
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
