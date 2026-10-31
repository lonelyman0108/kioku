import { inspect } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { S3Error, s3Client } from '../s3'

const LOCATION = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'kioku-test',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'backup-secret',
}

const failure = async (run: Promise<unknown>) => {
  const err = await run.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(S3Error)
  return err as S3Error
}

describe('请求对象存储时的报错', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([
    ['Access Key ID', { accessKeyId: 'AKIAPASTED\nwith-newline' }],
    ['会话令牌', { sessionToken: 'AKIAPASTED\nwith-newline' }],
  ])('%s里有换行：真实的 aws4fetch 把请求头写进错误，这里只说连不上', async (_, extra) => {
    const err = await failure(s3Client({ ...LOCATION, ...extra }).delete('x'))
    expect(err.message).toContain('无法连接存储')
    const text = inspect(err, { depth: null })
    for (const leaked of ['Credential', 'Signature', 'AKIAPASTED', 'with-newline']) {
      expect(text).not.toContain(leaked)
    }
  })

  it('连不上时带错误类别，不带错误原文', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new TypeError('fetch failed backup-secret'), {
        cause: Object.assign(new Error('connect backup-secret'), { code: 'ECONNREFUSED' }),
      })
    })
    const err = await failure(s3Client(LOCATION).delete('x'))
    expect(err.message).toBe('无法连接存储（ECONNREFUSED）：请检查实例设置中的接口地址与 Key')
  })

  it('到了时限：说清等了多久，一般请求和上传的时限不同', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(20))
    // 一直不响应，等请求的 signal 取消
    vi.stubGlobal(
      'fetch',
      (request: Request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason as Error))
        }),
    )
    // 时限不管有没有传给请求都会到期：没传时哨兵先到，按断言失败，不是等到用例超时
    const limited = async (run: Promise<unknown>) => {
      const sentinel = new Promise<string>((resolve) =>
        setTimeout(() => resolve('时限没有传给请求'), 1_500),
      )
      const outcome = await Promise.race([run.catch((e: unknown) => e), sentinel])
      expect(outcome).toBeInstanceOf(S3Error)
      return (outcome as S3Error).message
    }
    const client = s3Client(LOCATION)
    expect(await limited(client.delete('x'))).toBe('存储 30 秒内未返回')
    expect(await limited(client.put('x', Buffer.from('y')))).toBe('存储 600 秒内未返回')
  })
})
