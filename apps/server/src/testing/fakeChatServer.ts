import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ChatMessage } from '../extraction/provider'

// 测试用的 OpenAI 兼容 /chat/completions 接口，跑在本机的随机端口上：按收到的消息算出回答，用量固定
export interface FakeChatServer {
  // 接口根地址（抽取模型设置里的 baseUrl）
  url: string
  requests: ChatMessage[][]
  close(): Promise<void>
}

export async function startFakeChatServer(
  reply: (messages: ChatMessage[]) => string,
): Promise<FakeChatServer> {
  const requests: ChatMessage[][] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      const { messages } = JSON.parse(body || '{}') as { messages: ChatMessage[] }
      requests.push(messages)
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: reply(messages) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
