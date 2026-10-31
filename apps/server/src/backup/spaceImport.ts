import { randomUUID } from 'node:crypto'

import type { SpaceImportCounts, SpaceImportPreview, SpaceImportResult } from '@kioku/contracts'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'

import { lapsed } from '../access/access'
import { placeholderIdentifiers } from '../credential/placeholders'
import { sealCredentialValues } from '../credential/service'
import type { MasterKey } from '../crypto/keyring'
import {
  pgCauseCode,
  pgConstraint,
  pgErrorCode,
  pgMessage,
  withSpace,
  type Db,
  type Tx,
} from '../db/client'
import {
  appGroupPersonas,
  apps,
  credentialEvents,
  credentialProviders,
  credentials,
  memories,
  memoryCredentialRefs,
  memoryEvents,
  memoryGlossary,
  personas,
  spaceMembers,
  spaces,
  subjectIdentities,
  subjects,
} from '../db/schema'
import { MAX_PERSONA_DEPTH } from '../memory/personas'
import {
  MemoryError,
  SNAPSHOT_COLUMNS,
  sealMemoryContent,
  snapshot as memorySnapshot,
} from '../memory/service'
import { APP_DOMAIN, PERSONA_DOMAIN, parseUri } from '../memory/uri'
import { openSpaceExport } from './spaceFormat'
import {
  describeIssue,
  SPACE_EXPORT_FORMAT,
  SPACE_EXPORT_MAX_PLAIN_BYTES,
  SPACE_EXPORT_VERSION,
  SpaceExportHeader,
  SpaceExportHeaderV1,
  SpaceExportRecord,
  type AppRecord,
  type CredentialRecord,
  type GroupPersonaRecord,
  type IdentityRecord,
  type MemoryRecord,
  type PersonaRecord,
  type ProviderRecord,
  type SubjectRecord,
} from './spaceRecords'

// 把空间的导出文件导入成这个实例里的一个新空间，导入人是新空间的 owner。全部在一个事务里写：
// 失败时什么都不留下，新空间也不会出现。id 全部重新生成，文件里的互相指认按新 id 对上；
// 导出人的画像层、私人层、凭据与凭据源归导入人，对象上「这是我」的标记也换成导入人
// （画像层会进导入人的 agent 的启动上下文，所以导入之前先用 inspectSpaceImport 告诉他文件是谁导出的、有多少）。
// secret 记忆与托管的凭据值用这个实例的主密钥重新加密（新的数据密钥，aad 绑新的 id）；
// 没配主密钥而文件里有这两样时拒绝导入，不悄悄丢掉。
// 记忆按导出时的样子写回（来源、来源作用域、有效期、时间都不变；不可信来源的仍是不可信，照样进待审），
// 版本从 1 开始，每条记一条 import 事件；写入时已经通过了导出实例的检查，这里只核对影响数据库约束与读权限的部分

// 记录带上它在正文里是第几行，出错时说得出是哪一行
type Lined<T> = T & { line: number }

export interface ParsedSpaceExport {
  header: SpaceExportHeader
  personas: Lined<PersonaRecord>[]
  apps: Lined<AppRecord>[]
  subjects: Lined<SubjectRecord>[]
  identities: Lined<IdentityRecord>[]
  groupPersonas: Lined<GroupPersonaRecord>[]
  providers: Lined<ProviderRecord>[]
  credentials: Lined<CredentialRecord>[]
  memories: Lined<MemoryRecord>[]
}

const invalid = (detail: string) => new MemoryError(400, `导出文件的内容不对：${detail}`)

function jsonLine(text: string, lineNo: number): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw invalid(`第 ${lineNo} 行不是 JSON`)
  }
}

function parseLine<T>(value: unknown, schema: z.ZodType<T>, lineNo: number): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw invalid(`第 ${lineNo} 行 ${describeIssue(parsed.error)}`)
  return parsed.data
}

// 认得的文件头，按格式版本：这个版本写的，和更早的（读进来换成这个版本的样子）
const HEADERS = new Map<unknown, z.ZodType<SpaceExportHeader>>([
  [1, SpaceExportHeaderV1],
  [SPACE_EXPORT_VERSION, SpaceExportHeader],
])

// 解开之后的正文按行读出：第一行是文件头，之后每行一条记录。先认格式与版本，再按这个版本的定义检查
export function parseSpaceExport(plain: Buffer): ParsedSpaceExport {
  const text = plain.toString('utf8')
  const rows = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  if (!rows[0]) throw invalid('是空的')
  const first = jsonLine(rows[0], 1) as { format?: unknown; version?: unknown } | null
  if (first?.format !== SPACE_EXPORT_FORMAT) {
    throw new MemoryError(400, '不是 Kioku 的空间导出文件')
  }
  const header = HEADERS.get(first.version)
  if (!header) {
    throw new MemoryError(
      400,
      `导出文件的格式版本是 ${String(first.version)}，这个版本的 Kioku 认 1 到 ${SPACE_EXPORT_VERSION}：升级到导出它的版本（或更新的）再导入`,
    )
  }
  const result: ParsedSpaceExport = {
    header: parseLine(first, header, 1),
    personas: [],
    apps: [],
    subjects: [],
    identities: [],
    groupPersonas: [],
    providers: [],
    credentials: [],
    memories: [],
  }
  rows.slice(1).forEach((row, i) => {
    const line = i + 2
    const record = parseLine(jsonLine(row, line), SpaceExportRecord, line)
    switch (record.type) {
      case 'persona':
        return void result.personas.push({ ...record, line })
      case 'app':
        return void result.apps.push({ ...record, line })
      case 'subject':
        return void result.subjects.push({ ...record, line })
      case 'identity':
        return void result.identities.push({ ...record, line })
      case 'groupPersona':
        return void result.groupPersonas.push({ ...record, line })
      case 'provider':
        return void result.providers.push({ ...record, line })
      case 'credential':
        return void result.credentials.push({ ...record, line })
      case 'memory':
        return void result.memories.push({ ...record, line })
    }
  })
  return result
}

function byId<T extends { id: string; line: number }>(items: T[], what: string): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    if (map.has(item.id)) throw invalid(`第 ${item.line} 行${what}的 id 重复：${item.id}`)
    map.set(item.id, item)
  }
  return map
}

function distinct<T extends { line: number }>(
  items: T[],
  key: (item: T) => string,
  what: string,
): void {
  const seen = new Set<string>()
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) throw invalid(`第 ${item.line} 行${what}重复：${k}`)
    seen.add(k)
  }
}

const PER_MEMBER_LAYERS = new Set(['owner', 'private'])

// 文件里的互相指认要对得上，URI 不能冲突，层与归属要一致：写库之前查一遍，出错时说清是哪一行，
// 不等写到一半被数据库的约束拦下。now 是数据库的时间（见 databaseNow），判断记忆过期没有和触发器用同一个钟
export function checkSpaceExport(x: ParsedSpaceExport, now: Date): void {
  const personaById = byId(x.personas, '人格')
  distinct(x.personas, (p) => p.slug, '人格的标识')
  for (const p of x.personas) {
    if (p.extendsId && !personaById.has(p.extendsId)) {
      throw invalid(`第 ${p.line} 行人格 ${p.slug} 继承的人格不在文件里`)
    }
    // 继承关系不能成环，继承链（含自己）最多 MAX_PERSONA_DEPTH 层，和新建、修改人格时的规则一样
    const chain = new Set<string>()
    for (let at: PersonaRecord | undefined = p; at;) {
      if (chain.has(at.id)) throw invalid(`第 ${p.line} 行人格 ${p.slug} 的继承关系成环`)
      chain.add(at.id)
      at = at.extendsId ? personaById.get(at.extendsId) : undefined
    }
    if (chain.size > MAX_PERSONA_DEPTH) {
      throw invalid(`第 ${p.line} 行人格 ${p.slug} 的继承链超过 ${MAX_PERSONA_DEPTH} 层`)
    }
  }
  const appById = byId(x.apps, '应用')
  distinct(x.apps, (a) => a.slug, '应用的标识')
  for (const a of x.apps) {
    if (a.defaultPersonaId && !personaById.has(a.defaultPersonaId)) {
      throw invalid(`第 ${a.line} 行应用 ${a.slug} 的默认人格不在文件里`)
    }
  }
  const subjectById = byId(x.subjects, '对象')
  for (const i of x.identities) {
    const subject = subjectById.get(i.subjectId)
    const label = `第 ${i.line} 行平台账号 ${i.platform}:${i.externalId}`
    if (!subject) throw invalid(`${label} 挂的对象不在文件里`)
    if (subject.kind !== i.kind) throw invalid(`${label} 和对象的种类不同`)
  }
  distinct(x.identities, (i) => `${i.platform}/${i.kind}/${i.externalId}`, '平台账号')
  for (const r of x.groupPersonas) {
    if (!appById.has(r.appId) || !personaById.has(r.personaId)) {
      throw invalid(`第 ${r.line} 行按群换人格的规则指向的应用或人格不在文件里`)
    }
    if (subjectById.get(r.subjectId)?.kind !== 'group') {
      throw invalid(`第 ${r.line} 行按群换人格的规则指向的不是文件里的群`)
    }
  }
  distinct(x.groupPersonas, (r) => `${r.appId}/${r.subjectId}`, '按群换人格的规则')
  const providerById = byId(x.providers, '凭据源')
  byId(x.credentials, '凭据')
  distinct(x.credentials, (c) => c.identifier, '凭据的标识')
  for (const c of x.credentials) {
    if (c.source.kind === 'external' && !providerById.has(c.source.providerId)) {
      throw invalid(`第 ${c.line} 行凭据 ${c.identifier} 绑的凭据源不在文件里`)
    }
  }

  byId(x.memories, '记忆')
  // URI 的规则和数据库一样：同一归属里不重复，已过期的也算（唯一索引）；共享的与个人的（导入后都是导入人的）
  // 不共存，只看现在还有效的（URI 互斥的触发器：已失效或过期的记录不挡别人）。导出带着已过期的记忆，
  // 共享节点过期之后同一个 URI 上又有了个人节点，这样的两条一起导出、一起导入。
  // 写库的事务比这里晚开始，那时过期的只会更多，这里通过了触发器也不会拦
  const live = (m: MemoryRecord) =>
    !lapsed({ validTo: optionalTime(m.validTo), expiresAt: optionalTime(m.expiresAt) }, now)
  const shared = new Set<string>()
  const mine = new Set<string>()
  const liveShared = new Set<string>()
  const liveMine = new Set<string>()
  for (const m of x.memories) {
    const label = `第 ${m.line} 行${m.uri ? `记忆 ${m.uri}` : '抽取的记忆'}`
    if ((m.form === 'curated') !== (m.uri !== null)) throw invalid(`${label} 的形态与 URI 对不上`)
    if (m.provenance === 'untrusted' && m.layer !== 'subject' && m.layer !== 'episode') {
      throw invalid(`${label} 来自不可信来源，只能在对象层或情节层`)
    }
    const parsed = m.uri ? parseUri(m.uri) : null
    const namespaced = parsed?.domain === PERSONA_DOMAIN || parsed?.domain === APP_DOMAIN
    const owners = { persona: m.personaId, app: m.appId, subject: m.subjectId }
    const expected =
      m.layer === 'persona' || m.layer === 'app' || m.layer === 'subject' ? m.layer : null
    for (const [layer, id] of Object.entries(owners)) {
      if ((layer === expected) !== (id !== null)) throw invalid(`${label} 的层与归属对不上`)
    }
    if (m.layer === 'persona') {
      const persona = personaById.get(m.personaId!)
      if (!persona) throw invalid(`${label} 的人格不在文件里`)
      if (parsed && (parsed.domain !== PERSONA_DOMAIN || parsed.namespaceSlug !== persona.slug)) {
        throw invalid(`${label} 不在它的人格 ${persona.slug} 下面`)
      }
    } else if (m.layer === 'app') {
      const app = appById.get(m.appId!)
      if (!app) throw invalid(`${label} 的应用不在文件里`)
      if (parsed && (parsed.domain !== APP_DOMAIN || parsed.namespaceSlug !== app.slug)) {
        throw invalid(`${label} 不在它的应用 ${app.slug} 下面`)
      }
    } else if (namespaced) {
      throw invalid(`${label} 在 ${parsed!.domain}:// 下面，却是 ${m.layer} 层`)
    }
    if (m.layer === 'subject' && !subjectById.has(m.subjectId!)) {
      throw invalid(`${label} 的对象不在文件里`)
    }
    if (!m.uri) continue
    const personal = PER_MEMBER_LAYERS.has(m.layer)
    const bucket = personal ? mine : shared
    if (bucket.has(m.uri)) throw invalid(`${label} 的 URI 重复`)
    bucket.add(m.uri)
    if (live(m)) (personal ? liveMine : liveShared).add(m.uri)
  }
  for (const uri of liveMine) {
    if (liveShared.has(uri)) throw invalid(`URI ${uri} 既有有效的共享记忆，又有有效的个人记忆`)
  }
}

// 文件里有要加密保存的内容，这个实例却没配主密钥：拒绝导入。只导入不加密的部分会丢掉 secret 与托管的值，
// 引用它们的占位符也就取不到值了；配主密钥是一次性的事，配好再导入
function requireMasterKey(x: ParsedSpaceExport, masterKey: MasterKey | null): void {
  if (masterKey) return
  const secrets = x.memories.filter((m) => m.sensitivity === 'secret').length
  const hosted = x.credentials.filter((c) => c.source.kind === 'hosted').length
  if (!secrets && !hosted) return
  const what = [
    secrets ? `${secrets} 条 secret 记忆` : '',
    hosted ? `${hosted} 条托管的凭据` : '',
  ].filter(Boolean)
  throw new MemoryError(
    400,
    `文件里有 ${what.join('和 ')}，要用主密钥加密保存，这个实例没有配置 KIOKU_MASTER_KEY：配好主密钥、重启服务之后再导入`,
  )
}

function countsOf(x: ParsedSpaceExport): SpaceImportCounts {
  const layer = (name: string) => x.memories.filter((m) => m.layer === name).length
  return {
    personas: x.personas.length,
    apps: x.apps.length,
    subjects: x.subjects.length,
    linkedSubjects: x.subjects.filter((s) => s.linkedToExporter).length,
    memories: x.memories.length,
    ownerMemories: layer('owner'),
    privateMemories: layer('private'),
    secrets: x.memories.filter((m) => m.sensitivity === 'secret').length,
    credentials: x.credentials.length,
    providers: x.providers.length,
  }
}

export interface InspectSpaceOptions {
  file: Buffer
  passphrase: string
}

// 解开文件、按导入时的规则核对一遍，不写库：返回解开的内容
// 数据库的现在。URI 互斥的触发器按数据库的 now() 判断记录过期没有，导入前核对时用同一个钟，不用应用的时间
async function databaseNow(db: Db): Promise<Date> {
  const [row] = await db.execute<{ now: Date | string }>(sql`select now() as now`)
  return new Date(row!.now)
}

async function openAndCheck(
  db: Db,
  masterKey: MasterKey | null,
  options: InspectSpaceOptions,
): Promise<ParsedSpaceExport> {
  const plain = await openSpaceExport(options.file, {
    passphrase: options.passphrase,
    maxPlainBytes: SPACE_EXPORT_MAX_PLAIN_BYTES,
  })
  const x = parseSpaceExport(plain)
  checkSpaceExport(x, await databaseNow(db))
  requireMasterKey(x, masterKey)
  return x
}

// 导入之前先看：文件是谁导出的、从哪个空间、有多少，导入后哪些归你。导入会遇到的问题（口令不对、文件被改过、
// 内容对不上、没配主密钥）这一步就报出来
export async function inspectSpaceImport(
  db: Db,
  masterKey: MasterKey | null,
  options: InspectSpaceOptions,
): Promise<SpaceImportPreview> {
  const x = await openAndCheck(db, masterKey, options)
  return {
    exporter: x.header.exporter,
    spaceName: x.header.space.name,
    exportedAt: x.header.createdAt,
    counts: countsOf(x),
  }
}

export interface ImportSpaceOptions extends InspectSpaceOptions {
  // 导入人：实例管理员（路由检查），成为新空间的 owner
  accountId: string
  // 新空间的名字；不填时用导出时的空间名
  name?: string | undefined
}

export async function importSpace(
  db: Db,
  masterKey: MasterKey | null,
  options: ImportSpaceOptions,
): Promise<SpaceImportResult> {
  const x = await openAndCheck(db, masterKey, options)
  const name = options.name?.trim() || x.header.space.name
  // 新空间的 id 先定下来：整个导入在 withSpace 里，内容表按这个空间过滤
  const spaceId = randomUUID()
  const progress: Progress = { step: '', fromFile: false }
  try {
    await withSpace(db, spaceId, (tx) =>
      writeSpace(tx, x, { spaceId, accountId: options.accountId, masterKey, name, progress }),
    )
  } catch (err) {
    const code = pgErrorCode(err)
    if (code) {
      // 数据库报的错都把 SQLSTATE、约束名与说明记进日志，不管最后算谁的问题
      console.error(`导入空间时数据库报错：${progress.step}`, {
        code,
        cause: pgCauseCode(err),
        constraint: pgConstraint(err),
        message: pgMessage(err),
      })
    }
    // 上面的检查之外，数据库还拒绝了文件里的什么（例如被人改过、但口令对得上的文件）：整个撤销，
    // 说清是哪几行、违反了哪一条约束。22 类是值本身不对（例如时间超出范围），23 类是违反约束。
    // 只有正在写文件里来的值时才算文件的问题；成员、关键词、引用与事件是服务端自己派生的，出错是服务端的缺陷，照常 500
    if (progress.fromFile && (code?.startsWith('22') || code?.startsWith('23'))) {
      const why = pgConstraint(err) ? `违反了约束 ${pgConstraint(err)}` : (pgMessage(err) ?? code)
      throw invalid(`${progress.step}写不进数据库（${why}）`)
    }
    throw err
  }
  return { spaceId, name, exporter: x.header.exporter, counts: countsOf(x) }
}

// 一条语句最多写这么多行：参数个数不超过 PostgreSQL 的上限（65535）
const BATCH = 500

function* chunks<T>(items: T[], size = BATCH): Generator<T[]> {
  for (let at = 0; at < items.length; at += size) yield items.slice(at, at + size)
}

const time = (value: string) => new Date(value)
const optionalTime = (value: string | null) => (value === null ? null : new Date(value))

// 正在写哪一步：哪几行的什么，写的是不是文件里来的值（服务端自己派生的不算）
interface Progress {
  step: string
  fromFile: boolean
}

// 按文件建出新空间与里面的全部内容。progress 记着正在写哪一步，数据库报错时说得出是哪里、算不算文件的问题
async function writeSpace(
  tx: Tx,
  x: ParsedSpaceExport,
  ctx: {
    spaceId: string
    accountId: string
    masterKey: MasterKey | null
    name: string
    progress: Progress
  },
): Promise<void> {
  const { spaceId, accountId, masterKey, progress } = ctx
  // 写文件里来的值：报错时算文件的问题
  const step = (what: string, batch: { line: number }[]) => {
    const from = batch[0]?.line
    const to = batch[batch.length - 1]?.line
    progress.step = from === to ? `第 ${from} 行的${what}` : `第 ${from}–${to} 行的${what}`
    progress.fromFile = true
  }
  // 写服务端自己派生的：报错是服务端的缺陷
  const derived = (what: string, batch?: { line: number }[]) => {
    if (batch) step(what, batch)
    else progress.step = what
    progress.fromFile = false
  }
  progress.step = '空间的设置'
  progress.fromFile = true
  await tx.insert(spaces).values({
    id: spaceId,
    name: ctx.name,
    domainLayers: x.header.space.domainLayers,
    extractionMonthlyTokens: x.header.space.extractionMonthlyTokens,
    extractionDailyWrites: x.header.space.extractionDailyWrites,
  })
  derived('新空间的成员')
  // 导出人的画像层与私人层归了导入人，导出人关掉的 Dream 整理在导入人身上也关着，由导入人决定要不要打开
  await tx.insert(spaceMembers).values({
    spaceId,
    accountId,
    role: 'owner',
    dreamPrivate: x.header.exporter.dreamPrivate,
  })
  // app.importing_space 告诉 URI 互斥的触发器：这是导入新空间的事务，空间这一行刚写下、
  // 别的事务还看不到它，不用为每个 URI 加咨询锁（见 0023 迁移）
  await tx.execute(sql`select set_config('app.importing_space', ${spaceId}, true)`)

  const personaIds = new Map(x.personas.map((p) => [p.id, randomUUID()]))
  const appIds = new Map(x.apps.map((a) => [a.id, randomUUID()]))
  const subjectIds = new Map(x.subjects.map((s) => [s.id, randomUUID()]))
  const providerIds = new Map(x.providers.map((p) => [p.id, randomUUID()]))
  const mapped = (map: Map<string, string>, id: string | null) =>
    id === null ? null : map.get(id)!

  if (x.personas.length) {
    step('人格', x.personas)
    // 外键在语句结束时才检查，同一条语句里先写子人格也不要紧
    await tx.insert(personas).values(
      x.personas.map((p) => ({
        id: personaIds.get(p.id)!,
        spaceId,
        slug: p.slug,
        name: p.name,
        extendsId: mapped(personaIds, p.extendsId),
        description: p.description,
        createdAt: time(p.createdAt),
        updatedAt: time(p.updatedAt),
      })),
    )
  }
  if (x.apps.length) {
    step('应用', x.apps)
    await tx.insert(apps).values(
      x.apps.map((a) => ({
        id: appIds.get(a.id)!,
        spaceId,
        slug: a.slug,
        name: a.name,
        runtimeFamily: a.runtimeFamily,
        ownerAccountId: accountId,
        defaultPersonaId: mapped(personaIds, a.defaultPersonaId),
        config: a.config,
        createdAt: time(a.createdAt),
        updatedAt: time(a.updatedAt),
      })),
    )
  }
  for (const batch of chunks(x.subjects)) {
    step('对象', batch)
    await tx.insert(subjects).values(
      batch.map((s) => ({
        id: subjectIds.get(s.id)!,
        spaceId,
        kind: s.kind,
        displayName: s.displayName,
        nameLocked: s.nameLocked,
        accountId: s.linkedToExporter ? accountId : null,
        createdAt: time(s.createdAt),
        updatedAt: time(s.updatedAt),
      })),
    )
  }
  for (const batch of chunks(x.identities)) {
    step('平台账号', batch)
    await tx.insert(subjectIdentities).values(
      batch.map((i) => ({
        spaceId,
        subjectId: subjectIds.get(i.subjectId)!,
        kind: i.kind,
        platform: i.platform,
        externalId: i.externalId,
        displayName: i.displayName,
        createdAt: time(i.createdAt),
      })),
    )
  }
  for (const batch of chunks(x.groupPersonas)) {
    step('按群换人格的规则', batch)
    await tx.insert(appGroupPersonas).values(
      batch.map((r) => ({
        spaceId,
        appId: appIds.get(r.appId)!,
        subjectId: subjectIds.get(r.subjectId)!,
        personaId: personaIds.get(r.personaId)!,
        createdAt: time(r.createdAt),
      })),
    )
  }

  if (x.providers.length) {
    step('凭据源', x.providers)
    await tx.insert(credentialProviders).values(
      x.providers.map((p) => ({
        id: providerIds.get(p.id)!,
        spaceId,
        ownerAccountId: accountId,
        kind: p.kind,
        name: p.name,
        instructions: p.instructions,
        deletedAt: optionalTime(p.deletedAt),
        createdAt: time(p.createdAt),
        updatedAt: time(p.updatedAt),
      })),
    )
  }
  const credentialRow = (id: string, c: CredentialRecord) => {
    const common = {
      id,
      spaceId,
      ownerAccountId: accountId,
      identifier: c.identifier,
      name: c.name,
      description: c.description,
      // 限定的应用换成新的 id；文件里没有的（导出前已经删掉的应用）去掉，限定只会更严，不会变成不限定
      appIds: c.appIds && c.appIds.flatMap((app) => (appIds.has(app) ? [appIds.get(app)!] : [])),
      createdAt: time(c.createdAt),
      updatedAt: time(c.updatedAt),
    }
    if (c.source.kind === 'external') {
      return {
        ...common,
        source: 'external' as const,
        providerId: providerIds.get(c.source.providerId)!,
        location: c.source.location,
        fields: c.source.fields,
      }
    }
    // 和凭据服务保存托管的值一样：字段按名字排好，整体加密，aad 绑新的凭据 id
    const names = Object.keys(c.source.values).sort()
    const values = c.source.values
    return {
      ...common,
      source: 'hosted' as const,
      fields: names.map((name) => ({ name, sourceField: null })),
      ...sealCredentialValues(
        masterKey!,
        id,
        Object.fromEntries(names.map((n) => [n, values[n]!])),
      ),
    }
  }

  const context = { source: 'space-export', exportedAt: x.header.createdAt }
  for (const batch of chunks(x.credentials)) {
    step('凭据', batch)
    const rows = batch.map((c) => ({ id: randomUUID(), record: c }))
    await tx.insert(credentials).values(rows.map(({ id, record }) => credentialRow(id, record)))
    derived('凭据的导入事件', batch)
    await tx.insert(credentialEvents).values(
      rows.map(({ id }) => ({
        spaceId,
        credentialId: id,
        eventType: 'import',
        actorAccountId: accountId,
        context,
      })),
    )
  }

  // 来源作用域里的应用与对象换成新的 id。文件里没有的（导出前已经删掉的应用或对象）换成一个新的随机 id：
  // 仍然只在那个作用域里可见（再也没有会话对得上它），不会变成全局可见
  const orphans = new Map<string, string>()
  const scopeOf = (scope: string) => {
    if (scope === 'global') return scope
    const [kind, id] = scope.split(':') as [string, string]
    const known = (kind === 'app' ? appIds : subjectIds).get(id)
    if (known) return `${kind}:${known}`
    if (!orphans.has(id)) orphans.set(id, randomUUID())
    return `${kind}:${orphans.get(id)!}`
  }
  for (const batch of chunks(x.memories)) {
    step('记忆', batch)
    const prepared = batch.map((m) => {
      const id = randomUUID()
      const parsed = m.uri ? parseUri(m.uri)! : null
      const glossary = [...new Set(m.glossary)].sort()
      return {
        id,
        record: m,
        glossary,
        row: {
          id,
          spaceId,
          form: m.form,
          layer: m.layer,
          sensitivity: m.sensitivity,
          provenance: m.provenance,
          originScope: scopeOf(m.originScope),
          ownerAccountId: PER_MEMBER_LAYERS.has(m.layer) ? accountId : null,
          personaId: mapped(personaIds, m.personaId),
          appId: mapped(appIds, m.appId),
          subjectId: mapped(subjectIds, m.subjectId),
          domain: parsed?.domain ?? null,
          path: parsed?.path ?? null,
          ...(m.sensitivity === 'secret'
            ? { content: null, ...sealMemoryContent(masterKey!, id, m.content) }
            : { content: m.content, ciphertext: null, wrappedKey: null, keyId: null }),
          priority: m.priority,
          disclosure: m.disclosure,
          validFrom: time(m.validFrom),
          validTo: optionalTime(m.validTo),
          expiresAt: optionalTime(m.expiresAt),
          createdAt: time(m.createdAt),
          updatedAt: time(m.updatedAt),
        },
      }
    })
    // 只取回写快照用得到的列，不把密文与全文检索向量也取回来
    const written = new Map(
      (
        await tx
          .insert(memories)
          .values(prepared.map((p) => p.row))
          .returning(SNAPSHOT_COLUMNS)
      ).map((r) => [r.id, r]),
    )
    // 关键词是文件里的值（只是去了重、排了序），写不进去算文件的问题；
    // 引用索引与导入事件是服务端派生的（事件的快照是写进库之后取回的记录，加上已经检查过的关键词），分开标出
    step('记忆的关键词', batch)
    const keywords = prepared.flatMap((p) =>
      p.glossary.map((keyword) => ({ spaceId, memoryId: p.id, keyword })),
    )
    for (const part of chunks(keywords, BATCH * 4)) await tx.insert(memoryGlossary).values(part)
    // 引用索引和写入时一样按正文重建，secret 的不进索引
    derived('记忆的凭据引用', batch)
    const refs = prepared.flatMap((p) =>
      p.record.sensitivity === 'secret'
        ? []
        : [...placeholderIdentifiers(p.record.content)].map((identifier) => ({
            spaceId,
            memoryId: p.id,
            identifier,
          })),
    )
    for (const part of chunks(refs, BATCH * 4)) await tx.insert(memoryCredentialRefs).values(part)
    derived('记忆的导入事件', batch)
    await tx.insert(memoryEvents).values(
      prepared.map((p) => ({
        spaceId,
        memoryId: p.id,
        eventType: 'import',
        actorAccountId: accountId,
        provenance: 'system' as const,
        before: null,
        after: memorySnapshot(written.get(p.id)!, p.glossary),
        context: { ...context, previousVersions: p.record.version - 1 },
      })),
    )
  }
}
