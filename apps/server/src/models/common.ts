import { randomBytes } from 'node:crypto'

import type {
  BenchAgentMessage,
  BenchAgentReasoningBlock,
  BenchAgentToolCall,
  BenchTool,
  ModelFormat,
} from '@kioku/contracts'

import { fetchFailure, MODEL_ENDPOINT_CHECK, withoutKey } from '../settings/endpoint'
import { ModelCallError, type AgentToolDefinition } from './types'

const UPSTREAM_TEXT_CHARS = 500
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

export const trimBase = (url: string) => url.replace(/\/+$/, '')

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const numOrZero = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

export function endpointAddress(baseUrl: string): string {
  const { origin, pathname } = new URL(baseUrl)
  return `${origin}${pathname}`.replace(/\/+$/, '')
}

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

// 转义字符串内部没转义的控制字符：有的模型响应或工具参数里会出现未转义换行
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

export function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(escapeControlChars(text))
  }
}

export function excerptUpstream(text: string, apiKey: string | null): string {
  const clean = withoutKey(text, apiKey)
  if (clean.length <= UPSTREAM_TEXT_CHARS) return clean
  const cut = clean.slice(0, UPSTREAM_TEXT_CHARS)
  const last = cut.charCodeAt(cut.length - 1)
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`
}

export async function postModelJson(
  url: string,
  options: {
    headers: Record<string, string>
    body: unknown
    apiKey: string | null
    timeoutMs: number
    signal?: AbortSignal | undefined
    what?: string | undefined
    timeoutWhat?: string | undefined
    includeExcerptOnJsonError?: boolean | undefined
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ raw: string; parsed: unknown }> {
  const what = options.what ?? '模型接口'
  const timeout = AbortSignal.timeout(options.timeoutMs)
  let res: Response
  let raw: string
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    })
    raw = await res.text()
  } catch (err) {
    if (timeout.aborted) {
      throw new ModelCallError(
        `${options.timeoutWhat ?? what} ${Math.ceil(options.timeoutMs / 1000)} 秒内未返回`,
      )
    }
    if (options.signal?.aborted) {
      throw new ModelCallError('请求已断开')
    }
    throw new ModelCallError(fetchFailure(what, err, MODEL_ENDPOINT_CHECK))
  }
  if (!res.ok) {
    throw new ModelCallError(
      `${what}返回 HTTP ${res.status}：${excerptUpstream(raw, options.apiKey)}`,
    )
  }
  try {
    return { raw, parsed: parseModelJson(raw) }
  } catch {
    throw new ModelCallError(
      options.includeExcerptOnJsonError
        ? `${what}的响应不是合法的 JSON：${excerptUpstream(raw, options.apiKey)}`
        : `${what}的响应不是合法的 JSON`,
    )
  }
}

export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('')
}

export type NormalizedToolCall = Record<string, unknown> & { id: string }

const rawText = (raw: unknown) => (typeof raw === 'string' ? raw : JSON.stringify(raw))

function parseArguments(
  raw: unknown,
): Pick<BenchAgentToolCall, 'arguments' | 'parseError' | 'rawArguments'> {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = raw.trim() ? parseModelJson(raw) : null
    } catch {
      return { arguments: null, parseError: '工具参数不是合法的 JSON', rawArguments: raw }
    }
  }
  if (parsed === undefined || parsed === null) return { arguments: {}, parseError: null }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { arguments: null, parseError: '工具参数不是 JSON 对象', rawArguments: rawText(raw) }
  }
  return { arguments: parsed as Record<string, unknown>, parseError: null }
}

export function normalizeToolCalls(value: unknown): NormalizedToolCall[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.filter(isRecord).map((call) => {
    const id =
      typeof call.id === 'string' && call.id && !seen.has(call.id)
        ? call.id
        : `call_${randomBytes(12).toString('hex')}`
    seen.add(id)
    return { ...call, id }
  })
}

function historyArguments(args: unknown): string {
  if (typeof args !== 'string') return isRecord(args) ? JSON.stringify(args) : '{}'
  try {
    return isRecord(JSON.parse(args)) ? args : '{}'
  } catch {
    try {
      const tolerated: unknown = parseModelJson(args)
      return isRecord(tolerated) ? JSON.stringify(tolerated) : '{}'
    } catch {
      return '{}'
    }
  }
}

function historyToolCall(call: NormalizedToolCall): NormalizedToolCall {
  const fn = isRecord(call.function) ? call.function : null
  const name = fn?.name
  return {
    ...call,
    type: fn && typeof call.type === 'string' && call.type ? call.type : 'function',
    function: {
      ...fn,
      name: typeof name === 'string' && TOOL_NAME.test(name) ? name : 'unknown_tool',
      arguments: historyArguments(fn?.arguments),
    },
  }
}

export function parseToolCalls(calls: readonly NormalizedToolCall[]): BenchAgentToolCall[] {
  return calls.map((call) => {
    const fn = call.function as { name?: unknown; arguments?: unknown } | null | undefined
    const name = typeof fn?.name === 'string' ? fn.name : ''
    return {
      id: call.id,
      name,
      ...(name
        ? parseArguments(fn?.arguments)
        : {
            arguments: null,
            parseError: '工具调用没有名字',
            rawArguments: rawText(fn?.arguments),
          }),
    }
  })
}

export function buildAssistantMessage(
  message: Record<string, unknown>,
  calls: readonly NormalizedToolCall[],
): BenchAgentMessage {
  const result: Record<string, unknown> = { ...message, tool_calls: calls.map(historyToolCall) }
  if (!calls.length) delete result.tool_calls
  if (typeof message.role !== 'string' || !message.role) result.role = 'assistant'
  return result as BenchAgentMessage
}

export function parseObjectArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = parseModelJson(raw)
      if (isRecord(parsed)) return parsed
    } catch {
      return {}
    }
  }
  return {}
}

export function readReasoningBlocks(
  message: BenchAgentMessage,
  format: ModelFormat,
): BenchAgentReasoningBlock[] {
  const raw = (message as { reasoning_blocks?: unknown }).reasoning_blocks
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (b): b is BenchAgentReasoningBlock =>
      isRecord(b) && b.format === format && typeof b.kind === 'string',
  )
}

export function normalizeFinishReason(
  format: ModelFormat,
  raw: unknown,
  hasToolCalls: boolean,
): string | null {
  if (typeof raw !== 'string' || !raw) return hasToolCalls ? 'tool_calls' : null
  switch (format) {
    case 'openai-chat':
      return raw
    case 'openai-responses':
      if (raw === 'completed') return hasToolCalls ? 'tool_calls' : 'stop'
      if (raw === 'incomplete') return 'length'
      if (raw === 'failed') return 'error'
      return raw
    case 'anthropic':
      if (raw === 'end_turn' || raw === 'stop_sequence') return 'stop'
      if (raw === 'tool_use') return 'tool_calls'
      if (raw === 'max_tokens') return 'length'
      if (raw === 'refusal') return 'content_filter'
      return raw
    case 'gemini':
      if (raw === 'STOP') return hasToolCalls ? 'tool_calls' : 'stop'
      if (raw === 'MAX_TOKENS') return 'length'
      if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(raw)) {
        return 'content_filter'
      }
      return raw.toLowerCase()
    case 'ollama':
      if (raw === 'stop') return hasToolCalls ? 'tool_calls' : 'stop'
      if (raw === 'length') return 'length'
      return raw
  }
}
