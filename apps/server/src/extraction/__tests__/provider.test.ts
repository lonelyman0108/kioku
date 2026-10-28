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
})
