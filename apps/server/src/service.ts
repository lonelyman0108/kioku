import { DATABASE_FAILURE_NAMES } from '@kioku/contracts'
import { count, DrizzleQueryError, sql } from 'drizzle-orm'
import postgres from 'postgres'

import { createApp } from './app'
import type { Config } from './config'
import type { VaultClient } from './credential/bitwarden/types'
import { prepareMasterKey } from './crypto/rotation'
import { assertRuntimeRole, connect, errorText, type Database } from './db/client'
import { MigrationStateError, runMigrations } from './db/migrate'
import { failureOf } from './db/probe'
import { accounts } from './db/schema'
import { settingsEmbedderSource } from './embedding/source'
import type { SetupHost } from './http/env'
import { startJobs, type Jobs } from './jobs/queue'

// 完整的服务：连库、核对角色、迁移、核对主密钥、起后台任务、组装接口。
// 冷启动（配了数据库）与初始化页接上数据库之后走的都是这一个函数

export interface Service {
  app: ReturnType<typeof createApp>
  database: Database
  jobs: Jobs & { stop: () => Promise<void> }
  accounts: () => Promise<number>
}

type Step = 'connect' | 'role' | 'migrate' | 'master_key' | 'jobs'

// 起服务的某一步失败。cause 是原来的错误，只进日志（见 logInternalError），给人看的用 startupText
export class StartupError extends Error {
  constructor(
    readonly step: Step,
    override readonly cause: unknown,
  ) {
    super(`启动失败：${step}`)
  }
}

const isDatabaseError = (err: unknown) =>
  err instanceof DrizzleQueryError || err instanceof postgres.PostgresError

// 起服务失败时给人看的说明：只有本项目自己写的说明（角色、迁移、主密钥）原样给出，
// 驱动与数据库的错误只给类别，原因见服务日志
export function startupText(err: StartupError): string {
  const { step, cause } = err
  const own = cause instanceof Error && !isDatabaseError(cause) && !('code' in cause)
  switch (step) {
    case 'connect':
      return `无法连接数据库：${DATABASE_FAILURE_NAMES[failureOf(cause)]}`
    case 'role':
      return own ? cause.message : '无法读取当前数据库角色，原因见服务日志'
    case 'migrate':
      return cause instanceof MigrationStateError
        ? cause.message
        : '执行数据库迁移失败，原因见服务日志'
    case 'master_key':
      return own ? cause.message : `核对主密钥失败：${errorText(cause)}`
    case 'jobs':
      return '启动后台任务失败，原因见服务日志'
  }
}

export async function startService(
  config: Config,
  url: string,
  extra: { setup?: SetupHost; vault: VaultClient },
): Promise<Service> {
  const database = connect(url)
  let jobs: Service['jobs'] | null = null
  const step = async <T>(name: Step, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      throw new StartupError(name, err)
    }
  }
  try {
    await step('connect', () => database.db.execute(sql`select 1`))
    await step('role', () => assertRuntimeRole(database.db))
    await step('migrate', () => runMigrations(database, config.migrationsFolder))
    // 给加密的数据补上主密钥的标识，主密钥对不上时拒绝启动
    await step('master_key', () => prepareMasterKey(database.db, config.masterKey))

    const embedder = settingsEmbedderSource(database.db, config.masterKey)
    const started = await step('jobs', () =>
      startJobs({
        connectionString: url,
        db: database.db,
        embedder,
        masterKey: config.masterKey,
      }),
    )
    jobs = started
    // 启动时补齐一次：处理上次停机期间没来得及生成的向量；换模型换到一半的接着换
    void started.enqueueBackfill()
    void started.enqueueSwitch()

    const app = createApp({
      db: database.db,
      cookieSecure: config.cookieSecure,
      masterKey: config.masterKey,
      embedder,
      trustedProxies: config.trustedProxies,
      webDir: config.webDir,
      jobs: started,
      vault: extra.vault,
      ...(extra.setup ? { setup: extra.setup } : {}),
    })
    return {
      app,
      database,
      jobs: started,
      accounts: async () => {
        const [row] = await database.db.select({ n: count() }).from(accounts)
        return row?.n ?? 0
      },
    }
  } catch (err) {
    // 起到一半失败：已经起来的后台任务与连接都关掉，不留下半截状态
    await jobs?.stop().catch(() => {})
    await database.close().catch(() => {})
    throw err
  }
}
