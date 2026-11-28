import { randomUUID } from 'node:crypto'

import {
  CredentialListResponse,
  CredentialMeta,
  CredentialReferencesResponse,
  EntryDetailResponse,
  InboxResponse,
  ResolveCredentialsResponse,
  RevealCredentialResponse,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import { encryptSecret } from '../../crypto/envelope'
import { encryptionKey } from '../../crypto/keyring'
import { credentialAad } from '../../crypto/rotation'
import type { Database } from '../../db/client'
import { credentials } from '../../db/schema'
import { EntryService } from '../../memory/service'
import {
  consoleHeaders,
  createOwnerSession,
  createTestApp,
  entryInput,
  issueTestApiKey,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'

describe.skipIf(!testDatabaseUrl)('托管加密凭据：复合字段、受控解密、严格解析与引用反查', () => {
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

  it('控制台兼容旧版单值与附加字段创建/编辑/查看（no-store）/删除，且不暴露明文在列表接口', async () => {
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
    expect(meta.kind).toBe('secret')
    expect(meta.primaryField).toBe('value')
    expect(meta.allowedRealms).toEqual(['work'])
    expect(meta.fieldMeta.map((f) => f.name)).toEqual(['value', 'token', 'username'])

    // 列表接口只含元数据
    const listRes = await app.request('/v1/console/credentials', { headers: { cookie } })
    const rawList = await listRes.text()
    expect(rawList).not.toContain('ghp_main_secret_value')
    expect(rawList).not.toContain('ghp_sub_token')
    expect(rawList).not.toContain('deploy-bot')
    expect(CredentialListResponse.parse(JSON.parse(rawList)).items).toHaveLength(1)

    // 空请求体显式查看返回全量明文并带 Cache-Control: no-store
    const revealRes = await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
      method: 'POST',
      headers: consoleHeaders(cookie),
    })
    expect(revealRes.status).toBe(200)
    expect(revealRes.headers.get('cache-control')).toContain('no-store')
    const revealed = RevealCredentialResponse.parse(await revealRes.json())
    expect(revealed.value).toBe('ghp_main_secret_value')
    expect(revealed.fields).toEqual({
      value: 'ghp_main_secret_value',
      token: 'ghp_sub_token',
      username: 'deploy-bot',
    })

    // 更新名称与主值时保留其余附加字段
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

    const revealedAfter = RevealCredentialResponse.parse(
      await (
        await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
          method: 'POST',
          headers: consoleHeaders(cookie),
        })
      ).json(),
    )
    expect(revealedAfter.value).toBe('ghp_updated_value')
    expect(revealedAfter.fields).toEqual({
      value: 'ghp_updated_value',
      token: 'ghp_sub_token',
      username: 'deploy-bot',
    })

    // 删除凭据
    const delRes = await app.request(`/v1/console/credentials/${meta.id}`, {
      method: 'DELETE',
      headers: consoleHeaders(cookie),
    })
    expect(delRes.status).toBe(204)
  })

  it('复合凭据全量密文落库、分层受控 reveal 与原地合并/移除字段生效', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)

    const createRes = await app.request('/v1/console/credentials', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        slug: 'prod-pg-main',
        label: '生产 PostgreSQL',
        description: '核心业务主库',
        kind: 'database',
        fields: {
          host: 'pg.prod.internal',
          port: '5432',
          database: 'orders',
          username: 'svc_app',
          password: 'DbPasswordSecret99',
          url: 'postgres://svc_app:DbPasswordSecret99@pg.prod.internal:5432/orders',
        },
        allowedRealms: ['work'],
      }),
    })
    expect(createRes.status).toBe(201)
    const meta = CredentialMeta.parse(await createRes.json())
    expect(meta.kind).toBe('database')
    expect(meta.primaryField).toBe('url')
    expect(meta.provider).toBe('builtin')
    expect(meta.externalRef).toBeNull()
    expect(meta.passkeyManualOnly).toBe(false)
    expect(meta.fieldMeta.map((f) => `${f.name}:${f.secret ? 's' : 'p'}`)).toEqual([
      'url:s',
      'host:p',
      'port:p',
      'database:p',
      'username:p',
      'password:s',
    ])

    // 验证数据库表非密文列绝不存储任何字段值（哪怕是 secret=false 的 host/username）
    const [dbRow] = await database.db
      .select()
      .from(credentials)
      .where(eq(credentials.id, meta.id))
      .limit(1)
    expect(dbRow).toBeTruthy()
    const nonCipherColumns = JSON.stringify({
      slug: dbRow!.slug,
      label: dbRow!.label,
      description: dbRow!.description,
      kind: dbRow!.kind,
      primaryField: dbRow!.primaryField,
      fieldMeta: dbRow!.fieldMeta,
      externalRef: dbRow!.externalRef,
    })
    expect(nonCipherColumns).not.toContain('pg.prod.internal')
    expect(nonCipherColumns).not.toContain('svc_app')
    expect(nonCipherColumns).not.toContain('DbPasswordSecret99')
    const initialCiphertextHex = dbRow!.ciphertext.toString('hex')

    // 1) scope='plain' 仅返回 secret=false 字段，绝不泄露机密字段
    const plainRes = await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ scope: 'plain' }),
    })
    expect(plainRes.status).toBe(200)
    expect(plainRes.headers.get('cache-control')).toContain('no-store')
    const plainRaw = await plainRes.text()
    expect(plainRaw).not.toContain('DbPasswordSecret99')
    expect(plainRaw).not.toContain('postgres://')
    const plainParsed = RevealCredentialResponse.parse(JSON.parse(plainRaw))
    expect(plainParsed.value).toBeUndefined()
    expect(plainParsed.fields).toEqual({
      host: 'pg.prod.internal',
      port: '5432',
      database: 'orders',
      username: 'svc_app',
    })

    // 2) 指定单字段 reveal 仅返回目标字段，缺失或原型链字段返回 404
    const singleRes = await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ field: 'password' }),
    })
    expect(singleRes.status).toBe(200)
    expect(singleRes.headers.get('cache-control')).toContain('no-store')
    expect(RevealCredentialResponse.parse(await singleRes.json())).toEqual({
      field: 'password',
      value: 'DbPasswordSecret99',
    })

    const missingSingle = await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ field: 'constructor' }),
    })
    expect(missingSingle.status).toBe(404)

    // 未知键名（如拼写错误 scpoe）必须返回 400，严禁静默升级为全量解密
    const typoReveal = await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ scpoe: 'plain' }),
    })
    expect(typoReveal.status).toBe(400)

    // 3) 仅改元信息不触碰密文字节
    const metaOnlyPatch = await app.request(`/v1/console/credentials/${meta.id}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        label: '生产主库（只改元信息）',
        description: '更新说明但不重封密文',
      }),
    })
    expect(metaOnlyPatch.status).toBe(200)
    const [afterMetaRow] = await database.db
      .select({ ciphertext: credentials.ciphertext })
      .from(credentials)
      .where(eq(credentials.id, meta.id))
      .limit(1)
    expect(afterMetaRow!.ciphertext.toString('hex')).toBe(initialCiphertextHex)

    // 4) 原地更新单个字段并新增自定义字段，不重传未修改机密字段；同时移除一个字段
    const partialPatch = await app.request(`/v1/console/credentials/${meta.id}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        fields: {
          password: 'RotatedPassword2026',
          region: 'ap-east-1',
        },
        fieldMeta: [
          ...meta.fieldMeta.filter((f) => f.name !== 'port'),
          { name: 'region', label: '区域', secret: false },
        ],
        removeFields: ['port'],
      }),
    })
    expect(partialPatch.status).toBe(200)
    const updatedMeta = CredentialMeta.parse(await partialPatch.json())
    expect(updatedMeta.fieldMeta.map((f) => f.name)).not.toContain('port')
    expect(updatedMeta.fieldMeta.find((f) => f.name === 'region')).toEqual({
      name: 'region',
      label: '区域',
      secret: false,
    })

    const fullAfter = RevealCredentialResponse.parse(
      await (
        await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ scope: 'all' }),
        })
      ).json(),
    )
    expect(fullAfter.fields).toEqual({
      host: 'pg.prod.internal',
      database: 'orders',
      username: 'svc_app',
      password: 'RotatedPassword2026',
      url: 'postgres://svc_app:DbPasswordSecret99@pg.prod.internal:5432/orders',
      region: 'ap-east-1',
    })

    // 移除全部字段应返回 400
    const removeAllRes = await app.request(`/v1/console/credentials/${meta.id}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        removeFields: ['host', 'database', 'username', 'password', 'url', 'region'],
      }),
    })
    expect(removeAllRes.status).toBe(400)

    // 显式传 fieldMeta 省略 label 时不回带旧 label；同时传 value 与 fields[primaryField] 以 fields 为准
    const overrideMetaRes = await app.request(`/v1/console/credentials/${meta.id}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        value: 'ignored-legacy-url',
        fields: { url: 'postgres://svc_app:NewPass@pg.prod.internal:5432/orders' },
        fieldMeta: [{ name: 'region', secret: false }],
      }),
    })
    expect(overrideMetaRes.status).toBe(200)
    const overrideMeta = CredentialMeta.parse(await overrideMetaRes.json())
    expect(overrideMeta.fieldMeta.find((f) => f.name === 'region')).toEqual({
      name: 'region',
      secret: false,
    })
    const afterOverrideReveal = RevealCredentialResponse.parse(
      await (
        await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ field: 'url' }),
        })
      ).json(),
    )
    expect(afterOverrideReveal.value).toBe(
      'postgres://svc_app:NewPass@pg.prod.internal:5432/orders',
    )

    // PATCH 传入 fields: null + primaryField（未传 value）只保留该字段原值，绝不将机密主值复制降级为明文
    const missingPrimaryNull = await app.request(`/v1/console/credentials/${meta.id}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ fields: null, primaryField: 'nonexistent' }),
    })
    expect(missingPrimaryNull.status).toBe(400)

    const clearToPlainHost = await app.request(`/v1/console/credentials/${meta.id}`, {
      method: 'PATCH',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({ fields: null, primaryField: 'host' }),
    })
    expect(clearToPlainHost.status).toBe(200)
    const clearedMeta = CredentialMeta.parse(await clearToPlainHost.json())
    expect(clearedMeta.primaryField).toBe('host')
    expect(clearedMeta.fieldMeta).toEqual([{ name: 'host', label: '主机', secret: false }])
    const plainAfterClear = RevealCredentialResponse.parse(
      await (
        await app.request(`/v1/console/credentials/${meta.id}/reveal`, {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ scope: 'plain' }),
        })
      ).json(),
    )
    expect(plainAfterClear).toEqual({ fields: { host: 'pg.prod.internal' } })
  })

  it('POST /v1/credentials/resolve 严格校验 #field 拒绝静默回退，且兼容裸 slug、独立复合凭据与老密文', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)

    // 1) work 场域复合凭据（默认字段 url，另含 host 与自定义同名字段 custom）
    await app.request('/v1/console/credentials', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        slug: 'prod-db',
        label: '生产数据库',
        kind: 'database',
        fields: {
          host: 'pg.prod.internal',
          password: 'DbSecretValue',
          url: 'postgres://app:DbSecretValue@pg.prod.internal:5432/prod',
        },
        allowedRealms: ['work'],
      }),
    })
    // 2) 同名独立拆分凭据（prod-db-host 不得遮蔽 prod-db 自有 host；prod-db-readonly 作为缺失字段回退命中）
    await app.request('/v1/console/credentials', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        slug: 'prod-db-host',
        label: '旧拆分主机',
        value: 'legacy-shadow-host.internal',
        allowedRealms: ['work'],
      }),
    })
    await app.request('/v1/console/credentials', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        slug: 'prod-db-readonly',
        label: '生产库只读串',
        value: 'postgres://ro:RoSecret@pg.prod.internal:5432/prod',
        allowedRealms: ['work'],
      }),
    })
    // 3) 未标场域的凭据（受限密钥 fail-closed 不可用）
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
    // 4) 模拟老库迁移行（field_meta = []、旧格式 { value } 密文）
    const legacyId = randomUUID()
    const { key: encKey, id: encKeyId } = encryptionKey(masterKey)
    const legacySealed = encryptSecret(
      encKey,
      JSON.stringify({ value: 'legacy_token_val' }),
      credentialAad(legacyId),
    )
    await database.db.insert(credentials).values({
      id: legacyId,
      slug: 'legacy-token',
      label: '历史单值凭据',
      kind: 'secret',
      primaryField: 'value',
      fieldMeta: [],
      passkeyManualOnly: false,
      provider: 'builtin',
      externalRef: null,
      allowedRealms: ['work'],
      ciphertext: legacySealed.ciphertext,
      wrappedKey: legacySealed.wrappedKey,
      keyId: encKeyId,
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
      body: JSON.stringify({ refs: [{ identifier: 'prod-db' }] }),
    })
    expect(deniedPerm.status).toBe(403)

    // 裸 slug 解析 primaryField（返回兼容字段名 'value'），显式 #field 解析具名字段或 <slug>-<field>，老密文兼容裸 slug 与 #value
    const okWork = await app.request('/v1/credentials/resolve', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workKey.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        refs: [
          { identifier: 'prod-db' },
          { identifier: 'prod-db', field: 'host' },
          { identifier: 'prod-db', field: 'readonly' },
          { identifier: 'legacy-token' },
          { identifier: 'legacy-token', field: 'value' },
        ],
      }),
    })
    expect(okWork.status).toBe(200)
    expect(okWork.headers.get('cache-control')).toContain('no-store')
    const parsedWork = ResolveCredentialsResponse.parse(await okWork.json())
    expect(parsedWork.values).toEqual([
      {
        identifier: 'prod-db',
        field: 'value',
        value: 'postgres://app:DbSecretValue@pg.prod.internal:5432/prod',
      },
      { identifier: 'prod-db', field: 'host', value: 'pg.prod.internal' },
      {
        identifier: 'prod-db',
        field: 'readonly',
        value: 'postgres://ro:RoSecret@pg.prod.internal:5432/prod',
      },
      { identifier: 'legacy-token', field: 'value', value: 'legacy_token_val' },
      { identifier: 'legacy-token', field: 'value', value: 'legacy_token_val' },
    ])
    expect(parsedWork.expired).toEqual([])

    // 不存在的具名字段与原型链属性名均返回 404，严禁静默回退主值
    for (const badRef of [
      { identifier: 'prod-db', field: 'nonexistent' },
      { identifier: 'prod-db', field: 'constructor' },
      { identifier: 'legacy-token', field: 'nonexistent' },
    ]) {
      const badRes = await app.request('/v1/credentials/resolve', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${workKey.key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ refs: [badRef] }),
      })
      expect(badRes.status).toBe(404)
    }

    // 老迁移行（field_meta=[]）在 scope='plain' 下 fail-closed 不返回任何值
    const legacyPlain = RevealCredentialResponse.parse(
      await (
        await app.request(`/v1/console/credentials/${legacyId}/reveal`, {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ scope: 'plain' }),
        })
      ).json(),
    )
    expect(legacyPlain).toEqual({ fields: {} })

    // workKey 请求未标场域的 root-vault：fail-closed 返回 404
    const failClosed = await app.request('/v1/credentials/resolve', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workKey.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refs: [{ identifier: 'root-vault' }] }),
    })
    expect(failClosed.status).toBe(404)

    // fullKey（allowedRealms=null）可以解析未标场域凭据
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

    // placeholderStatuses 免解密精确判定 #field 与老数据兼容
    const entryRes = await app.request('/v1/console/entries', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        title: '凭据占位符校验',
        content: [
          '默认：{{cred:prod-db}}',
          '有效字段：{{cred:prod-db#host}}',
          '拆分凭据：{{cred:prod-db#readonly}}',
          '无效字段：{{cred:prod-db#nonexistent}}',
          '老凭据裸引用：{{cred:legacy-token}}',
          '老凭据主值：{{cred:legacy-token#value}}',
          '老凭据未知字段：{{cred:legacy-token#extra}}',
        ].join('\n'),
        realms: ['work'],
      }),
    })
    expect(entryRes.status).toBe(201)
    const entryDetail = EntryDetailResponse.parse(await entryRes.json())
    expect(entryDetail.credentialRefs).toEqual([
      { slug: 'prod-db', field: null, available: true, label: '生产数据库' },
      { slug: 'prod-db', field: 'host', available: true, label: '生产数据库' },
      { slug: 'prod-db', field: 'readonly', available: true, label: '生产库只读串' },
      { slug: 'prod-db', field: 'nonexistent', available: false, label: null },
      { slug: 'legacy-token', field: null, available: true, label: '历史单值凭据' },
      { slug: 'legacy-token', field: 'value', available: true, label: '历史单值凭据' },
      { slug: 'legacy-token', field: 'extra', available: false, label: null },
    ])
  })

  it('GET /v1/console/credentials/:id/references 精确反查引用记忆并排除软删除、会话摘要与前缀碰撞', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const target = await credSvc.create({
      slug: 'prod_db',
      label: '生产库',
      kind: 'database',
      fields: { host: 'pg.internal', url: 'postgres://app:pwd@pg.internal:5432/prod' },
    })

    const hitA = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '运维排查手册',
        content: '连接 {{cred:prod_db}} 与主机 {{cred:prod_db#host}}，重复 {{cred:prod_db#host}}。',
        realms: ['work'],
      }),
    )
    const hitB = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '迁移规范',
        content: '执行迁移时使用 {{cred:prod_db#url}}。',
        realms: ['work'],
      }),
    )
    // 前缀碰撞（prod_db-backup 与下划线通配符 prodXdb）不应误命中
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '备库说明',
        content: '使用 {{cred:prod_db-backup}} 与 {{cred:prodXdb}}。',
      }),
    )
    // 软删除记忆不应命中
    const deletedEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '已废弃手册',
        content: '旧连接 {{cred:prod_db}}。',
      }),
    )
    await entrySvc.remove(consoleScope, deletedEntry.entry.shortId)
    // 会话摘要（episode）不应命中
    await entrySvc.writeEpisode({
      title: '调试摘要',
      content: '排查了 {{cred:prod_db}} 连接。',
      deviceKey: 'mac',
      projectSlug: 'kioku',
    })

    const refRes = await app.request(`/v1/console/credentials/${target.id}/references`, {
      headers: { cookie },
    })
    expect(refRes.status).toBe(200)
    const parsed = CredentialReferencesResponse.parse(await refRes.json())
    expect(parsed.items).toHaveLength(2)

    const byShort = new Map(parsed.items.map((item) => [item.shortId, item]))
    expect(byShort.get(hitA.entry.shortId)).toMatchObject({
      id: hitA.entry.id,
      title: '运维排查手册',
      realms: ['work'],
      fields: [null, 'host'],
    })
    expect(byShort.get(hitB.entry.shortId)).toMatchObject({
      id: hitB.entry.id,
      title: '迁移规范',
      realms: ['work'],
      fields: ['url'],
    })

    // 不存在的凭据 ID 返回 404
    const notFound = await app.request(`/v1/console/credentials/${randomUUID()}/references`, {
      headers: { cookie },
    })
    expect(notFound.status).toBe(404)

    // 单条规范暂存接口对 secretWarnings 执行二次脱敏清洗，落库与 /console/inbox 均不回显明文
    const rawSecret = ['sk', 'proj', '5566778899abcdefghijkl'].join('-')
    const stageRes = await app.request(`/v1/console/entries/${hitA.entry.shortId}/tidy/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        expectedVersion: hitA.entry.version,
        title: hitA.entry.title,
        summary: '整理后概要',
        content: hitA.entry.content,
        stageToInbox: true,
        secretWarnings: [
          {
            label: `疑似密钥 ${rawSecret}`,
            location: '## 配置 P@ss*w0rd:99',
            maskedSnippet: 'postgres://a:p@ss@word@db.internal:5432/p',
          },
        ],
      }),
    })
    expect(stageRes.status).toBe(200)
    const inboxRes = await app.request('/v1/console/inbox', { headers: { cookie } })
    expect(inboxRes.status).toBe(200)
    const inboxRaw = await inboxRes.text()
    expect(inboxRaw).not.toContain(rawSecret)
    expect(inboxRaw).not.toContain('P@ss*w0rd:99')
    expect(inboxRaw).not.toContain('p@ss@word')
    const inbox = InboxResponse.parse(JSON.parse(inboxRaw))
    expect(inbox.items[0]?.secretWarnings).toEqual([
      {
        label: '疑似密钥 sk-***',
        location: '## 配置 P***',
        maskedSnippet: 'pos***',
      },
    ])
  })
})
