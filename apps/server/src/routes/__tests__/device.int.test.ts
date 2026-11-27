import {
  DeviceAuthorizeResponse,
  DeviceGrantApproveResponse,
  DeviceGrantLookupResponse,
  DeviceTokenResponse,
  WhoAmIResponse,
} from '@kioku/contracts'
import { count } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '../../db/client'
import { apiKeys } from '../../db/schema'
import {
  consoleHeaders,
  createOwnerSession,
  createTestApp,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'

describe.skipIf(!testDatabaseUrl)(
  '设备授权流（延迟签发密钥、单/多平台、拒绝与 other 兼容）',
  () => {
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

    it('单平台授权采用延迟签发：approve 不落库 api_keys，首次 token 轮询才签发并销毁授权单', async () => {
      const app = createTestApp(database, { masterKey: testMasterKey() })
      const { cookie } = await createOwnerSession(database)

      // 1. CLI 发起单平台设备授权（验证 other 兼容归一到 generic）
      const authRes = await app.request('/v1/device/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeFamily: 'other', clientName: 'My CLI' }),
      })
      expect(authRes.status).toBe(201)
      const auth = DeviceAuthorizeResponse.parse(await authRes.json())

      // 轮询尚处于 pending
      const pendingRes = await app.request('/v1/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: auth.deviceCode }),
      })
      expect(DeviceTokenResponse.parse(await pendingRes.json())).toEqual({ status: 'pending' })

      // 2. 控制台按确认码查询待审授权
      const lookupRes = await app.request('/v1/device/grants/lookup', {
        method: 'POST',
        headers: consoleHeaders(cookie, true),
        body: JSON.stringify({ userCode: auth.userCode }),
      })
      expect(lookupRes.status).toBe(200)
      const lookup = DeviceGrantLookupResponse.parse(await lookupRes.json())
      expect(lookup.platforms).toEqual([{ runtimeFamily: 'generic', clientName: 'My CLI' }])

      // 3. 控制台批准授权并指定终端透镜
      const approveRes = await app.request('/v1/device/grants/approve', {
        method: 'POST',
        headers: consoleHeaders(cookie, true),
        body: JSON.stringify({
          userCode: auth.userCode,
          envs: ['mac'],
          allowedRealms: ['work'],
          focusRealms: ['work'],
          canWrite: true,
          canResolveCredentials: true,
          items: [{ runtimeFamily: 'generic', keyName: 'Work CLI' }],
        }),
      })
      expect(approveRes.status).toBe(200)
      expect(DeviceGrantApproveResponse.parse(await approveRes.json()).items).toEqual([
        { runtimeFamily: 'generic', keyName: 'Work CLI' },
      ])

      // 延迟签发关键不变量：approve 之后、CLI 拉取之前，api_keys 表必须仍为 0 条
      const [beforePoll] = await database.db.select({ n: count() }).from(apiKeys)
      expect(beforePoll?.n).toBe(0)

      // 4. CLI 首次轮询换取明文密钥并自动消费删除授权单
      const tokenRes = await app.request('/v1/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: auth.deviceCode }),
      })
      expect(tokenRes.status).toBe(200)
      expect(tokenRes.headers.get('cache-control')).toContain('no-store')
      const tokenBody = DeviceTokenResponse.parse(await tokenRes.json())
      expect(tokenBody.status).toBe('approved')
      if (tokenBody.status !== 'approved' || !('key' in tokenBody)) {
        throw new Error('expected single-platform approved key')
      }
      expect(tokenBody.key).toMatch(/^kioku_/)
      expect(tokenBody.client.runtimeFamily).toBe('generic')

      // 拿到的密钥可立刻通过 /v1/whoami 认证并带有配置好的透镜
      const whoami = WhoAmIResponse.parse(
        await (
          await app.request('/v1/whoami', {
            headers: { authorization: `Bearer ${tokenBody.key}` },
          })
        ).json(),
      )
      expect(whoami.key.envs).toEqual(['mac'])
      expect(whoami.key.allowedRealms).toEqual(['work'])
      expect(whoami.key.focusRealms).toEqual(['work'])
      expect(whoami.key.canResolveCredentials).toBe(true)

      // 二次轮询同一个 deviceCode 必须返回 expired（一次性消费）
      const secondPoll = await app.request('/v1/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: auth.deviceCode }),
      })
      expect(DeviceTokenResponse.parse(await secondPoll.json())).toEqual({ status: 'expired' })
    })

    it('多平台授权支持部分跳过与拒绝流', async () => {
      const app = createTestApp(database, { masterKey: testMasterKey() })
      const { cookie } = await createOwnerSession(database)

      const auth = DeviceAuthorizeResponse.parse(
        await (
          await app.request('/v1/device/authorize', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              platforms: [
                { runtimeFamily: 'claudecode', clientName: 'Claude Code' },
                { runtimeFamily: 'codex', clientName: 'Codex' },
              ],
            }),
          })
        ).json(),
      )

      const approveRes = await app.request('/v1/device/grants/approve', {
        method: 'POST',
        headers: consoleHeaders(cookie, true),
        body: JSON.stringify({
          userCode: auth.userCode,
          envs: ['mac'],
          allowedRealms: null,
          canWrite: true,
          canResolveCredentials: false,
          items: [
            { runtimeFamily: 'claudecode', keyName: 'Mac Claude' },
            { runtimeFamily: 'codex', skip: true },
          ],
        }),
      })
      expect(approveRes.status).toBe(200)

      const tokenBody = DeviceTokenResponse.parse(
        await (
          await app.request('/v1/device/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceCode: auth.deviceCode }),
          })
        ).json(),
      )
      expect(tokenBody.status).toBe('approved')
      if (tokenBody.status !== 'approved' || !('keys' in tokenBody)) {
        throw new Error('expected multi-platform keys')
      }
      expect(tokenBody.keys).toHaveLength(2)
      expect(tokenBody.keys[0]?.status).toBe('issued')
      expect(tokenBody.keys[1]).toEqual({ runtimeFamily: 'codex', status: 'skipped' })

      // 拒绝授权流
      const deniedAuth = DeviceAuthorizeResponse.parse(
        await (
          await app.request('/v1/device/authorize', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runtimeFamily: 'gemini' }),
          })
        ).json(),
      )
      const denyRes = await app.request('/v1/device/grants/deny', {
        method: 'POST',
        headers: consoleHeaders(cookie, true),
        body: JSON.stringify({ userCode: deniedAuth.userCode }),
      })
      expect(denyRes.status).toBe(204)

      const deniedToken = DeviceTokenResponse.parse(
        await (
          await app.request('/v1/device/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceCode: deniedAuth.deviceCode }),
          })
        ).json(),
      )
      expect(deniedToken).toEqual({ status: 'denied' })
    })
  },
)
