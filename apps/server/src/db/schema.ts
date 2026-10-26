import {
  LAYERS,
  MEMBER_ROLES,
  MEMORY_FORMS,
  PROVENANCES,
  SENSITIVITIES,
  SUBJECT_KINDS,
  type KeyScopes,
} from '@kioku/contracts'
import { sql } from 'drizzle-orm'
import {
  bigserial,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

// 表分两类：身份表（accounts、spaces、space_members、api_keys）在鉴权阶段就要跨空间查询，不开行级安全；
// 其余内容表都带 space_id，由迁移里的 RLS 策略按会话变量 app.space_id 强制隔离。
// 外键检查不受 RLS 约束，所以指向内容表的外键都带上 space_id（复合外键），保证不会关联到别的空间。

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

export const memoryLayer = pgEnum('memory_layer', LAYERS)
export const sensitivity = pgEnum('sensitivity', SENSITIVITIES)
export const provenance = pgEnum('provenance', PROVENANCES)
export const memoryForm = pgEnum('memory_form', MEMORY_FORMS)
export const memberRole = pgEnum('member_role', MEMBER_ROLES)
export const subjectKind = pgEnum('subject_kind', SUBJECT_KINDS)

// ---- 身份表 ----

export const accounts = pgTable('accounts', {
  id: uuid().primaryKey().defaultRandom(),
  username: text().notNull().unique(),
  displayName: text().notNull(),
  passwordHash: text().notNull(),
  createdAt: createdAt(),
})

export const spaces = pgTable('spaces', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdAt: createdAt(),
})

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: memberRole().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.accountId] })],
)

// Key 明文只在创建时返回一次；库里存前缀（用于查找和显示）与整串的 SHA-256
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    appId: uuid().notNull(),
    name: text().notNull(),
    prefix: text().notNull().unique(),
    secretHash: text().notNull(),
    scopes: jsonb().$type<KeyScopes>().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.spaceId),
    foreignKey({ columns: [t.spaceId, t.appId], foreignColumns: [apps.spaceId, apps.id] }).onDelete(
      'cascade',
    ),
  ],
)

// ---- 内容表（RLS）----

export const personas = pgTable(
  'personas',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    extendsId: uuid().references((): AnyPgColumn => personas.id, { onDelete: 'set null' }),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.spaceId, t.slug), unique().on(t.spaceId, t.id)],
)

// 一个接入方实例；ownerAccountId 是这个 bot 的「主人」，决定 owner 层读谁的画像
export const apps = pgTable(
  'apps',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    runtimeFamily: text().notNull(),
    ownerAccountId: uuid()
      .notNull()
      .references(() => accounts.id),
    defaultPersonaId: uuid().references(() => personas.id, { onDelete: 'set null' }),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.spaceId, t.slug), unique().on(t.spaceId, t.id)],
)

export const subjects = pgTable(
  'subjects',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    kind: subjectKind().notNull(),
    displayName: text().notNull(),
    // 对象就是空间成员本人时填；用来认出「主人」
    accountId: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.spaceId), unique().on(t.spaceId, t.id)],
)

// 平台账号到对象的映射；合并对象就是把多条 identity 指向同一个 subject
export const subjectIdentities = pgTable(
  'subject_identities',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    subjectId: uuid().notNull(),
    platform: text().notNull(),
    externalId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex().on(t.spaceId, t.platform, t.externalId),
    index().on(t.subjectId),
    foreignKey({
      columns: [t.spaceId, t.subjectId],
      foreignColumns: [subjects.spaceId, subjects.id],
    }).onDelete('cascade'),
  ],
)

export const memories = pgTable(
  'memories',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    form: memoryForm().notNull(),
    layer: memoryLayer().notNull(),
    sensitivity: sensitivity().notNull(),
    provenance: provenance().notNull(),
    // global | app:<id> | group:<subject id> | direct:<subject id>
    originScope: text().notNull().default('global'),
    // 归属：按层只填其中一个，约束见下方 check
    ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'cascade' }),
    personaId: uuid(),
    appId: uuid(),
    subjectId: uuid(),
    // 策展记忆的 URI = domain://path；抽取记忆没有 URI
    domain: text(),
    path: text(),
    // secret 级只存密文：content 为空，ciphertext 与被主密钥包装过的数据密钥成对出现
    content: text(),
    ciphertext: bytea(),
    wrappedKey: bytea(),
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
    uniqueIndex('memories_uri_live_idx')
      .on(t.spaceId, t.domain, t.path)
      .where(sql`${t.deletedAt} is null`),
    index().on(t.spaceId, t.layer),
    index().on(t.subjectId),
    unique().on(t.spaceId, t.id),
    foreignKey({
      columns: [t.spaceId, t.personaId],
      foreignColumns: [personas.spaceId, personas.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.spaceId, t.appId], foreignColumns: [apps.spaceId, apps.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      columns: [t.spaceId, t.subjectId],
      foreignColumns: [subjects.spaceId, subjects.id],
    }).onDelete('cascade'),
    check(
      'memories_uri_by_form',
      sql`(${t.form} = 'curated') = (${t.domain} is not null and ${t.path} is not null)`,
    ),
    check(
      'memories_secret_encrypted',
      sql`case when ${t.sensitivity} = 'secret'
        then ${t.content} is null and ${t.ciphertext} is not null and ${t.wrappedKey} is not null
        else ${t.content} is not null and ${t.ciphertext} is null and ${t.wrappedKey} is null end`,
    ),
    check(
      'memories_owner_by_layer',
      sql`(${t.layer} in ('owner', 'private')) = (${t.ownerAccountId} is not null)
        and (${t.layer} = 'persona') = (${t.personaId} is not null)
        and (${t.layer} = 'app') = (${t.appId} is not null)
        and (${t.layer} = 'subject') = (${t.subjectId} is not null)`,
    ),
    check(
      'memories_untrusted_layers',
      sql`${t.provenance} <> 'untrusted' or ${t.layer} in ('subject', 'episode')`,
    ),
    check('memories_priority_nonneg', sql`${t.priority} >= 0`),
  ],
)

export const memoryGlossary = pgTable(
  'memory_glossary',
  {
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    memoryId: uuid().notNull(),
    keyword: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.keyword] }),
    index().on(t.spaceId, t.keyword),
    foreignKey({
      columns: [t.spaceId, t.memoryId],
      foreignColumns: [memories.spaceId, memories.id],
    }).onDelete('cascade'),
  ],
)

// 每次写入一条事件，带前后快照，用于历史、回滚与审计
export const memoryEvents = pgTable(
  'memory_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    memoryId: uuid().references(() => memories.id, { onDelete: 'set null' }),
    eventType: text().notNull(),
    actorKeyId: uuid(),
    actorAccountId: uuid(),
    provenance: provenance().notNull(),
    before: jsonb(),
    after: jsonb(),
    context: jsonb().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.spaceId, t.createdAt), index().on(t.memoryId, t.createdAt)],
)

// 迁移里据此给这些表开启并强制 RLS；新增内容表时同步加进来
export const RLS_TABLES = [
  'personas',
  'apps',
  'subjects',
  'subject_identities',
  'memories',
  'memory_glossary',
  'memory_events',
] as const
