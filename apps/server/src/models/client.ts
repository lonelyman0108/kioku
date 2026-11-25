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

  const payload = (await res.json()) as {
    data?: { index?: number; embedding?: unknown }[]
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

// 调用 OpenAI 兼容 /chat/completions 接口
export async function chatComplete(
  conn: ModelConnection,
  messages: readonly ChatMessage[],
  options: {
    temperature?: number
    maxTokens?: number
    jsonMode?: boolean
    signal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<ChatResult> {
  const url = joinEndpoint(conn.baseUrl, '/chat/completions')
  const signal = combineSignals(options.signal, options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS)
  const body: Record<string, unknown> = {
    model: conn.model,
    messages,
    temperature: options.temperature ?? 0.2,
  }
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.jsonMode) body.response_format = { type: 'json_object' }

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
    throw new Error(`对话模型接口失败：${await readErrorBody(res)}`)
  }

  const payload = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const rawContent = payload.choices?.[0]?.message?.content
  let content = ''
  if (typeof rawContent === 'string') {
    content = rawContent
  } else if (Array.isArray(rawContent)) {
    content = rawContent
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  }
  return {
    content: content.trim(),
    promptTokens: Number(payload.usage?.prompt_tokens ?? 0),
    completionTokens: Number(payload.usage?.completion_tokens ?? 0),
  }
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
