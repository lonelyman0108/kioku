import { serve } from '@hono/node-server'

import { createApp } from './app'

const port = Number(process.env.PORT ?? 18920)

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`Kioku 已启动：http://localhost:${info.port}`)
})
