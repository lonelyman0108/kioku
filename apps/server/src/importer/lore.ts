import {
  CreateMemoryRequest,
  RUNTIME_FAMILIES,
  Slug,
  type Layer,
  type RuntimeFamily,
  type UpdateMemoryRequest,
} from '@kioku/contracts'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type postgres from 'postgres'

import { consoleAccess, sensitivityRank } from '../access/access'
import {
  looksLikePlaintextCredential,
  mentionsPlaceholder,
  scanPlaceholders,
} from '../credential/placeholders'
import { decryptSecret } from '../crypto/envelope'
import { withSpace, type Db } from '../db/client'
import { apps, memories, memoryEvents, personas } from '../db/schema'
import { sealedEmbeddingKey } from '../embedding/settings'
import { MemoryError, MemoryService } from '../memory/service'
import { APP_DOMAIN, DEFAULT_SENSITIVITY, PERSONA_DOMAIN, formatUri, parseUri } from '../memory/uri'

// 从 Lore 导入，规则与步骤见 docs/migrate-from-lore.md。Lore 只读访问；映射规则：
// core://agent → 基础层；core://soul → 指定人格的 persona 层；core://agent/<runtime> → 对应应用的应用层；
// preferences:// → 主人层；其余 domain → 导入者的私人层。
// 历史版本不迁移，每条记忆记一条 import 事件，带上 Lore 的节点 uuid 与旧版本数；召回事件不迁移
// 导入过的节点在 Lore 里又改了，用 planSync / applySync 同步（命令行的 --sync）

// Lore 里一个节点导入时需要的信息。一个节点可能挂在多条路径上，最早的一条作为它的 URI，其余是别名
export interface LoreNode {
  uuid: string
  uri: string
  aliases: string[]
  priority: number
  disclosure: string | null
  content: string | null
  createdAt: Date
  updatedAt: Date
  previousVersions: number
  keywords: string[]
}

export interface LoreSnapshot {
  nodes: LoreNode[]
  // 召回事件条数，只用于报告；表不存在时为 null
  recallEvents: number | null
}

// 在只读事务里读出全部节点，保证不会改动 Lore 的数据
export async function readLore(sql: postgres.Sql): Promise<LoreSnapshot> {
  return sql.begin('read only', async (tx) => {
    const paths = await tx<
      {
        domain: string
        path: string
        uuid: string
        priority: number
        disclosure: string | null
        created: Date
      }[]
    >`
      select p.domain, p.path, e.child_uuid as uuid, e.priority, e.disclosure, n.created_at as created
      from paths p
      join edges e on e.id = p.edge_id
      join nodes n on n.uuid = e.child_uuid
      order by p.created_at, p.domain, p.path`
    const current = await tx<{ uuid: string; content: string | null; created: Date }[]>`
      select distinct on (node_uuid) node_uuid as uuid, content, created_at as created
      from memories
      where not deprecated
      order by node_uuid, created_at desc, id desc`
    const versions = await tx<{ uuid: string; n: number }[]>`
      select node_uuid as uuid, count(*)::int as n from memories where deprecated group by node_uuid`
    const keywords = await tx<{ uuid: string; keyword: string }[]>`
      select node_uuid as uuid, keyword from glossary_keywords order by keyword`
    const [recallTable] = await tx<{ exists: boolean }[]>`
      select to_regclass('recall_events') is not null as exists`
    const recallEvents = recallTable?.exists
      ? ((await tx<{ n: number }[]>`select count(*)::int as n from recall_events`)[0]?.n ?? 0)
      : null

    const contentOf = new Map(current.map((c) => [c.uuid, c]))
    const versionsOf = new Map(versions.map((v) => [v.uuid, v.n]))
    const nodes = new Map<string, LoreNode>()
    for (const p of paths) {
      const uri = formatUri(p.domain, p.path)
      const existing = nodes.get(p.uuid)
      if (existing) {
        existing.aliases.push(uri)
        continue
      }
      const body = contentOf.get(p.uuid)
      nodes.set(p.uuid, {
        uuid: p.uuid,
        uri,
        aliases: [],
        priority: p.priority,
        disclosure: p.disclosure || null,
        content: body?.content ?? null,
        createdAt: p.created,
        updatedAt: body?.created ?? p.created,
        previousVersions: versionsOf.get(p.uuid) ?? 0,
        keywords: [],
      })
    }
    for (const k of keywords) nodes.get(k.uuid)?.keywords.push(k.keyword)
    return { nodes: [...nodes.values()], recallEvents }
  })
}

export interface ImportOptions {
  // 导入者：主人层、私人层归他；core://agent/<runtime> 只会写进他自己的应用
  accountId: string
  persona: { slug: string; name: string }
  // 这些 Lore URI（含别名）导入为 secret（加密存储）
  secretUris: ReadonlySet<string>
}

export interface ExistingApp {
  slug: string
  runtimeFamily: string
  ownerAccountId: string
}

export interface AppMapping {
  runtime: string
  // create 为 true 表示导入时新建这个应用
  apps: { slug: string; create: boolean; runtimeFamily: RuntimeFamily }[]
}

export interface PlannedMemory {
  source: string
  request: CreateMemoryRequest
  createdAt: Date
  updatedAt: Date
  // 同一个 Lore 节点写到同一个目标（应用）只导入一次，不论之后在 Kioku 里被删除还是移动
  importKey: string
  context: Record<string, unknown>
}

export interface ImportPlan {
  persona: { slug: string; name: string }
  apps: AppMapping[]
  memories: PlannedMemory[]
  skipped: { source: string; reason: string }[]
  droppedKeywords: { source: string; keyword: string; reason: string }[]
  warnings: string[]
  // 有这些问题时拒绝执行，例如 --secret 对不上任何节点：照常导入会把凭据写成明文
  errors: string[]
}

export interface ImportKeyParts {
  loreNodeUuid?: unknown
  targetApp?: unknown
  targetPersona?: unknown
}

// 导入事件 context 里记下的去重键：Lore 节点 uuid，加上写入的应用或人格
// （core://agent/<runtime> 可能写进多个应用；core://soul 换个 --persona 就是另一份）
export function importKeyOf(context: ImportKeyParts): string {
  const app = context.targetApp ? String(context.targetApp) : ''
  const persona = context.targetPersona ? `#${String(context.targetPersona)}` : ''
  return `${String(context.loreNodeUuid)}@${app}${persona}`
}

const MAX_KEYWORDS = 32
const MAX_DISCLOSURE = 500
// 路径里带这些词、或正文像有明文凭据（规则见 contracts 的 PLAINTEXT_CREDENTIAL）的多半含凭据，没有标成 secret 时提醒。
// 只提醒不自动标记：secret 不进召回和 boot，整条记忆都只能显式读取，要由人来权衡
const CREDENTIAL_PATH = /credential|password|passwd|secret|token|密码|凭据/i

// 计划只依赖读出来的数据和已有应用，不写库：先打印给人确认，再执行
export function planImport(
  snapshot: LoreSnapshot,
  existingApps: ExistingApp[],
  options: ImportOptions,
): ImportPlan {
  const plan: ImportPlan = {
    persona: options.persona,
    apps: [],
    memories: [],
    skipped: [],
    droppedKeywords: [],
    warnings: [],
    errors: [],
  }

  // core://agent/<runtime> 对应的应用，只在导入者自己的应用里找：别的成员的应用由他们自己管，
  // 写进去会进入他们每次会话的启动上下文。标识相同的优先，其次是同一运行时类型的；
  // 按类型匹配时跳过标识恰好是另一个运行时名的应用，它按标识归那个运行时。都没有就新建
  const slugOf = (runtime: string) => runtime.replace(/_/g, '-')
  const runtimes = new Set(
    snapshot.nodes
      .map((n) => /^core:\/\/agent\/([^/]+)/.exec(n.uri)?.[1])
      .filter((r): r is string => !!r),
  )
  const own = existingApps.filter((a) => a.ownerAccountId === options.accountId)
  const appsByRuntime = new Map<string, AppMapping['apps'] | string>()
  const appsFor = (runtime: string): AppMapping['apps'] | string => {
    const cached = appsByRuntime.get(runtime)
    if (cached) return cached
    const slug = slugOf(runtime)
    const otherSlugs = new Set([...runtimes].filter((r) => r !== runtime).map(slugOf))
    const family = (RUNTIME_FAMILIES as readonly string[]).includes(runtime)
      ? (runtime as RuntimeFamily)
      : 'other'
    const bySlug = own.filter((a) => a.slug === slug)
    const byFamily = own.filter((a) => a.runtimeFamily === runtime && !otherSlugs.has(a.slug))
    const matched = bySlug.length ? bySlug : byFamily
    let result: AppMapping['apps'] | string = matched.map((a) => ({
      slug: a.slug,
      create: false,
      runtimeFamily: a.runtimeFamily as RuntimeFamily,
    }))
    if (!result.length) {
      if (existingApps.some((a) => a.slug === slug)) {
        result = `应用标识 ${slug} 已被别的成员占用：先在管理界面建一个自己的、运行时类型为 ${family} 的应用，再重新导入`
      } else if (!Slug.safeParse(slug).success) {
        result = `运行时 ${runtime} 无法作为应用标识`
      } else {
        result = [{ slug, create: true, runtimeFamily: family }]
      }
    }
    appsByRuntime.set(runtime, result)
    if (typeof result !== 'string') plan.apps.push({ runtime, apps: result })
    return result
  }

  // --secret 也可以写别名；对不上任何节点时拒绝执行，免得拼错一个字就把凭据导成明文
  const nodeByUri = new Map<string, LoreNode>()
  for (const node of snapshot.nodes) {
    nodeByUri.set(node.uri, node)
    for (const alias of node.aliases) nodeByUri.set(alias, node)
  }
  const secretNodes = new Set<string>()
  for (const uri of options.secretUris) {
    const node = nodeByUri.get(uri)
    if (node) secretNodes.add(node.uuid)
    else plan.errors.push(`--secret 指定的 ${uri} 在 Lore 里不存在`)
  }
  // 两个节点映射到同一个 URI 时只导入第一个
  const plannedUris = new Map<string, string>()

  for (const node of snapshot.nodes) {
    for (const alias of node.aliases) {
      plan.skipped.push({ source: alias, reason: `是 ${node.uri} 的别名，Kioku 没有别名` })
    }
    if (!node.content) {
      plan.skipped.push({ source: node.uri, reason: '没有正文' })
      continue
    }
    // 占位符的写入规则在计划里先查一遍，不用等执行时逐条失败
    const malformed = scanPlaceholders(node.content).malformed[0]
    if (malformed) {
      plan.skipped.push({
        source: node.uri,
        reason: `正文里有格式不对的凭据占位符 ${malformed}：写到这种写法的说明文字要去掉花括号`,
      })
      continue
    }
    const parsed = parseUri(node.uri)
    if (!parsed) {
      plan.skipped.push({ source: node.uri, reason: 'URI 不符合 Kioku 的格式' })
      continue
    }
    if (parsed.domain === PERSONA_DOMAIN || parsed.domain === APP_DOMAIN) {
      plan.skipped.push({ source: node.uri, reason: `${parsed.domain}:// 是 Kioku 的保留 domain` })
      continue
    }

    const segments = parsed.path.split('/')
    let targets: { uri: string; layer: Layer; app?: string; persona?: string }[]
    if (parsed.domain === 'core' && segments[0] === 'soul') {
      targets = [
        {
          uri: formatUri(PERSONA_DOMAIN, [options.persona.slug, ...segments].join('/')),
          layer: 'persona',
          persona: options.persona.slug,
        },
      ]
    } else if (parsed.domain === 'core' && segments[0] === 'agent' && segments.length > 1) {
      const mapped = appsFor(segments[1]!)
      if (typeof mapped === 'string') {
        plan.skipped.push({ source: node.uri, reason: mapped })
        continue
      }
      targets = mapped.map((app) => ({
        uri: formatUri(APP_DOMAIN, [app.slug, 'agent', ...segments.slice(2)].join('/')),
        layer: 'app',
        app: app.slug,
      }))
    } else if (parsed.domain === 'core') {
      targets = [{ uri: node.uri, layer: 'base' }]
    } else if (parsed.domain === 'preferences') {
      targets = [{ uri: node.uri, layer: 'owner' }]
    } else {
      targets = [{ uri: node.uri, layer: 'private' }]
    }

    // 路径看主路径和别名；正文之外 disclosure 与关键词也看：secret 只加密正文，这两项始终是明文
    const secret = secretNodes.has(node.uuid)
    const extras = [node.disclosure ?? '', ...node.keywords].join('\n')
    if (!secret && [node.uri, ...node.aliases].some((u) => CREDENTIAL_PATH.test(u))) {
      plan.warnings.push(`${node.uri} 看起来是凭据，没有用 --secret 标记`)
    } else if (!secret && looksLikePlaintextCredential(`${node.content}\n${extras}`)) {
      plan.warnings.push(`${node.uri} 的正文里像有密码或 Token，没有用 --secret 标记`)
    } else if (secret && looksLikePlaintextCredential(extras)) {
      plan.warnings.push(
        `${node.uri} 的 disclosure 或关键词里像有凭据：secret 只加密正文，这两项仍是明文`,
      )
    }
    let disclosure = node.disclosure ?? undefined
    if (disclosure && disclosure.length > MAX_DISCLOSURE) {
      plan.warnings.push(`${node.uri} 的 disclosure 超过 ${MAX_DISCLOSURE} 字，已截断`)
      disclosure = disclosure.slice(0, MAX_DISCLOSURE)
    }
    // 按真正会写进去的 disclosure 判断（截断之后）；关键词里的占位符在 keywordsOf 里单独丢掉
    if (disclosure && mentionsPlaceholder(disclosure)) {
      plan.skipped.push({
        source: node.uri,
        reason: 'disclosure 里有凭据占位符：占位符只能写在正文里',
      })
      continue
    }
    const glossary = keywordsOf(node, plan)
    const hasRefs = scanPlaceholders(node.content).refs.length > 0

    for (const target of targets) {
      const earlier = plannedUris.get(target.uri)
      if (earlier) {
        plan.skipped.push({ source: node.uri, reason: `和 ${earlier} 映射到同一个 ${target.uri}` })
        continue
      }
      // 占位符只能放在私人层、敏感级至少 private 的记忆里（规则见 memory/service.ts 的写入检查）
      const sensitivity = secret ? 'secret' : DEFAULT_SENSITIVITY[target.layer]
      if (
        hasRefs &&
        (target.layer !== 'private' || sensitivityRank(sensitivity) < sensitivityRank('private'))
      ) {
        plan.skipped.push({
          source: node.uri,
          reason: `正文里有凭据占位符，只能放在私人层、敏感级至少 private 的记忆里，${target.uri} 是 ${target.layer} 层`,
        })
        continue
      }
      const request = CreateMemoryRequest.safeParse({
        uri: target.uri,
        content: node.content,
        layer: target.layer,
        ...(secret ? { sensitivity: 'secret' } : {}),
        priority: node.priority,
        ...(disclosure ? { disclosure } : {}),
        glossary,
      })
      if (!request.success) {
        plan.skipped.push({
          source: node.uri,
          reason: request.error.issues.map((i) => i.message).join('；'),
        })
        continue
      }
      plannedUris.set(target.uri, node.uri)
      const context = {
        source: 'lore',
        loreUri: node.uri,
        loreNodeUuid: node.uuid,
        targetApp: target.app ?? null,
        targetPersona: target.persona ?? null,
        previousVersions: node.previousVersions,
      }
      plan.memories.push({
        source: node.uri,
        request: request.data,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        importKey: importKeyOf(context),
        context,
      })
    }
  }
  return plan
}

// 关键词与接口写入的规则一致：至少两个字、最长 64 字、每条最多 32 个；超出时保留较长、较具体的
function keywordsOf(node: LoreNode, plan: ImportPlan): string[] {
  const kept: string[] = []
  for (const raw of node.keywords) {
    const keyword = raw.trim()
    if (mentionsPlaceholder(keyword)) {
      plan.droppedKeywords.push({
        source: node.uri,
        keyword,
        reason: '有凭据占位符，占位符只能写在正文里',
      })
    } else if (keyword.length < 2) {
      plan.droppedKeywords.push({ source: node.uri, keyword, reason: '不足两个字' })
    } else if (keyword.length > 64) {
      plan.droppedKeywords.push({ source: node.uri, keyword, reason: '超过 64 个字' })
    } else if (!kept.includes(keyword)) {
      kept.push(keyword)
    }
  }
  kept.sort((a, b) => b.length - a.length || a.localeCompare(b))
  for (const keyword of kept.splice(MAX_KEYWORDS)) {
    plan.droppedKeywords.push({ source: node.uri, keyword, reason: `超过每条 ${MAX_KEYWORDS} 个` })
  }
  return kept.sort()
}

export interface ImportTarget {
  db: Db
  spaceId: string
  accountId: string
  masterKey: Buffer | null
}

export interface ImportResult {
  personaCreated: boolean
  appsCreated: string[]
  // 原本没有默认人格、导入时设成了导入的人格
  appsGivenPersona: string[]
  // 已经在用别的人格：导入的 core://soul 不会进入它们的启动上下文
  appsOtherPersona: string[]
  created: string[]
  // 之前导入过的（之后在 Kioku 里删除或移动了的也算），不再重复写入
  previouslyImported: string[]
  // 这次要求 secret、但之前导入过而且现在还是明文的：--secret 对它们不起作用，要在管理界面改。
  // current 是记忆现在的 URI，导入后移动过的与 uri 不同；同一个节点导入过多条的，每条明文各占一项
  secretAlreadyImported: { uri: string; current: string }[]
  // URI 已被不是导入产生的记忆占用
  occupied: string[]
  failed: { uri: string; reason: string }[]
}

// 按计划写入。可以重复执行：导入过的节点按导入事件去重，已有的人格与应用直接复用
export async function applyImport(
  target: ImportTarget,
  plan: ImportPlan,
  // 同步时发现 Lore 里换了路径、映射到别处的节点（见 SyncPlan.skipCreate），不在新位置再建一条
  options: { skip?: ReadonlySet<string> } = {},
): Promise<ImportResult> {
  const { db, spaceId, accountId } = target
  const result: ImportResult = {
    personaCreated: false,
    appsCreated: [],
    appsGivenPersona: [],
    appsOtherPersona: [],
    created: [],
    previouslyImported: [],
    secretAlreadyImported: [],
    occupied: [],
    failed: [],
  }
  // 执行时发现不属于导入者的应用（计划之后被别人抢先建了同名应用、或被转走），不往里写。
  // 写入期间才被转走的，由每次写入时同一个事务里的归属核对拦下（requireAppOwner）
  const blockedApps = new Set<string>()

  await withSpace(db, spaceId, async (tx) => {
    const [created] = await tx
      .insert(personas)
      .values({ spaceId, slug: plan.persona.slug, name: plan.persona.name })
      .onConflictDoNothing()
      .returning({ id: personas.id })
    result.personaCreated = Boolean(created)
    const personaId =
      created?.id ??
      (
        await tx
          .select({ id: personas.id })
          .from(personas)
          .where(eq(personas.slug, plan.persona.slug))
      )[0]!.id

    // Lore 里所有客户端都读同一个 core://soul，所以对应的应用都用导入的人格；
    // 已有的应用只在还没有默认人格时设置
    for (const mapping of plan.apps) {
      for (const app of mapping.apps) {
        if (app.create) {
          const rows = await tx
            .insert(apps)
            .values({
              spaceId,
              slug: app.slug,
              name: mapping.runtime,
              runtimeFamily: app.runtimeFamily,
              ownerAccountId: accountId,
              defaultPersonaId: personaId,
            })
            .onConflictDoNothing()
            .returning({ slug: apps.slug })
          if (rows.length) {
            result.appsCreated.push(app.slug)
            continue
          }
        }
        const [current] = await tx
          .select({ owner: apps.ownerAccountId, personaId: apps.defaultPersonaId })
          .from(apps)
          .where(eq(apps.slug, app.slug))
          .for('update')
        if (current?.owner !== accountId) {
          blockedApps.add(app.slug)
        } else if (current.personaId === null) {
          await tx
            .update(apps)
            .set({ defaultPersonaId: personaId, updatedAt: new Date() })
            .where(eq(apps.slug, app.slug))
          result.appsGivenPersona.push(app.slug)
        } else if (current.personaId !== personaId) {
          result.appsOtherPersona.push(app.slug)
        }
      }
    }
  })

  const done = await importedMemories(db, spaceId)
  const service = importerService(target)
  for (const item of plan.memories) {
    const app = item.context.targetApp
    if (typeof app === 'string' && blockedApps.has(app)) {
      result.failed.push({ uri: item.request.uri, reason: `应用 ${app} 不属于导入者，没有写入` })
      continue
    }
    if (options.skip?.has(item.importKey)) {
      result.previouslyImported.push(item.request.uri)
      continue
    }
    const found = done.get(item.importKey)
    if (found) {
      result.previouslyImported.push(item.request.uri)
      // 这次要求 secret、对应的记忆现在却是明文的才提醒；已经是 secret 或已经删除的照常跳过。
      // 一个键对应多条时每条明文都提醒，不看先后；导入后移动过的，旧 URI 上可能已经是别的记忆，提醒里要给出它现在的位置
      if (item.request.sensitivity === 'secret') {
        for (const f of found) {
          if (f.state !== 'plain') continue
          result.secretAlreadyImported.push({
            uri: item.request.uri,
            current: f.uri ?? item.request.uri,
          })
        }
      }
      continue
    }
    try {
      await service.create(item.request, {
        eventType: 'import',
        eventContext: item.context,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        requireAppOwner: accountId,
      })
      result.created.push(item.request.uri)
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err
      if (err.status === 409) result.occupied.push(item.request.uri)
      else result.failed.push({ uri: item.request.uri, reason: err.message })
    }
  }
  return result
}

interface ImportedMemory {
  key: string
  memoryId: string | null
  loreNodeUuid: string
  // 导入时这个节点在 Lore 里的 URI；事件里没记的为 null，不拿它判断换没换路径
  loreUri: string | null
  state: 'secret' | 'plain' | 'deleted'
  // 记忆现在的 URI 与版本号，已经删除的为 null
  uri: string | null
  version: number | null
}

// 导入过的节点：去重键 → 每条导入事件对应的记忆现在的状态（是不是 secret，或者已经删除）与现在的 URI。
// 早期版本去重不上时会把同一个节点再写一条，所以一个键可能对应多条记忆。
// 早期的导入事件没有记 targetPersona：人格层的从导入时的快照补出来（当时 URI 的第一段就是人格），
// 记忆后来删掉了也补得出，去重键才与现在的一致
async function importedMemories(db: Db, spaceId: string): Promise<Map<string, ImportedMemory[]>> {
  const imported = await withSpace(db, spaceId, (tx) =>
    tx
      .select({
        memoryId: memoryEvents.memoryId,
        context: memoryEvents.context,
        importedDomain: sql<string | null>`${memoryEvents.after}->>'domain'`,
        importedPath: sql<string | null>`${memoryEvents.after}->>'path'`,
        sensitivity: memories.sensitivity,
        deletedAt: memories.deletedAt,
        domain: memories.domain,
        path: memories.path,
        version: memories.version,
      })
      .from(memoryEvents)
      .leftJoin(memories, eq(memories.id, memoryEvents.memoryId))
      .where(
        and(eq(memoryEvents.eventType, 'import'), sql`${memoryEvents.context}->>'source' = 'lore'`),
      )
      .orderBy(memoryEvents.id),
  )
  const done = new Map<string, ImportedMemory[]>()
  for (const e of imported) {
    const context = e.context as ImportKeyParts & { loreUri?: unknown }
    const parts =
      context.targetPersona === undefined && e.importedDomain === PERSONA_DOMAIN
        ? { ...context, targetPersona: e.importedPath?.split('/')[0] }
        : context
    // 看记忆现在的状态：导入后在管理界面改成了 secret 的，也算已经是 secret。
    // 记忆被软删除，或整行已经不在（例如删除账号时级联删掉，事件的 memory_id 被置空，联表取不到），都算已经删除
    const gone = e.deletedAt !== null || e.sensitivity === null
    const key = importKeyOf(parts)
    done.set(key, [
      ...(done.get(key) ?? []),
      {
        key,
        memoryId: e.memoryId,
        loreNodeUuid: String(context.loreNodeUuid),
        loreUri: typeof context.loreUri === 'string' ? context.loreUri : null,
        state: gone ? 'deleted' : e.sensitivity === 'secret' ? 'secret' : 'plain',
        uri: !gone && e.domain && e.path ? formatUri(e.domain, e.path) : null,
        version: gone ? null : e.version,
      },
    ])
  }
  return done
}

// 按空间 owner 的管理界面权限写入，来源记为 system。正文里已有的凭据占位符照常检查（要解析到导入者的凭据），
// 但允许新增：这是主人自己把数据搬进自己的私人层，不是抽取或 Dream
function importerService(target: ImportTarget): MemoryService {
  return new MemoryService({
    db: target.db,
    spaceId: target.spaceId,
    access: { ...consoleAccess('owner', target.accountId), writeProvenance: 'system' },
    personaId: 'all',
    masterKey: target.masterKey,
    actor: { accountId: target.accountId },
    allowCredentialRefs: true,
  })
}

// 同步导入过的节点：把 Kioku 里的记忆改成 Lore 里现在的正文、priority、disclosure 与关键词，敏感级不动。
// 只动导入（或上次同步）之后在 Kioku 里没人改过的：记忆现在的版本号还是导入工具最后写下的那个才算，
// 任何修改、移动、撤销删除都会让版本号加一。在 Kioku 里改过、移动过、删除了的一律不动，
// 凭据迁移改过的凭据节点也就不会被 Lore 里的明文盖回去；
// Lore 里路径变了的也不动，移动可能改变层（例如移进 core:// 就成了所有应用都读的基础层），要由人决定
export type SyncState =
  'update' | 'current' | 'edited' | 'moved' | 'deleted' | 'skipped' | 'unreadable'

export interface SyncItem {
  source: string
  // 记忆现在的 URI；在 Kioku 里删除了的是导入时的 URI
  uri: string
  state: SyncState
  // state 为 moved 时，按 Lore 现在的路径应当在的 URI
  target?: string
  // state 为 skipped（这次的导入计划不导入这个节点）或 unreadable 时的原因
  reason?: string
  changes: ('content' | 'priority' | 'disclosure' | 'glossary')[]
  request?: UpdateMemoryRequest
  context?: Record<string, unknown>
}

export interface SyncPlan {
  items: SyncItem[]
  // 导入过、但 Lore 里已经没有这个节点的记忆现在的 URI：Kioku 里保留，要删由人决定
  goneFromLore: string[]
  // Lore 里换了路径、映射到别的应用或人格的节点：去重键跟着变了，导入时不要在新位置再建一条
  skipCreate: Set<string>
}

// 只读：算出同步要做什么，打印给人确认；执行时再按版本号核对一次
export async function planSync(
  target: ImportTarget,
  plan: ImportPlan,
  snapshot: LoreSnapshot,
): Promise<SyncPlan> {
  const done = await importedMemories(target.db, target.spaceId)
  const all = [...done.values()].flat()
  const live = all.filter((m) => m.state !== 'deleted' && m.memoryId)
  // 导入工具最后一次写下的版本号：导入与同步事件的快照里都有
  const written = live.length
    ? await withSpace(target.db, target.spaceId, (tx) =>
        tx
          .select({
            memoryId: memoryEvents.memoryId,
            version: sql<number | null>`max((${memoryEvents.after}->>'version')::int)`,
          })
          .from(memoryEvents)
          .where(
            and(
              inArray(
                memoryEvents.memoryId,
                live.map((m) => m.memoryId!),
              ),
              inArray(memoryEvents.eventType, ['import', 'sync']),
              sql`${memoryEvents.context}->>'source' = 'lore'`,
            ),
          )
          .groupBy(memoryEvents.memoryId),
      )
    : []
  const writtenVersion = new Map(written.map((w) => [w.memoryId, w.version]))
  const untouched = (m: ImportedMemory) =>
    m.version !== null && writtenVersion.get(m.memoryId) === m.version
  // 只有真要读出来比对的 secret 才需要主密钥
  if (!target.masterKey && live.some((m) => m.state === 'secret' && untouched(m))) {
    throw new Error('导入过的 secret 记忆要读出来比对：同步需要设置与服务相同的 KIOKU_MASTER_KEY')
  }

  const service = importerService(target)
  const sync: SyncPlan = { items: [], goneFromLore: [], skipCreate: new Set() }
  const reported = new Set<ImportedMemory>()
  const report = (m: ImportedMemory, item: Omit<SyncItem, 'changes'>) => {
    reported.add(m)
    sync.items.push({ ...item, changes: [] })
  }
  for (const item of plan.memories) {
    const same = done.get(item.importKey)
    if (!same) {
      // 同一个 Lore 节点之前按别的去重键导入过（Lore 里换了路径，映射到了别的应用或人格）：
      // 和同一个键下换了路径一样只列出来，不在新位置再建一条。换个 --persona 再导入时 Lore 的 URI 不变，不算
      const earlier = all.filter(
        (m) =>
          m.loreNodeUuid === item.context.loreNodeUuid &&
          m.loreUri !== null &&
          m.loreUri !== item.source,
      )
      if (earlier.length) sync.skipCreate.add(item.importKey)
      for (const m of earlier) {
        if (m.state === 'deleted' || !m.uri) {
          report(m, { source: item.source, uri: item.request.uri, state: 'deleted' })
        } else {
          report(m, { source: item.source, uri: m.uri, state: 'moved', target: item.request.uri })
        }
      }
      continue
    }
    for (const m of same) {
      const base = { source: item.source }
      if (m.state === 'deleted' || !m.uri) {
        report(m, { ...base, uri: item.request.uri, state: 'deleted' })
      } else if (!untouched(m)) {
        report(m, { ...base, uri: m.uri, state: 'edited' })
      } else if (m.uri !== item.request.uri) {
        report(m, { ...base, uri: m.uri, state: 'moved', target: item.request.uri })
      } else {
        let current
        try {
          current = await service.get(m.uri)
        } catch (err) {
          if (!(err instanceof MemoryError)) throw err
          report(m, { ...base, uri: m.uri, state: 'unreadable', reason: err.message })
          continue
        }
        // 读到的应当就是导入的那一条，而且版本没变；对不上就是刚刚有人动过，不去改它
        if (current.id !== m.memoryId || current.version !== m.version) {
          report(m, { ...base, uri: m.uri, state: 'edited' })
          continue
        }
        const want = item.request
        const request: UpdateMemoryRequest = {
          uri: m.uri,
          expectedId: current.id,
          expectedVersion: current.version,
        }
        const changes: SyncItem['changes'] = []
        if (current.content !== want.content) {
          request.content = want.content
          changes.push('content')
        }
        if (want.priority !== undefined && current.priority !== want.priority) {
          request.priority = want.priority
          changes.push('priority')
        }
        if ((current.disclosure ?? null) !== (want.disclosure ?? null)) {
          request.disclosure = want.disclosure ?? null
          changes.push('disclosure')
        }
        const wanted = new Set(want.glossary ?? [])
        const add = [...wanted].filter((k) => !current.glossary.includes(k))
        const remove = current.glossary.filter((k) => !wanted.has(k))
        if (add.length || remove.length) {
          if (add.length) request.glossaryAdd = add
          if (remove.length) request.glossaryRemove = remove
          changes.push('glossary')
        }
        reported.add(m)
        sync.items.push(
          changes.length
            ? { ...base, uri: m.uri, state: 'update', changes, request, context: item.context }
            : { ...base, uri: m.uri, state: 'current', changes: [] },
        )
      }
    }
  }
  // 导入过、节点还在 Lore 里，这次的计划却不导入它（例如正文清空了、写进了格式不对的占位符）：
  // 列出来并给出原因，不能悄悄不同步
  const nodeByUuid = new Map(snapshot.nodes.map((n) => [n.uuid, n]))
  for (const m of all) {
    if (reported.has(m)) continue
    const node = nodeByUuid.get(m.loreNodeUuid)
    if (!node) {
      if (m.uri) sync.goneFromLore.push(m.uri)
      continue
    }
    if (m.state === 'deleted' || !m.uri) continue
    const reason = plan.skipped.find((s) => s.source === node.uri)?.reason
    if (reason) {
      sync.items.push({ source: node.uri, uri: m.uri, state: 'skipped', reason, changes: [] })
    }
  }
  return sync
}

export interface SyncResult {
  updated: string[]
  failed: { uri: string; reason: string }[]
}

export async function applySync(target: ImportTarget, sync: SyncPlan): Promise<SyncResult> {
  const result: SyncResult = { updated: [], failed: [] }
  const service = importerService(target)
  for (const item of sync.items) {
    if (item.state !== 'update' || !item.request) continue
    try {
      // 计划之后有人改过、或者同一个 URI 上换了一条记忆，按 expectedId 与 expectedVersion 拒绝
      await service.update(item.request, {
        eventType: 'sync',
        eventContext: { ...item.context, changes: item.changes },
        requireAppOwner: target.accountId,
      })
      result.updated.push(item.uri)
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err
      result.failed.push({ uri: item.uri, reason: err.message })
    }
  }
  return result
}

// 导入 secret 之前确认主密钥和服务用的是同一把：库里已有加密数据时试着解密一条。
// 返回 false 表示库里还没有加密数据、没法确认；对不上时抛错
export async function verifyMasterKey(
  db: Db,
  spaceId: string,
  masterKey: Buffer,
): Promise<boolean> {
  // 读库出错时原样抛出，只有解密失败才说是主密钥不一致
  const stored = await sealedEmbeddingKey(db)
  if (stored) {
    try {
      decryptSecret(masterKey, stored.sealed, stored.aad)
      return true
    } catch {
      throw new Error('KIOKU_MASTER_KEY 解不开已保存的嵌入接口 Key：它和服务使用的主密钥不一致')
    }
  }
  const [sealed] = await withSpace(db, spaceId, (tx) =>
    tx
      .select({ id: memories.id, ciphertext: memories.ciphertext, wrappedKey: memories.wrappedKey })
      .from(memories)
      .where(and(isNotNull(memories.ciphertext), isNotNull(memories.wrappedKey)))
      .limit(1),
  )
  if (!sealed) return false
  try {
    decryptSecret(
      masterKey,
      { ciphertext: sealed.ciphertext!, wrappedKey: sealed.wrappedKey! },
      sealed.id,
    )
    return true
  } catch {
    throw new Error('KIOKU_MASTER_KEY 解不开已有的 secret 记忆：它和服务使用的主密钥不一致')
  }
}
