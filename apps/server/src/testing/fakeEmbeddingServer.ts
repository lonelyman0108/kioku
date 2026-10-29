import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { EMBEDDING_DIMENSIONS } from '../db/schema'
import { fakeEmbedder } from './fakeEmbedder'

// 测试用的 OpenAI 兼容嵌入接口，跑在本机的随机端口上。路径的第一段是渠道名，各渠道可以设成出错或返回别的维度。
// 向量先按文本算（fakeEmbedder），再按请求的模型名整体转一个位置：同一个模型的各渠道向量相同，换了模型就几乎正交
export interface FakeEmbeddingServer {
  // 这个渠道的接口根地址
  url(channel: string): string
  // 让这个渠道之后的请求返回这个状态码；null 表示直接断开连接；undefined 恢复正常
  fail(channel: string, status: number | null | undefined): void
  // 让这个渠道返回这个维度的向量
  dimensions(channel: string, n: number): void
  // 输入里有含这段文字的就整个请求返回 413（模拟正文超过模型的长度上限）；null 恢复正常
  rejectText(marker: string | null): void
  requests: { channel: string; model: string; inputs: string[] }[]
  close(): Promise<void>
}

const shiftOf = (model: string) =>
  createHash('md5').update(model).digest().readUInt16BE(0) % EMBEDDING_DIMENSIONS

export async function startFakeEmbeddingServer(): Promise<FakeEmbeddingServer> {
  const failures = new Map<string, number | null>()
  const sizes = new Map<string, number>()
  let rejected: string | null = null
  const requests: FakeEmbeddingServer['requests'] = []
  const vectors = fakeEmbedder()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      void (async () => {
        const channel = (req.url ?? '').split('/')[1] ?? ''
        const { model, input } = JSON.parse(body || '{}') as { model: string; input: string[] }
        requests.push({ channel, model, inputs: input })
        if (failures.has(channel)) {
          const status = failures.get(channel)
          if (status === null) return req.socket.destroy()
          res.writeHead(status!, { 'content-type': 'text/plain' }).end('故意出错')
          return
        }
        if (rejected && input.some((t) => t.includes(rejected!))) {
          res.writeHead(413, { 'content-type': 'text/plain' }).end('input too long')
          return
        }
        const shift = shiftOf(model)
        const data = (await vectors.embed(input)).map((v, index) => {
          const rotated = v.map((_, i) => v[(i + shift) % v.length]!)
          const size = sizes.get(channel) ?? EMBEDDING_DIMENSIONS
          return {
            index,
            embedding: rotated
              .slice(0, size)
              .concat(new Array(Math.max(0, size - rotated.length)).fill(0)),
          }
        })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: (channel) => `http://127.0.0.1:${port}/${channel}/v1`,
    fail: (channel, status) =>
      status === undefined ? failures.delete(channel) : failures.set(channel, status),
    dimensions: (channel, n) => sizes.set(channel, n),
    rejectText: (marker) => {
      rejected = marker
    },
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
