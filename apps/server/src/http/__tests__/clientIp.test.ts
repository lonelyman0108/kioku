import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { clientIdentity, clientKey, stripPort, type ClientIdentity } from '../clientIp'

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

  it('IPv6 按 /64 分桶，IPv4 映射地址还原成 IPv4', () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(clientKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64')
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(clientKey('::ffff:192.0.2.5')).toBe('192.0.2.5')
    expect(clientKey('192.0.2.5')).toBe('192.0.2.5')
  })

  it('受信代理写的 ip:port 去掉端口；不是合法地址时归入未知客户端，不记到代理的地址上', async () => {
    expect(stripPort('203.0.113.5:51234')).toBe('203.0.113.5')
    expect(stripPort('[2001:db8::1]:443')).toBe('2001:db8::1')
    expect(stripPort('2001:db8::1')).toBe('2001:db8::1')
    expect(await identify(1, '203.0.113.5:51234')).toEqual({ key: '203.0.113.5', identified: true })
    expect(await identify(1, 'unknown', '192.0.2.5')).toEqual({ key: 'unknown', identified: false })
  })

  it('转发头的项数不够时（绕过代理直连）退回连接对端', async () => {
    expect(await identify(2, '203.0.113.9', '192.0.2.5')).toEqual({
      key: '192.0.2.5',
      identified: true,
    })
    expect(await identify(1, undefined, '192.0.2.5')).toEqual({
      key: '192.0.2.5',
      identified: true,
    })
  })
})
