import { join } from 'node:path'

import {
  DATABASE_FAILURE_NAMES,
  DATABASE_SOURCE_NAMES,
  databaseProblemText,
  type DatabaseCheck,
  type DatabaseSource,
  type DatabaseState,
} from '@kioku/contracts'

import { createSetupApp } from './app'
import { SetupGate } from './auth/setupCode'
import type { Config } from './config'
import { assertWritable, DATA_FILE, writeDataFile } from './dataDir'
import { logInternalError } from './db/client'
import { failedCheck, isFatal, probeDatabase, transientFailure } from './db/probe'
import type { SetupHost } from './http/env'
import { startService, startupText, StartupError, type Service } from './service'
import { ActivationError, SetupBusyError } from './setupErrors'

type Fetch = (request: Request, ...rest: unknown[]) => Response | Promise<Response>

export interface Runtime {
  fetch: Fetch
  state: () => DatabaseState
  gate: SetupGate
  stop: (drained?: Promise<void>) => Promise<void>
}

export interface RuntimeOptions {
  retryMs?: number
  maxRetryMs?: number
  log?: (line: string) => void
  onFatal?: (message: string) => void
  start?: typeof startService
}

export class FatalStartupError extends Error {}

interface DatabaseStatus {
  state: DatabaseState
  source: DatabaseSource | null
  url: string | null
  check: DatabaseCheck | null
}

function checkProblem(check: DatabaseCheck): string {
  return check.problems.map((p) => databaseProblemText(p, check.failure)).join('；')
}

export async function startRuntime(config: Config, options: RuntimeOptions = {}): Promise<Runtime> {
  const log = options.log ?? ((line: string) => console.log(line))
  const firstRetryMs = options.retryMs ?? 5_000
  const maxRetryMs = options.maxRetryMs ?? 60_000
  const onFatal =
    options.onFatal ??
    ((message: string) => {
      console.error(message)
      process.exit(1)
    })
  const start = options.start ?? startService
  const gate = new SetupGate(config.setupCode)
  let service: Service | null = null
  let status: DatabaseStatus = config.database
    ? { state: 'unavailable', ...config.database, check: null }
    : { state: 'missing', source: null, url: null, check: null }
  let busy = false
  let retryTimer: NodeJS.Timeout | null = null
  let retryMs = firstRetryMs
  let stopped = false
  let lastProblem = ''

  const announce = () => {
    const opened = gate.isOpen
    const code = gate.open()
    if (opened) return
    const source = config.setupCode ? '（来自 KIOKU_SETUP_CODE）' : ''
    log('')
    log(`==================== Kioku 初始化码：${code} ${source}====================`)
    log('打开管理界面，在初始化页填写这个码；建好管理员账号之后作废')
    log('')
  }

  const host: SetupHost = {
    gate,
    migrationsFolder: config.migrationsFolder,
    masterKey: Boolean(config.masterKey),
    database: () => status,
    exclusive: async (fn) => {
      if (busy) throw new SetupBusyError()
      busy = true
      try {
        return await fn()
      } finally {
        busy = false
      }
    },
    activate: (url) => activate(url),
  }
  const setupApp = createSetupApp({
    host,
    trustedProxies: config.trustedProxies,
    webDir: config.webDir,
  })

  const switchTo = (svc: Service, source: DatabaseSource, url: string, accountsCount: number) => {
    service = svc
    status = { state: 'ready', source, url, check: null }
    if (accountsCount === 0) announce()
    else gate.close()
  }

  const inflight = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work)
    void work.then(
      () => inflight.delete(work),
      () => inflight.delete(work),
    )
    return work
  }

  const activate = (url: string) => track(activateNow(url))

  async function activateNow(url: string): Promise<'switched'> {
    if (stopped) throw new ActivationError('服务正在停止')
    if (status.state !== 'missing') throw new ActivationError('数据库已配置')
    const file = join(config.dataDir, DATA_FILE)
    try {
      await assertWritable(config.dataDir)
    } catch (err) {
      console.error('数据目录无法写入', { code: (err as { code?: unknown }).code })
      throw new ActivationError(
        `数据目录无法写入：${config.dataDir}（检查 KIOKU_DATA_DIR 与目录权限）`,
      )
    }
    let svc: Service
    try {
      svc = await start(config, url, { setup: host })
    } catch (err) {
      if (err instanceof StartupError) {
        logInternalError(`接入数据库失败（${err.step}）`, err.cause)
        throw new ActivationError(startupText(err))
      }
      logInternalError('接入数据库失败', err)
      throw new ActivationError('接入失败，原因见服务日志')
    }
    let accountsCount: number
    try {
      accountsCount = await svc.accounts()
    } catch (err) {
      logInternalError('读取账号数失败', err)
      await stopService(svc)
      throw new ActivationError('无法完成接入：读取账号数失败，没有接入')
    }
    if (stopped) {
      await stopService(svc)
      throw new ActivationError('服务正在停止，没有接入')
    }
    try {
      await writeDataFile(config.dataDir, { databaseUrl: url })
    } catch (err) {
      console.error('写入数据库连接失败', { code: (err as { code?: unknown }).code })
      await stopService(svc)
      throw new ActivationError(`无法写入 ${file}，没有接入`)
    }
    switchTo(svc, 'file', url, accountsCount)
    log(`已接入数据库，连接保存在 ${file}`)
    return 'switched'
  }

  const report = (problem: string) => {
    if (problem === lastProblem) return
    lastProblem = problem
    const from = status.source ? DATABASE_SOURCE_NAMES[status.source] : '配置'
    console.error(`数据库暂时不可用（来自${from}）：${problem}；自动重试中`)
  }

  const scheduleRetry = () => {
    if (stopped) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void retry().catch((err: unknown) => {
        logInternalError('重试连接数据库出错', err)
        scheduleRetry()
      })
    }, retryMs)
    retryTimer.unref()
    retryMs = Math.min(retryMs * 2, maxRetryMs)
  }

  async function attempt(url: string, source: DatabaseSource): Promise<boolean> {
    const check = await probeDatabase(url, config.migrationsFolder)
    if (!check.ready) {
      if (isFatal(check)) {
        throw new FatalStartupError(
          `数据库来自${DATABASE_SOURCE_NAMES[source]}，无法使用：${checkProblem(check)}`,
        )
      }
      status = { state: 'unavailable', source, url, check }
      report(checkProblem(check))
      return false
    }
    let svc: Service
    try {
      svc = await start(config, url, { setup: host })
    } catch (err) {
      if (!(err instanceof StartupError)) throw err
      logInternalError(`启动失败（${err.step}）`, err.cause)
      const kind = transientFailure(err.cause)
      if (!kind) throw new FatalStartupError(startupText(err))
      status = { state: 'unavailable', source, url, check: failedCheck(kind) }
      report(DATABASE_FAILURE_NAMES[kind])
      return false
    }
    let accountsCount: number
    try {
      accountsCount = await svc.accounts()
    } catch (err) {
      logInternalError('读取账号数失败', err)
      await stopService(svc)
      const kind = transientFailure(err) ?? 'unknown'
      status = { state: 'unavailable', source, url, check: failedCheck(kind) }
      report(`读取账号数失败：${DATABASE_FAILURE_NAMES[kind]}`)
      return false
    }
    if (stopped) {
      await stopService(svc)
      return false
    }
    switchTo(svc, source, url, accountsCount)
    return true
  }

  async function retry(): Promise<void> {
    if (stopped || status.state !== 'unavailable' || !status.url || !status.source) return
    try {
      if (await track(attempt(status.url, status.source))) {
        log('已接上数据库')
        return
      }
    } catch (err) {
      if (err instanceof FatalStartupError) return onFatal(err.message)
      throw err
    }
    scheduleRetry()
  }

  if (!config.database) {
    log(`没有配置数据库（DATABASE_URL 或 ${join(config.dataDir, DATA_FILE)}），只提供初始化页`)
    announce()
  } else if (!(await attempt(config.database.url, config.database.source))) {
    scheduleRetry()
  }

  return {
    fetch: (request, ...rest) => (service ? service.app : setupApp).fetch(request, ...rest),
    state: () => status.state,
    gate,
    stop: async (drained = Promise.resolve()) => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      await Promise.allSettled([...inflight])
      const svc = service
      await Promise.all([svc?.jobs.stop(), drained])
      await svc?.database.close()
    },
  }
}

async function stopService(svc: Service): Promise<void> {
  await svc.jobs.stop().catch(() => {})
  await svc.database.close().catch(() => {})
}
