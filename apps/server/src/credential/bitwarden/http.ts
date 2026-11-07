import { VaultError } from './types'

// 向密码库发请求。服务器地址由成员填写，可能指向内网：响应正文只在这里解析成 JSON 交给调用方的解析函数，
// 不以任何形式（错误信息、cause、日志）透出去。给调用方的错误文字只写类别（无法连接、超时、意外的响应），
// 不写错误代码与状态码，否则能拿服务器地址探测内网的端口；这些细节只交给 log，log 也不带响应正文

// 内部日志里记的细节：哪一类问题，加上状态码、连接错误的代码，或者哪个接口的响应缺了什么（只有字段名，不带正文）。
// error 是 onSecretsChanged 抛的错误经 loggableError 处理之后的样子
export interface VaultDiagnostic {
  what: 'connect' | 'timeout' | 'redirect' | 'status' | 'too_large' | 'format' | 'secrets_not_saved'
  status?: number
  code?: string
  endpoint?: string
  problem?: string
  error?: unknown
}

export interface HttpOptions {
  fetch: typeof fetch
  timeoutMs: number
  log: (diagnostic: VaultDiagnostic) => void
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

const OFFICIAL = new Map<string, VaultEndpoints>([
  [
    'vault.bitwarden.com',
    { api: 'https://api.bitwarden.com', identity: 'https://identity.bitwarden.com' },
  ],
  [
    'vault.bitwarden.eu',
    { api: 'https://api.bitwarden.eu', identity: 'https://identity.bitwarden.eu' },
  ],
])

// http 只给两种地址：本机回环地址（测试与装在同一台机器上的密码库），和不带点的单段主机名
// （同一个 Docker 网络里的服务名，例如 vaultwarden）。别的地址要 https：令牌与密文不能明文过网络
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
// 单段的主机名全是数字（或 0x 开头的十六进制）时，URL 把它当成 IPv4 地址，规范成带点的写法
// （http://3232235777 → 192.168.1.1），不是服务名
const NUMERIC_HOST = /^(?:\d+|0x[0-9a-f]*)$/i
const SERVICE_NAME = /^[a-z0-9-]+$/i

export const PLAIN_HTTP_RULE =
  '服务器地址须使用 https；本机地址与同一个 Docker 网络里的服务名（不带点的主机名）可以用 http'

// 按写下的主机名判断，不用 URL 解析之后的：解析会把数字写法的主机名换成 IPv4 地址。规则和契约的 VaultServerUrl 一致
function plainHttpAllowed(host: string): boolean {
  const name = host.toLowerCase()
  if (LOOPBACK.has(name)) return true
  return SERVICE_NAME.test(name) && !NUMERIC_HOST.test(name)
}

// 地址里写下的主机名：去掉协议、路径与端口；IPv6 地址带着方括号
function writtenHost(serverUrl: string): string {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\]*)/i.exec(serverUrl.trim())?.[1] ?? ''
  return authority.replace(/:\d*$/, '')
}

// 地址不能用的原因，能用时为 null。登录之前也用它检查，地址的问题不当作连不上
export function serverUrlProblem(serverUrl: string): string | null {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    return '服务器地址无效'
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    return '服务器地址无效'
  }
  if (url.protocol === 'http:' && !plainHttpAllowed(writtenHost(serverUrl))) return PLAIN_HTTP_RULE
  return null
}

export function vaultEndpoints(serverUrl: string): VaultEndpoints {
  const problem = serverUrlProblem(serverUrl)
  if (problem) throw new VaultError('unreachable', problem)
  const url = new URL(serverUrl)
  const official = url.protocol === 'https:' && !url.port ? OFFICIAL.get(url.hostname) : undefined
  if (official) return official
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  return { api: `${base}/api`, identity: `${base}/identity` }
}

// 连接错误：日志里只记错误代码（例如 ECONNREFUSED），不用错误自己的文字（可能带着请求头）
function connectFailure(http: HttpOptions, err: unknown): VaultError {
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    http.log({ what: 'timeout' })
    return new VaultError('unreachable', '连接密码库超时')
  }
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
  http.log({
    what: 'connect',
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { code } : {}),
  })
  return new VaultError('unreachable', '无法连接密码库')
}

const UNEXPECTED = '密码库返回了意外的响应'

// 到时限就取消读取：fetch 自己按 signal 中止正文，这里再管一道，换了 fetch 实现（测试注入的）也一样
async function readBody(http: HttpOptions, res: Response, signal: AbortSignal): Promise<string> {
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
        http.log({ what: 'too_large' })
        throw new VaultError('server_error', UNEXPECTED)
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
    throw connectFailure(http, err)
  }
  // 不跟随重定向：跳到哪里由服务器决定，可能是别的主机
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {})
    http.log({ what: 'redirect', status: res.status })
    throw new VaultError('server_error', UNEXPECTED)
  }
  let text: string
  try {
    text = await readBody(http, res, signal)
  } catch (err) {
    if (err instanceof VaultError) throw err
    throw connectFailure(http, signal.aborted ? signal.reason : err)
  }
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

export function unexpectedStatus(http: HttpOptions, status: number): VaultError {
  http.log({ what: 'status', status })
  return new VaultError('server_error', UNEXPECTED)
}

// 响应缺字段或格式不对。problem 只写哪个字段、哪类问题，不带正文；在请求所在的地方经 formatLogged 记进日志
export class VaultFormatError extends VaultError {
  constructor(readonly problem: string) {
    super('server_error', UNEXPECTED)
  }
}

export const badResponse = (problem: string) => new VaultFormatError(problem)

// 解析某个接口的响应：格式不对时记下接口与问题，再照样抛出
export function formatLogged<T>(http: HttpOptions, endpoint: string, parse: () => T): T {
  try {
    return parse()
  } catch (err) {
    if (err instanceof VaultFormatError)
      http.log({ what: 'format', endpoint, problem: err.problem })
    throw err
  }
}

// 字段名大小写：Bitwarden 的接口是 camelCase，旧版 Vaultwarden 有 PascalCase 的，两种都认
export function prop(obj: unknown, name: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  const record = obj as Record<string, unknown>
  if (Object.hasOwn(record, name)) return record[name]
  const pascal = name[0]!.toUpperCase() + name.slice(1)
  return Object.hasOwn(record, pascal) ? record[pascal] : undefined
}

export function str(obj: unknown, name: string): string | undefined {
  const value = prop(obj, name)
  return typeof value === 'string' ? value : undefined
}

export function requireStr(obj: unknown, name: string): string {
  const value = str(obj, name)
  if (value === undefined) throw badResponse(`missing ${name}`)
  return value
}
