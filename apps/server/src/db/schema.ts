import {
  ACCOUNT_LINK_PURPOSES,
  CIRCLE_KINDS,
  CONVERSATION_KINDS,
  CREDENTIAL_SOURCES,
  DEFAULT_EXTRACTION_DAILY_WRITES,
  DEFAULT_EXTRACTION_MONTHLY_TOKENS,
  ENTRY_KINDS,
  FACET_MATCH_MODES,
  MEMBER_ROLES,
  PROVENANCES,
  SENSITIVITIES,
  SUBJECT_KINDS,
  VAULT_CONNECTION_STATUSES,
  VAULT_DISABLED_REASONS,
  VAULT_ERROR_KINDS,
  type ClientConfig,
  type CredentialField,
  type DefaultFacets,
  type FacetImplies,
  type LensKeyScopes,
  type LinkedCircleGrant,
  type StoredSensitiveFinding,
  type VariantInput,
  type WhenCondition,
} from '@kioku/contracts'
import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

// 表分两类：身份与路由表（accounts、settings、circles、circle_members、circle_departures、sessions、
// account_links、login_attempts、api_keys、device_grants）不开行级安全；其余内容表全部带非空 circle_id，
// 由迁移中的四命令 RLS 策略按会话变量 app.read_circles 与 app.write_circles 分别控制读与写。

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

// 整个实例共用同一个向量维度（1024 维在 pgvector HNSW 索引上限 2000 之内）
export const EMBEDDING_DIMENSIONS = 1024

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

export const circleKind = pgEnum('circle_kind', CIRCLE_KINDS)
export const entryKind = pgEnum('entry_kind', ENTRY_KINDS)
export const sensitivity = pgEnum('sensitivity', SENSITIVITIES)
export const provenance = pgEnum('provenance', PROVENANCES)
export const memberRole = pgEnum('member_role', MEMBER_ROLES)
export const subjectKind = pgEnum('subject_kind', SUBJECT_KINDS)
export const credentialSource = pgEnum('credential_source', CREDENTIAL_SOURCES)
export const vaultConnectionStatus = pgEnum('vault_connection_status', VAULT_CONNECTION_STATUSES)
export const vaultDisabledReason = pgEnum('vault_disabled_reason', VAULT_DISABLED_REASONS)
export const vaultErrorKind = pgEnum('vault_error_kind', VAULT_ERROR_KINDS)
export const conversationKind = pgEnum('conversation_kind', CONVERSATION_KINDS)
export const accountLinkPurpose = pgEnum('account_link_purpose', ACCOUNT_LINK_PURPOSES)
export const facetMatchMode = pgEnum('facet_match_mode', FACET_MATCH_MODES)

// ---- 身份与系统表（不开 RLS）----

export const accounts = pgTable('accounts', {
  id: uuid().primaryKey().defaultRandom(),
  username: text().notNull().unique(),
  displayName: text().notNull(),
  passwordHash: text(),
  isAdmin: boolean().notNull().default(false),
  disabledAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
})

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt(),
})

// 记忆圈：personal 为每个账号唯一不可删的个人圈；shared 为共享圈（家庭、团队、机器人社交圈等）
export const circles = pgTable(
  'circles',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    kind: circleKind().notNull(),
    ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'cascade' }),
    defaultFacets: jsonb().$type<DefaultFacets>().notNull().default({}),
    extractionMonthlyTokens: integer().notNull().default(DEFAULT_EXTRACTION_MONTHLY_TOKENS),
    extractionDailyWrites: integer().notNull().default(DEFAULT_EXTRACTION_DAILY_WRITES),
    advanced: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    privacy: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    privacyRevision: integer().notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    unique('circles_id_kind_unique').on(t.id, t.kind),
    uniqueIndex('circles_personal_owner_idx')
      .on(t.ownerAccountId)
      .where(sql`${t.kind} = 'personal'`),
    check(
      'circles_owner_by_kind',
      sql`(${t.kind} = 'personal') = (${t.ownerAccountId} is not null)`,
    ),
  ],
)

export const circleMembers = pgTable(
  'circle_members',
  {
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: memberRole().notNull(),
    dreamPrivate: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.circleId, t.accountId] })],
)

export const circleDepartures = pgTable(
  'circle_departures',
  {
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    leftAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    dreamPrivate: boolean().notNull(),
    purgeStartedAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.circleId, t.accountId] }), index().on(t.leftAt)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    clientAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    lastActiveAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.accountId)],
)

export const accountLinks = pgTable(
  'account_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    purpose: accountLinkPurpose().notNull(),
    tokenHash: text().notNull().unique(),
    createdBy: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.accountId), index().on(t.expiresAt)],
)

export const loginAttempts = pgTable(
  'login_attempts',
  {
    username: text().primaryKey(),
    count: integer().notNull(),
    resetAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.resetAt)],
)

// ---- 内容表（强制 RLS，共 31 张）----

export const personas = pgTable(
  'personas',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    extendsId: uuid().references((): AnyPgColumn => personas.id, { onDelete: 'set null' }),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('personas_circle_slug_idx').on(t.circleId, t.slug),
    unique('personas_circle_id_unique').on(t.circleId, t.id),
  ],
)

// 人格设定段：按 trait_key 在继承链上逐段覆盖
export const personaTraits = pgTable(
  'persona_traits',
  {
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    personaId: uuid().notNull(),
    traitKey: text().notNull(),
    title: text().notNull(),
    content: text().notNull(),
    sortOrder: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.personaId, t.traitKey] }),
    index('persona_traits_circle_idx').on(t.circleId, t.personaId, t.sortOrder),
    foreignKey({
      name: 'persona_traits_persona_fk',
      columns: [t.circleId, t.personaId],
      foreignColumns: [personas.circleId, personas.id],
    }).onDelete('cascade'),
  ],
)

// 接入实例：作为访问密钥主场圈、所有者、默认人格及群规则的唯一真源
export const clients = pgTable(
  'clients',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    runtimeFamily: text().notNull(),
    ownerAccountId: uuid()
      .notNull()
      .references(() => accounts.id),
    defaultPersonaId: uuid(),
    config: jsonb().$type<ClientConfig>().notNull().default({ personMemoryMode: 'strict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('clients_circle_slug_idx').on(t.circleId, t.slug),
    unique('clients_circle_id_unique').on(t.circleId, t.id),
    // 迁移基线中手写 ON DELETE SET NULL ("default_persona_id")，避免把 circle_id 置空
    foreignKey({
      name: 'clients_default_persona_fk',
      columns: [t.circleId, t.defaultPersonaId],
      foreignColumns: [personas.circleId, personas.id],
    }).onDelete('set null'),
  ],
)

// 访问密钥（身份表）：归属某接入实例，主场圈与所有者统一从 clients 关联约束
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid().notNull(),
    name: text().notNull(),
    prefix: text().notNull().unique(),
    secretHash: text().notNull(),
    linkedCircles: jsonb().$type<LinkedCircleGrant[]>().notNull().default([]),
    contextFacets: jsonb().$type<WhenCondition>().notNull().default({}),
    personaOverrideId: uuid(),
    scopes: jsonb().$type<LensKeyScopes>().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('api_keys_circle_client_idx').on(t.circleId, t.clientId),
    index('api_keys_client_idx').on(t.clientId),
    foreignKey({
      name: 'api_keys_circle_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('cascade'),
    // 迁移基线中手写 ON DELETE SET NULL ("persona_override_id")，避免把 circle_id 置空
    foreignKey({
      name: 'api_keys_persona_override_fk',
      columns: [t.circleId, t.personaOverrideId],
      foreignColumns: [personas.circleId, personas.id],
    }).onDelete('set null'),
  ],
)

// 升级前签发的访问密钥（身份表）：就地迁移时只记下前缀与哈希，不能再用来访问，只用来认出旧密钥、
// 回 401 时提示重新接入。所有者用旧实例的账号 id（迁移保留账号 id），账号删了跟着删
export const legacyApiKeys = pgTable('legacy_api_keys', {
  prefix: text().primaryKey(),
  secretHash: text().notNull(),
  name: text().notNull(),
  ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
})

export interface DeviceGrantPlatform {
  runtimeFamily: string
  clientName: string | null
}
export type DeviceGrantSelection =
  | { runtimeFamily: string; skip: true }
  | {
      runtimeFamily: string
      clientId: string
      keyName: string
      scopes: LensKeyScopes
      contextFacets?: WhenCondition
    }

// 浏览器授权申请（身份表）
export const deviceGrants = pgTable(
  'device_grants',
  {
    id: uuid().primaryKey().defaultRandom(),
    deviceHash: text().notNull().unique(),
    userHash: text().notNull().unique(),
    runtimeFamily: text(),
    platforms: jsonb().$type<DeviceGrantPlatform[]>(),
    clientName: text(),
    clientAddress: text(),
    clientKey: text().notNull(),
    status: text({ enum: ['pending', 'approved', 'denied'] })
      .notNull()
      .default('pending'),
    approvedBy: uuid().references(() => accounts.id, { onDelete: 'cascade' }),
    selections: jsonb().$type<DeviceGrantSelection[]>(),
    approvedAt: timestamp({ withTimezone: true }),
    circleId: uuid().references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid(),
    linkedCircles: jsonb().$type<LinkedCircleGrant[]>(),
    contextFacets: jsonb().$type<WhenCondition>(),
    keyName: text(),
    scopes: jsonb().$type<LensKeyScopes>(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastPolledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.expiresAt),
    index().on(t.clientKey),
    index().on(t.circleId),
    foreignKey({
      name: 'device_grants_circle_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('cascade'),
    check(
      'device_grants_platforms_shape',
      sql`(${t.runtimeFamily} is null) <> (${t.platforms} is null)`,
    ),
  ],
)

export const subjects = pgTable(
  'subjects',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    kind: subjectKind().notNull(),
    displayName: text().notNull(),
    nameLocked: boolean().notNull().default(false),
    accountId: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('subjects_circle_created_idx').on(t.circleId, t.createdAt, t.id),
    unique('subjects_circle_id_unique').on(t.circleId, t.id),
    unique('subjects_circle_id_kind_unique').on(t.circleId, t.id, t.kind),
  ],
)

export const subjectIdentities = pgTable(
  'subject_identities',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    subjectId: uuid().notNull(),
    kind: subjectKind().notNull(),
    platform: text().notNull(),
    externalId: text().notNull(),
    displayName: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('subject_identities_platform_idx').on(t.circleId, t.platform, t.kind, t.externalId),
    index('subject_identities_subject_idx').on(t.subjectId),
    foreignKey({
      name: 'subject_identities_subject_fk',
      columns: [t.circleId, t.subjectId, t.kind],
      foreignColumns: [subjects.circleId, subjects.id, subjects.kind],
    }).onDelete('cascade'),
  ],
)

// 按群规则：按群覆盖人格及单群强隔离锁（isolate_group_memory）
export const clientGroupRules = pgTable(
  'client_group_rules',
  {
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid().notNull(),
    groupSubjectId: uuid().notNull(),
    personaId: uuid(),
    isolateGroupMemory: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.groupSubjectId] }),
    index('client_group_rules_persona_idx').on(t.personaId),
    index('client_group_rules_group_idx').on(t.groupSubjectId),
    foreignKey({
      name: 'client_group_rules_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'client_group_rules_subject_fk',
      columns: [t.circleId, t.groupSubjectId],
      foreignColumns: [subjects.circleId, subjects.id],
    }).onDelete('cascade'),
    // 迁移基线中手写 ON DELETE SET NULL ("persona_id")
    foreignKey({
      name: 'client_group_rules_persona_fk',
      columns: [t.circleId, t.personaId],
      foreignColumns: [personas.circleId, personas.id],
    }).onDelete('set null'),
  ],
)

// 会话：群聊/频道、私聊，以及按 (client_id, owner_account_id, device_key, project_slug) 细分的本机无上下文会话
export const conversations = pgTable(
  'conversations',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid().notNull(),
    kind: conversationKind().notNull(),
    deviceKey: text().notNull().default(''),
    projectSlug: text().notNull().default(''),
    subjectId: uuid(),
    ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastActiveAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('conversations_circle_id_unique').on(t.circleId, t.id),
    uniqueIndex('conversations_subject_idx')
      .on(t.clientId, t.subjectId)
      .where(sql`${t.kind} <> 'none'`),
    uniqueIndex('conversations_none_idx')
      .on(t.clientId, t.ownerAccountId, t.deviceKey, t.projectSlug)
      .where(sql`${t.kind} = 'none'`),
    index('conversations_circle_active_idx').on(t.circleId, t.lastActiveAt),
    index('conversations_subject_lookup_idx').on(t.subjectId),
    foreignKey({
      name: 'conversations_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversations_subject_fk',
      columns: [t.circleId, t.subjectId],
      foreignColumns: [subjects.circleId, subjects.id],
    }).onDelete('cascade'),
    check(
      'conversations_kind_shape',
      sql`case when ${t.kind} = 'none'
        then ${t.subjectId} is null and ${t.ownerAccountId} is not null
        else ${t.subjectId} is not null and ${t.ownerAccountId} is null and ${t.deviceKey} = '' and ${t.projectSlug} = '' end`,
    ),
  ],
)

// 自定义切面维度：均按 circle_id 严格隔离；四大内置维度常量固化于 @kioku/contracts
export const facetDimensions = pgTable(
  'facet_dimensions',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    name: text().notNull(),
    matchMode: facetMatchMode().notNull().default('exclusive'),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('facet_dimensions_circle_key_idx').on(t.circleId, t.key),
    check(
      'facet_dimensions_not_builtin',
      sql`${t.key} not in ('realm', 'env', 'runtime', 'project')`,
    ),
  ],
)

// 切面词表项：全量按 circle_id 隔离，含 implies 蕴含展开与 aliases 口语触发词
export const facetTerms = pgTable(
  'facet_terms',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    dimensionKey: text().notNull(),
    slug: text().notNull(),
    label: text().notNull(),
    implies: jsonb().$type<FacetImplies>().notNull().default({}),
    aliases: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    autoRegistered: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('facet_terms_circle_dim_slug_idx').on(t.circleId, t.dimensionKey, t.slug),
    index('facet_terms_aliases_gin_idx').using('gin', t.aliases),
  ],
)

// 词条头表：统一正式词条（entry）、联系人/群事实（fact）与会话摘要（episode）
export const entries = pgTable(
  'entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    circleKind: circleKind().notNull(),
    shortId: text().notNull(),
    kind: entryKind().notNull(),
    title: text().notNull(),
    sensitivity: sensitivity().notNull(),
    provenance: provenance().notNull(),
    originScope: text().notNull().default('global'),
    clientId: uuid(),
    ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'cascade' }),
    subjectId: uuid(),
    subjectKind: subjectKind(),
    conversationId: uuid(),
    realms: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    topics: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    priority: integer().notNull().default(2),
    disclosure: text(),
    validFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // 全实例全局唯一短 ID（含已软删除行），绝不复用碰撞
    unique('entries_short_id_unique').on(t.shortId),
    unique('entries_circle_id_unique').on(t.circleId, t.id),
    unique('entries_circle_id_sens_kind_unique').on(t.circleId, t.id, t.sensitivity, t.kind),
    index('entries_circle_kind_idx').on(t.circleId, t.kind),
    index('entries_subject_idx')
      .on(t.subjectId)
      .where(sql`${t.subjectId} is not null`),
    index('entries_conversation_idx')
      .on(t.conversationId)
      .where(sql`${t.conversationId} is not null`),
    index('entries_topics_gin_idx').using('gin', t.topics),
    index('entries_realms_gin_idx').using('gin', t.realms),
    foreignKey({
      name: 'entries_circle_kind_fk',
      columns: [t.circleId, t.circleKind],
      foreignColumns: [circles.id, circles.kind],
    }).onDelete('cascade'),
    // 迁移基线中手写 ON DELETE SET NULL ("client_id")
    foreignKey({
      name: 'entries_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'entries_subject_fk',
      columns: [t.circleId, t.subjectId, t.subjectKind],
      foreignColumns: [subjects.circleId, subjects.id, subjects.kind],
    }).onDelete('cascade'),
    // 迁移基线中手写 ON DELETE SET NULL ("conversation_id")；摘要由删除前触发器清理
    foreignKey({
      name: 'entries_conversation_fk',
      columns: [t.circleId, t.conversationId],
      foreignColumns: [conversations.circleId, conversations.id],
    }).onDelete('set null'),
    check('entries_short_id_format', sql`${t.shortId} ~ '^m-[2-9a-hjkmnp-tv-z]{6,8}$'`),
    check('entries_subject_kind_pair', sql`(${t.subjectId} is null) = (${t.subjectKind} is null)`),
    check(
      'entries_shape_by_kind',
      sql`case ${t.kind}
        when 'entry' then ((${t.circleKind} = 'personal' and ${t.ownerAccountId} is not null)
          or (${t.circleKind} = 'shared' and ${t.ownerAccountId} is null))
          and ${t.subjectId} is null and ${t.subjectKind} is null and ${t.conversationId} is null
        when 'fact' then ${t.subjectId} is not null and ${t.subjectKind} is not null
          and ${t.ownerAccountId} is null
        when 'episode' then ${t.conversationId} is not null
          and ${t.subjectId} is null and ${t.subjectKind} is null
        else false end`,
    ),
    check(
      'entries_untrusted_kinds',
      sql`${t.provenance} <> 'untrusted' or ${t.kind} in ('fact', 'episode')`,
    ),
    check(
      'entries_episode_not_secret',
      sql`${t.kind} <> 'episode' or ${t.sensitivity} <> 'secret'`,
    ),
    check('entries_episode_priority', sql`${t.kind} <> 'episode' or ${t.priority} >= 1`),
    check('entries_priority_nonneg', sql`${t.priority} >= 0`),
  ],
)

// 词条多变体切片表：承载切面条件、正文、信封密文、脱敏标记与单表级全文检索向量
export const entryVariants = pgTable(
  'entry_variants',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    entryId: uuid().notNull(),
    sensitivity: sensitivity().notNull(),
    kind: entryKind().notNull(),
    when: jsonb().$type<WhenCondition>().notNull().default({}),
    whenSignature: text().notNull().default('{}'),
    sortOrder: integer().notNull().default(0),
    // 同事务同步拼接头表检索关键词；secret 词条必须为空串
    searchHeader: text().notNull().default(''),
    content: text(),
    ciphertext: bytea(),
    wrappedKey: bytea(),
    keyId: text(),
    plaintextIgnoredHash: text(),
    sensitiveRevision: integer().notNull().default(0),
    sensitiveCredential: boolean().notNull().default(false),
    sensitivePii: boolean().notNull().default(false),
    sensitiveFindings: jsonb().$type<StoredSensitiveFinding[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    fts: tsvector().generatedAlwaysAs(
      sql`to_tsvector('kioku_zh'::regconfig, coalesce(search_header, '') || ' ' || coalesce(content, ''))`,
    ),
  },
  (t) => [
    unique('entry_variants_circle_id_unique').on(t.circleId, t.id),
    uniqueIndex('entry_variants_entry_when_idx').on(t.entryId, t.whenSignature),
    uniqueIndex('entry_variants_episode_single_idx')
      .on(t.entryId)
      .where(sql`${t.kind} = 'episode'`),
    index('entry_variants_fts_idx').using('gin', t.fts),
    index('entry_variants_key_id_idx')
      .on(t.circleId, t.keyId)
      .where(sql`${t.wrappedKey} is not null`),
    index('entry_variants_sensitive_idx').on(t.circleId, t.sensitiveCredential, t.sensitivePii),
    foreignKey({
      name: 'entry_variants_entry_fk',
      columns: [t.circleId, t.entryId],
      foreignColumns: [entries.circleId, entries.id],
    }).onDelete('cascade'),
    // 迁移基线中声明为 DEFERRABLE INITIALLY DEFERRED，保障敏感级变更与正文加解密同事务同步提交
    foreignKey({
      name: 'entry_variants_state_fk',
      columns: [t.circleId, t.entryId, t.sensitivity, t.kind],
      foreignColumns: [entries.circleId, entries.id, entries.sensitivity, entries.kind],
    }),
    check(
      'entry_variants_secret_encrypted',
      sql`case when ${t.sensitivity} = 'secret'
        then ${t.content} is null and ${t.searchHeader} = '' and ${t.ciphertext} is not null and ${t.wrappedKey} is not null
        else ${t.content} is not null and ${t.ciphertext} is null and ${t.wrappedKey} is null end`,
    ),
    check(
      'entry_variants_episode_unconditional',
      sql`${t.kind} <> 'episode' or (${t.when} = '{}'::jsonb and ${t.whenSignature} = '{}')`,
    ),
  ],
)

export const entryEmbeddings = pgTable(
  'entry_embeddings',
  {
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    variantId: uuid().notNull(),
    entryId: uuid().notNull(),
    model: text().notNull(),
    contentHash: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.model] }),
    index('entry_embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('entry_embeddings_entry_idx').on(t.circleId, t.entryId),
    foreignKey({
      name: 'entry_embeddings_variant_fk',
      columns: [t.circleId, t.variantId],
      foreignColumns: [entryVariants.circleId, entryVariants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'entry_embeddings_entry_fk',
      columns: [t.circleId, t.entryId],
      foreignColumns: [entries.circleId, entries.id],
    }).onDelete('cascade'),
  ],
)

// 双链边索引：细化至源变体切片粒度，目标按短 ID 保留悬空引用支持跨圈联想与软删除恢复
export const entryLinks = pgTable(
  'entry_links',
  {
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    sourceVariantId: uuid().notNull(),
    sourceEntryId: uuid().notNull(),
    targetShortId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceVariantId, t.targetShortId] }),
    index('entry_links_target_idx').on(t.targetShortId),
    index('entry_links_source_entry_idx').on(t.circleId, t.sourceEntryId),
    foreignKey({
      name: 'entry_links_variant_fk',
      columns: [t.circleId, t.sourceVariantId],
      foreignColumns: [entryVariants.circleId, entryVariants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'entry_links_entry_fk',
      columns: [t.circleId, t.sourceEntryId],
      foreignColumns: [entries.circleId, entries.id],
    }).onDelete('cascade'),
    check('entry_links_target_format', sql`${t.targetShortId} ~ '^m-[2-9a-hjkmnp-tv-z]{6,8}$'`),
  ],
)

export const entryGlossary = pgTable(
  'entry_glossary',
  {
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    entryId: uuid().notNull(),
    keyword: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.keyword] }),
    index().on(t.circleId, t.keyword),
    foreignKey({
      name: 'entry_glossary_entry_fk',
      columns: [t.circleId, t.entryId],
      foreignColumns: [entries.circleId, entries.id],
    }).onDelete('cascade'),
  ],
)

export const entryEvents = pgTable(
  'entry_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    entryId: uuid().references(() => entries.id, { onDelete: 'set null' }),
    shortId: text().notNull(),
    eventType: text().notNull(),
    actorKeyId: uuid(),
    actorAccountId: uuid(),
    provenance: provenance().notNull(),
    before: jsonb(),
    after: jsonb(),
    context: jsonb().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.circleId, t.createdAt),
    index().on(t.entryId, t.createdAt),
    index().on(t.circleId, t.shortId, t.createdAt),
  ],
)

export const entryCredentialRefs = pgTable(
  'entry_credential_refs',
  {
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    entryId: uuid().notNull(),
    identifier: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.identifier] }),
    index().on(t.circleId, t.identifier),
    foreignKey({
      name: 'entry_credential_refs_entry_fk',
      columns: [t.circleId, t.entryId],
      foreignColumns: [entries.circleId, entries.id],
    }).onDelete('cascade'),
  ],
)

export const entryRecallStats = pgTable(
  'entry_recall_stats',
  {
    entryId: uuid().primaryKey(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    count: integer().notNull(),
    lastRecalledAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'entry_recall_stats_entry_fk',
      columns: [t.circleId, t.entryId],
      foreignColumns: [entries.circleId, entries.id],
    }).onDelete('cascade'),
  ],
)

// 迁移旧坐标兜底映射表
export const legacyUris = pgTable(
  'legacy_uris',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    entryId: uuid().notNull(),
    legacyUri: text().notNull(),
    source: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('legacy_uris_circle_uri_idx').on(t.circleId, t.legacyUri),
    index('legacy_uris_entry_idx').on(t.circleId, t.entryId),
    foreignKey({
      name: 'legacy_uris_entry_fk',
      columns: [t.circleId, t.entryId],
      foreignColumns: [entries.circleId, entries.id],
    }).onDelete('cascade'),
    check('legacy_uris_source_check', sql`${t.source} in ('lore', 'kioku-legacy')`),
  ],
)

export const vaultConnections = pgTable(
  'vault_connections',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    ownerAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    serverUrl: text().notNull(),
    email: text().notNull(),
    vaultUserId: text().notNull(),
    deviceId: uuid().notNull(),
    ciphertext: bytea(),
    wrappedKey: bytea(),
    keyId: text(),
    status: vaultConnectionStatus().notNull().default('ok'),
    disabledReason: vaultDisabledReason(),
    lastErrorKind: vaultErrorKind(),
    lastErrorAt: timestamp({ withTimezone: true }),
    lastCheckedAt: timestamp({ withTimezone: true }),
    defaultCollectionId: text(),
    defaultOrganizationId: text(),
    defaultCollectionName: text(),
    disconnectedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('vault_connections_circle_owner_idx').on(t.circleId, t.ownerAccountId),
    unique('vault_connections_circle_owner_id_unique').on(t.circleId, t.ownerAccountId, t.id),
    uniqueIndex('vault_connections_account_idx').on(
      t.circleId,
      t.ownerAccountId,
      t.serverUrl,
      t.vaultUserId,
    ),
    index('vault_connections_key_id_idx')
      .on(t.circleId, t.keyId)
      .where(sql`${t.wrappedKey} is not null`),
    check(
      'vault_connections_secrets_shape',
      sql`(${t.ciphertext} is null) = (${t.wrappedKey} is null)
        and (${t.ciphertext} is null) = (${t.status} = 'disconnected')
        and (${t.disconnectedAt} is null) = (${t.status} <> 'disconnected')`,
    ),
    check(
      'vault_connections_disabled_reason',
      sql`(${t.disabledReason} is null) = (${t.status} <> 'disabled')`,
    ),
    check(
      'vault_connections_last_error',
      sql`(${t.lastErrorKind} is null) = (${t.lastErrorAt} is null)`,
    ),
    check(
      'vault_connections_destination_shape',
      sql`(${t.defaultCollectionId} is null) = (${t.defaultOrganizationId} is null)
        and (${t.defaultCollectionId} is null) = (${t.defaultCollectionName} is null)`,
    ),
    uniqueIndex('vault_connections_destination_idx')
      .on(t.circleId, t.ownerAccountId)
      .where(sql`${t.defaultCollectionId} is not null`),
  ],
)

export const credentials = pgTable(
  'credentials',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    ownerAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    identifier: text().notNull(),
    name: text().notNull(),
    description: text(),
    source: credentialSource().notNull(),
    vaultConnectionId: uuid(),
    vaultItemId: text(),
    fields: jsonb().$type<CredentialField[]>().notNull().default([]),
    ciphertext: bytea(),
    wrappedKey: bytea(),
    keyId: text(),
    clientIds: uuid().array(),
    allowedRealms: text().array(),
    version: integer().notNull().default(1),
    expiresAt: timestamp({ withTimezone: true }),
    rotationRequestedAt: timestamp({ withTimezone: true }),
    valueVersion: integer().notNull().default(1),
    valueChangedAt: timestamp({ withTimezone: true }),
    vaultRevision: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('credentials_identifier_live_idx')
      .on(t.circleId, t.ownerAccountId, t.identifier)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('credentials_vault_item_live_idx')
      .on(t.vaultConnectionId, t.vaultItemId)
      .where(sql`${t.deletedAt} is null`),
    index('credentials_vault_connection_idx').on(t.vaultConnectionId),
    unique('credentials_circle_id_unique').on(t.circleId, t.id),
    index('credentials_key_id_idx')
      .on(t.circleId, t.keyId)
      .where(sql`${t.wrappedKey} is not null`),
    foreignKey({
      name: 'credentials_vault_connection_fk',
      columns: [t.circleId, t.ownerAccountId, t.vaultConnectionId],
      foreignColumns: [
        vaultConnections.circleId,
        vaultConnections.ownerAccountId,
        vaultConnections.id,
      ],
    }),
    check(
      'credentials_source_shape',
      sql`case when ${t.source} = 'hosted'
        then ${t.ciphertext} is not null and ${t.wrappedKey} is not null and ${t.vaultConnectionId} is null and ${t.vaultItemId} is null
        else ${t.ciphertext} is null and ${t.wrappedKey} is null and ${t.vaultConnectionId} is not null and ${t.vaultItemId} is not null end`,
    ),
  ],
)

export const credentialEvents = pgTable(
  'credential_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    credentialId: uuid().notNull(),
    eventType: text().notNull(),
    actorKeyId: uuid(),
    actorAccountId: uuid(),
    context: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.credentialId, t.id),
    foreignKey({
      name: 'credential_events_credential_fk',
      columns: [t.circleId, t.credentialId],
      foreignColumns: [credentials.circleId, credentials.id],
    }).onDelete('cascade'),
  ],
)

export const recallEvents = pgTable(
  'recall_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid().notNull(),
    keyId: uuid(),
    ownerAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    source: text().notNull(),
    query: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.circleId, t.createdAt),
    index().on(t.clientId, t.createdAt),
    index().on(t.circleId, t.ownerAccountId, t.clientId, t.id),
  ],
)

// 跨圈命中明细落在主场圈；不建指向客场 entries 的外键，累计统计由异步写入同步更新目标圈 entry_recall_stats
export const recallEventHits = pgTable(
  'recall_event_hits',
  {
    eventId: bigint({ mode: 'number' })
      .notNull()
      .references(() => recallEvents.id, { onDelete: 'cascade' }),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    targetCircleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    entryId: uuid().notNull(),
    shortId: text().notNull(),
    rank: smallint().notNull(),
    score: real().notNull(),
    via: text().array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.entryId] }),
    index('recall_event_hits_target_idx').on(t.targetCircleId, t.entryId),
  ],
)

export const conversationTurns = pgTable(
  'conversation_turns',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid().notNull(),
    keyId: uuid()
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    scope: text().notNull(),
    sessionId: text().notNull(),
    chatType: text().notNull(),
    groupSubjectId: uuid(),
    senderSubjectId: uuid(),
    ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'cascade' }),
    senderName: text(),
    userText: text().notNull(),
    replyText: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('conversation_turns_client_scope_idx').on(t.clientId, t.scope, t.id),
    foreignKey({
      name: 'conversation_turns_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversation_turns_group_fk',
      columns: [t.circleId, t.groupSubjectId],
      foreignColumns: [subjects.circleId, subjects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversation_turns_sender_fk',
      columns: [t.circleId, t.senderSubjectId],
      foreignColumns: [subjects.circleId, subjects.id],
    }).onDelete('cascade'),
    check(
      'conversation_turns_chat_type',
      sql`case ${t.chatType}
          when 'none' then ${t.groupSubjectId} is null and ${t.senderSubjectId} is null
            and ${t.ownerAccountId} is not null
          when 'direct' then ${t.groupSubjectId} is null and ${t.senderSubjectId} is not null
            and ${t.ownerAccountId} is null
          when 'group' then ${t.groupSubjectId} is not null and ${t.senderSubjectId} is not null
            and ${t.ownerAccountId} is null
          when 'channel' then ${t.groupSubjectId} is not null and ${t.senderSubjectId} is not null
            and ${t.ownerAccountId} is null
          else false end`,
    ),
  ],
)

export const extractionRuns = pgTable(
  'extraction_runs',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid().notNull(),
    scope: text().notNull(),
    conversationId: uuid(),
    subjectIds: uuid().array().notNull(),
    turns: integer().notNull(),
    skippedTurns: integer().notNull().default(0),
    model: text(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    added: integer().notNull().default(0),
    updated: integer().notNull().default(0),
    unchanged: integer().notNull().default(0),
    dropped: integer().notNull().default(0),
    summarized: boolean().notNull().default(false),
    summaryOnly: boolean().notNull().default(false),
    limited: integer().notNull().default(0),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.circleId, t.createdAt),
    index().using('gin', t.subjectIds),
    index('extraction_runs_conversation_idx')
      .on(t.conversationId, t.createdAt)
      .where(sql`${t.conversationId} is not null`),
    foreignKey({
      name: 'extraction_runs_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('cascade'),
    // 迁移基线中手写 ON DELETE SET NULL ("conversation_id")
    foreignKey({
      name: 'extraction_runs_conversation_fk',
      columns: [t.circleId, t.conversationId],
      foreignColumns: [conversations.circleId, conversations.id],
    }).onDelete('set null'),
  ],
)

export const subjectBindCodes = pgTable(
  'subject_bind_codes',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid().notNull(),
    keyId: uuid().notNull(),
    subjectId: uuid().notNull(),
    platform: text().notNull(),
    externalId: text().notNull(),
    codeHash: text().notNull(),
    previewedBy: uuid()
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('subject_bind_codes_client_hash_idx').on(t.clientId, t.codeHash),
    index().on(t.subjectId),
    index().on(t.expiresAt),
    foreignKey({
      name: 'subject_bind_codes_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'subject_bind_codes_subject_fk',
      columns: [t.circleId, t.subjectId],
      foreignColumns: [subjects.circleId, subjects.id],
    }).onDelete('cascade'),
  ],
)

export const subjectBindings = pgTable(
  'subject_bindings',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid().notNull(),
    keyId: uuid().notNull(),
    subjectId: uuid().notNull(),
    fromSubjectId: uuid().notNull(),
    platform: text().notNull(),
    externalId: text().notNull(),
    displayName: text(),
    issuedPlatform: text().notNull(),
    issuedExternalId: text().notNull(),
    issuedAt: timestamp({ withTimezone: true }).notNull(),
    status: text().$type<'pending' | 'merged' | 'confirmed' | 'rejected' | 'cancelled'>().notNull(),
    accountId: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    decidedBy: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    note: text(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.subjectId),
    index().on(t.fromSubjectId),
    index()
      .on(t.accountId)
      .where(sql`${t.status} = 'pending'`),
    foreignKey({
      name: 'subject_bindings_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'subject_bindings_subject_fk',
      columns: [t.circleId, t.subjectId],
      foreignColumns: [subjects.circleId, subjects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'subject_bindings_from_subject_fk',
      columns: [t.circleId, t.fromSubjectId],
      foreignColumns: [subjects.circleId, subjects.id],
    }).onDelete('cascade'),
    check(
      'subject_bindings_status',
      sql`${t.status} in ('pending', 'merged', 'confirmed', 'rejected', 'cancelled')
        and (${t.status} = 'pending') = (${t.decidedAt} is null)
        and (${t.status} <> 'pending' or ${t.expiresAt} is not null)`,
    ),
  ],
)

export const subjectBindAttempts = pgTable(
  'subject_bind_attempts',
  {
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    clientId: uuid().notNull(),
    key: text().notNull(),
    count: integer().notNull(),
    resetAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.key] }),
    index().on(t.resetAt),
    foreignKey({
      name: 'subject_bind_attempts_client_fk',
      columns: [t.circleId, t.clientId],
      foreignColumns: [clients.circleId, clients.id],
    }).onDelete('cascade'),
  ],
)

export const dreamRuns = pgTable(
  'dream_runs',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    runId: uuid().notNull(),
    trigger: text().notNull(),
    scope: text(),
    ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    model: text(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    changed: integer().notNull().default(0),
    considered: integer().notNull().default(0),
    suggested: integer().notNull().default(0),
    known: integer().notNull().default(0),
    dropped: integer().notNull().default(0),
    more: boolean().notNull().default(false),
    skipped: text(),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.circleId, t.createdAt),
    check('dream_runs_trigger', sql`${t.trigger} in ('scheduled', 'manual')`),
  ],
)

export const dreamSuggestions = pgTable(
  'dream_suggestions',
  {
    id: uuid().primaryKey().defaultRandom(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    scope: text().notNull(),
    ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    entryIds: uuid().array().notNull(),
    versions: integer().array().notNull(),
    keepId: uuid(),
    title: text(),
    content: text(),
    variants: jsonb().$type<VariantInput[] | null>(),
    when: jsonb().$type<WhenCondition | null>(),
    topics: text().array(),
    disclosure: text(),
    verdict: text(),
    targetPriority: integer(),
    reason: text().notNull(),
    fingerprint: text().notNull(),
    status: text().notNull().default('pending'),
    decidedBy: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('dream_suggestions_fingerprint_idx').on(t.circleId, t.fingerprint),
    index().on(t.circleId, t.status, t.createdAt),
    check(
      'dream_suggestions_kind',
      sql`${t.kind} in ('merge', 'merge_variants', 'facet_tag', 'generalize', 'distill', 'distill_episode', 'stale', 'review', 'promote')`,
    ),
    check('dream_suggestions_status', sql`${t.status} in ('pending', 'applied', 'rejected')`),
    check(
      'dream_suggestions_entries',
      sql`cardinality(${t.entryIds}) >= 1 and cardinality(${t.entryIds}) = cardinality(${t.versions})`,
    ),
  ],
)

export const dreamMarks = pgTable(
  'dream_marks',
  {
    entryId: uuid().primaryKey(),
    circleId: uuid()
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'dream_marks_entry_fk',
      columns: [t.circleId, t.entryId],
      foreignColumns: [entries.circleId, entries.id],
    }).onDelete('cascade'),
  ],
)

// 迁移里据此为以下 31 张内容表开启并强制 RLS（新增带 circle_id 的内容表时同步补充）
export const RLS_TABLES = [
  'personas',
  'persona_traits',
  'clients',
  'subjects',
  'subject_identities',
  'client_group_rules',
  'conversations',
  'facet_dimensions',
  'facet_terms',
  'entries',
  'entry_variants',
  'entry_embeddings',
  'entry_links',
  'entry_glossary',
  'entry_events',
  'entry_credential_refs',
  'entry_recall_stats',
  'legacy_uris',
  'vault_connections',
  'credentials',
  'credential_events',
  'recall_events',
  'recall_event_hits',
  'conversation_turns',
  'extraction_runs',
  'subject_bind_codes',
  'subject_bindings',
  'subject_bind_attempts',
  'dream_runs',
  'dream_suggestions',
  'dream_marks',
] as const
