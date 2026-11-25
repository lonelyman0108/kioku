import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  ApiError,
  NetworkError,
  attachmentName,
  download,
  readFailure,
  request,
  retryable,
} from '../client'
import { api } from '../endpoints'

afterEach(() => vi.unstubAllGlobals())

describe('读取失败的文字', () => {
  it('服务端给了说明就用它；没有时用兜底的说法，不漏内部信息', () => {
    expect(readFailure(new ApiError(500, '服务端出错了'))).toBe('服务端出错了')
    expect(readFailure(new TypeError('Failed to fetch http://127.0.0.1'))).toBe('读取失败')
    expect(readFailure(new TypeError('Failed to fetch'), '读取预设失败')).toBe('读取预设失败')
    // 有服务端的说明时兜底的说法不用
    expect(readFailure(new ApiError(404, '预设不存在'), '读取预设失败')).toBe('预设不存在')
  })
})

describe('值不值得再读一次', () => {
  it('只认服务端暂时的失败、连不上、超时或取消', () => {
    expect(retryable(new NetworkError(new TypeError('Failed to fetch')))).toBe(true)
    expect(retryable(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(retryable(new DOMException('timed out', 'TimeoutError'))).toBe(true)
    for (const status of [500, 502, 503, 408, 429]) {
      expect(retryable(new ApiError(status, '…')), String(status)).toBe(true)
    }
  })

  it('确定的结果、契约对不上、程序自己的错误再读也一样', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(retryable(new ApiError(status, '…')), String(status)).toBe(false)
    }
    const parsed = z.object({ ok: z.boolean() }).safeParse({ ok: 'yes' })
    expect(parsed.success).toBe(false)
    expect(retryable(parsed.error)).toBe(false)
    expect(retryable(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(
      false,
    )
    expect(retryable('出错了')).toBe(false)
  })

  it('fetch 本身 reject 时包成 NetworkError，原来的错误放在 cause 里', async () => {
    const offline = new TypeError('Failed to fetch')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw offline
      }),
    )
    const failure = await request('GET', '/x').catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(NetworkError)
    expect((failure as NetworkError).cause).toBe(offline)
    expect(retryable(failure)).toBe(true)
    expect(readFailure(failure)).toBe('读取失败')
  })

  it('请求体序列化不了是程序的问题，不算网络错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    )
    const failure = await request('POST', '/x', { body: { n: 1n } }).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(TypeError)
    expect(retryable(failure)).toBe(false)
  })

  it('响应解析不过时 request 抛的就是这种错误：不会被当成可以再读', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: 'yes' })),
    )
    const failure = await request('GET', '/x', { schema: z.object({ ok: z.boolean() }) }).catch(
      (err: unknown) => err,
    )
    expect(retryable(failure)).toBe(false)
  })
})

describe('API 客户端', () => {
  it('带上查询参数与 JSON 请求体，按 schema 校验响应', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await request('POST', '/x', {
      query: { q: 'a b', skip: undefined },
      body: { a: 1 },
      schema: z.object({ ok: z.boolean() }),
    })
    expect(result).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/v1/x?q=a+b')
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

  it('模型连接测试接口按契约校验响应', async () => {
    const res = { ok: true, latencyMs: 42, dimensions: 1024 }
    const fetchMock = vi.fn(async () => Response.json(res))
    vi.stubGlobal('fetch', fetchMock)
    const body = {
      kind: 'embedding' as const,
      baseUrl: 'https://api.example.com/v1',
      model: 'text-embedding-3-small',
      useSavedKey: false,
    }
    expect(await api.testModel(body)).toEqual(res)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/v1/console/settings/models/test')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(body)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: 'not-a-bool' })),
    )
    await expect(api.testModel(body)).rejects.toThrow()
  })

  it('错误响应转成带状态码和提示的 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: '词条不存在' }, { status: 404 })),
    )
    await expect(request('GET', '/x')).rejects.toEqual(
      new ApiError(404, '词条不存在', { error: '词条不存在' }),
    )
  })

  it('错误体原样带在 payload 里：词条写入被拒时另带疑似明文的位置', async () => {
    const body = { error: '正文第 2 行疑似明文', plaintext: [{ line: 2, kind: 'label' }] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body, { status: 400 })),
    )
    const err = await request('POST', '/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).payload).toEqual(body)
  })

  it('错误体不是 JSON 时 payload 为 null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 502 })),
    )
    const err = (await request('GET', '/x').catch((e: unknown) => e)) as ApiError
    expect([err.status, err.payload]).toEqual([502, null])
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
    await request('POST', '/circles/import', { body: form })
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
              'content-disposition': `attachment; filename="kioku-circle.kioku-circle"; filename*=UTF-8''${encodeURIComponent('家-20261029T120000Z.kioku-circle')}`,
            },
          }),
      ),
    )
    const { blob, filename } = await download('POST', '/circles/c/export', { passphrase: 'p' })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(filename).toBe('家-20261029T120000Z.kioku-circle')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: '仅记忆圈所有者可导出记忆圈' }, { status: 403 })),
    )
    await expect(download('POST', '/circles/c/export')).rejects.toEqual(
      new ApiError(403, '仅记忆圈所有者可导出记忆圈', { error: '仅记忆圈所有者可导出记忆圈' }),
    )
  })

  it('文件名优先取 filename*，编码不对时退回 filename', () => {
    expect(attachmentName(null)).toBeNull()
    expect(attachmentName('attachment; filename="a.kioku-circle"')).toBe('a.kioku-circle')
    expect(attachmentName(`attachment; filename="a"; filename*=UTF-8''%E5%AE%B6`)).toBe('家')
    expect(attachmentName(`attachment; filename="a"; filename*=UTF-8''%E5%AE`)).toBe('a')
  })
})
