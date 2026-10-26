import { describe, expect, it } from 'vitest'

import { router } from '../openapi'

describe('路由', () => {
  it('顶层应用匹配路由前把连续的斜杠合并成一个', async () => {
    const app = router({ collapseSlashes: true })
    app.get('/v1/mcp', (c) => c.text('ok'))
    expect((await app.request('//v1/mcp')).status).toBe(200)
    expect((await app.request('/v1//mcp')).status).toBe(200)
    expect(
      (
        await router()
          .get('/v1/mcp', (c) => c.text('ok'))
          .request('//v1/mcp')
      ).status,
    ).toBe(404)
  })
})
