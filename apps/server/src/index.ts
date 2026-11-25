import { serve } from '@hono/node-server'

import { loadConfig } from './config'
import { logInternalError } from './db/client'
import { FatalStartupError, startRuntime } from './runtime'

const config = loadConfig()
const runtime = await startRuntime(config).catch((err: unknown) => {
  if (err instanceof FatalStartupError) console.error(`拒绝启动：${err.message}`)
  else logInternalError('启动失败', err)
  process.exit(1)
})

const server = serve({ fetch: runtime.fetch, port: config.port }, (info) => {
  console.log(`Kioku 已启动：http://localhost:${info.port}`)
})

const SHUTDOWN_GRACE_MS = 10_000

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const drained = Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
    ])
    void runtime.stop(drained).finally(() => process.exit(0))
  })
}
