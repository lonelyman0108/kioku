import { join } from 'node:path'

import {
  DATABASE_FAILURE_NAMES,
  DATABASE_SOURCE_NAMES,
  EXISTING_DATA_NAMES,
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
import { probeDatabase } from './db/probe'
import type { SetupHost } from './http/env'
import { settleRecallEvents } from './recall/events'
import { startService, startupText, StartupError, type Service } from './service'
import { ActivationError, SetupBusyError } from './setupErrors'

// 服务的运行状态：接没接上数据库，请求交给哪个应用。
// - 没有配置数据库：只提供初始化（createSetupApp），在初始化页填库、当场接上之后换成完整的服务；
// - 配了却连不上或检查没过：同样只提供初始化（只能看、不能改），定时重试，接上之后换成完整的服务；
// - 接上了：完整的服务（startService），冷启动与初始化后接上走的是同一个函数。
// 还没有任何账号时打开初始化码并打印到日志，有了账号就作废

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
  // 配了的库连不上时隔多久重试，默认 15 秒；测试里调小
  retryMs?: number
  log?: (line: string) => void
}

interface DatabaseStatus {
  state: DatabaseState
  source: DatabaseSource | null
  url: string | null
  check: DatabaseCheck | null
}

// 检查没过的原因，写进日志的一句
function checkProblem(check: DatabaseCheck): string {
  if (check.failure) return DATABASE_FAILURE_NAMES[check.failure]
  if (check.role?.superuser) return `角色 ${check.role.name} 是超级用户，会绕过行级安全`
  if (check.role?.bypassRls) return `角色 ${check.role.name} 带 BYPASSRLS，会绕过行级安全`
  const missing = check.extensions.filter((e) => e.state !== 'installed').map((e) => e.name)
  if (missing.length) return `缺少扩展 ${missing.join('、')}`
  if (check.existing && check.existing !== 'empty' && check.existing !== 'kioku') {
    return `库里是${EXISTING_DATA_NAMES[check.existing]}`
  }
  return '检查未通过'
}

export async function startRuntime(config: Config, options: RuntimeOptions = {}): Promise<Runtime> {
  const log = options.log ?? ((line: string) => console.log(line))
  const vault = options.vault ?? createVaultClient()
  const retryMs = options.retryMs ?? 15_000
  const gate = new SetupGate(config.setupCode)
  let service: Service | null = null
  let status: DatabaseStatus = config.database
    ? { state: 'unavailable', ...config.database, check: null }
    : { state: 'missing', source: null, url: null, check: null }
  let busy = false
  let retryTimer: NodeJS.Timeout | null = null
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

  // 接上之后：有账号就作废初始化码，没有就打开
  const ready = async (svc: Service, source: DatabaseSource, url: string) => {
    service = svc
    status = { state: 'ready', source, url, check: null }
    if ((await svc.accounts()) === 0) announce()
    else gate.close()
  }

  // 初始化页填的库：先确认数据目录写得进去，再起服务，起来之后写 kioku.json，最后换上完整的服务。
  // 任何一步失败都回到接入之前：服务关掉，文件没写
  async function activate(url: string): Promise<void> {
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
      svc = await startService(config, url, { setup: host, vault })
    } catch (err) {
      if (!(err instanceof StartupError)) throw err
      logInternalError(`接入数据库失败（${err.step}）`, err.cause)
      throw new ActivationError(startupText(err))
    }
    try {
      await writeDataFile(config.dataDir, { databaseUrl: url })
    } catch (err) {
      console.error('写入数据库连接失败', { code: (err as { code?: unknown }).code })
      await stopService(svc)
      throw new ActivationError(`无法写入 ${file}，没有接入`)
    }
    log(`已接入数据库，连接保存在 ${file}`)
    await ready(svc, 'file', url)
  }

  // 配了的库连不上：隔一会儿再试，接上之后换成完整的服务。原因变了才写一次日志
  const scheduleRetry = () => {
    if (stopped) return
    retryTimer = setTimeout(() => void retry(), retryMs)
    retryTimer.unref()
  }
  const report = (problem: string) => {
    if (problem === lastProblem) return
    lastProblem = problem
    const from = status.source ? DATABASE_SOURCE_NAMES[status.source] : '配置'
    console.error(`数据库不可用（来自${from}）：${problem}；每 ${retryMs / 1000} 秒重试一次`)
  }
  async function retry(): Promise<void> {
    retryTimer = null
    if (stopped || status.state !== 'unavailable' || !status.url) return
    const { url, source } = status
    const check = await probeDatabase(url, config.migrationsFolder)
    if (!check.ready) {
      status = { ...status, check }
      report(checkProblem(check))
      return scheduleRetry()
    }
    try {
      const svc = await startService(config, url, { setup: host, vault })
      if (stopped) return await stopService(svc)
      log('已接上数据库')
      await ready(svc, source!, url)
    } catch (err) {
      if (!(err instanceof StartupError)) throw err
      logInternalError(`启动失败（${err.step}）`, err.cause)
      report(startupText(err))
      scheduleRetry()
    }
  }

  if (!config.database) {
    log(`没有配置数据库（DATABASE_URL 或 ${join(config.dataDir, DATA_FILE)}），只提供初始化页`)
    announce()
  } else {
    const { url, source } = config.database
    const check = await probeDatabase(url, config.migrationsFolder)
    if (check.ready) {
      // 冷启动时检查过了还起不来（主密钥对不上这类）照旧拒绝启动，由调用方退出
      await ready(await startService(config, url, { setup: host, vault }), source, url)
    } else {
      status = { state: 'unavailable', source, url, check }
      report(checkProblem(check))
      announce()
      scheduleRetry()
    }
  }

  return {
    fetch: (request, ...rest) => (service ? service.app : setupApp).fetch(request, ...rest),
    state: () => status.state,
    gate,
    stop: async (drained = Promise.resolve()) => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
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
