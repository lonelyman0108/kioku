import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { encryptSecret } from '../../crypto/envelope'
import { encryptionKey } from '../../crypto/keyring'
import { credentialAad } from '../../crypto/rotation'
import { formatCredentialMetadataList } from '../../mcp/format'
import { openCredentialPayload, prepareCredentialWrite } from '../service'

function makeMasterKey() {
  return randomBytes(32)
}

describe('复合凭据载荷归一化、解密兼容与 MCP 元数据格式化', () => {
  it('兼容旧版 { value } 与新版全员具名字段归一化，并对自定义字段默认机密', () => {
    const legacy = prepareCredentialWrite({ value: 'secret-only' })
    expect(legacy).toEqual({
      kind: 'secret',
      primaryField: 'value',
      fieldMeta: [{ name: 'value', label: '值', secret: true }],
      passkeyManualOnly: false,
      payload: {
        value: 'secret-only',
        fields: { value: 'secret-only' },
      },
    })

    const db = prepareCredentialWrite({
      kind: 'database',
      fields: {
        host: 'db.internal',
        port: '5432',
        url: 'postgres://app:pwd@db.internal:5432/prod',
        extra_note: 'custom-sensitive-by-default',
      },
    })
    expect(db.kind).toBe('database')
    expect(db.primaryField).toBe('url')
    expect(db.payload.value).toBe('postgres://app:pwd@db.internal:5432/prod')
    expect(db.fieldMeta).toEqual([
      { name: 'url', label: '连接串', secret: true },
      { name: 'host', label: '主机', secret: false },
      { name: 'port', label: '端口', secret: false },
      { name: 'extra_note', secret: true },
    ])

    // Passkey-only login 省略 password 时优雅回退默认字段为首个已填字段
    const passkeyLogin = prepareCredentialWrite({
      kind: 'login',
      primaryField: 'password',
      fields: {
        url: 'https://github.com/login',
        username: 'alice',
      },
      passkeyManualOnly: true,
    })
    expect(passkeyLogin.primaryField).toBe('url')
    expect(passkeyLogin.passkeyManualOnly).toBe(true)
    expect(passkeyLogin.payload.value).toBe('https://github.com/login')

    // 显式指定不存在的非模板默认字段直接报 400
    expect(() =>
      prepareCredentialWrite({
        kind: 'api',
        primaryField: 'missing_field',
        fields: { token: 'tok_123' },
      }),
    ).toThrow(/默认字段 missing_field 不在已填写字段中/)
  })

  it('openCredentialPayload 兼容历史纯字符串与 { value, fields? } 密文格式', () => {
    const masterKey = makeMasterKey()
    const { key, id: keyId } = encryptionKey(masterKey)
    const id = '11111111-1111-4111-8111-111111111111'

    const strSealed = encryptSecret(key, JSON.stringify('plain-str-secret'), credentialAad(id))
    expect(
      openCredentialPayload(masterKey, {
        id,
        primaryField: 'value',
        ciphertext: strSealed.ciphertext,
        wrappedKey: strSealed.wrappedKey,
        keyId,
      }),
    ).toEqual({
      value: 'plain-str-secret',
      fields: { value: 'plain-str-secret' },
    })

    const legacyObjSealed = encryptSecret(
      key,
      JSON.stringify({ value: 'main-val', fields: { webhook: 'whsec_1' } }),
      credentialAad(id),
    )
    expect(
      openCredentialPayload(masterKey, {
        id,
        primaryField: 'value',
        ciphertext: legacyObjSealed.ciphertext,
        wrappedKey: legacyObjSealed.wrappedKey,
        keyId,
      }),
    ).toEqual({
      value: 'main-val',
      fields: { value: 'main-val', webhook: 'whsec_1' },
    })
  })

  it('formatCredentialMetadataList 透出类型、字段明文/机密标注、默认字段与 Passkey 提示', () => {
    const text = formatCredentialMetadataList([
      {
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'prod-pg',
        label: '生产主库',
        description: '核心业务库',
        kind: 'database',
        primaryField: 'url',
        fieldMeta: [
          { name: 'url', label: '连接串', secret: true },
          { name: 'host', label: '主机', secret: false },
          { name: 'password', label: '密码', secret: true },
        ],
        passkeyManualOnly: false,
        provider: 'builtin',
        externalRef: null,
        allowedRealms: ['work'],
        createdAt: '2026-11-28T00:00:00.000Z',
        updatedAt: '2026-11-28T00:00:00.000Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        slug: 'github-admin',
        label: 'GitHub 管理员',
        description: null,
        kind: 'login',
        primaryField: 'username',
        fieldMeta: [{ name: 'username', label: '用户名', secret: false }],
        passkeyManualOnly: true,
        provider: 'builtin',
        externalRef: null,
        allowedRealms: null,
        createdAt: '2026-11-28T00:00:00.000Z',
        updatedAt: '2026-11-28T00:00:00.000Z',
      },
    ])

    expect(text).toContain('`prod-pg`（生产主库 · 数据库连接） [场域: work] — 核心业务库')
    expect(text).toContain('`url`（机密，默认）、`host`（明文）、`password`（机密）')
    expect(text).toContain('`github-admin`（GitHub 管理员 · 账号与密码）')
    expect(text).toContain('需人工 Passkey 登录，不可自动注入')
    expect(text).toContain('{{cred:<slug>#<field>}}')
    expect(text).toContain('kioku run -e VAR=<slug>#<field>')
  })
})
