import { AppConfig, SPACE_EXPORT_MAX_BYTES, type RuntimeFamily } from '@kioku/contracts'
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'

import { consoleAccess } from '../access/access'
import { openCredentialValues } from '../credential/service'
import { decryptSecret } from '../crypto/envelope'
import { decryptionKey, type MasterKey } from '../crypto/keyring'
import { withSpace, type Db, type Tx } from '../db/client'
import {
  appGroupPersonas,
  apps,
  credentialEvents,
  credentialProviders,
  credentials,
  memories,
  memoryGlossary,
  personas,
  spaces,
  subjectIdentities,
  subjects,
} from '../db/schema'
import { readableConditions } from '../memory/filter'
import { MemoryError } from '../memory/service'
import { formatUri } from '../memory/uri'
import { VERSION } from '../version'
import { deriveExportKey, ExportTooLarge, sealSpaceExport, type KdfParams } from './spaceFormat'
import {
  SPACE_EXPORT_FORMAT,
  SPACE_EXPORT_MAX_PLAIN_BYTES,
  SPACE_EXPORT_VERSION,
  type CredentialRecord,
  type MemoryRecord,
  type SpaceExportHeader,
  type SpaceExportRecord,
} from './spaceRecords'

// 按空间导出：只导出导出人读得到的。导出人是空间 owner（路由检查），按他在管理界面里的权限读：
// 共享的层（基础、人格、应用、对象与情节层）、人格、应用、对象与按群换人格，加上他自己的画像层与私人层、
// 他自己的凭据与凭据源；别的成员的画像、私人层与凭据都不导出。
// 不导出：Key、会话、召回事件与召回统计、对话缓冲、抽取记录、记忆与凭据的历史、向量；
// 已删除、已过期与被推翻的记忆（只导出现在有效的，和读权限的规则一致）

export interface SpaceExportCounts {
  personas: number
  apps: number
  subjects: number
  memories: number
  secrets: number
  credentials: number
  providers: number
}

export interface SpaceExport {
  file: Buffer
  spaceName: string
  createdAt: string
  counts: SpaceExportCounts
}

// 每次读多少条记忆
const PAGE = 500

export async function exportSpace(
  db: Db,
  masterKey: MasterKey | null,
  options: { spaceId: string; accountId: string; passphrase: string; kdf?: KdfParams },
): Promise<SpaceExport> {
  // 先派生密钥再开事务：派生要排队、要几百毫秒，不占着读库的事务
  const exportKey = await deriveExportKey(options.passphrase, options.kdf)
  const createdAt = new Date().toISOString()
  const counts: SpaceExportCounts = {
    personas: 0,
    apps: 0,
    subjects: 0,
    memories: 0,
    secrets: 0,
    credentials: 0,
    providers: 0,
  }
  // 导出了哪些凭据、各带了哪些字段：读完之后记访问事件
  const exported = new Map<string, string[]>()
  let spaceName = ''
  let file: Buffer
  try {
    // 整份在一个可重复读的只读事务里读，各表是同一时刻的快照
    file = await db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('app.space_id', ${options.spaceId}, true)`)
        const [space] = await tx.select().from(spaces).where(eq(spaces.id, options.spaceId))
        if (!space) throw new MemoryError(404, '空间不存在')
        spaceName = space.name
        const header: SpaceExportHeader = {
          format: SPACE_EXPORT_FORMAT,
          version: SPACE_EXPORT_VERSION,
          createdAt,
          kioku: VERSION,
          space: {
            name: space.name,
            domainLayers: space.domainLayers,
            extractionMonthlyTokens: space.extractionMonthlyTokens,
            extractionDailyWrites: space.extractionDailyWrites,
          },
        }
        const source = lines(tx, {
          header,
          accountId: options.accountId,
          masterKey,
          counts,
          exported,
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
  return { file, spaceName, createdAt, counts }
}

interface LinesContext {
  header: SpaceExportHeader
  accountId: string
  masterKey: MasterKey | null
  counts: SpaceExportCounts
  exported: Map<string, string[]>
}

const line = (record: SpaceExportHeader | SpaceExportRecord) => `${JSON.stringify(record)}\n`
const iso = (value: Date | null) => value?.toISOString() ?? null

async function* lines(tx: Tx, ctx: LinesContext): AsyncGenerator<string> {
  const { accountId, counts } = ctx
  yield line(ctx.header)

  const personaRows = await tx
    .select()
    .from(personas)
    .orderBy(asc(personas.createdAt), asc(personas.id))
  counts.personas = personaRows.length
  yield inheritanceOrder(personaRows)
    .map((p) =>
      line({
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

  const appRows = await tx.select().from(apps).orderBy(asc(apps.createdAt), asc(apps.id))
  counts.apps = appRows.length
  yield appRows
    .map((a) =>
      line({
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

  const subjectRows = await tx
    .select()
    .from(subjects)
    .orderBy(asc(subjects.createdAt), asc(subjects.id))
  counts.subjects = subjectRows.length
  yield subjectRows
    .map((s) =>
      line({
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
  const identityRows = await tx
    .select()
    .from(subjectIdentities)
    .orderBy(asc(subjectIdentities.createdAt), asc(subjectIdentities.id))
  yield identityRows
    .map((i) =>
      line({
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
  const ruleRows = await tx
    .select()
    .from(appGroupPersonas)
    .orderBy(asc(appGroupPersonas.createdAt), asc(appGroupPersonas.appId))
  yield ruleRows
    .map((r) =>
      line({
        type: 'groupPersona',
        appId: r.appId,
        subjectId: r.subjectId,
        personaId: r.personaId,
        createdAt: r.createdAt.toISOString(),
      }),
    )
    .join('')

  // 凭据与凭据源只有导出人自己的；凭据只导出有效的。已删除的凭据源只在还有导出的凭据绑着它时带上
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
  counts.providers = providerRows.length
  yield providerRows
    .map((p) =>
      line({
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
  counts.credentials = credentialRows.length
  yield credentialRows
    .map((c) => {
      const record = credentialRecord(c, ctx.masterKey)
      ctx.exported.set(c.id, c.fields.map((f) => f.name).sort())
      return line(record)
    })
    .join('')

  // 记忆按导出人在管理界面里的读权限挑：和列表、历史用的是同一套条件（readableConditions），
  // 不另写一份规则。人格层的看得到全部人格；secret 按显式读取算，导出人是空间 owner，读得到
  const readable = readableConditions(consoleAccess('owner', accountId), {
    personaIds: personaRows.map((p) => p.id),
    explicit: true,
  })
  let after: string | null = null
  for (;;) {
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
    counts.memories += rows.length
    counts.secrets += rows.filter((r) => r.sensitivity === 'secret').length
    yield rows
      .map((row) => line(memoryRecord(row, glossary.get(row.id) ?? [], ctx.masterKey)))
      .join('')
    after = rows[rows.length - 1]!.id
    if (rows.length < PAGE) break
  }
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

function credentialRecord(
  row: typeof credentials.$inferSelect,
  masterKey: MasterKey | null,
): CredentialRecord {
  let source: CredentialRecord['source']
  if (row.source === 'hosted') {
    if (!masterKey) {
      throw new MemoryError(400, '服务端没有配置 KIOKU_MASTER_KEY，解不开托管的凭据，不能导出')
    }
    source = {
      kind: 'hosted',
      values: openCredentialValues(masterKey, {
        id: row.id,
        ciphertext: row.ciphertext!,
        wrappedKey: row.wrappedKey!,
        keyId: row.keyId,
      }),
    }
  } else {
    source = {
      kind: 'external',
      providerId: row.providerId!,
      location: row.location!,
      fields: row.fields.map((f) => ({ name: f.name, sourceField: f.sourceField ?? '' })),
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
    content = decryptSecret(
      decryptionKey(masterKey, row.keyId),
      { ciphertext: row.ciphertext!, wrappedKey: row.wrappedKey! },
      row.id,
    )
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
    content: content!,
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
