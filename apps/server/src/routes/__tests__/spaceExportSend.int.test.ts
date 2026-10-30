import { once } from 'node:events'
import type { Server } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'

import { serve } from '@hono/node-server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { acquireTransferSlot, queuedTransfers } from '../../backup/transferGate'
import type { Database } from '../../db/client'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootstrap, type Workspace } from '../../testing/fixtures'

// 这里测的是导出的文件在真的连接上怎么发，导出本身换成直接给一个大文件：要比连接两头的缓冲大得多，
// 客户端不读时才发不完
const { FILE_BYTES } = vi.hoisted(() => ({ FILE_BYTES: 24 * 1024 * 1024 }))
vi.mock('../../backup/spaceExport', async () => {
  const { randomBytes } = await import('node:crypto')
  return {
    exportSpace: async () => ({
      file: randomBytes(FILE_BYTES),
      spaceName: '家',
      createdAt: new Date().toISOString(),
    }),
  }
})

const body = JSON.stringify({ passphrase: 'correct horse battery staple' })
// 慢慢读：每读到这么多字节就停一会儿再读。停的时间比空闲时限短得多，整个文件读下来比空闲时限长
const SLOW = { burst: 2 * 1024 * 1024, pauseMs: 200 }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// 最多等 ms 毫秒：等不到时报错，不一直卡着
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('等不到结果')), ms)),
  ])

describe.skipIf(!testDatabaseUrl)('导出的文件在真的连接上发送', () => {
  let database: Database
  let ws: Workspace
  const servers: Server[] = []
  const sockets: Socket[] = []

  const appWith = (limits: { idleMs: number; totalMs: number }) =>
    createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: null,
      embedder: staticEmbedderSource(null),
      jobs: null,
      exportSendLimits: limits,
    })
  // 起一个真的服务（@hono/node-server），发送时限按给的算
  async function serveWith(limits: { idleMs: number; totalMs: number }) {
    const server = serve({ fetch: appWith(limits).fetch, port: 0, hostname: '127.0.0.1' }) as Server
    servers.push(server)
    if (!server.listening) await once(server, 'listening')
    const connections = () =>
      new Promise<number>((resolve, reject) =>
        server.getConnections((err, n) => (err ? reject(err) : resolve(n))),
      )
    return { port: (server.address() as AddressInfo).port, connections }
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    await resetDatabase(database)
    ws = await bootstrap(appWith({ idleMs: 60_000, totalMs: 60_000 }))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const socket of sockets.splice(0)) socket.destroy()
  })
  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (database) {
      await resetDatabase(database)
      await database.close()
    }
  })

  // 用一条 TCP 连接发导出请求。pace 为 'stall' 时读完响应头就不再读，也不断开；给了 burst 就按它慢慢读
  async function download(port: number, pace: 'stall' | typeof SLOW) {
    const socket = connect(port, '127.0.0.1')
    sockets.push(socket)
    socket.on('error', () => {})
    const closed = once(socket, 'close').then(() => {})
    await once(socket, 'connect')
    socket.write(
      [
        `POST /v1/spaces/${ws.spaceId}/export HTTP/1.1`,
        'host: 127.0.0.1',
        `cookie: ${ws.cookie}`,
        'sec-fetch-site: same-origin',
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(body)}`,
        'connection: close',
        '',
        body,
      ].join('\r\n'),
    )
    let head = Buffer.alloc(0)
    let headBytes = -1
    let total = 0
    let sincePause = 0
    const status = await new Promise<string>((resolve) => {
      socket.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (headBytes < 0) {
          head = Buffer.concat([head, chunk])
          const end = head.indexOf('\r\n\r\n')
          if (end < 0) return
          headBytes = end + 4
          resolve(head.subarray(0, head.indexOf('\r\n')).toString('latin1'))
          if (pace === 'stall') socket.pause()
          return
        }
        if (pace === 'stall') return
        sincePause += chunk.length
        if (sincePause >= pace.burst) {
          sincePause = 0
          socket.pause()
          setTimeout(() => socket.resume(), pace.pauseMs)
        }
      })
    })
    expect(status).toBe('HTTP/1.1 200 OK')
    return { socket, closed, bodyBytes: () => total - headBytes }
  }

  it('客户端一直不读、也不断开：没发完之前名额占着，空闲到了时限直接断开连接、放掉名额，只记一行日志', async () => {
    const { port, connections } = await serveWith({ idleMs: 1000, totalMs: 60_000 })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stalled = await download(port, 'stall')
    // 文件远比连接的缓冲大，发不完：名额还占着，别人来要排队
    await sleep(200)
    const probe = acquireTransferSlot('probe')
    const queued = queuedTransfers()
    expect(await connections()).toBe(1)
    // 到了空闲时限：服务端断开这个连接，名额交给排着的那个（先拿到再判断，判断不过也不把名额留给后面的用例）
    ;(await within(probe, 5000))()
    expect(queued).toBe(1)
    for (const started = Date.now(); (await connections()) > 0;) {
      if (Date.now() - started > 3000) throw new Error('连接没有断开')
      await sleep(50)
    }
    // 客户端这边只看到连接断了，文件没收全
    stalled.socket.resume()
    await within(stalled.closed, 3000)
    expect(stalled.bodyBytes()).toBeLessThan(FILE_BYTES)
    // 只有一行普通的日志，@hono/node-server 没有往响应后面写错误、打调用栈
    expect(warned).toHaveBeenCalledTimes(1)
    expect(String(warned.mock.calls[0]![0])).toContain('太久没有进度')
    expect(errored).not.toHaveBeenCalled()
  })

  it('一直在慢慢读的客户端不会被掐断：每读走一块重新计时，读完整个文件', async () => {
    const { port } = await serveWith({ idleMs: 1000, totalMs: 60_000 })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const started = Date.now()
    const slow = await download(port, SLOW)
    await within(slow.closed, 20_000)
    // 读下来比空闲时限长，照样收全
    expect(Date.now() - started).toBeGreaterThan(1500)
    expect(slow.bodyBytes()).toBe(FILE_BYTES)
    expect(warned).not.toHaveBeenCalled()
    ;(await within(acquireTransferSlot('next'), 2000))()
  })

  it('慢到过了总时限还没发完：同样断开连接、放掉名额', async () => {
    const { port } = await serveWith({ idleMs: 1000, totalMs: 1200 })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slow = await download(port, SLOW)
    await within(slow.closed, 10_000)
    expect(slow.bodyBytes()).toBeLessThan(FILE_BYTES)
    expect(String(warned.mock.calls[0]![0])).toContain('总时限')
    ;(await within(acquireTransferSlot('next'), 2000))()
  })

  it('读响应的客户端拿到完整的文件，发完就放掉名额', async () => {
    const { port } = await serveWith({ idleMs: 1000, totalMs: 60_000 })
    const res = await fetch(`http://127.0.0.1:${port}/v1/spaces/${ws.spaceId}/export`, {
      method: 'POST',
      headers: {
        cookie: ws.cookie,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body,
    })
    expect(res.status).toBe(200)
    expect(Number(res.headers.get('content-length'))).toBe(FILE_BYTES)
    expect((await res.arrayBuffer()).byteLength).toBe(FILE_BYTES)
    ;(await within(acquireTransferSlot('next'), 2000))()
  })
})
