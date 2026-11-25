import {
  CredentialListResponse,
  CredentialMeta,
  ResolveCredentialsResponse,
  RevealCredentialResponse,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '../../db/client'
import {
  consoleHeaders,
  createOwnerSession,
  createTestApp,
  issueTestApiKey,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'

describe.skipIf(!testDatabaseUrl)('托管加密凭据：控制台 CRUD、显式查看与原子解析', () => {
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

  it('控制台支持创建/编辑/查看（no-store）/删除，且不暴露明文在列表接口', async () => {
    const app = createTestApp(database, { masterKey: testMasterKey() })
    const { cookie } = await createOwnerSession(database)

    const createdRes = await app.request('/v1/console/credentials', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        slug: 'github-deploy',
        label: 'GitHub Deploy',
        description: '生产发布令牌',
        value: 'ghp_main_secret_value',
        fields: { token: 'ghp_sub_token', username: 'deploy-bot' },
        allowedRealms: ['work'],
      }),
    })
    expect(createdRes.status).toBe(201)
    const meta = CredentialMeta.parse(await createdRes.json())
    expect(meta.slug).toBe('github-deploy')
    expect(meta.allowedRealms).toEqual(['work'])

    // 列表接口只含元数据
    const listRes = await app.request('/v1/console/credentials', { headers: { cookie } })
    const rawList = await listRes.text()
    expect(rawList).not.toContain('ghp_main_secret_value')
    expect(CredentialListResponse.parse(JSON.parse(rawList)).items).toHaveLength(1)

    // 显式查看返回明文并带 Cache-Control: no-store
    const revealRes = await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
      method: 'POST',
      headers: consoleHeaders(cookie),
    })
    expect(revealRes.status).toBe(200)
    expect(revealRes.headers.get('cache-control')).toContain('no-store')
    const revealed = RevealCredentialResponse.parse(await revealRes.json())
    expect(revealed.value).toBe('ghp_main_secret_value')
    expect(revealed.fields).toEqual({ token: 'ghp_sub_token', username: 'deploy-bot' })

    // 更新描述与附加字段
    const patchRes = await app.request(`/v1/console/credentials/${meta.id}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        label: 'GitHub Prod',
        value: 'ghp_updated_value',
      }),
    })
    expect(patchRes.status).toBe(200)
    expect(CredentialMeta.parse(await patchRes.json()).label).toBe('GitHub Prod')

    // 删除凭据
    const delRes = await app.request(`/v1/console/credentials/${meta.id}`, {
      method: 'DELETE',
      headers: consoleHeaders(cookie),
    })
    expect(delRes.status).toBe(204)
  })

  it('POST /v1/credentials/resolve 支持裸 slug、field 桥接与复合 slug-field，并严格执行 fail-closed', async () => {
    const app = createTestApp(database, { masterKey: testMasterKey() })
    const { cookie } = await createOwnerSession(database)

    // 1) work 场域凭据（含主值与附加字段）
    await app.request('/v1/console/credentials', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        slug: 'stripe-api',
        label: 'Stripe',
        value: 'sk_live_main',
        fields: { webhook: 'whsec_123' },
        allowedRealms: ['work'],
      }),
    })
    // 2) 未标场域的凭据（仅全权限密钥可用，受限密钥 fail-closed 不可用）
    await app.request('/v1/console/credentials', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        slug: 'root-vault',
        label: 'Root Vault',
        value: 'root_secret_value',
        allowedRealms: null,
      }),
    })

    const noPermKey = await issueTestApiKey(database, {
      allowedRealms: null,
      canResolveCredentials: false,
    })
    const workKey = await issueTestApiKey(database, {
      allowedRealms: ['work'],
      canResolveCredentials: true,
    })
    const fullKey = await issueTestApiKey(database, {
      allowedRealms: null,
      canResolveCredentials: true,
    })

    // 未授权读取凭据的密钥直接 403
    const deniedPerm = await app.request('/v1/credentials/resolve', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${noPermKey.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refs: [{ identifier: 'stripe-api' }] }),
    })
    expect(deniedPerm.status).toBe(403)

    // workKey 可以解析 stripe-api（裸 slug、显式 field 两种方式）
    const okWork = await app.request('/v1/credentials/resolve', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workKey.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        refs: [{ identifier: 'stripe-api' }, { identifier: 'stripe-api', field: 'webhook' }],
      }),
    })
    expect(okWork.status).toBe(200)
    expect(okWork.headers.get('cache-control')).toContain('no-store')
    const parsedWork = ResolveCredentialsResponse.parse(await okWork.json())
    expect(parsedWork.values).toEqual([
      { identifier: 'stripe-api', field: 'value', value: 'sk_live_main' },
      { identifier: 'stripe-api', field: 'webhook', value: 'whsec_123' },
    ])
    expect(parsedWork.expired).toEqual([])

    // 原型链属性名（如 constructor）不得命中 Object.prototype，应安全回退至主值
    const protoField = await app.request('/v1/credentials/resolve', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workKey.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        refs: [{ identifier: 'stripe-api', field: 'constructor' }],
      }),
    })
    expect(protoField.status).toBe(200)
    expect(ResolveCredentialsResponse.parse(await protoField.json()).values).toEqual([
      { identifier: 'stripe-api', field: 'constructor', value: 'sk_live_main' },
    ])

    // workKey 请求未标场域的 root-vault：fail-closed 返回 404（不泄露存在性）
    const failClosed = await app.request('/v1/credentials/resolve', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workKey.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refs: [{ identifier: 'root-vault' }] }),
    })
    expect(failClosed.status).toBe(404)

    // fullKey（allowedRealms=null）可以同时解析全部凭据
    const okFull = await app.request('/v1/credentials/resolve', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fullKey.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refs: [{ identifier: 'root-vault' }] }),
    })
    expect(okFull.status).toBe(200)
    expect(ResolveCredentialsResponse.parse(await okFull.json()).values).toEqual([
      { identifier: 'root-vault', field: 'value', value: 'root_secret_value' },
    ])
  })
})
