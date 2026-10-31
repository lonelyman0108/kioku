import { DrizzleQueryError, eq } from 'drizzle-orm'
import { PostgresError } from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { openTestDatabase, testDatabaseUrl } from '../../testing/db'
import {
  isUniqueViolation,
  pgConstraint,
  pgErrorCode,
  pgMessage,
  type Database,
  type Tx,
} from '../client'
import { settings } from '../schema'

const KEY = 'pg-error-test'
const PKEY = 'settings_pkey'

// 真实的数据库错误：两条路径给出的错误对象不一样，字段要读得一样
describe.skipIf(!testDatabaseUrl)('数据库报错的字段', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await database.db.insert(settings).values({ key: KEY, value: {} })
  })
  afterEach(async () => {
    await database.db.delete(settings).where(eq(settings.key, KEY))
  })

  const duplicate = (tx: Tx) => tx.insert(settings).values({ key: KEY, value: {} })
  const expectUniqueViolation = (err: unknown) => {
    expect(pgErrorCode(err)).toBe('23505')
    expect(pgConstraint(err)).toBe(PKEY)
    expect(pgMessage(err)).toContain('duplicate key')
    expect(isUniqueViolation(err, PKEY)).toBe(true)
  }

  it('回调没接住语句的错误：事务以 drizzle 包着的错误 reject', async () => {
    const err = await database.db.transaction((tx) => duplicate(tx)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DrizzleQueryError)
    expectUniqueViolation(err)
  })

  it('回调把语句的错误接住了：驱动照样回滚，事务以未包装的错误 reject', async () => {
    const err = await database.db
      .transaction(async (tx) => {
        await duplicate(tx).catch(() => {})
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PostgresError)
    expectUniqueViolation(err)
  })
})
