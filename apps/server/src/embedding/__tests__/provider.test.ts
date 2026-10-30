import { describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS } from '../../db/schema'
import { channelEmbedder, EmbedRejected, openAiEmbedder } from '../provider'

const vector = (n = EMBEDDING_DIMENSIONS) => new Array(n).fill(0.1)

describe('OpenAI 兼容嵌入客户端', () => {
  it('请求带模型、维度与 Key，结果按 index 排序', async () => {
    let request: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      request = { url, init }
      return Response.json({
        data: [
          { index: 1, embedding: vector().map(() => 0.2) },
          { index: 0, embedding: vector() },
        ],
      })
    }) as unknown as typeof fetch
    const embedder = openAiEmbedder(
      { baseUrl: 'https://e.example.com/v1/', model: 'm', apiKey: 'sk' },
      fetchImpl,
    )
    const out = await embedder.embed(['a', 'b'])
    expect(request!.url).toBe('https://e.example.com/v1/embeddings')
    expect(JSON.parse(String(request!.init.body))).toMatchObject({
      model: 'm',
      input: ['a', 'b'],
      dimensions: EMBEDDING_DIMENSIONS,
    })
    expect((request!.init.headers as Record<string, string>).authorization).toBe('Bearer sk')
    expect(out[0]![0]).toBe(0.1)
    expect(out[1]![0]).toBe(0.2)
  })

  it('维度不对时报错，提示确认 dimensions 参数', async () => {
    const fetchImpl = (async () =>
      Response.json({ data: [{ index: 0, embedding: vector(4096) }] })) as unknown as typeof fetch
    const embedder = openAiEmbedder(
      { baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: null },
      fetchImpl,
    )
    await expect(embedder.embed(['a'])).rejects.toThrow('dimensions')
  })

  it('非 2xx 时带上状态码与响应片段', async () => {
    const fetchImpl = (async () =>
      new Response('quota exceeded', { status: 429 })) as unknown as typeof fetch
    const embedder = openAiEmbedder(
      { baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: null },
      fetchImpl,
    )
    await expect(embedder.embed(['a'])).rejects.toThrow('HTTP 429')
  })
})

describe('一组渠道按顺序回退', () => {
  // 按地址的主机名决定这个渠道怎么回答；hang 一直不回，直到请求被取消
  const behaviors: Record<string, (init: RequestInit) => Response | Promise<Response>> = {
    hang: (init) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(new Error('请求超时'))),
      ),
    ok: () => Response.json({ data: [{ index: 0, embedding: vector() }] }),
    auth: () => new Response('bad key', { status: 401 }),
    busy: () => new Response('slow down', { status: 429 }),
    toolarge: () => new Response('input too long', { status: 413 }),
    narrow: () => Response.json({ data: [{ index: 0, embedding: vector(768) }] }),
    offline: () => Promise.reject(new TypeError('fetch failed')),
  }
  const run = async (hosts: string[]) => {
    const asked: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const host = new URL(url).hostname
      asked.push(host)
      return behaviors[host]!(init)
    }) as unknown as typeof fetch
    const embedder = channelEmbedder(
      'logical',
      hosts.map((h) => ({ baseUrl: `https://${h}/v1`, model: 'remote', apiKey: null })),
      fetchImpl,
    )
    return { embedder, asked }
  }

  it('出什么错都换下一个：鉴权失败、限流、请求被拒、维度不对、连不上', async () => {
    const { embedder, asked } = await run(['auth', 'busy', 'toolarge', 'narrow', 'offline', 'ok'])
    expect(embedder.model).toBe('logical')
    expect(await embedder.embed(['a'])).toHaveLength(1)
    expect(asked).toEqual(['auth', 'busy', 'toolarge', 'narrow', 'offline', 'ok'])
  })

  it('调用方的总时限到了就不再试后面的渠道', async () => {
    const { embedder, asked } = await run(['auth', 'ok'])
    const deadline = new AbortController()
    deadline.abort()
    await expect(embedder.embed(['a'], { signal: deadline.signal })).rejects.toThrow(
      '等待时间用完了',
    )
    expect(asked).toEqual([])
  })

  it('每个渠道有自己的超时：第一个卡住时，总时限内还来得及换第二个', async () => {
    const { embedder, asked } = await run(['hang', 'ok'])
    const out = await embedder.embed(['a'], { signal: AbortSignal.timeout(5_000), timeoutMs: 50 })
    expect(out).toHaveLength(1)
    expect(asked).toEqual(['hang', 'ok'])
  })

  it('都失败时把各个渠道的错误一起报出来', async () => {
    const { embedder } = await run(['auth', 'offline'])
    await expect(embedder.embed(['a'])).rejects.toThrow(
      /所有渠道都失败了。渠道 1：嵌入接口返回 HTTP 401.*；渠道 2：fetch failed/,
    )
  })

  it('每个渠道都拒绝了这些文本才算被拒；有一个是连不上、限流这类的就算接口不可用', async () => {
    const rejected = async (hosts: string[]) => {
      const { embedder } = await run(hosts)
      return embedder.embed(['a']).then(
        () => null,
        (err: unknown) => err instanceof EmbedRejected,
      )
    }
    expect(await rejected(['toolarge'])).toBe(true)
    expect(await rejected(['toolarge', 'toolarge'])).toBe(true)
    expect(await rejected(['toolarge', 'offline'])).toBe(false)
    expect(await rejected(['busy', 'toolarge'])).toBe(false)
    expect(await rejected(['narrow'])).toBe(false)
  })
})

describe('请求被拒与接口不可用', () => {
  const statusOf = (status: number) =>
    openAiEmbedder(
      { baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: null },
      (async () => new Response('x', { status })) as unknown as typeof fetch,
    )
      .embed(['a'])
      .then(
        () => 'ok',
        (err: unknown) => (err instanceof EmbedRejected ? 'rejected' : 'unavailable'),
      )

  it('400、413、422 这类是文本被拒；鉴权、地址不对、超时、限流与 5xx 算接口不可用', async () => {
    for (const status of [400, 413, 422]) expect(await statusOf(status)).toBe('rejected')
    for (const status of [401, 403, 404, 408, 429, 500, 502, 503]) {
      expect(await statusOf(status)).toBe('unavailable')
    }
  })
})
