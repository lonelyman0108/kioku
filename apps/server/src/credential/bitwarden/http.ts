import { VaultError } from './types'

// 向密码库发请求。服务器地址由成员填写，可能指向内网：响应正文只在这里解析成 JSON 交给调用方的解析函数，
// 不以任何形式（错误信息、cause、日志）透出去；错误信息只写类别与状态码

export interface HttpOptions {
  fetch: typeof fetch
  timeoutMs: number
}

export interface HttpResponse {
  status: number
  // 正文不是 JSON 时为 undefined
  json: unknown
}

// 响应正文的上限。同步的响应随条目数增长，几千个条目也只有几 MB
const MAX_BODY_BYTES = 32 * 1024 * 1024

// 地址的写法：官方服务的网页版地址换成它的接口与身份服务地址，其余的（Vaultwarden 等）都在同一个主机的 /api 与 /identity 下
export interface VaultEndpoints {
  api: string
  identity: string
}

const OFFICIAL: Record<string, VaultEndpoints> = {
  'vault.bitwarden.com': {
    api: 'https://api.bitwarden.com',
    identity: 'https://identity.bitwarden.com',
  },
  'vault.bitwarden.eu': {
    api: 'https://api.bitwarden.eu',
    identity: 'https://identity.bitwarden.eu',
  },
}

export function vaultEndpoints(serverUrl: string): VaultEndpoints {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    throw new VaultError('unreachable', '服务器地址无效')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new VaultError('unreachable', '服务器地址无效')
  }
  const official = url.protocol === 'https:' && !url.port ? OFFICIAL[url.hostname] : undefined
  if (official) return official
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  return { api: `${base}/api`, identity: `${base}/identity` }
}

// 连接错误只取错误代码（例如 ECONNREFUSED），不用错误自己的文字
function connectFailure(err: unknown): VaultError {
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new VaultError('unreachable', '连接密码库超时')
  }
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
  const shown = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? `（${code}）` : ''
  return new VaultError('unreachable', `无法连接密码库${shown}`)
}

// 到时限就取消读取：fetch 自己按 signal 中止正文，这里再管一道，换了 fetch 实现（测试注入的）也一样
async function readBody(res: Response, signal: AbortSignal): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const cancel = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      // 取消之后 read 以 done 结束，读到的只是一部分，按超时算
      if (signal.aborted) throw signal.reason
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        cancel()
        throw new VaultError('server_error', '密码库的响应过大')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export async function vaultRequest(
  http: HttpOptions,
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
): Promise<HttpResponse> {
  // 计时覆盖读正文：服务器发完响应头之后不再发正文，也按超时算
  const signal = AbortSignal.timeout(http.timeoutMs)
  let res: Response
  try {
    res = await http.fetch(url, {
      method: init.method,
      headers: { accept: 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: 'manual',
      signal,
    })
  } catch (err) {
    throw connectFailure(err)
  }
  // 不跟随重定向：跳到哪里由服务器决定，可能是别的主机
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {})
    throw new VaultError('server_error', `密码库返回了重定向（${res.status}）`)
  }
  let text: string
  try {
    text = await readBody(res, signal)
  } catch (err) {
    if (err instanceof VaultError) throw err
    throw connectFailure(signal.aborted ? signal.reason : err)
  }
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

export function unexpectedStatus(status: number): VaultError {
  return new VaultError('server_error', `密码库返回了意外的状态码（${status}）`)
}

export const badResponse = () => new VaultError('server_error', '密码库的响应格式无法识别')

// 字段名大小写：Bitwarden 的接口是 camelCase，旧版 Vaultwarden 有 PascalCase 的，两种都认
export function prop(obj: unknown, name: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  const record = obj as Record<string, unknown>
  if (name in record) return record[name]
  const pascal = name[0]!.toUpperCase() + name.slice(1)
  return record[pascal]
}

export function str(obj: unknown, name: string): string | undefined {
  const value = prop(obj, name)
  return typeof value === 'string' ? value : undefined
}

export function requireStr(obj: unknown, name: string): string {
  const value = str(obj, name)
  if (value === undefined) throw badResponse()
  return value
}
