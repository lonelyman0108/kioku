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
  // 没配置受信代理却收到了转发头：要么部署在代理后面但没配置，要么是请求方伪造的。
  // 两种情况都只按连接对端区分客户端，不让请求头改变限流行为（否则伪造一个头就能把限流降级）；
  // 前一种情况所有人会共用代理的地址，只打一次警告提醒配置
  if (forwarded && trustedProxies === 0 && !warnedUntrustedForward) {
    warnedUntrustedForward = true
    console.warn(
      '收到 X-Forwarded-For 但没有设置 KIOKU_TRUSTED_PROXIES：如果部署在反向代理后面，请设置它，否则所有客户端会共用代理的地址',
    )
  }
  return { key: remote, identified: true }
}
