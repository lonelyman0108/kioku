import { inspect } from 'node:util'

import { ErrorResponse } from '@kioku/contracts'
import { DrizzleQueryError } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../app'
import type { Db } from '../db/client'
import { staticEmbedderSource } from '../embedding/source'

// 初始化与登录在读数据库之前先校验请求体，用一个碰不得的数据库就够了：校验没拦下的请求一读库就出错
const app = createApp({
  db: {} as Db,
  cookieSecure: true,
  masterKey: null,
  embedder: staticEmbedderSource(null),
  jobs: null,
})
// 模拟依赖库抛出的几种：带自己的响应（响应头）、带自己的说明、两样都带，以及 5xx。路由要在第一个请求之前加上
app.get('/v1/test/throttled', () => {
  throw new HTTPException(429, {
    res: new Response('slow down', {
      status: 429,
      headers: { 'retry-after': '30', 'content-type': 'text/plain', 'content-length': '9' },
    }),
  })
})
app.get('/v1/test/challenge', () => {
  throw new HTTPException(401, {
    message: 'token verification failure: signature mismatch',
    res: new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="kioku"' },
    }),
  })
})
app.get('/v1/test/explained', () => {
  throw new HTTPException(400, { message: 'Invalid Connection header value: x-internal' })
})
app.get('/v1/test/unavailable', () => {
  throw new HTTPException(503, { message: 'upstream down' })
})
// drizzle 的错误：message 与字段带着 SQL 与全部参数，数据库报的错在 cause 里
const SQL_TEXT = 'insert into "memories" ("content") values ($1)'
const PARAM = '不该进日志的记忆正文'
app.post('/v1/test/write', () => {
  throw new DrizzleQueryError(
    SQL_TEXT,
    [PARAM],
    Object.assign(new Error('new row violates check constraint "memories_priority_check"'), {
      code: '23514',
      constraint_name: 'memories_priority_check',
    }),
  )
})

const post = (
  path: string,
  body: NonNullable<RequestInit['body']>,
  headers: Record<string, string> = {},
) => app.request(path, { method: 'POST', headers, body })

async function errorOf(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status)
  return ErrorResponse.parse(await res.json()).error
}

describe('请求本身有问题时的回复', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('请求体不是合法的 JSON：400，格式和别的错误一样，不打堆栈', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const json = { 'content-type': 'application/json' }
    for (const [path, body] of [
      ['/v1/auth/login', '{"username": "alice",'],
      ['/v1/auth/login', 'not json'],
      ['/v1/setup', ''],
      ['/v1/setup', '{"username": "alice"}}'],
    ] as const) {
      expect(await errorOf(await post(path, body, json), 400)).toBe('请求格式错误')
    }
    expect(
      await errorOf(
        await post('/v1/auth/login', '{', { 'content-type': 'application/json; charset=utf-8' }),
        400,
      ),
    ).toBe('请求格式错误')
    expect(logged).not.toHaveBeenCalled()
  })

  it('Content-Type 不对、或者有请求体却没写 Content-Type：415', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = JSON.stringify({ username: 'alice', password: 'correct horse battery' })
    expect(
      await errorOf(await post('/v1/auth/login', body, { 'content-type': 'text/plain' }), 415),
    ).toBe('请求体的类型（Content-Type）不对')
    expect(
      await errorOf(
        await post('/v1/auth/login', body, { 'content-type': 'multipart/form-data; boundary=x' }),
        415,
      ),
    ).toBe('请求体的类型（Content-Type）不对')
    // 字节数组作请求体时不会自动带上 Content-Type
    expect(await errorOf(await post('/v1/auth/login', new TextEncoder().encode(body)), 415)).toBe(
      '请求体的类型（Content-Type）不对',
    )
    expect(logged).not.toHaveBeenCalled()
  })

  it('依赖库带了自己的响应：沿用它的状态码与响应头，正文换成 { error }', async () => {
    const res = await app.request('/v1/test/throttled')
    expect(await errorOf(res, 429)).toBe('请求不合法')
    expect(res.headers.get('retry-after')).toBe('30')
    // 跟着原来正文的响应头不沿用
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('content-length')).not.toBe('9')
  })

  it('依赖库自带的说明不给调用方，一律按状态码给中文说明；同时带了响应时响应头照样沿用', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const challenge = await app.request('/v1/test/challenge')
    expect(await errorOf(challenge, 401)).toBe('请求不合法')
    expect(challenge.headers.get('www-authenticate')).toBe('Bearer realm="kioku"')
    expect(await errorOf(await app.request('/v1/test/explained'), 400)).toBe('请求格式错误')
    expect(logged).not.toHaveBeenCalled()
  })

  it('5xx 的不算请求的问题：照旧是 500「服务内部错误」，记下堆栈', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await errorOf(await app.request('/v1/test/unavailable'), 500)).toBe('服务内部错误')
    expect(logged).toHaveBeenCalledOnce()
    expect(logged.mock.calls[0]![1]).toMatchObject({
      message: 'upstream down',
      stack: expect.stringContaining('errors.test.ts'),
    })
  })

  it('请求体合规时照常往下走；服务端自己出的错照旧是 500「服务内部错误」，记下堆栈', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(
      '/v1/auth/login',
      JSON.stringify({ username: 'alice', password: 'correct horse battery' }),
      { 'content-type': 'application/json' },
    )
    expect(await errorOf(res, 500)).toBe('服务内部错误')
    expect(logged).toHaveBeenCalledOnce()
    expect(logged.mock.calls[0]![1]).toMatchObject({ stack: expect.stringContaining('TypeError') })
  })

  it('写库出错：500，日志只有 SQLSTATE、约束名与说明，没有 SQL 与参数，也不打堆栈', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await errorOf(await post('/v1/test/write', ''), 500)).toBe('服务内部错误')
    expect(logged).toHaveBeenCalledOnce()
    const text = inspect(logged.mock.calls, { depth: null })
    for (const leaked of [PARAM, SQL_TEXT, 'Failed query', 'stack']) {
      expect(text).not.toContain(leaked)
    }
    expect(logged.mock.calls[0]![1]).toEqual({
      code: '23514',
      constraint: 'memories_priority_check',
      message: 'new row violates check constraint "memories_priority_check"',
    })
  })
})
