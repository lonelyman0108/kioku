import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import { openAiChatModel } from '../provider'

describe('OpenAI 兼容的抽取模型客户端', () => {
  it('请求只带模型与消息，带上 Key；取第一个回答与用量', async () => {
    let request: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      request = { url, init }
      return Response.json({
        choices: [{ message: { content: '{"facts":[]}' } }],
        usage: { prompt_tokens: 120, completion_tokens: 8 },
      })
    }) as unknown as typeof fetch
    const model = openAiChatModel(
      { baseUrl: 'https://llm.example.com/v1/', model: 'example-chat-model', apiKey: 'sk' },
      fetchImpl,
    )
    const out = await model.complete([{ role: 'user', content: '你好' }])
    expect(request!.url).toBe('https://llm.example.com/v1/chat/completions')
    // 推理模型常常不接受 temperature、response_format、max_tokens，一个都不传
    expect(JSON.parse(String(request!.init.body))).toEqual({
      model: 'example-chat-model',
      messages: [{ role: 'user', content: '你好' }],
    })
    expect((request!.init.headers as Record<string, string>).authorization).toBe('Bearer sk')
    expect(out).toEqual({
      content: '{"facts":[]}',
      usage: { promptTokens: 120, completionTokens: 8 },
    })
  })

  it('没有 Key 时不带 authorization；没有用量时记 0，没有正文时是空字符串', async () => {
    let headers: Record<string, string> = {}
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>
      return Response.json({ choices: [{ message: { content: null } }] })
    }) as unknown as typeof fetch
    const model = openAiChatModel(
      { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: null },
      fetchImpl,
    )
    expect(await model.complete([{ role: 'user', content: 'x' }])).toEqual({
      content: '',
      usage: { promptTokens: 0, completionTokens: 0 },
    })
    expect(headers.authorization).toBeUndefined()
  })

  it('正文是分段数组时把文字段拼起来', async () => {
    const model = openAiChatModel(
      { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: null },
      (async () =>
        Response.json({
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: '{"facts":' },
                  { type: 'image_url', image_url: { url: 'https://img.example.com/a.png' } },
                  { type: 'text', text: '[]}' },
                ],
              },
            },
          ],
        })) as unknown as typeof fetch,
    )
    expect((await model.complete([{ role: 'user', content: 'x' }])).content).toBe('{"facts":[]}')
  })

  it('超时给出中文说明', async () => {
    const hanging = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
      })) as unknown as typeof fetch
    const model = openAiChatModel(
      { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: null },
      hanging,
    )
    await expect(
      model.complete([{ role: 'user', content: 'x' }], { timeoutMs: 20 }),
    ).rejects.toThrow('抽取模型 1 秒内没有返回')
  })

  it('非 2xx 时带上状态码与响应片段；没有 choices 时报错', async () => {
    const failing = openAiChatModel(
      { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: null },
      (async () => new Response('quota exceeded', { status: 429 })) as unknown as typeof fetch,
    )
    await expect(failing.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
      'HTTP 429：quota exceeded',
    )
    const empty = openAiChatModel(
      { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: null },
      (async () => Response.json({ choices: [] })) as unknown as typeof fetch,
    )
    await expect(empty.complete([{ role: 'user', content: 'x' }])).rejects.toThrow('choices')
  })

  it('上游把 Key 写进报错时换掉，先换再截断，Key 跨在截断处也不留半截', async () => {
    const complete = (text: string, apiKey = 'sk-secret') =>
      openAiChatModel(
        { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey },
        (async () => new Response(text, { status: 401 })) as unknown as typeof fetch,
      ).complete([{ role: 'user', content: 'x' }])
    await expect(complete('无效的 Key：sk-secret！')).rejects.toThrow(
      '抽取模型返回 HTTP 401：无效的 Key：***！',
    )
    // 保存的带着结尾的换行，上游见到的是 fetch 去掉之后的
    await expect(complete('无效的 Key：sk-secret！', 'sk-secret\n')).rejects.toThrow(
      '抽取模型返回 HTTP 401：无效的 Key：***！',
    )
    const cut = (await complete(`${'x'.repeat(295)}sk-secret${'y'.repeat(100)}`).catch(
      (e: unknown) => e,
    )) as Error
    expect(cut.message).toContain('x'.repeat(295))
    expect(cut.message).not.toContain('sk-')
  })

  it('Key 中间有换行：真实的 fetch 把整个请求头写进错误，这里报连不上，错误和 cause 里都没有 Key', async () => {
    const model = openAiChatModel({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'm',
      apiKey: 'sk-pasted\nwith-newline',
    })
    const err = (await model
      .complete([{ role: 'user', content: 'x' }])
      .catch((e: unknown) => e)) as Error
    expect(err.message).toContain('连不上抽取模型')
    const text = inspect(err, { depth: null })
    expect(text).not.toContain('sk-pasted')
    expect(text).not.toContain('with-newline')
  })

  it('连不上时带错误类别，不带错误原文', async () => {
    const model = openAiChatModel(
      { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: 'sk-secret' },
      (async () => {
        throw Object.assign(new TypeError('fetch failed sk-secret'), {
          cause: Object.assign(new Error('connect sk-secret'), { code: 'ECONNREFUSED' }),
        })
      }) as unknown as typeof fetch,
    )
    await expect(model.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
      '连不上抽取模型（ECONNREFUSED）：检查实例设置里的接口地址与 Key',
    )
  })
})
