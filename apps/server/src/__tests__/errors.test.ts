import { ErrorResponse } from '@kioku/contracts'
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
// 模拟中间件抛出的几种：带自己的响应（响应头）、带自己的说明、两样都带，以及 5xx。路由要在第一个请求之前加上
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
    message: '这个接口要用 Bearer Key',
    res: new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="kioku"' },
    }),
  })
})
app.get('/v1/test/explained', () => {
  throw new HTTPException(409, { message: '这一批正在处理' })
})
app.get('/v1/test/unavailable', () => {
  throw new HTTPException(503, { message: 'upstream down' })
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

  it('中间件带了自己的响应：沿用它的状态码与响应头，正文换成 { error }', async () => {
    const res = await app.request('/v1/test/throttled')
    expect(await errorOf(res, 429)).toBe('请求太频繁，请稍后再试')
    expect(res.headers.get('retry-after')).toBe('30')
    // 跟着原来正文的响应头不沿用
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('content-length')).not.toBe('9')
  })

  it('抛出的地方写了自己的说明就用它；同时带了响应时响应头照样沿用', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const challenge = await app.request('/v1/test/challenge')
    expect(await errorOf(challenge, 401)).toBe('这个接口要用 Bearer Key')
    expect(challenge.headers.get('www-authenticate')).toBe('Bearer realm="kioku"')
    expect(await errorOf(await app.request('/v1/test/explained'), 409)).toBe('这一批正在处理')
    expect(logged).not.toHaveBeenCalled()
  })

  it('5xx 的不算请求的问题：照旧是 500「服务内部错误」，记下堆栈', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await errorOf(await app.request('/v1/test/unavailable'), 500)).toBe('服务内部错误')
    expect(logged).toHaveBeenCalledOnce()
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
  })
})
