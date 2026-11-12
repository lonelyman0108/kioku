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
import { createVaultClient } from './credential/bitwarden/client'
import type { VaultClient } from './credential/bitwarden/types'
import { assertWritable, DATA_FILE, writeDataFile } from './dataDir'
import { logInternalError } from './db/client'
import { failedCheck, isFatal, probeDatabase, transientFailure } from './db/probe'
import type { SetupHost } from './http/env'
import { settleRecallEvents } from './recall/events'
import { startService, startupText, StartupError, type Service } from './service'
import { ActivationError, SetupBusyError } from './setupErrors'

// 服务的运行状态：接没接上数据库，请求交给哪个应用。
// - missing：没有配置数据库，只提供初始化（createSetupApp），在初始化页填库、当场接上之后换成完整的服务；
// - unavailable：配了却暂时连不上（连不上、超时、认证失败、库不存在这类可能自己好的问题），同样只挂
//   createSetupApp，但不当作要初始化、不开初始化码，健康检查回 503；按退避重试，接上之后换成完整的服务；
// - ready：完整的服务（startService），冷启动、重试接上与初始化页接入走的是同一个函数。
// 角色绕过行级安全、缺扩展、库的结构用不了、主密钥对不上这类不会自己好的问题，照旧拒绝启动（FatalStartupError）。
// 初始化码只在 missing、或者接上之后确认没有任何账号时打开并打印，有了账号就作废

type Fetch = (request: Request, ...rest: unknown[]) => Response | Promise<Response>

export interface Runtime {
  fetch: Fetch
  state: () => DatabaseState
  gate: SetupGate
  // 停止：后台任务立刻停；drained 是正在处理的请求收尾（最多等一会儿），之后等召回事件写完，最后关库
  stop: (drained?: Promise<void>) => Promise<void>
}

export interface RuntimeOptions {
  vault?: VaultClient
  // 暂时连不上时第一次隔多久重试，之后每次翻倍、最多 maxRetryMs。默认 5 秒与 60 秒；测试里调小
  retryMs?: number
  maxRetryMs?: number
  log?: (line: string) => void
  // 重试时遇到不会自己好的问题：默认打印原因后退出进程，和冷启动时拒绝启动一样。测试里接住
  onFatal?: (message: string) => void
  // 起完整服务的函数，默认 startService；测试里换成会在某一步失败的
  start?: typeof startService
}

// 不会自己好的问题：冷启动时由调用方打印并退出进程
export class FatalStartupError extends Error {}

interface DatabaseStatus {
  state: DatabaseState
  source: DatabaseSource | null
  url: string | null
  check: DatabaseCheck | null
}

// 检查没过的原因，写进日志的一句，和初始化页同一份原因码
function checkProblem(check: DatabaseCheck): string {
  return check.problems.map((p) => databaseProblemText(p, check.failure)).join('；')
}

export async function startRuntime(config: Config, options: RuntimeOptions = {}): Promise<Runtime> {
  const log = options.log ?? ((line: string) => console.log(line))
  const vault = options.vault ?? createVaultClient()
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

  // 需要初始化：打开初始化码，第一次打开时打印（醒目一行，部署的人从日志里取）
  const announce = () => {
    const opened = gate.isOpen
    const code = gate.open()
    if (opened) return
    const source = config.setupCode ? '（来自 KIOKU_SETUP_CODE）' : ''
    log('')
    log(`==================== Kioku 初始化码：${code} ${source}====================`)
    log('打开管理界面，在初始化页填写这个码；建好第一个管理员之后作废')
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

  // 切换：只有同步的赋值与开关初始化码，不会失败。要查的（账号数）都在切换之前查完
  const switchTo = (svc: Service, source: DatabaseSource, url: string, accounts: number) => {
    service = svc
    status = { state: 'ready', source, url, check: null }
    if (accounts === 0) announce()
    else gate.close()
  }

  // 初始化页填的库。准备阶段：确认数据目录写得进去、起服务、数账号、写 kioku.json，任何一步失败都关掉已经起来的、
  // 不写文件、状态不变，抛 ActivationError；准备完才切换
  // 进行中的接入与重试：stop() 等它们结束，不留下停止之后才起来的服务
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
      svc = await start(config, url, { setup: host, vault })
    } catch (err) {
      if (err instanceof StartupError) {
        logInternalError(`接入数据库失败（${err.step}）`, err.cause)
        throw new ActivationError(startupText(err))
      }
      logInternalError('接入数据库失败', err)
      throw new ActivationError('接入失败，原因见服务日志')
    }
    let accounts: number
    try {
      accounts = await svc.accounts()
    } catch (err) {
      logInternalError('读取账号数失败', err)
      await stopService(svc)
      throw new ActivationError('无法完成接入：读取账号数失败，没有接入')
    }
    // 起服务期间收到了停止：关掉刚起的服务，不写文件、不切换（回滚代建的库也安全）
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
    // 写完文件到切换之间没有 await：stop() 插不进来，切换只有同步的赋值
    switchTo(svc, 'file', url, accounts)
    log(`已接入数据库，连接保存在 ${file}`)
    return 'switched'
  }

  const report = (problem: string) => {
    if (problem === lastProblem) return
    lastProblem = problem
    const from = status.source ? DATABASE_SOURCE_NAMES[status.source] : '配置'
    console.error(`数据库暂时不可用（来自${from}）：${problem}；自动重试中`)
  }

  // 暂时连不上：按退避重试（5 秒起，每次翻倍，最多 60 秒）
  const scheduleRetry = () => {
    if (stopped) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void retry().catch((err: unknown) => {
        // 任何意外都接住，记下来接着重试：定时器里的 rejection 没人处理会让进程崩溃
        logInternalError('重试连接数据库出错', err)
        scheduleRetry()
      })
    }, retryMs)
    retryTimer.unref()
    retryMs = Math.min(retryMs * 2, maxRetryMs)
  }

  // 起一次服务（冷启动与重试共用）：检查过了再起；不会自己好的问题抛 FatalStartupError，
  // 暂时的问题返回 null（状态记成 unavailable），起来了就切换
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
      svc = await start(config, url, { setup: host, vault })
    } catch (err) {
      if (!(err instanceof StartupError)) throw err
      logInternalError(`启动失败（${err.step}）`, err.cause)
      // 不管哪一步，原因是连接出了问题（断开、超时、库重启）就是暂时的，接着重试；
      // 别的（角色、迁移对不上、主密钥）才拒绝启动
      const kind = transientFailure(err.cause)
      if (!kind) throw new FatalStartupError(startupText(err))
      status = { state: 'unavailable', source, url, check: failedCheck(kind) }
      report(DATABASE_FAILURE_NAMES[kind])
      return false
    }
    let accounts: number
    try {
      accounts = await svc.accounts()
    } catch (err) {
      logInternalError('读取账号数失败', err)
      await stopService(svc)
      // 不可用页显示的原因跟着更新，不留「未知」
      const kind = transientFailure(err) ?? 'unknown'
      status = { state: 'unavailable', source, url, check: failedCheck(kind) }
      report(`读取账号数失败：${DATABASE_FAILURE_NAMES[kind]}`)
      return false
    }
    if (stopped) {
      await stopService(svc)
      return false
    }
    switchTo(svc, source, url, accounts)
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
    // 暂时连不上：不开初始化码（不知道有没有账号），等重试接上之后再看
    scheduleRetry()
  }

  return {
    fetch: (request, ...rest) => (service ? service.app : setupApp).fetch(request, ...rest),
    state: () => status.state,
    gate,
    stop: async (drained = Promise.resolve()) => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      // 等进行中的接入与重试结束：它们看到 stopped 会关掉自己刚起的服务
      await Promise.allSettled([...inflight])
      const svc = service
      await Promise.all([svc?.jobs.stop(), drained.then(settleRecallEvents)])
      await svc?.database.close()
    },
  }
}

async function stopService(svc: Service): Promise<void> {
  await svc.jobs.stop().catch(() => {})
  await svc.database.close().catch(() => {})
}
