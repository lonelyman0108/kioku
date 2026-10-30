import { MemoryError } from '../memory/service'

// 由服务端向 Lore 拉取导出（GET /api/backup?action=export）。只读这一个接口；Lore 的 Token 权限很大
// （同一个 Token 能 POST restore 清空整个库），所以不保存、不进日志。报错和日志都不带对方返回的内容，
// 也不带填写的地址：fetch 与 JSON 解析自己的错误文字里有这些，一律换成固定文字，日志只记主机与错误类别。
// 这是服务端向任意地址发请求，只给实例管理员（路由里查）

// 完整导出的上限，和上传的（裁剪之后的）分开：这里读的是全量，读完解析之后立刻丢弃
const LORE_FETCH_MAX_BYTES = 128 * 1024 * 1024
const LORE_FETCH_TIMEOUT_MS = 120_000

export interface LoreFetchLimits {
  maxBytes: number
  timeoutMs: number
}

// 地址：只允许 http 与 https，不能带账号密码、查询与片段
export function loreExportUrl(address: string): URL {
  let base: URL
  try {
    base = new URL(address.trim())
  } catch {
    throw new MemoryError(400, 'Lore 地址不是合法的网址')
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new MemoryError(400, 'Lore 地址只支持 http 与 https')
  }
  if (base.username || base.password) {
    throw new MemoryError(400, 'Lore 地址里不能带账号密码，Token 单独填')
  }
  if (base.search || base.hash) {
    throw new MemoryError(400, 'Lore 地址里不能带查询或片段，填到服务的根路径就好')
  }
  const root = base.href.endsWith('/') ? base.href : `${base.href}/`
  return new URL('api/backup?action=export', root)
}

// 读响应正文，累计解压之后的字节数，超过上限就停下
async function readLimited(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'))
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of res.body ?? []) {
    total += chunk.length
    if (total > maxBytes) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// 拉到的导出解析成 JSON 返回，内容由 parseLoreBackup 校验。signal 是请求的：客户端断开就不再等 Lore
export async function fetchLoreBackup(
  source: { url: string; token: string },
  signal: AbortSignal | undefined,
  limits: LoreFetchLimits = { maxBytes: LORE_FETCH_MAX_BYTES, timeoutMs: LORE_FETCH_TIMEOUT_MS },
): Promise<unknown> {
  const url = loreExportUrl(source.url)
  const fail = (kind: string, message: string) => {
    console.warn('拉取 Lore 的导出失败', { host: url.host, kind })
    return new MemoryError(400, message)
  }
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const failed = () =>
    timeout.aborted
      ? fail('timeout', `${limits.timeoutMs / 1000} 秒内没有拉完 Lore 的导出`)
      : signal?.aborted
        ? fail('aborted', '请求已经断开')
        : fail('network', '连不上 Lore，或者连接中途断了')
  let res: Response
  try {
    res = await fetch(url, {
      headers: source.token ? { authorization: `Bearer ${source.token}` } : {},
      // 不跟随重定向：Token 会跟着发到别的地址
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch {
    throw failed()
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    if (res.status >= 300 && res.status < 400) {
      throw fail('redirect', 'Lore 返回了重定向，这里不跟随：填重定向之后的地址')
    }
    if (res.status === 401 || res.status === 403) {
      throw fail('unauthorized', 'Lore 拒绝了这个 Token')
    }
    throw fail('status', `Lore 返回了错误（HTTP ${res.status}）`)
  }
  let body: Buffer | null
  try {
    body = await readLimited(res, limits.maxBytes)
  } catch {
    throw failed()
  }
  if (!body) {
    throw fail(
      'tooLarge',
      `Lore 的导出超过 ${limits.maxBytes / 1024 / 1024} MB 的上限：导出时不要带召回事件`,
    )
  }
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw fail('json', 'Lore 返回的不是 JSON：确认地址填到了 Lore 服务的根路径')
  }
}
