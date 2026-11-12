import { describe, expect, it } from 'vitest'

import { RUNTIME_FAMILIES } from '../auth'
import {
  DEVICE_MAX_PLATFORMS,
  DeviceAuthorizeRequest,
  DeviceGrantApprove,
  DeviceTokenResponse,
} from '../device'

const ok = (body: unknown) => DeviceAuthorizeRequest.safeParse(body).success

describe('浏览器授权的申请', () => {
  it('单个平台的写法照旧', () => {
    expect(ok({ runtimeFamily: 'codex' })).toBe(true)
    expect(ok({ runtimeFamily: 'codex', clientName: 'laptop' })).toBe(true)
    expect(ok({ runtimeFamily: 'nope' })).toBe(false)
  })

  it('几个平台的写法：每项可带自己的名字，顶层是机器名', () => {
    expect(
      ok({
        platforms: [{ runtimeFamily: 'codex', clientName: 'work' }, { runtimeFamily: 'pi' }],
        clientName: 'mac',
      }),
    ).toBe(true)
    expect(ok({ platforms: [{ runtimeFamily: 'pi', clientName: 'a\nb' }] })).toBe(false)
  })

  it('两种写法二选一：都给、都不给都不行', () => {
    expect(ok({ runtimeFamily: 'codex', platforms: [{ runtimeFamily: 'pi' }] })).toBe(false)
    expect(ok({})).toBe(false)
    expect(ok({ clientName: 'mac' })).toBe(false)
  })

  it('运行时不能重复', () => {
    const result = DeviceAuthorizeRequest.safeParse({
      platforms: [{ runtimeFamily: 'pi' }, { runtimeFamily: 'codex' }, { runtimeFamily: 'pi' }],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['platforms', 2, 'runtimeFamily'])
  })

  it('平台 1 到 8 个', () => {
    const platforms = RUNTIME_FAMILIES.map((runtimeFamily) => ({ runtimeFamily }))
    expect(ok({ platforms: [] })).toBe(false)
    expect(ok({ platforms: platforms.slice(0, 1) })).toBe(true)
    expect(ok({ platforms: platforms.slice(0, DEVICE_MAX_PLATFORMS) })).toBe(true)
    expect(ok({ platforms: platforms.slice(0, DEVICE_MAX_PLATFORMS + 1) })).toBe(false)
  })
})

describe('浏览器授权的确认', () => {
  const base = { userCode: 'BCDF-GHJK', spaceId: '00000000-0000-4000-8000-000000000000' }
  const scopes = {
    readLayers: ['core'],
    writeLayers: [],
    maxSensitivity: 'private',
    admin: false,
    credentials: 'none',
  }

  it('每项是跳过，或者应用、访问密钥名与签发范围', () => {
    const parsed = DeviceGrantApprove.parse({
      ...base,
      items: [
        { runtimeFamily: 'pi', skip: true },
        { runtimeFamily: 'codex', app: { slug: 'codex', name: 'Codex' }, keyName: 'mac', scopes },
      ],
    })
    expect(parsed.items[0]).toEqual({ runtimeFamily: 'pi', skip: true })
    expect(parsed.items[1]).toMatchObject({ app: { slug: 'codex' } })
    expect(
      DeviceGrantApprove.safeParse({ ...base, items: [{ runtimeFamily: 'codex', keyName: 'x' }] })
        .success,
    ).toBe(false)
    expect(DeviceGrantApprove.safeParse({ ...base, items: [] }).success).toBe(false)
  })
})

describe('取走的结果', () => {
  it('单个平台是 key 与 app，几个平台是 keys', () => {
    const app = { slug: 'codex', name: 'Codex', runtimeFamily: 'codex' }
    expect(DeviceTokenResponse.parse({ status: 'approved', key: 'k', app })).toEqual({
      status: 'approved',
      key: 'k',
      app,
    })
    const keys = [
      { runtimeFamily: 'codex', status: 'issued', key: 'k', app },
      { runtimeFamily: 'pi', status: 'skipped' },
      { runtimeFamily: 'hermes', status: 'denied', reason: '确认人已不在空间或已停用' },
    ]
    expect(DeviceTokenResponse.parse({ status: 'approved', keys })).toEqual({
      status: 'approved',
      keys,
    })
    expect(DeviceTokenResponse.parse({ status: 'pending' })).toEqual({ status: 'pending' })
  })
})
