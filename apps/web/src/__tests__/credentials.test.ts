import { describe, expect, it } from 'vitest'

import credentialIndexRail from '../components/CredentialIndexRail.vue?raw'
import credentialReadRail from '../components/CredentialReadRail.vue?raw'
import credentialWorkbench from '../components/CredentialWorkbench.vue?raw'
import inlineCaptureModal from '../components/InlineCredentialCaptureModal.vue?raw'
import {
  buildKiokuRunCommand,
  canKeyAccessCredential,
  collectKnownRealms,
  dedupeSlug,
  deriveCredentialSlug,
  formatCredentialPlaceholder,
  maskSecretSnippet,
  replaceMatchAtRange,
  suggestCapturePreset,
} from '../credentials'
import credentialsPage from '../pages/CredentialsPage.vue?raw'
import { findSecretMatches } from '../secretHint'

describe('凭据管理界面与安全边界约束', () => {
  it('采用三栏纸墨工作台、阅读态与编辑态分离且不使用 form 隐式提交', () => {
    expect(credentialsPage).not.toContain('VaultConnection')
    expect(credentialsPage).not.toContain('PlaintextSaveModal')
    expect(credentialsPage).toContain('216px var(--list-width, 336px) minmax(0, 1fr)')
    expect(credentialsPage).toContain('<CredentialIndexRail')
    expect(credentialsPage).toContain('<CredentialWorkbench')
    expect(credentialsPage).toContain('<ConsequenceModal')
    expect(credentialsPage).toContain('useUnsavedChangesGuard')
    expect(credentialIndexRail).toContain('CREDENTIAL_KIND_ORDER')
    expect(credentialWorkbench).toContain('<CredentialReadRail')
    expect(credentialWorkbench).toContain('<SaveBar')
    expect(credentialWorkbench).toContain('所有字段值均加密存储')
    expect(credentialWorkbench).not.toContain('仅机密字段加密')
    expect(credentialWorkbench).not.toContain('<form')
    expect(inlineCaptureModal).not.toContain('<form')
  })

  it('分层读取非机密属性并按需显露或盲拷机密字段，明文仅留局部状态且绝不写入查询缓存', () => {
    expect(credentialWorkbench).toContain("scope: 'plain'")
    expect(credentialWorkbench).toContain("scope: 'all'")
    expect(credentialWorkbench).toContain('copyFieldValue')
    expect(credentialWorkbench).toContain('clearLocalSecrets')
    expect(credentialWorkbench).toContain('onBeforeUnmount')
    expect(credentialWorkbench).not.toContain('setQueryData')
    expect(inlineCaptureModal).toContain('clearSensitiveDraft')
    expect(inlineCaptureModal).toContain('onBeforeUnmount')
    expect(inlineCaptureModal).not.toContain('setQueryData')
    expect(credentialsPage).toContain('api.credentialReferences')
    expect(credentialReadRail).toContain('canKeyAccessCredential')
    expect(credentialReadRail).toContain('buildKiokuRunCommand')
  })
})

describe('凭据辅助函数', () => {
  it('canKeyAccessCredential 遵循失败即拒绝规则', () => {
    const fullKey = { canResolveCredentials: true, allowedRealms: null, revokedAt: null }
    const workKey = { canResolveCredentials: true, allowedRealms: ['work'], revokedAt: null }
    const noCredKey = { canResolveCredentials: false, allowedRealms: null, revokedAt: null }
    const revokedKey = {
      canResolveCredentials: true,
      allowedRealms: null,
      revokedAt: '2026-01-01T00:00:00Z',
    }
    const emptyRealmKey = { canResolveCredentials: true, allowedRealms: [], revokedAt: null }

    expect(canKeyAccessCredential(fullKey, { allowedRealms: null })).toBe(true)
    expect(canKeyAccessCredential(fullKey, { allowedRealms: ['work'] })).toBe(true)
    expect(canKeyAccessCredential(workKey, { allowedRealms: null })).toBe(false)
    expect(canKeyAccessCredential(workKey, { allowedRealms: [] })).toBe(false)
    expect(canKeyAccessCredential(workKey, { allowedRealms: ['personal'] })).toBe(false)
    expect(canKeyAccessCredential(workKey, { allowedRealms: ['work', 'ops'] })).toBe(true)
    expect(canKeyAccessCredential(noCredKey, { allowedRealms: ['work'] })).toBe(false)
    expect(canKeyAccessCredential(revokedKey, { allowedRealms: ['work'] })).toBe(false)
    expect(canKeyAccessCredential(emptyRealmKey, { allowedRealms: ['work'] })).toBe(false)
  })

  it('自动推导标识、去重、脱敏片段、占位符与命令行注入示例', () => {
    expect(deriveCredentialSlug('GitHub Personal Token')).toBe('github-personal-token')
    expect(deriveCredentialSlug('生产数据库主库')).toBe('prod-db-pg-main')
    expect(dedupeSlug('github-token', ['github-token', 'github-token-2'])).toBe('github-token-3')

    const pg = `postgres://admin:${'s3cr3tP@ss'}@db.example.com:5432/kioku`
    expect(maskSecretSnippet(pg)).toBe('postgres://admin:***@db.example.com:5432')
    expect(maskSecretSnippet(`${'ghp_'}${'a1b2c3d4e5f6g7h8i9j0k1l2'}`)).toBe('ghp_a1…k1l2')

    const meta = { slug: 'prod-db', kind: 'database' as const, primaryField: 'url' }
    expect(formatCredentialPlaceholder(meta)).toBe('{{cred:prod-db}}')
    expect(formatCredentialPlaceholder(meta, 'url')).toBe('{{cred:prod-db}}')
    expect(formatCredentialPlaceholder(meta, 'password')).toBe('{{cred:prod-db#password}}')

    expect(buildKiokuRunCommand(meta)).toBe(
      'kioku run -e DATABASE_URL=prod-db -- psql "$DATABASE_URL"',
    )
    expect(buildKiokuRunCommand(meta, 'password')).toBe(
      'kioku run -e PROD_DB_PASSWORD=prod-db#password -- env',
    )
  })

  it('根据明文匹配结果推断模板并在原区间精准替换占位符', () => {
    const token = `${'ghp_'}${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'}`
    const source = `部署前先导出令牌 ${token} 再执行同步`
    const [match] = findSecretMatches(source)
    expect(match).toBeDefined()

    const preset = suggestCapturePreset(match!, match!.match, ['github-token'])
    expect(preset.kind).toBe('api')
    expect(preset.slug).toBe('github-token-2')
    expect(preset.field).toBe('token')

    const replaced = replaceMatchAtRange(source, match!, '{{cred:github-token-2}}')
    expect(replaced).toBe('部署前先导出令牌 {{cred:github-token-2}} 再执行同步')
    expect(collectKnownRealms([{ allowedRealms: ['ops'] }], [{ allowedRealms: ['lab'] }])).toEqual([
      'lab',
      'ops',
      'personal',
      'work',
    ])
  })
})
