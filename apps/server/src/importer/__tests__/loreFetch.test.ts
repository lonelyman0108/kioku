import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchLoreBackup, loreExportUrl } from '../loreFetch'

const limits = { maxBytes: 1024 * 1024, timeoutMs: 5_000 }
const TOKEN = 'lore-token-not-for-logs'

describe('拉取 Lore 的导出', () => {
  const servers: Server[] = []
  const logs: unknown[][] = []
  const serve = async (handler: RequestListener) => {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  beforeEach(() => {
    logs.length = 0
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args))
    }
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  // 日志只有主机与错误类别，没有地址里的别的部分、Token 与对方返回的内容
  const expectCleanLog = (host: string, kind: string) => {
    expect(logs).toEqual([['拉取 Lore 的导出失败', { host, kind }]])
  }
  const hostOf = (url: string) => new URL(url).host

  it('地址只允许 http、https，不能带账号密码、查询与片段；报错不带填写的内容', () => {
    for (const address of [
      'ftp://lore.example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:hunter2@lore.example.com',
      'https://user@lore.example.com',
      'https://lore.example.com/?token=hunter2',
      'https://lore.example.com/#hunter2',
      // 查询与片段是空的也不行：拼地址时路径会被丢掉，Token 发到同一主机的另一个路径
      'https://lore.example.com/lore?',
      'https://lore.example.com/lore#',
      'https://lore.example.com/?',
      'https://lore.example.com/#',
      'https://lore.example.com/lore?#',
      '不是网址 hunter2',
    ]) {
      expect(() => loreExportUrl(address)).toThrow(/Lore 地址/)
      try {
        loreExportUrl(address)
      } catch (err) {
        expect((err as Error).message).not.toContain('hunter2')
      }
    }
    expect(loreExportUrl('https://lore.example.com').href).toBe(
      'https://lore.example.com/api/backup?action=export',
    )
    expect(loreExportUrl(' http://127.0.0.1:3000/lore/ ').href).toBe(
      'http://127.0.0.1:3000/lore/api/backup?action=export',
    )
    expect(loreExportUrl('http://127.0.0.1:3000/lore').href).toBe(
      'http://127.0.0.1:3000/lore/api/backup?action=export',
    )
  })

  it('用 GET 读导出接口，带上 Token，返回解析好的 JSON；留空时不带', async () => {
    const seen: { method: string | undefined; url: string | undefined; authorization?: string }[] =
      []
    const url = await serve((req, res) => {
      seen.push({
        method: req.method,
        url: req.url,
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      })
      res.end(JSON.stringify({ format: 'x' }))
    })
    expect(await fetchLoreBackup({ url, token: TOKEN }, undefined, limits)).toEqual({ format: 'x' })
    await fetchLoreBackup({ url: `${url}/`, token: '' }, undefined, limits)
    expect(seen).toEqual([
      { method: 'GET', url: '/api/backup?action=export', authorization: `Bearer ${TOKEN}` },
      { method: 'GET', url: '/api/backup?action=export' },
    ])
    expect(logs).toEqual([])
  })

  it('不跟随重定向：Token 不会发到别的地址', async () => {
    const hits: string[] = []
    const other = await serve((req, res) => {
      hits.push(req.url ?? '')
      res.end('{}')
    })
    const url = await serve((_req, res) => {
      res.writeHead(302, { location: `${other}/stolen` }).end()
    })
    await expect(fetchLoreBackup({ url, token: TOKEN }, undefined, limits)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('重定向') as string,
    })
    expect(hits).toEqual([])
    expectCleanLog(hostOf(url), 'redirect')
  })

  it('对方报错、返回的不是 JSON 时换成固定文字，不带返回的内容', async () => {
    const SECRET = 'response-body-not-for-logs'
    const cases: [number, string, string][] = [
      [401, 'unauthorized', 'Token'],
      [403, 'unauthorized', 'Token'],
      [500, 'status', 'HTTP 500'],
      [200, 'json', '不是 JSON'],
    ]
    for (const [status, kind, text] of cases) {
      logs.length = 0
      const url = await serve((_req, res) => {
        res.writeHead(status).end(`<html>${SECRET}`)
      })
      const failure = await fetchLoreBackup({ url, token: TOKEN }, undefined, limits).catch(
        (err: Error) => err,
      )
      expect((failure as Error).message).toContain(text)
      expect((failure as Error).message).not.toContain(SECRET)
      expectCleanLog(hostOf(url), kind)
      expect(JSON.stringify(logs)).not.toContain(SECRET)
      expect(JSON.stringify(logs)).not.toContain(TOKEN)
    }
  })

  it('连不上时换成固定文字，日志只有主机', async () => {
    const url = await serve((_req, res) => res.end('{}'))
    const server = servers.pop()!
    await new Promise((resolve) => server.close(resolve))
    await expect(fetchLoreBackup({ url, token: TOKEN }, undefined, limits)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('无法连接') as string,
    })
    expectCleanLog(hostOf(url), 'network')
  })

  it('超过大小上限就停下：声明的长度、没声明长度的流、解压之后才超过的都算', async () => {
    const small = { maxBytes: 1000, timeoutMs: 2_000 }
    let closed = false
    const urls = [
      await serve((_req, res) => {
        res.writeHead(200, { 'content-length': '1001' }).end('x'.repeat(1001))
      }),
      // 没有 content-length，一直写到连接被断开
      await serve((req, res) => {
        res.on('close', () => (closed = true))
        const timer = setInterval(() => res.write('x'.repeat(400)), 5)
        req.socket.on('close', () => clearInterval(timer))
      }),
      await serve((_req, res) => {
        res
          .writeHead(200, { 'content-encoding': 'gzip' })
          .end(gzipSync(Buffer.from('x'.repeat(100_000))))
      }),
    ]
    for (const url of urls) {
      logs.length = 0
      await expect(fetchLoreBackup({ url, token: '' }, undefined, small)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('上限') as string,
      })
      expectCleanLog(hostOf(url), 'tooLarge')
    }
    await vi.waitFor(() => expect(closed).toBe(true))
  })

  it('有时限：响应头或正文迟迟不来都算超时', async () => {
    const short = { maxBytes: 1000, timeoutMs: 100 }
    const urls = [
      await serve(() => {}),
      await serve((_req, res) => {
        res.writeHead(200)
        res.write('{"partial":')
      }),
    ]
    for (const url of urls) {
      logs.length = 0
      // 没有时限的话这里按断言失败，不是等到用例超时
      const outcome = await Promise.race([
        fetchLoreBackup({ url, token: '' }, undefined, short).catch((err: Error) => err.message),
        new Promise((resolve) => setTimeout(() => resolve('一直没有停下'), 1_500)),
      ])
      expect(outcome).toContain('秒内未能拉取完')
      expectCleanLog(hostOf(url), 'timeout')
    }
  })

  it('请求的 signal 传给 fetch：客户端断开就不再等 Lore', async () => {
    let received: () => void
    const arrived = new Promise<void>((resolve) => (received = resolve))
    let closed = false
    const url = await serve((req) => {
      req.socket.on('close', () => (closed = true))
      received()
    })
    const client = new AbortController()
    const pending = fetchLoreBackup(
      { url, token: '' },
      client.signal,
      // 比用例的时限短：signal 没传给 fetch 时按断言失败，不是等到用例超时
      { ...limits, timeoutMs: 1_500 },
    ).catch((err: Error) => err)
    await arrived
    client.abort()
    expect(((await pending) as Error).message).toBe('请求已断开')
    expectCleanLog(hostOf(url), 'aborted')
    await vi.waitFor(() => expect(closed).toBe(true))
  })
})
