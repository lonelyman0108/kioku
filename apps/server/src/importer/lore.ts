import {
  CreateMemoryRequest,
  RUNTIME_FAMILIES,
  Slug,
  type Layer,
  type RuntimeFamily,
} from '@kioku/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import type postgres from 'postgres'

import { consoleAccess } from '../access/access'
import { withSpace, type Db } from '../db/client'
import { apps, personas } from '../db/schema'
import { MemoryError, MemoryService } from '../memory/service'
import { APP_DOMAIN, PERSONA_DOMAIN, formatUri, parseUri } from '../memory/uri'

// 从 Lore 导入（设计第 11 节）。Lore 只读访问；映射规则：
// core://agent → 基础层；core://soul → 指定人格的 persona 层；core://agent/<runtime> → 对应应用的应用层；
// preferences:// → 主人层；其余 domain → 导入者的私人层。
// 历史版本不迁移，每条记忆记一条 import 事件，带上 Lore 的节点 uuid 与旧版本数；召回事件不迁移

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
  persona: { slug: string; name: string }
  // 这些 Lore URI 导入为 secret（加密存储）
  secretUris: ReadonlySet<string>
}

export interface ExistingApp {
  slug: string
  runtimeFamily: string
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
  context: Record<string, unknown>
}

export interface ImportPlan {
  persona: { slug: string; name: string }
  apps: AppMapping[]
  memories: PlannedMemory[]
  skipped: { source: string; reason: string }[]
  droppedKeywords: { source: string; keyword: string; reason: string }[]
  warnings: string[]
}

const MAX_KEYWORDS = 32
const MAX_DISCLOSURE = 500
// 路径里带这些词、或正文里有「密码：…」「token = …」这类写法的多半含凭据，没有标成 secret 时提醒。
// 只提醒不自动标记：secret 不进召回和 boot，整条记忆都只能显式读取，要由人来权衡
const CREDENTIAL_PATH = /credential|password|passwd|secret|token|密码|凭据/i
const CREDENTIAL_CONTENT =
  /(password|passwd|密码|口令|token|api[_ -]?key|secret)\s*[:：=]|sk-[A-Za-z0-9]{16,}/i

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
  }

  // core://agent/<runtime> 对应的应用：标识相同的应用优先，其次是同一运行时类型的所有应用，都没有就新建
  const appsByRuntime = new Map<string, AppMapping['apps'] | null>()
  const appsFor = (runtime: string) => {
    if (appsByRuntime.has(runtime)) return appsByRuntime.get(runtime)!
    const slug = runtime.replace(/_/g, '-')
    const family = (RUNTIME_FAMILIES as readonly string[]).includes(runtime)
      ? (runtime as RuntimeFamily)
      : 'other'
    const bySlug = existingApps.filter((a) => a.slug === slug)
    const byFamily = existingApps.filter((a) => a.runtimeFamily === runtime)
    const matched = bySlug.length ? bySlug : byFamily
    let mapped: AppMapping['apps'] | null = matched.map((a) => ({
      slug: a.slug,
      create: false,
      runtimeFamily: a.runtimeFamily as RuntimeFamily,
    }))
    if (!mapped.length) {
      mapped = Slug.safeParse(slug).success ? [{ slug, create: true, runtimeFamily: family }] : null
    }
    appsByRuntime.set(runtime, mapped)
    if (mapped) plan.apps.push({ runtime, apps: mapped })
    return mapped
  }

  const sourceUris = new Set(snapshot.nodes.map((n) => n.uri))
  for (const uri of options.secretUris) {
    if (!sourceUris.has(uri)) plan.warnings.push(`--secret 指定的 ${uri} 在 Lore 里不存在`)
  }

  for (const node of snapshot.nodes) {
    for (const alias of node.aliases) {
      plan.skipped.push({ source: alias, reason: `是 ${node.uri} 的别名，Kioku 没有别名` })
    }
    if (!node.content) {
      plan.skipped.push({ source: node.uri, reason: '没有正文' })
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
    let targets: { uri: string; layer: Layer }[]
    if (parsed.domain === 'core' && segments[0] === 'soul') {
      targets = [
        {
          uri: formatUri(PERSONA_DOMAIN, [options.persona.slug, ...segments].join('/')),
          layer: 'persona',
        },
      ]
    } else if (parsed.domain === 'core' && segments[0] === 'agent' && segments.length > 1) {
      const mapped = appsFor(segments[1]!)
      if (!mapped) {
        plan.skipped.push({ source: node.uri, reason: `运行时 ${segments[1]} 无法作为应用标识` })
        continue
      }
      targets = mapped.map((app) => ({
        uri: formatUri(APP_DOMAIN, [app.slug, 'agent', ...segments.slice(2)].join('/')),
        layer: 'app',
      }))
    } else if (parsed.domain === 'core') {
      targets = [{ uri: node.uri, layer: 'base' }]
    } else if (parsed.domain === 'preferences') {
      targets = [{ uri: node.uri, layer: 'owner' }]
    } else {
      targets = [{ uri: node.uri, layer: 'private' }]
    }

    const secret = options.secretUris.has(node.uri)
    if (!secret && CREDENTIAL_PATH.test(node.uri)) {
      plan.warnings.push(`${node.uri} 看起来是凭据，没有用 --secret 标记`)
    } else if (!secret && CREDENTIAL_CONTENT.test(node.content)) {
      plan.warnings.push(`${node.uri} 的正文里像有密码或 Token，没有用 --secret 标记`)
    }
    let disclosure = node.disclosure ?? undefined
    if (disclosure && disclosure.length > MAX_DISCLOSURE) {
      plan.warnings.push(`${node.uri} 的 disclosure 超过 ${MAX_DISCLOSURE} 字，已截断`)
      disclosure = disclosure.slice(0, MAX_DISCLOSURE)
    }
    const glossary = keywordsOf(node, plan)

    for (const target of targets) {
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
      plan.memories.push({
        source: node.uri,
        request: request.data,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        context: {
          source: 'lore',
          loreUri: node.uri,
          loreNodeUuid: node.uuid,
          previousVersions: node.previousVersions,
        },
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
    if (keyword.length < 2) {
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
  existing: string[]
  failed: { uri: string; reason: string }[]
}

// 按计划写入。可以重复执行：已存在的 URI 跳过，已有的人格与应用直接复用
export async function applyImport(target: ImportTarget, plan: ImportPlan): Promise<ImportResult> {
  const { db, spaceId, accountId } = target
  const result: ImportResult = {
    personaCreated: false,
    appsCreated: [],
    appsGivenPersona: [],
    appsOtherPersona: [],
    created: [],
    existing: [],
    failed: [],
  }

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

    // Lore 里所有客户端都读同一个 core://soul，所以对应的应用都用导入的人格。
    // 已有的应用只在还没有默认人格、且属于导入者时才设置，不改别人的配置
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
          if (rows.length) result.appsCreated.push(app.slug)
        } else {
          const rows = await tx
            .update(apps)
            .set({ defaultPersonaId: personaId, updatedAt: new Date() })
            .where(
              and(
                eq(apps.slug, app.slug),
                isNull(apps.defaultPersonaId),
                eq(apps.ownerAccountId, accountId),
              ),
            )
            .returning({ slug: apps.slug })
          if (rows.length) {
            result.appsGivenPersona.push(app.slug)
            continue
          }
          const [current] = await tx
            .select({ personaId: apps.defaultPersonaId })
            .from(apps)
            .where(eq(apps.slug, app.slug))
          if (current?.personaId !== personaId) result.appsOtherPersona.push(app.slug)
        }
      }
    }
  })

  // 按空间 owner 的管理界面权限写入，来源记为 system
  const service = new MemoryService({
    db,
    spaceId,
    access: { ...consoleAccess('owner', accountId), writeProvenance: 'system' },
    personaId: 'all',
    masterKey: target.masterKey,
    actor: { accountId },
  })
  for (const item of plan.memories) {
    try {
      await service.get(item.request.uri)
      result.existing.push(item.request.uri)
      continue
    } catch (err) {
      if (!(err instanceof MemoryError) || err.status !== 404) throw err
    }
    try {
      await service.create(item.request, {
        eventType: 'import',
        eventContext: item.context,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })
      result.created.push(item.request.uri)
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err
      result.failed.push({ uri: item.request.uri, reason: err.message })
    }
  }
  return result
}
