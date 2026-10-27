import { serve } from '@hono/node-server'

import { createApp } from './app'
import { loadConfig } from './config'
import { assertRuntimeRole, connect } from './db/client'
import { runMigrations } from './db/migrate'
import { settingsEmbedderSource } from './embedding/source'
import { startJobs } from './jobs/queue'

const config = loadConfig()
const database = connect(config.databaseUrl)
await assertRuntimeRole(database.db)
await runMigrations(database, config.migrationsFolder)

const embedder = settingsEmbedderSource(database.db, config.masterKey)
const jobs = await startJobs({
  connectionString: config.databaseUrl,
  db: database.db,
  embedder: () => embedder.get(),
})
// 启动时补齐一次：处理上次停机期间没来得及生成的向量
void jobs.enqueueBackfill()

const app = createApp({
  db: database.db,
  cookieSecure: config.cookieSecure,
  masterKey: config.masterKey,
  embedder,
  trustedProxies: config.trustedProxies,
  webDir: config.webDir,
  jobs,
})

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Kioku 已启动：http://localhost:${info.port}`)
})

// 收到停止信号时先停止接收请求，再等后台任务收尾
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close()
    void jobs.stop().finally(() => database.close().finally(() => process.exit(0)))
  })
}
