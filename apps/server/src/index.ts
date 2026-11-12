import { serve } from '@hono/node-server'

import { loadConfig } from './config'
import { logInternalError } from './db/client'
import { FatalStartupError, startRuntime } from './runtime'

const config = loadConfig()
// 不会自己好的问题（角色绕过行级安全、库的结构用不了、主密钥对不上等）拒绝启动；别的意外也退出，日志不带错误原文
const runtime = await startRuntime(config).catch((err: unknown) => {
  if (err instanceof FatalStartupError) console.error(`拒绝启动：${err.message}`)
  else logInternalError('启动失败', err)
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
