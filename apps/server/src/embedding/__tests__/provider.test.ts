import { describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS } from '../../db/schema'
import { channelEmbedder, openAiEmbedder } from '../provider'

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
  // 按地址的主机名决定这个渠道怎么回答
  const behaviors: Record<string, () => Response | Promise<Response>> = {
    ok: () => Response.json({ data: [{ index: 0, embedding: vector() }] }),
    auth: () => new Response('bad key', { status: 401 }),
    busy: () => new Response('slow down', { status: 429 }),
    toolarge: () => new Response('input too long', { status: 413 }),
    narrow: () => Response.json({ data: [{ index: 0, embedding: vector(768) }] }),
    offline: () => Promise.reject(new TypeError('fetch failed')),
  }
  const run = async (hosts: string[]) => {
    const asked: string[] = []
    const fetchImpl = (async (url: string) => {
      const host = new URL(url).hostname
      asked.push(host)
      return behaviors[host]!()
    }) as unknown as typeof fetch
    const embedder = channelEmbedder(
      'logical',
      hosts.map((h) => ({ baseUrl: `https://${h}/v1`, model: 'remote', apiKey: null })),
      fetchImpl,
    )
    return { embedder, asked }
  }

  it('鉴权失败、限流、维度不对、连不上都换下一个', async () => {
    const { embedder, asked } = await run(['auth', 'busy', 'narrow', 'offline', 'ok'])
    expect(embedder.model).toBe('logical')
    expect(await embedder.embed(['a'])).toHaveLength(1)
    expect(asked).toEqual(['auth', 'busy', 'narrow', 'offline', 'ok'])
  })

  it('请求本身有问题时不换渠道', async () => {
    const { embedder, asked } = await run(['toolarge', 'ok'])
    await expect(embedder.embed(['a'])).rejects.toThrow('HTTP 413')
    expect(asked).toEqual(['toolarge'])
  })

  it('都失败时把各个渠道的错误一起报出来', async () => {
    const { embedder } = await run(['auth', 'offline'])
    await expect(embedder.embed(['a'])).rejects.toThrow(
      /所有渠道都失败了。渠道 1：嵌入接口返回 HTTP 401.*；渠道 2：fetch failed/,
    )
  })
})
