import type { TestModelResponse } from '@kioku/contracts'

import { EMBEDDING_DIMENSIONS } from '../db/schema'

export interface ModelConnection {
  baseUrl: string
  model: string
  apiKey: string | null
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  content: string
  promptTokens: number
  completionTokens: number
}

const DEFAULT_EMBED_TIMEOUT_MS = 30_000
const DEFAULT_CHAT_TIMEOUT_MS = 60_000

function joinEndpoint(baseUrl: string, suffix: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`
}

function authHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return '请求超时'
    const cause = err.cause as { code?: unknown; message?: unknown } | undefined
    if (typeof cause?.code === 'string') return `无法连接模型服务（${cause.code}）`
    return err.message
  }
  return String(err)
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 300).trim()
    return text ? `HTTP ${res.status}: ${text}` : `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

// 调用 OpenAI 兼容 /embeddings 接口，校验返回向量数量与维度（1024 维）
export async function embedTexts(
  conn: ModelConnection,
  texts: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number[][]> {
  if (!texts.length) return []
  const url = joinEndpoint(conn.baseUrl, '/embeddings')
  const signal = combineSignals(options.signal, options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(conn.apiKey),
      body: JSON.stringify({
        model: conn.model,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal,
    })
  } catch (err) {
    throw new Error(describeFetchError(err), { cause: err })
  }

  if (!res.ok) {
    throw new Error(`嵌入接口失败：${await readErrorBody(res)}`)
  }

  let payload: {
    data?: { index?: number; embedding?: unknown }[]
  }
  try {
    payload = (await res.json()) as {
      data?: { index?: number; embedding?: unknown }[]
    }
  } catch (err) {
    throw new Error(describeFetchError(err), { cause: err })
  }
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
    throw new Error(
      `嵌入接口返回条数不匹配：期望 ${texts.length}，实际 ${payload.data?.length ?? 0}`,
    )
  }

  const ordered = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const vectors: number[][] = []
  for (const item of ordered) {
    if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMENSIONS) {
      const actual = Array.isArray(item.embedding) ? item.embedding.length : 0
      throw new Error(
        `嵌入向量维度不匹配：需要 ${EMBEDDING_DIMENSIONS} 维，模型返回了 ${actual} 维`,
      )
    }
    vectors.push(item.embedding.map(Number))
  }
  return vectors
}

function extractMessageText(rawContent: unknown): string {
  if (typeof rawContent === 'string') return rawContent
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  }
  return ''
}

interface ChatCompletionPayload {
  choices?: {
    message?: { content?: unknown } | null
    delta?: { content?: unknown } | null
  }[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null
  error?: { message?: unknown } | string | null
}

function extractPayloadError(rawError: unknown): string | null {
  if (!rawError) return null
  if (typeof rawError === 'string') return rawError.trim() || '上游返回错误'
  if (typeof rawError === 'object') {
    const msg = (rawError as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim()) return msg.trim()
  }
  return '上游返回错误'
}

function parseChatPayload(payload: unknown): ChatResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('对话模型接口返回空或非对象响应')
  }
  const rec = payload as ChatCompletionPayload
  const errMsg = extractPayloadError(rec.error)
  if (errMsg) throw new Error(`对话模型接口失败：${errMsg}`)
  const promptTokens = typeof rec.usage?.prompt_tokens === 'number' ? rec.usage.prompt_tokens : 0
  const completionTokens =
    typeof rec.usage?.completion_tokens === 'number' ? rec.usage.completion_tokens : 0
  return {
    content: extractMessageText(rec.choices?.[0]?.message?.content).trim(),
    promptTokens,
    completionTokens,
  }
}

async function readChatJson(res: Response): Promise<ChatResult> {
  let payload: unknown
  try {
    payload = await res.json()
  } catch (err) {
    throw new Error(describeFetchError(err), { cause: err })
  }
  return parseChatPayload(payload)
}

// 消费 OpenAI 兼容 SSE 流：按事件块聚合多行 data，只收集 delta.content（推理段保活），兼容末尾 usage 与 [DONE]
async function readChatEventStream(res: Response): Promise<ChatResult> {
  if (!res.body) return { content: '', promptTokens: 0, completionTokens: 0 }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let promptTokens = 0
  let completionTokens = 0
  let buffer = ''
  let done = false
  let eventType = ''
  let dataLines: string[] = []
  let sawSsePrefix = false
  const nonSseLines: string[] = []

  const flushEvent = () => {
    const currentEvent = eventType
    const rawData = dataLines.join('\n').trim()
    eventType = ''
    dataLines = []

    if (!rawData) {
      if (currentEvent === 'error') {
        throw new Error('对话模型接口失败：上游返回流式错误')
      }
      return
    }
    if (rawData === '[DONE]') {
      done = true
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawData)
    } catch {
      if (currentEvent === 'error') {
        throw new Error(`对话模型接口失败：${rawData.slice(0, 300)}`)
      }
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const chunk = parsed as ChatCompletionPayload
    const errMsg = extractPayloadError(chunk.error)
    if (errMsg || currentEvent === 'error') {
      throw new Error(`对话模型接口失败：${errMsg ?? rawData.slice(0, 300)}`)
    }
    if (chunk.usage && typeof chunk.usage === 'object') {
      if (typeof chunk.usage.prompt_tokens === 'number') {
        promptTokens = chunk.usage.prompt_tokens
      }
      if (typeof chunk.usage.completion_tokens === 'number') {
        completionTokens = chunk.usage.completion_tokens
      }
    }
    const choice = chunk.choices?.[0]
    if (!choice || typeof choice !== 'object') return
    const piece =
      choice.delta != null
        ? extractMessageText(choice.delta.content)
        : choice.message != null
          ? extractMessageText(choice.message.content)
          : ''
    if (piece) parts.push(piece)
  }

  const handleLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      flushEvent()
      return
    }
    if (line.startsWith(':')) {
      sawSsePrefix = true
      return
    }
    if (line.startsWith('event:')) {
      sawSsePrefix = true
      eventType = line.slice(6).trim().toLowerCase()
      return
    }
    if (line.startsWith('data:')) {
      sawSsePrefix = true
      const value = line.slice(5)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
      return
    }
    if (!sawSsePrefix && nonSseLines.length < 200) {
      nonSseLines.push(line)
    }
  }

  try {
    while (!done) {
      const step = await reader.read()
      if (step.done) break
      buffer += decoder.decode(step.value, { stream: true })
      let newlineIdx = buffer.indexOf('\n')
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        handleLine(line)
        if (done) break
        newlineIdx = buffer.indexOf('\n')
      }
    }
    if (!done) {
      buffer += decoder.decode()
      if (buffer.length > 0) {
        for (const line of buffer.split('\n')) {
          handleLine(line)
          if (done) break
        }
      }
      if (!done) flushEvent()
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('对话模型接口失败：')) throw err
    throw new Error(describeFetchError(err), { cause: err })
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  // 上游未按 SSE 返回（例如 text/plain JSON 或反代 200 错误页）时显式回退解析或报错，避免静默返回空串
  if (!sawSsePrefix && parts.length === 0) {
    const raw = nonSseLines.join('\n').trim()
    if (raw.startsWith('{')) {
      try {
        return parseChatPayload(JSON.parse(raw))
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('对话模型接口失败：')) throw err
      }
    }
    if (raw) {
      throw new Error(`对话模型接口返回异常内容：${raw.slice(0, 120)}`)
    }
  }

  return {
    content: parts.join('').trim(),
    promptTokens,
    completionTokens,
  }
}

export interface ChatCompleteOptions {
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  stream?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

const STREAM_UNSUPPORTED_RE = /\bstream(?:ing)?\b|流式/i

// 调用 OpenAI 兼容 /chat/completions 接口；长耗时任务可启用 stream: true 以 SSE 保活并规避反代读取超时
export async function chatComplete(
  conn: ModelConnection,
  messages: readonly ChatMessage[],
  options: ChatCompleteOptions = {},
): Promise<ChatResult> {
  const url = joinEndpoint(conn.baseUrl, '/chat/completions')
  const signal = combineSignals(options.signal, options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS)

  const send = async (useStream: boolean): Promise<ChatResult> => {
    const body: Record<string, unknown> = {
      model: conn.model,
      messages,
      temperature: options.temperature ?? 0.2,
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.jsonMode) body.response_format = { type: 'json_object' }
    if (useStream) body.stream = true

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: authHeaders(conn.apiKey),
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      throw new Error(describeFetchError(err), { cause: err })
    }

    if (!res.ok) {
      const detail = await readErrorBody(res)
      if (
        useStream &&
        (res.status === 400 || res.status === 422) &&
        STREAM_UNSUPPORTED_RE.test(detail)
      ) {
        return send(false)
      }
      throw new Error(`对话模型接口失败：${detail}`)
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    if (useStream && !contentType.includes('application/json')) {
      return readChatEventStream(res)
    }
    return readChatJson(res)
  }

  return send(Boolean(options.stream))
}

export async function testModelConnection(
  kind: 'embedding' | 'chat_llm',
  conn: ModelConnection,
): Promise<TestModelResponse> {
  const start = Date.now()
  try {
    if (kind === 'embedding') {
      const [vec] = await embedTexts(conn, ['kioku connectivity probe'], { timeoutMs: 15_000 })
      return {
        ok: true,
        latencyMs: Date.now() - start,
        dimensions: vec?.length ?? EMBEDDING_DIMENSIONS,
      }
    }
    await chatComplete(conn, [{ role: 'user', content: 'Reply with OK.' }], {
      temperature: 0,
      maxTokens: 16,
      timeoutMs: 20_000,
    })
    return { ok: true, latencyMs: Date.now() - start }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
