import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

export interface ClientIdentity {
  // 用于按客户端限流的键
  key: string
  // 能否可靠地区分客户端；不能时不按客户端限流，否则所有人会共用一个名额
  identified: boolean
}

let warnedUntrustedForward = false

// 客户端地址。trustedProxies 是前面受信任的反向代理层数（KIOKU_TRUSTED_PROXIES）：
// X-Forwarded-For 是逐跳追加的，最左边的项由请求方自己填写、可以伪造，
// 所以从右往左数，跳过受信代理追加的项，取最后一个由受信代理写入的地址。
export function clientIdentity(c: Context, trustedProxies: number): ClientIdentity {
  const forwarded = c.req.header('x-forwarded-for')
  if (trustedProxies > 0) {
    const hops = (forwarded ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const picked = hops[hops.length - trustedProxies]
    if (picked) return { key: picked, identified: true }
  }
  let remote: string | undefined
  try {
    remote = getConnInfo(c).remote.address
  } catch {
    // 测试里直接调用 app.request，没有底层连接
  }
  if (!remote) return { key: 'unknown', identified: false }
  // 没配置受信代理却收到了转发头：连接的对端多半是代理本身，所有人都会是同一个地址
  if (forwarded && trustedProxies === 0) {
    if (!warnedUntrustedForward) {
      warnedUntrustedForward = true
      console.warn('收到 X-Forwarded-For 但没有设置 KIOKU_TRUSTED_PROXIES，登录限流无法区分客户端')
    }
    return { key: remote, identified: false }
  }
  return { key: remote, identified: true }
}
