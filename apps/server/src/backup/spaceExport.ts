import { AppConfig, SPACE_EXPORT_MAX_BYTES, type RuntimeFamily } from '@kioku/contracts'
import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'

import { consoleAccess } from '../access/access'
import { openCredentialValues } from '../credential/service'
import type { MasterKey } from '../crypto/keyring'
import { withSpace, type Db, type Tx } from '../db/client'
import {
  accounts,
  appGroupPersonas,
  apps,
  credentialEvents,
  credentialProviders,
  credentials,
  memories,
  memoryGlossary,
  personas,
  spaceMembers,
  spaces,
  subjectIdentities,
  subjects,
} from '../db/schema'
import { readableConditions } from '../memory/filter'
import { MemoryError, openMemoryContent } from '../memory/service'
import { formatUri } from '../memory/uri'
import { VERSION } from '../version'
import { deriveExportKey, ExportTooLarge, sealSpaceExport, type KdfParams } from './spaceFormat'
import {
  describeIssue,
  SPACE_EXPORT_FORMAT,
  SPACE_EXPORT_MAX_PLAIN_BYTES,
  SPACE_EXPORT_VERSION,
  SpaceExportHeader,
  SpaceExportRecord,
  type CredentialRecord,
  type MemoryRecord,
} from './spaceRecords'

// 按空间导出：只导出导出人读得到的。导出人是空间 owner（路由检查），按他在管理界面里的权限读：
// 共享的层（基础、人格、应用、对象与情节层）、人格、应用、对象与按群换人格，加上他自己的画像层与私人层、
// 他自己的凭据与凭据源，以及他让不让 Dream 整理这两层；别的成员的画像、私人层、凭据与设置都不导出。
// 记忆按管理读取挑（和历史、已过期列表同一套规则）：已过期的策展记忆与被推翻的事实也带上，有效期原样写出，
// 导入后照样在「已过期」与对象页的「被推翻的事实」里，能重新生效。
// 不导出：Key、会话、召回事件与召回统计、对话缓冲、抽取记录、记忆与凭据的历史、向量；
// 已删除的记忆（包括过期之后让出了 URI 的），以及到期的会话摘要（按设计到期，不能重新生效）

export interface SpaceExport {
  file: Buffer<ArrayBuffer>
  spaceName: string
  createdAt: string
}

// 每次读多少条记忆
const PAGE = 500

// 请求断开了（客户端超时、关掉页面）：文件交不出去，不再接着做。响应没人收，状态码只是给日志看的
function stopIfGone(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MemoryError(400, '请求已经断开，导出停下')
}

export async function exportSpace(
  db: Db,
  masterKey: MasterKey | null,
  options: {
    spaceId: string
    accountId: string
    passphrase: string
    kdf?: KdfParams
    // 请求的断开信号：派生之后、开事务之前与每读一批之前看一眼，断开了就停下
    signal?: AbortSignal
  },
): Promise<SpaceExport> {
  const { signal } = options
  // 先派生密钥再开事务：派生要几百毫秒，不占着读库的事务
  const exportKey = await deriveExportKey(options.passphrase, options.kdf)
  stopIfGone(signal)
  const createdAt = new Date().toISOString()
  // 导出了哪些凭据、各带了哪些字段：读完之后记访问事件
  const exported = new Map<string, string[]>()
  let spaceName = ''
  let file: Buffer<ArrayBuffer>
  try {
    // 整份在一个可重复读的只读事务里读，各表是同一时刻的快照
    file = await withSpace(
      db,
      options.spaceId,
      async (tx) => {
        const [space] = await tx.select().from(spaces).where(eq(spaces.id, options.spaceId))
        const [exporter] = await tx
          .select({ displayName: accounts.displayName, dreamPrivate: spaceMembers.dreamPrivate })
          .from(accounts)
          .innerJoin(spaceMembers, eq(spaceMembers.accountId, accounts.id))
          .where(and(eq(accounts.id, options.accountId), eq(spaceMembers.spaceId, options.spaceId)))
        if (!space || !exporter) throw new MemoryError(404, '空间不存在')
        spaceName = space.name
        const header = checked(SpaceExportHeader, '空间的设置或导出人的名字', {
          format: SPACE_EXPORT_FORMAT,
          version: SPACE_EXPORT_VERSION,
          createdAt,
          kioku: VERSION,
          exporter: { displayName: exporter.displayName, dreamPrivate: exporter.dreamPrivate },
          space: {
            name: space.name,
            domainLayers: space.domainLayers,
            extractionMonthlyTokens: space.extractionMonthlyTokens,
            extractionDailyWrites: space.extractionDailyWrites,
          },
        })
        const source = lines(tx, {
          header,
          accountId: options.accountId,
          masterKey,
          exported,
          signal,
        })
        try {
          return await sealSpaceExport(exportKey, source, {
            maxPlainBytes: SPACE_EXPORT_MAX_PLAIN_BYTES,
            maxBytes: SPACE_EXPORT_MAX_BYTES,
          })
        } finally {
          // 加密或计数出错时管道先失败，读库的查询可能还在跑：等它停下再结束事务
          await source.return(undefined).catch(() => {})
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  } catch (err) {
    if (err instanceof ExportTooLarge) {
      throw new MemoryError(
        400,
        `这个空间导出后超过导入的上限（加密后 ${SPACE_EXPORT_MAX_BYTES / 1024 / 1024} MB、解压后 ${SPACE_EXPORT_MAX_PLAIN_BYTES / 1024 / 1024} MB），导出了也导入不了`,
      )
    }
    throw err
  }
  // 文件做好时客户端已经断开：文件交不出去，也就不记访问事件
  stopIfGone(signal)
  // 托管的值与外部的绑定都随文件带走了，和取用一样给凭据的主人记一条访问事件，事后查得到
  if (exported.size) {
    await withSpace(db, options.spaceId, (tx) =>
      tx.insert(credentialEvents).values(
        [...exported].map(([credentialId, fields]) => ({
          spaceId: options.spaceId,
          credentialId,
          eventType: 'access',
          actorAccountId: options.accountId,
          context: { via: 'export', fields },
        })),
      ),
    )
  }
  return { file, spaceName, createdAt }
}

// 写进文件之前按导入时的定义检查：写得出来的就一定导入得了。通不过的（例如规则收紧之前存下的值）
// 点名是哪一条，改掉再导出，不交出一个导入不了的文件
function checked<T>(schema: z.ZodType<T>, label: string, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new MemoryError(
    409,
    `${label}导出后导入不了（${describeIssue(parsed.error)}），在管理界面改掉再导出`,
  )
}

interface LinesContext {
  header: SpaceExportHeader
  accountId: string
  masterKey: MasterKey | null
  exported: Map<string, string[]>
  signal: AbortSignal | undefined
}

const line = (record: SpaceExportHeader | SpaceExportRecord) => `${JSON.stringify(record)}\n`
const record = (label: string, value: SpaceExportRecord) =>
  line(checked(SpaceExportRecord, label, value))
const iso = (value: Date | null) => value?.toISOString() ?? null

async function* lines(tx: Tx, ctx: LinesContext): AsyncGenerator<string> {
  const { accountId } = ctx
  // 每读一批之前看一眼：请求断开了就停下，不接着读库、压缩与加密
  const next = () => stopIfGone(ctx.signal)
  yield line(ctx.header)

  next()
  const personaRows = await tx
    .select()
    .from(personas)
    .orderBy(asc(personas.createdAt), asc(personas.id))
  yield inheritanceOrder(personaRows)
    .map((p) =>
      record(`人格 ${p.slug} `, {
        type: 'persona',
        id: p.id,
        slug: p.slug,
        name: p.name,
        extendsId: p.extendsId,
        description: p.description,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      }),
    )
    .join('')

  next()
  const appRows = await tx.select().from(apps).orderBy(asc(apps.createdAt), asc(apps.id))
  yield appRows
    .map((a) =>
      record(`应用 ${a.slug} `, {
        type: 'app',
        id: a.id,
        slug: a.slug,
        name: a.name,
        runtimeFamily: a.runtimeFamily as RuntimeFamily,
        defaultPersonaId: a.defaultPersonaId,
        config: AppConfig.parse(a.config),
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      }),
    )
    .join('')

  next()
  const subjectRows = await tx
    .select()
    .from(subjects)
    .orderBy(asc(subjects.createdAt), asc(subjects.id))
  yield subjectRows
    .map((s) =>
      record(`对象「${s.displayName}」`, {
        type: 'subject',
        id: s.id,
        kind: s.kind,
        displayName: s.displayName,
        nameLocked: s.nameLocked,
        linkedToExporter: s.accountId === accountId,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      }),
    )
    .join('')
  next()
  const identityRows = await tx
    .select()
    .from(subjectIdentities)
    .orderBy(asc(subjectIdentities.createdAt), asc(subjectIdentities.id))
  yield identityRows
    .map((i) =>
      record(`平台账号 ${i.platform}:${i.externalId} `, {
        type: 'identity',
        subjectId: i.subjectId,
        kind: i.kind,
        platform: i.platform,
        externalId: i.externalId,
        displayName: i.displayName,
        createdAt: i.createdAt.toISOString(),
      }),
    )
    .join('')
  next()
  const ruleRows = await tx
    .select()
    .from(appGroupPersonas)
    .orderBy(asc(appGroupPersonas.createdAt), asc(appGroupPersonas.appId))
  yield ruleRows
    .map((r) =>
      record('按群换人格的规则', {
        type: 'groupPersona',
        appId: r.appId,
        subjectId: r.subjectId,
        personaId: r.personaId,
        createdAt: r.createdAt.toISOString(),
      }),
    )
    .join('')

  // 凭据与凭据源只有导出人自己的；凭据只导出有效的。已删除的凭据源只在还有导出的凭据绑着它时带上
  next()
  const credentialRows = await tx
    .select()
    .from(credentials)
    .where(and(eq(credentials.ownerAccountId, accountId), isNull(credentials.deletedAt)))
    .orderBy(asc(credentials.createdAt), asc(credentials.id))
  const boundProviders = [
    ...new Set(credentialRows.flatMap((c) => (c.providerId ? [c.providerId] : []))),
  ]
  const providerRows = await tx
    .select()
    .from(credentialProviders)
    .where(
      and(
        eq(credentialProviders.ownerAccountId, accountId),
        boundProviders.length
          ? or(
              isNull(credentialProviders.deletedAt),
              inArray(credentialProviders.id, boundProviders),
            )
          : isNull(credentialProviders.deletedAt),
      ),
    )
    .orderBy(asc(credentialProviders.createdAt), asc(credentialProviders.id))
  yield providerRows
    .map((p) =>
      record(`凭据源「${p.name}」`, {
        type: 'provider',
        id: p.id,
        kind: p.kind,
        name: p.name,
        instructions: p.instructions,
        deletedAt: iso(p.deletedAt),
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      }),
    )
    .join('')
  yield credentialRows
    .map((c) => {
      const text = record(`凭据 ${c.identifier} `, credentialRecord(c, ctx.masterKey))
      ctx.exported.set(c.id, c.fields.map((f) => f.name).sort())
      return text
    })
    .join('')

  const readable = exportableMemories(accountId)
  let after: string | null = null
  for (;;) {
    next()
    const rows = await tx
      .select()
      .from(memories)
      .where(and(readable, after ? gt(memories.id, after) : undefined))
      .orderBy(asc(memories.id))
      .limit(PAGE)
    if (!rows.length) break
    const glossary = new Map<string, string[]>()
    for (const g of await tx
      .select()
      .from(memoryGlossary)
      .where(
        inArray(
          memoryGlossary.memoryId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(memoryGlossary.keyword))) {
      glossary.set(g.memoryId, [...(glossary.get(g.memoryId) ?? []), g.keyword])
    }
    yield rows
      .map((row) =>
        record(
          `记忆 ${memoryLabel(row)} `,
          memoryRecord(row, glossary.get(row.id) ?? [], ctx.masterKey),
        ),
      )
      .join('')
    after = rows[rows.length - 1]!.id
    if (rows.length < PAGE) break
  }
}

// 导出哪些记忆。底子是导出人在管理界面里的管理读取，和历史、已过期列表同一套条件（readableConditions，不另写）：
// 不看有效期，所以已过期的策展记忆与被推翻的事实也在里面，导入后能重新生效；人格层不限人格；secret 导出人是
// 空间 owner，读得到；别的成员的画像层与私人层不在里面。管理读取也不看删除状态，在它之外再去掉两种：
// - 已删除的（包括过期之后让出了 URI 的）：删掉的不搬走，撤销删除只在原来的空间里做；
// - 到期的会话摘要（只有会话摘要有 expires_at）：按设计到期、不能重新生效，搬过去也只是等着被保留期清掉。
// 时间按数据库的 now()，导出整份在一个事务里，就是事务开始的那一刻
export function exportableMemories(accountId: string): SQL {
  return and(
    readableConditions(consoleAccess('owner', accountId), { personaIds: [], management: true }),
    isNull(memories.deletedAt),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
  )!
}

// 被继承的人格排在前面，读文件的人一眼看得出继承关系（导入不依赖这个顺序）。
// 继承关系有环或指向不在这里的人格时（服务不会写出这样的数据），剩下的按原来的顺序排在最后
function inheritanceOrder<T extends { id: string; extendsId: string | null }>(rows: T[]): T[] {
  const placed = new Set<string>()
  const result: T[] = []
  let left = rows
  for (;;) {
    const ready = left.filter((r) => r.extendsId === null || placed.has(r.extendsId))
    if (!ready.length) break
    for (const r of ready) {
      placed.add(r.id)
      result.push(r)
    }
    left = left.filter((r) => !placed.has(r.id))
  }
  return [...result, ...left]
}

const memoryLabel = (row: typeof memories.$inferSelect) =>
  row.domain && row.path ? formatUri(row.domain, row.path) : row.id

// 解不开的托管凭据或 secret 记忆（密文缺了、被改过，或者主密钥对不上）：整个导出停下，点名是哪一条
const unreadable = (what: string) =>
  new MemoryError(
    409,
    `${what}解不开（密文缺失、被改过或主密钥对不上），导出不了：先在管理界面重新填它的内容，或者删掉它`,
  )

function credentialRecord(
  row: typeof credentials.$inferSelect,
  masterKey: MasterKey | null,
): CredentialRecord {
  let source: CredentialRecord['source']
  if (row.source === 'hosted') {
    if (!masterKey) {
      throw new MemoryError(400, '服务端没有配置 KIOKU_MASTER_KEY，解不开托管的凭据，不能导出')
    }
    if (!row.ciphertext || !row.wrappedKey) throw unreadable(`托管的凭据 ${row.identifier} `)
    try {
      source = {
        kind: 'hosted',
        values: openCredentialValues(masterKey, {
          ...row,
          ciphertext: row.ciphertext,
          wrappedKey: row.wrappedKey,
        }),
      }
    } catch {
      throw unreadable(`托管的凭据 ${row.identifier} `)
    }
  } else {
    source = {
      kind: 'external',
      providerId: row.providerId!,
      location: row.location!,
      // 没有来源字段的取值时按字段名取：导出时就写成字段名，和新建凭据的接口一样必填，导入后取法不变
      fields: row.fields.map((f) => ({ name: f.name, sourceField: f.sourceField ?? f.name })),
    }
  }
  return {
    type: 'credential',
    id: row.id,
    identifier: row.identifier,
    name: row.name,
    description: row.description,
    source,
    appIds: row.appIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function memoryRecord(
  row: typeof memories.$inferSelect,
  glossary: string[],
  masterKey: MasterKey | null,
): MemoryRecord {
  let content = row.content
  if (row.sensitivity === 'secret') {
    if (!masterKey) {
      throw new MemoryError(400, '服务端没有配置 KIOKU_MASTER_KEY，解不开 secret 记忆，不能导出')
    }
    if (!row.ciphertext || !row.wrappedKey) throw unreadable(`secret 记忆 ${memoryLabel(row)} `)
    try {
      content = openMemoryContent(masterKey, {
        ...row,
        ciphertext: row.ciphertext,
        wrappedKey: row.wrappedKey,
      })
    } catch {
      throw unreadable(`secret 记忆 ${memoryLabel(row)} `)
    }
  }
  return {
    type: 'memory',
    id: row.id,
    form: row.form,
    layer: row.layer,
    sensitivity: row.sensitivity,
    provenance: row.provenance,
    originScope: row.originScope,
    personaId: row.personaId,
    appId: row.appId,
    subjectId: row.subjectId,
    uri: row.domain && row.path ? formatUri(row.domain, row.path) : null,
    content: content ?? '',
    priority: row.priority,
    disclosure: row.disclosure,
    glossary,
    validFrom: row.validFrom.toISOString(),
    validTo: iso(row.validTo),
    expiresAt: iso(row.expiresAt),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
