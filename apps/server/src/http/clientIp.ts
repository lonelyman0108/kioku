import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

// 客户端地址：默认取 TCP 连接的对端地址；部署在反向代理后面时设置 KIOKU_TRUST_PROXY=true，
// 改用 X-Forwarded-For 的第一项。不信任代理时不读这个头，否则谁都能伪造
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    // 测试里直接调用 app.request，没有底层连接
    return 'unknown'
  }
}
