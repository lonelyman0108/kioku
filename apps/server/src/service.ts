import { DATABASE_FAILURE_NAMES } from '@kioku/contracts'
import { count, DrizzleQueryError, sql } from 'drizzle-orm'
import postgres from 'postgres'

import { createApp } from './app'
import type { Config } from './config'
import { prepareMasterKey } from './crypto/rotation'
import { connect, errorText, type Database } from './db/client'
import { MigrationStateError, runMigrations } from './db/migrate'
import { failureOf } from './db/probe'
import { accounts } from './db/schema'
import type { SetupHost } from './http/env'
import { startJobs, type Jobs } from './jobs/queue'

// 完整服务启动入口：连库、迁移、核对并同步重封主密钥、起后台任务、组装路由。
// 冷启动、断线重试与初始化页接入均走此同一路径
export interface Service {
  app: ReturnType<typeof createApp>
  database: Database
  jobs: Jobs & { stop: () => Promise<void> }
  accounts: () => Promise<number>
}

type Step = 'connect' | 'migrate' | 'master_key' | 'jobs'

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

export function startupText(err: StartupError): string {
  const { step, cause } = err
  const own = cause instanceof Error && !isDatabaseError(cause) && !('code' in cause)
  switch (step) {
    case 'connect':
      return `无法连接数据库：${DATABASE_FAILURE_NAMES[failureOf(cause)]}`
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
  extra: { setup?: SetupHost } = {},
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
    await step('migrate', () => runMigrations(database, config.migrationsFolder))
    const rotated = await step('master_key', () => prepareMasterKey(database.db, config.masterKey))
    if (rotated.rewrappedCredentials + rotated.rewrappedSettings > 0) {
      console.log(
        `主密钥轮换完成：重封凭据 ${rotated.rewrappedCredentials} 条、模型设置 ${rotated.rewrappedSettings} 项`,
      )
    }

    const started = await step('jobs', () =>
      startJobs({
        connectionString: url,
        db: database.db,
        masterKey: config.masterKey,
      }),
    )
    jobs = started
    void started.enqueueBackfill()

    const app = createApp({
      db: database.db,
      cookieSecure: config.cookieSecure,
      masterKey: config.masterKey,
      trustedProxies: config.trustedProxies,
      webDir: config.webDir,
      jobs: started,
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
    await jobs?.stop().catch(() => {})
    await database.close().catch(() => {})
    throw err
  }
}
