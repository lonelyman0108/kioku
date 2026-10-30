import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ApiError, attachmentName, download, request } from '../client'

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

  it('signal 传给 fetch：取消时抛的是 AbortError，不是 ApiError', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      init.signal?.throwIfAborted()
      return Response.json({})
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await request('POST', '/x', { body: {}, signal: controller.signal })
    expect(fetchMock.mock.calls[0]![1].signal).toBe(controller.signal)
    controller.abort()
    const err = await request('POST', '/x', { body: {}, signal: controller.signal }).catch(
      (e: unknown) => e,
    )
    expect(err).not.toBeInstanceOf(ApiError)
    expect((err as DOMException).name).toBe('AbortError')
    // 不传时也不影响
    await request('GET', '/x')
    expect(fetchMock.mock.calls.at(-1)![1].signal).toBeUndefined()
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

  it('表单按原样上传，content-type 交给浏览器写（里面有分隔行）', async () => {
    const fetchMock = vi.fn(async () => Response.json({}))
    vi.stubGlobal('fetch', fetchMock)
    const form = new FormData()
    form.set('passphrase', 'x')
    await request('POST', '/spaces/import', { body: form })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBe(form)
    expect(init.headers).toEqual({})
  })

  it('下载：读出文件与服务端给的文件名，出错时照样是 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: {
              'content-disposition': `attachment; filename="kioku-space.kioku-space"; filename*=UTF-8''${encodeURIComponent('家-20261029T120000Z.kioku-space')}`,
            },
          }),
      ),
    )
    const { blob, filename } = await download('POST', '/spaces/s/export', { passphrase: 'p' })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(filename).toBe('家-20261029T120000Z.kioku-space')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: '只有空间 owner 能导出空间' }, { status: 403 })),
    )
    await expect(download('POST', '/spaces/s/export')).rejects.toEqual(
      new ApiError(403, '只有空间 owner 能导出空间'),
    )
  })

  it('文件名优先取 filename*，编码不对时退回 filename', () => {
    expect(attachmentName(null)).toBeNull()
    expect(attachmentName('attachment; filename="a.kioku-space"')).toBe('a.kioku-space')
    expect(attachmentName(`attachment; filename="a"; filename*=UTF-8''%E5%AE%B6`)).toBe('家')
    expect(attachmentName(`attachment; filename="a"; filename*=UTF-8''%E5%AE`)).toBe('a')
  })
})
