import { serve } from '@hono/node-server'

import { createApp } from './app'
import { loadConfig } from './config'
import { assertRuntimeRole, connect } from './db/client'
import { runMigrations } from './db/migrate'

const config = loadConfig()
const database = connect(config.databaseUrl)
await assertRuntimeRole(database.db)
await runMigrations(database.db, config.migrationsFolder)

serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  console.log(`Kioku 已启动：http://localhost:${info.port}`)
})
