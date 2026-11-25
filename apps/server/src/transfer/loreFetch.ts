import { MemoryError } from '../memory/errors'

// 由服务端向 Lore 拉取导出（GET /api/backup?action=export）。Token 不保存、不进日志，不跟随重定向
const LORE_FETCH_MAX_BYTES = 128 * 1024 * 1024
const LORE_FETCH_TIMEOUT_MS = 120_000

export interface LoreFetchLimits {
  maxBytes: number
  timeoutMs: number
}

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
    throw new MemoryError(400, 'Lore 地址不能包含账号密码，API Token 请单独填写')
  }
  if (/[?#]/.test(base.href)) {
    throw new MemoryError(400, 'Lore 地址不能包含查询或片段，填写到服务根路径即可')
  }
  const root = base.href.endsWith('/') ? base.href : `${base.href}/`
  return new URL('api/backup?action=export', root)
}

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

export async function fetchLoreBackup(
  source: { url: string; token: string },
  signal?: AbortSignal,
  limits: LoreFetchLimits = { maxBytes: LORE_FETCH_MAX_BYTES, timeoutMs: LORE_FETCH_TIMEOUT_MS },
): Promise<unknown> {
  const url = loreExportUrl(source.url)
  const fail = (kind: string, message: string) => {
    console.warn('拉取 Lore 导出失败', { host: url.host, kind })
    return new MemoryError(400, message)
  }
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const failed = () =>
    timeout.aborted
      ? fail('timeout', `${limits.timeoutMs / 1000} 秒内未能拉取完 Lore 的导出`)
      : signal?.aborted
        ? fail('aborted', '请求已断开')
        : fail('network', '无法连接 Lore，或连接中途断开')

  let res: Response
  try {
    res = await fetch(url, {
      headers: source.token ? { authorization: `Bearer ${source.token}` } : {},
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch {
    throw failed()
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    if (res.status >= 300 && res.status < 400) {
      throw fail('redirect', 'Lore 返回了重定向，此处不跟随，请填写重定向后的地址')
    }
    if (res.status === 401 || res.status === 403) {
      throw fail('unauthorized', 'Lore 拒绝了此 API Token')
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
      `Lore 导出超过 ${limits.maxBytes / 1024 / 1024} MB 上限，导出时请勿包含召回事件`,
    )
  }

  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw fail('json', 'Lore 返回的不是 JSON，请确认地址填写到服务根路径')
  }
}
