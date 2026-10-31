import {
  CREDENTIAL_PROVIDER_KINDS,
  DEFAULT_EXTRACTION_DAILY_WRITES,
  DEFAULT_EXTRACTION_MONTHLY_TOKENS,
  CREDENTIAL_SOURCES,
  LAYERS,
  MEMBER_ROLES,
  MEMORY_FORMS,
  PROVENANCES,
  SENSITIVITIES,
  SUBJECT_KINDS,
  type CredentialField,
  type KeyScopes,
  type PlainLayer,
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
export const credentialProviderKind = pgEnum('credential_provider_kind', CREDENTIAL_PROVIDER_KINDS)
export const credentialSource = pgEnum('credential_source', CREDENTIAL_SOURCES)

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
  // domain → 管理界面新建记忆时带出的层（只能是 base、owner、private）
  domainLayers: jsonb().$type<Record<string, PlainLayer>>().notNull().default({}),
  // 抽取预算：每月最多用多少 token（UTC 自然月），每个对象每天最多写几条事实
  extractionMonthlyTokens: integer().notNull().default(DEFAULT_EXTRACTION_MONTHLY_TOKENS),
  extractionDailyWrites: integer().notNull().default(DEFAULT_EXTRACTION_DAILY_WRITES),
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
    // 让不让 Dream 整理这个成员的画像层与私人层（secret 本来就不读）：默认整理，只有本人能改。
    // 关掉之后这两层不发给抽取模型，整理标记也不前进，再打开时接着看关掉期间新增与改动的（见 extraction/dream.ts）
    dreamPrivate: boolean().notNull().default(true),
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

// 登录失败计数，一个计数键一行（「用户名」或「用户名 + 客户端」，见 auth/rateLimit.ts）；放在数据库里而不是进程内存：
// 并发请求用原子加一计数，不需要淘汰策略，也就不会被随机用户名挤掉或塞满
export const loginAttempts = pgTable(
  'login_attempts',
  {
    // 计数键：用户名，或用户名加客户端，编码见 auth/rateLimit.ts
    username: text().primaryKey(),
    count: integer().notNull(),
    resetAt: timestamp({ withTimezone: true }).notNull(),
  },
  // 清理过期计数按 reset_at 删除
  (t) => [index().on(t.resetAt)],
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
    // 成员在管理界面改过名字：之后平台上的显示名再变也不跟着改
    nameLocked: boolean().notNull().default(false),
    // 对象就是空间成员本人时填；用来认出「主人」
    accountId: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 对象页按第一次遇到的时间从新到旧翻页；只按空间查的也用它
    index().on(t.spaceId, t.createdAt, t.id),
    unique().on(t.spaceId, t.id),
    // 平台账号按种类挂到对象上（见 subject_identities 的外键）
    unique().on(t.spaceId, t.id, t.kind),
  ],
)

// 平台账号到对象的映射；合并对象就是把多条 identity 指向同一个 subject。
// 账号按种类区分：QQ 的群号与 QQ 号是两套编号，同一个数字可能既是群又是人。
// 外键带上种类，平台账号只能挂到同种类的对象上，人和群合并不到一起
export const subjectIdentities = pgTable(
  'subject_identities',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    subjectId: uuid().notNull(),
    kind: subjectKind().notNull(),
    platform: text().notNull(),
    externalId: text().notNull(),
    // 平台上的显示名，随上报更新
    displayName: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex().on(t.spaceId, t.platform, t.kind, t.externalId),
    index().on(t.subjectId),
    foreignKey({
      name: 'subject_identities_subject_fk',
      columns: [t.spaceId, t.subjectId, t.kind],
      foreignColumns: [subjects.spaceId, subjects.id, subjects.kind],
    }).onDelete('cascade'),
  ],
)

// 按群换人格：应用在某个群（或频道）里用的人格。没有规则的群与私聊用应用的默认人格。
// 人格被规则用着时不能删（删除人格的接口先检查，外键兜底）；群对象或应用删掉时规则跟着删
export const appGroupPersonas = pgTable(
  'app_group_personas',
  {
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    appId: uuid().notNull(),
    subjectId: uuid().notNull(),
    personaId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.subjectId] }),
    index().on(t.personaId),
    index().on(t.subjectId),
    foreignKey({ columns: [t.spaceId, t.appId], foreignColumns: [apps.spaceId, apps.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      columns: [t.spaceId, t.subjectId],
      foreignColumns: [subjects.spaceId, subjects.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.spaceId, t.personaId],
      foreignColumns: [personas.spaceId, personas.id],
    }),
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
    // 包装数据密钥用的主密钥的标识（crypto/keyring.ts）：轮换时按它找出还是旧密钥包装的记录
    keyId: text(),
    // 忽略明文提示时正文的 SHA-256（十六进制）：和现在的正文对得上才算忽略，正文一改提示自动回来。
    // 不进事件快照，也不随空间导出（历史不跟着走，到了那边查不到是谁忽略的）；
    // 正文变化、改成 secret 时清掉：它是含旧值的正文的哈希，能离线猜解，密文的哈希也不能留在明文列里
    plaintextIgnoredHash: text(),
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
    // 轮换主密钥时按主密钥的标识找加密的行；只建在加密的行上（secret 不多）
    index('memories_key_id_idx')
      .on(t.spaceId, t.keyId)
      .where(sql`${t.wrappedKey} is not null`),
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

// 凭据源：成员自己的密码管理器（或别的取值方式）以及给 agent 看的使用说明。和凭据一样归某个成员，
// 只有他本人看得到、用得上：使用说明会下发给他的 agent，不能让别人改。软删除，绑定它的凭据仍指向它
export const credentialProviders = pgTable(
  'credential_providers',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    ownerAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: credentialProviderKind().notNull(),
    name: text().notNull(),
    instructions: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.spaceId, t.ownerAccountId), unique().on(t.spaceId, t.ownerAccountId, t.id)],
)

// 凭据：归某个成员，记忆正文用 {{cred:<标识>}} 引用。值要么由 Kioku 加密保存（hosted），
// 要么在外部凭据源里、这里只存条目位置（external）。软删除，可以恢复
export const credentials = pgTable(
  'credentials',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    ownerAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // 创建后不能改：记忆按它引用
    identifier: text().notNull(),
    name: text().notNull(),
    description: text(),
    source: credentialSource().notNull(),
    providerId: uuid(),
    // 外部来源的条目位置
    location: text(),
    // 字段名，外部来源再加上条目里对应的字段；托管的值不在这里
    fields: jsonb().$type<CredentialField[]>().notNull().default([]),
    // 托管的值：各字段的值整体加密，aad 绑定凭据 id（见 credential/service.ts）
    ciphertext: bytea(),
    wrappedKey: bytea(),
    // 包装数据密钥用的主密钥的标识，同记忆的 keyId
    keyId: text(),
    // 只给这些应用用；null 表示不限定
    appIds: uuid().array(),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // 标识在同一个成员的有效凭据里唯一：建凭据时不会因为别人用过同一个标识而冲突
    uniqueIndex('credentials_identifier_live_idx')
      .on(t.spaceId, t.ownerAccountId, t.identifier)
      .where(sql`${t.deletedAt} is null`),
    unique().on(t.spaceId, t.id),
    // 数凭据源上绑着几条有效的凭据（凭据源列表、删除凭据源时）
    index('credentials_provider_live_idx')
      .on(t.providerId)
      .where(sql`${t.deletedAt} is null`),
    // 轮换主密钥时按主密钥的标识找托管的凭据
    index('credentials_key_id_idx')
      .on(t.spaceId, t.keyId)
      .where(sql`${t.wrappedKey} is not null`),
    // 凭据源必须是同一个成员的：外键带上主人。自动生成的约束名超过 PostgreSQL 的 63 字符上限，这里起短名
    foreignKey({
      name: 'credentials_provider_fk',
      columns: [t.spaceId, t.ownerAccountId, t.providerId],
      foreignColumns: [
        credentialProviders.spaceId,
        credentialProviders.ownerAccountId,
        credentialProviders.id,
      ],
    }),
    check(
      'credentials_source_shape',
      sql`case when ${t.source} = 'hosted'
        then ${t.ciphertext} is not null and ${t.wrappedKey} is not null and ${t.providerId} is null and ${t.location} is null
        else ${t.ciphertext} is null and ${t.wrappedKey} is null and ${t.providerId} is not null and ${t.location} is not null end`,
    ),
  ],
)

// 凭据的事件：新建、修改、删除、撤销删除与取用。只有凭据的主人看得到，不进空间的活动记录；不含任何值
export const credentialEvents = pgTable(
  'credential_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    credentialId: uuid().notNull(),
    eventType: text().notNull(),
    actorKeyId: uuid(),
    actorAccountId: uuid(),
    // 取用经由哪里、取了哪些字段，修改了哪些部分
    context: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    // 一条凭据的事件按 id 倒序翻页
    index().on(t.credentialId, t.id),
    foreignKey({
      name: 'credential_events_credential_fk',
      columns: [t.spaceId, t.credentialId],
      foreignColumns: [credentials.spaceId, credentials.id],
    }).onDelete('cascade'),
  ],
)

// 记忆正文里引用了哪些凭据标识：列出一条凭据被哪些记忆用着、挡住删除。每次写入按正文重写这条记忆的引用，
// secret 的不进来（明文标识会透露加密正文写的是什么）。算不算数在查询时与记忆表关联判断
// （没删除、不是 secret、仍有效、在凭据主人的私人层），所以删除、撤销删除、让出 URI 都不用另外维护
export const memoryCredentialRefs = pgTable(
  'memory_credential_refs',
  {
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    memoryId: uuid().notNull(),
    identifier: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.identifier] }),
    index().on(t.spaceId, t.identifier),
    foreignKey({
      name: 'memory_credential_refs_memory_fk',
      columns: [t.spaceId, t.memoryId],
      foreignColumns: [memories.spaceId, memories.id],
    }).onDelete('cascade'),
  ],
)

// 召回事件：会话开始的项目召回、每轮输入的召回、MCP 搜索与 REST 召回各记一条，管理界面里的搜索与调试不记。
// 明细保留一段时间（实例设置），清理前把次数并入 memory_recall_stats。明细只给事件发生时的应用主人看：
// 里面有那位主人的提示语和私人层的命中，应用转给别人之后不跟着转。不挂应用的外键：删掉应用之后，
// 它召回过的次数仍算在记忆上，明细到期照常清理
export const recallEvents = pgTable(
  'recall_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    appId: uuid().notNull(),
    keyId: uuid(),
    // 事件发生时的应用主人
    ownerAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    source: text().notNull(),
    // 提示语的前 200 字，像凭据的片段已打码；应用关掉了记录提示语时为空
    query: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.spaceId, t.createdAt),
    index().on(t.appId, t.createdAt),
    // 明细只给事件里记下的主人，按主人与应用翻页（应用详情里看的就是这样）
    index().on(t.spaceId, t.ownerAccountId, t.appId, t.id),
  ],
)

// 一次召回命中了哪些记忆：名次（从 1 开始）、分数与来路
export const recallEventHits = pgTable(
  'recall_event_hits',
  {
    eventId: bigint({ mode: 'number' })
      .notNull()
      .references(() => recallEvents.id, { onDelete: 'cascade' }),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    memoryId: uuid().notNull(),
    rank: smallint().notNull(),
    score: real().notNull(),
    via: text().array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.memoryId] }),
    index().on(t.spaceId, t.memoryId),
    foreignKey({
      name: 'recall_event_hits_memory_fk',
      columns: [t.spaceId, t.memoryId],
      foreignColumns: [memories.spaceId, memories.id],
    }).onDelete('cascade'),
  ],
)

// 每条记忆的累计召回次数：清理明细前并入，之后只剩次数与最后一次召回的时间
export const memoryRecallStats = pgTable(
  'memory_recall_stats',
  {
    memoryId: uuid().primaryKey(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    count: integer().notNull(),
    lastRecalledAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'memory_recall_stats_memory_fk',
      columns: [t.spaceId, t.memoryId],
      foreignColumns: [memories.spaceId, memories.id],
    }).onDelete('cascade'),
  ],
)

// 会话缓冲：私聊与群聊里一轮轮的对话，只是抽取的输入。攒批抽取完就删，空闲超过一天的也删，
// 不进召回、不进活动，也没有读取的接口（群聊原文里有别人的话，不该长期留）。
// 按应用与来源作用域（本群，或与此人的私聊）分批，不按插件给的会话标识：标识重了也不会把私聊混进群里的那一批。
// 会话上下文按这一轮解析出的对象记下；抽取时按写入这一轮的 Key 重新算权限，Key 吊销或作废就不抽取
export const conversationTurns = pgTable(
  'conversation_turns',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    appId: uuid().notNull(),
    keyId: uuid()
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    // group:<群对象> 或 direct:<发言人对象>，和这一批抽取写下的记忆的来源作用域相同
    scope: text().notNull(),
    // 插件给的会话标识，只做记录
    sessionId: text().notNull(),
    // direct | group | channel
    chatType: text().notNull(),
    groupSubjectId: uuid(),
    senderSubjectId: uuid().notNull(),
    // 这一轮上报的发言人名字（群里可能是群名片），抽取时给模型分清谁说的
    senderName: text(),
    userText: text().notNull(),
    replyText: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.appId, t.scope, t.id),
    foreignKey({ columns: [t.spaceId, t.appId], foreignColumns: [apps.spaceId, apps.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      name: 'conversation_turns_group_fk',
      columns: [t.spaceId, t.groupSubjectId],
      foreignColumns: [subjects.spaceId, subjects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversation_turns_sender_fk',
      columns: [t.spaceId, t.senderSubjectId],
      foreignColumns: [subjects.spaceId, subjects.id],
    }).onDelete('cascade'),
    check(
      'conversation_turns_chat_type',
      sql`${t.chatType} in ('direct', 'group', 'channel')
        and (${t.chatType} = 'direct') = (${t.groupSubjectId} is null)`,
    ),
  ],
)

// 抽取记录：每抽取一批缓冲记一条，给对象页看抽取了什么、用了多少 token；失败的也记，带上原因
export const extractionRuns = pgTable(
  'extraction_runs',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    appId: uuid().notNull(),
    // 这一批的来源作用域，见 conversation_turns.scope
    scope: text().notNull(),
    // 这一批涉及的对象（发言人与群），对象页按它找抽取记录
    subjectIds: uuid().array().notNull(),
    // 给模型看了几轮；写入它们的 Key 吊销、作废或写不了的那几轮没给模型看，单独计数，随这一批删掉
    turns: integer().notNull(),
    skippedTurns: integer().notNull().default(0),
    model: text(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    added: integer().notNull().default(0),
    updated: integer().notNull().default(0),
    // 模型认为已经记过的（NONE），以及和已有事实一字不差的
    unchanged: integer().notNull().default(0),
    // 丢掉的候选：对象不对、太长、像明文凭据、写不进去
    dropped: integer().notNull().default(0),
    summarized: boolean().notNull().default(false),
    // 本月的 token 预算用完了，这一批只写了会话摘要
    summaryOnly: boolean().notNull().default(false),
    // 对象当天写满了条数、没写的事实
    limited: integer().notNull().default(0),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.spaceId, t.createdAt),
    index().using('gin', t.subjectIds),
    foreignKey({ columns: [t.spaceId, t.appId], foreignColumns: [apps.spaceId, apps.id] }).onDelete(
      'cascade',
    ),
  ],
)

// 绑定码：在私聊里用 Key 申请，到另一个平台的私聊里带上它，把那边的对象并进申请的对象（见 access/binding.ts）。
// 库里只存哈希。同一个对象再申请时旧的删掉，在群里发出来的也删掉；过期的（用过的也是 10 分钟就过期）由每小时的清理删掉。
// 发码的对象被合并掉时跟着删。只活几分钟，不进备份
export const subjectBindCodes = pgTable(
  'subject_bind_codes',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    // 只能在同一个应用里使用
    appId: uuid().notNull(),
    // 申请时用的 Key，只做记录
    keyId: uuid().notNull(),
    // 发码的对象，以及申请时用的平台账号
    subjectId: uuid().notNull(),
    platform: text().notNull(),
    externalId: text().notNull(),
    codeHash: text().notNull(),
    // 预览过这个码的收码对象（只留最近几个）：预览过的才能接着确认合并，没预览过就确认的先给预览，
    // 收码的人总会先看到要并到谁那里
    previewedBy: uuid()
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // 同一个应用里的码不重复，用码时按应用找
    uniqueIndex().on(t.appId, t.codeHash),
    index().on(t.subjectId),
    index().on(t.expiresAt),
    foreignKey({ columns: [t.spaceId, t.appId], foreignColumns: [apps.spaceId, apps.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      name: 'subject_bind_codes_subject_fk',
      columns: [t.spaceId, t.subjectId],
      foreignColumns: [subjects.spaceId, subjects.id],
    }).onDelete('cascade'),
  ],
)

// 绑定记录：每用成一次绑定码记一条。发码的对象没有标记成员时马上把收码的对象并进来（merged）；
// 标记了成员时等那个成员本人在管理界面确认（pending，有期限），确认后合并，也可能被拒绝、过期，
// 或者等确认期间两边的对象被合并而作废（cancelled）。合并对象时指向被合并掉的对象的记录改指向保留的，
// 对象页按对象找得到。处理完的过了保留期由清理删掉
export const subjectBindings = pgTable(
  'subject_bindings',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    appId: uuid().notNull(),
    // 收码时用的 Key，只做记录
    keyId: uuid().notNull(),
    // 发码的对象：并到这里
    subjectId: uuid().notNull(),
    // 收码的对象：并进 subjectId
    fromSubjectId: uuid().notNull(),
    // 收码时用的平台账号与平台上的名字
    platform: text().notNull(),
    externalId: text().notNull(),
    displayName: text(),
    // 申请绑定码的平台账号与时间
    issuedPlatform: text().notNull(),
    issuedExternalId: text().notNull(),
    issuedAt: timestamp({ withTimezone: true }).notNull(),
    // pending | merged | confirmed | rejected | cancelled；过了期限还没处理的是 pending，按 expires_at 判断过期
    status: text().$type<'pending' | 'merged' | 'confirmed' | 'rejected' | 'cancelled'>().notNull(),
    // 要谁确认：收码时发码的对象标记成的成员
    accountId: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    decidedBy: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    // 作废的原因
    note: text(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.subjectId),
    index().on(t.fromSubjectId),
    // 概览里列出等某个成员确认的
    index()
      .on(t.accountId)
      .where(sql`${t.status} = 'pending'`),
    foreignKey({ columns: [t.spaceId, t.appId], foreignColumns: [apps.spaceId, apps.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      name: 'subject_bindings_subject_fk',
      columns: [t.spaceId, t.subjectId],
      foreignColumns: [subjects.spaceId, subjects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'subject_bindings_from_subject_fk',
      columns: [t.spaceId, t.fromSubjectId],
      foreignColumns: [subjects.spaceId, subjects.id],
    }).onDelete('cascade'),
    check(
      'subject_bindings_status',
      sql`${t.status} in ('pending', 'merged', 'confirmed', 'rejected', 'cancelled')
        and (${t.status} = 'pending') = (${t.decidedAt} is null)
        and (${t.status} <> 'pending' or ${t.expiresAt} is not null)`,
    ),
  ],
)

// 输错绑定码的计数：一个计数键一行（收码的平台账号，或整个应用，见 access/binding.ts），一小时一个窗口。
// 和登录失败计数一样放在数据库里原子递增；每小时的清理删掉过了窗口的。不进备份
export const subjectBindAttempts = pgTable(
  'subject_bind_attempts',
  {
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    appId: uuid().notNull(),
    key: text().notNull(),
    count: integer().notNull(),
    resetAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.key] }),
    index().on(t.resetAt),
    foreignKey({ columns: [t.spaceId, t.appId], foreignColumns: [apps.spaceId, apps.id] }).onDelete(
      'cascade',
    ),
  ],
)

// Dream 的运行记录：一次整理（每天一次或手动）逐个范围记一条，整次没走到范围时（没配模型、预算用完、没有新内容）
// 记一条范围为空的；同一次整理的几条 run_id 相同。用量计入抽取的同一份月度预算（见 extraction/budget.ts），
// 保留期的清理和抽取记录一样留着本月的。范围是某个成员的画像层或私人层时记下这个成员，只给他看
export const dreamRuns = pgTable(
  'dream_runs',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    runId: uuid().notNull(),
    // scheduled | manual
    trigger: text().notNull(),
    // 范围，见 memory/scopes.ts 的 DREAM_SCOPE_KEY
    scope: text(),
    ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    model: text(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    // 给模型看了几条：上次以来新增或改动的，以及连同近邻一共几条
    changed: integer().notNull().default(0),
    considered: integer().notNull().default(0),
    // 新提的建议、和已有的建议一样的（包括拒绝过的）、不合规则丢掉的
    suggested: integer().notNull().default(0),
    known: integer().notNull().default(0),
    dropped: integer().notNull().default(0),
    // 这个范围还有没看完的，下次接着整理
    more: boolean().notNull().default(false),
    // 没整理的原因：no-model | budget | idle
    skipped: text(),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.spaceId, t.createdAt),
    check('dream_runs_trigger', sql`${t.trigger} in ('scheduled', 'manual')`),
  ],
)

// Dream 的建议：进待审，成员确认后才按建议执行，Dream 自己不写记忆。涉及的记忆与生成时各自的版本按下标对应，
// 执行时版本对不上就不执行。指纹是「种类 + 涉及的记忆 id 与版本」，在空间里唯一：还在待审的、执行过的、拒绝过的
// 都不再提；涉及的记忆改过之后版本变了，指纹也跟着变，可以再提。范围是某个成员的画像层或私人层时记下这个成员
export const dreamSuggestions = pgTable(
  'dream_suggestions',
  {
    id: uuid().primaryKey().defaultRandom(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    scope: text().notNull(),
    ownerAccountId: uuid().references(() => accounts.id, { onDelete: 'cascade' }),
    // merge | distill | stale | review
    kind: text().notNull(),
    memoryIds: uuid().array().notNull(),
    versions: integer().array().notNull(),
    // 合并：保留的那一条
    keepId: uuid(),
    // 合并后的正文；提炼的草稿正文、URI 与 disclosure
    content: text(),
    uri: text(),
    disclosure: text(),
    // 审核：confirm | delete
    verdict: text(),
    reason: text().notNull(),
    fingerprint: text().notNull(),
    // pending | applied | rejected
    status: text().notNull().default('pending'),
    decidedBy: uuid().references(() => accounts.id, { onDelete: 'set null' }),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('dream_suggestions_fingerprint_idx').on(t.spaceId, t.fingerprint),
    // 待审里按状态与时间翻页
    index().on(t.spaceId, t.status, t.createdAt),
    check('dream_suggestions_kind', sql`${t.kind} in ('merge', 'distill', 'stale', 'review')`),
    check('dream_suggestions_status', sql`${t.status} in ('pending', 'applied', 'rejected')`),
    check(
      'dream_suggestions_memories',
      sql`cardinality(${t.memoryIds}) >= 1 and cardinality(${t.memoryIds}) = cardinality(${t.versions})`,
    ),
  ],
)

// Dream 整理过的记忆与当时的版本：下次只看没有标记、或者标记之后改过（版本变了）的记忆。不按时间判断，
// 导入的（带着原来的更新时间）、写了很久才提交的都看得到；整理过、没改过的不会再给模型看。随记忆一起删掉
export const dreamMarks = pgTable(
  'dream_marks',
  {
    memoryId: uuid().primaryKey(),
    spaceId: uuid()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'dream_marks_memory_fk',
      columns: [t.spaceId, t.memoryId],
      foreignColumns: [memories.spaceId, memories.id],
    }).onDelete('cascade'),
  ],
)

// 迁移里据此给这些表开启并强制 RLS；新增内容表时同步加进来
export const RLS_TABLES = [
  'personas',
  'apps',
  'subjects',
  'subject_identities',
  'app_group_personas',
  'memories',
  'memory_embeddings',
  'memory_glossary',
  'memory_events',
  'credential_providers',
  'credentials',
  'credential_events',
  'memory_credential_refs',
  'recall_events',
  'recall_event_hits',
  'memory_recall_stats',
  'conversation_turns',
  'extraction_runs',
  'subject_bind_codes',
  'subject_bindings',
  'subject_bind_attempts',
  'dream_runs',
  'dream_suggestions',
  'dream_marks',
] as const
