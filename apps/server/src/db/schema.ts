import type {
  ArchivedHistoryNote,
  DreamSuggestionKind,
  DreamSuggestionStatus,
  EntryDiffMeta,
  EntryEventType,
  EntryKind,
  EntrySnapshot,
  RuntimeFamily,
} from '@kioku/contracts'
import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

// 整个实例共用同一个向量维度（1024 维在 pgvector HNSW 索引上限 2000 之内）
export const EMBEDDING_DIMENSIONS = 1024

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

// ---- 单人账号、会话与实例配置 ----

export const accounts = pgTable('accounts', {
  id: uuid().primaryKey().defaultRandom(),
  username: text().notNull().unique(),
  displayName: text().notNull(),
  passwordHash: text().notNull(),
  createdAt: createdAt(),
})

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
  (t) => [
    index('sessions_account_idx').on(t.accountId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
)

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt(),
})

// ---- 终端访问密钥与浏览器设备授权 ----

export const apiKeys = pgTable('api_keys', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  runtimeFamily: text().$type<RuntimeFamily>().notNull().default('generic'),
  prefix: text().notNull().unique(),
  secretHash: text().notNull(),
  envs: text()
    .array()
    .notNull()
    .default(sql`'{}'`),
  // null 表示不限场域；非 null 时为硬性静态场域边界
  allowedRealms: text().array(),
  canWrite: boolean().notNull().default(true),
  canResolveCredentials: boolean().notNull().default(false),
  createdAt: createdAt(),
  lastUsedAt: timestamp({ withTimezone: true }),
  revokedAt: timestamp({ withTimezone: true }),
})

export interface DeviceGrantPlatform {
  runtimeFamily: RuntimeFamily
  clientName: string | null
}

export type DeviceGrantSelection =
  | { runtimeFamily: RuntimeFamily; skip: true }
  | {
      runtimeFamily: RuntimeFamily
      keyName: string
    }

export const deviceGrants = pgTable(
  'device_grants',
  {
    id: uuid().primaryKey().defaultRandom(),
    deviceHash: text().notNull().unique(),
    userHash: text().notNull().unique(),
    runtimeFamily: text().$type<RuntimeFamily>(),
    platforms: jsonb().$type<DeviceGrantPlatform[]>(),
    clientName: text(),
    clientAddress: text(),
    clientKey: text().notNull(),
    status: text().$type<'pending' | 'approved' | 'denied'>().notNull().default('pending'),
    selections: jsonb().$type<DeviceGrantSelection[]>(),
    keyName: text(),
    envs: text().array(),
    allowedRealms: text().array(),
    canWrite: boolean(),
    canResolveCredentials: boolean(),
    approvedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastPolledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('device_grants_expires_idx').on(t.expiresAt),
    index('device_grants_client_key_idx').on(t.clientKey),
    check('device_grants_status_check', sql`${t.status} in ('pending', 'approved', 'denied')`),
    check(
      'device_grants_platforms_shape',
      sql`(${t.runtimeFamily} is null) <> (${t.platforms} is null)`,
    ),
  ],
)

// ---- 扁平核心记忆、向量、双链与版本历史 ----

export const entries = pgTable(
  'entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    shortId: text().notNull().unique(),
    kind: text().$type<EntryKind>().notNull().default('entry'),
    title: text().notNull(),
    summary: text(),
    content: text().notNull(),
    disclosure: text(),
    isPinned: boolean().notNull().default(false),
    envs: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    realms: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    projects: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    runtimes: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    topics: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    deviceKey: text(),
    projectSlug: text(),
    // 写入时同步拼接短 ID、主题与场景标签，保证下方 generated 全文索引列只调用不可变函数
    searchTags: text().notNull().default(''),
    validTo: timestamp({ withTimezone: true }),
    verifiedAt: timestamp({ withTimezone: true }),
    lastChangeSummary: text(),
    version: integer().notNull().default(1),
    dreamCheckedVersion: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
    fts: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('kioku_zh'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('kioku_zh'::regconfig, coalesce(summary, '') || ' ' || coalesce(disclosure, '') || ' ' || coalesce(search_tags, '')), 'B') || setweight(to_tsvector('kioku_zh'::regconfig, content), 'C')`,
    ),
  },
  (t) => [
    index('entries_fts_idx').using('gin', t.fts),
    index('entries_realms_gin_idx').using('gin', t.realms),
    index('entries_projects_gin_idx').using('gin', t.projects),
    index('entries_topics_gin_idx').using('gin', t.topics),
    index('entries_episodes_scope_idx')
      .on(t.deviceKey, t.projectSlug, t.createdAt)
      .where(sql`${t.kind} = 'episode' and ${t.deletedAt} is null`),
    index('entries_pinned_active_idx')
      .on(t.createdAt, t.shortId)
      .where(sql`${t.isPinned} = true and ${t.deletedAt} is null`),
    index('entries_deleted_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    check('entries_short_id_format', sql`${t.shortId} ~ '^m-[2-9a-hjkmnp-tv-z]{6,8}$'`),
    check('entries_kind_check', sql`${t.kind} in ('entry', 'episode')`),
    check('entries_episode_not_pinned', sql`${t.kind} <> 'episode' or not ${t.isPinned}`),
    check('entries_version_positive', sql`${t.version} >= 1`),
  ],
)

export const entryEmbeddings = pgTable(
  'entry_embeddings',
  {
    entryId: uuid()
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    model: text().notNull(),
    contentHash: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.model] }),
    index('entry_embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
)

export const entryLinks = pgTable(
  'entry_links',
  {
    sourceEntryId: uuid()
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    targetShortId: text().notNull(),
    relation: text(),
    contextSnippet: text(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceEntryId, t.targetShortId] }),
    index('entry_links_target_idx').on(t.targetShortId),
    check('entry_links_target_format', sql`${t.targetShortId} ~ '^m-[2-9a-hjkmnp-tv-z]{6,8}$'`),
  ],
)

export const entryEvents = pgTable(
  'entry_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    entryId: uuid()
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    eventType: text().$type<EntryEventType>().notNull(),
    actor: text().notNull(),
    changeSummary: text(),
    diffMeta: jsonb().$type<EntryDiffMeta | null>(),
    occurredAt: timestamp({ withTimezone: true }),
    snapshot: jsonb().$type<EntrySnapshot>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('entry_events_entry_idx').on(t.entryId, t.id),
    check(
      'entry_events_type_check',
      sql`${t.eventType} in ('create', 'update', 'delete', 'undelete', 'restore', 'archive_note')`,
    ),
  ],
)

// ---- 极简托管加密凭据 ----

export const credentials = pgTable(
  'credentials',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    label: text().notNull(),
    description: text(),
    allowedRealms: text().array(),
    ciphertext: bytea().notNull(),
    wrappedKey: bytea().notNull(),
    keyId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('credentials_key_id_idx').on(t.keyId),
    check('credentials_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
  ],
)

// ---- 会话轮次缓冲与 Dream 待审队列 ----

export const turnBuffer = pgTable(
  'turn_buffer',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    keyId: uuid()
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    deviceKey: text().notNull().default(''),
    projectSlug: text().notNull().default(''),
    sessionId: text().notNull(),
    userText: text().notNull(),
    replyText: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('turn_buffer_scope_idx').on(t.deviceKey, t.projectSlug, t.id)],
)

export const dreamSuggestions = pgTable(
  'dream_suggestions',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().$type<DreamSuggestionKind>().notNull(),
    entryIds: uuid().array().notNull(),
    entryVersions: integer().array().notNull(),
    keepId: uuid(),
    proposedTitle: text(),
    proposedSummary: text(),
    proposedContent: text(),
    proposedDisclosure: text(),
    proposedChangeSummary: text(),
    archivedNotes: jsonb().$type<ArchivedHistoryNote[] | null>(),
    proposedTopics: text().array(),
    proposedEnvs: text().array(),
    proposedRealms: text().array(),
    proposedProjects: text().array(),
    proposedRuntimes: text().array(),
    reason: text().notNull(),
    fingerprint: text().notNull().unique(),
    status: text().$type<DreamSuggestionStatus>().notNull().default('pending'),
    createdAt: createdAt(),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('dream_suggestions_status_idx').on(t.status, t.createdAt),
    check(
      'dream_suggestions_kind_check',
      sql`${t.kind} in ('distill_episode', 'merge_duplicates', 'mark_stale', 'update', 'tidy')`,
    ),
    check('dream_suggestions_status_check', sql`${t.status} in ('pending', 'applied', 'rejected')`),
    check(
      'dream_suggestions_entries_check',
      sql`cardinality(${t.entryIds}) >= 1 and cardinality(${t.entryIds}) = cardinality(${t.entryVersions})`,
    ),
  ],
)
