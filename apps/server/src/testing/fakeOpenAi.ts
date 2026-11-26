import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { EMBEDDING_DIMENSIONS } from '../db/schema'

export type FakeChatHandler = (
  messages: { role: string; content: string }[],
  body: Record<string, unknown>,
) => string | Promise<string>

export interface FakeOpenAiOptions {
  embed?: (input: string) => number[]
  chat?: FakeChatHandler
}

export interface FakeOpenAiServer {
  baseUrl: string
  requests: { path: string; body: unknown; auth: string | undefined }[]
  setChatHandler: (fn: FakeChatHandler) => void
  setEmbedHandler: (fn: (input: string) => number[]) => void
  close: () => Promise<void>
}

// 为每个独立词元分配正交维度，保证无共享词元的文本余弦相似度严格为 0，同主题文本相似度高
const tokenDimensions = new Map<string, number>()

export function deterministicVector(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .filter(Boolean)
  if (!tokens.length) {
    vec[0] = 1
    return vec
  }
  for (const token of tokens) {
    let bucket = tokenDimensions.get(token)
    if (bucket === undefined) {
      bucket = tokenDimensions.size % EMBEDDING_DIMENSIONS
      tokenDimensions.set(token, bucket)
    }
    vec[bucket] = (vec[bucket] ?? 0) + 1
  }
  let norm = 0
  for (const v of vec) norm += v * v
  const scale = Math.sqrt(norm) || 1
  return vec.map((v) => v / scale)
}

export async function startFakeOpenAi(options: FakeOpenAiOptions = {}): Promise<FakeOpenAiServer> {
  let embedHandler = options.embed ?? deterministicVector
  let chatHandler =
    options.chat ?? (() => JSON.stringify({ title: '默认测试摘要', content: '测试内容' }))
  const requests: { path: string; body: unknown; auth: string | undefined }[] = []

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const path = req.url ?? '/'
      requests.push({ path, body, auth: req.headers.authorization })

      if (path.endsWith('/embeddings')) {
        const input = body.input
        const inputs = Array.isArray(input) ? input.map(String) : [String(input ?? '')]
        const data = inputs.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: embedHandler(text),
        }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data, model: body.model ?? 'fake-embed' }))
        return
      }

      if (path.endsWith('/chat/completions')) {
        const messages = Array.isArray(body.messages)
          ? (body.messages as { role: string; content: string }[])
          : []
        void Promise.resolve()
          .then(() => chatHandler(messages, body))
          .then((content) => {
            if (body.stream === true) {
              res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
              const mid = Math.ceil(content.length / 2)
              const parts = [content.slice(0, mid), content.slice(mid)].filter(Boolean)
              for (const piece of parts) {
                res.write(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
                  })}\n\n`,
                )
              }
              res.write('data: [DONE]\n\n')
              res.end()
              return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(
              JSON.stringify({
                id: 'chatcmpl-test',
                object: 'chat.completion',
                choices: [
                  { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
                ],
              }),
            )
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message } }))
          })
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setChatHandler(fn) {
      chatHandler = fn
    },
    setEmbedHandler(fn) {
      embedHandler = fn
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
