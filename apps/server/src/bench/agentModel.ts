import { randomBytes } from 'node:crypto'

import type {
  BenchAgentMessage,
  BenchAgentToolCall,
  BenchAgentTurnResult,
  BenchTool,
} from '@kioku/contracts'

import type { EndpointConfig } from '../settings/endpoint'

// 模型代理的一次请求：OpenAI 兼容接口、带工具。和抽取用的 ChatModel 分开：这里消息要原样转发（tool_calls、tool 消息、
// reasoning_content 这些字段都不能丢），模型给的工具参数不合法也不算请求失败。和 ChatModel 一样不传 temperature、
// max_tokens：推理模型常常不接受这些参数，传了会整个请求被拒

// 推理模型一次可能想一两分钟。前面有反向代理时，它的读超时要大于这个时限
const TIMEOUT_MS = 120_000
// 报错里带的上游原文最多这么多字（这个接口只给实例管理员）
const UPSTREAM_TEXT_CHARS = 500

// 请求模型失败。message 直接给调用方看：不带 API Key，上游的原文截断过
export class AgentModelError extends Error {}

export interface AgentToolDefinition {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

export interface AgentTurnInput {
  messages: readonly BenchAgentMessage[]
  // 空的时候请求里不带 tools：有的接口不接受空数组
  tools: readonly AgentToolDefinition[]
  // 请求的：客户端断开就取消，不继续花 token
  signal?: AbortSignal
  timeoutMs?: number
}

// 工具定义原样转发，只去掉没有语义的 $schema。别的字段等上游真的拒绝时才在这里转换，调用台与 MCP 不动
export function toolDefinitions(tools: readonly BenchTool[]): AgentToolDefinition[] {
  return tools.map(({ name, description, inputSchema }) => {
    const parameters = { ...(inputSchema as Record<string, unknown>) }
    delete parameters.$schema
    return {
      type: 'function',
      function: { name, ...(description === undefined ? {} : { description }), parameters },
    }
  })
}

// 转义字符串内部没转义的控制字符。有的模型的响应里有这种字符，严格的 JSON 解析会失败。要记着在不在字符串里：
// 字符串外的换行和缩进是合法的空白，转义了反而解析不了；反斜杠后面的那个字符不算引号，也不动
export function escapeControlChars(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (inString && !escaped && code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    const ch = text.charAt(i)
    out += ch
    if (escaped) escaped = false
    else if (ch === '\\') escaped = inString
    else if (ch === '"') inString = !inString
  }
  return out
}

// 先严格解析，失败了才容忍控制字符：多数响应用不着多扫一遍
export function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(escapeControlChars(text))
  }
}

type ParsedArguments = Pick<BenchAgentToolCall, 'arguments' | 'parseError'>

function parseArguments(raw: unknown): ParsedArguments {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      // 和响应一样容忍控制字符：多行正文的参数里常有没转义的换行，这里报错的话模型只能白白重试
      parsed = raw.trim() ? parseModelJson(raw) : null
    } catch {
      return { arguments: null, parseError: '工具参数不是合法的 JSON' }
    }
  }
  // 没有参数的工具，有的模型不给，有的给空串或 null，有的模型和代理把 null 编码成字符串
  if (parsed === undefined || parsed === null) return { arguments: {}, parseError: null }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { arguments: null, parseError: '工具参数不是 JSON 对象' }
  }
  return { arguments: parsed as Record<string, unknown>, parseError: null }
}

export type NormalizedToolCall = Record<string, unknown> & { id: string }

// 助手消息里的 tool_calls。这条消息下一轮要放回历史，tool 消息的 tool_call_id 得和这里的 id 一一对上，否则之后每一轮
// 上游都拒绝，对话就卡死了。所以缺失、不是字符串、空串或重复的 id 换成生成的，重复的第一个留着；生成的照 OpenAI 的写法
// （call_ 加 24 位），有的接口限制 id 的长度。不是对象的放不下 id，也说不出要调什么，去掉。别的字段原样
export function normalizeToolCalls(value: unknown): NormalizedToolCall[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value
    .filter(
      (call: unknown): call is Record<string, unknown> =>
        typeof call === 'object' && call !== null && !Array.isArray(call),
    )
    .map((call) => {
      const id =
        typeof call.id === 'string' && call.id && !seen.has(call.id)
          ? call.id
          : `call_${randomBytes(12).toString('hex')}`
      seen.add(id)
      return { ...call, id }
    })
}

// 解析规范化之后的工具调用，和 message.tool_calls 一一对应、id 相同。不合规的也留着，由调用方作为工具错误回给模型：
// 带 tool_calls 的消息要跟齐每一个 tool 消息，少一个下一轮上游就拒绝
export function parseToolCalls(calls: readonly NormalizedToolCall[]): BenchAgentToolCall[] {
  return calls.map((call) => {
    const fn = call.function as { name?: unknown; arguments?: unknown } | null | undefined
    const name = typeof fn?.name === 'string' ? fn.name : ''
    return {
      id: call.id,
      name,
      ...(name
        ? parseArguments(fn?.arguments)
        : { arguments: null, parseError: '工具调用没有名字' }),
    }
  })
}

// 下一轮要放回历史的助手消息。tool_calls 换成规范化之后的，没有工具调用时去掉：上游给的空数组或别的类型，严格的接口会拒绝。
// 没有 role 时补上：历史里每条都要有 role。别的字段原样
function assistantMessage(
  message: Record<string, unknown>,
  calls: readonly NormalizedToolCall[],
): BenchAgentMessage {
  const result: Record<string, unknown> = { ...message, tool_calls: calls }
  if (!calls.length) delete result.tool_calls
  if (typeof message.role !== 'string' || !message.role) result.role = 'assistant'
  return result as BenchAgentMessage
}

// 上游可能把收到的 Key 写进报错。JSON 或网址里的写法可能不同，都换掉
function withoutKey(text: string, apiKey: string | null): string {
  if (!apiKey) return text
  return [apiKey, JSON.stringify(apiKey).slice(1, -1), encodeURIComponent(apiKey)].reduce(
    (out, form) => out.replaceAll(form, '***'),
    text,
  )
}

// 切开代理对时连前半个一起去掉，落单的代理项不是合法的文字
function excerpt(text: string): string {
  if (text.length <= UPSTREAM_TEXT_CHARS) return text
  const cut = text.slice(0, UPSTREAM_TEXT_CHARS)
  const last = cut.charCodeAt(cut.length - 1)
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`
}

const tokens = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

// 请求一次模型。失败时抛 AgentModelError；工具参数不合法不算失败，见 parseToolCalls
export async function requestAgentTurn(
  config: EndpointConfig,
  { messages, tools, signal, timeoutMs = TIMEOUT_MS }: AgentTurnInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BenchAgentTurnResult> {
  const started = Date.now()
  const timeout = AbortSignal.timeout(timeoutMs)
  // 先去掉 Key 再截断：先截断的话，截在 Key 中间时留下的半截就换不掉了
  const upstreamText = (text: string) => excerpt(withoutKey(text, config.apiKey))

  let res: Response
  let raw: string
  try {
    res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        ...(tools.length ? { tools } : {}),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    raw = await res.text()
  } catch (err) {
    // 不用错误自己的文字：Key 里有换行时，fetch 把整个请求头写进错误
    if (timeout.aborted) {
      throw new AgentModelError(`模型 ${Math.ceil(timeoutMs / 1000)} 秒内没有返回`)
    }
    if (signal?.aborted) throw new AgentModelError('请求已经断开')
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
    throw new AgentModelError(
      `连不上模型接口${typeof code === 'string' ? `（${code}）` : ''}：检查实例设置里的接口地址与 Key`,
    )
  }
  if (!res.ok) {
    throw new AgentModelError(`模型接口返回 HTTP ${res.status}：${upstreamText(raw)}`)
  }

  let body: unknown
  try {
    body = parseModelJson(raw)
  } catch {
    throw new AgentModelError(`模型接口的响应不是合法的 JSON：${upstreamText(raw)}`)
  }
  const { choices, usage } = (body ?? {}) as {
    choices?: { message?: unknown; finish_reason?: unknown }[]
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  }
  const choice = choices?.[0]
  const message = choice?.message as Record<string, unknown> | null | undefined
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    throw new AgentModelError(`模型接口的响应里没有助手消息：${upstreamText(raw)}`)
  }
  const calls = normalizeToolCalls(message.tool_calls)
  return {
    message: assistantMessage(message, calls),
    toolCalls: parseToolCalls(calls),
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage: {
      promptTokens: tokens(usage?.prompt_tokens),
      completionTokens: tokens(usage?.completion_tokens),
    },
    ms: Date.now() - started,
    model: config.model,
  }
}
