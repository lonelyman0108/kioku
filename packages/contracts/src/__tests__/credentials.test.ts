import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_KINDS,
  CREDENTIAL_TEMPLATES,
  CreateCredentialRequest,
  defaultFieldMetaForKind,
  defaultPrimaryFieldForKind,
  getCredentialTemplate,
  RevealCredentialRequest,
  RevealCredentialResponse,
} from '../credentials'

describe('credential contracts and templates', () => {
  it('exposes all five templates with expected default primary fields and returns fresh copies', () => {
    expect(CREDENTIAL_KINDS).toEqual(['secret', 'login', 'api', 'database', 'ssh'])
    expect(defaultPrimaryFieldForKind('secret')).toBe('value')
    expect(defaultPrimaryFieldForKind('login')).toBe('password')
    expect(defaultPrimaryFieldForKind('api')).toBe('token')
    expect(defaultPrimaryFieldForKind('database')).toBe('url')
    expect(defaultPrimaryFieldForKind('ssh')).toBe('private_key')

    for (const kind of CREDENTIAL_KINDS) {
      const tpl = getCredentialTemplate(kind)
      expect(tpl).toBe(CREDENTIAL_TEMPLATES[kind])
      expect(tpl.fields.some((f) => f.name === tpl.defaultPrimaryField)).toBe(true)
    }

    const dbFields = defaultFieldMetaForKind('database')
    expect(dbFields.map((f) => `${f.name}:${f.secret ? 'secret' : 'plain'}`)).toEqual([
      'url:secret',
      'host:plain',
      'port:plain',
      'database:plain',
      'username:plain',
      'password:secret',
    ])
    dbFields[0]!.secret = false
    expect(CREDENTIAL_TEMPLATES.database.fields[0]!.secret).toBe(true)
  })

  it('validates both composite and legacy CreateCredentialRequest payloads', () => {
    const legacy = CreateCredentialRequest.safeParse({
      slug: 'cf-token',
      label: 'Cloudflare',
      value: 'cf_secret_123',
    })
    expect(legacy.success).toBe(true)

    const composite = CreateCredentialRequest.safeParse({
      slug: 'prod-pg',
      label: 'Production DB',
      kind: 'database',
      primaryField: 'url',
      fieldMeta: [
        { name: 'host', label: '主机', secret: false },
        { name: 'url', label: '连接串', secret: true },
      ],
      fields: {
        host: 'db.internal',
        url: 'postgres://app:pwd@db.internal:5432/prod',
      },
      passkeyManualOnly: false,
      allowedRealms: ['work'],
    })
    expect(composite.success).toBe(true)

    const empty = CreateCredentialRequest.safeParse({
      slug: 'empty-cred',
      label: 'Empty',
    })
    expect(empty.success).toBe(false)

    const dupMeta = CreateCredentialRequest.safeParse({
      slug: 'dup-meta',
      label: 'Dup Meta',
      fields: { token: 'abc' },
      fieldMeta: [
        { name: 'token', secret: true },
        { name: 'token', secret: false },
      ],
    })
    expect(dupMeta.success).toBe(false)
  })

  it('validates controlled reveal request and response shapes', () => {
    expect(RevealCredentialRequest.safeParse({}).success).toBe(true)
    expect(RevealCredentialRequest.safeParse({ scope: 'plain' }).success).toBe(true)
    expect(RevealCredentialRequest.safeParse({ scope: 'all' }).success).toBe(true)
    expect(RevealCredentialRequest.safeParse({ field: 'password' }).success).toBe(true)
    expect(RevealCredentialRequest.safeParse({ scope: 'plain', field: 'host' }).success).toBe(false)
    // 严格拒绝未知键名，防止拼写错误静默降级为全量解密
    expect(RevealCredentialRequest.safeParse({ scpoe: 'plain' }).success).toBe(false)

    expect(
      RevealCredentialResponse.safeParse({ value: 'sec', fields: { value: 'sec' } }).success,
    ).toBe(true)
    expect(RevealCredentialResponse.safeParse({ fields: { host: 'db.internal' } }).success).toBe(
      true,
    )
    expect(RevealCredentialResponse.safeParse({ field: 'password', value: 'sec' }).success).toBe(
      true,
    )
    expect(RevealCredentialResponse.safeParse({}).success).toBe(false)
  })
})
