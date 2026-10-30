import type { z } from 'zod'

// 后端返回的业务错误统一是 { error }；这里把状态码和提示一起带出来，页面按状态码决定怎么处理
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
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
  const res = await fetch(url, {
    method,
    headers: options.body === undefined || form ? {} : { 'content-type': 'application/json' },
    body:
      options.body === undefined
        ? undefined
        : form
          ? (options.body as FormData)
          : JSON.stringify(options.body),
    signal: options.signal,
  })
  if (!res.ok) {
    if (res.status === 401 && !SESSION_PATHS.includes(path)) onUnauthorized?.()
    const payload = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, payload?.error ?? `请求失败：HTTP ${res.status}`)
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
