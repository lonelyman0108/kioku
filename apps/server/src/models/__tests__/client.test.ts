import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { chatComplete } from '../client'

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

describe('chatComplete 流式与超时处理', () => {
  const closers: (() => Promise<void>)[] = []

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
})
