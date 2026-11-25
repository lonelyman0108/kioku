import { describe, expect, it } from 'vitest'

import {
  detectSecretPrefixes,
  ExportDataRequest,
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
})
