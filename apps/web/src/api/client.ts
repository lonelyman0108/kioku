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
}

// 管理界面与后端同源，用浏览器的会话 Cookie 鉴权；浏览器会自动带上 Sec-Fetch-Site，后端据此做同源检查
export async function request<T = void>(
  method: string,
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) params.set(key, String(value))
  }
  const url = `/v1${path}${params.size ? `?${params}` : ''}`
  const res = await fetch(url, {
    method,
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, payload?.error ?? `请求失败：HTTP ${res.status}`)
  }
  if (res.status === 204 || !options.schema) return undefined as T
  return options.schema.parse(await res.json())
}
