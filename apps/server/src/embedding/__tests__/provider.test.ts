import { describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS } from '../../db/schema'
import { openAiEmbedder } from '../provider'

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
