import { inspect } from 'node:util'

import { ErrorResponse } from '@kioku/contracts'
import { DrizzleQueryError } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { PostgresError } from 'postgres'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isLockBusy } from '../access/subjects'
import { createApp } from '../app'
import { RollbackRun } from '../bench/rollback'
import {
  errorText,
  isUniqueViolation,
  loggableError,
  pgConstraint,
  pgErrorCode,
  pgMessage,
  type Db,
} from '../db/client'
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
    // 不是数据库的错误原样记下，堆栈还在
    const err = logged.mock.calls[0]![1] as Error
    expect(err.message).toBe('upstream down')
    expect(err.stack).toContain('errors.test.ts')
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
    expect((logged.mock.calls[0]![1] as Error).stack).toContain('TypeError')
  })

  it('别的错误的 cause 与 code 都留着，不当成数据库的错误', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const err = new TypeError('fetch failed', { cause })
    expect(loggableError(err)).toBe(err)
    const noded = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    expect(loggableError(noded)).toBe(noded)
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

describe('记进最近的错误的文字', () => {
  it('drizzle 的错误只留数据库报的说明，没有 SQL 与参数', () => {
    const cause = new Error('new row violates check constraint "memories_priority_check"')
    expect(errorText(new DrizzleQueryError(SQL_TEXT, [PARAM], cause))).toBe(cause.message)
  })

  it('drizzle 的错误没有说明时给固定文字，不退回带 SQL 的 message', () => {
    expect(errorText(new DrizzleQueryError(SQL_TEXT, [PARAM]))).toBe('数据库出错')
  })

  it('别的错误不变：有 cause 也给它自己的 message', () => {
    expect(errorText(new Error('存储返回 403'))).toBe('存储返回 403')
    const wrapped = new Error('Key 解不开，看看主密钥', { cause: new Error('bad decrypt') })
    expect(errorText(wrapped)).toBe('Key 解不开，看看主密钥')
    expect(errorText('不是错误对象')).toBe('不是错误对象')
  })
})

describe('数据库错误的字段', () => {
  const postgresError = (code: string, message: string, constraint?: string) =>
    new PostgresError({
      code,
      message,
      ...(constraint ? { constraint_name: constraint } : {}),
    })
  const wrap = (cause: unknown) => new DrizzleQueryError(SQL_TEXT, [PARAM], cause as Error)
  // 和驱动给的一样：连接错误自带 cause，被杀时是数据库说的原因，网络断开时是 socket 的错误
  const CLOSED_MESSAGE = 'write CONNECTION_CLOSED localhost:5432'
  const connectionLost = (cause?: unknown) =>
    Object.assign(new Error(CLOSED_MESSAGE), { code: 'CONNECTION_CLOSED', cause })
  const terminated = postgresError('57P01', 'terminating connection due to administrator command')
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  const newRun = () =>
    new RollbackRun({
      parallel: 1,
      statementTimeoutMs: 1,
      lockTimeoutMs: 1,
      runMs: 1,
      embedBudgetMs: 1,
    })

  describe('数据库报的错：包不包在 drizzle 的错误里，字段都一样', () => {
    const unique = postgresError('23505', 'duplicate key value', 'memories_uri_live_idx')

    it.each([
      ['未包装', unique],
      ['包在 drizzle 的错误里', wrap(unique)],
    ])('%s', (_, err) => {
      expect(pgErrorCode(err)).toBe('23505')
      expect(pgConstraint(err)).toBe('memories_uri_live_idx')
      expect(pgMessage(err)).toBe('duplicate key value')
      expect(isUniqueViolation(err, 'memories_uri_live_idx')).toBe(true)
      expect(isUniqueViolation(err, 'another_idx')).toBe(false)
      expect(errorText(err)).toBe('duplicate key value')
    })

    it('日志：未包装的原样留着，它的 SQL 与参数不可枚举；包在 drizzle 里的只留三个字段', () => {
      expect(loggableError(unique)).toBe(unique)
      expect(loggableError(wrap(unique))).toEqual({
        code: '23505',
        constraint: 'memories_uri_live_idx',
        message: 'duplicate key value',
      })
    })

    it.each([
      ['未包装', (code: string) => postgresError(code, '等不到')],
      ['包在 drizzle 的错误里', (code: string) => wrap(postgresError(code, '等不到'))],
    ])('等锁与语句超时认得出来：%s', (_, make) => {
      expect(isLockBusy(make('55P03'))).toBe(true)
      expect(isLockBusy(make('40P01'))).toBe(true)
      expect(isLockBusy(make('57014'))).toBe(false)
      const run = newRun()
      run.note(make('57014'))
      expect(run.takeDetail()).toBe('statement_timeout')
      run.note(make('55P03'))
      expect(run.takeDetail()).toBe('lock_timeout')
    })
  })

  describe('连接错误：不解开它自带的 cause，同一次断连记成同一个 code', () => {
    it.each([
      ['后端被杀', connectionLost(terminated)],
      ['网络断开', connectionLost(reset)],
      ['没有 cause', connectionLost()],
      ['后端被杀，包在 drizzle 的错误里', wrap(connectionLost(terminated))],
      ['网络断开，包在 drizzle 的错误里', wrap(connectionLost(reset))],
    ])('%s', (_, err) => {
      expect(pgErrorCode(err)).toBe('CONNECTION_CLOSED')
      expect(pgMessage(err)).toBe(CLOSED_MESSAGE)
      expect(pgConstraint(err)).toBeUndefined()
      expect(errorText(err)).toBe(CLOSED_MESSAGE)
      expect(isLockBusy(err)).toBe(false)
      const run = newRun()
      run.note(err)
      expect(run.takeDetail()).toBeNull()
    })

    it('cause 里的 SQLSTATE 不算这个错误的：不会被当成唯一约束冲突或等锁超时', () => {
      const unique = postgresError('23505', '重复', 'memories_uri_live_idx')
      expect(isUniqueViolation(connectionLost(unique), 'memories_uri_live_idx')).toBe(false)
      expect(isLockBusy(connectionLost(postgresError('55P03', '等锁')))).toBe(false)
    })

    it('日志：未包装的原样留着，cause 也在；包在 drizzle 里的只留三个字段', () => {
      const raw = connectionLost(terminated)
      expect(loggableError(raw)).toBe(raw)
      expect(loggableError(wrap(raw))).toEqual({
        code: 'CONNECTION_CLOSED',
        constraint: undefined,
        message: CLOSED_MESSAGE,
      })
    })
  })

  it('别的错误的 cause 不解开：fetch 的错误不算数据库的错误', () => {
    const err = new TypeError('fetch failed', { cause: reset })
    expect(pgErrorCode(err)).toBeUndefined()
    expect(pgConstraint(err)).toBeUndefined()
    expect(pgMessage(err)).toBe('fetch failed')
  })

  it('drizzle 的错误没有 cause 时什么也不给，不退回带 SQL 与参数的 message', () => {
    const err = new DrizzleQueryError(SQL_TEXT, [PARAM])
    expect(pgErrorCode(err)).toBeUndefined()
    expect(pgMessage(err)).toBeUndefined()
  })

  it('抛出来的不是错误对象时不再报错', () => {
    for (const err of [null, undefined, '不是错误对象', 1]) {
      expect(pgErrorCode(err)).toBeUndefined()
      expect(isUniqueViolation(err, 'memories_uri_live_idx')).toBe(false)
    }
  })
})
