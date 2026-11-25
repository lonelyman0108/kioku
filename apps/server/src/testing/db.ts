import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { CreateEntryRequest } from '@kioku/contracts'
import { sql } from 'drizzle-orm'

import { createApp } from '../app'
import { generateApiKey } from '../auth/keys'
import { hashPassword } from '../auth/password'
import { createSession, SESSION_COOKIE } from '../auth/session'
import { resetLoginLimitsForTest } from '../auth/rateLimit'
import type { Keyring } from '../crypto/keyring'
import { connect, type Database } from '../db/client'
import { runMigrations } from '../db/migrate'
import { accounts, apiKeys } from '../db/schema'
import type { Deps } from '../http/env'
import { testWorkers, workerDatabaseUrl } from './workers'

// 集成测试共用：需要真实 PostgreSQL。本地设置 KIOKU_TEST_DATABASE_URL；CI 未设置直接失败
const baseUrl = process.env.KIOKU_TEST_DATABASE_URL
if (!baseUrl && process.env.CI) throw new Error('CI 环境缺少 KIOKU_TEST_DATABASE_URL')
export const testDatabaseUrl =
  baseUrl && workerDatabaseUrl(baseUrl, testWorkers(), process.env.VITEST_POOL_ID)

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url))

export function testMasterKey(): Keyring {
  return { current: randomBytes(32), previous: null }
}

export async function openTestDatabase(): Promise<Database> {
  const database = connect(testDatabaseUrl!, { max: 2 })
  await runMigrations(database, migrationsFolder)
  await resetDatabase(database)
  return database
}

export async function resetDatabase(database: Database): Promise<void> {
  resetLoginLimitsForTest()
  await database.db.execute(
    sql`truncate accounts, api_keys, device_grants, entries, credentials, turn_buffer, dream_suggestions, settings cascade`,
  )
}

export async function createOwnerSession(
  database: Database,
  options: { username?: string; displayName?: string; password?: string } = {},
): Promise<{ accountId: string; cookie: string }> {
  const passwordHash = await hashPassword(options.password ?? 'correct horse battery')
  const [account] = await database.db
    .insert(accounts)
    .values({
      username: options.username ?? 'owner',
      displayName: options.displayName ?? 'Owner',
      passwordHash,
    })
    .returning()
  const token = await createSession(database.db, account!.id)
  return { accountId: account!.id, cookie: `${SESSION_COOKIE}=${token}` }
}

export async function issueTestApiKey(
  database: Database,
  options: {
    name?: string
    runtimeFamily?: typeof apiKeys.$inferInsert.runtimeFamily
    envs?: string[]
    allowedRealms?: string[] | null
    canWrite?: boolean
    canResolveCredentials?: boolean
  } = {},
): Promise<{ id: string; key: string; prefix: string }> {
  const generated = generateApiKey()
  const [row] = await database.db
    .insert(apiKeys)
    .values({
      name: options.name ?? 'Test Terminal',
      runtimeFamily: options.runtimeFamily ?? 'claudecode',
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      envs: options.envs ?? [],
      allowedRealms: options.allowedRealms ?? null,
      canWrite: options.canWrite ?? true,
      canResolveCredentials: options.canResolveCredentials ?? false,
    })
    .returning()
  return { id: row!.id, key: generated.plaintext, prefix: generated.prefix }
}

export function createTestApp(database: Database, overrides: Partial<Omit<Deps, 'db'>> = {}) {
  return createApp({
    db: database.db,
    cookieSecure: false,
    masterKey: overrides.masterKey !== undefined ? overrides.masterKey : testMasterKey(),
    jobs: overrides.jobs !== undefined ? overrides.jobs : null,
    ...(overrides.trustedProxies !== undefined ? { trustedProxies: overrides.trustedProxies } : {}),
    ...(overrides.webDir !== undefined ? { webDir: overrides.webDir } : {}),
    ...(overrides.setup !== undefined ? { setup: overrides.setup } : {}),
  })
}

export function entryInput(
  input: Parameters<typeof CreateEntryRequest.parse>[0],
): CreateEntryRequest {
  return CreateEntryRequest.parse(input)
}

export function consoleHeaders(cookie: string, withJson = false): Record<string, string> {
  return {
    cookie,
    'sec-fetch-site': 'same-origin',
    ...(withJson ? { 'content-type': 'application/json' } : {}),
  }
}

export { databaseNow } from '../db/client'
