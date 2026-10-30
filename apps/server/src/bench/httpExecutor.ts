import { WhoAmI } from '@kioku/contracts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { VERSION } from '../version'
import {
  restFailure,
  restSuccess,
  toolOutcome,
  type BenchExecutor,
  type ResolvedStep,
  type StepOutcome,
  type ToolResult,
} from './executor'

// 真实 HTTP 执行：用真实的 Key，覆盖鉴权与网络这一层。工具走 SDK 的 Client，先做真实握手；
// 生命周期事件与 /recall 走 fetch。没有回滚也没有打码：取值是一次真实调用

const REQUEST_TIMEOUT_MS = 60_000

export interface HttpExecutor extends BenchExecutor {
  // 真实握手之后的服务端信息与工具名单
  handshake(): Promise<{ name: string; version: string; tools: string[] }>
  close(): Promise<void>
}

// 连不上之类的错误：不是接口给的结果，没有状态码
const transportFailure = (err: unknown): StepOutcome => ({
  ...restFailure(500, `请求失败：${err instanceof Error ? err.message : String(err)}`),
  httpStatus: null,
})

export function httpExecutor(target: { url: string; key: string }): HttpExecutor {
  const base = target.url.replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${target.key}` }
  const client = new Client({ name: 'kioku-bench', version: VERSION })
  let connected: Promise<void> | null = null
  const connect = () =>
    (connected ??= client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/v1/mcp`), { requestInit: { headers } }),
    ))

  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/v1${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let raw: unknown = text
    try {
      raw = JSON.parse(text)
    } catch {
      // 不是 JSON（例如反向代理的错误页）就给原文
    }
    return { res, raw, text }
  }

  const rest = async (
    kind: ResolvedStep['kind'],
    method: string,
    path: string,
    body?: unknown,
  ): Promise<StepOutcome> => {
    try {
      const { res, raw, text } = await request(method, path, body)
      if (res.ok) return restSuccess(kind, raw)
      const message = (raw as { error?: unknown } | null)?.error
      return { ...restFailure(res.status, typeof message === 'string' ? message : text), raw }
    } catch (err) {
      return transportFailure(err)
    }
  }

  return {
    async whoami() {
      const { res, raw } = await request('GET', '/whoami')
      if (!res.ok) throw new Error(`读 /whoami 失败：HTTP ${res.status}，确认服务地址与 Key`)
      const parsed = WhoAmI.safeParse(raw)
      if (!parsed.success) throw new Error('/whoami 的响应对不上，确认服务地址指向 Kioku')
      return parsed.data
    },
    async handshake() {
      await connect()
      const server = client.getServerVersion()
      const tools: string[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {})
        tools.push(...page.tools.map((t) => t.name))
        cursor = page.nextCursor
      } while (cursor)
      return { name: server?.name ?? '', version: server?.version ?? '', tools }
    },
    async execute(step) {
      switch (step.kind) {
        case 'tool':
          try {
            await connect()
            const result = await client.callTool({ name: step.tool, arguments: step.arguments })
            return toolOutcome(step.tool, result as ToolResult)
          } catch (err) {
            return transportFailure(err)
          }
        case 'lifecycle':
          return rest('lifecycle', 'POST', '/lifecycle/event', step.body)
        case 'recall':
          return rest('recall', 'POST', '/recall', step.body)
        case 'boot':
          return rest('boot', 'GET', '/boot')
        case 'whoami':
          return rest('whoami', 'GET', '/whoami')
      }
    },
    stopReason: async () => null,
    close: () => client.close(),
  }
}
