import { DATABASE_UNAVAILABLE_CODE, URI_FORMAT_MESSAGE } from '@kioku/contracts'
import type { z } from 'zod'

import { URI_FORMAT_HINT } from '../labels'

// 后端返回的业务错误统一是 { error }；这里把状态码和提示一起带出来，页面按状态码决定怎么处理。
// payload 是原样的错误体，有的错误另带字段（记忆写入的 MemoryWriteError 带疑似明文的位置），由调用方按契约解析
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload: unknown = null,
  ) {
    super(message)
  }
}

// 读取失败时显示的文字：服务端给了说明就用它。没有说明时（网络错误、响应格式不符）用 fallback，
// 一页上读好几样的地方传具体的说法，免得几处都只写「读取失败」分不清是哪一样
export function readFailure(error: unknown, fallback = '读取失败'): string {
  return error instanceof ApiError ? error.message : fallback
}

// fetch 本身 reject 了：连不上、断网、代理掐断。和程序自己的错误（同样可能是 TypeError）分开，
// 只有这种值得再试。原来的错误放在 cause 里
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('网络连接失败', { cause })
    this.name = 'NetworkError'
  }
}

// 4xx 里只有这两个是暂时的：请求超时、请求太频繁
const TRANSIENT_STATUSES = [408, 429]
// 超时或取消：fetch 照原样抛出的 DOMException
const ABORTED = ['AbortError', 'TimeoutError']

// 值不值得再读一次：只认服务端暂时的失败（5xx、408、429）、连不上（NetworkError）、超时或取消。
// 401、403、404 这类确定的结果，响应和契约对不上，以及程序自己的错误，再读也一样。
// 查询的自动重试和界面上的「重试」用这同一条规则
export function retryable(error: unknown): boolean {
  if (error instanceof ApiError)
    return error.status >= 500 || TRANSIENT_STATUSES.includes(error.status)
  if (error instanceof NetworkError) return true
  return error instanceof Error && ABORTED.includes(error.name)
}

// 有的报错是写给接口与 MCP 的：URI 格式那句中英并列，前面还带着字段路径（uri：、to：）。界面上换成只说中文的那句
function consoleMessage(message: string): string {
  return message.endsWith(URI_FORMAT_MESSAGE) ? URI_FORMAT_HINT : message
}

type Query = Record<string, string | number | undefined>

interface RequestOptions<T> {
  query?: Query
  body?: unknown
  // 有 schema 时按它校验响应，契约与后端不一致会立刻暴露
  schema?: z.ZodType<T>
  // 取消请求：等得久的请求（请求模型）可以中途停下，这时 fetch 抛 AbortError，不是 ApiError
  signal?: AbortSignal
}

// 会话失效（过期、在别的标签页退出）时的处理，由入口注册；登录与查询当前账号本身返回 401 是正常结果，不触发
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}
const SESSION_PATHS = ['/auth/login', '/auth/me', '/auth/logout']

// 服务没接上数据库（503，带 DATABASE_UNAVAILABLE_CODE）时的处理，由入口注册：回到初始化页
let onDatabaseUnavailable: (() => void) | null = null
export function setDatabaseUnavailableHandler(handler: () => void): void {
  onDatabaseUnavailable = handler
}

// 管理界面与后端同源，用浏览器的会话 Cookie 鉴权；浏览器会自动带上 Sec-Fetch-Site，后端据此做同源检查。
// body 是 FormData 时按表单上传（分隔行由浏览器写进 content-type），其余的按 JSON 发
async function send(method: string, path: string, options: RequestOptions<unknown>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) params.set(key, String(value))
  }
  // 不用 params.size：iOS 16.4 之前的 Safari 等构建目标内的浏览器还不支持它
  const query = params.toString()
  const url = `/v1${path}${query ? `?${query}` : ''}`
  const form = options.body instanceof FormData
  // 请求先在外面拼好：序列化请求体出的错是程序的问题，不能算成网络错误
  const init: RequestInit = {
    method,
    headers: options.body === undefined || form ? {} : { 'content-type': 'application/json' },
    body:
      options.body === undefined
        ? undefined
        : form
          ? (options.body as FormData)
          : JSON.stringify(options.body),
    signal: options.signal,
  }
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    // 取消和超时照原样抛：调用方靠 AbortError 认出是自己停下的
    if (err instanceof Error && ABORTED.includes(err.name)) throw err
    throw new NetworkError(err)
  }
  if (!res.ok) {
    if (res.status === 401 && !SESSION_PATHS.includes(path)) onUnauthorized?.()
    const payload = (await res.json().catch(() => null)) as { error?: string; code?: string } | null
    if (res.status === 503 && payload?.code === DATABASE_UNAVAILABLE_CODE) onDatabaseUnavailable?.()
    throw new ApiError(
      res.status,
      consoleMessage(payload?.error ?? `请求失败：HTTP ${res.status}`),
      payload,
    )
  }
  return res
}

export async function request<T = void>(
  method: string,
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  const res = await send(method, path, options as RequestOptions<unknown>)
  if (res.status === 204 || !options.schema) return undefined as T
  return options.schema.parse(await res.json())
}

// 响应是要下载的文件：整个读成 Blob，连同服务端在 Content-Disposition 里给的文件名
export async function download(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ blob: Blob; filename: string | null }> {
  const res = await send(method, path, { body })
  return {
    blob: await res.blob(),
    filename: attachmentName(res.headers.get('content-disposition')),
  }
}

// 取 Content-Disposition 里的文件名：优先 filename*（UTF-8，中文名在这里），其次 filename
export function attachmentName(header: string | null): string | null {
  if (!header) return null
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim())
    } catch {
      // 编码不对时退回普通的文件名
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? null
}
