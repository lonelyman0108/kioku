import { describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS } from '../../db/schema'
import {
  callChatFallback,
  callChatProfile,
  callEmbeddingFallback,
  callEmbeddingProfile,
} from '../execute'
import type { ResolvedChatProfile, ResolvedEmbeddingProfile } from '../types'

const vec = (seed = 0.5) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? seed : 0))

const chatBase: ResolvedChatProfile = {
  profileId: 'p1',
  providerId: 'prov1',
  providerName: 'TestProvider',
  format: 'openai-chat',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-secret-key',
  model: 'test-model',
  label: null,
  thinking: 'default',
  thinkingStyle: 'auto',
  maxTokens: null,
}

const embedBase: ResolvedEmbeddingProfile = {
  profileId: 'e1',
  providerId: 'prov1',
  providerName: 'EmbedProvider',
  format: 'openai-chat',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-secret-key',
  model: 'embed-model',
  label: null,
}

describe('多协议对话适配器', () => {
  it('openai-chat：default 思考不传参数；explicit 思考按风格发送', async () => {
    const bodies: Record<string, unknown>[] = []
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      )
    }) as typeof fetch

    await callChatProfile(chatBase, { messages: [{ role: 'user', content: 'hi' }] }, fakeFetch)
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    expect(bodies[0]).not.toHaveProperty('enable_thinking')
    expect(bodies[0]).not.toHaveProperty('max_tokens')

    await callChatProfile(
      { ...chatBase, thinking: 'high', thinkingStyle: 'reasoning_effort', maxTokens: 1024 },
      { messages: [{ role: 'user', content: 'hi' }] },
      fakeFetch,
    )
    expect(bodies[1]).toMatchObject({ reasoning_effort: 'high', max_tokens: 1024 })

    await callChatProfile(
      { ...chatBase, thinking: 'off', thinkingStyle: 'enable_thinking' },
      { messages: [{ role: 'user', content: 'hi' }] },
      fakeFetch,
    )
    expect(bodies[2]).toMatchObject({ enable_thinking: false })
  })

  it('openai-responses：转换 instructions / input / tools / reasoning 并保留 reasoning_blocks', async () => {
    let seenUrl = ''
    let seenBody: Record<string, unknown> = {}
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url)
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'rs_1',
              encrypted_content: 'enc_abc',
              summary: [{ type: 'summary_text', text: 'thinking summary' }],
            },
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'kioku_search',
              arguments: '{"query":"cat"}',
            },
          ],
          usage: { input_tokens: 20, output_tokens: 12 },
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const result = await callChatProfile(
      { ...chatBase, format: 'openai-responses', thinking: 'medium' },
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'find cat' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'kioku_search', parameters: { type: 'object' } },
          },
        ],
      },
      fakeFetch,
    )

    expect(seenUrl).toBe('https://api.example.com/v1/responses')
    expect(seenBody).toMatchObject({
      instructions: 'sys',
      reasoning: { effort: 'medium' },
      tools: [{ type: 'function', name: 'kioku_search', parameters: { type: 'object' } }],
    })
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'kioku_search',
      arguments: { query: 'cat' },
    })
    expect(result.message.reasoning_content).toBe('thinking summary')
    expect(result.message.reasoning_blocks).toEqual([
      {
        format: 'openai-responses',
        kind: 'responses_reasoning',
        id: 'rs_1',
        encryptedContent: 'enc_abc',
        text: 'thinking summary',
      },
    ])

    // 下一轮回传工具结果时应还原 reasoning item 与 function_call_output
    let nextBody: Record<string, unknown> = {}
    const nextFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      nextBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
          usage: { input_tokens: 30, output_tokens: 4 },
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const next = await callChatProfile(
      { ...chatBase, format: 'openai-responses', thinking: 'medium' },
      {
        messages: [
          { role: 'user', content: 'find cat' },
          result.message,
          { role: 'tool', tool_call_id: 'call_1', content: '[]' },
        ],
      },
      nextFetch,
    )
    expect(nextBody.input).toEqual([
      { type: 'message', role: 'user', content: 'find cat' },
      {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'enc_abc',
        summary: [{ type: 'summary_text', text: 'thinking summary' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'kioku_search',
        arguments: '{"query":"cat"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '[]' },
    ])
    expect(next.finishReason).toBe('stop')
    expect(next.message.content).toBe('done')
  })

  it('anthropic：x-api-key、system 顶层、thinking signature 保留与合并 tool_result', async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            stop_reason: 'tool_use',
            content: [
              { type: 'thinking', thinking: 'plan', signature: 'sig_123' },
              { type: 'tool_use', id: 'tu_1', name: 'kioku_boot', input: {} },
            ],
            usage: { input_tokens: 12, output_tokens: 8 },
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ready' }],
          usage: { input_tokens: 15, output_tokens: 5 },
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const profile: ResolvedChatProfile = {
      ...chatBase,
      format: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      thinking: 'medium',
      maxTokens: 2048,
    }
    const turn1 = await callChatProfile(
      profile,
      {
        messages: [
          { role: 'system', content: 'be helpful' },
          { role: 'user', content: 'boot' },
        ],
        tools: [
          { type: 'function', function: { name: 'kioku_boot', parameters: { type: 'object' } } },
        ],
      },
      fakeFetch,
    )

    expect(requests[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0]!.headers.get('x-api-key')).toBe('sk-secret-key')
    expect(requests[0]!.body).toMatchObject({
      system: 'be helpful',
      thinking: { type: 'enabled', budget_tokens: 8192 },
      max_tokens: 8192 + 4096,
    })
    expect(turn1.finishReason).toBe('tool_calls')

    const turn2 = await callChatProfile(
      profile,
      {
        messages: [
          { role: 'user', content: 'boot' },
          turn1.message,
          { role: 'tool', tool_call_id: 'tu_1', content: 'ok1' },
          { role: 'tool', tool_call_id: 'tu_2', content: 'ok2' },
        ],
      },
      fakeFetch,
    )
    expect(requests[1]!.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'boot' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan', signature: 'sig_123' },
          { type: 'tool_use', id: 'tu_1', name: 'kioku_boot', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok1' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'ok2' },
        ],
      },
    ])
    expect(turn2.finishReason).toBe('stop')
    expect(turn2.message.content).toBe('ready')
  })

  it('gemini：x-goog-api-key、thoughtSignature 回传与 thinkingBudget/thinkingLevel 映射', async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  parts: [
                    { text: 'internal', thought: true },
                    {
                      functionCall: { name: 'kioku_get', args: { uri: 'user://a' } },
                      thoughtSignature: 'gsig_1',
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 },
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'answer' }] } }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3 },
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const profile: ResolvedChatProfile = {
      ...chatBase,
      format: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-3-flash-preview',
      thinking: 'low',
    }
    const turn1 = await callChatProfile(
      profile,
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'read' },
        ],
      },
      fakeFetch,
    )
    expect(requests[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent',
    )
    expect(requests[0]!.headers.get('x-goog-api-key')).toBe('sk-secret-key')
    expect(requests[0]!.body.generationConfig).toEqual({
      thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
    })
    expect(turn1.usage).toEqual({ promptTokens: 10, completionTokens: 12 })
    expect(turn1.finishReason).toBe('tool_calls')

    await callChatProfile(
      profile,
      {
        messages: [
          { role: 'user', content: 'read' },
          turn1.message,
          { role: 'tool', tool_call_id: turn1.toolCalls[0]!.id, content: 'mem' },
        ],
      },
      fakeFetch,
    )
    expect(requests[1]!.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'read' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'kioku_get', args: { uri: 'user://a' } },
            thoughtSignature: 'gsig_1',
          },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'kioku_get', response: { result: 'mem' } } }],
      },
    ])
  })

  it('ollama：原生 /api/chat 参数对象化与 think 字段映射', async () => {
    let seenBody: Record<string, unknown> = {}
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          done_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'done',
            thinking: 'thought',
            tool_calls: [{ function: { name: 'kioku_boot', arguments: { depth: 1 } } }],
          },
          prompt_eval_count: 9,
          eval_count: 4,
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const res = await callChatProfile(
      {
        ...chatBase,
        format: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        thinking: 'high',
        maxTokens: 512,
      },
      {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":1}' } },
            ],
          },
        ],
      },
      fakeFetch,
    )
    expect(seenBody).toMatchObject({
      stream: false,
      think: true,
      options: { num_predict: 512 },
    })
    expect((seenBody.messages as Record<string, unknown>[])[0]).toMatchObject({
      tool_calls: [{ type: 'function', function: { name: 't', arguments: { a: 1 } } }],
    })
    expect(res.message.reasoning_content).toBe('thought')
    expect(res.toolCalls[0]?.arguments).toEqual({ depth: 1 })
    expect(res.usage).toEqual({ promptTokens: 9, completionTokens: 4 })
  })
})

describe('多协议嵌入适配器与 Fallback', () => {
  it('支持 gemini 与 ollama 原生嵌入并校验 1024 维', async () => {
    const geminiFetch = (async () =>
      new Response(JSON.stringify({ embeddings: [{ values: vec(0.1) }] }), {
        status: 200,
      })) as typeof fetch
    const gVecs = await callEmbeddingProfile(
      { ...embedBase, format: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
      ['hello'],
      {},
      geminiFetch,
    )
    expect(gVecs[0]?.length).toBe(EMBEDDING_DIMENSIONS)

    const ollamaFetch = (async () =>
      new Response(JSON.stringify({ embeddings: [vec(0.2)] }), { status: 200 })) as typeof fetch
    const oVecs = await callEmbeddingProfile(
      { ...embedBase, format: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      ['hello'],
      {},
      ollamaFetch,
    )
    expect(oVecs[0]?.length).toBe(EMBEDDING_DIMENSIONS)
  })

  it('Fallback 脱敏所有节点的 Key，信号取消后停止继续尝试', async () => {
    const controller = new AbortController()
    let calls = 0
    const fakeFetch = (async () => {
      calls++
      if (calls === 1) {
        return new Response('bad key sk-first-secret', { status: 401 })
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const p1 = { ...chatBase, profileId: 'p1', apiKey: 'sk-first-secret', model: 'm1' }
    const p2 = { ...chatBase, profileId: 'p2', apiKey: 'sk-second-secret', model: 'm2' }
    const out = await callChatFallback(
      [p1, p2],
      { messages: [{ role: 'user', content: 'hi' }] },
      fakeFetch,
    )
    expect(out.model).toBe('m2')
    expect(out.profileId).toBe('p2')

    // 全部失败时错误中不得泄露明文 Key
    const failFetch = (async () =>
      new Response('leak sk-first-secret and sk-second-secret', { status: 500 })) as typeof fetch
    await expect(
      callChatFallback([p1, p2], { messages: [{ role: 'user', content: 'hi' }] }, failFetch),
    ).rejects.toThrow(/所有备选模型均失败/)
    try {
      await callChatFallback([p1, p2], { messages: [{ role: 'user', content: 'hi' }] }, failFetch)
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-first-secret')
      expect((err as Error).message).not.toContain('sk-second-secret')
    }

    // AbortSignal 取消后不尝试第二个渠道
    calls = 0
    const abortFetch = (async () => {
      calls++
      controller.abort()
      return new Response('err', { status: 500 })
    }) as typeof fetch
    await expect(
      callEmbeddingFallback(
        [embedBase, { ...embedBase, profileId: 'e2' }],
        ['a'],
        {
          signal: controller.signal,
        },
        abortFetch,
      ),
    ).rejects.toThrow(/后续渠道未尝试/)
    expect(calls).toBe(1)
  })
})
