import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ApiError, request } from '../client'

afterEach(() => vi.unstubAllGlobals())

describe('API 客户端', () => {
  it('带上查询参数与 JSON 请求体，按 schema 校验响应', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await request('POST', '/x', {
      query: { uri: 'core://a b', skip: undefined },
      body: { a: 1 },
      schema: z.object({ ok: z.boolean() }),
    })
    expect(result).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/v1/x?uri=core%3A%2F%2Fa+b')
    expect(init.body).toBe('{"a":1}')
  })

  it('错误响应转成带状态码和提示的 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: '记忆不存在' }, { status: 404 })),
    )
    await expect(request('GET', '/x')).rejects.toEqual(new ApiError(404, '记忆不存在'))
  })

  it('响应不符合契约时直接报错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: 'yes' })),
    )
    await expect(request('GET', '/x', { schema: z.object({ ok: z.boolean() }) })).rejects.toThrow()
  })
})
