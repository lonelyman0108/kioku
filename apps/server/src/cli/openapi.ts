// 把 OpenAPI 文档写到标准输出，给 sdks/python 生成客户端用。生成文档用不到数据库，不连库
import { createApp } from '../app'
import type { Db } from '../db/client'
import { staticEmbedderSource } from '../embedding/source'

const app = createApp({
  db: {} as Db,
  cookieSecure: false,
  masterKey: null,
  embedder: staticEmbedderSource(null),
  jobs: null,
})
const res = await app.request('/v1/openapi.json')
if (!res.ok) {
  console.error(`生成 OpenAPI 文档失败：HTTP ${res.status} ${await res.text()}`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify(await res.json(), null, 2)}\n`)
