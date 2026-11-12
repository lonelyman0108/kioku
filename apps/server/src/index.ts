import { serve } from '@hono/node-server'

import { loadConfig } from './config'
import { logInternalError } from './db/client'
import { startRuntime } from './runtime'
import { StartupError, startupText } from './service'

const config = loadConfig()
const runtime = await startRuntime(config).catch((err: unknown) => {
  // 配了数据库、检查也通过了却起不来（例如主密钥对不上）：和以前一样拒绝启动
  if (!(err instanceof StartupError)) throw err
  logInternalError(`启动失败（${err.step}）`, err.cause)
  console.error(startupText(err))
  process.exit(1)
})

const server = serve({ fetch: runtime.fetch, port: config.port }, (info) => {
  console.log(`Kioku 已启动：http://localhost:${info.port}`)
})

// 停止时最多等正在处理的请求这么久
const SHUTDOWN_GRACE_MS = 10_000

// 收到停止信号时先停止接收请求，再等后台任务收尾
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // 后台任务立刻停；正在处理的请求最多再等一会儿（它们还会记召回事件），再等事件写完，最后关库
    const drained = Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
    ])
    void runtime.stop(drained).finally(() => process.exit(0))
  })
}
