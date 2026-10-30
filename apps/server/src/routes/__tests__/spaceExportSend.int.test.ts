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

const DEADLINE_MS = 1500
const body = JSON.stringify({ passphrase: 'correct horse battery staple' })

// 最多等 ms 毫秒：等不到时报错，不一直卡着
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('等不到结果')), ms)),
  ])

describe.skipIf(!testDatabaseUrl)('导出的文件在真的连接上发送', () => {
  let database: Database
  let server: Server
  let port: number
  let ws: Workspace
  const sockets: Socket[] = []

  beforeAll(async () => {
    database = await openTestDatabase()
    await resetDatabase(database)
    const app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: null,
      embedder: staticEmbedderSource(null),
      jobs: null,
      exportSendTimeoutMs: DEADLINE_MS,
    })
    ws = await bootstrap(app)
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server
    if (!server.listening) await once(server, 'listening')
    port = (server.address() as AddressInfo).port
  })
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy()
  })
  afterAll(async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (database) {
      await resetDatabase(database)
      await database.close()
    }
  })

  const connections = () =>
    new Promise<number>((resolve, reject) =>
      server.getConnections((err, n) => (err ? reject(err) : resolve(n))),
    )

  // 发一个导出请求，读完响应头就不再读，也不断开
  async function stalledExport(): Promise<void> {
    const socket = connect(port, '127.0.0.1')
    sockets.push(socket)
    await once(socket, 'connect')
    socket.write(
      [
        `POST /v1/spaces/${ws.spaceId}/export HTTP/1.1`,
        'host: 127.0.0.1',
        `cookie: ${ws.cookie}`,
        'sec-fetch-site: same-origin',
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(body)}`,
        '',
        body,
      ].join('\r\n'),
    )
    let head = ''
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        head += chunk.toString('latin1')
        if (!head.includes('\r\n\r\n')) return
        socket.off('data', onData)
        socket.pause()
        resolve()
      }
      socket.on('data', onData)
    })
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
  }

  it('客户端一直不读响应、也不断开：没发完之前名额占着，到了发送时限断开连接、放掉名额', async () => {
    await stalledExport()
    // 文件远比连接的缓冲大，发不完：名额还占着，别人来要排队
    await new Promise((resolve) => setTimeout(resolve, 200))
    const probe = acquireTransferSlot('probe')
    const queued = queuedTransfers()
    expect(await connections()).toBe(1)
    // 到了时限：服务端断开这个连接，名额交给排着的那个（先拿到再判断，判断不过也不把名额留给后面的用例）
    ;(await within(probe, DEADLINE_MS * 3))()
    expect(queued).toBe(1)
    for (const started = Date.now(); (await connections()) > 0;) {
      if (Date.now() - started > 3000) throw new Error('连接没有断开')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })

  it('读响应的客户端拿到完整的文件，发完就放掉名额', async () => {
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
