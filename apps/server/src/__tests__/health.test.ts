import { HealthResponse } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app'

describe('GET /v1/health', () => {
  it('返回 ok 与版本号', async () => {
    const res = await createApp().request('/v1/health')
    expect(res.status).toBe(200)
    expect(HealthResponse.parse(await res.json()).status).toBe('ok')
  })

  it('OpenAPI 文档包含 health 路由', async () => {
    const res = await createApp().request('/v1/openapi.json')
    const doc = (await res.json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toContain('/v1/health')
  })
})
