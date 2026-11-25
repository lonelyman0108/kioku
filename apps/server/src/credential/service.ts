import { randomUUID } from 'node:crypto'

import {
  extractCredentialPlaceholders,
  type CreateCredentialRequest,
  type CredentialMeta,
  type CredentialRefStatus,
  type ResolveCredentialsRequest,
  type ResolveCredentialsResponse,
  type RevealCredentialResponse,
  type UpdateCredentialRequest,
} from '@kioku/contracts'
import { asc, eq, inArray, sql } from 'drizzle-orm'

import { canAccessCredential, credentialRealmConditionSql, type AccessScope } from '../access/scope'
import { decryptSecret, encryptSecret } from '../crypto/envelope'
import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'
import { credentialAad } from '../crypto/rotation'
import { isUniqueViolation, type Db, type Tx } from '../db/client'
import { credentials } from '../db/schema'
import { MemoryError } from '../memory/errors'

interface CredentialPayload {
  value: string
  fields?: Record<string, string>
}

type CredentialRow = typeof credentials.$inferSelect

function toMeta(row: CredentialRow): CredentialMeta {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    description: row.description,
    allowedRealms: row.allowedRealms,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function sealPayload(
  masterKey: MasterKey | null,
  id: string,
  payload: CredentialPayload,
): { ciphertext: Buffer; wrappedKey: Buffer; keyId: string } {
  if (!masterKey) {
    throw new MemoryError(400, '尚未配置 KIOKU_MASTER_KEY，无法保存加密凭据')
  }
  const { key, id: keyId } = encryptionKey(masterKey)
  const sealed = encryptSecret(key, JSON.stringify(payload), credentialAad(id))
  return { ciphertext: sealed.ciphertext, wrappedKey: sealed.wrappedKey, keyId }
}

function openPayload(masterKey: MasterKey | null, row: CredentialRow): CredentialPayload {
  if (!masterKey) {
    throw new MemoryError(503, '尚未配置 KIOKU_MASTER_KEY，无法读取凭据值')
  }
  let key: Buffer
  try {
    key = decryptionKey(masterKey, row.keyId)
  } catch {
    throw new MemoryError(500, '主密钥与该凭据不匹配')
  }
  const raw = decryptSecret(
    key,
    { ciphertext: row.ciphertext, wrappedKey: row.wrappedKey },
    credentialAad(row.id),
  )
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed === 'string') return { value: parsed }
  if (
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as { value?: unknown }).value === 'string'
  ) {
    const rec = parsed as { value: string; fields?: Record<string, string> }
    return rec.fields ? { value: rec.value, fields: rec.fields } : { value: rec.value }
  }
  throw new MemoryError(500, '凭据密文格式无法识别')
}

export class CredentialService {
  constructor(
    private readonly db: Db,
    private readonly masterKey: MasterKey | null,
  ) {}

  async list(): Promise<CredentialMeta[]> {
    const rows = await this.db.select().from(credentials).orderBy(asc(credentials.slug))
    return rows.map(toMeta)
  }

  async create(input: CreateCredentialRequest): Promise<CredentialMeta> {
    const id = randomUUID()
    const payload: CredentialPayload =
      input.fields && Object.keys(input.fields).length
        ? { value: input.value, fields: input.fields }
        : { value: input.value }
    const sealed = sealPayload(this.masterKey, id, payload)
    try {
      const [row] = await this.db
        .insert(credentials)
        .values({
          id,
          slug: input.slug,
          label: input.label,
          description: input.description ?? null,
          allowedRealms: input.allowedRealms ?? null,
          ciphertext: sealed.ciphertext,
          wrappedKey: sealed.wrappedKey,
          keyId: sealed.keyId,
        })
        .returning()
      return toMeta(row!)
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new MemoryError(409, `凭据标识 ${input.slug} 已存在`)
      }
      throw err
    }
  }

  async update(id: string, input: UpdateCredentialRequest): Promise<CredentialMeta> {
    const [existing] = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.id, id))
      .limit(1)
    if (!existing) throw new MemoryError(404, '凭据不存在')

    let nextSealed: { ciphertext: Buffer; wrappedKey: Buffer; keyId: string } | null = null
    if (input.value !== undefined || input.fields !== undefined) {
      const current = openPayload(this.masterKey, existing)
      const nextValue = input.value ?? current.value
      const nextFields =
        input.fields === undefined
          ? current.fields
          : input.fields === null || Object.keys(input.fields).length === 0
            ? undefined
            : input.fields
      const payload: CredentialPayload = nextFields
        ? { value: nextValue, fields: nextFields }
        : { value: nextValue }
      nextSealed = sealPayload(this.masterKey, existing.id, payload)
    }

    const [updated] = await this.db
      .update(credentials)
      .set({
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.allowedRealms !== undefined ? { allowedRealms: input.allowedRealms } : {}),
        ...(nextSealed
          ? {
              ciphertext: nextSealed.ciphertext,
              wrappedKey: nextSealed.wrappedKey,
              keyId: nextSealed.keyId,
            }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(credentials.id, id))
      .returning()

    return toMeta(updated!)
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.db
      .delete(credentials)
      .where(eq(credentials.id, id))
      .returning({ id: credentials.id })
    if (!deleted.length) throw new MemoryError(404, '凭据不存在')
  }

  async reveal(id: string): Promise<RevealCredentialResponse> {
    const [row] = await this.db.select().from(credentials).where(eq(credentials.id, id)).limit(1)
    if (!row) throw new MemoryError(404, '凭据不存在')
    const payload = openPayload(this.masterKey, row)
    return payload.fields
      ? { value: payload.value, fields: payload.fields }
      : { value: payload.value }
  }

  // 供 MCP kioku_list_credentials 使用：仅返回元数据，绝不解密值，严格按 allowed_realms 失败即拒绝
  async listForScope(scope: AccessScope): Promise<CredentialMeta[]> {
    if (scope.kind === 'key' && !scope.canResolveCredentials) return []
    const rows = await this.db
      .select()
      .from(credentials)
      .where(credentialRealmConditionSql(scope))
      .orderBy(asc(credentials.slug))
    return rows.map(toMeta)
  }

  // 供 kioku run 一次性原子取值；兼容 slug 与 slug#field 两种请求形式
  async resolveForKey(
    scope: AccessScope,
    request: ResolveCredentialsRequest,
  ): Promise<ResolveCredentialsResponse> {
    if (scope.kind === 'key' && !scope.canResolveCredentials) {
      throw new MemoryError(403, '该访问密钥未开启凭据注入权限')
    }
    const candidateSlugs = new Set<string>()
    for (const ref of request.refs) {
      candidateSlugs.add(ref.identifier)
      if (ref.field) candidateSlugs.add(`${ref.identifier}-${ref.field}`)
    }
    const rows = await this.db
      .select()
      .from(credentials)
      .where(inArray(credentials.slug, [...candidateSlugs]))
    const bySlug = new Map(rows.map((r) => [r.slug, r]))

    const values: ResolveCredentialsResponse['values'] = []
    for (const ref of request.refs) {
      const compositeSlug = ref.field ? `${ref.identifier}-${ref.field}` : null
      const compositeRow = compositeSlug ? bySlug.get(compositeSlug) : undefined
      const row =
        compositeRow && canAccessCredential(scope, compositeRow)
          ? compositeRow
          : bySlug.get(ref.identifier)

      if (!row || !canAccessCredential(scope, row)) {
        throw new MemoryError(404, `凭据不存在或当前密钥无权访问：${ref.identifier}`)
      }

      const payload = openPayload(this.masterKey, row)
      let resolvedValue: string
      if (ref.field && row.slug === ref.identifier) {
        if (payload.fields && Object.hasOwn(payload.fields, ref.field)) {
          resolvedValue = payload.fields[ref.field]!
        } else {
          resolvedValue = payload.value
        }
      } else {
        resolvedValue = payload.value
      }

      values.push({
        identifier: ref.identifier,
        field: ref.field ?? 'value',
        value: resolvedValue,
      })
    }

    return { values, expired: [] }
  }

  // 解析词条正文中的 {{cred:...}} 占位符可用状态（仅检查可见性与元数据，不解密值）
  async placeholderStatuses(
    db: Db | Tx,
    scope: AccessScope,
    content: string,
  ): Promise<CredentialRefStatus[]> {
    const parsed = extractCredentialPlaceholders(content)
    if (!parsed.length) return []
    const deduped: { slug: string; field: string | null }[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      const key = `${item.slug}#${item.field ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push({ slug: item.slug, field: item.field })
    }

    const candidateSlugs = new Set<string>()
    for (const item of deduped) {
      candidateSlugs.add(item.slug)
      if (item.field) candidateSlugs.add(`${item.slug}-${item.field}`)
    }

    const rows = await db
      .select({
        slug: credentials.slug,
        label: credentials.label,
        allowedRealms: credentials.allowedRealms,
      })
      .from(credentials)
      .where(inArray(credentials.slug, [...candidateSlugs]))
    const bySlug = new Map(rows.map((r) => [r.slug, r]))

    return deduped.map((item) => {
      const composite = item.field ? bySlug.get(`${item.slug}-${item.field}`) : undefined
      const row =
        composite && canAccessCredential(scope, composite) ? composite : bySlug.get(item.slug)
      const available = Boolean(row && canAccessCredential(scope, row))
      return {
        slug: item.slug,
        field: item.field,
        available,
        label: available ? (row?.label ?? null) : null,
      }
    })
  }
}
