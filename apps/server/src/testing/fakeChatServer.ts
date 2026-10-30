import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// 收到的一条消息：抽取只发 role 与 content，模型代理还有 tool_calls、tool_call_id、reasoning_content 这些字段，原样记下
export type FakeChatMessage = { role: string; content?: unknown } & Record<string, unknown>

// 回答的助手消息：可以带工具调用，别的字段也原样写进消息。finish_reason 不给时按有没有工具调用算
export type FakeChatAnswer = {
  content?: string | null
  tool_calls?: unknown[]
  reasoning_content?: string
  finish_reason?: string
} & Record<string, unknown>

// 字符串是回答的文字；raw 原样写回响应（上游报错、不合规的 JSON）；hang 一直不响应（取消、超时）
export type FakeChatReply =
  string | FakeChatAnswer | { raw: string; status?: number } | { hang: true }

// 测试用的 OpenAI 兼容 /chat/completions 接口，跑在本机的随机端口上：按收到的消息算出回答，用量固定
export interface FakeChatServer {
  // 接口根地址（抽取模型设置里的 baseUrl）
  url: string
  requests: FakeChatMessage[][]
  // 每次请求的 tools，没带时是 undefined
  tools: (unknown[] | undefined)[]
  // 每次请求的完整请求体与 Authorization 头
  bodies: Record<string, unknown>[]
  authorizations: (string | undefined)[]
  // 还没响应就断开了的请求（第几个）
  cancelled: number[]
  close(): Promise<void>
}

export async function startFakeChatServer(
  reply: (messages: FakeChatMessage[]) => FakeChatReply,
): Promise<FakeChatServer> {
  const requests: FakeChatMessage[][] = []
  const tools: (unknown[] | undefined)[] = []
  const bodies: Record<string, unknown>[] = []
  const authorizations: (string | undefined)[] = []
  const cancelled: number[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as Record<string, unknown>
      const index = requests.length
      requests.push(parsed.messages as FakeChatMessage[])
      tools.push(parsed.tools as unknown[] | undefined)
      bodies.push(parsed)
      authorizations.push(req.headers.authorization)
      res.on('close', () => {
        if (!res.writableFinished) cancelled.push(index)
      })
      const answer = reply(parsed.messages as FakeChatMessage[])
      if (typeof answer === 'object' && 'hang' in answer) return
      if (typeof answer === 'object' && 'raw' in answer) {
        const { raw, status = 200 } = answer as { raw: string; status?: number }
        res.writeHead(status, { 'content-type': 'application/json' }).end(raw)
        return
      }
      const { finish_reason: finishReason, ...message } = (
        typeof answer === 'string' ? { content: answer } : answer
      ) as FakeChatAnswer
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', ...message },
              finish_reason: finishReason ?? (message.tool_calls ? 'tool_calls' : 'stop'),
            },
          ],
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
    tools,
    bodies,
    authorizations,
    cancelled,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        // 一直不响应的请求不会自己结束，不断开就关不上
        server.closeAllConnections()
      }),
  }
}
