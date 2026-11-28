import { describe, expect, it } from 'vitest'

import createMemoryModal from '../components/CreateMemoryModal.vue?raw'
import credentialIndexRail from '../components/CredentialIndexRail.vue?raw'
import credentialReadRail from '../components/CredentialReadRail.vue?raw'
import credentialWorkbench from '../components/CredentialWorkbench.vue?raw'
import dreamSuggestionCard from '../components/DreamSuggestionCard.vue?raw'
import inlineCaptureModal from '../components/InlineCredentialCaptureModal.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import quickCaptureModal from '../components/QuickCaptureModal.vue?raw'
import {
  applyRevealedValuesToEditRows,
  buildCredentialUpdateFields,
  buildKiokuRunCommand,
  canKeyAccessCredential,
  collectKnownRealms,
  CREDENTIAL_REALM_ALL,
  CREDENTIAL_REALM_EMPTY,
  CREDENTIAL_REALM_UNSCOPED,
  dedupeSlug,
  deriveCredentialSlug,
  formatCredentialPlaceholder,
  maskSecretSnippet,
  replaceMatchAtRange,
  suggestCapturePreset,
  validateCredentialEditRows,
  type EditableCredentialFieldRow,
} from '../credentials'
import { credentialFieldLabel } from '../labels'
import credentialsPage from '../pages/CredentialsPage.vue?raw'
import inboxPage from '../pages/InboxPage.vue?raw'
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
    expect(credentialsPage).toContain('CREDENTIAL_REALM_ALL')
    expect(credentialsPage).toContain('CREDENTIAL_REALM_UNSCOPED')
    expect(credentialsPage).toContain(
      "await queryClient.invalidateQueries({ queryKey: ['credentials'] })",
    )
    expect(credentialIndexRail).toContain('CREDENTIAL_KIND_ORDER')
    expect(credentialIndexRail).toContain('CREDENTIAL_REALM_ALL')
    expect(credentialIndexRail).toContain('CREDENTIAL_REALM_UNSCOPED')
    expect(credentialWorkbench).toContain('<CredentialReadRail')
    expect(credentialWorkbench).toContain('<SaveBar')
    expect(credentialWorkbench).toContain('所有字段值均加密存储')
    expect(credentialWorkbench).not.toContain('仅机密字段加密')
    expect(credentialWorkbench).not.toContain('<form')
    expect(inlineCaptureModal).not.toContain('<form')
    expect(inlineCaptureModal).toContain('silentSuccessToast')
  })

  it('分层读取非机密属性并按需显露或盲拷机密字段，具备竞态与清空防线且明文绝不进查询缓存', () => {
    expect(credentialWorkbench).toContain("scope: 'plain'")
    expect(credentialWorkbench).toContain("scope: 'all'")
    expect(credentialWorkbench).toContain('copyFieldValue')
    expect(credentialWorkbench).toContain('clearLocalSecrets')
    expect(credentialWorkbench).toContain('existingUnloaded')
    expect(credentialWorkbench).toContain('secretRevealSeq')
    expect(credentialWorkbench).toContain('copySeq')
    expect(credentialWorkbench).toContain('revealingFields')
    expect(credentialWorkbench).toContain('formLoadingSecrets.value = false')
    expect(credentialWorkbench).toContain('row.originalPlainValue = null')
    expect(credentialWorkbench).toContain('formFields.value = []')
    expect(credentialWorkbench).toContain('onBeforeUnmount')
    expect(credentialWorkbench).not.toContain('setQueryData')
    expect(inlineCaptureModal).toContain('clearSensitiveDraft')
    expect(inlineCaptureModal).toContain('onBeforeUnmount')
    expect(inlineCaptureModal).not.toContain('setQueryData')
    expect(credentialsPage).toContain('api.credentialReferences')
    expect(credentialReadRail).toContain('canKeyAccessCredential')
    expect(credentialReadRail).toContain('buildKiokuRunCommand')
  })

  it('行内捕获父组件在关闭与卸载时清空上下文并避免重复提示，整理安全快批排除明文告警', () => {
    for (const source of [
      memoryEditor,
      quickCaptureModal,
      createMemoryModal,
      dreamSuggestionCard,
    ]) {
      expect(source).toContain('silent-success-toast')
    }
    expect(memoryEditor).toContain('clearInlineCaptureContext')
    expect(memoryEditor).toContain('fetchQuery')
    expect(quickCaptureModal).toContain('watch(captureModalOpen')
    expect(createMemoryModal).toContain('watch(captureModalOpen')
    expect(dreamSuggestionCard).toContain('watch(captureModalOpen')

    const batchSafeStart = inboxPage.indexOf('function isSafeForBatch')
    const batchSafeEnd = inboxPage.indexOf('function riskLevelOf')
    expect(batchSafeStart).toBeGreaterThan(-1)
    expect(batchSafeEnd).toBeGreaterThan(batchSafeStart)
    expect(inboxPage.slice(batchSafeStart, batchSafeEnd)).toContain('s.secretWarnings?.length')
  })
})

describe('凭据编辑载荷与未加载字段保护', () => {
  const dbCred = {
    kind: 'database' as const,
    primaryField: 'url',
    fieldMeta: [
      { name: 'url', label: '连接串', secret: true },
      { name: 'host', label: '主机', secret: false },
      { name: 'username', label: '用户名', secret: false },
      { name: 'password', label: '密码', secret: true },
    ],
  }

  function makeInitialEditRows(): EditableCredentialFieldRow[] {
    return dbCred.fieldMeta.map((m) => ({
      name: m.name,
      label: m.label,
      secret: m.secret,
      multiline: false,
      preset: true,
      existingKey: m.name,
      existingUnloaded: true,
      originalPlainValue: null,
      value: '',
    }))
  }

  it('非敏感字段加载中阻断保存，加载失败保存绝不误删未加载的非敏感或机密字段', () => {
    const rows = makeInitialEditRows()
    expect(validateCredentialEditRows(rows, { plainLoading: true })).toContain('正在读取')
    expect(validateCredentialEditRows(rows, { plainLoading: false })).toBeNull()

    // 模拟 scope: plain 失败（plainLoading 已结束，所有行仍为 existingUnloaded: true）
    const plan = buildCredentialUpdateFields(dbCred, rows, 'url', credentialFieldLabel)
    expect(plan.removeFields).toEqual([])
    expect(plan.fieldsToSet).toEqual({})
    expect(plan.fieldMeta.map((f) => f.name)).toEqual(['url', 'host', 'username', 'password'])
    expect(plan.touchedFieldCount).toBe(0)
  })

  it('受控回填不因 secret 开关变化跳过，且保护用户已经手工输入的新值', () => {
    const rows = makeInitialEditRows()
    // 用户在 plain 回填完成前把 host 切成了机密，并提前手写了 username 新值
    rows[1]!.secret = true
    rows[2]!.value = 'manual-user'

    const filled = applyRevealedValuesToEditRows(rows, {
      host: 'db.internal',
      username: 'old-user',
    })
    expect(filled).toBe(2)
    expect(rows[1]!.value).toBe('db.internal')
    expect(rows[1]!.originalPlainValue).toBe('db.internal')
    expect(rows[1]!.existingUnloaded).toBe(false)
    expect(rows[2]!.value).toBe('manual-user')
    expect(rows[2]!.originalPlainValue).toBe('old-user')
    expect(rows[2]!.existingUnloaded).toBe(false)
    expect(rows[0]!.existingUnloaded).toBe(true)
    expect(rows[3]!.existingUnloaded).toBe(true)

    const plan = buildCredentialUpdateFields(dbCred, rows, 'url', credentialFieldLabel)
    expect(plan.fieldsToSet).toEqual({ username: 'manual-user' })
    expect(plan.removeFields).toEqual([])
    expect(plan.touchedFieldCount).toBe(2)
  })

  it('已加载非敏感字段显式清空进入 removeFields，移除后重建同名字段则覆盖更新而不误删', () => {
    const rows = makeInitialEditRows()
    applyRevealedValuesToEditRows(rows, { host: 'db.internal', username: 'svc' })

    // 清空已加载的 username -> 应移除
    rows[2]!.value = ''
    // 移除已有 host 后，再新增一个同名 host 字段 -> 应走 fieldsToSet 而非 removeFields
    const nextRows: EditableCredentialFieldRow[] = [
      rows[0]!,
      rows[2]!,
      rows[3]!,
      {
        name: ' HOST ',
        label: '新主机',
        secret: false,
        multiline: false,
        preset: false,
        existingKey: null,
        existingUnloaded: false,
        originalPlainValue: null,
        value: 'db2.internal',
      },
    ]

    expect(validateCredentialEditRows(nextRows, { plainLoading: false })).toBeNull()
    const plan = buildCredentialUpdateFields(dbCred, nextRows, ' URL ', credentialFieldLabel)
    expect(plan.fieldsToSet).toEqual({ host: 'db2.internal' })
    expect(plan.removeFields).toEqual(['username'])
    expect(plan.primaryField).toBe('url')
    expect(plan.fieldMeta.map((f) => f.name)).toEqual(['url', 'password', 'host'])
  })
})

describe('凭据辅助函数', () => {
  it('筛选哨兵避开合法场域标识且 canKeyAccessCredential 遵循失败即拒绝规则', () => {
    expect(CREDENTIAL_REALM_ALL).toBe('__all__')
    expect(CREDENTIAL_REALM_UNSCOPED).toBe('__unscoped__')
    expect(CREDENTIAL_REALM_EMPTY).toBe('__empty__')

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

  it('自动推导标识、去重、脱敏片段、占位符与 POSIX 安全命令行注入示例', () => {
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

    // 数字开头的标识推导为非默认字段环境变量时自动加 CRED_ 前缀以符合 POSIX 标识符规范
    const numericSlugMeta = { slug: '1password-cli', kind: 'api' as const, primaryField: 'token' }
    expect(buildKiokuRunCommand(numericSlugMeta, 'api_secret')).toBe(
      'kioku run -e CRED_1PASSWORD_CLI_API_SECRET=1password-cli#api_secret -- env',
    )
  })

  it('根据明文匹配结果推断模板，重复明文精准替换原区间并在偏移失效时安全回退', () => {
    const token = `${'ghp_'}${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'}`
    const source = `主令牌 ${token} 与备令牌 ${token}`
    const matches = findSecretMatches(source)
    expect(matches).toHaveLength(2)

    const preset = suggestCapturePreset(matches[0]!, matches[0]!.match, ['github-token'])
    expect(preset.kind).toBe('api')
    expect(preset.slug).toBe('github-token-2')
    expect(preset.field).toBe('token')

    // 精准替换第二处重复明文，保留第一处不动
    const secondReplaced = replaceMatchAtRange(source, matches[1]!, '{{cred:backup-token}}')
    expect(secondReplaced).toBe(`主令牌 ${token} 与备令牌 {{cred:backup-token}}`)

    // 原文前方被插入文字导致偏移失效时，安全回退至首个精确文本匹配
    const shifted = `补充说明：${source}`
    const fallbackReplaced = replaceMatchAtRange(shifted, matches[0]!, '{{cred:github-token-2}}')
    expect(fallbackReplaced).toBe(`补充说明：主令牌 {{cred:github-token-2}} 与备令牌 ${token}`)

    expect(collectKnownRealms([{ allowedRealms: ['ops'] }], [{ allowedRealms: ['lab'] }])).toEqual([
      'lab',
      'ops',
      'personal',
      'work',
    ])
  })
})
