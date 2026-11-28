import { describe, expect, it } from 'vitest'

import {
  detectSecretPrefixes,
  ExportDataRequest,
  ExportedCredentialRecord,
  findSecretMatches,
  KIOKU_EXPORT_FORMAT,
  KiokuExportBundle,
  LORE_BACKUP_FORMAT,
  LoreBackupUpload,
} from '../transfer'

describe('transfer contracts', () => {
  it('validates ExportDataRequest passphrase requirement for encrypted credentials', () => {
    expect(ExportDataRequest.safeParse({ format: 'json', includeCredentials: false }).success).toBe(
      true,
    )
    expect(ExportDataRequest.safeParse({ format: 'json', includeCredentials: true }).success).toBe(
      false,
    )
    expect(
      ExportDataRequest.safeParse({
        format: 'markdown',
        includeCredentials: true,
        passphrase: 'strong-passphrase-123',
      }).success,
    ).toBe(false)
    expect(
      ExportDataRequest.safeParse({
        format: 'json',
        includeCredentials: true,
        passphrase: 'strong-passphrase-123',
      }).success,
    ).toBe(true)
  })

  it('validates KiokuExportBundle and LoreBackupUpload strictly', () => {
    const okKioku = KiokuExportBundle.safeParse({
      format: KIOKU_EXPORT_FORMAT,
      schemaVersion: 2,
      exportedAt: '2026-11-24T12:00:00.000Z',
      count: 1,
      entries: [
        {
          shortId: 'm-234567',
          title: 'Git 规范',
          content: '内容',
        },
      ],
    })
    expect(okKioku.success).toBe(true)

    const badLore = LoreBackupUpload.safeParse({
      format: LORE_BACKUP_FORMAT,
      created_at: '2026-11-24T12:00:00Z',
      tables: {
        nodes: [],
        memories: [],
        edges: [],
        paths: [],
        glossary_keywords: [],
        app_settings: [],
      },
    })
    expect(badLore.success).toBe(false)
  })

  it('detects common plaintext secret prefixes', () => {
    const matches = detectSecretPrefixes(
      'token sk-test12345678901234567890 and AKIAIOSFODNN7EXAMPLE',
    )
    expect(matches.map((m) => m.label)).toEqual(['AWS 访问凭证', 'OpenAI / 服务密钥'])
    expect(detectSecretPrefixes('{{cred:github-token}}')).toEqual([])
  })

  it('finds exact secret spans including DB URIs and Bearer JWTs while skipping placeholders', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----'
    const dbUri = 'postgres://svc_app:R3alPr0dPwd99@db.prod.internal:5432/orders'
    const redisUri = 'redis://:R3disSecr3t88@cache.prod.internal:6379/0'
    const jwtHeader = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    const jwt = [
      jwtHeader,
      'eyJzdWIiOiJ1c2VyLTQyIiwicm9sZSI6ImFkbWluIn0',
      'K9xM2pQ7wV4nB8zL1tR6yF3cH5dJ0sA',
    ].join('.')
    const sampleDocJwt = [
      jwtHeader,
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.')
    const text = [
      pem,
      'anthropic: sk-ant-api03-1234567890abcdefghij',
      `db=${dbUri}.`,
      `cache=${redisUri}`,
      `Authorization: Bearer ${jwt}`,
      'kioku: kioku_abcd1234efgh5678',
    ].join('\n')

    const hits = findSecretMatches(text)
    expect(hits.map((h) => ({ label: h.label, kind: h.kind, field: h.suggestedField }))).toEqual([
      { label: '私钥块', kind: 'ssh', field: 'private_key' },
      { label: 'Anthropic 密钥', kind: 'api', field: 'token' },
      { label: '数据库连接串', kind: 'database', field: 'url' },
      { label: '数据库连接串', kind: 'database', field: 'url' },
      { label: 'Bearer JWT 令牌', kind: 'api', field: 'token' },
      { label: 'Kioku 访问密钥', kind: 'api', field: 'token' },
    ])
    for (const hit of hits) {
      expect(text.slice(hit.start, hit.end)).toBe(hit.match)
    }
    expect(hits[0]?.match).toBe(pem)
    expect(hits[2]?.match).toBe(dbUri)
    expect(hits[3]?.match).toBe(redisUri)
    expect(hits[4]?.match).toBe(jwt)

    // 占位示例、本地连接与文档示例 JWT 均不误报
    const safeExamples = [
      'postgres://kioku:kioku@localhost:55432/kioku',
      'postgres://user:pass@db.prod.internal:5432/app',
      'postgres://admin:changeme@10.20.30.40:5432/app',
      'postgres://admin:RealPwd99@db.example.com:5432/app',
      'mysql://app:RealPwd99@127.0.0.1:3306/dev',
      'redis://:{{cred:prod-redis#password}}@cache.prod.internal:6379/0',
      'postgres://app:${DB_PASS}@db.prod.internal:5432/app',
      `Authorization: Bearer ${sampleDocJwt}`,
      'bare token without scheme: ' + jwt,
    ].join('\n')
    expect(findSecretMatches(safeExamples)).toEqual([])
    expect(detectSecretPrefixes(safeExamples)).toEqual([])
  })

  it('validates both legacy and composite ExportedCredentialRecord', () => {
    expect(
      ExportedCredentialRecord.safeParse({
        slug: 'legacy-token',
        label: 'Legacy',
        value: 'sec_123',
      }).success,
    ).toBe(true)

    expect(
      ExportedCredentialRecord.safeParse({
        slug: 'prod-db',
        label: 'Prod DB',
        kind: 'database',
        primaryField: 'url',
        fieldMeta: [
          { name: 'host', label: '主机', secret: false },
          { name: 'url', label: '连接串', secret: true },
        ],
        passkeyManualOnly: false,
        value: 'postgres://app:pwd@db.internal:5432/prod',
        fields: {
          host: 'db.internal',
          url: 'postgres://app:pwd@db.internal:5432/prod',
        },
      }).success,
    ).toBe(true)
  })
})
