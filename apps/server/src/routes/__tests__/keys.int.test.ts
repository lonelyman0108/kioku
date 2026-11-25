import {
  ApiKeyListResponse,
  ApiKeyView,
  IssuedApiKeyResponse,
  WhoAmIResponse,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '../../db/client'
import {
  consoleHeaders,
  createOwnerSession,
  createTestApp,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'

describe.skipIf(!testDatabaseUrl)('访问密钥管理、轮换与 whoami 兼容输出', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('支持签发、更新透镜、轮换（旧密钥即刻吊销、新密钥继承配置）、吊销与 whoami', async () => {
    const app = createTestApp(database, { masterKey: testMasterKey() })
    const { cookie } = await createOwnerSession(database)

    // 签发密钥
    const createRes = await app.request('/v1/console/keys', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        name: 'Office Mac',
        runtimeFamily: 'claudecode',
        envs: ['mac', 'office'],
        allowedRealms: ['work'],
        canWrite: true,
        canResolveCredentials: true,
      }),
    })
    expect(createRes.status).toBe(201)
    expect(createRes.headers.get('cache-control')).toContain('no-store')
    const issued = IssuedApiKeyResponse.parse(await createRes.json())
    expect(issued.key).toMatch(/^kioku_/)
    expect(issued.item.envs).toEqual(['mac', 'office'])
    expect(issued.item.allowedRealms).toEqual(['work'])

    // GET /v1/whoami 返回透镜与 primaryCircle 兼容垫片
    const whoamiRes = await app.request('/v1/whoami', {
      headers: { authorization: `Bearer ${issued.key}` },
    })
    expect(whoamiRes.status).toBe(200)
    const whoami = WhoAmIResponse.parse(await whoamiRes.json())
    expect(whoami.key.name).toBe('Office Mac')
    expect(whoami.key.runtimeFamily).toBe('claudecode')
    expect(whoami.key.envs).toEqual(['mac', 'office'])
    expect(whoami.key.allowedRealms).toEqual(['work'])
    expect(whoami.key.canResolveCredentials).toBe(true)
    expect(whoami.primaryCircle?.slug).toBe('default')

    // PATCH 更新名称与权限
    const patchRes = await app.request(`/v1/console/keys/${issued.item.id}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        name: 'Office Mac Renamed',
        canWrite: false,
      }),
    })
    expect(patchRes.status).toBe(200)
    const updated = ApiKeyView.parse(await patchRes.json())
    expect(updated.name).toBe('Office Mac Renamed')
    expect(updated.canWrite).toBe(false)

    // POST rotate：吊销旧密钥并继承原透镜签发新密钥
    const rotateRes = await app.request(`/v1/console/keys/${issued.item.id}/rotate`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(rotateRes.status).toBe(200)
    expect(rotateRes.headers.get('cache-control')).toContain('no-store')
    const rotated = IssuedApiKeyResponse.parse(await rotateRes.json())
    expect(rotated.key).not.toBe(issued.key)
    expect(rotated.item.id).not.toBe(issued.item.id)
    expect(rotated.item.name).toBe('Office Mac Renamed')
    expect(rotated.item.envs).toEqual(['mac', 'office'])
    expect(rotated.item.allowedRealms).toEqual(['work'])
    expect(rotated.item.canWrite).toBe(false)

    // 旧密钥即刻返回 401
    const oldWhoami = await app.request('/v1/whoami', {
      headers: { authorization: `Bearer ${issued.key}` },
    })
    expect(oldWhoami.status).toBe(401)

    // 新密钥立即可用
    const newWhoami = await app.request('/v1/whoami', {
      headers: { authorization: `Bearer ${rotated.key}` },
    })
    expect(newWhoami.status).toBe(200)

    // 列表只包含未吊销的新密钥
    const list = ApiKeyListResponse.parse(
      await (await app.request('/v1/console/keys', { headers: { cookie } })).json(),
    )
    expect(list.items.map((k) => k.id)).toEqual([rotated.item.id])

    // DELETE 吊销新密钥
    const delRes = await app.request(`/v1/console/keys/${rotated.item.id}`, {
      method: 'DELETE',
      headers: consoleHeaders(cookie),
    })
    expect(delRes.status).toBe(204)

    const afterDel = await app.request('/v1/whoami', {
      headers: { authorization: `Bearer ${rotated.key}` },
    })
    expect(afterDel.status).toBe(401)
  })
})
