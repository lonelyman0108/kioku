import { HealthResponse } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app'
import { staticEmbedderSource } from '../embedding/source'
import type { Db } from '../db/client'

// health 与 OpenAPI 文档不访问数据库
const app = createApp({
  db: {} as Db,
  cookieSecure: true,
  masterKey: null,
  embedder: staticEmbedderSource(null),
  jobs: null,
})

describe('GET /v1/health', () => {
  it('返回 ok 与版本号', async () => {
    const res = await app.request('/v1/health')
    expect(res.status).toBe(200)
    expect(HealthResponse.parse(await res.json()).status).toBe('ok')
  })

  it('OpenAPI 文档包含 health 路由', async () => {
    const res = await app.request('/v1/openapi.json')
    const doc = (await res.json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toContain('/v1/health')
  })

  it('测试台的接口都归在 bench 下：不进 Python SDK，也不和管理界面的别的接口混在一起', async () => {
    const res = await app.request('/v1/openapi.json')
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { tags?: string[] }>>
    }
    const bench = Object.entries(doc.paths).filter(([path]) => path.includes('/bench/'))
    const tags = bench.flatMap(([, operations]) => Object.values(operations).map((o) => o.tags))
    expect(tags).toHaveLength(5)
    for (const tag of tags) expect(tag).toEqual(['bench'])
  })
})
