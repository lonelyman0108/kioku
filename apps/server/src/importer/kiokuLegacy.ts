import { createDecipheriv, createHmac, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

import {
  ClientAdvanced,
  ClientConfig,
  CREDENTIAL_NAME_PATTERN,
  CREDENTIAL_PLACEHOLDER,
  CredentialField,
  CredentialIdentifier,
  CredentialSource,
  deriveEntryTitle,
  DISCLOSURE_MAX,
  ENTRY_TITLE_MAX,
  ExtractionBudget,
  FACET_TERM_SLUG_PATTERN,
  GLOSSARY_MAX,
  MEMBER_ROLES,
  placeholderAllowed,
  PROVENANCES,
  RUNTIME_FAMILIES,
  SENSITIVITIES,
  sensitivityAllowed,
  Slug,
  SUBJECT_KINDS,
  TOPICS_MAX,
  VAULT_CONNECTION_STATUSES,
  VAULT_DISABLED_REASONS,
  VAULT_ERROR_KINDS,
  VaultCredentialFields,
  VaultEmail,
  VaultItemId,
  VaultServerUrl,
  whenSignature,
  type CircleKind,
  type ConversationKind,
  type EntryKind,
  type Provenance,
  type Sensitivity,
  type SubjectKind,
  type VaultConnectionStatus,
  type VaultDisabledReason,
  type VaultErrorKind,
  type WhenCondition,
} from '@kioku/contracts'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import postgres from 'postgres'
import { z } from 'zod'

import { createPersonalCircle } from '../access/circles'
import { openBackup } from '../backup/format'
import { assertUninitialized } from '../backup/restore'
import { placeholderIdentifiers } from '../credential/placeholders'
import { openCredentialValues, sealCredentialValues } from '../credential/service'
import { openVaultSecrets, sealVaultSecrets } from '../credential/vault'
import { decryptSecret, encryptSecret } from '../crypto/envelope'
import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'
import { prepareMasterKey } from '../crypto/rotation'
import { withCircles, type Db, type Tx } from '../db/client'
import {
  accounts,
  circleMembers,
  circles,
  clientGroupRules,
  clients,
  conversations,
  credentials,
  entries,
  entryEvents,
  entryGlossary,
  entryVariants,
  facetTerms,
  legacyUris,
  personas,
  personaTraits,
  settings,
  subjectIdentities,
  subjects,
  vaultConnections,
} from '../db/schema'
import { migrateLegacyModelSettings, type StoredProvider } from '../models/store'
import { syncEntryLinks } from '../memory/links'
import { buildSearchHeader, syncCredentialRefs, toStoredSnapshot } from '../memory/service'
import { generateShortId } from '../memory/shortId'
import { parseUri } from '../memory/uri'
import { CLIENT_ADVANCED_FIELD } from '../settings/advanced'
import { openApiKey, type SealedJson } from '../settings/endpoint'

const SPACE_EXPORT_MAGIC = Buffer.from('KIOKUSX1')
const SALT_LENGTH = 16
const IV_LENGTH = 12
const CHECK_LENGTH = 16
const TAG_LENGTH = 16
const HEADER_LENGTH = SPACE_EXPORT_MAGIC.length + 3 + SALT_LENGTH + IV_LENGTH + CHECK_LENGTH
const MAX_KDF_MEMORY = 256 * 1024 * 1024
const SPACE_EXPORT_MAX_PLAIN_BYTES = 128 * 1024 * 1024

const LEGACY_LAYERS = ['user', 'core', 'persona', 'app', 'subject', 'episode'] as const
type LegacyLayer = (typeof LEGACY_LAYERS)[number]
const LEGACY_FORMS = ['curated', 'extracted'] as const
type LegacyForm = (typeof LEGACY_FORMS)[number]

const SKIPPED_SETTING_KEYS = new Set([
  'backup',
  'backup-status',
  'master-key-error',
  'device_cookie_secret',
  'update-check-status',
  'embedding-error',
  'retention-status',
  'retention-restored',
])

const gunzipAsync = promisify(gunzip)

const scryptAsync = (
  passphrase: string,
  salt: Buffer,
  kdf: { logN: number; r: number; p: number },
) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      passphrase.normalize('NFKC'),
      salt,
      64,
      {
        N: 2 ** kdf.logN,
        r: kdf.r,
        p: kdf.p,
        maxmem: 128 * 2 ** kdf.logN * kdf.r + 32 * 1024 * 1024,
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  )

// ---- 标准化旧版源数据结构 ----

export interface LegacyAccount {
  id: string
  username: string
  displayName: string
  passwordHash: string | null
  isAdmin: boolean
  disabledAt: Date | null
  createdAt: Date
}

export interface LegacySpace {
  id: string
  name: string
  extractionMonthlyTokens: number
  extractionDailyWrites: number
  advanced: Record<string, unknown>
  privacy: Record<string, unknown>
  privacyRevision: number
  createdAt: Date
}

export interface LegacySpaceMember {
  spaceId: string
  accountId: string
  role: 'owner' | 'editor' | 'viewer'
  dreamPrivate: boolean
  createdAt: Date
}

export interface LegacySetting {
  key: string
  value: unknown
  updatedAt: Date
}

export interface LegacyPersona {
  id: string
  spaceId: string
  slug: string
  name: string
  extendsId: string | null
  description: string | null
  createdAt: Date
  updatedAt: Date
}

export interface LegacyApp {
  id: string
  spaceId: string
  slug: string
  name: string
  runtimeFamily: string
  ownerAccountId: string | null
  defaultPersonaId: string | null
  config: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface LegacyGroupPersona {
  spaceId: string
  appId: string
  subjectId: string
  personaId: string
  createdAt: Date
}

export interface LegacySubject {
  id: string
  spaceId: string
  kind: SubjectKind
  displayName: string
  nameLocked: boolean
  accountId: string | null
  linkedToExporter: boolean
  createdAt: Date
  updatedAt: Date
}

export interface LegacySubjectIdentity {
  id: string
  spaceId: string
  subjectId: string
  kind: SubjectKind
  platform: string
  externalId: string
  displayName: string | null
  createdAt: Date
}

export interface LegacyConversation {
  id: string
  spaceId: string
  appId: string
  kind: ConversationKind
  subjectId: string | null
  ownerAccountId: string | null
  createdAt: Date
  lastActiveAt: Date
}

export interface LegacyVaultConnection {
  id: string
  spaceId: string
  ownerAccountId: string | null
  serverUrl: string
  email: string
  vaultUserId: string
  deviceId: string
  ciphertext: Buffer | null
  wrappedKey: Buffer | null
  keyId: string | null
  status: VaultConnectionStatus
  disabledReason: VaultDisabledReason | null
  lastErrorKind: VaultErrorKind | null
  lastErrorAt: Date | null
  lastCheckedAt: Date | null
  defaultCollectionId: string | null
  defaultOrganizationId: string | null
  defaultCollectionName: string | null
  disconnectedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface LegacyCredential {
  id: string
  spaceId: string
  ownerAccountId: string | null
  identifier: string
  name: string
  description: string | null
  source: 'hosted' | 'vault'
  plainValues: Record<string, string> | null
  vaultConnectionId: string | null
  vaultItemId: string | null
  fields: CredentialField[]
  ciphertext: Buffer | null
  wrappedKey: Buffer | null
  keyId: string | null
  appIds: string[] | null
  version: number
  expiresAt: Date | null
  rotationRequestedAt: Date | null
  valueVersion: number
  valueChangedAt: Date | null
  vaultRevision: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface LegacyMemory {
  id: string
  spaceId: string
  form: LegacyForm
  layer: LegacyLayer
  sensitivity: Sensitivity
  provenance: Provenance
  originScope: string
  ownerAccountId: string | null
  personaId: string | null
  appId: string | null
  subjectId: string | null
  conversationId: string | null
  uri: string | null
  domain: string | null
  path: string | null
  title: string | null
  content: string | null
  ciphertext: Buffer | null
  wrappedKey: Buffer | null
  keyId: string | null
  plaintextIgnoredHash: string | null
  sensitiveRevision: number
  sensitiveCredential: boolean
  sensitivePii: boolean
  sensitiveFindings: unknown[]
  priority: number
  disclosure: string | null
  glossary: string[]
  validFrom: Date
  validTo: Date | null
  expiresAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface LegacySnapshot {
  mode: 'instance' | 'space-export'
  sourceVersion: string
  exporter?: { displayName: string; dreamPrivate: boolean }
  accounts: LegacyAccount[]
  spaces: LegacySpace[]
  members: LegacySpaceMember[]
  settings: LegacySetting[]
  personas: LegacyPersona[]
  apps: LegacyApp[]
  groupPersonas: LegacyGroupPersona[]
  subjects: LegacySubject[]
  identities: LegacySubjectIdentity[]
  conversations: LegacyConversation[]
  vaultConnections: LegacyVaultConnection[]
  credentials: LegacyCredential[]
  memories: LegacyMemory[]
  skippedApiKeys: number
  skippedDeletedMemories: number
  skippedDeletedCredentials: number
}

// ---- Space Export（KIOKUSX1）解析 ----

const SpaceHeaderSchema = z.object({
  format: z.literal('kioku-space-export'),
  version: z.number().int().min(4).max(6),
  createdAt: z.string(),
  kioku: z.string(),
  exporter: z.object({
    displayName: z.string(),
    dreamPrivate: z.boolean().default(true),
  }),
  space: z.object({
    name: z.string().trim().min(1).max(64),
    extractionMonthlyTokens: ExtractionBudget.shape.monthlyTokens,
    extractionDailyWrites: ExtractionBudget.shape.dailyWritesPerSubject,
    advanced: z.record(z.string(), z.unknown()).optional(),
    privacy: z.record(z.string(), z.unknown()).optional(),
  }),
})

const SpacePersonaSchema = z.object({
  type: z.literal('persona'),
  id: z.guid(),
  slug: Slug,
  name: z.string().min(1).max(64),
  extendsId: z.guid().nullable(),
  description: z.string().max(500).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const SpaceAppSchema = z.object({
  type: z.literal('app'),
  id: z.guid(),
  slug: Slug,
  name: z.string().min(1).max(64),
  runtimeFamily: z.string().min(1),
  defaultPersonaId: z.guid().nullable(),
  config: z.record(z.string(), z.unknown()).default({}),
  advanced: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const SpaceSubjectSchema = z.object({
  type: z.literal('subject'),
  id: z.guid(),
  kind: z.enum(SUBJECT_KINDS),
  displayName: z.string().min(1),
  nameLocked: z.boolean(),
  linkedToExporter: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const SpaceIdentitySchema = z.object({
  type: z.literal('identity'),
  subjectId: z.guid(),
  kind: z.enum(SUBJECT_KINDS),
  platform: z.string().min(1),
  externalId: z.string().min(1),
  displayName: z.string().nullable(),
  createdAt: z.string(),
})

const SpaceGroupPersonaSchema = z.object({
  type: z.literal('groupPersona'),
  appId: z.guid(),
  subjectId: z.guid(),
  personaId: z.guid(),
  createdAt: z.string(),
})

const SpaceVaultConnectionSchema = z.object({
  type: z.literal('vault_connection'),
  id: z.guid(),
  serverUrl: VaultServerUrl,
  email: VaultEmail,
  vaultUserId: z.string().min(1),
  destination: z
    .object({
      collectionId: z.string().min(1),
      organizationId: z.string().min(1),
      collectionName: z.string(),
    })
    .nullable()
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const SpaceCredentialSchema = z.object({
  type: z.literal('credential'),
  id: z.guid(),
  identifier: CredentialIdentifier,
  name: z.string().min(1),
  description: z.string().nullable(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('hosted'), values: z.record(z.string(), z.string()) }),
    z.object({
      kind: z.literal('vault'),
      connectionId: z.guid(),
      itemId: VaultItemId,
      fields: VaultCredentialFields,
    }),
  ]),
  appIds: z.array(z.guid()).nullable(),
  expiresAt: z.string().nullable().optional(),
  rotationRequestedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const SpaceMemorySchema = z.object({
  type: z.literal('memory'),
  id: z.guid(),
  form: z.enum(LEGACY_FORMS),
  layer: z.enum(LEGACY_LAYERS),
  sensitivity: z.enum(SENSITIVITIES),
  provenance: z.enum(PROVENANCES),
  originScope: z.string(),
  personaId: z.guid().nullable(),
  appId: z.guid().nullable(),
  subjectId: z.guid().nullable(),
  uri: z.string().nullable(),
  title: z.string().nullable(),
  content: z.string(),
  priority: z.number().int().min(0),
  disclosure: z.string().nullable(),
  glossary: z.array(z.string()),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  expiresAt: z.string().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const SpaceRecordSchema = z.discriminatedUnion('type', [
  SpacePersonaSchema,
  SpaceAppSchema,
  SpaceSubjectSchema,
  SpaceIdentitySchema,
  SpaceGroupPersonaSchema,
  SpaceVaultConnectionSchema,
  SpaceCredentialSchema,
  SpaceMemorySchema,
])

function toDate(val: unknown, fallback = new Date()): Date {
  if (val instanceof Date) return val
  if (typeof val === 'string') {
    const parsed = new Date(val)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return fallback
}

function toNullableDate(val: unknown): Date | null {
  if (val === null || val === undefined) return null
  if (val instanceof Date) return val
  if (typeof val === 'string') {
    const parsed = new Date(val)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return null
}

function decodeBytea(val: unknown): Buffer | null {
  if (val === null || val === undefined) return null
  if (Buffer.isBuffer(val)) return val
  if (val instanceof Uint8Array) return Buffer.from(val)
  if (typeof val === 'string') {
    const clean = val.startsWith('\\x')
      ? val.slice(2)
      : val.startsWith('\\\\x')
        ? val.slice(3)
        : val
    return Buffer.from(clean, 'hex')
  }
  return null
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val.filter((v): v is string => typeof v === 'string')
}

function asObject(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {}
}

export async function readLegacySpaceExport(
  file: Buffer,
  passphrase: string,
): Promise<LegacySnapshot> {
  if (file.length >= 8 && file.subarray(0, 8).toString('ascii') === 'KIOKUBK1') {
    throw new Error('这是全实例备份文件，请改用 --backup 迁移')
  }
  if (file.length >= 8 && file.subarray(0, 8).toString('ascii') === 'KIOKUCX2') {
    throw new Error('这是新版记忆圈导出文件，请直接在管理界面或按记忆圈导入，无需迁移')
  }
  if (
    file.length < HEADER_LENGTH + TAG_LENGTH ||
    !file.subarray(0, SPACE_EXPORT_MAGIC.length).equals(SPACE_EXPORT_MAGIC)
  ) {
    throw new Error('不是旧版 Kioku 空间导出文件')
  }

  const headerBuf = file.subarray(0, HEADER_LENGTH)
  let at = SPACE_EXPORT_MAGIC.length
  const logN = headerBuf[at++]!
  const r = headerBuf[at++]!
  const p = headerBuf[at++]!
  const kdfMem = 128 * 2 ** logN * r
  if (logN < 14 || logN > 18 || r < 1 || r > 16 || p < 1 || p > 4 || kdfMem > MAX_KDF_MEMORY) {
    throw new Error('旧版导出文件头中的加密参数超出可接受范围')
  }

  const salt = headerBuf.subarray(at, (at += SALT_LENGTH))
  const iv = headerBuf.subarray(at, (at += IV_LENGTH))
  const expectedCheck = headerBuf.subarray(at, at + CHECK_LENGTH)

  const derived = await scryptAsync(passphrase, salt, { logN, r, p })
  const check = createHmac('sha256', derived.subarray(32))
    .update('kioku-space-export-check')
    .digest()
    .subarray(0, CHECK_LENGTH)
  if (!timingSafeEqual(check, expectedCheck)) {
    throw new Error('旧版空间导出文件口令错误（或文件头已被修改）')
  }

  const decipher = createDecipheriv('aes-256-gcm', derived.subarray(0, 32), iv)
  decipher.setAAD(headerBuf)
  decipher.setAuthTag(file.subarray(file.length - TAG_LENGTH))

  let compressed: Buffer
  try {
    compressed = Buffer.concat([
      decipher.update(file.subarray(HEADER_LENGTH, file.length - TAG_LENGTH)),
      decipher.final(),
    ])
  } catch {
    throw new Error('旧版空间导出文件无法解密：文件不完整或已被修改')
  }

  let plain: Buffer
  try {
    plain = await gunzipAsync(compressed, { maxOutputLength: SPACE_EXPORT_MAX_PLAIN_BYTES })
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`导出文件解压后超过 ${SPACE_EXPORT_MAX_PLAIN_BYTES / 1024 / 1024} MB 上限`, {
        cause: err,
      })
    }
    throw new Error('旧版空间导出文件解压失败', { cause: err })
  }

  const text = plain.toString('utf8')
  const lines = text.split('\n').filter((line) => line.length > 0)
  if (!lines.length) throw new Error('旧版空间导出文件为空')

  let headerJson: unknown
  try {
    headerJson = JSON.parse(lines[0]!)
  } catch {
    throw new Error('旧版空间导出文件第 1 行不是合法的 JSON')
  }
  const headerParsed = SpaceHeaderSchema.safeParse(headerJson)
  if (!headerParsed.success) {
    throw new Error(`旧版空间导出文件头不兼容：仅支持格式版本 4 至 6`)
  }
  const header = headerParsed.data
  const spaceId = randomUUID()
  const createdAt = toDate(header.createdAt)

  const snap: LegacySnapshot = {
    mode: 'space-export',
    sourceVersion: `${header.kioku} (format ${header.version})`,
    exporter: header.exporter,
    accounts: [],
    spaces: [
      {
        id: spaceId,
        name: header.space.name,
        extractionMonthlyTokens: header.space.extractionMonthlyTokens,
        extractionDailyWrites: header.space.extractionDailyWrites,
        advanced: header.space.advanced ?? {},
        privacy: header.space.privacy ?? {},
        privacyRevision: 1,
        createdAt,
      },
    ],
    members: [],
    settings: [],
    personas: [],
    apps: [],
    groupPersonas: [],
    subjects: [],
    identities: [],
    conversations: [],
    vaultConnections: [],
    credentials: [],
    memories: [],
    skippedApiKeys: 0,
    skippedDeletedMemories: 0,
    skippedDeletedCredentials: 0,
  }

  for (let i = 1; i < lines.length; i++) {
    let raw: unknown
    try {
      raw = JSON.parse(lines[i]!)
    } catch {
      throw new Error(`导出文件第 ${i + 1} 行不是合法的 JSON`)
    }
    const parsed = SpaceRecordSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`导出文件第 ${i + 1} 行格式不合法：${parsed.error.issues[0]?.message ?? ''}`)
    }
    const rec = parsed.data
    switch (rec.type) {
      case 'persona':
        snap.personas.push({
          id: rec.id,
          spaceId,
          slug: rec.slug,
          name: rec.name,
          extendsId: rec.extendsId,
          description: rec.description,
          createdAt: toDate(rec.createdAt),
          updatedAt: toDate(rec.updatedAt),
        })
        break
      case 'app':
        snap.apps.push({
          id: rec.id,
          spaceId,
          slug: rec.slug,
          name: rec.name,
          runtimeFamily: rec.runtimeFamily,
          ownerAccountId: null,
          defaultPersonaId: rec.defaultPersonaId,
          config: {
            ...rec.config,
            ...(rec.advanced && Object.keys(rec.advanced).length
              ? { [CLIENT_ADVANCED_FIELD]: rec.advanced }
              : {}),
          },
          createdAt: toDate(rec.createdAt),
          updatedAt: toDate(rec.updatedAt),
        })
        break
      case 'subject':
        snap.subjects.push({
          id: rec.id,
          spaceId,
          kind: rec.kind,
          displayName: rec.displayName,
          nameLocked: rec.nameLocked,
          accountId: null,
          linkedToExporter: rec.linkedToExporter,
          createdAt: toDate(rec.createdAt),
          updatedAt: toDate(rec.updatedAt),
        })
        break
      case 'identity':
        snap.identities.push({
          id: randomUUID(),
          spaceId,
          subjectId: rec.subjectId,
          kind: rec.kind,
          platform: rec.platform,
          externalId: rec.externalId,
          displayName: rec.displayName,
          createdAt: toDate(rec.createdAt),
        })
        break
      case 'groupPersona':
        snap.groupPersonas.push({
          spaceId,
          appId: rec.appId,
          subjectId: rec.subjectId,
          personaId: rec.personaId,
          createdAt: toDate(rec.createdAt),
        })
        break
      case 'vault_connection':
        snap.vaultConnections.push({
          id: rec.id,
          spaceId,
          ownerAccountId: null,
          serverUrl: rec.serverUrl,
          email: rec.email,
          vaultUserId: rec.vaultUserId,
          deviceId: randomUUID(),
          ciphertext: null,
          wrappedKey: null,
          keyId: null,
          status: 'disconnected',
          disabledReason: null,
          lastErrorKind: null,
          lastErrorAt: null,
          lastCheckedAt: null,
          defaultCollectionId: rec.destination?.collectionId ?? null,
          defaultOrganizationId: rec.destination?.organizationId ?? null,
          defaultCollectionName: rec.destination?.collectionName ?? null,
          disconnectedAt: toDate(rec.updatedAt),
          createdAt: toDate(rec.createdAt),
          updatedAt: toDate(rec.updatedAt),
        })
        break
      case 'credential':
        snap.credentials.push({
          id: rec.id,
          spaceId,
          ownerAccountId: null,
          identifier: rec.identifier,
          name: rec.name,
          description: rec.description,
          source: rec.source.kind,
          plainValues: rec.source.kind === 'hosted' ? rec.source.values : null,
          vaultConnectionId: rec.source.kind === 'vault' ? rec.source.connectionId : null,
          vaultItemId: rec.source.kind === 'vault' ? rec.source.itemId : null,
          fields:
            rec.source.kind === 'vault'
              ? rec.source.fields
              : Object.keys(rec.source.values).map((name) => ({ name, itemField: null })),
          ciphertext: null,
          wrappedKey: null,
          keyId: null,
          appIds: rec.appIds,
          version: 1,
          expiresAt: toNullableDate(rec.expiresAt),
          rotationRequestedAt: toNullableDate(rec.rotationRequestedAt),
          valueVersion: 1,
          valueChangedAt: toDate(rec.updatedAt),
          vaultRevision: null,
          createdAt: toDate(rec.createdAt),
          updatedAt: toDate(rec.updatedAt),
          deletedAt: null,
        })
        break
      case 'memory': {
        const parsedUri = rec.uri ? parseUri(rec.uri) : null
        snap.memories.push({
          id: rec.id,
          spaceId,
          form: rec.form,
          layer: rec.layer,
          sensitivity: rec.sensitivity,
          provenance: rec.provenance,
          originScope: rec.originScope,
          ownerAccountId: null,
          personaId: rec.personaId,
          appId: rec.appId,
          subjectId: rec.subjectId,
          conversationId: null,
          uri: rec.uri,
          domain: parsedUri?.domain ?? (rec.form === 'curated' ? rec.layer : null),
          path: parsedUri?.path ?? null,
          title: rec.title,
          content: rec.content,
          ciphertext: null,
          wrappedKey: null,
          keyId: null,
          plaintextIgnoredHash: null,
          sensitiveRevision: 0,
          sensitiveCredential: false,
          sensitivePii: false,
          sensitiveFindings: [],
          priority: rec.priority,
          disclosure: rec.disclosure,
          glossary: rec.glossary,
          validFrom: toDate(rec.validFrom),
          validTo: toNullableDate(rec.validTo),
          expiresAt: toNullableDate(rec.expiresAt),
          version: rec.version,
          createdAt: toDate(rec.createdAt),
          updatedAt: toDate(rec.updatedAt),
          deletedAt: null,
        })
        break
      }
    }
  }

  return snap
}

// ---- 全实例旧备份与旧数据库共用行映射 ----

type RawRow = Record<string, unknown>

function mapAccountRow(r: RawRow): LegacyAccount {
  return {
    id: String(r.id),
    username: String(r.username),
    displayName: String(r.display_name),
    passwordHash: r.password_hash ? String(r.password_hash) : null,
    isAdmin: Boolean(r.is_admin),
    disabledAt: toNullableDate(r.disabled_at),
    createdAt: toDate(r.created_at),
  }
}

function mapSpaceRow(r: RawRow): LegacySpace {
  return {
    id: String(r.id),
    name: String(r.name),
    extractionMonthlyTokens: Number(r.extraction_monthly_tokens ?? 1_000_000),
    extractionDailyWrites: Number(r.extraction_daily_writes ?? 50),
    advanced: asObject(r.advanced),
    privacy: asObject(r.privacy),
    privacyRevision: Number(r.privacy_revision ?? 1),
    createdAt: toDate(r.created_at),
  }
}

function mapMemberRow(r: RawRow): LegacySpaceMember {
  const rawRole = String(r.role)
  const role = (MEMBER_ROLES as readonly string[]).includes(rawRole)
    ? (rawRole as 'owner' | 'editor' | 'viewer')
    : 'viewer'
  return {
    spaceId: String(r.space_id),
    accountId: String(r.account_id),
    role,
    dreamPrivate: Boolean(r.dream_private ?? true),
    createdAt: toDate(r.created_at),
  }
}

function mapPersonaRow(r: RawRow, spaceId: string): LegacyPersona {
  return {
    id: String(r.id),
    spaceId: String(r.space_id ?? spaceId),
    slug: String(r.slug),
    name: String(r.name),
    extendsId: r.extends_id ? String(r.extends_id) : null,
    description: r.description ? String(r.description) : null,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  }
}

function mapAppRow(r: RawRow, spaceId: string): LegacyApp {
  return {
    id: String(r.id),
    spaceId: String(r.space_id ?? spaceId),
    slug: String(r.slug),
    name: String(r.name),
    runtimeFamily: String(r.runtime_family ?? 'other'),
    ownerAccountId: r.owner_account_id ? String(r.owner_account_id) : null,
    defaultPersonaId: r.default_persona_id ? String(r.default_persona_id) : null,
    config: asObject(r.config),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  }
}

function mapGroupPersonaRow(r: RawRow, spaceId: string): LegacyGroupPersona {
  return {
    spaceId: String(r.space_id ?? spaceId),
    appId: String(r.app_id),
    subjectId: String(r.subject_id),
    personaId: String(r.persona_id),
    createdAt: toDate(r.created_at),
  }
}

function mapSubjectRow(r: RawRow, spaceId: string): LegacySubject {
  const kind = String(r.kind) === 'group' ? 'group' : 'person'
  return {
    id: String(r.id),
    spaceId: String(r.space_id ?? spaceId),
    kind,
    displayName: String(r.display_name),
    nameLocked: Boolean(r.name_locked),
    accountId: r.account_id ? String(r.account_id) : null,
    linkedToExporter: false,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  }
}

function mapIdentityRow(r: RawRow, spaceId: string): LegacySubjectIdentity {
  const kind = String(r.kind) === 'group' ? 'group' : 'person'
  return {
    id: String(r.id),
    spaceId: String(r.space_id ?? spaceId),
    subjectId: String(r.subject_id),
    kind,
    platform: String(r.platform),
    externalId: String(r.external_id),
    displayName: r.display_name ? String(r.display_name) : null,
    createdAt: toDate(r.created_at),
  }
}

function mapConversationRow(r: RawRow, spaceId: string): LegacyConversation {
  const rawKind = String(r.kind)
  const kind: ConversationKind =
    rawKind === 'group' || rawKind === 'direct' || rawKind === 'channel' || rawKind === 'none'
      ? rawKind
      : 'none'
  return {
    id: String(r.id),
    spaceId: String(r.space_id ?? spaceId),
    appId: String(r.app_id),
    kind,
    subjectId: r.subject_id ? String(r.subject_id) : null,
    ownerAccountId: r.owner_account_id ? String(r.owner_account_id) : null,
    createdAt: toDate(r.created_at),
    lastActiveAt: toDate(r.last_active_at),
  }
}

function mapVaultConnectionRow(r: RawRow, spaceId: string): LegacyVaultConnection {
  const rawStatus = String(r.status ?? 'ok')
  const status: VaultConnectionStatus = (VAULT_CONNECTION_STATUSES as readonly string[]).includes(
    rawStatus,
  )
    ? (rawStatus as VaultConnectionStatus)
    : 'disconnected'
  const rawReason = r.disabled_reason ? String(r.disabled_reason) : null
  const disabledReason: VaultDisabledReason | null =
    rawReason && (VAULT_DISABLED_REASONS as readonly string[]).includes(rawReason)
      ? (rawReason as VaultDisabledReason)
      : null
  const rawErr = r.last_error_kind ? String(r.last_error_kind) : null
  const lastErrorKind: VaultErrorKind | null =
    rawErr && (VAULT_ERROR_KINDS as readonly string[]).includes(rawErr)
      ? (rawErr as VaultErrorKind)
      : null

  return {
    id: String(r.id),
    spaceId: String(r.space_id ?? spaceId),
    ownerAccountId: r.owner_account_id ? String(r.owner_account_id) : null,
    serverUrl: String(r.server_url),
    email: String(r.email),
    vaultUserId: String(r.vault_user_id),
    deviceId: String(r.device_id),
    ciphertext: decodeBytea(r.ciphertext),
    wrappedKey: decodeBytea(r.wrapped_key),
    keyId: r.key_id ? String(r.key_id) : null,
    status,
    disabledReason,
    lastErrorKind,
    lastErrorAt: toNullableDate(r.last_error_at),
    lastCheckedAt: toNullableDate(r.last_checked_at),
    defaultCollectionId: r.default_collection_id ? String(r.default_collection_id) : null,
    defaultOrganizationId: r.default_organization_id ? String(r.default_organization_id) : null,
    defaultCollectionName: r.default_collection_name ? String(r.default_collection_name) : null,
    disconnectedAt: toNullableDate(r.disconnected_at),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  }
}

function mapCredentialRow(r: RawRow, spaceId: string): LegacyCredential {
  const fieldsParsed = z.array(CredentialField).safeParse(r.fields ?? [])
  return {
    id: String(r.id),
    spaceId: String(r.space_id ?? spaceId),
    ownerAccountId: r.owner_account_id ? String(r.owner_account_id) : null,
    identifier: String(r.identifier),
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    source: CredentialSource.catch('hosted').parse(r.source),
    plainValues: null,
    vaultConnectionId: r.vault_connection_id ? String(r.vault_connection_id) : null,
    vaultItemId: r.vault_item_id ? String(r.vault_item_id) : null,
    fields: fieldsParsed.success ? fieldsParsed.data : [],
    ciphertext: decodeBytea(r.ciphertext),
    wrappedKey: decodeBytea(r.wrapped_key),
    keyId: r.key_id ? String(r.key_id) : null,
    appIds: r.app_ids === null || r.app_ids === undefined ? null : asStringArray(r.app_ids),
    version: Number(r.version ?? 1),
    expiresAt: toNullableDate(r.expires_at),
    rotationRequestedAt: toNullableDate(r.rotation_requested_at),
    valueVersion: Number(r.value_version ?? 1),
    valueChangedAt: toNullableDate(r.value_changed_at),
    vaultRevision: r.vault_revision ? String(r.vault_revision) : null,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    deletedAt: toNullableDate(r.deleted_at),
  }
}

function mapMemoryRow(
  r: RawRow,
  spaceId: string,
  glossaryByMemory: ReadonlyMap<string, string[]>,
): LegacyMemory {
  const domain = r.domain ? String(r.domain) : null
  const path = r.path ? String(r.path) : null
  const uri = domain && path ? `${domain}://${path}` : null
  return {
    id: String(r.id),
    spaceId: String(r.space_id ?? spaceId),
    form: String(r.form) === 'extracted' ? 'extracted' : 'curated',
    layer: String(r.layer) as LegacyLayer,
    sensitivity: String(r.sensitivity) as Sensitivity,
    provenance: String(r.provenance) as Provenance,
    originScope: String(r.origin_scope ?? 'global'),
    ownerAccountId: r.owner_account_id ? String(r.owner_account_id) : null,
    personaId: r.persona_id ? String(r.persona_id) : null,
    appId: r.app_id ? String(r.app_id) : null,
    subjectId: r.subject_id ? String(r.subject_id) : null,
    conversationId: r.conversation_id ? String(r.conversation_id) : null,
    uri,
    domain,
    path,
    title: r.title ? String(r.title) : null,
    content: r.content !== null && r.content !== undefined ? String(r.content) : null,
    ciphertext: decodeBytea(r.ciphertext),
    wrappedKey: decodeBytea(r.wrapped_key),
    keyId: r.key_id ? String(r.key_id) : null,
    plaintextIgnoredHash: r.plaintext_ignored_hash ? String(r.plaintext_ignored_hash) : null,
    sensitiveRevision: Number(r.sensitive_revision ?? 0),
    sensitiveCredential: Boolean(r.sensitive_credential),
    sensitivePii: Boolean(r.sensitive_pii),
    sensitiveFindings: Array.isArray(r.sensitive_findings) ? r.sensitive_findings : [],
    priority: Number(r.priority ?? 2),
    disclosure: r.disclosure ? String(r.disclosure) : null,
    glossary: glossaryByMemory.get(String(r.id)) ?? [],
    validFrom: toDate(r.valid_from),
    validTo: toNullableDate(r.valid_to),
    expiresAt: toNullableDate(r.expires_at),
    version: Number(r.version ?? 1),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    deletedAt: toNullableDate(r.deleted_at),
  }
}

export function readLegacyInstanceBackup(file: Buffer, legacyMasterKey: MasterKey): LegacySnapshot {
  const plain = openBackup(legacyMasterKey, file)
  const text = plain.toString('utf8')
  const lines = text.split('\n').filter((l) => l.length > 0)
  if (!lines.length) throw new Error('旧版全实例备份是空的')

  let headerRaw: { format?: unknown; version?: unknown; kioku?: unknown }
  try {
    headerRaw = JSON.parse(lines[0]!) as {
      format?: unknown
      version?: unknown
      kioku?: unknown
    }
  } catch {
    throw new Error('旧版全实例备份文件第 1 行不是合法的 JSON')
  }
  if (headerRaw.format !== 'kioku-backup') {
    throw new Error('不是 Kioku 全实例备份文件')
  }
  if (headerRaw.version === 2) {
    throw new Error('这是新版（记忆圈架构）全实例备份文件，请直接使用 restore 恢复，无需迁移')
  }
  if (headerRaw.version !== 1) {
    throw new Error(`不支持的旧版备份格式版本：${String(headerRaw.version)}`)
  }

  const snap: LegacySnapshot = {
    mode: 'instance',
    sourceVersion: `${String(headerRaw.kioku ?? 'legacy')} (backup)`,
    accounts: [],
    spaces: [],
    members: [],
    settings: [],
    personas: [],
    apps: [],
    groupPersonas: [],
    subjects: [],
    identities: [],
    conversations: [],
    vaultConnections: [],
    credentials: [],
    memories: [],
    skippedApiKeys: 0,
    skippedDeletedMemories: 0,
    skippedDeletedCredentials: 0,
  }

  const rawMemories: { row: RawRow; spaceId: string }[] = []
  const glossaryByMemory = new Map<string, string[]>()

  let currentTable = ''
  let currentSpaceId = ''
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('[')) {
      let head: [string, string | null]
      try {
        head = JSON.parse(line) as [string, string | null]
      } catch {
        throw new Error(`旧版备份第 ${i + 1} 行段头不是合法的 JSON`)
      }
      currentTable = head[0]
      currentSpaceId = head[1] ?? ''
      continue
    }
    let row: RawRow
    try {
      row = JSON.parse(line) as RawRow
    } catch {
      throw new Error(`旧版备份第 ${i + 1} 行记录不是合法的 JSON`)
    }
    switch (currentTable) {
      case 'accounts':
        snap.accounts.push(mapAccountRow(row))
        break
      case 'spaces':
        snap.spaces.push(mapSpaceRow(row))
        break
      case 'space_members':
        snap.members.push(mapMemberRow(row))
        break
      case 'settings':
        snap.settings.push({
          key: String(row.key),
          value: row.value,
          updatedAt: toDate(row.updated_at),
        })
        break
      case 'api_keys':
        snap.skippedApiKeys++
        break
      case 'personas':
        snap.personas.push(mapPersonaRow(row, currentSpaceId))
        break
      case 'apps':
        snap.apps.push(mapAppRow(row, currentSpaceId))
        break
      case 'app_group_personas':
        snap.groupPersonas.push(mapGroupPersonaRow(row, currentSpaceId))
        break
      case 'subjects':
        snap.subjects.push(mapSubjectRow(row, currentSpaceId))
        break
      case 'subject_identities':
        snap.identities.push(mapIdentityRow(row, currentSpaceId))
        break
      case 'conversations':
        snap.conversations.push(mapConversationRow(row, currentSpaceId))
        break
      case 'vault_connections':
        snap.vaultConnections.push(mapVaultConnectionRow(row, currentSpaceId))
        break
      case 'credentials': {
        const cred = mapCredentialRow(row, currentSpaceId)
        if (cred.deletedAt) snap.skippedDeletedCredentials++
        else snap.credentials.push(cred)
        break
      }
      case 'memory_glossary': {
        const memoryId = String(row.memory_id)
        const kw = String(row.keyword)
        const list = glossaryByMemory.get(memoryId)
        if (list) list.push(kw)
        else glossaryByMemory.set(memoryId, [kw])
        break
      }
      case 'memories':
        rawMemories.push({ row, spaceId: currentSpaceId })
        break
    }
  }

  for (const item of rawMemories) {
    const m = mapMemoryRow(item.row, item.spaceId, glossaryByMemory)
    if (m.deletedAt) snap.skippedDeletedMemories++
    else snap.memories.push(m)
  }

  return snap
}

export async function readLegacyDatabase(url: string): Promise<LegacySnapshot> {
  const client = postgres(url, { max: 2, onnotice: () => {} })
  try {
    return await client.begin('read only', async (tx) => {
      const [checkNew] = await tx<
        { has_circles: boolean; has_spaces: boolean }[]
      >`select to_regclass('circles') is not null as has_circles, to_regclass('spaces') is not null as has_spaces`
      if (checkNew?.has_circles) {
        throw new Error('源数据库已经是新版记忆圈结构，无需再用旧版迁移工具')
      }
      if (!checkNew?.has_spaces) {
        throw new Error('源数据库里找不到旧版 spaces 表，请检查数据库连接是否正确')
      }

      const accountRows = await tx<RawRow[]>`select * from accounts order by created_at, id`
      const spaceRows = await tx<RawRow[]>`select * from spaces order by created_at, id`
      const memberRows = await tx<RawRow[]>`select * from space_members order by created_at`
      const settingRows = await tx<RawRow[]>`select * from settings`
      const [keyCount] = await tx<{ n: number }[]>`select count(*)::int as n from api_keys`

      const snap: LegacySnapshot = {
        mode: 'instance',
        sourceVersion: 'postgres-legacy',
        accounts: accountRows.map(mapAccountRow),
        spaces: spaceRows.map(mapSpaceRow),
        members: memberRows.map(mapMemberRow),
        settings: settingRows.map((r) => ({
          key: String(r.key),
          value: r.value,
          updatedAt: toDate(r.updated_at),
        })),
        personas: [],
        apps: [],
        groupPersonas: [],
        subjects: [],
        identities: [],
        conversations: [],
        vaultConnections: [],
        credentials: [],
        memories: [],
        skippedApiKeys: keyCount?.n ?? 0,
        skippedDeletedMemories: 0,
        skippedDeletedCredentials: 0,
      }

      for (const space of snap.spaces) {
        await tx`select set_config('app.space_id', ${space.id}, true)`

        const personaRows = await tx<RawRow[]>`select * from personas order by created_at, id`
        const appRows = await tx<RawRow[]>`select * from apps order by created_at, id`
        const gpRows = await tx<RawRow[]>`select * from app_group_personas`
        const subjectRows = await tx<RawRow[]>`select * from subjects order by created_at, id`
        const idRows = await tx<RawRow[]>`select * from subject_identities order by created_at, id`
        const convRows = await tx<RawRow[]>`select * from conversations order by created_at, id`
        const vaultRows = await tx<
          RawRow[]
        >`select * from vault_connections order by created_at, id`
        const credRows = await tx<RawRow[]>`select * from credentials order by created_at, id`
        const glossRows = await tx<RawRow[]>`select * from memory_glossary`
        const memRows = await tx<RawRow[]>`select * from memories order by created_at, id`

        for (const r of personaRows) snap.personas.push(mapPersonaRow(r, space.id))
        for (const r of appRows) snap.apps.push(mapAppRow(r, space.id))
        for (const r of gpRows) snap.groupPersonas.push(mapGroupPersonaRow(r, space.id))
        for (const r of subjectRows) snap.subjects.push(mapSubjectRow(r, space.id))
        for (const r of idRows) snap.identities.push(mapIdentityRow(r, space.id))
        for (const r of convRows) snap.conversations.push(mapConversationRow(r, space.id))
        for (const r of vaultRows) snap.vaultConnections.push(mapVaultConnectionRow(r, space.id))

        for (const r of credRows) {
          const cred = mapCredentialRow(r, space.id)
          if (cred.deletedAt) snap.skippedDeletedCredentials++
          else snap.credentials.push(cred)
        }

        const glossaryByMemory = new Map<string, string[]>()
        for (const g of glossRows) {
          const memoryId = String(g.memory_id)
          const kw = String(g.keyword)
          const list = glossaryByMemory.get(memoryId)
          if (list) list.push(kw)
          else glossaryByMemory.set(memoryId, [kw])
        }
        for (const r of memRows) {
          const m = mapMemoryRow(r, space.id, glossaryByMemory)
          if (m.deletedAt) snap.skippedDeletedMemories++
          else snap.memories.push(m)
        }
      }

      return snap
    })
  } finally {
    await client.end()
  }
}

// ---- 辅助标准化与加密重写 ----

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const TRAIT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

function slugBase(raw: string, fallback: string, maxLen: number): string {
  const clean = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const candidate = clean || fallback
  const started = /^[a-z0-9]/.test(candidate) ? candidate : `${fallback}-${candidate}`
  return started.slice(0, maxLen)
}

function allocateSuffixId(
  base: string,
  taken: Set<string>,
  maxLen: number,
  pattern: RegExp,
  allowUnderscore = false,
): string {
  const normalized = base.trim().toLowerCase()
  let first: string
  if (allowUnderscore) {
    const cleaned = normalized.replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '')
    const candidate = cleaned || 'item'
    const started = /^[a-z0-9]/.test(candidate) ? candidate : `x-${candidate}`
    const sliced = started.slice(0, maxLen)
    first = pattern.test(sliced) ? sliced : slugBase(base, 'item', maxLen)
  } else {
    const cleanBase = slugBase(base, 'item', maxLen)
    first = pattern.test(cleanBase) ? cleanBase : slugBase(`x-${cleanBase}`, 'item', maxLen)
  }
  if (!taken.has(first)) {
    taken.add(first)
    return first
  }
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${first.slice(0, maxLen - suffix.length)}${suffix}`
    if (!taken.has(candidate) && pattern.test(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

function normalizeTraitKey(rawPath: string): string {
  const clean = rawPath
    .trim()
    .toLowerCase()
    .replace(/\//g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  const candidate = clean || 'trait'
  const started = /^[a-z0-9]/.test(candidate) ? candidate : `t-${candidate}`
  return started.slice(0, 64)
}

function normalizeRuntimeSlug(runtimeFamily: string, appSlug: string): string {
  const raw =
    (RUNTIME_FAMILIES as readonly string[]).includes(runtimeFamily) && runtimeFamily !== 'other'
      ? runtimeFamily
      : appSlug
  const lower = raw.trim().toLowerCase()
  if (FACET_TERM_SLUG_PATTERN.test(lower)) return lower
  return slugBase(lower, 'other', 64)
}

function extractTopicTags(uri: string | null, dropFirstSegment: boolean): string[] {
  if (!uri) return []
  const parsed = parseUri(uri)
  if (!parsed) return []
  const segments = parsed.path.split('/').filter(Boolean)
  if (segments.length <= (dropFirstSegment ? 2 : 1)) return []
  const middle = segments.slice(dropFirstSegment ? 1 : 0, -1)
  const out: string[] = []
  const seen = new Set<string>()
  for (const seg of middle) {
    const clean = seg.trim().toLowerCase()
    if (!clean || clean.length > 64 || clean.includes('{{cred:') || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= TOPICS_MAX) break
  }
  return out
}

function rewritePlaceholders(text: string, renameMap: ReadonlyMap<string, string>): string {
  if (!renameMap.size || !text.includes('{{cred:')) return text
  const re = new RegExp(CREDENTIAL_PLACEHOLDER.source, 'g')
  return text.replace(re, (full, identifier: string, field?: string) => {
    const next = renameMap.get(identifier)
    if (!next || next === identifier) return full
    return field ? `{{cred:${next}#${field}}}` : `{{cred:${next}}}`
  })
}

function remapOriginScope(
  raw: string,
  appIdToClientId: ReadonlyMap<string, string>,
  subjectIdMap: ReadonlyMap<string, string>,
): string {
  const at = raw.indexOf(':')
  if (at < 0) return raw
  const kind = raw.slice(0, at)
  const oldId = raw.slice(at + 1)
  if (kind === 'app') {
    const cid = appIdToClientId.get(oldId)
    return cid ? `client:${cid}` : 'global'
  }
  if (kind === 'client') {
    const cid = appIdToClientId.get(oldId)
    return cid ? `client:${cid}` : raw
  }
  if (kind === 'group' || kind === 'direct') {
    const sid = subjectIdMap.get(oldId)
    return sid ? `${kind}:${sid}` : 'global'
  }
  return raw
}

function decryptLegacyMemoryContent(row: LegacyMemory, legacyMasterKey: MasterKey | null): string {
  if (row.content !== null) return row.content
  if (!row.ciphertext || !row.wrappedKey) {
    throw new Error(`旧记忆 ${row.id} 缺少正文与密文`)
  }
  if (!legacyMasterKey) {
    throw new Error('旧数据含机密记忆，请配置 LEGACY_KIOKU_MASTER_KEY 或 KIOKU_MASTER_KEY')
  }
  try {
    return decryptSecret(
      decryptionKey(legacyMasterKey, row.keyId),
      { ciphertext: row.ciphertext, wrappedKey: row.wrappedKey },
      row.id,
    )
  } catch (err) {
    throw new Error(`无法解密旧机密记忆（${row.uri ?? row.id}）：${(err as Error).message}`, {
      cause: err,
    })
  }
}

function decryptLegacyCredentialValues(
  row: LegacyCredential,
  legacyMasterKey: MasterKey | null,
): Record<string, string> {
  if (row.plainValues) return row.plainValues
  if (!row.ciphertext || !row.wrappedKey) {
    throw new Error(`旧托管凭据 ${row.identifier} 缺少密文`)
  }
  if (!legacyMasterKey) {
    throw new Error('旧数据含托管凭据，请配置 LEGACY_KIOKU_MASTER_KEY 或 KIOKU_MASTER_KEY')
  }
  try {
    return openCredentialValues(legacyMasterKey, {
      id: row.id,
      ciphertext: row.ciphertext,
      wrappedKey: row.wrappedKey,
      keyId: row.keyId,
    })
  } catch (err) {
    throw new Error(`无法解密旧凭据 ${row.identifier}：${(err as Error).message}`, { cause: err })
  }
}

function decryptLegacyVaultSecrets(row: LegacyVaultConnection, legacyMasterKey: MasterKey | null) {
  if (!row.ciphertext || !row.wrappedKey) return null
  if (!legacyMasterKey) {
    throw new Error(
      '旧数据含已登录的密码库连接，请配置 LEGACY_KIOKU_MASTER_KEY 或 KIOKU_MASTER_KEY',
    )
  }
  try {
    return openVaultSecrets(legacyMasterKey, {
      id: row.id,
      ciphertext: row.ciphertext,
      wrappedKey: row.wrappedKey,
      keyId: row.keyId,
    })
  } catch (err) {
    throw new Error(`无法解密旧密码库连接（${row.email}）：${(err as Error).message}`, {
      cause: err,
    })
  }
}

function reencryptSealedJson(
  sealed: SealedJson | null | undefined,
  legacyMasterKey: MasterKey | null,
  targetMasterKey: MasterKey | null,
  fallbackAad: string,
  label: string,
): SealedJson | null {
  if (!sealed) return null
  const plain = openApiKey(legacyMasterKey, sealed, fallbackAad, label)
  if (!targetMasterKey) {
    throw new Error(`${label} 含加密 API Key，目标实例必须配置 KIOKU_MASTER_KEY`)
  }
  const { key, id: keyId } = encryptionKey(targetMasterKey)
  const targetAad = sealed.aad ?? fallbackAad
  const next = encryptSecret(key, plain, targetAad)
  return {
    ciphertext: next.ciphertext.toString('base64'),
    wrappedKey: next.wrappedKey.toString('base64'),
    keyId,
    ...(sealed.aad ? { aad: sealed.aad } : {}),
  }
}

function transformSettingForTarget(
  setting: LegacySetting,
  legacyMasterKey: MasterKey | null,
  targetMasterKey: MasterKey | null,
): { key: string; value: unknown; updatedAt: Date } | null {
  if (SKIPPED_SETTING_KEYS.has(setting.key)) return null

  if (setting.key === 'space-limit') {
    const raw = asObject(setting.value)
    return {
      key: 'circle-limit',
      value: { maxOwnedCircles: Number(raw.maxOwnedSpaces ?? raw.maxOwnedCircles ?? 5) },
      updatedAt: setting.updatedAt,
    }
  }

  if (setting.key === 'extraction') {
    const raw = structuredClone(asObject(setting.value))
    raw.apiKey = reencryptSealedJson(
      raw.apiKey as SealedJson | null | undefined,
      legacyMasterKey,
      targetMasterKey,
      'settings:extraction',
      '抽取模型设置',
    )
    return { key: 'extraction', value: raw, updatedAt: setting.updatedAt }
  }

  if (setting.key === 'embedding') {
    const raw = structuredClone(asObject(setting.value))
    if ('apiKey' in raw && raw.apiKey) {
      raw.apiKey = reencryptSealedJson(
        raw.apiKey as SealedJson,
        legacyMasterKey,
        targetMasterKey,
        'settings:embedding',
        '嵌入模型设置',
      )
    }
    const reencryptChannels = (setup: unknown) => {
      if (!setup || typeof setup !== 'object') return
      const s = setup as { channels?: Array<{ apiKey?: SealedJson | null }> }
      if (!Array.isArray(s.channels)) return
      for (const ch of s.channels) {
        if (ch.apiKey) {
          ch.apiKey = reencryptSealedJson(
            ch.apiKey,
            legacyMasterKey,
            targetMasterKey,
            'settings:embedding',
            '嵌入渠道设置',
          )
        }
      }
    }
    reencryptChannels(raw.active)
    reencryptChannels(raw.next)
    return { key: 'embedding', value: raw, updatedAt: setting.updatedAt }
  }

  if (setting.key === 'privacy_model') {
    const raw = structuredClone(asObject(setting.value))
    if (raw.apiKey) {
      raw.apiKey = reencryptSealedJson(
        raw.apiKey as SealedJson,
        legacyMasterKey,
        targetMasterKey,
        'settings:privacy_model',
        '隐私识别模型设置',
      )
    }
    return { key: 'privacy_model', value: raw, updatedAt: setting.updatedAt }
  }

  if (setting.key === 'model-providers') {
    const raw = structuredClone(asObject(setting.value)) as { providers?: StoredProvider[] }
    if (Array.isArray(raw.providers)) {
      for (const p of raw.providers) {
        if (p.apiKey) {
          p.apiKey = reencryptSealedJson(
            p.apiKey,
            legacyMasterKey,
            targetMasterKey,
            'settings:model-providers',
            `模型服务商 ${p.name}`,
          )
        }
      }
    }
    return { key: 'model-providers', value: raw, updatedAt: setting.updatedAt }
  }

  if (setting.key === 'model-bindings') {
    const raw = structuredClone(asObject(setting.value)) as {
      privacy?: { apiKey?: SealedJson | null }
    }
    if (raw.privacy?.apiKey) {
      raw.privacy.apiKey = reencryptSealedJson(
        raw.privacy.apiKey,
        legacyMasterKey,
        targetMasterKey,
        'settings:model-bindings:privacy-http',
        '隐私识别绑定接口',
      )
    }
    return { key: 'model-bindings', value: raw, updatedAt: setting.updatedAt }
  }

  return setting
}

function topoSortPersonas(list: readonly LegacyPersona[]): {
  ordered: LegacyPersona[]
  brokenParents: Set<string>
} {
  const byId = new Map(list.map((p) => [p.id, p]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const ordered: LegacyPersona[] = []
  const brokenParents = new Set<string>()

  const visit = (p: LegacyPersona) => {
    if (visited.has(p.id)) return
    visiting.add(p.id)
    if (p.extendsId) {
      const parent = byId.get(p.extendsId)
      if (!parent || parent.spaceId !== p.spaceId) {
        brokenParents.add(p.id)
      } else if (visiting.has(parent.id)) {
        brokenParents.add(p.id)
      } else {
        visit(parent)
      }
    }
    visiting.delete(p.id)
    visited.add(p.id)
    ordered.push(p)
  }

  for (const p of list) visit(p)
  return { ordered, brokenParents }
}

// ---- 规划与写入数据类型 ----

interface PlannedAccount {
  id: string
  username: string
  displayName: string
  passwordHash: string | null
  isAdmin: boolean
  disabledAt: Date | null
  createdAt: Date
  personalCircleId: string
  personalCircleSlug: string
  personalCircleName: string
  createAccount: boolean
}

interface PlannedSharedCircle {
  id: string
  legacySpaceId: string
  slug: string
  name: string
  extractionMonthlyTokens: number
  extractionDailyWrites: number
  advanced: Record<string, unknown>
  privacy: Record<string, unknown>
  privacyRevision: number
  createdAt: Date
  members: {
    accountId: string
    role: 'owner' | 'editor' | 'viewer'
    dreamPrivate: boolean
    createdAt: Date
  }[]
}

interface PlannedPersona {
  id: string
  circleId: string
  legacySpaceId: string
  slug: string
  name: string
  extendsId: string | null
  description: string | null
  createdAt: Date
  updatedAt: Date
}

interface PlannedPersonaTrait {
  circleId: string
  personaId: string
  traitKey: string
  title: string
  content: string
  sortOrder: number
  updatedAt: Date
  legacyUri: string
}

interface PlannedClient {
  id: string
  circleId: string
  legacySpaceId: string
  slug: string
  name: string
  runtimeFamily: string
  ownerAccountId: string
  defaultPersonaId: string | null
  config: ClientConfig
  createdAt: Date
  updatedAt: Date
}

interface PlannedGroupRule {
  circleId: string
  clientId: string
  groupSubjectId: string
  personaId: string | null
  createdAt: Date
}

interface PlannedSubject {
  id: string
  circleId: string
  kind: SubjectKind
  displayName: string
  nameLocked: boolean
  accountId: string | null
  createdAt: Date
  updatedAt: Date
}

interface PlannedIdentity {
  id: string
  circleId: string
  subjectId: string
  kind: SubjectKind
  platform: string
  externalId: string
  displayName: string | null
  createdAt: Date
}

interface PlannedConversation {
  id: string
  circleId: string
  clientId: string
  kind: ConversationKind
  deviceKey: string
  projectSlug: string
  subjectId: string | null
  ownerAccountId: string | null
  createdAt: Date
  lastActiveAt: Date
}

interface PlannedVaultConnection {
  id: string
  circleId: string
  ownerAccountId: string
  serverUrl: string
  email: string
  vaultUserId: string
  deviceId: string
  secrets: { refreshToken: string; userKey: Buffer } | null
  status: VaultConnectionStatus
  disabledReason: VaultDisabledReason | null
  lastErrorKind: VaultErrorKind | null
  lastErrorAt: Date | null
  lastCheckedAt: Date | null
  defaultCollectionId: string | null
  defaultOrganizationId: string | null
  defaultCollectionName: string | null
  disconnectedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

interface PlannedCredential {
  id: string
  circleId: string
  ownerAccountId: string
  identifier: string
  originalIdentifier: string
  name: string
  description: string | null
  source: 'hosted' | 'vault'
  plainValues: Record<string, string> | null
  vaultConnectionId: string | null
  vaultItemId: string | null
  fields: CredentialField[]
  clientIds: string[] | null
  version: number
  expiresAt: Date | null
  rotationRequestedAt: Date | null
  valueVersion: number
  valueChangedAt: Date | null
  vaultRevision: string | null
  createdAt: Date
  updatedAt: Date
}

interface PlannedEntry {
  id: string
  circleId: string
  circleKind: CircleKind
  circleName: string
  kind: EntryKind
  explicitTitle: string | null
  titleFallback: string | null
  sensitivity: Sensitivity
  provenance: Provenance
  originScope: string
  clientId: string | null
  ownerAccountId: string | null
  subjectId: string | null
  subjectKind: SubjectKind | null
  conversationId: string | null
  realms: string[]
  topics: string[]
  priority: number
  disclosure: string | null
  glossary: string[]
  validFrom: Date
  validTo: Date | null
  expiresAt: Date | null
  legacyVersion: number
  createdAt: Date
  updatedAt: Date
  when: WhenCondition
  whenSignature: string
  plaintext: string
  plaintextIgnoredHash: string | null
  sensitiveRevision: number
  sensitiveCredential: boolean
  sensitivePii: boolean
  sensitiveFindings: unknown[]
  legacyUri: string | null
  runtimeFacetSlug: string | null
}

export interface LegacyMigrationPlanSummary {
  mode: 'instance' | 'space-export'
  sourceVersion: string
  accounts: number
  personalCircles: number
  sharedCircles: { id: string; name: string; slug: string; memberCount: number }[]
  personas: number
  personaTraits: number
  clients: number
  groupRules: number
  subjects: number
  identities: number
  conversations: number
  vaultConnections: number
  credentials: number
  entries: { entry: number; fact: number; episode: number; secret: number }
  legacyUris: number
  settings: number
  skippedApiKeys: number
  skippedDeletedMemories: number
  skippedDeletedCredentials: number
  warnings: string[]
}

export interface LegacyMigrationPlan {
  mode: 'instance' | 'space-export'
  sourceVersion: string
  accounts: PlannedAccount[]
  sharedCircles: PlannedSharedCircle[]
  personas: PlannedPersona[]
  personaTraits: PlannedPersonaTrait[]
  clients: PlannedClient[]
  groupRules: PlannedGroupRule[]
  subjects: PlannedSubject[]
  identities: PlannedIdentity[]
  conversations: PlannedConversation[]
  vaultConnections: PlannedVaultConnection[]
  credentials: PlannedCredential[]
  entries: PlannedEntry[]
  settings: { key: string; value: unknown; updatedAt: Date }[]
  warnings: string[]
  summary: LegacyMigrationPlanSummary
}

export interface PlanLegacyOptions {
  legacyMasterKey?: MasterKey | null
  targetMasterKey?: MasterKey | null
  accountUsername?: string
  circleName?: string
}

export interface LegacyMigrationResult {
  summary: LegacyMigrationPlanSummary
  allocatedShortIds: number
}

async function resolveSpaceExportTarget(
  db: Db,
  username?: string,
): Promise<{
  account: { id: string; username: string; displayName: string }
  personalCircleId: string
  personalCircleSlug: string
  personalCircleName: string
}> {
  const rows = username
    ? await db
        .select({
          id: accounts.id,
          username: accounts.username,
          displayName: accounts.displayName,
        })
        .from(accounts)
        .where(eq(accounts.username, username))
    : await db
        .select({
          id: accounts.id,
          username: accounts.username,
          displayName: accounts.displayName,
        })
        .from(accounts)
  if (!rows.length) {
    throw new Error(
      username ? `找不到目标账号 ${username}` : '目标数据库还没有账号，请先初始化后再导入空间文件',
    )
  }
  if (rows.length > 1) {
    throw new Error('目标实例有多个账号，请通过 --account 指定导入到哪个账号名下')
  }
  const account = rows[0]!
  const [personal] = await db
    .select({ id: circles.id, slug: circles.slug, name: circles.name })
    .from(circles)
    .where(and(eq(circles.kind, 'personal'), eq(circles.ownerAccountId, account.id)))
    .limit(1)
  if (!personal) {
    throw new Error(`账号 ${account.username} 缺少个人圈，无法导入`)
  }
  return {
    account,
    personalCircleId: personal.id,
    personalCircleSlug: personal.slug,
    personalCircleName: personal.name,
  }
}

export async function planLegacyMigration(
  db: Db,
  snapshot: LegacySnapshot,
  options: PlanLegacyOptions = {},
): Promise<LegacyMigrationPlan> {
  const legacyMasterKey = options.legacyMasterKey ?? options.targetMasterKey ?? null
  const targetMasterKey = options.targetMasterKey ?? null
  const warnings: string[] = []

  if (snapshot.mode === 'instance') {
    await assertUninitialized(db)
  }

  const takenCircleSlugs = new Set<string>()
  const plannedAccounts: PlannedAccount[] = []
  const accountById = new Map<string, PlannedAccount>()

  if (snapshot.mode === 'instance') {
    if (!snapshot.accounts.length) {
      throw new Error('旧版全实例源中没有账号记录')
    }
    for (const acc of snapshot.accounts) {
      const slug = allocateSuffixId(`me-${acc.username}`, takenCircleSlugs, 63, SLUG_PATTERN)
      const planned: PlannedAccount = {
        ...acc,
        personalCircleId: randomUUID(),
        personalCircleSlug: slug,
        personalCircleName: `${acc.displayName}的个人圈`,
        createAccount: true,
      }
      plannedAccounts.push(planned)
      accountById.set(acc.id, planned)
    }
  } else {
    const existingSlugs = await db.select({ slug: circles.slug }).from(circles)
    for (const s of existingSlugs) takenCircleSlugs.add(s.slug)
    const target = await resolveSpaceExportTarget(db, options.accountUsername)
    const planned: PlannedAccount = {
      id: target.account.id,
      username: target.account.username,
      displayName: target.account.displayName,
      passwordHash: null,
      isAdmin: false,
      disabledAt: null,
      createdAt: new Date(),
      personalCircleId: target.personalCircleId,
      personalCircleSlug: target.personalCircleSlug,
      personalCircleName: target.personalCircleName,
      createAccount: false,
    }
    plannedAccounts.push(planned)
    accountById.set(target.account.id, planned)
  }

  // 1. 共享记忆圈与成员
  const plannedSharedCircles: PlannedSharedCircle[] = []
  const sharedBySpaceId = new Map<string, PlannedSharedCircle>()
  const primaryOwnerBySpaceId = new Map<string, string>()

  for (const space of snapshot.spaces) {
    const circleId = randomUUID()
    const circleName =
      snapshot.mode === 'space-export' && options.circleName?.trim()
        ? options.circleName.trim().slice(0, 64)
        : space.name
    const circleSlug = allocateSuffixId(
      circleName,
      takenCircleSlugs,
      63,
      /^[a-z0-9][a-z0-9-]{0,62}$/,
    )

    const members =
      snapshot.mode === 'instance'
        ? snapshot.members
            .filter((m) => m.spaceId === space.id && accountById.has(m.accountId))
            .map((m) => ({
              accountId: m.accountId,
              role: m.role,
              dreamPrivate: m.dreamPrivate,
              createdAt: m.createdAt,
            }))
        : [
            {
              accountId: plannedAccounts[0]!.id,
              role: 'owner' as const,
              dreamPrivate: snapshot.exporter?.dreamPrivate ?? true,
              createdAt: new Date(),
            },
          ]

    const fallbackOwner =
      members.find((m) => m.role === 'owner')?.accountId ??
      members[0]?.accountId ??
      plannedAccounts[0]!.id
    primaryOwnerBySpaceId.set(space.id, fallbackOwner)

    const circle: PlannedSharedCircle = {
      id: circleId,
      legacySpaceId: space.id,
      slug: circleSlug,
      name: circleName,
      extractionMonthlyTokens: space.extractionMonthlyTokens,
      extractionDailyWrites: space.extractionDailyWrites,
      advanced: space.advanced,
      privacy: space.privacy,
      privacyRevision: space.privacyRevision,
      createdAt: space.createdAt,
      members,
    }
    plannedSharedCircles.push(circle)
    sharedBySpaceId.set(space.id, circle)
  }

  if (snapshot.skippedApiKeys > 0) {
    warnings.push(
      `已跳过 ${snapshot.skippedApiKeys} 个旧版访问密钥；迁移完成后请在管理界面重新签发透镜访问密钥`,
    )
  }

  // 2. 设置项（仅全实例模式）：先解密再重封，提前暴露主密钥不匹配
  const plannedSettings: { key: string; value: unknown; updatedAt: Date }[] = []
  if (snapshot.mode === 'instance') {
    for (const s of snapshot.settings) {
      if (s.key === 'backup') {
        warnings.push(
          '已跳过旧版 backup（对象存储备份）设置，避免覆盖或误删旧实例备份；请迁移后重新配置',
        )
        continue
      }
      const next = transformSettingForTarget(s, legacyMasterKey, targetMasterKey)
      if (next) plannedSettings.push(next)
    }
  }

  // 3. 独立人格（先父后子拓扑排序）
  const { ordered: sortedPersonas, brokenParents } = topoSortPersonas(snapshot.personas)
  const personaIdMap = new Map<string, string>()
  const plannedPersonas: PlannedPersona[] = []
  const usedPersonaSlugsByCircle = new Map<string, Set<string>>()

  for (const p of sortedPersonas) {
    const circle = sharedBySpaceId.get(p.spaceId)
    if (!circle) continue
    const nextId = randomUUID()
    personaIdMap.set(p.id, nextId)
  }
  for (const p of sortedPersonas) {
    const circle = sharedBySpaceId.get(p.spaceId)
    if (!circle) continue
    let usedSlugs = usedPersonaSlugsByCircle.get(circle.id)
    if (!usedSlugs) {
      usedSlugs = new Set()
      usedPersonaSlugsByCircle.set(circle.id, usedSlugs)
    }
    const slug = allocateSuffixId(p.slug, usedSlugs, 63, /^[a-z0-9][a-z0-9-]{0,62}$/)
    const broken = brokenParents.has(p.id)
    if (broken) {
      warnings.push(`人格 ${p.name}（${p.slug}）的继承链存在异常，已断开继承关系迁入`)
    }
    plannedPersonas.push({
      id: personaIdMap.get(p.id)!,
      circleId: circle.id,
      legacySpaceId: p.spaceId,
      slug,
      name: p.name.slice(0, 64),
      extendsId: !broken && p.extendsId ? (personaIdMap.get(p.extendsId) ?? null) : null,
      description: p.description ? p.description.slice(0, 500) : null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })
  }

  // 4. 接入实例（clients）
  const appIdToClientId = new Map<string, string>()
  const clientById = new Map<string, PlannedClient>()
  const plannedClients: PlannedClient[] = []
  const usedClientSlugsByCircle = new Map<string, Set<string>>()

  for (const app of snapshot.apps) {
    const circle = sharedBySpaceId.get(app.spaceId)
    if (!circle) continue
    let usedSlugs = usedClientSlugsByCircle.get(circle.id)
    if (!usedSlugs) {
      usedSlugs = new Set()
      usedClientSlugsByCircle.set(circle.id, usedSlugs)
    }
    const slug = allocateSuffixId(app.slug, usedSlugs, 63, /^[a-z0-9][a-z0-9-]{0,62}$/)
    const ownerId =
      (app.ownerAccountId && accountById.has(app.ownerAccountId) ? app.ownerAccountId : null) ??
      primaryOwnerBySpaceId.get(app.spaceId)!

    const rawConfig = asObject(app.config)
    const parsedConfig = ClientConfig.safeParse({
      personMemoryMode: 'strict',
      ...(rawConfig.elevateOwnerDirect === 'internal' ? { elevateOwnerDirect: 'internal' } : {}),
      ...(typeof rawConfig.recordPrompt === 'boolean'
        ? { recordPrompt: rawConfig.recordPrompt }
        : {}),
    })
    const clientConfig: Record<string, unknown> = parsedConfig.success
      ? { ...parsedConfig.data }
      : { personMemoryMode: 'strict' }
    if (rawConfig[CLIENT_ADVANCED_FIELD]) {
      const adv = ClientAdvanced.safeParse(rawConfig[CLIENT_ADVANCED_FIELD])
      if (adv.success && Object.keys(adv.data).length > 0) {
        clientConfig[CLIENT_ADVANCED_FIELD] = adv.data
      }
    }

    const nextClient: PlannedClient = {
      id: randomUUID(),
      circleId: circle.id,
      legacySpaceId: app.spaceId,
      slug,
      name: app.name.slice(0, 64),
      runtimeFamily: (RUNTIME_FAMILIES as readonly string[]).includes(app.runtimeFamily)
        ? app.runtimeFamily
        : 'other',
      ownerAccountId: ownerId,
      defaultPersonaId: app.defaultPersonaId
        ? (personaIdMap.get(app.defaultPersonaId) ?? null)
        : null,
      config: clientConfig as ClientConfig,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    }
    appIdToClientId.set(app.id, nextClient.id)
    clientById.set(nextClient.id, nextClient)
    plannedClients.push(nextClient)
  }

  // 5. 联系人与身份与群人格规则
  const subjectIdMap = new Map<string, string>()
  const subjectKindMap = new Map<string, SubjectKind>()
  const plannedSubjects: PlannedSubject[] = []
  for (const subj of snapshot.subjects) {
    const circle = sharedBySpaceId.get(subj.spaceId)
    if (!circle) continue
    const nextId = randomUUID()
    subjectIdMap.set(subj.id, nextId)
    subjectKindMap.set(nextId, subj.kind)
    let mappedAccountId: string | null = null
    if (snapshot.mode === 'instance') {
      mappedAccountId = subj.accountId && accountById.has(subj.accountId) ? subj.accountId : null
    } else if (subj.linkedToExporter) {
      mappedAccountId = plannedAccounts[0]!.id
    }
    plannedSubjects.push({
      id: nextId,
      circleId: circle.id,
      kind: subj.kind,
      displayName: subj.displayName,
      nameLocked: subj.nameLocked,
      accountId: mappedAccountId,
      createdAt: subj.createdAt,
      updatedAt: subj.updatedAt,
    })
  }

  const plannedIdentities: PlannedIdentity[] = []
  const seenIdentity = new Set<string>()
  for (const iden of snapshot.identities) {
    const circle = sharedBySpaceId.get(iden.spaceId)
    const nextSubjId = subjectIdMap.get(iden.subjectId)
    if (!circle || !nextSubjId) continue
    const dedupeKey = `${circle.id}\0${iden.platform}\0${iden.kind}\0${iden.externalId}`
    if (seenIdentity.has(dedupeKey)) continue
    seenIdentity.add(dedupeKey)
    plannedIdentities.push({
      id: randomUUID(),
      circleId: circle.id,
      subjectId: nextSubjId,
      kind: subjectKindMap.get(nextSubjId)!,
      platform: iden.platform,
      externalId: iden.externalId,
      displayName: iden.displayName,
      createdAt: iden.createdAt,
    })
  }

  const plannedGroupRules: PlannedGroupRule[] = []
  const seenRule = new Set<string>()
  for (const gp of snapshot.groupPersonas) {
    const circle = sharedBySpaceId.get(gp.spaceId)
    const nextClientId = appIdToClientId.get(gp.appId)
    const nextGroupId = subjectIdMap.get(gp.subjectId)
    const nextPersonaId = personaIdMap.get(gp.personaId) ?? null
    if (!circle || !nextClientId || !nextGroupId || !nextPersonaId) continue
    const key = `${nextClientId}\0${nextGroupId}`
    if (seenRule.has(key)) continue
    seenRule.add(key)
    plannedGroupRules.push({
      circleId: circle.id,
      clientId: nextClientId,
      groupSubjectId: nextGroupId,
      personaId: nextPersonaId,
      createdAt: gp.createdAt,
    })
  }

  // 6. 会话（保证唯一约束与 kind 形态）
  const conversationIdMap = new Map<string, string>()
  const conversationById = new Map<string, PlannedConversation>()
  const conversationClientMap = new Map<string, string>()
  const plannedConversations: PlannedConversation[] = []
  const seenSubjectConv = new Map<string, string>()
  const seenNoneConv = new Map<string, string>()

  for (const conv of snapshot.conversations) {
    const circle = sharedBySpaceId.get(conv.spaceId)
    const clientId = appIdToClientId.get(conv.appId)
    if (!circle || !clientId) continue

    if (conv.kind === 'none') {
      const ownerId =
        (conv.ownerAccountId && accountById.has(conv.ownerAccountId)
          ? conv.ownerAccountId
          : null) ?? clientById.get(clientId)!.ownerAccountId
      const key = `${clientId}\0${ownerId}\0\0`
      const existingId = seenNoneConv.get(key)
      if (existingId) {
        conversationIdMap.set(conv.id, existingId)
        continue
      }
      const nextId = randomUUID()
      seenNoneConv.set(key, nextId)
      conversationIdMap.set(conv.id, nextId)
      conversationClientMap.set(nextId, clientId)
      const planned: PlannedConversation = {
        id: nextId,
        circleId: circle.id,
        clientId,
        kind: 'none',
        deviceKey: '',
        projectSlug: '',
        subjectId: null,
        ownerAccountId: ownerId,
        createdAt: conv.createdAt,
        lastActiveAt: conv.lastActiveAt,
      }
      conversationById.set(nextId, planned)
      plannedConversations.push(planned)
    } else {
      const subjectId = conv.subjectId ? (subjectIdMap.get(conv.subjectId) ?? null) : null
      if (!subjectId) continue
      const key = `${clientId}\0${subjectId}`
      const existingId = seenSubjectConv.get(key)
      if (existingId) {
        conversationIdMap.set(conv.id, existingId)
        continue
      }
      const nextId = randomUUID()
      seenSubjectConv.set(key, nextId)
      conversationIdMap.set(conv.id, nextId)
      conversationClientMap.set(nextId, clientId)
      const planned: PlannedConversation = {
        id: nextId,
        circleId: circle.id,
        clientId,
        kind: conv.kind,
        deviceKey: '',
        projectSlug: '',
        subjectId,
        ownerAccountId: null,
        createdAt: conv.createdAt,
        lastActiveAt: conv.lastActiveAt,
      }
      conversationById.set(nextId, planned)
      plannedConversations.push(planned)
    }
  }

  // 7. 密码库连接与凭据（全部落入所属账号唯一个人圈并去重与重映射占位符）
  const vaultConnIdMap = new Map<string, string>()
  const vaultKeyByOwnerAccount = new Map<string, Map<string, string>>()
  const ownerHasDestination = new Set<string>()
  const plannedVaults: PlannedVaultConnection[] = []

  if (snapshot.mode === 'space-export') {
    const personalId = plannedAccounts[0]!.personalCircleId
    const accountId = plannedAccounts[0]!.id
    const existingVaults = await withCircles(
      db,
      { read: [personalId] },
      (rTx) =>
        rTx
          .select({
            id: vaultConnections.id,
            serverUrl: vaultConnections.serverUrl,
            vaultUserId: vaultConnections.vaultUserId,
            defaultCollectionId: vaultConnections.defaultCollectionId,
          })
          .from(vaultConnections)
          .where(eq(vaultConnections.circleId, personalId)),
      { accessMode: 'read only' },
    )
    const byKey = new Map<string, string>()
    for (const ev of existingVaults) {
      byKey.set(`${ev.serverUrl}\0${ev.vaultUserId}`, ev.id)
      if (ev.defaultCollectionId) ownerHasDestination.add(accountId)
    }
    vaultKeyByOwnerAccount.set(accountId, byKey)
  }

  // 先优先迁入非断开连接，避免跨空间去重时被断开的占先
  const sortedVaults = [...snapshot.vaultConnections].sort((a, b) => {
    const aActive = a.status !== 'disconnected' ? 0 : 1
    const bActive = b.status !== 'disconnected' ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    return b.updatedAt.getTime() - a.updatedAt.getTime()
  })

  for (const v of sortedVaults) {
    const ownerAccount =
      v.ownerAccountId && accountById.has(v.ownerAccountId)
        ? accountById.get(v.ownerAccountId)!
        : plannedAccounts[0]!

    let byKey = vaultKeyByOwnerAccount.get(ownerAccount.id)
    if (!byKey) {
      byKey = new Map()
      vaultKeyByOwnerAccount.set(ownerAccount.id, byKey)
    }
    const dedupeKey = `${v.serverUrl}\0${v.vaultUserId}`
    const existingConnId = byKey.get(dedupeKey)
    if (existingConnId) {
      vaultConnIdMap.set(v.id, existingConnId)
      continue
    }

    const secrets = decryptLegacyVaultSecrets(v, legacyMasterKey)
    if (secrets && !targetMasterKey) {
      throw new Error('旧数据含已登录的密码库连接，目标实例必须配置 KIOKU_MASTER_KEY')
    }

    let keepDestination = Boolean(
      v.defaultCollectionId && v.defaultOrganizationId && v.defaultCollectionName !== null,
    )
    if (keepDestination && ownerHasDestination.has(ownerAccount.id)) {
      keepDestination = false
      warnings.push(
        `账号 ${ownerAccount.username} 跨空间迁入多个密码库连接去处，仅保留首个连接的集合设置（其余保留连接但清空默认集合）`,
      )
    }
    if (keepDestination) ownerHasDestination.add(ownerAccount.id)

    const nextId = randomUUID()
    byKey.set(dedupeKey, nextId)
    vaultConnIdMap.set(v.id, nextId)

    const isDisconnected = !secrets || v.status === 'disconnected'
    plannedVaults.push({
      id: nextId,
      circleId: ownerAccount.personalCircleId,
      ownerAccountId: ownerAccount.id,
      serverUrl: v.serverUrl,
      email: v.email,
      vaultUserId: v.vaultUserId,
      deviceId: v.deviceId,
      secrets: isDisconnected ? null : secrets,
      status: isDisconnected ? 'disconnected' : v.status,
      disabledReason: isDisconnected ? null : v.status === 'disabled' ? v.disabledReason : null,
      lastErrorKind: !isDisconnected && v.lastErrorKind && v.lastErrorAt ? v.lastErrorKind : null,
      lastErrorAt: !isDisconnected && v.lastErrorKind && v.lastErrorAt ? v.lastErrorAt : null,
      lastCheckedAt: v.lastCheckedAt,
      defaultCollectionId: keepDestination ? v.defaultCollectionId : null,
      defaultOrganizationId: keepDestination ? v.defaultOrganizationId : null,
      defaultCollectionName: keepDestination ? v.defaultCollectionName : null,
      disconnectedAt: isDisconnected ? (v.disconnectedAt ?? v.updatedAt) : null,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    })
  }

  const takenCredIdsByOwner = new Map<string, Set<string>>()
  const vaultItemCredByOwner = new Map<string, Map<string, string>>()
  const credRenameBySpaceOwner = new Map<string, Map<string, string>>()

  if (snapshot.mode === 'space-export') {
    const accountId = plannedAccounts[0]!.id
    const personalId = plannedAccounts[0]!.personalCircleId
    const existingCreds = await withCircles(
      db,
      { read: [personalId] },
      (rTx) =>
        rTx
          .select({
            identifier: credentials.identifier,
            vaultConnectionId: credentials.vaultConnectionId,
            vaultItemId: credentials.vaultItemId,
          })
          .from(credentials)
          .where(and(eq(credentials.circleId, personalId), isNull(credentials.deletedAt))),
      { accessMode: 'read only' },
    )
    const taken = new Set<string>()
    const vaultMap = new Map<string, string>()
    for (const c of existingCreds) {
      taken.add(c.identifier)
      if (c.vaultConnectionId && c.vaultItemId) {
        vaultMap.set(`${c.vaultConnectionId}\0${c.vaultItemId}`, c.identifier)
      }
    }
    takenCredIdsByOwner.set(accountId, taken)
    vaultItemCredByOwner.set(accountId, vaultMap)
  }

  const plannedCredentials: PlannedCredential[] = []
  for (const cred of snapshot.credentials) {
    const ownerAccount =
      cred.ownerAccountId && accountById.has(cred.ownerAccountId)
        ? accountById.get(cred.ownerAccountId)!
        : plannedAccounts[0]!

    let taken = takenCredIdsByOwner.get(ownerAccount.id)
    if (!taken) {
      taken = new Set()
      takenCredIdsByOwner.set(ownerAccount.id, taken)
    }
    let vaultItems = vaultItemCredByOwner.get(ownerAccount.id)
    if (!vaultItems) {
      vaultItems = new Map()
      vaultItemCredByOwner.set(ownerAccount.id, vaultItems)
    }

    const mappedVaultConnId =
      cred.source === 'vault' && cred.vaultConnectionId
        ? (vaultConnIdMap.get(cred.vaultConnectionId) ?? null)
        : null
    if (cred.source === 'vault' && (!mappedVaultConnId || !cred.vaultItemId)) {
      warnings.push(`凭据 ${cred.identifier} 关联的密码库连接缺失，已跳过`)
      continue
    }

    let renameMap = credRenameBySpaceOwner.get(`${cred.spaceId}\0${ownerAccount.id}`)
    if (!renameMap) {
      renameMap = new Map()
      credRenameBySpaceOwner.set(`${cred.spaceId}\0${ownerAccount.id}`, renameMap)
    }

    if (cred.source === 'vault' && mappedVaultConnId && cred.vaultItemId) {
      const existingIdent = vaultItems.get(`${mappedVaultConnId}\0${cred.vaultItemId}`)
      if (existingIdent) {
        if (existingIdent !== cred.identifier) {
          renameMap.set(cred.identifier, existingIdent)
          warnings.push(
            `密码库条目凭据 ${cred.identifier} 与已存在凭据 ${existingIdent} 指向同一条目，已合并并重写占位符`,
          )
        }
        continue
      }
    }

    const plainValues =
      cred.source === 'hosted' ? decryptLegacyCredentialValues(cred, legacyMasterKey) : null
    if (cred.source === 'hosted' && !targetMasterKey) {
      throw new Error('旧数据含托管凭据，目标实例必须配置 KIOKU_MASTER_KEY')
    }

    const nextIdentifier = allocateSuffixId(
      cred.identifier,
      taken,
      64,
      CREDENTIAL_NAME_PATTERN,
      true,
    )
    if (nextIdentifier !== cred.identifier) {
      renameMap.set(cred.identifier, nextIdentifier)
      warnings.push(
        `账号 ${ownerAccount.username} 的凭据标识 ${cred.identifier} 在个人圈中发生命名冲突，已自动重命名为 ${nextIdentifier} 并重写对应记忆占位符`,
      )
    }
    if (cred.source === 'vault' && mappedVaultConnId && cred.vaultItemId) {
      vaultItems.set(`${mappedVaultConnId}\0${cred.vaultItemId}`, nextIdentifier)
    }

    const mappedClientIds =
      cred.appIds === null
        ? null
        : cred.appIds.map((id) => appIdToClientId.get(id)).filter((id): id is string => Boolean(id))

    plannedCredentials.push({
      id: randomUUID(),
      circleId: ownerAccount.personalCircleId,
      ownerAccountId: ownerAccount.id,
      identifier: nextIdentifier,
      originalIdentifier: cred.identifier,
      name: cred.name.slice(0, 100),
      description: cred.description ? cred.description.slice(0, 2000) : null,
      source: cred.source,
      plainValues,
      vaultConnectionId: mappedVaultConnId,
      vaultItemId: cred.source === 'vault' ? cred.vaultItemId : null,
      fields: cred.fields,
      clientIds: mappedClientIds,
      version: cred.version,
      expiresAt: cred.expiresAt,
      rotationRequestedAt: cred.rotationRequestedAt,
      valueVersion: cred.valueVersion,
      valueChangedAt: cred.valueChangedAt,
      vaultRevision: cred.vaultRevision,
      createdAt: cred.createdAt,
      updatedAt: cred.updatedAt,
    })
  }

  // 8. 记忆转换：persona -> persona_traits，其余按归属分流至个人圈/共享圈
  const plannedTraits: PlannedPersonaTrait[] = []
  const usedTraitKeysByPersona = new Map<string, Set<string>>()
  const plannedEntries: PlannedEntry[] = []

  const counts = { entry: 0, fact: 0, episode: 0, secret: 0 }
  let legacyUriCount = 0

  for (const mem of snapshot.memories) {
    const sharedCircle = sharedBySpaceId.get(mem.spaceId)
    if (!sharedCircle) continue

    const plaintext = decryptLegacyMemoryContent(mem, legacyMasterKey)
    if (mem.sensitivity === 'secret' && !targetMasterKey) {
      throw new Error('旧数据含机密记忆，目标实例必须配置 KIOKU_MASTER_KEY')
    }

    // 8a. persona 层写入 persona_traits；若标为 secret，出于安全改入所有者个人圈机密 entry
    if (mem.layer === 'persona') {
      const targetPersonaId = mem.personaId ? (personaIdMap.get(mem.personaId) ?? null) : null
      if (mem.sensitivity !== 'secret' && targetPersonaId) {
        const parsed = mem.uri ? parseUri(mem.uri) : null
        const slash = parsed ? parsed.path.indexOf('/') : -1
        const rawRest = slash >= 0 ? parsed!.path.slice(slash + 1) : (parsed?.path ?? 'trait')
        let usedKeys = usedTraitKeysByPersona.get(targetPersonaId)
        if (!usedKeys) {
          usedKeys = new Set()
          usedTraitKeysByPersona.set(targetPersonaId, usedKeys)
        }
        const traitKey = allocateSuffixId(
          normalizeTraitKey(rawRest),
          usedKeys,
          64,
          TRAIT_KEY_PATTERN,
          true,
        )
        const title = (mem.title?.trim() || rawRest).slice(0, 120)
        plannedTraits.push({
          circleId: sharedCircle.id,
          personaId: targetPersonaId,
          traitKey,
          title,
          content: plaintext,
          sortOrder: plannedTraits.filter((t) => t.personaId === targetPersonaId).length,
          updatedAt: mem.updatedAt,
          legacyUri: mem.uri ?? `persona://${traitKey}`,
        })
        continue
      }

      // 机密人格片段或孤立人格记忆降落为安全 entry
      const ownerAccount = accountById.get(primaryOwnerBySpaceId.get(mem.spaceId)!)!
      const fallbackName = mem.uri?.split('/').pop()?.slice(0, ENTRY_TITLE_MAX) || '未命名人格'
      const explicitTitle = mem.title?.trim() ? mem.title.trim().slice(0, ENTRY_TITLE_MAX) : null
      const provenance: Provenance = mem.provenance === 'untrusted' ? 'agent' : mem.provenance
      const sens: Sensitivity =
        mem.sensitivity === 'secret'
          ? 'secret'
          : mem.sensitivity === 'public'
            ? 'internal'
            : mem.sensitivity
      const when: WhenCondition = {}
      const sig = whenSignature(when)
      if (mem.sensitivity === 'secret') counts.secret++
      counts.entry++
      if (mem.uri) legacyUriCount++
      warnings.push(
        `人格记忆 ${mem.uri ?? mem.id} 因标为机密或缺少关联人格，已安全迁入 ${ownerAccount.username} 的个人圈正式词条`,
      )
      plannedEntries.push({
        id: randomUUID(),
        circleId: ownerAccount.personalCircleId,
        circleKind: 'personal',
        circleName: ownerAccount.personalCircleName,
        kind: 'entry',
        explicitTitle,
        titleFallback: sens === 'secret' ? null : fallbackName,
        sensitivity: sens,
        provenance,
        originScope: 'global',
        clientId: null,
        ownerAccountId: ownerAccount.id,
        subjectId: null,
        subjectKind: null,
        conversationId: null,
        realms: [],
        topics: extractTopicTags(mem.uri, true),
        priority: mem.priority,
        disclosure: mem.disclosure ? mem.disclosure.slice(0, DISCLOSURE_MAX) : null,
        glossary: [...new Set(mem.glossary)].slice(0, GLOSSARY_MAX),
        validFrom: mem.validFrom,
        validTo: mem.validTo,
        expiresAt: mem.expiresAt,
        legacyVersion: mem.version,
        createdAt: mem.createdAt,
        updatedAt: mem.updatedAt,
        when,
        whenSignature: sig,
        plaintext,
        plaintextIgnoredHash: mem.sensitivity === 'secret' ? null : mem.plaintextIgnoredHash,
        sensitiveRevision: mem.sensitivity === 'secret' ? 0 : mem.sensitiveRevision,
        sensitiveCredential: mem.sensitivity === 'secret' ? false : mem.sensitiveCredential,
        sensitivePii: mem.sensitivity === 'secret' ? false : mem.sensitivePii,
        sensitiveFindings: mem.sensitivity === 'secret' ? [] : mem.sensitiveFindings,
        legacyUri: mem.uri,
        runtimeFacetSlug: null,
      })
      continue
    }

    // 8b. user:// 迁入所有者个人圈
    if (mem.layer === 'user') {
      const ownerAccount =
        mem.ownerAccountId && accountById.has(mem.ownerAccountId)
          ? accountById.get(mem.ownerAccountId)!
          : (accountById.get(primaryOwnerBySpaceId.get(mem.spaceId)!) ?? plannedAccounts[0]!)
      const renameMap = credRenameBySpaceOwner.get(`${mem.spaceId}\0${ownerAccount.id}`)
      const rewrittenText = renameMap ? rewritePlaceholders(plaintext, renameMap) : plaintext
      const placeholderChanged = rewrittenText !== plaintext
      const provenance: Provenance = mem.provenance === 'untrusted' ? 'owner' : mem.provenance
      const fallbackName = mem.uri?.split('/').pop()?.slice(0, ENTRY_TITLE_MAX) || '未命名记忆'
      const explicitTitle = mem.title?.trim() ? mem.title.trim().slice(0, ENTRY_TITLE_MAX) : null
      const when: WhenCondition = {}
      const sig = whenSignature(when)
      counts.entry++
      if (mem.sensitivity === 'secret') counts.secret++
      if (mem.uri) legacyUriCount++
      plannedEntries.push({
        id: randomUUID(),
        circleId: ownerAccount.personalCircleId,
        circleKind: 'personal',
        circleName: ownerAccount.personalCircleName,
        kind: 'entry',
        explicitTitle,
        titleFallback: mem.sensitivity === 'secret' ? null : fallbackName,
        sensitivity: mem.sensitivity,
        provenance,
        originScope: 'global',
        clientId: null,
        ownerAccountId: ownerAccount.id,
        subjectId: null,
        subjectKind: null,
        conversationId: null,
        realms: [],
        topics: extractTopicTags(mem.uri, false),
        priority: mem.priority,
        disclosure: mem.disclosure ? mem.disclosure.slice(0, DISCLOSURE_MAX) : null,
        glossary: [...new Set(mem.glossary)].slice(0, GLOSSARY_MAX),
        validFrom: mem.validFrom,
        validTo: mem.validTo,
        expiresAt: mem.expiresAt,
        legacyVersion: mem.version,
        createdAt: mem.createdAt,
        updatedAt: mem.updatedAt,
        when,
        whenSignature: sig,
        plaintext: rewrittenText,
        plaintextIgnoredHash:
          mem.sensitivity === 'secret' || placeholderChanged ? null : mem.plaintextIgnoredHash,
        sensitiveRevision: mem.sensitivity === 'secret' ? 0 : mem.sensitiveRevision,
        sensitiveCredential: mem.sensitivity === 'secret' ? false : mem.sensitiveCredential,
        sensitivePii: mem.sensitivity === 'secret' ? false : mem.sensitivePii,
        sensitiveFindings: mem.sensitivity === 'secret' ? [] : mem.sensitiveFindings,
        legacyUri: mem.uri,
        runtimeFacetSlug: null,
      })
      continue
    }

    // 8c. core / app 迁入共享圈 entry
    if (mem.layer === 'core' || mem.layer === 'app') {
      let provenance = mem.provenance
      if (provenance === 'untrusted') {
        provenance = 'agent'
        warnings.push(`正式词条 ${mem.uri ?? mem.id} 来源为未确认来源，已按规则调整为 agent`)
      }
      const mappedClientId =
        mem.layer === 'app' && mem.appId ? (appIdToClientId.get(mem.appId) ?? null) : null
      const matchedClient = mappedClientId ? clientById.get(mappedClientId) : undefined
      const parsed = mem.uri ? parseUri(mem.uri) : null
      const runtimeSlug =
        mem.layer === 'app'
          ? normalizeRuntimeSlug(
              matchedClient?.runtimeFamily ?? 'other',
              matchedClient?.slug ?? parsed?.namespaceSlug ?? 'other',
            )
          : null
      const when: WhenCondition = runtimeSlug ? { runtime: [runtimeSlug] } : {}
      const sig = whenSignature(when)
      const fallbackName = mem.uri?.split('/').pop()?.slice(0, ENTRY_TITLE_MAX) || '未命名记忆'
      const explicitTitle = mem.title?.trim() ? mem.title.trim().slice(0, ENTRY_TITLE_MAX) : null

      counts.entry++
      if (mem.sensitivity === 'secret') counts.secret++
      if (mem.uri) legacyUriCount++
      plannedEntries.push({
        id: randomUUID(),
        circleId: sharedCircle.id,
        circleKind: 'shared',
        circleName: sharedCircle.name,
        kind: 'entry',
        explicitTitle,
        titleFallback: mem.sensitivity === 'secret' ? null : fallbackName,
        sensitivity: mem.sensitivity,
        provenance,
        originScope: remapOriginScope(mem.originScope, appIdToClientId, subjectIdMap),
        clientId: mappedClientId,
        ownerAccountId: null,
        subjectId: null,
        subjectKind: null,
        conversationId: null,
        realms: [],
        topics: extractTopicTags(mem.uri, mem.layer === 'app'),
        priority: mem.priority,
        disclosure: mem.disclosure ? mem.disclosure.slice(0, DISCLOSURE_MAX) : null,
        glossary: [...new Set(mem.glossary)].slice(0, GLOSSARY_MAX),
        validFrom: mem.validFrom,
        validTo: mem.validTo,
        expiresAt: mem.expiresAt,
        legacyVersion: mem.version,
        createdAt: mem.createdAt,
        updatedAt: mem.updatedAt,
        when,
        whenSignature: sig,
        plaintext,
        plaintextIgnoredHash: mem.sensitivity === 'secret' ? null : mem.plaintextIgnoredHash,
        sensitiveRevision: mem.sensitivity === 'secret' ? 0 : mem.sensitiveRevision,
        sensitiveCredential: mem.sensitivity === 'secret' ? false : mem.sensitiveCredential,
        sensitivePii: mem.sensitivity === 'secret' ? false : mem.sensitivePii,
        sensitiveFindings: mem.sensitivity === 'secret' ? [] : mem.sensitiveFindings,
        legacyUri: mem.uri,
        runtimeFacetSlug: runtimeSlug,
      })
      continue
    }

    // 8d. subject 事实 -> kind = 'fact'
    if (mem.layer === 'subject') {
      const nextSubjectId = mem.subjectId ? (subjectIdMap.get(mem.subjectId) ?? null) : null
      const nextSubjectKind = nextSubjectId ? (subjectKindMap.get(nextSubjectId) ?? null) : null
      if (!nextSubjectId || !nextSubjectKind) {
        warnings.push(`联系人事实 ${mem.id} 缺少对应联系人，已跳过`)
        continue
      }
      const nextConvId = mem.conversationId
        ? (conversationIdMap.get(mem.conversationId) ?? null)
        : null
      let clientId = nextConvId ? (conversationClientMap.get(nextConvId) ?? null) : null
      if (!clientId && mem.appId) clientId = appIdToClientId.get(mem.appId) ?? null
      const sens: Sensitivity = !sensitivityAllowed(
        'shared',
        'fact',
        mem.sensitivity,
        mem.provenance,
      )
        ? 'private'
        : mem.sensitivity
      if (sens !== mem.sensitivity) {
        warnings.push(`未确认来源联系人事实 ${mem.id} 不能标为 secret，已降级为 private`)
      }
      const explicitTitle = mem.title?.trim() ? mem.title.trim().slice(0, ENTRY_TITLE_MAX) : null
      counts.fact++
      if (sens === 'secret') counts.secret++
      plannedEntries.push({
        id: randomUUID(),
        circleId: sharedCircle.id,
        circleKind: 'shared',
        circleName: sharedCircle.name,
        kind: 'fact',
        explicitTitle,
        titleFallback: sens === 'secret' ? null : '联系人事实',
        sensitivity: sens,
        provenance: mem.provenance,
        originScope: remapOriginScope(mem.originScope, appIdToClientId, subjectIdMap),
        clientId,
        ownerAccountId: null,
        subjectId: nextSubjectId,
        subjectKind: nextSubjectKind,
        conversationId: nextConvId,
        realms: [],
        topics: [],
        priority: mem.priority,
        disclosure: mem.disclosure ? mem.disclosure.slice(0, DISCLOSURE_MAX) : null,
        glossary: [...new Set(mem.glossary)].slice(0, GLOSSARY_MAX),
        validFrom: mem.validFrom,
        validTo: mem.validTo,
        expiresAt: mem.expiresAt,
        legacyVersion: mem.version,
        createdAt: mem.createdAt,
        updatedAt: mem.updatedAt,
        when: {},
        whenSignature: '{}',
        plaintext,
        plaintextIgnoredHash: sens === 'secret' ? null : mem.plaintextIgnoredHash,
        sensitiveRevision: sens === 'secret' ? 0 : mem.sensitiveRevision,
        sensitiveCredential: sens === 'secret' ? false : mem.sensitiveCredential,
        sensitivePii: sens === 'secret' ? false : mem.sensitivePii,
        sensitiveFindings: sens === 'secret' ? [] : mem.sensitiveFindings,
        legacyUri: null,
        runtimeFacetSlug: null,
      })
      continue
    }

    // 8e. episode 会话摘要 -> kind = 'episode'
    const nextConvId = mem.conversationId
      ? (conversationIdMap.get(mem.conversationId) ?? null)
      : null
    if (!nextConvId) {
      warnings.push(`会话摘要 ${mem.id} 缺少对应会话，已跳过`)
      continue
    }
    const clientId = conversationClientMap.get(nextConvId) ?? null
    const convObj = conversationById.get(nextConvId)
    const sens: Sensitivity = mem.sensitivity === 'secret' ? 'private' : mem.sensitivity
    if (sens !== mem.sensitivity) {
      warnings.push(`会话摘要 ${mem.id} 不能标为 secret，已降级为 private`)
    }
    const ownerAccountId =
      convObj?.kind === 'none'
        ? mem.ownerAccountId && accountById.has(mem.ownerAccountId)
          ? mem.ownerAccountId
          : convObj.ownerAccountId
        : null
    const explicitTitle = mem.title?.trim() ? mem.title.trim().slice(0, ENTRY_TITLE_MAX) : null
    counts.episode++
    plannedEntries.push({
      id: randomUUID(),
      circleId: sharedCircle.id,
      circleKind: 'shared',
      circleName: sharedCircle.name,
      kind: 'episode',
      explicitTitle,
      titleFallback: '会话摘要',
      sensitivity: sens,
      provenance: mem.provenance,
      originScope: remapOriginScope(mem.originScope, appIdToClientId, subjectIdMap),
      clientId,
      ownerAccountId,
      subjectId: null,
      subjectKind: null,
      conversationId: nextConvId,
      realms: [],
      topics: [],
      priority: Math.max(1, mem.priority),
      disclosure: mem.disclosure ? mem.disclosure.slice(0, DISCLOSURE_MAX) : null,
      glossary: [...new Set(mem.glossary)].slice(0, GLOSSARY_MAX),
      validFrom: mem.validFrom,
      validTo: mem.validTo,
      expiresAt: mem.expiresAt,
      legacyVersion: mem.version,
      createdAt: mem.createdAt,
      updatedAt: mem.updatedAt,
      when: {},
      whenSignature: '{}',
      plaintext,
      plaintextIgnoredHash: mem.plaintextIgnoredHash,
      sensitiveRevision: mem.sensitiveRevision,
      sensitiveCredential: mem.sensitiveCredential,
      sensitivePii: mem.sensitivePii,
      sensitiveFindings: mem.sensitiveFindings,
      legacyUri: null,
      runtimeFacetSlug: null,
    })
  }

  const summary: LegacyMigrationPlanSummary = {
    mode: snapshot.mode,
    sourceVersion: snapshot.sourceVersion,
    accounts: plannedAccounts.filter((a) => a.createAccount).length,
    personalCircles: plannedAccounts.filter((a) => a.createAccount).length,
    sharedCircles: plannedSharedCircles.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      memberCount: c.members.length,
    })),
    personas: plannedPersonas.length,
    personaTraits: plannedTraits.length,
    clients: plannedClients.length,
    groupRules: plannedGroupRules.length,
    subjects: plannedSubjects.length,
    identities: plannedIdentities.length,
    conversations: plannedConversations.length,
    vaultConnections: plannedVaults.length,
    credentials: plannedCredentials.length,
    entries: counts,
    legacyUris: legacyUriCount,
    settings: plannedSettings.length,
    skippedApiKeys: snapshot.skippedApiKeys,
    skippedDeletedMemories: snapshot.skippedDeletedMemories,
    skippedDeletedCredentials: snapshot.skippedDeletedCredentials,
    warnings,
  }

  return {
    mode: snapshot.mode,
    sourceVersion: snapshot.sourceVersion,
    accounts: plannedAccounts,
    sharedCircles: plannedSharedCircles,
    personas: plannedPersonas,
    personaTraits: plannedTraits,
    clients: plannedClients,
    groupRules: plannedGroupRules,
    subjects: plannedSubjects,
    identities: plannedIdentities,
    conversations: plannedConversations,
    vaultConnections: plannedVaults,
    credentials: plannedCredentials,
    entries: plannedEntries,
    settings: plannedSettings,
    warnings,
    summary,
  }
}

async function allocateFreshShortIds(
  tx: Tx,
  allCircleIds: readonly string[],
  count: number,
): Promise<string[]> {
  if (!count) return []
  const taken = new Set<string>()
  const allocated: string[] = []
  let round = 0
  while (allocated.length < count) {
    const needed = count - allocated.length
    const length = round < 4 ? 6 : round < 8 ? 7 : 8
    const candidates: string[] = []
    for (let i = 0; i < Math.max(needed * 2, 32); i++) {
      const id = generateShortId(length)
      if (!taken.has(id)) candidates.push(id)
    }
    if (allCircleIds.length) {
      await withCircles(
        tx,
        { read: allCircleIds },
        async (readTx) => {
          for (let i = 0; i < candidates.length; i += 500) {
            const chunk = candidates.slice(i, i + 500)
            const rows = await readTx
              .select({ shortId: entries.shortId })
              .from(entries)
              .where(inArray(entries.shortId, chunk))
            for (const r of rows) taken.add(r.shortId)
          }
        },
        { accessMode: 'read only' },
      )
    }
    for (const c of candidates) {
      if (allocated.length >= count) break
      if (taken.has(c)) continue
      taken.add(c)
      allocated.push(c)
    }
    round++
    if (round > 32) throw new Error('批量分配短 ID 重试次数已耗尽')
  }
  return allocated
}

export async function applyLegacyMigration(
  db: Db,
  plan: LegacyMigrationPlan,
  options: { targetMasterKey?: MasterKey | null } = {},
): Promise<LegacyMigrationResult> {
  const targetMasterKey = options.targetMasterKey ?? null
  if (
    (plan.summary.entries.secret > 0 ||
      plan.credentials.some((c) => c.source === 'hosted') ||
      plan.vaultConnections.some((v) => v.secrets !== null)) &&
    !targetMasterKey
  ) {
    throw new Error('迁移内容包含加密数据，必须配置目标实例的 KIOKU_MASTER_KEY')
  }

  const warnings = [...plan.warnings]
  const allocatedCount = await db.transaction(async (outerTx) => {
    if (plan.mode === 'instance') {
      const [existingAcc] = await outerTx.select({ id: accounts.id }).from(accounts).limit(1)
      const [existingCircle] = await outerTx.select({ id: circles.id }).from(circles).limit(1)
      if (existingAcc || existingCircle) {
        throw new Error('目标实例已存在账号或记忆圈：全实例迁移仅支持写入未初始化的空库')
      }
    }

    // 1. 写入账号与个人圈
    const personalIdMap = new Map<string, string>()
    for (const acc of plan.accounts) {
      if (!acc.createAccount) {
        personalIdMap.set(acc.id, acc.personalCircleId)
        continue
      }
      await outerTx.insert(accounts).values({
        id: acc.id,
        username: acc.username,
        displayName: acc.displayName,
        passwordHash: acc.passwordHash,
        isAdmin: acc.isAdmin,
        disabledAt: acc.disabledAt,
        createdAt: acc.createdAt,
      })
      const createdPersonal = await createPersonalCircle(outerTx, acc)
      personalIdMap.set(acc.id, createdPersonal.id)
    }

    // 2. 写入共享圈与成员
    for (const c of plan.sharedCircles) {
      await outerTx.insert(circles).values({
        id: c.id,
        slug: c.slug,
        name: c.name,
        kind: 'shared',
        ownerAccountId: null,
        defaultFacets: {},
        extractionMonthlyTokens: c.extractionMonthlyTokens,
        extractionDailyWrites: c.extractionDailyWrites,
        advanced: c.advanced,
        privacy: c.privacy,
        privacyRevision: c.privacyRevision,
        createdAt: c.createdAt,
      })
      if (c.members.length) {
        await outerTx.insert(circleMembers).values(
          c.members.map((m) => ({
            circleId: c.id,
            accountId: m.accountId,
            role: m.role,
            dreamPrivate: m.dreamPrivate,
            createdAt: m.createdAt,
          })),
        )
      }
    }

    // 3. 写入全局 settings 并迁移旧模型配置（仅全实例模式）
    if (plan.mode === 'instance' && plan.settings.length) {
      for (const s of plan.settings) {
        await outerTx
          .insert(settings)
          .values({ key: s.key, value: s.value, updatedAt: s.updatedAt })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: s.value, updatedAt: s.updatedAt },
          })
      }
      await migrateLegacyModelSettings(outerTx)
    }

    const existingCircleRows = await outerTx.select({ id: circles.id }).from(circles)
    const allExistingCircleIds = existingCircleRows.map((r) => r.id)
    const writeCircleIds = [
      ...new Set([...personalIdMap.values(), ...plan.sharedCircles.map((c) => c.id)]),
    ]
    const shortIds = await allocateFreshShortIds(outerTx, allExistingCircleIds, plan.entries.length)

    if (writeCircleIds.length) {
      await withCircles(outerTx, { read: writeCircleIds, write: writeCircleIds }, async (cTx) => {
        // 4. 人格与人格设定段
        for (const p of plan.personas) {
          await cTx.insert(personas).values({
            id: p.id,
            circleId: p.circleId,
            slug: p.slug,
            name: p.name,
            extendsId: p.extendsId,
            description: p.description,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          })
        }
        for (const t of plan.personaTraits) {
          await cTx.insert(personaTraits).values({
            circleId: t.circleId,
            personaId: t.personaId,
            traitKey: t.traitKey,
            title: t.title,
            content: t.content,
            sortOrder: t.sortOrder,
            updatedAt: t.updatedAt,
          })
        }

        // 5. 接入实例
        for (const cl of plan.clients) {
          await cTx.insert(clients).values({
            id: cl.id,
            circleId: cl.circleId,
            slug: cl.slug,
            name: cl.name,
            runtimeFamily: cl.runtimeFamily,
            ownerAccountId: cl.ownerAccountId,
            defaultPersonaId: cl.defaultPersonaId,
            config: cl.config,
            createdAt: cl.createdAt,
            updatedAt: cl.updatedAt,
          })
        }

        // 6. 联系人、身份、按群规则与会话
        for (const subj of plan.subjects) {
          await cTx.insert(subjects).values({
            id: subj.id,
            circleId: subj.circleId,
            kind: subj.kind,
            displayName: subj.displayName,
            nameLocked: subj.nameLocked,
            accountId: subj.accountId,
            createdAt: subj.createdAt,
            updatedAt: subj.updatedAt,
          })
        }
        for (const iden of plan.identities) {
          await cTx.insert(subjectIdentities).values({
            id: iden.id,
            circleId: iden.circleId,
            subjectId: iden.subjectId,
            kind: iden.kind,
            platform: iden.platform,
            externalId: iden.externalId,
            displayName: iden.displayName,
            createdAt: iden.createdAt,
          })
        }
        for (const r of plan.groupRules) {
          await cTx.insert(clientGroupRules).values({
            circleId: r.circleId,
            clientId: r.clientId,
            groupSubjectId: r.groupSubjectId,
            personaId: r.personaId,
            isolateGroupMemory: false,
            createdAt: r.createdAt,
          })
        }
        for (const conv of plan.conversations) {
          await cTx.insert(conversations).values({
            id: conv.id,
            circleId: conv.circleId,
            clientId: conv.clientId,
            kind: conv.kind,
            deviceKey: conv.deviceKey,
            projectSlug: conv.projectSlug,
            subjectId: conv.subjectId,
            ownerAccountId: conv.ownerAccountId,
            createdAt: conv.createdAt,
            lastActiveAt: conv.lastActiveAt,
          })
        }

        // 7. 密码库连接与凭据（personalCircleId 对齐最新个人圈 id）
        for (const v of plan.vaultConnections) {
          const targetCircleId = personalIdMap.get(v.ownerAccountId) ?? v.circleId
          const sealed = v.secrets ? sealVaultSecrets(targetMasterKey!, v.id, v.secrets) : null
          await cTx.insert(vaultConnections).values({
            id: v.id,
            circleId: targetCircleId,
            ownerAccountId: v.ownerAccountId,
            serverUrl: v.serverUrl,
            email: v.email,
            vaultUserId: v.vaultUserId,
            deviceId: v.deviceId,
            ciphertext: sealed ? sealed.ciphertext : null,
            wrappedKey: sealed ? sealed.wrappedKey : null,
            keyId: sealed ? sealed.keyId : null,
            status: v.status,
            disabledReason: v.disabledReason,
            lastErrorKind: v.lastErrorKind,
            lastErrorAt: v.lastErrorAt,
            lastCheckedAt: v.lastCheckedAt,
            defaultCollectionId: v.defaultCollectionId,
            defaultOrganizationId: v.defaultOrganizationId,
            defaultCollectionName: v.defaultCollectionName,
            disconnectedAt: v.disconnectedAt,
            createdAt: v.createdAt,
            updatedAt: v.updatedAt,
          })
        }

        for (const c of plan.credentials) {
          const targetCircleId = personalIdMap.get(c.ownerAccountId) ?? c.circleId
          if (c.source === 'hosted') {
            const sealed = sealCredentialValues(targetMasterKey!, c.id, c.plainValues ?? {})
            await cTx.insert(credentials).values({
              id: c.id,
              circleId: targetCircleId,
              ownerAccountId: c.ownerAccountId,
              identifier: c.identifier,
              name: c.name,
              description: c.description,
              source: 'hosted',
              fields: c.fields,
              ciphertext: sealed.ciphertext,
              wrappedKey: sealed.wrappedKey,
              keyId: sealed.keyId,
              clientIds: c.clientIds,
              allowedRealms: null,
              version: c.version,
              expiresAt: c.expiresAt,
              rotationRequestedAt: c.rotationRequestedAt,
              valueVersion: c.valueVersion,
              valueChangedAt: c.valueChangedAt,
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
            })
          } else {
            await cTx.insert(credentials).values({
              id: c.id,
              circleId: targetCircleId,
              ownerAccountId: c.ownerAccountId,
              identifier: c.identifier,
              name: c.name,
              description: c.description,
              source: 'vault',
              vaultConnectionId: c.vaultConnectionId,
              vaultItemId: c.vaultItemId,
              fields: c.fields,
              clientIds: c.clientIds,
              allowedRealms: null,
              version: c.version,
              expiresAt: c.expiresAt,
              rotationRequestedAt: c.rotationRequestedAt,
              valueVersion: c.valueVersion,
              valueChangedAt: c.valueChangedAt,
              vaultRevision: c.vaultRevision,
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
            })
          }
        }

        // 8. 注册 runtime 切面词表项并写入全部词条与变体
        const registeredRuntimeTerms = new Set<string>()
        const existingLegacyUris = new Set<string>()
        if (plan.mode === 'space-export') {
          const personalIds = plan.accounts.map(
            (a) => personalIdMap.get(a.id) ?? a.personalCircleId,
          )
          if (personalIds.length) {
            const existingRows = await cTx
              .select({ circleId: legacyUris.circleId, legacyUri: legacyUris.legacyUri })
              .from(legacyUris)
              .where(inArray(legacyUris.circleId, personalIds))
            for (const r of existingRows) {
              existingLegacyUris.add(`${r.circleId}\0${r.legacyUri}`)
            }
          }
        }

        for (let i = 0; i < plan.entries.length; i++) {
          const item = plan.entries[i]!
          const shortId = shortIds[i]!
          const targetCircleId =
            item.circleKind === 'personal' && item.ownerAccountId
              ? (personalIdMap.get(item.ownerAccountId) ?? item.circleId)
              : item.circleId

          if (item.runtimeFacetSlug && item.circleKind === 'shared') {
            const termKey = `${targetCircleId}\0${item.runtimeFacetSlug}`
            if (!registeredRuntimeTerms.has(termKey)) {
              registeredRuntimeTerms.add(termKey)
              await cTx
                .insert(facetTerms)
                .values({
                  circleId: targetCircleId,
                  dimensionKey: 'runtime',
                  slug: item.runtimeFacetSlug,
                  label: item.runtimeFacetSlug,
                  autoRegistered: true,
                })
                .onConflictDoNothing()
            }
          }

          const title = deriveEntryTitle(
            item.explicitTitle,
            [{ content: item.plaintext }],
            item.sensitivity === 'secret' ? shortId : item.titleFallback || shortId,
            item.sensitivity,
          )
          const [insertedEntry] = await cTx
            .insert(entries)
            .values({
              id: item.id,
              circleId: targetCircleId,
              circleKind: item.circleKind,
              shortId,
              kind: item.kind,
              title,
              sensitivity: item.sensitivity,
              provenance: item.provenance,
              originScope: item.originScope,
              clientId: item.clientId,
              ownerAccountId: item.ownerAccountId,
              subjectId: item.subjectId,
              subjectKind: item.subjectKind,
              conversationId: item.conversationId,
              realms: item.realms,
              topics: item.topics,
              priority: item.priority,
              disclosure: item.disclosure,
              validFrom: item.validFrom,
              validTo: item.validTo,
              expiresAt: item.expiresAt,
              version: 1,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            })
            .returning()

          const variantId = randomUUID()
          if (item.sensitivity === 'secret') {
            const { key, id: keyId } = encryptionKey(targetMasterKey!)
            const sealed = encryptSecret(key, item.plaintext, `variant:${variantId}`)
            await cTx.insert(entryVariants).values({
              id: variantId,
              circleId: targetCircleId,
              entryId: item.id,
              sensitivity: 'secret',
              kind: item.kind,
              when: item.when,
              whenSignature: item.whenSignature,
              sortOrder: 0,
              searchHeader: '',
              content: null,
              ciphertext: sealed.ciphertext,
              wrappedKey: sealed.wrappedKey,
              keyId,
              plaintextIgnoredHash: null,
              sensitiveRevision: 0,
              sensitiveCredential: false,
              sensitivePii: false,
              sensitiveFindings: [],
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            })
          } else {
            await cTx.insert(entryVariants).values({
              id: variantId,
              circleId: targetCircleId,
              entryId: item.id,
              sensitivity: item.sensitivity,
              kind: item.kind,
              when: item.when,
              whenSignature: item.whenSignature,
              sortOrder: 0,
              searchHeader: buildSearchHeader({
                sensitivity: item.sensitivity,
                title,
                topics: item.topics,
                disclosure: item.disclosure,
                glossary: item.glossary,
              }),
              content: item.plaintext,
              ciphertext: null,
              wrappedKey: null,
              keyId: null,
              plaintextIgnoredHash: item.plaintextIgnoredHash,
              sensitiveRevision: item.sensitiveRevision,
              sensitiveCredential: item.sensitiveCredential,
              sensitivePii: item.sensitivePii,
              sensitiveFindings: item.sensitiveFindings as never,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            })
          }

          if (item.glossary.length) {
            await cTx
              .insert(entryGlossary)
              .values(
                item.glossary.map((keyword) => ({
                  circleId: targetCircleId,
                  entryId: item.id,
                  keyword,
                })),
              )
              .onConflictDoNothing()
          }

          const credRefs =
            item.sensitivity !== 'secret' &&
            placeholderAllowed(item.circleKind, item.kind, item.sensitivity)
              ? placeholderIdentifiers(item.plaintext)
              : new Set<string>()
          await syncCredentialRefs(cTx, targetCircleId, item.id, credRefs)

          await syncEntryLinks(cTx, {
            circleId: targetCircleId,
            entryId: item.id,
            shortId,
            sensitivity: item.sensitivity,
            provenance: item.provenance,
            variants: [{ id: variantId, content: item.plaintext }],
          })

          if (item.legacyUri) {
            const uriKey = `${targetCircleId}\0${item.legacyUri}`
            if (existingLegacyUris.has(uriKey)) {
              warnings.push(
                `个人圈已存在旧坐标 ${item.legacyUri}，词条（短 ID ${shortId}）已写入但未重复占用该旧坐标映射`,
              )
            } else {
              existingLegacyUris.add(uriKey)
              await cTx.insert(legacyUris).values({
                circleId: targetCircleId,
                entryId: item.id,
                legacyUri: item.legacyUri,
                source: 'kioku-legacy',
              })
            }
          }

          await cTx.insert(entryEvents).values({
            circleId: targetCircleId,
            entryId: item.id,
            shortId,
            eventType: 'create',
            provenance: item.provenance,
            actorAccountId: item.ownerAccountId ?? plan.accounts[0]?.id ?? null,
            before: null,
            after: toStoredSnapshot(
              insertedEntry!,
              [{ when: item.when, content: item.sensitivity === 'secret' ? null : item.plaintext }],
              item.glossary,
            ),
            context: {
              source: 'kioku-legacy',
              legacyVersion: item.legacyVersion,
              ...(item.legacyUri ? { legacyUri: item.legacyUri } : {}),
            },
          })
        }
      })
    }

    return shortIds.length
  })

  // 验证主密钥状态并补齐遗留 keyId（确保 status 通过）
  await prepareMasterKey(db, targetMasterKey)

  return {
    summary: { ...plan.summary, warnings },
    allocatedShortIds: allocatedCount,
  }
}
