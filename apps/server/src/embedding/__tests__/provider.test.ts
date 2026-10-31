import { inspect } from 'node:util'

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

  it('上游把 Key 写进报错时换掉，先换再截断，Key 跨在截断处也不留半截', async () => {
    const embed = (text: string, apiKey = 'sk-secret') =>
      openAiEmbedder(
        { baseUrl: 'https://e.example.com/v1', model: 'm', apiKey },
        (async () => new Response(text, { status: 401 })) as unknown as typeof fetch,
      ).embed(['a'])
    await expect(embed('无效的 Key：sk-secret！')).rejects.toThrow(
      '嵌入接口返回 HTTP 401：无效的 Key：***！',
    )
    // 保存的带着结尾的换行，上游见到的是 fetch 去掉之后的
    await expect(embed('无效的 Key：sk-secret！', 'sk-secret\n')).rejects.toThrow(
      '嵌入接口返回 HTTP 401：无效的 Key：***！',
    )
    const cut = (await embed(`${'x'.repeat(295)}sk-secret${'y'.repeat(100)}`).catch(
      (e: unknown) => e,
    )) as Error
    expect(cut.message).toContain('x'.repeat(295))
    expect(cut.message).not.toContain('sk-')
  })

  it('200 但不是 JSON、响应开头就是 Key：报固定文字，错误和 cause 里都没有响应的内容', async () => {
    const embedder = openAiEmbedder(
      { baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: 'sk-secret' },
      (async () => new Response('sk-secret 无效')) as unknown as typeof fetch,
    )
    const err = (await embedder.embed(['a']).catch((e: unknown) => e)) as Error
    expect(err.message).toBe('嵌入接口的响应不是合法的 JSON')
    expect(inspect(err, { depth: null })).not.toContain('sk-')
  })

  describe('fetch 报的错', () => {
    const pasted = openAiEmbedder({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'm',
      apiKey: 'sk-pasted\nwith-newline',
    })
    const expectNoKey = (err: unknown) => {
      const text = inspect(err, { depth: null })
      expect(text).not.toContain('sk-pasted')
      expect(text).not.toContain('with-newline')
    }

    it('Key 中间有换行：真实的 fetch 把整个请求头写进错误，这里报连不上，错误和 cause 里都没有 Key', async () => {
      const err = (await pasted.embed(['a']).catch((e: unknown) => e)) as Error
      expect(err.message).toContain('无法连接嵌入接口')
      expectNoKey(err)
    })

    it('请求已经取消时，真实的 fetch 还是先报请求头不合法：同样不带 Key', async () => {
      const deadline = new AbortController()
      deadline.abort()
      const err = await pasted.embed(['a'], { signal: deadline.signal }).catch((e: unknown) => e)
      expect((err as Error).message).toBe('已达调用方的总时限，或服务正在停止')
      expectNoKey(err)
    })

    it('连不上时带错误类别，不带错误原文', async () => {
      const embedder = openAiEmbedder(
        { baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: 'sk-secret' },
        (async () => {
          throw Object.assign(new TypeError('fetch failed sk-secret'), {
            cause: Object.assign(new Error('connect sk-secret'), { code: 'ECONNREFUSED' }),
          })
        }) as unknown as typeof fetch,
      )
      await expect(embedder.embed(['a'])).rejects.toThrow(
        '无法连接嵌入接口（ECONNREFUSED）：请检查实例设置中的接口地址与 Key',
      )
    })

    it('到了这个接口的时限：说清等了多久', async () => {
      const embedder = openAiEmbedder(
        { baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: null },
        (async (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error))
          })) as unknown as typeof fetch,
      )
      await expect(embedder.embed(['a'], { timeoutMs: 20 })).rejects.toThrow(
        '嵌入接口 1 秒内未返回',
      )
    })
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
      '等待时间已用完',
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
      /所有渠道均失败。渠道 1：嵌入接口返回 HTTP 401.*；渠道 2：无法连接嵌入接口/,
    )
  })
})
