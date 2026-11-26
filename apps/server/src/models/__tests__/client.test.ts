import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS } from '../../db/schema'
import {
  chatComplete,
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

    // 1. default 绝对不注入 reasoning_effort
    await chatComplete(
      { baseUrl: okStub.baseUrl, model: 'm-default', apiKey: null, reasoningEffort: 'default' },
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 1_000 },
    )
    expect(seenBodies.at(-1)?.reasoning_effort).toBeUndefined()
    expect(seenBodies.at(-1)?.max_tokens).toBe(1_000)

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
    expect(fallbackBodies[1]?.max_tokens).toBe(1_000)

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

    // 2. 上游因 max_tokens 返回 400 时，不应误命中思考参数降级也不应污染降级缓存
    const maxTokBodies: Record<string, unknown>[] = []
    const maxTokStub = await startStubServer((_req, res, body) => {
      maxTokBodies.push(body)
      if (maxTokBodies.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { message: "Unsupported parameter: 'max_tokens' is not supported" },
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    })
    closers.push(maxTokStub.close)

    await expect(
      chatComplete(
        { baseUrl: maxTokStub.baseUrl, model: 'm-strict', apiKey: null, reasoningEffort: 'high' },
        [{ role: 'user', content: 'call 1' }],
        { maxTokens: 1_000 },
      ),
    ).rejects.toMatchObject({ category: 'bad_request', status: 400 })
    expect(maxTokBodies).toHaveLength(1)

    // 后续调用仍应携带 reasoning_effort: 'high'（证明未被错误拉黑缓存）
    await chatComplete(
      { baseUrl: maxTokStub.baseUrl, model: 'm-strict', apiKey: null, reasoningEffort: 'high' },
      [{ role: 'user', content: 'call 2' }],
      { maxTokens: 1_000 },
    )
    expect(maxTokBodies[1]?.reasoning_effort).toBe('high')

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
  })
})
