import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { clientIdentity, type ClientIdentity } from '../clientIp'

async function identify(
  trustedProxies: number,
  forwardedFor?: string,
  remoteAddress?: string,
): Promise<ClientIdentity> {
  let result: ClientIdentity | undefined
  const app = new Hono()
  app.get('/', (c) => {
    result = clientIdentity(c, trustedProxies)
    return c.text('ok')
  })
  // @hono/node-server 从 env.incoming.socket 取连接对端地址，这里模拟一条连接
  const env = remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined
  await app.request('/', { headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} }, env)
  return result!
}

describe('客户端地址', () => {
  it('一层受信代理取最右边那一项，最左边由请求方填写的项被忽略', async () => {
    expect(await identify(1, '198.51.100.7, 203.0.113.9')).toEqual({
      key: '203.0.113.9',
      identified: true,
    })
  })

  it('两层受信代理取倒数第二项', async () => {
    expect(await identify(2, '198.51.100.7, 203.0.113.9, 192.0.2.1')).toEqual({
      key: '203.0.113.9',
      identified: true,
    })
  })

  it('不信任代理时不读转发头；没有连接信息时视为分不清客户端', async () => {
    expect(await identify(0, '203.0.113.9')).toEqual({ key: 'unknown', identified: false })
  })

  it('不信任代理时，伪造的转发头不能把限流降级，仍按连接对端区分', async () => {
    expect(await identify(0, '203.0.113.9', '192.0.2.5')).toEqual({
      key: '192.0.2.5',
      identified: true,
    })
  })
})
