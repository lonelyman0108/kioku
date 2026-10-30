import { ErrorResponse } from '@kioku/contracts'
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
