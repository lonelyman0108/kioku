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
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

// 表分两类：身份表（accounts、sessions、login_attempts、spaces、space_members、api_keys）与实例设置（settings）在鉴权阶段就要跨空间查询，不开行级安全；
// 其余内容表都带 space_id，由迁移里的 RLS 策略按会话变量 app.space_id 强制隔离。
// 外键检查不受 RLS 约束，所以指向内容表的外键都带上 space_id（复合外键），保证不会关联到别的空间。

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

// 整个实例只用一个嵌入模型和维度，向量才可比较。1024 维在 pgvector HNSW 索引的上限（2000）之内
export const EMBEDDING_DIMENSIONS = 1024

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
  // 实例管理员：能改嵌入模型等全实例设置；首次初始化创建的账号是管理员
  isAdmin: boolean().notNull().default(false),
  createdAt: createdAt(),
})

// 全实例设置（嵌入模型等），不属于任何空间
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt(),
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

// 管理界面的登录会话；Cookie 里是随机令牌，库里只存它的 SHA-256
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.accountId)],
)

// 登录失败计数，按用户名（小写）一行；放在数据库里而不是进程内存：
// 并发请求用原子加一计数，不需要淘汰策略，也就不会被随机用户名挤掉或塞满
export const loginAttempts = pgTable('login_attempts', {
  username: text().primaryKey(),
  count: integer().notNull(),
  resetAt: timestamp({ withTimezone: true }).notNull(),
})

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
    // 中文全文检索；secret 的 content 为空，不会被索引
    fts: tsvector().generatedAlwaysAs(
      sql`to_tsvector('kioku_zh'::regconfig, coalesce(domain, '') || ' ' || coalesce(path, '') || ' ' || coalesce(disclosure, '') || ' ' || coalesce(content, ''))`,
    ),
  },
  (t) => [
    index('memories_fts_idx').using('gin', t.fts),
    // URI 在空间内唯一，但 owner 与 private 层按成员各存一份：唯一键带上归属成员，
    // 共享层（归属为空）合并成同一个键。两个成员可以各有一条 preferences://user
    uniqueIndex('memories_uri_live_idx')
      .on(
        t.spaceId,
        t.domain,
        t.path,
        sql`coalesce(${t.ownerAccountId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
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

// 每条记忆在当前模型下一条向量；contentHash 是嵌入文本的哈希，没变就不重新请求
export const memoryEmbeddings = pgTable(
  'memory_embeddings',
  {
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    memoryId: uuid().notNull(),
    model: text().notNull(),
    contentHash: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.model] }),
    index('memory_embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    foreignKey({
      columns: [t.spaceId, t.memoryId],
      foreignColumns: [memories.spaceId, memories.id],
    }).onDelete('cascade'),
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
  'memory_embeddings',
  'memory_glossary',
  'memory_events',
] as const
