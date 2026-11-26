import type { ReasoningEffort, TaskReasoningEffort, TestModelResponse } from '@kioku/contracts'

import { EMBEDDING_DIMENSIONS } from '../db/schema'

export interface ModelConnection {
  baseUrl: string
  model: string
  apiKey: string | null
  reasoningEffort?: ReasoningEffort | undefined
  taskReasoningEffort?: TaskReasoningEffort | undefined
}

export type ChatTaskKind = 'fast' | 'organize'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  content: string
  promptTokens: number
  completionTokens: number
  finishReason?: string | null | undefined
}

export type ModelErrorCategory =
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'stream_truncated'
  | 'network'
  | 'auth'
  | 'quota'
  | 'not_found'
  | 'bad_request'
  | 'context_length'
  | 'length_limit'
  | 'cancelled'
  | 'unknown'

export class ModelClientError extends Error {
  readonly category: ModelErrorCategory
  readonly status: number | null
  readonly retryAfterMs: number | null
  readonly retryable: boolean
  readonly rawDetail: string

  constructor(
    message: string,
    opts: {
      category: ModelErrorCategory
      status?: number | null | undefined
      retryAfterMs?: number | null | undefined
      retryable: boolean
      rawDetail?: string | undefined
      cause?: unknown
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'ModelClientError'
    this.category = opts.category
    this.status = opts.status ?? null
    this.retryAfterMs = opts.retryAfterMs ?? null
    this.retryable = opts.retryable
    this.rawDetail = opts.rawDetail ?? message
  }
}

export interface RetryCallbackInfo {
  attempt: number
  delayMs: number
  error: ModelClientError
}

export interface EmbedTextsOptions {
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  maxRetries?: number | undefined
  retryBaseMs?: number | undefined
  retryMaxMs?: number | undefined
  onRetry?: ((info: RetryCallbackInfo) => void) | undefined
}

export interface ChatCompleteOptions {
  temperature?: number | undefined
  maxTokens?: number | undefined
  jsonMode?: boolean | undefined
  stream?: boolean | undefined
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  idleTimeoutMs?: number | undefined
  taskKind?: ChatTaskKind | undefined
  reasoningEffort?: ReasoningEffort | undefined
  allowReasoningFallback?: boolean | undefined
  maxRetries?: number | undefined
  retryBaseMs?: number | undefined
  retryMaxMs?: number | undefined
  onRetry?: ((info: RetryCallbackInfo) => void) | undefined
}

const DEFAULT_EMBED_TIMEOUT_MS = 30_000
const DEFAULT_CHAT_TIMEOUT_MS = 60_000
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 45_000
const DEFAULT_RETRY_BASE_MS = 1_000
const DEFAULT_RETRY_MAX_MS = 30_000
const RETRY_AFTER_MAX_MS = 60_000
const REASONING_CACHE_TTL_MS = 3_600_000
const REASONING_CACHE_MAX_SIZE = 128

const REASONING_MAX_TOKENS_BONUS: Record<'low' | 'medium' | 'high', number> = {
  low: 2_000,
  medium: 4_000,
  high: 8_000,
}

const STREAM_UNSUPPORTED_RE = /\bstream(?:ing)?\b|流式/i
const TEMPERATURE_UNSUPPORTED_RE = /\btemperature\b/i
const REASONING_EXPLICIT_RE = /reasoning[_ -]?effort|\bthinking\b|does not support .*reasoning/i
const GENERIC_PARAM_UNSUPPORTED_RE =
  /unknown (?:field|parameter)|unrecognized request argument|unsupported (?:parameter|value|field)|extra inputs are not permitted/i
const OTHER_PARAM_NAMED_RE =
  /\b(?:max_tokens|max_completion_tokens|response_format|messages|tools|tool_choice|top_p|presence_penalty|frequency_penalty|seed|stop)\b/i
const QUOTA_ERROR_RE =
  /insufficient_quota|exceeded your current quota|quota exceeded|billing|credit balance|余额不足|额度(?:不足|已用尽|耗尽)/i
const CONTEXT_LENGTH_RE =
  /context_length_exceeded|maximum context length|too many tokens|prompt is too long|input.*too long|上下文.*超/i

function isReasoningUnsupportedError(detail: string): boolean {
  if (REASONING_EXPLICIT_RE.test(detail)) return true
  return GENERIC_PARAM_UNSUPPORTED_RE.test(detail) && !OTHER_PARAM_NAMED_RE.test(detail)
}
const TRANSIENT_PAYLOAD_ERROR_RE =
  /rate.?limit|too many requests|overloaded|gateway timeout|temporarily unavailable|try again|service unavailable|bad gateway/i
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])
const LEADING_THINK_BLOCK_RE = /^\s*(?:<think\b[^>]*>[\s\S]*?<\/think>\s*)+/i

// 进程内缓存上游不支持指定 reasoning_effort 的端点，避免批处理逐条撞 400
const reasoningUnsupportedCache = new Map<string, number>()

function reasoningCacheKey(baseUrl: string, model: string, effort: ReasoningEffort): string {
  return `${baseUrl.replace(/\/+$/, '')}\0${model}\0${effort}`
}

function isReasoningCachedUnsupported(
  baseUrl: string,
  model: string,
  effort: ReasoningEffort,
): boolean {
  const key = reasoningCacheKey(baseUrl, model, effort)
  const expiresAt = reasoningUnsupportedCache.get(key)
  if (expiresAt === undefined) return false
  if (expiresAt <= Date.now()) {
    reasoningUnsupportedCache.delete(key)
    return false
  }
  return true
}

function markReasoningUnsupported(baseUrl: string, model: string, effort: ReasoningEffort): void {
  const key = reasoningCacheKey(baseUrl, model, effort)
  if (reasoningUnsupportedCache.size >= REASONING_CACHE_MAX_SIZE) {
    const oldest = reasoningUnsupportedCache.keys().next().value
    if (oldest !== undefined) reasoningUnsupportedCache.delete(oldest)
  }
  reasoningUnsupportedCache.set(key, Date.now() + REASONING_CACHE_TTL_MS)
}

export function clearReasoningFallbackCache(): void {
  reasoningUnsupportedCache.clear()
}

// 剥离网关 thinking_to_content 拼在正文开头的 <think>...</think> 块，不改动 JSON 正文内部的字面文本
export function stripThinkTags(text: string): string {
  return text.replace(LEADING_THINK_BLOCK_RE, '').trim()
}

export function resolveEffectiveReasoningEffort(
  conn: Pick<ModelConnection, 'reasoningEffort' | 'taskReasoningEffort'>,
  options: Pick<ChatCompleteOptions, 'reasoningEffort' | 'taskKind'>,
): ReasoningEffort {
  if (options.reasoningEffort !== undefined) return options.reasoningEffort
  if (options.taskKind && conn.taskReasoningEffort?.[options.taskKind] !== undefined) {
    return conn.taskReasoningEffort[options.taskKind]!
  }
  return conn.reasoningEffort ?? 'default'
}

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

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null
  const trimmed = headerValue.trim()
  if (!trimmed) return null
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(RETRY_AFTER_MAX_MS, Math.round(seconds * 1000))
  }
  const ts = Date.parse(trimmed)
  if (!Number.isNaN(ts)) {
    const delta = ts - Date.now()
    if (delta > 0) return Math.min(RETRY_AFTER_MAX_MS, delta)
  }
  return null
}

function classifyFetchError(err: unknown, callerSignal: AbortSignal | undefined): ModelClientError {
  if (err instanceof ModelClientError) return err
  if (callerSignal?.aborted) {
    return new ModelClientError('请求已取消', {
      category: 'cancelled',
      retryable: false,
      cause: err,
    })
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return new ModelClientError('请求超时', {
        category: 'timeout',
        retryable: true,
        cause: err,
      })
    }
    const cause = err.cause as { code?: unknown; message?: unknown } | undefined
    if (typeof cause?.code === 'string') {
      return new ModelClientError(`无法连接模型服务（${cause.code}）`, {
        category: 'network',
        retryable: true,
        rawDetail: cause.code,
        cause: err,
      })
    }
    return new ModelClientError(err.message, {
      category: 'network',
      retryable: true,
      rawDetail: err.message,
      cause: err,
    })
  }
  return new ModelClientError(String(err), {
    category: 'network',
    retryable: true,
    rawDetail: String(err),
  })
}

async function readErrorDetail(res: Response): Promise<{ detail: string; rawBody: string }> {
  try {
    const rawBody = (await res.text()).slice(0, 1000).trim()
    const detail = rawBody ? `HTTP ${res.status}: ${rawBody.slice(0, 300)}` : `HTTP ${res.status}`
    return { detail, rawBody }
  } catch {
    return { detail: `HTTP ${res.status}`, rawBody: '' }
  }
}

function classifyHttpError(
  prefix: string,
  res: Response,
  detail: string,
  rawBody: string,
): ModelClientError {
  const status = res.status
  const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
  const message = `${prefix}：${detail}`

  if (status === 401 || status === 403) {
    return new ModelClientError(message, {
      category: 'auth',
      status,
      retryable: false,
      rawDetail: rawBody || detail,
    })
  }
  if (status === 402 || ((status === 400 || status === 422) && QUOTA_ERROR_RE.test(rawBody))) {
    return new ModelClientError(message, {
      category: 'quota',
      status,
      retryable: false,
      rawDetail: rawBody || detail,
    })
  }
  if (status === 404) {
    return new ModelClientError(message, {
      category: 'not_found',
      status,
      retryable: false,
      rawDetail: rawBody || detail,
    })
  }
  if (status === 413 || ((status === 400 || status === 422) && CONTEXT_LENGTH_RE.test(rawBody))) {
    return new ModelClientError(message, {
      category: 'context_length',
      status,
      retryable: false,
      rawDetail: rawBody || detail,
    })
  }
  if (status === 429) {
    if (QUOTA_ERROR_RE.test(rawBody)) {
      return new ModelClientError(message, {
        category: 'quota',
        status,
        retryable: false,
        rawDetail: rawBody || detail,
      })
    }
    return new ModelClientError(message, {
      category: 'rate_limit',
      status,
      retryAfterMs,
      retryable: true,
      rawDetail: rawBody || detail,
    })
  }
  if (status === 408) {
    return new ModelClientError(message, {
      category: 'timeout',
      status,
      retryable: true,
      rawDetail: rawBody || detail,
    })
  }
  if (RETRYABLE_HTTP_STATUS.has(status)) {
    return new ModelClientError(message, {
      category: 'server',
      status,
      retryAfterMs,
      retryable: true,
      rawDetail: rawBody || detail,
    })
  }
  if (status === 400 || status === 422) {
    return new ModelClientError(message, {
      category: 'bad_request',
      status,
      retryable: false,
      rawDetail: rawBody || detail,
    })
  }
  return new ModelClientError(message, {
    category: 'unknown',
    status,
    retryable: false,
    rawDetail: rawBody || detail,
  })
}

function classifyPayloadError(prefix: string, errMsg: string): ModelClientError {
  const message = `${prefix}：${errMsg}`
  if (QUOTA_ERROR_RE.test(errMsg)) {
    return new ModelClientError(message, {
      category: 'quota',
      status: 200,
      retryable: false,
      rawDetail: errMsg,
    })
  }
  if (CONTEXT_LENGTH_RE.test(errMsg)) {
    return new ModelClientError(message, {
      category: 'context_length',
      status: 200,
      retryable: false,
      rawDetail: errMsg,
    })
  }
  if (TRANSIENT_PAYLOAD_ERROR_RE.test(errMsg)) {
    return new ModelClientError(message, {
      category: /rate.?limit|too many requests/i.test(errMsg) ? 'rate_limit' : 'server',
      status: 200,
      retryable: true,
      rawDetail: errMsg,
    })
  }
  return new ModelClientError(message, {
    category: 'unknown',
    status: 200,
    retryable: false,
    rawDetail: errMsg,
  })
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      return Promise.reject(
        new ModelClientError('请求已取消', { category: 'cancelled', retryable: false }),
      )
    }
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ModelClientError('请求已取消', { category: 'cancelled', retryable: false }))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ModelClientError('请求已取消', { category: 'cancelled', retryable: false }))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function computeRetryDelayMs(
  err: ModelClientError,
  attempt: number,
  retryBaseMs: number,
  retryMaxMs: number,
): number {
  if (err.retryAfterMs !== null) {
    const minWait = Math.min(1_000, retryBaseMs)
    return Math.min(RETRY_AFTER_MAX_MS, Math.max(minWait, err.retryAfterMs))
  }
  const cap = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1))
  // Full Jitter：在 [0, cap] 内均匀抖动，至少保留极短间隔防同步热重试
  return Math.max(Math.min(cap, 10), Math.floor(Math.random() * (cap + 1)))
}

async function withRetries<T>(
  run: () => Promise<T>,
  options: {
    maxRetries?: number | undefined
    retryBaseMs?: number | undefined
    retryMaxMs?: number | undefined
    signal?: AbortSignal | undefined
    onRetry?: ((info: RetryCallbackInfo) => void) | undefined
  },
): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 0)
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS)
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)

  let attempt = 0
  for (;;) {
    try {
      return await run()
    } catch (err) {
      const classified = classifyFetchError(err, options.signal)
      if (!classified.retryable || attempt >= maxRetries || options.signal?.aborted) {
        throw classified
      }
      attempt++
      const delayMs = computeRetryDelayMs(classified, attempt, retryBaseMs, retryMaxMs)
      options.onRetry?.({ attempt, delayMs, error: classified })
      await abortableSleep(delayMs, options.signal)
    }
  }
}

// 调用 OpenAI 兼容 /embeddings 接口，校验返回向量数量与维度（1024 维）
export async function embedTexts(
  conn: ModelConnection,
  texts: readonly string[],
  options: EmbedTextsOptions = {},
): Promise<number[][]> {
  if (!texts.length) return []
  const url = joinEndpoint(conn.baseUrl, '/embeddings')
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS

  return withRetries(async () => {
    const signal = combineSignals(options.signal, timeoutMs)

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
      throw classifyFetchError(err, options.signal)
    }

    if (!res.ok) {
      const { detail, rawBody } = await readErrorDetail(res)
      throw classifyHttpError('嵌入接口失败', res, detail, rawBody)
    }

    let payload: {
      data?: { index?: number; embedding?: unknown }[]
    }
    try {
      payload = (await res.json()) as {
        data?: { index?: number; embedding?: unknown }[]
      }
    } catch (err) {
      throw classifyFetchError(err, options.signal)
    }
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new ModelClientError(
        `嵌入接口返回条数不匹配：期望 ${texts.length}，实际 ${payload.data?.length ?? 0}`,
        { category: 'unknown', retryable: false },
      )
    }

    const ordered = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const vectors: number[][] = []
    for (const item of ordered) {
      if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMENSIONS) {
        const actual = Array.isArray(item.embedding) ? item.embedding.length : 0
        throw new ModelClientError(
          `嵌入向量维度不匹配：需要 ${EMBEDDING_DIMENSIONS} 维，模型返回了 ${actual} 维`,
          { category: 'bad_request', retryable: false },
        )
      }
      vectors.push(item.embedding.map(Number))
    }
    return vectors
  }, options)
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
    finish_reason?: unknown
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

function finalizeChatResult(
  rawContent: string,
  promptTokens: number,
  completionTokens: number,
  finishReason: string | null,
  jsonMode: boolean,
): ChatResult {
  const content = stripThinkTags(rawContent)
  if (finishReason === 'length' && (jsonMode || !content)) {
    throw new ModelClientError('对话模型输出达到长度上限被截断', {
      category: 'length_limit',
      retryable: false,
      rawDetail: 'finish_reason=length',
    })
  }
  return {
    content,
    promptTokens,
    completionTokens,
    finishReason,
  }
}

function parseChatPayload(payload: unknown, jsonMode: boolean): ChatResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ModelClientError('对话模型接口返回空或非对象响应', {
      category: 'unknown',
      retryable: false,
    })
  }
  const rec = payload as ChatCompletionPayload
  const errMsg = extractPayloadError(rec.error)
  if (errMsg) throw classifyPayloadError('对话模型接口失败', errMsg)
  const promptTokens = typeof rec.usage?.prompt_tokens === 'number' ? rec.usage.prompt_tokens : 0
  const completionTokens =
    typeof rec.usage?.completion_tokens === 'number' ? rec.usage.completion_tokens : 0
  const choice = rec.choices?.[0]
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
  return finalizeChatResult(
    extractMessageText(choice?.message?.content),
    promptTokens,
    completionTokens,
    finishReason,
    jsonMode,
  )
}

async function readChatJson(
  res: Response,
  jsonMode: boolean,
  callerSignal: AbortSignal | undefined,
): Promise<ChatResult> {
  let payload: unknown
  try {
    payload = await res.json()
  } catch (err) {
    throw classifyFetchError(err, callerSignal)
  }
  return parseChatPayload(payload, jsonMode)
}

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
}

async function readChunkWithIdleTimeout(
  reader: ChunkReader,
  idleTimeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array | undefined }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ModelClientError('请求超时（流式输出长时间无响应）', {
              category: 'timeout',
              retryable: true,
              rawDetail: `sse_idle_timeout_${idleTimeoutMs}ms`,
            }),
          )
        }, idleTimeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// 消费 OpenAI 兼容 SSE 流：按事件块聚合多行 data，只收集 delta.content（推理段保活），检测空闲僵死、提前截断与长度上限
async function readChatEventStream(
  res: Response,
  options: {
    jsonMode: boolean
    idleTimeoutMs: number
    callerSignal: AbortSignal | undefined
  },
): Promise<ChatResult> {
  if (!res.body) {
    throw new ModelClientError('对话模型流式响应为空', {
      category: 'stream_truncated',
      retryable: true,
      rawDetail: 'sse_empty_body',
    })
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let promptTokens = 0
  let completionTokens = 0
  let finishReason: string | null = null
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
        throw classifyPayloadError('对话模型接口失败', '上游返回流式错误')
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
        throw classifyPayloadError('对话模型接口失败', rawData.slice(0, 300))
      }
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const chunk = parsed as ChatCompletionPayload
    const errMsg = extractPayloadError(chunk.error)
    if (errMsg || currentEvent === 'error') {
      throw classifyPayloadError('对话模型接口失败', errMsg ?? rawData.slice(0, 300))
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
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      finishReason = choice.finish_reason
    }
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
      const step = await readChunkWithIdleTimeout(reader, options.idleTimeoutMs)
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
    if (err instanceof ModelClientError) throw err
    throw classifyFetchError(err, options.callerSignal)
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  // 上游未按 SSE 返回（例如 text/plain JSON 或反代 200 错误页）时显式回退解析或报错，避免静默返回空串
  if (!sawSsePrefix && parts.length === 0) {
    const raw = nonSseLines.join('\n').trim()
    if (raw.startsWith('{')) {
      try {
        return parseChatPayload(JSON.parse(raw), options.jsonMode)
      } catch (err) {
        if (err instanceof ModelClientError) throw err
      }
    }
    if (raw) {
      throw new ModelClientError(`对话模型接口返回异常内容：${raw.slice(0, 120)}`, {
        category: 'unknown',
        retryable: false,
      })
    }
    throw new ModelClientError('对话模型流式响应为空', {
      category: 'stream_truncated',
      retryable: true,
      rawDetail: 'sse_empty_body',
    })
  }

  if (sawSsePrefix && !done && !finishReason) {
    throw new ModelClientError('对话模型流式输出意外中断（未收到结束标记）', {
      category: 'stream_truncated',
      retryable: true,
      rawDetail: 'sse_missing_done',
    })
  }

  return finalizeChatResult(
    parts.join(''),
    promptTokens,
    completionTokens,
    finishReason,
    options.jsonMode,
  )
}

// 调用 OpenAI 兼容 /chat/completions 接口；支持思考等级透传与降级、流式保活及传输层指数退避重试
export async function chatComplete(
  conn: ModelConnection,
  messages: readonly ChatMessage[],
  options: ChatCompleteOptions = {},
): Promise<ChatResult> {
  const url = joinEndpoint(conn.baseUrl, '/chat/completions')
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
  const idleTimeoutMs = Math.min(options.idleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS, timeoutMs)
  const effectiveEffort = resolveEffectiveReasoningEffort(conn, options)
  const allowReasoningFallback = options.allowReasoningFallback !== false
  const jsonMode = Boolean(options.jsonMode)

  return withRetries(async () => {
    const signal = combineSignals(options.signal, timeoutMs)

    const initialIncludeReasoning =
      effectiveEffort !== 'default' &&
      (!allowReasoningFallback ||
        !isReasoningCachedUnsupported(conn.baseUrl, conn.model, effectiveEffort))

    const send = async (
      flags: {
        useStream: boolean
        includeReasoning: boolean
        includeTemperature: boolean
      },
      downgradesLeft = 3,
    ): Promise<ChatResult> => {
      const body: Record<string, unknown> = {
        model: conn.model,
        messages,
      }
      if (flags.includeTemperature) {
        body.temperature = options.temperature ?? 0.2
      }
      if (flags.includeReasoning && effectiveEffort !== 'default') {
        body.reasoning_effort = effectiveEffort === 'off' ? 'none' : effectiveEffort
      }
      if (options.maxTokens !== undefined) {
        const bonus =
          flags.includeReasoning &&
          (effectiveEffort === 'low' || effectiveEffort === 'medium' || effectiveEffort === 'high')
            ? REASONING_MAX_TOKENS_BONUS[effectiveEffort]
            : 0
        body.max_tokens = options.maxTokens + bonus
      }
      if (jsonMode) body.response_format = { type: 'json_object' }
      if (flags.useStream) body.stream = true

      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: authHeaders(conn.apiKey),
          body: JSON.stringify(body),
          signal,
        })
      } catch (err) {
        throw classifyFetchError(err, options.signal)
      }

      if (!res.ok) {
        const { detail, rawBody } = await readErrorDetail(res)
        const errorText = rawBody || detail
        if (
          (res.status === 400 || res.status === 422) &&
          downgradesLeft > 0 &&
          !CONTEXT_LENGTH_RE.test(errorText) &&
          !QUOTA_ERROR_RE.test(errorText)
        ) {
          if (flags.useStream && STREAM_UNSUPPORTED_RE.test(errorText)) {
            return send({ ...flags, useStream: false }, downgradesLeft - 1)
          }
          if (flags.includeTemperature && TEMPERATURE_UNSUPPORTED_RE.test(errorText)) {
            return send({ ...flags, includeTemperature: false }, downgradesLeft - 1)
          }
          if (
            flags.includeReasoning &&
            allowReasoningFallback &&
            effectiveEffort !== 'default' &&
            isReasoningUnsupportedError(errorText)
          ) {
            // 仅在剥离思考参数后重试成功时才写入降级缓存，避免无关 400 误污染缓存
            const fallbackResult = await send(
              { ...flags, includeReasoning: false },
              downgradesLeft - 1,
            )
            markReasoningUnsupported(conn.baseUrl, conn.model, effectiveEffort)
            return fallbackResult
          }
        }
        throw classifyHttpError('对话模型接口失败', res, detail, rawBody)
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
      if (flags.useStream && !contentType.includes('application/json')) {
        return readChatEventStream(res, {
          jsonMode,
          idleTimeoutMs,
          callerSignal: options.signal,
        })
      }
      return readChatJson(res, jsonMode, options.signal)
    }

    return send({
      useStream: Boolean(options.stream),
      includeReasoning: initialIncludeReasoning,
      includeTemperature: true,
    })
  }, options)
}

export async function testModelConnection(
  kind: 'embedding' | 'chat_llm',
  conn: ModelConnection,
): Promise<TestModelResponse> {
  const start = Date.now()
  try {
    if (kind === 'embedding') {
      const [vec] = await embedTexts(conn, ['kioku connectivity probe'], {
        timeoutMs: 15_000,
        maxRetries: 0,
      })
      return {
        ok: true,
        latencyMs: Date.now() - start,
        dimensions: vec?.length ?? EMBEDDING_DIMENSIONS,
      }
    }
    // 基础 64 叠加 low/medium/high 补偿后分别为 2064/4064/8064，既够思考又不超过常见的 8192 上限
    await chatComplete(conn, [{ role: 'user', content: 'Reply with OK.' }], {
      temperature: 0,
      maxTokens: 64,
      timeoutMs: 25_000,
      maxRetries: 0,
      allowReasoningFallback: false,
    })
    return { ok: true, latencyMs: Date.now() - start }
  } catch (err) {
    const effort = kind === 'chat_llm' ? resolveEffectiveReasoningEffort(conn, {}) : 'default'
    if (
      kind === 'chat_llm' &&
      effort !== 'default' &&
      err instanceof ModelClientError &&
      (err.status === 400 || err.status === 422) &&
      isReasoningUnsupportedError(err.rawDetail)
    ) {
      try {
        await chatComplete(
          { ...conn, reasoningEffort: 'default', taskReasoningEffort: undefined },
          [{ role: 'user', content: 'Reply with OK.' }],
          {
            temperature: 0,
            maxTokens: 64,
            timeoutMs: 15_000,
            maxRetries: 0,
            allowReasoningFallback: false,
          },
        )
        return {
          ok: false,
          latencyMs: Date.now() - start,
          error: '模型可连通，但该接口不支持当前思考等级，建议改选「跟随默认」',
        }
      } catch {
        // 回退探测同样失败时返回原始错误
      }
    }
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
