import { randomUUID } from 'node:crypto'

import {
  CREDENTIAL_FIELDS_MAX,
  CREDENTIAL_TEMPLATES,
  defaultPrimaryFieldForKind,
  extractCredentialPlaceholders,
  type CreateCredentialRequest,
  type CredentialFieldMeta,
  type CredentialKind,
  type CredentialMeta,
  type CredentialReferenceItem,
  type CredentialRefStatus,
  type ResolveCredentialsRequest,
  type ResolveCredentialsResponse,
  type RevealCredentialRequest,
  type RevealCredentialResponse,
  type UpdateCredentialRequest,
} from '@kioku/contracts'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { canAccessCredential, credentialRealmConditionSql, type AccessScope } from '../access/scope'
import { decryptSecret, encryptSecret } from '../crypto/envelope'
import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'
import { credentialAad } from '../crypto/rotation'
import { isUniqueViolation, withTx, type Db, type Tx } from '../db/client'
import { credentials, entries } from '../db/schema'
import { MemoryError } from '../memory/errors'

export interface NormalizedCredentialPayload {
  value: string
  fields: Record<string, string>
}

export interface PreparedCredentialWrite {
  kind: CredentialKind
  primaryField: string
  fieldMeta: CredentialFieldMeta[]
  passkeyManualOnly: boolean
  payload: NormalizedCredentialPayload
}

type CredentialRow = typeof credentials.$inferSelect

function toMeta(row: CredentialRow): CredentialMeta {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    description: row.description,
    kind: row.kind,
    primaryField: row.primaryField,
    fieldMeta: row.fieldMeta,
    passkeyManualOnly: row.passkeyManualOnly,
    provider: row.provider,
    externalRef: row.externalRef,
    allowedRealms: row.allowedRealms,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, '\\$&')
}

function buildNormalizedFieldMeta(
  kind: CredentialKind,
  fieldKeys: readonly string[],
  preferredMeta?: readonly CredentialFieldMeta[],
  existingMeta?: readonly CredentialFieldMeta[],
): CredentialFieldMeta[] {
  const keySet = new Set(fieldKeys)
  const templateList = CREDENTIAL_TEMPLATES[kind].fields
  const templateMap = new Map(templateList.map((f) => [f.name, f]))
  const preferredMap = new Map((preferredMeta ?? []).map((f) => [f.name, f]))
  const existingMap = new Map((existingMeta ?? []).map((f) => [f.name, f]))

  const orderedNames: string[] = []
  const seen = new Set<string>()
  const pushIfPresent = (name: string) => {
    if (!keySet.has(name) || seen.has(name)) return
    seen.add(name)
    orderedNames.push(name)
  }

  for (const item of preferredMeta ?? []) pushIfPresent(item.name)
  for (const item of existingMeta ?? []) pushIfPresent(item.name)
  for (const item of templateList) pushIfPresent(item.name)
  for (const name of fieldKeys) pushIfPresent(name)

  return orderedNames.map((name) => {
    const preferred = preferredMap.get(name)
    if (preferred) {
      return {
        name,
        ...(preferred.label !== undefined ? { label: preferred.label } : {}),
        secret: preferred.secret,
        ...(preferred.multiline ? { multiline: true } : {}),
      }
    }
    const existing = existingMap.get(name)
    const tpl = templateMap.get(name)
    const secret = existing?.secret ?? tpl?.secret ?? true
    const label = existing?.label ?? tpl?.label
    const multiline = existing?.multiline ?? tpl?.multiline
    return {
      name,
      ...(label !== undefined ? { label } : {}),
      secret,
      ...(multiline ? { multiline: true } : {}),
    }
  })
}

// 统一归一化新版复合具名字段与旧版 { value, fields? } 写入载荷，保证 field_meta 与密文字段集合一致
export function prepareCredentialWrite(input: {
  kind?: CredentialKind | undefined
  primaryField?: string | undefined
  fieldMeta?: readonly CredentialFieldMeta[] | undefined
  value?: string | undefined
  fields?: Record<string, string> | undefined
  passkeyManualOnly?: boolean | undefined
}): PreparedCredentialWrite {
  const kind: CredentialKind = input.kind ?? 'secret'
  const templateDefault = defaultPrimaryFieldForKind(kind)
  const valueKey = input.primaryField ?? templateDefault

  const allFields: Record<string, string> = {}
  if (input.value !== undefined) {
    allFields[valueKey] = input.value
  }
  if (input.fields) {
    for (const [k, v] of Object.entries(input.fields)) {
      allFields[k] = v
    }
  }

  const fieldKeys = Object.keys(allFields)
  if (!fieldKeys.length) {
    throw new MemoryError(400, '请至少填写一个凭据字段值')
  }
  if (fieldKeys.length > CREDENTIAL_FIELDS_MAX) {
    throw new MemoryError(400, `字段最多 ${CREDENTIAL_FIELDS_MAX} 个`)
  }

  const fieldMeta = buildNormalizedFieldMeta(kind, fieldKeys, input.fieldMeta)
  let primaryField: string
  if (input.primaryField !== undefined) {
    if (Object.hasOwn(allFields, input.primaryField)) {
      primaryField = input.primaryField
    } else if (input.primaryField === templateDefault) {
      primaryField = fieldMeta[0]!.name
    } else {
      throw new MemoryError(400, `默认字段 ${input.primaryField} 不在已填写字段中`)
    }
  } else if (Object.hasOwn(allFields, templateDefault)) {
    primaryField = templateDefault
  } else {
    primaryField = fieldMeta[0]!.name
  }

  const primaryValue = allFields[primaryField] ?? allFields[fieldMeta[0]!.name]!
  return {
    kind,
    primaryField,
    fieldMeta,
    passkeyManualOnly: input.passkeyManualOnly ?? false,
    payload: {
      value: primaryValue,
      fields: allFields,
    },
  }
}

function sealPayload(
  masterKey: MasterKey | null,
  id: string,
  payload: NormalizedCredentialPayload,
): { ciphertext: Buffer; wrappedKey: Buffer; keyId: string } {
  if (!masterKey) {
    throw new MemoryError(400, '尚未配置 KIOKU_MASTER_KEY，无法保存加密凭据')
  }
  const { key, id: keyId } = encryptionKey(masterKey)
  const sealed = encryptSecret(key, JSON.stringify(payload), credentialAad(id))
  return { ciphertext: sealed.ciphertext, wrappedKey: sealed.wrappedKey, keyId }
}

// 解密并归一历史单值密文与复合具名字段密文，确保返回 { value, fields } 一致结构
export function openCredentialPayload(
  masterKey: MasterKey | null,
  row: Pick<CredentialRow, 'id' | 'primaryField' | 'ciphertext' | 'wrappedKey' | 'keyId'>,
): NormalizedCredentialPayload {
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
  const primaryKey = row.primaryField || 'value'

  if (typeof parsed === 'string') {
    return { value: parsed, fields: { [primaryKey]: parsed } }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rec = parsed as { value?: unknown; fields?: unknown }
    const normalizedFields: Record<string, string> = {}
    if (rec.fields && typeof rec.fields === 'object' && !Array.isArray(rec.fields)) {
      for (const [k, v] of Object.entries(rec.fields as Record<string, unknown>)) {
        if (typeof v === 'string') normalizedFields[k] = v
      }
    }
    if (typeof rec.value === 'string') {
      if (!Object.hasOwn(normalizedFields, primaryKey)) {
        normalizedFields[primaryKey] = rec.value
      }
      return { value: rec.value, fields: normalizedFields }
    }
    const keys = Object.keys(normalizedFields)
    if (keys.length) {
      const fallback = Object.hasOwn(normalizedFields, primaryKey)
        ? normalizedFields[primaryKey]!
        : normalizedFields[keys[0]!]!
      return { value: fallback, fields: normalizedFields }
    }
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
    const prepared = prepareCredentialWrite(input)
    const sealed = sealPayload(this.masterKey, id, prepared.payload)
    try {
      const [row] = await this.db
        .insert(credentials)
        .values({
          id,
          slug: input.slug,
          label: input.label,
          description: input.description ?? null,
          kind: prepared.kind,
          primaryField: prepared.primaryField,
          fieldMeta: prepared.fieldMeta,
          passkeyManualOnly: prepared.passkeyManualOnly,
          provider: 'builtin',
          externalRef: null,
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
    return withTx(this.db, async (tx, now) => {
      const [existing] = await tx
        .select()
        .from(credentials)
        .where(eq(credentials.id, id))
        .for('update')
      if (!existing) throw new MemoryError(404, '凭据不存在')

      const nextKind = input.kind ?? existing.kind
      const nextPasskeyManualOnly = input.passkeyManualOnly ?? existing.passkeyManualOnly
      const touchesSecretValues =
        input.value !== undefined ||
        input.fields !== undefined ||
        Boolean(input.removeFields?.length)
      const changesPrimaryField =
        input.primaryField !== undefined && input.primaryField !== existing.primaryField
      const needsDecrypt =
        touchesSecretValues ||
        changesPrimaryField ||
        (input.fieldMeta !== undefined && existing.fieldMeta.length === 0)

      let nextPrimaryField = existing.primaryField
      let nextFieldMeta = existing.fieldMeta
      let nextSealed: { ciphertext: Buffer; wrappedKey: Buffer; keyId: string } | null = null

      if (needsDecrypt) {
        const current = openCredentialPayload(this.masterKey, existing)
        let nextFields: Record<string, string>

        if (input.fields === null) {
          if (input.value !== undefined) {
            const keepKey = input.primaryField ?? existing.primaryField
            nextFields = { [keepKey]: input.value }
          } else if (input.primaryField !== undefined) {
            if (!Object.hasOwn(current.fields, input.primaryField)) {
              throw new MemoryError(400, `默认字段 ${input.primaryField} 不在已填写字段中`)
            }
            nextFields = { [input.primaryField]: current.fields[input.primaryField]! }
          } else {
            const keepKey = existing.primaryField
            const keepVal = Object.hasOwn(current.fields, keepKey)
              ? current.fields[keepKey]!
              : current.value
            nextFields = { [keepKey]: keepVal }
          }
        } else {
          nextFields = { ...current.fields }
          if (input.removeFields?.length) {
            for (const keyToRemove of input.removeFields) {
              delete nextFields[keyToRemove]
            }
          }
          if (input.value !== undefined) {
            const targetKey = input.primaryField ?? existing.primaryField
            nextFields[targetKey] = input.value
          }
          if (input.fields) {
            for (const [k, v] of Object.entries(input.fields)) {
              nextFields[k] = v
            }
          }
        }

        const fieldKeys = Object.keys(nextFields)
        if (!fieldKeys.length) {
          throw new MemoryError(400, '凭据至少保留一个非空字段')
        }
        if (fieldKeys.length > CREDENTIAL_FIELDS_MAX) {
          throw new MemoryError(400, `字段最多 ${CREDENTIAL_FIELDS_MAX} 个`)
        }

        nextFieldMeta = buildNormalizedFieldMeta(
          nextKind,
          fieldKeys,
          input.fieldMeta,
          existing.fieldMeta,
        )

        const templateDefault = defaultPrimaryFieldForKind(nextKind)
        if (input.primaryField !== undefined) {
          if (!Object.hasOwn(nextFields, input.primaryField)) {
            throw new MemoryError(400, `默认字段 ${input.primaryField} 不在已填写字段中`)
          }
          nextPrimaryField = input.primaryField
        } else if (Object.hasOwn(nextFields, existing.primaryField)) {
          nextPrimaryField = existing.primaryField
        } else if (Object.hasOwn(nextFields, templateDefault)) {
          nextPrimaryField = templateDefault
        } else {
          nextPrimaryField = nextFieldMeta[0]!.name
        }

        const payload: NormalizedCredentialPayload = {
          value: nextFields[nextPrimaryField]!,
          fields: nextFields,
        }
        nextSealed = sealPayload(this.masterKey, existing.id, payload)
      } else if (input.fieldMeta !== undefined && existing.fieldMeta.length > 0) {
        nextFieldMeta = buildNormalizedFieldMeta(
          nextKind,
          existing.fieldMeta.map((f) => f.name),
          input.fieldMeta,
          existing.fieldMeta,
        )
      }

      const [updated] = await tx
        .update(credentials)
        .set({
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.kind !== undefined ? { kind: nextKind } : {}),
          ...(nextPrimaryField !== existing.primaryField ? { primaryField: nextPrimaryField } : {}),
          ...(needsDecrypt || input.fieldMeta !== undefined ? { fieldMeta: nextFieldMeta } : {}),
          ...(input.passkeyManualOnly !== undefined
            ? { passkeyManualOnly: nextPasskeyManualOnly }
            : {}),
          ...(input.allowedRealms !== undefined ? { allowedRealms: input.allowedRealms } : {}),
          ...(nextSealed
            ? {
                ciphertext: nextSealed.ciphertext,
                wrappedKey: nextSealed.wrappedKey,
                keyId: nextSealed.keyId,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(credentials.id, id))
        .returning()

      if (!updated) throw new MemoryError(404, '凭据不存在')
      return toMeta(updated)
    })
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.db
      .delete(credentials)
      .where(eq(credentials.id, id))
      .returning({ id: credentials.id })
    if (!deleted.length) throw new MemoryError(404, '凭据不存在')
  }

  // 分层受控解密：scope='plain' 仅返回非机密属性字段，field 仅返回单字段，缺省或 scope='all' 返回全量
  async reveal(
    id: string,
    request: RevealCredentialRequest = {},
  ): Promise<RevealCredentialResponse> {
    const [row] = await this.db.select().from(credentials).where(eq(credentials.id, id)).limit(1)
    if (!row) throw new MemoryError(404, '凭据不存在')
    const payload = openCredentialPayload(this.masterKey, row)

    if (request.field !== undefined) {
      if (!Object.hasOwn(payload.fields, request.field)) {
        throw new MemoryError(404, `凭据 ${row.slug} 不存在字段 ${request.field}`)
      }
      return {
        field: request.field,
        value: payload.fields[request.field]!,
      }
    }

    if (request.scope === 'plain') {
      const plainFields: Record<string, string> = {}
      for (const meta of row.fieldMeta) {
        if (!meta.secret && Object.hasOwn(payload.fields, meta.name)) {
          plainFields[meta.name] = payload.fields[meta.name]!
        }
      }
      return { fields: plainFields }
    }

    return {
      value: payload.value,
      fields: payload.fields,
    }
  }

  // 反查在活跃正式记忆中引用了指定凭据的记录（先 SQL 粗筛，再精确解析占位符避免前缀误伤）
  async references(id: string): Promise<CredentialReferenceItem[]> {
    const [cred] = await this.db
      .select({ id: credentials.id, slug: credentials.slug })
      .from(credentials)
      .where(eq(credentials.id, id))
      .limit(1)
    if (!cred) throw new MemoryError(404, '凭据不存在')

    const pattern = `%{{cred:${escapeLikePattern(cred.slug)}%`
    const rows = await this.db
      .select({
        id: entries.id,
        shortId: entries.shortId,
        title: entries.title,
        realms: entries.realms,
        content: entries.content,
        updatedAt: entries.updatedAt,
      })
      .from(entries)
      .where(
        and(
          eq(entries.kind, 'entry'),
          isNull(entries.deletedAt),
          sql`${entries.content} ilike ${pattern} escape '\\'`,
        ),
      )
      .orderBy(desc(entries.updatedAt), asc(entries.shortId))

    const items: CredentialReferenceItem[] = []
    for (const row of rows) {
      const placeholders = extractCredentialPlaceholders(row.content)
      const fields: (string | null)[] = []
      const seen = new Set<string>()
      for (const p of placeholders) {
        if (p.slug !== cred.slug) continue
        const key = p.field === null ? '\0' : p.field
        if (seen.has(key)) continue
        seen.add(key)
        fields.push(p.field)
      }
      if (!fields.length) continue
      items.push({
        id: row.id,
        shortId: row.shortId,
        title: row.title,
        realms: row.realms,
        updatedAt: row.updatedAt.toISOString(),
        fields,
      })
    }
    return items
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

  // 供 kioku run 一次性原子取值；显式 #field 严格校验存在性，严禁静默回退主值
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
      if (ref.field !== undefined) {
        const row = bySlug.get(ref.identifier)
        const canAccessPrimary = Boolean(row && canAccessCredential(scope, row))
        if (canAccessPrimary && row) {
          const payload = openCredentialPayload(this.masterKey, row)
          if (Object.hasOwn(payload.fields, ref.field)) {
            values.push({
              identifier: ref.identifier,
              field: ref.field,
              value: payload.fields[ref.field]!,
            })
            continue
          }
        }

        const compositeRow = bySlug.get(`${ref.identifier}-${ref.field}`)
        if (compositeRow && canAccessCredential(scope, compositeRow)) {
          const payload = openCredentialPayload(this.masterKey, compositeRow)
          const resolvedValue = Object.hasOwn(payload.fields, compositeRow.primaryField)
            ? payload.fields[compositeRow.primaryField]!
            : payload.value
          values.push({
            identifier: ref.identifier,
            field: ref.field,
            value: resolvedValue,
          })
          continue
        }

        if (!canAccessPrimary) {
          throw new MemoryError(404, `凭据不存在或当前密钥无权访问：${ref.identifier}`)
        }
        throw new MemoryError(404, `凭据 ${ref.identifier} 不存在字段 ${ref.field}`)
      }

      const row = bySlug.get(ref.identifier)
      if (!row || !canAccessCredential(scope, row)) {
        throw new MemoryError(404, `凭据不存在或当前密钥无权访问：${ref.identifier}`)
      }
      const payload = openCredentialPayload(this.masterKey, row)
      const resolvedValue = Object.hasOwn(payload.fields, row.primaryField)
        ? payload.fields[row.primaryField]!
        : payload.value

      values.push({
        identifier: ref.identifier,
        field: 'value',
        value: resolvedValue,
      })
    }

    return { values, expired: [] }
  }

  // 解析词条正文中的 {{cred:...}} 占位符可用状态（仅检查可见性与 field_meta 元数据，不解密值）
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
        primaryField: credentials.primaryField,
        fieldMeta: credentials.fieldMeta,
      })
      .from(credentials)
      .where(inArray(credentials.slug, [...candidateSlugs]))
    const bySlug = new Map(rows.map((r) => [r.slug, r]))

    return deduped.map((item) => {
      if (item.field !== null) {
        const row = bySlug.get(item.slug)
        if (row && canAccessCredential(scope, row)) {
          const fieldExists =
            row.fieldMeta.length > 0
              ? row.fieldMeta.some((f) => f.name === item.field)
              : item.field === 'value' || item.field === row.primaryField
          if (fieldExists) {
            return {
              slug: item.slug,
              field: item.field,
              available: true,
              label: row.label,
            }
          }
        }
        const composite = bySlug.get(`${item.slug}-${item.field}`)
        if (composite && canAccessCredential(scope, composite)) {
          return {
            slug: item.slug,
            field: item.field,
            available: true,
            label: composite.label,
          }
        }
        return {
          slug: item.slug,
          field: item.field,
          available: false,
          label: null,
        }
      }

      const row = bySlug.get(item.slug)
      const available = Boolean(row && canAccessCredential(scope, row))
      return {
        slug: item.slug,
        field: null,
        available,
        label: available ? (row?.label ?? null) : null,
      }
    })
  }
}
