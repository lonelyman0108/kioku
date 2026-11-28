import {
  CREDENTIAL_FIELDS_MAX,
  CREDENTIAL_TEMPLATES,
  CredentialFieldName,
  normalizeSlugList,
  type ApiKeyView,
  type CredentialFieldMeta,
  type CredentialKind,
  type CredentialMeta,
  type SecretMatch,
} from '@kioku/contracts'

import { placeholderOf } from './placeholders'

// 左侧场域筛选哨兵值，避开合法场域标识字符集，防止与真实场域重名
export const CREDENTIAL_REALM_ALL = '__all__'
export const CREDENTIAL_REALM_UNSCOPED = '__unscoped__'
export const CREDENTIAL_REALM_EMPTY = '__empty__'

export interface EditableCredentialFieldRow {
  name: string
  label: string
  secret: boolean
  multiline: boolean
  preset: boolean
  existingKey: string | null
  existingUnloaded: boolean
  originalPlainValue: string | null
  value: string
}

export interface CredentialUpdateFieldsPlan {
  fieldsToSet: Record<string, string>
  fieldMeta: CredentialFieldMeta[]
  removeFields: string[]
  primaryField: string
  effectiveFieldCount: number
  touchedFieldCount: number
}

// 将受控读取返回的字段值回填至编辑行：不依赖当前 secret 开关，且保留用户已手工输入的新值
export function applyRevealedValuesToEditRows<T extends EditableCredentialFieldRow>(
  rows: readonly T[],
  revealed: Readonly<Record<string, string>>,
): number {
  let filled = 0
  for (const row of rows) {
    if (!row.existingKey || !row.existingUnloaded) continue
    if (!Object.hasOwn(revealed, row.existingKey)) continue
    const val = revealed[row.existingKey]!
    if (!row.value) row.value = val
    row.originalPlainValue = val
    row.existingUnloaded = false
    filled++
  }
  return filled
}

// 校验编辑态字段行：非敏感字段仍在加载时阻断保存；未加载字段留空视为保留原值，已加载字段留空视为移除
export function validateCredentialEditRows(
  rows: readonly EditableCredentialFieldRow[],
  options: { plainLoading: boolean },
): string | null {
  if (options.plainLoading) return '正在读取非敏感字段，请稍候保存'
  const seenNames = new Set<string>()
  let effectiveFieldCount = 0

  for (const row of rows) {
    if (row.existingKey) {
      if (!row.existingUnloaded && !row.value.length) continue
      if (seenNames.has(row.existingKey)) return `字段键名 ${row.existingKey} 重复`
      seenNames.add(row.existingKey)
      effectiveFieldCount++
      continue
    }
    const cleanName = row.name.trim().toLowerCase()
    const hasVal = row.value.length > 0
    if (!cleanName && !hasVal) continue
    const nameCheck = CredentialFieldName.safeParse(cleanName)
    if (!nameCheck.success) return nameCheck.error.issues[0]?.message ?? '字段键名格式有误'
    if (!hasVal) return `请填写新增字段 ${cleanName} 的值`
    if (seenNames.has(cleanName)) return `字段键名 ${cleanName} 重复`
    seenNames.add(cleanName)
    effectiveFieldCount++
  }

  if (effectiveFieldCount === 0) return '请至少保留一个非空凭据字段'
  if (effectiveFieldCount > CREDENTIAL_FIELDS_MAX) return `字段最多 ${CREDENTIAL_FIELDS_MAX} 个`
  return null
}

// 构建编辑态 PATCH 所需的字段更新、元数据、删除清单与变动统计，防止未加载字段被误删，并支持移除后重建同名字段
export function buildCredentialUpdateFields(
  cred: Pick<CredentialMeta, 'kind' | 'primaryField' | 'fieldMeta'>,
  rows: readonly EditableCredentialFieldRow[],
  requestedPrimaryField: string,
  resolveFieldLabel: (kind: CredentialKind, fieldName: string, explicitLabel?: string) => string,
): CredentialUpdateFieldsPlan {
  const origMetaMap = new Map(cred.fieldMeta.map((f) => [f.name, f]))
  const fieldsToSet: Record<string, string> = {}
  const fieldMeta: CredentialFieldMeta[] = []
  let touchedFieldCount = 0

  for (const row of rows) {
    if (row.existingKey) {
      if (!row.existingUnloaded && !row.value) {
        continue
      }
      const nextLabel = row.label.trim() || resolveFieldLabel(cred.kind, row.existingKey)
      const nextMultiline = row.multiline || row.value.includes('\n')
      fieldMeta.push({
        name: row.existingKey,
        label: nextLabel,
        secret: row.secret,
        ...(nextMultiline ? { multiline: true } : {}),
      })

      const orig = origMetaMap.get(row.existingKey)
      const metaChanged = Boolean(
        orig && (orig.secret !== row.secret || Boolean(orig.multiline) !== nextMultiline),
      )
      let valueChanged = false
      if (row.existingUnloaded) {
        if (row.value.length > 0) {
          fieldsToSet[row.existingKey] = row.value
          valueChanged = true
        }
      } else if (row.originalPlainValue === null || row.value !== row.originalPlainValue) {
        if (row.value.length > 0) {
          fieldsToSet[row.existingKey] = row.value
          valueChanged = true
        }
      }
      if (metaChanged || valueChanged) touchedFieldCount++
    } else {
      const cleanName = row.name.trim().toLowerCase()
      if (!cleanName || !row.value) continue
      fieldsToSet[cleanName] = row.value
      fieldMeta.push({
        name: cleanName,
        label: row.label.trim() || resolveFieldLabel(cred.kind, cleanName),
        secret: row.secret,
        ...(row.multiline || row.value.includes('\n') ? { multiline: true } : {}),
      })
      touchedFieldCount++
    }
  }

  const keptNames = new Set(fieldMeta.map((f) => f.name))
  const removeFields: string[] = []
  for (const orig of cred.fieldMeta) {
    if (!keptNames.has(orig.name) && !removeFields.includes(orig.name)) {
      removeFields.push(orig.name)
      touchedFieldCount++
    }
  }

  const normalizedPrimary = requestedPrimaryField.trim().toLowerCase()
  const primaryField = keptNames.has(normalizedPrimary)
    ? normalizedPrimary
    : (fieldMeta[0]?.name ?? cred.primaryField)

  return {
    fieldsToSet,
    fieldMeta,
    removeFields,
    primaryField,
    effectiveFieldCount: fieldMeta.length,
    touchedFieldCount,
  }
}

// 与服务端 access/scope.ts 保持一致的失败即拒绝判定，用于实时统计有权解析凭据的访问密钥数量
export function canKeyAccessCredential(
  key: Pick<ApiKeyView, 'canResolveCredentials' | 'allowedRealms' | 'revokedAt'>,
  cred: { allowedRealms: readonly string[] | null },
): boolean {
  if (key.revokedAt) return false
  if (!key.canResolveCredentials) return false
  if (key.allowedRealms === null) return true
  const keyAllowed = normalizeSlugList(key.allowedRealms)
  if (!keyAllowed.length) return false
  const credAllowed = normalizeSlugList(cred.allowedRealms)
  if (!credAllowed.length) return false
  const allowedSet = new Set(keyAllowed)
  return credAllowed.some((r) => allowedSet.has(r))
}

const ZH_SLUG_HINTS: readonly [string, string][] = [
  ['生产', 'prod'],
  ['预发', 'staging'],
  ['测试', 'test'],
  ['开发', 'dev'],
  ['数据库', 'db'],
  ['主库', 'pg-main'],
  ['缓存', 'redis'],
  ['网关', 'gateway'],
  ['令牌', 'token'],
  ['账号', 'account'],
  ['密码', 'pass'],
  ['密钥', 'key'],
  ['接口', 'api'],
  ['服务', 'service'],
  ['个人', 'personal'],
  ['工作', 'work'],
  ['跳板机', 'bastion'],
]

export function deriveCredentialSlug(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) return ''
  const ascii = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-._]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48)
  if (ascii && /^[a-z0-9]/.test(ascii)) return ascii
  const parts: string[] = []
  for (const [zh, en] of ZH_SLUG_HINTS) {
    if (trimmed.includes(zh) && !parts.includes(en)) {
      parts.push(en)
      if (parts.length >= 3) break
    }
  }
  return parts.join('-')
}

export function dedupeSlug(base: string, existingSlugs: readonly string[]): string {
  const clean = base.trim().toLowerCase()
  if (!clean) return ''
  const existing = new Set(existingSlugs.map((s) => s.toLowerCase()))
  if (!existing.has(clean)) return clean
  for (let i = 2; i < 100; i++) {
    const candidate = `${clean.slice(0, 58)}-${i}`
    if (!existing.has(candidate)) return candidate
  }
  return clean
}

export interface CapturePreset {
  kind: CredentialKind
  slug: string
  label: string
  field: string
  multiline: boolean
  secret: boolean
}

function suggestDatabaseSlug(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    const dbName = parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
    const hostPart = parsed.hostname.split('.')[0] ?? ''
    const candidate = deriveCredentialSlug(dbName || hostPart)
    if (candidate) return `${candidate}-db`.slice(0, 48)
  } catch {
    // 非标准连接串退回默认标识
  }
  return 'database-url'
}

export function suggestCapturePreset(
  match: SecretMatch | null,
  rawValue = '',
  existingSlugs: readonly string[] = [],
): CapturePreset {
  if (!match) {
    const multiline = rawValue.includes('\n')
    return {
      kind: 'secret',
      slug: '',
      label: '',
      field: 'value',
      multiline,
      secret: true,
    }
  }

  let baseSlug: string
  let label = match.label
  let multiline = match.match.includes('\n')

  switch (match.label) {
    case '私钥块':
      baseSlug = 'ssh-private-key'
      label = 'SSH 私钥'
      multiline = true
      break
    case '数据库连接串':
      baseSlug = suggestDatabaseSlug(match.match)
      label = '数据库连接'
      break
    case 'GitHub 令牌':
      baseSlug = 'github-token'
      label = 'GitHub 令牌'
      break
    case 'AWS 访问凭证':
      baseSlug = 'aws-access'
      label = 'AWS 访问凭证'
      break
    case 'Slack 令牌':
      baseSlug = 'slack-token'
      label = 'Slack 令牌'
      break
    case 'OpenAI / 服务密钥':
      baseSlug = 'openai-service'
      label = 'OpenAI 服务凭据'
      break
    case 'Anthropic 密钥':
      baseSlug = 'anthropic-service'
      label = 'Anthropic 服务凭据'
      break
    case 'Kioku 访问密钥':
      baseSlug = 'kioku-service'
      label = 'Kioku 服务凭据'
      break
    case 'Bearer JWT 令牌':
      baseSlug = 'service-jwt'
      label = '接口认证令牌'
      break
    default:
      baseSlug = deriveCredentialSlug(match.label) || 'service-cred'
  }

  return {
    kind: match.kind,
    slug: dedupeSlug(baseSlug, existingSlugs),
    label,
    field: match.suggestedField || CREDENTIAL_TEMPLATES[match.kind].defaultPrimaryField,
    multiline,
    secret: true,
  }
}

// 脱敏展示命中明文片段，避免告警条回显完整凭据
export function maskSecretSnippet(raw: string): string {
  const clean = raw.trim()
  if (!clean) return ''
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? ''
  if (firstLine.startsWith('-----BEGIN ')) {
    return firstLine.slice(0, 36)
  }
  const dbMatch = /^([a-z0-9+.-]+:\/\/)([^/\s:@]*):([^\s/?#]+)@([^\s/?#@]+)/i.exec(firstLine)
  if (dbMatch) {
    const scheme = dbMatch[1]!
    const user = dbMatch[2] ? `${dbMatch[2]}:` : ''
    const host = dbMatch[4]!
    return `${scheme}${user}***@${host}`
  }
  if (firstLine.length <= 10) {
    return `${firstLine.slice(0, 3)}***`
  }
  return `${firstLine.slice(0, 6)}…${firstLine.slice(-4)}`
}

export function formatCredentialPlaceholder(
  cred: Pick<CredentialMeta, 'slug' | 'primaryField'>,
  fieldName?: string | null,
): string {
  if (!fieldName || fieldName === cred.primaryField) {
    return placeholderOf(cred.slug)
  }
  return placeholderOf(cred.slug, fieldName)
}

const DEFAULT_ENV_BY_KIND: Record<CredentialKind, { env: string; cmd: string }> = {
  database: { env: 'DATABASE_URL', cmd: 'psql "$DATABASE_URL"' },
  api: { env: 'API_TOKEN', cmd: 'env' },
  ssh: { env: 'SSH_PRIVATE_KEY', cmd: 'env' },
  login: { env: 'LOGIN_PASSWORD', cmd: 'env' },
  secret: { env: 'CRED_VALUE', cmd: 'env' },
}

export function buildKiokuRunCommand(
  cred: Pick<CredentialMeta, 'slug' | 'kind' | 'primaryField'>,
  fieldName?: string | null,
): string {
  const isDefault = !fieldName || fieldName === cred.primaryField
  const preset = DEFAULT_ENV_BY_KIND[cred.kind]
  const ref = isDefault ? cred.slug : `${cred.slug}#${fieldName}`
  const rawEnv = isDefault
    ? preset.env
    : `${cred.slug}_${fieldName}`
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
  const envVar = !rawEnv ? 'CRED_VALUE' : /^[0-9]/.test(rawEnv) ? `CRED_${rawEnv}` : rawEnv
  const cmd = isDefault ? preset.cmd : 'env'
  return `kioku run -e ${envVar}=${ref} -- ${cmd}`
}

export function replaceMatchAtRange(
  source: string,
  match: Pick<SecretMatch, 'start' | 'end' | 'match'>,
  replacement: string,
): string {
  if (
    match.start >= 0 &&
    match.end <= source.length &&
    source.slice(match.start, match.end) === match.match
  ) {
    return `${source.slice(0, match.start)}${replacement}${source.slice(match.end)}`
  }
  const idx = source.indexOf(match.match)
  if (idx !== -1) {
    return `${source.slice(0, idx)}${replacement}${source.slice(idx + match.match.length)}`
  }
  return source
}

export function collectKnownRealms(
  credentials: readonly Pick<CredentialMeta, 'allowedRealms'>[],
  keys: readonly Pick<ApiKeyView, 'allowedRealms'>[] = [],
  extra: readonly string[] = [],
): string[] {
  const realms: string[] = ['work', 'personal', ...extra]
  for (const c of credentials) {
    if (c.allowedRealms?.length) realms.push(...c.allowedRealms)
  }
  for (const k of keys) {
    if (k.allowedRealms?.length) realms.push(...k.allowedRealms)
  }
  return normalizeSlugList(realms)
}
