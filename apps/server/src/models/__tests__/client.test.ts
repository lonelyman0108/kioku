import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS } from '../../db/schema'
import {
  chatComplete,
  clearModelCompatibilityCaches,
  clearReasoningFallbackCache,
  embedTexts,
  ModelClientError,
  stripThinkTags,
  testModelConnection,
} from '../client'

async function startStubServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}

describe('chatComplete 流式、重试与思考等级处理', () => {
  const closers: (() => Promise<void>)[] = []

  beforeEach(() => {
    clearReasoningFallbackCache()
  })

  afterEach(async () => {
    while (closers.length) {
      await closers.pop()!()
    }
  })

  it('聚合 SSE 分片（含跨分片 UTF-8 字符），忽略推理段并读取末尾 usage', async () => {
    const stub = await startStubServer((_req, res, body) => {
      expect(body.stream).toBe(true)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      // 模拟推理模型的 reasoning_content（仅保活，不混入正文）
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: '先分析原文结构...' } }],
        })}\n\n`,
      )
      // 模拟一个中文字符跨字节分片写入
      const frame = Buffer.from(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '{"title":"网络架构' } }],
        })}\n\n`,
        'utf8',
      )
      const splitPoint = frame.indexOf(Buffer.from('架', 'utf8')) + 1
      res.write(frame.subarray(0, splitPoint))
      res.write(frame.subarray(splitPoint))
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '总览"}' } }],
          usage: { prompt_tokens: 120, completion_tokens: 45 },
        })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
    closers.push(stub.close)

    const result = await chatComplete(
      { baseUrl: stub.baseUrl, model: 'test-model', apiKey: null },
      [{ role: 'user', content: 'hi' }],
      { stream: true, jsonMode: true },
    )
    expect(result.content).toBe('{"title":"网络架构总览"}')
    expect(result.promptTokens).toBe(120)
    expect(result.completionTokens).toBe(45)
  })

  it('上游忽略 stream:true 直接返回 application/json 时平滑解析', async () => {
    const stub = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"needed":false}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )
    })
    closers.push(stub.close)

    const result = await chatComplete(
      { baseUrl: stub.baseUrl, model: 'test-model', apiKey: null },
      [{ role: 'user', content: 'hi' }],
      { stream: true },
    )
    expect(result.content).toBe('{"needed":false}')
  })

  it('上游以 HTTP 422 拒绝 streaming 参数时自动降级非流式重试一次', async () => {
    const seenStreams: unknown[] = []
    const stub = await startStubServer((_req, res, body) => {
      seenStreams.push(body.stream)
      if (body.stream === true) {
        res.writeHead(422, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Streaming is not supported for this model' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'fallback-ok' } }] }))
    })
    closers.push(stub.close)

    const result = await chatComplete(
      { baseUrl: stub.baseUrl, model: 'test-model', apiKey: null },
      [{ role: 'user', content: 'hi' }],
      { stream: true },
    )
    expect(seenStreams).toEqual([true, undefined])
    expect(result.content).toBe('fallback-ok')
  })

  it('SSE 容忍 data: null / delta: null、多行 data 块，并在 event: error 或 HTTP 200 error 对象时显式报错', async () => {
    const stubOk = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write('data: null\n\n')
      res.write('data: {"choices":[\n')
      res.write('data: {"delta":{"content":"hello"}}\n')
      res.write('data: ]}\n\n')
      res.write(
        'data: {"choices":[{"delta":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":null}}\n\n',
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
    closers.push(stubOk.close)

    const okRes = await chatComplete(
      { baseUrl: stubOk.baseUrl, model: 'test-model', apiKey: null },
      [{ role: 'user', content: 'hi' }],
      { stream: true },
    )
    expect(okRes.content).toBe('hello')

    const stubSseErr = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write('event: error\ndata: upstream gateway timeout\n\n')
      res.end()
    })
    closers.push(stubSseErr.close)

    await expect(
      chatComplete(
        { baseUrl: stubSseErr.baseUrl, model: 'test-model', apiKey: null },
        [{ role: 'user', content: 'hi' }],
        { stream: true },
      ),
    ).rejects.toThrow('upstream gateway timeout')

    const stubJsonErr = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'quota exceeded' } }))
    })
    closers.push(stubJsonErr.close)

    await expect(
      chatComplete({ baseUrl: stubJsonErr.baseUrl, model: 'test-model', apiKey: null }, [
        { role: 'user', content: 'hi' },
      ]),
    ).rejects.toThrow('quota exceeded')
  })

  it('流式读取中途卡死超过 timeoutMs 时抛出「请求超时」', async () => {
    const openResponses: ServerResponse[] = []
    const stub = await startStubServer((_req, res) => {
      openResponses.push(res)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"part":' } }] })}\n\n`)
      // 故意不结束响应，等待客户端超时中止
    })
    closers.push(async () => {
      for (const r of openResponses) r.destroy()
      await stub.close()
    })

    await expect(
      chatComplete(
        { baseUrl: stub.baseUrl, model: 'test-model', apiKey: null },
        [{ role: 'user', content: 'hi' }],
        { stream: true, timeoutMs: 80 },
      ),
    ).rejects.toThrow('请求超时')
  })

  it('stripThinkTags 剥离前置 <think> 块并保留 JSON 字符串内部的字面内容', () => {
    expect(stripThinkTags('<think>先思考步骤</think>\n{"ok":true}')).toBe('{"ok":true}')
    expect(stripThinkTags('  <THINK>A</THINK>\n<think>B</think> {"x":"<think>keep</think>"}')).toBe(
      '{"x":"<think>keep</think>"}',
    )
    expect(stripThinkTags('{"note":"正文里的 <think>示例</think> 不应被删"}')).toBe(
      '{"note":"正文里的 <think>示例</think> 不应被删"}',
    )
  })

  it('检测 SSE 空闲僵死、未见 [DONE] 提前中断与 finish_reason=length 截断', async () => {
    const openResponses: ServerResponse[] = []
    const idleStub = await startStubServer((_req, res) => {
      openResponses.push(res)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"a":' } }] })}\n\n`)
    })
    closers.push(async () => {
      for (const r of openResponses) r.destroy()
      await idleStub.close()
    })

    await expect(
      chatComplete(
        { baseUrl: idleStub.baseUrl, model: 'test-model', apiKey: null },
        [{ role: 'user', content: 'hi' }],
        { stream: true, timeoutMs: 2_000, idleTimeoutMs: 60 },
      ),
    ).rejects.toMatchObject({ category: 'timeout', retryable: true })

    let truncCalls = 0
    const truncStub = await startStubServer((_req, res) => {
      truncCalls++
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] })}\n\n`)
      if (truncCalls === 1) {
        // 首轮模拟流中途断开，既无 finish_reason 也无 [DONE]
        res.end()
        return
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
    closers.push(truncStub.close)

    const recovered = await chatComplete(
      { baseUrl: truncStub.baseUrl, model: 'test-model', apiKey: null },
      [{ role: 'user', content: 'hi' }],
      { stream: true, maxRetries: 1, retryBaseMs: 5 },
    )
    expect(truncCalls).toBe(2)
    expect(recovered.content).toBe('{"ok":true}')

    let lengthCalls = 0
    const lengthStub = await startStubServer((_req, res) => {
      lengthCalls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"partial":' }, finish_reason: 'length' }],
        }),
      )
    })
    closers.push(lengthStub.close)

    await expect(
      chatComplete(
        { baseUrl: lengthStub.baseUrl, model: 'test-model', apiKey: null },
        [{ role: 'user', content: 'hi' }],
        { jsonMode: true, maxRetries: 2, retryBaseMs: 5 },
      ),
    ).rejects.toMatchObject({ category: 'length_limit', retryable: false })
    expect(lengthCalls).toBe(1)
  })

  it('对 429/503 按退避与 Retry-After 重试；对 401/额度不足/上下文超长立即失败不重试', async () => {
    let calls = 0
    const retryDelays: number[] = []
    const transientStub = await startStubServer((_req, res) => {
      calls++
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.02' })
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
        return
      }
      if (calls === 2) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'service unavailable' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '<think>reasoning</think>\n{"ok":1}' } }],
        }),
      )
    })
    closers.push(transientStub.close)

    const res = await chatComplete(
      { baseUrl: transientStub.baseUrl, model: 'test-model', apiKey: null },
      [{ role: 'user', content: 'hi' }],
      {
        maxRetries: 2,
        retryBaseMs: 5,
        onRetry: ({ delayMs }) => retryDelays.push(delayMs),
      },
    )
    expect(calls).toBe(3)
    expect(retryDelays).toHaveLength(2)
    expect(retryDelays[0]).toBeGreaterThanOrEqual(15)
    expect(res.content).toBe('{"ok":1}')

    for (const scenario of [
      { status: 401, msg: 'invalid api key', category: 'auth' },
      { status: 402, msg: 'payment required: insufficient balance', category: 'quota' },
      { status: 429, msg: 'You exceeded your current quota, check billing', category: 'quota' },
      { status: 400, msg: 'context_length_exceeded', category: 'context_length' },
    ] as const) {
      let n = 0
      const failStub = await startStubServer((_req, res) => {
        n++
        res.writeHead(scenario.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: scenario.msg } }))
      })
      closers.push(failStub.close)

      await expect(
        chatComplete(
          { baseUrl: failStub.baseUrl, model: 'test-model', apiKey: null },
          [{ role: 'user', content: 'hi' }],
          { maxRetries: 2, retryBaseMs: 5 },
        ),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ModelClientError &&
          err.category === scenario.category &&
          err.retryable === false,
      )
      expect(n).toBe(1)
    }
  })

  it('思考等级：default 不传参数、按任务覆盖与 max_tokens 补偿、temperature 冲突与 400 降级缓存及测试探测', async () => {
    const seenBodies: Record<string, unknown>[] = []
    const okStub = await startStubServer((_req, res, body) => {
      seenBodies.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
    closers.push(okStub.close)

    // 1. default 绝对不注入 reasoning_effort；>=1000 时附带保守默认余量（+4000，封顶 16384），<1000 保持原值
    await chatComplete(
      { baseUrl: okStub.baseUrl, model: 'm-default', apiKey: null, reasoningEffort: 'default' },
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 600 },
    )
    expect(seenBodies.at(-1)?.reasoning_effort).toBeUndefined()
    expect(seenBodies.at(-1)?.max_tokens).toBe(600)

    await chatComplete(
      { baseUrl: okStub.baseUrl, model: 'm-default', apiKey: null, reasoningEffort: 'default' },
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 1_000 },
    )
    expect(seenBodies.at(-1)?.reasoning_effort).toBeUndefined()
    expect(seenBodies.at(-1)?.max_tokens).toBe(5_000)

    await chatComplete(
      { baseUrl: okStub.baseUrl, model: 'm-default', apiKey: null, reasoningEffort: 'default' },
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 14_000 },
    )
    expect(seenBodies.at(-1)?.max_tokens).toBe(16_384)

    await chatComplete(
      { baseUrl: okStub.baseUrl, model: 'm-default', apiKey: null, reasoningEffort: 'default' },
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 20_000 },
    )
    expect(seenBodies.at(-1)?.max_tokens).toBe(20_000)

    // 2. 任务覆盖：fast=off 传 none 不加预算；organize=high 传 high 并 +8000
    const connWithOverrides = {
      baseUrl: okStub.baseUrl,
      model: 'm-reason',
      apiKey: null,
      reasoningEffort: 'low' as const,
      taskReasoningEffort: { fast: 'off' as const, organize: 'high' as const },
    }
    await chatComplete(connWithOverrides, [{ role: 'user', content: 'hi' }], {
      taskKind: 'fast',
      maxTokens: 600,
    })
    expect(seenBodies.at(-1)?.reasoning_effort).toBe('none')
    expect(seenBodies.at(-1)?.max_tokens).toBe(600)

    await chatComplete(connWithOverrides, [{ role: 'user', content: 'hi' }], {
      taskKind: 'organize',
      maxTokens: 2_000,
    })
    expect(seenBodies.at(-1)?.reasoning_effort).toBe('high')
    expect(seenBodies.at(-1)?.max_tokens).toBe(10_000)

    // 2b. 扩展思考档位：minimal (+1000)、xhigh (+12000)、max (+16000)
    for (const [effort, expectedMax] of [
      ['minimal', 2_000],
      ['xhigh', 13_000],
      ['max', 17_000],
    ] as const) {
      await chatComplete(
        { baseUrl: okStub.baseUrl, model: 'm-frontier', apiKey: null, reasoningEffort: effort },
        [{ role: 'user', content: 'hi' }],
        { maxTokens: 1_000 },
      )
      expect(seenBodies.at(-1)?.reasoning_effort).toBe(effort)
      expect(seenBodies.at(-1)?.max_tokens).toBe(expectedMax)
    }

    // 3. temperature 冲突时剥离 temperature 但保留 reasoning_effort
    const tempBodies: Record<string, unknown>[] = []
    const tempStub = await startStubServer((_req, res, body) => {
      tempBodies.push(body)
      if (body.temperature !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'temperature' is not supported with reasoning_effort",
            },
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
    closers.push(tempStub.close)

    await chatComplete(
      { baseUrl: tempStub.baseUrl, model: 'o3-mini', apiKey: null, reasoningEffort: 'medium' },
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.1, maxTokens: 1_000 },
    )
    expect(tempBodies).toHaveLength(2)
    expect(tempBodies[0]?.temperature).toBe(0.1)
    expect(tempBodies[1]?.temperature).toBeUndefined()
    expect(tempBodies[1]?.reasoning_effort).toBe('medium')

    // 4. 上游拒绝 reasoning_effort：运行时自动剥离并缓存 1h，测试连接直接反馈明确提示
    const fallbackBodies: Record<string, unknown>[] = []
    const noReasonStub = await startStubServer((_req, res, body) => {
      fallbackBodies.push(body)
      if (body.reasoning_effort !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unknown parameter: reasoning_effort' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
    closers.push(noReasonStub.close)

    const testRes = await testModelConnection('chat_llm', {
      baseUrl: noReasonStub.baseUrl,
      model: 'gpt-4o-mini',
      apiKey: null,
      reasoningEffort: 'high',
    })
    expect(testRes.ok).toBe(false)
    expect(testRes.error).toContain('不支持当前思考等级')

    fallbackBodies.length = 0
    await chatComplete(
      {
        baseUrl: noReasonStub.baseUrl,
        model: 'gpt-4o-mini',
        apiKey: null,
        reasoningEffort: 'high',
      },
      [{ role: 'user', content: 'call 1' }],
      { maxTokens: 1_000 },
    )
    expect(fallbackBodies).toHaveLength(2)
    expect(fallbackBodies[0]?.reasoning_effort).toBe('high')
    expect(fallbackBodies[1]?.reasoning_effort).toBeUndefined()
    // 降级剥离 reasoning_effort 后仍对 >=1000 请求保留 +4000 默认余量
    expect(fallbackBodies[1]?.max_tokens).toBe(5_000)

    // 第二次调用直接命中进程内缓存，不再先撞一次 400
    await chatComplete(
      {
        baseUrl: noReasonStub.baseUrl,
        model: 'gpt-4o-mini',
        apiKey: null,
        reasoningEffort: 'high',
      },
      [{ role: 'user', content: 'call 2' }],
      { maxTokens: 1_000 },
    )
    expect(fallbackBodies).toHaveLength(3)
    expect(fallbackBodies[2]?.reasoning_effort).toBeUndefined()
  })

  it('embedTexts 支持 503 重试并在 401 时立即失败', async () => {
    let embedCalls = 0
    const stub = await startStubServer((_req, res) => {
      embedCalls++
      if (embedCalls === 1) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'upstream overloaded' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [{ index: 0, embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(0.1) }],
        }),
      )
    })
    closers.push(stub.close)

    const vectors = await embedTexts(
      { baseUrl: stub.baseUrl, model: 'emb', apiKey: null },
      ['hello'],
      { maxRetries: 1, retryBaseMs: 5 },
    )
    expect(embedCalls).toBe(2)
    expect(vectors).toHaveLength(1)
  })

  it('0 字节空 SSE 流触发传输层重试；无关 400 不误缓存思考降级；testModelConnection high 不越过 8192', async () => {
    // 1. 0 字节空 SSE 流应判为 stream_truncated 并自动重试
    let emptySseCalls = 0
    const emptySseStub = await startStubServer((_req, res) => {
      emptySseCalls++
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (emptySseCalls === 1) {
        res.end()
        return
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    closers.push(emptySseStub.close)

    const emptyRecovered = await chatComplete(
      { baseUrl: emptySseStub.baseUrl, model: 'test-model', apiKey: null },
      [{ role: 'user', content: 'hi' }],
      { stream: true, maxRetries: 1, retryBaseMs: 5 },
    )
    expect(emptySseCalls).toBe(2)
    expect(emptyRecovered.content).toBe('ok')

    // 2. 上游因无关具名参数（如 top_p）返回 400 时，不应误命中思考参数降级也不应污染降级缓存
    const unrelatedBodies: Record<string, unknown>[] = []
    const unrelatedStub = await startStubServer((_req, res, body) => {
      unrelatedBodies.push(body)
      if (unrelatedBodies.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { message: "Unsupported parameter: 'top_p' is not supported" },
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
    closers.push(unrelatedStub.close)

    await expect(
      chatComplete(
        {
          baseUrl: unrelatedStub.baseUrl,
          model: 'm-strict',
          apiKey: null,
          reasoningEffort: 'high',
        },
        [{ role: 'user', content: 'call 1' }],
        { maxTokens: 1_000 },
      ),
    ).rejects.toMatchObject({ category: 'bad_request', status: 400 })
    expect(unrelatedBodies).toHaveLength(1)

    // 后续调用仍应携带 reasoning_effort: 'high'（证明未被错误拉黑缓存）
    await chatComplete(
      { baseUrl: unrelatedStub.baseUrl, model: 'm-strict', apiKey: null, reasoningEffort: 'high' },
      [{ role: 'user', content: 'call 2' }],
      { maxTokens: 1_000 },
    )
    expect(unrelatedBodies[1]?.reasoning_effort).toBe('high')

    // 3. 即使剥离 reasoning_effort 后仍返 400，也绝不能写入降级缓存
    let alwaysBadCalls = 0
    const alwaysBadStub = await startStubServer((_req, res) => {
      alwaysBadCalls++
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Unsupported value in request' } }))
    })
    closers.push(alwaysBadStub.close)

    await expect(
      chatComplete(
        { baseUrl: alwaysBadStub.baseUrl, model: 'm-bad', apiKey: null, reasoningEffort: 'low' },
        [{ role: 'user', content: '1' }],
      ),
    ).rejects.toMatchObject({ category: 'bad_request' })
    expect(alwaysBadCalls).toBe(2)

    await expect(
      chatComplete(
        { baseUrl: alwaysBadStub.baseUrl, model: 'm-bad', apiKey: null, reasoningEffort: 'low' },
        [{ role: 'user', content: '2' }],
      ),
    ).rejects.toMatchObject({ category: 'bad_request' })
    // 未污染缓存，因此第二次仍会先携带 reasoning_effort 尝试
    expect(alwaysBadCalls).toBe(4)

    // 4. testModelConnection 探测 high 时 max_tokens 必须 <= 8192
    let probedMaxTokens: unknown
    const highProbeStub = await startStubServer((_req, res, body) => {
      probedMaxTokens = body.max_tokens
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
    closers.push(highProbeStub.close)

    const highProbe = await testModelConnection('chat_llm', {
      baseUrl: highProbeStub.baseUrl,
      model: 'm-high',
      apiKey: null,
      reasoningEffort: 'high',
    })
    expect(highProbe.ok).toBe(true)
    expect(typeof probedMaxTokens).toBe('number')
    expect(probedMaxTokens as number).toBeGreaterThanOrEqual(256)
    expect(probedMaxTokens as number).toBeLessThanOrEqual(8_192)

    // 5. testModelConnection 默认思考档位使用 256，防止默认思考模型连连通探测都截断
    let defaultProbeMaxTokens: unknown
    const defaultProbeStub = await startStubServer((_req, res, body) => {
      defaultProbeMaxTokens = body.max_tokens
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
    closers.push(defaultProbeStub.close)

    const defaultProbe = await testModelConnection('chat_llm', {
      baseUrl: defaultProbeStub.baseUrl,
      model: 'm-default-probe',
      apiKey: null,
      reasoningEffort: 'default',
    })
    expect(defaultProbe.ok).toBe(true)
    expect(defaultProbeMaxTokens).toBe(256)
  })

  it('length_limit 透出已输出 token 与请求上限，并在小于 16384 时自动扩容重试一次', async () => {
    // 1. 未达 16384 时自动 2x 扩容重试一次并成功
    const expandSeen: unknown[] = []
    const retryEvents: string[] = []
    const expandOkStub = await startStubServer((_req, res, body) => {
      expandSeen.push(body.max_tokens)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (expandSeen.length === 1) {
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"half":' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 100, completion_tokens: 6_000 },
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 7_200 },
        }),
      )
    })
    closers.push(expandOkStub.close)

    const expanded = await chatComplete(
      {
        baseUrl: expandOkStub.baseUrl,
        model: 'm-expand',
        apiKey: null,
        reasoningEffort: 'default',
      },
      [{ role: 'user', content: 'hi' }],
      {
        jsonMode: true,
        maxTokens: 2_000,
        onRetry: ({ error }) => retryEvents.push(error.category),
      },
    )
    expect(expanded.content).toBe('{"ok":true}')
    expect(expandSeen).toEqual([6_000, 12_000])
    expect(retryEvents).toEqual(['length_limit'])

    // 2. 扩容到 16384 后仍被截断则仅重试一次，报错与 rawDetail 带实际用量与请求上限
    const stillTruncSeen: unknown[] = []
    const stillTruncStub = await startStubServer((_req, res, body) => {
      stillTruncSeen.push(body.max_tokens)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"cut":' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 200, completion_tokens: body.max_tokens },
        }),
      )
    })
    closers.push(stillTruncStub.close)

    await expect(
      chatComplete(
        { baseUrl: stillTruncStub.baseUrl, model: 'm-still-cut', apiKey: null },
        [{ role: 'user', content: 'hi' }],
        { jsonMode: true, maxTokens: 6_000, maxRetries: 2, retryBaseMs: 5 },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ModelClientError &&
        err.category === 'length_limit' &&
        err.retryable === false &&
        err.message === '对话模型输出达到长度上限被截断（已输出 16384 token，请求上限 16384）' &&
        err.rawDetail === 'finish_reason=length completion_tokens=16384 max_tokens=16384',
    )
    expect(stillTruncSeen).toEqual([10_000, 16_384])

    // 3. 流式未返回 usage 且已处于 16384 时不重复扩容，文案标注「未知」与请求上限
    let sseCalls = 0
    const sseNoUsageStub = await startStubServer((_req, res) => {
      sseCalls++
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '{"a":1' }, finish_reason: 'length' }],
        })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
    closers.push(sseNoUsageStub.close)

    await expect(
      chatComplete(
        { baseUrl: sseNoUsageStub.baseUrl, model: 'm-sse-cut', apiKey: null },
        [{ role: 'user', content: 'hi' }],
        { jsonMode: true, stream: true, maxTokens: 16_384 },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ModelClientError &&
        err.category === 'length_limit' &&
        err.message === '对话模型输出达到长度上限被截断（已输出 未知 token，请求上限 16384）' &&
        err.rawDetail === 'finish_reason=length completion_tokens=unknown max_tokens=16384',
    )
    expect(sseCalls).toBe(1)

    // 4. 首轮返回 length_limit 后进入扩容重试前若外部 signal 中止，则立即停止不再发起二次请求
    const abortController = new AbortController()
    let abortExpandCalls = 0
    const abortRetryCategories: string[] = []
    const abortExpandStub = await startStubServer((_req, res) => {
      abortExpandCalls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"cut":' }, finish_reason: 'length' }],
        }),
      )
    })
    closers.push(abortExpandStub.close)

    await expect(
      chatComplete(
        { baseUrl: abortExpandStub.baseUrl, model: 'm-abort-cut', apiKey: null },
        [{ role: 'user', content: 'hi' }],
        {
          jsonMode: true,
          maxTokens: 2_000,
          signal: abortController.signal,
          onRetry: ({ error }) => {
            abortRetryCategories.push(error.category)
            abortController.abort()
          },
        },
      ),
    ).rejects.toMatchObject({ category: 'cancelled' })
    expect(abortRetryCategories).toEqual(['length_limit'])
    expect(abortExpandCalls).toBe(1)
  })

  it('传输层 400 自动适配 max_completion_tokens 与上游硬上限解析并缓存', async () => {
    // 1. max_tokens 不支持 -> 自动改用 max_completion_tokens 并保留 reasoning_effort，同时命中缓存
    const mctBodies: Record<string, unknown>[] = []
    const mctStub = await startStubServer((_req, res, body) => {
      mctBodies.push(body)
      if (body.max_tokens !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            },
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }))
    })
    closers.push(mctStub.close)

    const connMct = {
      baseUrl: mctStub.baseUrl,
      model: 'o3-compat',
      apiKey: null,
      reasoningEffort: 'high' as const,
    }
    const r1 = await chatComplete(connMct, [{ role: 'user', content: '1' }], { maxTokens: 1_000 })
    expect(r1.content).toBe('{"ok":true}')
    expect(mctBodies).toHaveLength(2)
    expect(mctBodies[0]?.max_tokens).toBe(9_000)
    expect(mctBodies[1]?.max_tokens).toBeUndefined()
    expect(mctBodies[1]?.max_completion_tokens).toBe(9_000)
    expect(mctBodies[1]?.reasoning_effort).toBe('high')

    // 第二次直接命中缓存，首轮即发送 max_completion_tokens
    await chatComplete(connMct, [{ role: 'user', content: '2' }], { maxTokens: 1_000 })
    expect(mctBodies).toHaveLength(3)
    expect(mctBodies[2]?.max_tokens).toBeUndefined()
    expect(mctBodies[2]?.max_completion_tokens).toBe(9_000)

    // 清理缓存后重新从 max_tokens 起步
    clearModelCompatibilityCaches()
    await chatComplete(connMct, [{ role: 'user', content: '3' }], { maxTokens: 1_000 })
    expect(mctBodies).toHaveLength(5)
    expect(mctBodies[3]?.max_tokens).toBe(9_000)
    expect(mctBodies[4]?.max_completion_tokens).toBe(9_000)

    // 2. 400 上限数值解析（range / <= / maximum）：自动夹紧重试、缓存，且命中硬上限截断时不再无意义扩容
    const capCases = [
      {
        model: 'deepseek-cap',
        cap: 8_192,
        msg: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]',
      },
      {
        model: 'strict-le-cap',
        cap: 4_096,
        msg: "Unsupported value: 'max_tokens' must be <= 4096",
      },
      {
        model: 'max-wording-cap',
        cap: 6_144,
        msg: "max_tokens (16384) exceeds the model's maximum of 6144",
      },
      {
        model: 'anthropic-gt-cap',
        cap: 8_192,
        msg: 'max_tokens: 16000 > 8192, which is the maximum allowed for this model',
      },
    ] as const

    for (const item of capCases) {
      const capBodies: Record<string, unknown>[] = []
      const capStub = await startStubServer((_req, res, body) => {
        capBodies.push(body)
        const limit = typeof body.max_tokens === 'number' ? body.max_tokens : 0
        if (limit > item.cap) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: item.msg } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
      })
      closers.push(capStub.close)

      const connCap = { baseUrl: capStub.baseUrl, model: item.model, apiKey: null }
      await chatComplete(connCap, [{ role: 'user', content: '1' }], { maxTokens: 12_000 })
      expect(capBodies).toHaveLength(2)
      expect(capBodies[0]?.max_tokens).toBe(16_000)
      expect(capBodies[1]?.max_tokens).toBe(item.cap)
      expect(capBodies[1]?.max_completion_tokens).toBeUndefined()

      // 再次调用直接按缓存硬上限夹紧，不再撞 400
      await chatComplete(connCap, [{ role: 'user', content: '2' }], { maxTokens: 12_000 })
      expect(capBodies).toHaveLength(3)
      expect(capBodies[2]?.max_tokens).toBe(item.cap)
    }

    // 3. 已夹紧至上游硬上限仍返回 finish_reason=length 时，不越过硬上限重复扩容
    const cappedTruncBodies: Record<string, unknown>[] = []
    const cappedTruncStub = await startStubServer((_req, res, body) => {
      cappedTruncBodies.push(body)
      const limit = typeof body.max_tokens === 'number' ? body.max_tokens : 0
      if (limit > 4_096) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'max_tokens must be <= 4096' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"half":' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 50, completion_tokens: 4_096 },
        }),
      )
    })
    closers.push(cappedTruncStub.close)

    await expect(
      chatComplete(
        { baseUrl: cappedTruncStub.baseUrl, model: 'm-hard-cap', apiKey: null },
        [{ role: 'user', content: 'hi' }],
        { jsonMode: true, maxTokens: 8_000 },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ModelClientError &&
        err.category === 'length_limit' &&
        err.message === '对话模型输出达到长度上限被截断（已输出 4096 token，请求上限 4096）',
    )
    // 1 次撞 400（12000）+ 1 次夹紧重试（4096），不再尝试扩容到 8192
    expect(cappedTruncBodies.map((b) => b.max_tokens)).toEqual([12_000, 4_096])

    // 4. 负向校验：JSON 外层 code:400、prompt token 数、模型年份与无上限数值的 Unsupported value 不应误夹紧或污染缓存
    const falsePositiveCases = [
      {
        model: 'm-fp-code-400',
        payload: {
          error: { message: 'max_tokens exceeds maximum limit for this model', code: 400 },
        },
      },
      {
        model: 'm-fp-prompt-tokens',
        payload: {
          error: { message: 'max_tokens exceeds maximum. Your prompt has 5000 tokens.' },
        },
      },
      {
        model: 'm-fp-model-year',
        payload: {
          error: { message: 'max_tokens exceeds maximum output tokens for gemini-pro-2025' },
        },
      },
      {
        model: 'm-fp-unsupported-value',
        payload: {
          error: { message: "Unsupported value: 'max_tokens' exceeds limit" },
        },
      },
    ] as const

    for (const item of falsePositiveCases) {
      const fpBodies: Record<string, unknown>[] = []
      const fpStub = await startStubServer((_req, res, body) => {
        fpBodies.push(body)
        if (fpBodies.length === 1) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify(item.payload))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
      })
      closers.push(fpStub.close)

      const connFp = { baseUrl: fpStub.baseUrl, model: item.model, apiKey: null }
      await expect(
        chatComplete(connFp, [{ role: 'user', content: '1' }], { maxTokens: 6_000 }),
      ).rejects.toMatchObject({ category: 'bad_request', status: 400 })
      // 不应误夹紧重试，也不应误切 max_completion_tokens 重试
      expect(fpBodies).toHaveLength(1)

      // 再次调用仍按原预算 10000（6000 + 4000 默认余量）发 max_tokens，证明未污染上限与协议缓存
      await chatComplete(connFp, [{ role: 'user', content: '2' }], { maxTokens: 6_000 })
      expect(fpBodies).toHaveLength(2)
      expect(fpBodies[1]?.max_tokens).toBe(10_000)
      expect(fpBodies[1]?.max_completion_tokens).toBeUndefined()
    }
  })
})
