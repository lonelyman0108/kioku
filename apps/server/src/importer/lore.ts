import { createHash } from 'node:crypto'

import {
  CreateMemoryRequest,
  RUNTIME_FAMILIES,
  Slug,
  type Layer,
  type LoreTargetState,
  type LoreWarningKind,
  type RuntimeFamily,
  type UpdateMemoryRequest,
} from '@kioku/contracts'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type postgres from 'postgres'

import { consoleAccess } from '../access/access'
import {
  looksLikePlaintextCredential,
  mentionsPlaceholder,
  placeholderAllowed,
  scanPlaceholders,
} from '../credential/placeholders'
import { decryptSecret } from '../crypto/envelope'
import { decryptionKey, type MasterKey } from '../crypto/keyring'
import { sealedSettingsKeys } from '../crypto/rotation'
import { pgErrorCode, withSpace, type Db } from '../db/client'
import { apps, memories, memoryEvents, personas } from '../db/schema'
import { LAYER_NAMES } from '../memory/names'
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
  // 这些 Lore URI（含别名）这次不导入，导入过的就是这次不同步。同时标了 secret 时以这里为准
  excludeUris?: ReadonlySet<string>
  // 这份数据的导出时间（ISO 8601），记进事件的 context，用来判断之后的文件新旧。
  // 命令行读的是现在的库，没有这一项
  exportedAt?: string
  // 跳过的原因里引用正文中那段格式不对的占位符，好到 Lore 里找。这段可能带着后面的明文，只有命令行打开：
  // 输出在主人自己的终端上。接口不打开，计划视图不含正文
  quoteMalformed?: boolean
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
  // 文字由命令行与界面各自拼
  warnings: { uri: string; kind: LoreWarningKind }[]
  // 有这些问题时拒绝执行，例如要标 secret 的 URI 对不上任何节点：照常导入会把凭据写成明文
  errors: ImportPlanError[]
}

// 指定的 URI 对不上任何节点
export interface ImportPlanError {
  kind: 'secretNotFound' | 'excludeNotFound'
  uri: string
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
export const MAX_DISCLOSURE = 500
// 路径里带这些词、或正文像有明文凭据（规则见 contracts 的 PLAINTEXT_CREDENTIAL）的多半含凭据，没有标成 secret 时提醒。
// 只提醒不自动标记：secret 不进召回和 boot，整条记忆都只能显式读取，要由人来权衡
const CREDENTIAL_PATH = /credential|password|passwd|secret|token|密码|凭据/i

const extrasOf = (node: LoreNode) => [node.disclosure ?? '', ...node.keywords].join('\n')

// 按 UTF-16 单元截断可能切开代理对。落单的代理项写进 text 时被换成 U+FFFD：存下来末尾多一个乱码，又和这里算出的
// 对不上，这个节点之后每次同步都算要更新。所以切开时连前半个一起去掉
function truncateDisclosure(text: string): string {
  const cut = text.slice(0, MAX_DISCLOSURE)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

// 一个节点像不像含凭据，路径（主路径与别名）、正文、disclosure 或关键词分开看
export function credentialHints(node: LoreNode): {
  path: boolean
  content: boolean
  extras: boolean
} {
  return {
    path: [node.uri, ...node.aliases].some((u) => CREDENTIAL_PATH.test(u)),
    content: looksLikePlaintextCredential(node.content ?? ''),
    extras: looksLikePlaintextCredential(extrasOf(node)),
  }
}

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
  const runtimeOf = (uri: string) => /^core:\/\/agent\/([^/]+)/.exec(uri)?.[1]
  const runtimes = new Set(
    snapshot.nodes.map((n) => runtimeOf(n.uri)).filter((r): r is string => !!r),
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
        result = `应用标识 ${slug} 已被其他成员占用。请先在管理界面新建一个属于当前账号、运行时类型为 ${family} 的应用，再重新导入。`
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

  // 要标 secret 的也可以写别名；对不上任何节点时拒绝执行，免得拼错一个字就把凭据导成明文。
  // 不导入的同样：对不上时照常导入，就把明确不要的节点写进去了
  const nodeByUri = new Map<string, LoreNode>()
  for (const node of snapshot.nodes) {
    nodeByUri.set(node.uri, node)
    for (const alias of node.aliases) nodeByUri.set(alias, node)
  }
  const nodesOf = (uris: Iterable<string>, kind: ImportPlanError['kind']) => {
    const found = new Set<string>()
    for (const uri of uris) {
      const node = nodeByUri.get(uri)
      if (node) found.add(node.uuid)
      else plan.errors.push({ kind, uri })
    }
    return found
  }
  const secretNodes = nodesOf(options.secretUris, 'secretNotFound')
  // 按节点判断、在循环里跳过，不从 snapshot 里过滤：runtimes 决定哪些应用按类型匹配，
  // 少算一个运行时，别的节点就会写错应用
  const excludedNodes = nodesOf(options.excludeUris ?? [], 'excludeNotFound')
  // 两个节点映射到同一个 URI 时只导入第一个
  const plannedUris = new Map<string, string>()
  // 勾掉的节点写到的 URI 还占着：写入的只能是看过的计划减去勾掉的。映射到同一个 URI 的下一个节点
  // 在计划里没有写入目标，看不到也勾不了，不能让它顶上来。哪个节点占着要走完下面整段判断才知道，所以先算一次不勾的
  if (excludedNodes.size) {
    const unticked = planImport(snapshot, existingApps, { ...options, excludeUris: new Set() })
    for (const m of unticked.memories) {
      if (excludedNodes.has(String(m.context.loreNodeUuid))) {
        plannedUris.set(m.request.uri, m.source)
      }
    }
  }

  for (const node of snapshot.nodes) {
    for (const alias of node.aliases) {
      plan.skipped.push({ source: alias, reason: `是 ${node.uri} 的别名，Kioku 不支持别名` })
    }
    if (excludedNodes.has(node.uuid)) {
      plan.skipped.push({ source: node.uri, reason: '本次选择不导入' })
      continue
    }
    if (!node.content) {
      plan.skipped.push({ source: node.uri, reason: '没有正文' })
      continue
    }
    // 占位符的写入规则在计划里先查一遍，不用等执行时逐条失败
    const malformed = scanPlaceholders(node.content).malformed[0]
    if (malformed) {
      const quoted = options.quoteMalformed ? ` ${malformed}` : ''
      plan.skipped.push({
        source: node.uri,
        reason: `正文含格式错误的凭据占位符${quoted}。说明文字提到这种写法时，请去掉花括号。`,
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
    const extras = extrasOf(node)
    if (!secret && [node.uri, ...node.aliases].some((u) => CREDENTIAL_PATH.test(u))) {
      plan.warnings.push({ uri: node.uri, kind: 'credentialPath' })
    } else if (!secret && looksLikePlaintextCredential(`${node.content}\n${extras}`)) {
      plan.warnings.push({
        uri: node.uri,
        kind: looksLikePlaintextCredential(node.content) ? 'credentialContent' : 'credentialExtras',
      })
    } else if (secret && looksLikePlaintextCredential(extras)) {
      plan.warnings.push({ uri: node.uri, kind: 'secretExtras' })
    }
    let disclosure = node.disclosure ?? undefined
    if (disclosure && disclosure.length > MAX_DISCLOSURE) {
      plan.warnings.push({ uri: node.uri, kind: 'disclosureTruncated' })
      disclosure = truncateDisclosure(disclosure)
    }
    // 按真正会写进去的 disclosure 判断（截断之后）；关键词里的占位符在 keywordsOf 里单独丢掉
    if (disclosure && mentionsPlaceholder(disclosure)) {
      plan.skipped.push({
        source: node.uri,
        reason: '触发场景中有凭据占位符：占位符只能写在正文中',
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
      // 占位符的位置规则与写入检查相同
      const sensitivity = secret ? 'secret' : DEFAULT_SENSITIVITY[target.layer]
      if (hasRefs && !placeholderAllowed(target.layer, sensitivity)) {
        plan.skipped.push({
          source: node.uri,
          reason: `正文含凭据占位符，只能放在私人层、敏感级不低于私密的记忆中，${target.uri} 属于${LAYER_NAMES[target.layer]}`,
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
        ...(options.exportedAt ? { loreExportedAt: options.exportedAt } : {}),
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
  // 走到应用映射的节点之后还可能被跳过（撞 URI、disclosure 里有占位符等），所以循环结束才知道要动哪些应用：
  // 运行时下有写入目标的留下；要新建的应用没有写入目标就不建，不留空应用；已有的应用保留，按人格的规则照常设默认人格，
  // 除非这个运行时下的节点被勾掉了，或者全部勾掉、什么都不写。界面的 selectionEffects 算的要和这里一样
  const written = new Set(plan.memories.map((m) => runtimeOf(m.source)))
  const ticked = new Set(
    snapshot.nodes.filter((n) => excludedNodes.has(n.uuid)).map((n) => runtimeOf(n.uri)),
  )
  const nothingLeft = excludedNodes.size > 0 && !plan.memories.length
  plan.apps = plan.apps.filter(
    (m) =>
      written.has(m.runtime) ||
      (!nothingLeft && !ticked.has(m.runtime) && m.apps.every((a) => !a.create)),
  )
  return plan
}

// 关键词与接口写入的规则一致：至少两个字、最长 64 字、每条最多 32 个；超出时保留较长、较具体的
function keywordsOf(node: LoreNode, plan: ImportPlan): string[] {
  const unique = new Set<string>()
  for (const raw of node.keywords) {
    const keyword = raw.trim()
    if (mentionsPlaceholder(keyword)) {
      plan.droppedKeywords.push({
        source: node.uri,
        keyword,
        reason: '含凭据占位符，占位符只能写在正文中',
      })
    } else if (keyword.length < 2) {
      plan.droppedKeywords.push({ source: node.uri, keyword, reason: '不足两个字' })
    } else if (keyword.length > 64) {
      plan.droppedKeywords.push({ source: node.uri, keyword, reason: '超过 64 个字' })
    } else {
      unique.add(keyword)
    }
  }
  const kept = [...unique].sort((a, b) => b.length - a.length || a.localeCompare(b))
  for (const keyword of kept.splice(MAX_KEYWORDS)) {
    plan.droppedKeywords.push({ source: node.uri, keyword, reason: `超过每条 ${MAX_KEYWORDS} 个` })
  }
  return kept.sort()
}

// 写入之前共用的检查（命令行与路由）：计划有错误，或者要 secret 又没有主密钥时，什么都不写。
// 文字不提命令行的参数，命令行自己说
export function assertExecutable(plan: ImportPlan, masterKey: MasterKey | null): void {
  if (plan.errors.length) {
    const lines = plan.errors.map((e) =>
      e.kind === 'secretNotFound'
        ? `要标记为机密的 ${e.uri} 在 Lore 中不存在`
        : `要跳过的 ${e.uri} 在 Lore 中不存在`,
    )
    throw new MemoryError(400, `计划有误，无法执行：${lines.join('；')}`)
  }
  if (!masterKey && plan.memories.some((m) => m.request.sensitivity === 'secret')) {
    throw new MemoryError(400, '当前实例未配置主密钥，无法导入机密节点')
  }
}

export interface ImportTarget {
  db: Db
  spaceId: string
  accountId: string
  masterKey: MasterKey | null
}

// 空间里已有的应用：计划按它们映射 core://agent/<runtime>。按标识排序，映射的顺序不随行的物理位置变
export function existingImportApps(db: Db, spaceId: string): Promise<ExistingApp[]> {
  return withSpace(db, spaceId, (tx) =>
    tx
      .select({
        slug: apps.slug,
        runtimeFamily: apps.runtimeFamily,
        ownerAccountId: apps.ownerAccountId,
      })
      .from(apps)
      .orderBy(asc(apps.slug)),
  )
}

export interface ImportResult {
  // 这次有没有人格可用：已有的，或者这次新建的（见 writesNewPersona）。没有时 personaCreated 总是 false
  personaUsed: boolean
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
  // Lore 里换了路径、映射到别的应用或层的节点（见 movedInLore）：没有在 uri 新建，之前导入的那条留在 current
  // （在 Kioku 里删除了的为 null）
  movedInLore: { uri: string; current: string | null }[]
  failed: { uri: string; reason: string }[]
}

// 写入时这个应用的默认人格怎么处理：不属于导入者的不往里写；这次没有人格可用的不动；还没有默认人格的设成导入的人格；
// 已经在用别的人格的不动。计划预览与真正写入都按这个判断（人格这次才新建时，预览里 id 还是 null）
function personaEffect(
  current: { owner: string; personaId: string | null } | undefined,
  accountId: string,
  persona: { used: boolean; id: string | null },
): 'blocked' | 'given' | 'other' | 'none' {
  if (current?.owner !== accountId) return 'blocked'
  if (!persona.used) return 'none'
  if (current.personaId === null) return 'given'
  return current.personaId === persona.id ? 'none' : 'other'
}

// 一个写入目标这次算什么、之前导入的是哪些记忆（新建时是空的）。计划预览与真正写入都按这个判断
function priorImport(
  item: PlannedMemory,
  done: Map<string, ImportedMemory[]>,
  moved: Map<string, ImportedMemory[]>,
): { state: LoreTargetState; found: ImportedMemory[] } {
  const earlier = moved.get(item.importKey)
  if (earlier) return { state: 'moved', found: earlier }
  const found = done.get(item.importKey)
  return found ? { state: 'imported', found } : { state: 'new', found: [] }
}

// 这次要不要写入新的人格层记忆：人格层目标里有状态是新建的。已导入的、Lore 里换了路径的、在 Kioku 里删除了的都不算，
// 勾掉的不在计划里。只有这时人格不存在才新建；否则不新建，已有的人格照常用（跳过 soul 的同步不改变应用用哪个人格），
// 不存在就没有人格可用，新建的应用默认人格为空。计划预览与真正写入都按这个判断
function writesNewPersona(
  plan: ImportPlan,
  done: Map<string, ImportedMemory[]>,
  moved: Map<string, ImportedMemory[]>,
): boolean {
  return plan.memories.some(
    (m) => m.request.layer === 'persona' && priorImport(m, done, moved).state === 'new',
  )
}

export interface TargetPreview {
  item: PlannedMemory
  state: LoreTargetState
  // 之前导入的那些记忆现在的样子，新建时是空的。在 Kioku 里删除了的 uri 为 null
  current: { uri: string | null; secret: boolean }[]
}

export interface ImportPreview {
  targets: TargetPreview[]
  personaExists: boolean
  // 这次会不会新建人格
  createsPersona: boolean
  // 之前的导入写到过的人格
  importedPersonas: string[]
  appsGivenPersona: string[]
  appsOtherPersona: string[]
  // 这次才新建、默认人格会是导入的人格的应用（没有人格可用时新建的应用默认人格为空）
  newAppsWithPersona: string[]
}

// 只读：这份计划真正写入时每个目标会怎样、哪些应用会被设默认人格，判断和 applyImport 是同一段
export async function previewImport(
  target: ImportTarget,
  plan: ImportPlan,
): Promise<ImportPreview> {
  const { db, spaceId, accountId } = target
  const done = await importedMemories(db, spaceId)
  const moved = movedInLore(plan, done)
  const { persona, rows } = await withSpace(db, spaceId, async (tx) => ({
    persona: (
      await tx
        .select({ id: personas.id })
        .from(personas)
        .where(eq(personas.slug, plan.persona.slug))
    )[0],
    rows: await tx
      .select({ slug: apps.slug, owner: apps.ownerAccountId, personaId: apps.defaultPersonaId })
      .from(apps),
  }))
  const appBySlug = new Map(rows.map((r) => [r.slug, r]))
  const writes = writesNewPersona(plan, done, moved)
  const used = Boolean(persona) || writes
  const preview: ImportPreview = {
    targets: plan.memories.map((item) => {
      const { state, found } = priorImport(item, done, moved)
      return {
        item,
        state,
        current: found.map((m) => ({ uri: m.uri, secret: m.state === 'secret' })),
      }
    }),
    personaExists: Boolean(persona),
    createsPersona: writes && !persona,
    importedPersonas: [
      ...new Set(
        [...done.values()].flat().flatMap((m) => (m.targetPersona ? [m.targetPersona] : [])),
      ),
    ].sort(),
    appsGivenPersona: [],
    appsOtherPersona: [],
    newAppsWithPersona: [],
  }
  for (const mapping of plan.apps) {
    for (const app of mapping.apps) {
      const current = appBySlug.get(app.slug)
      // 这次才新建的应用建的时候就带上默认人格，不用设
      if (app.create && !current) {
        if (used) preview.newAppsWithPersona.push(app.slug)
        continue
      }
      const effect = personaEffect(current, accountId, { used, id: persona?.id ?? null })
      if (effect === 'given') preview.appsGivenPersona.push(app.slug)
      else if (effect === 'other') preview.appsOtherPersona.push(app.slug)
    }
  }
  return preview
}

// 写库时数据本身的问题（22 类：值不对；23 类：违反约束）只算这一条失败，返回给人看的原因；别的错误返回 null。
// 日志只记 SQLSTATE：驱动的错误里带着 SQL 与参数，也就是节点的正文
function dataWriteFailure(err: unknown): string | null {
  const code = pgErrorCode(err)
  if (!code?.startsWith('22') && !code?.startsWith('23')) return null
  console.error('写入 Lore 的节点时数据库报错', { code })
  return `写入数据库失败（${code}）`
}

// 按计划写入。可以重复执行：导入过的节点按导入事件去重，已有的人格与应用直接复用
export async function applyImport(target: ImportTarget, plan: ImportPlan): Promise<ImportResult> {
  const { db, spaceId, accountId } = target
  const result: ImportResult = {
    personaUsed: false,
    personaCreated: false,
    appsCreated: [],
    appsGivenPersona: [],
    appsOtherPersona: [],
    created: [],
    previouslyImported: [],
    secretAlreadyImported: [],
    occupied: [],
    movedInLore: [],
    failed: [],
  }
  // 执行时发现不属于导入者的应用（计划之后被别人抢先建了同名应用、或被转走），不往里写。
  // 写入期间才被转走的，由每次写入时同一个事务里的归属核对拦下（requireAppOwner）
  const blockedApps = new Set<string>()
  const done = await importedMemories(db, spaceId)
  const moved = movedInLore(plan, done)

  await withSpace(db, spaceId, async (tx) => {
    const [created] = writesNewPersona(plan, done, moved)
      ? await tx
          .insert(personas)
          .values({ spaceId, slug: plan.persona.slug, name: plan.persona.name })
          .onConflictDoNothing()
          .returning({ id: personas.id })
      : []
    const personaId =
      created?.id ??
      (
        await tx
          .select({ id: personas.id })
          .from(personas)
          .where(eq(personas.slug, plan.persona.slug))
      )[0]?.id ??
      null
    result.personaCreated = Boolean(created)
    result.personaUsed = personaId !== null

    // Lore 里所有客户端都读同一个 core://soul，所以对应的应用都用导入的人格；
    // 已有的应用只在还没有默认人格时设置。没有人格可用时新建的应用默认人格为空
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
        const effect = personaEffect(current, accountId, {
          used: result.personaUsed,
          id: personaId,
        })
        if (effect === 'blocked') {
          blockedApps.add(app.slug)
        } else if (effect === 'given') {
          await tx
            .update(apps)
            .set({ defaultPersonaId: personaId, updatedAt: new Date() })
            .where(eq(apps.slug, app.slug))
          result.appsGivenPersona.push(app.slug)
        } else if (effect === 'other') {
          result.appsOtherPersona.push(app.slug)
        }
      }
    }
  })

  const service = importerService(target)
  for (const item of plan.memories) {
    const app = item.context.targetApp
    if (typeof app === 'string' && blockedApps.has(app)) {
      result.failed.push({ uri: item.request.uri, reason: `应用 ${app} 不属于导入者，未写入` })
      continue
    }
    const { state, found } = priorImport(item, done, moved)
    if (state === 'moved') {
      for (const m of found) result.movedInLore.push({ uri: item.request.uri, current: m.uri })
    }
    if (state !== 'new') {
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
      if (err instanceof MemoryError) {
        if (err.status === 409) result.occupied.push(item.request.uri)
        else result.failed.push({ uri: item.request.uri, reason: err.message })
        continue
      }
      const reason = dataWriteFailure(err)
      if (reason === null) throw err
      result.failed.push({ uri: item.request.uri, reason })
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
  targetPersona: string | null
  // 导入时写到的 URI（导入事件的快照里有），记忆删掉之后报告时用
  importedUri: string | null
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
        targetPersona: parts.targetPersona ? String(parts.targetPersona) : null,
        importedUri:
          e.importedDomain && e.importedPath ? formatUri(e.importedDomain, e.importedPath) : null,
        state: gone ? 'deleted' : e.sensitivity === 'secret' ? 'secret' : 'plain',
        uri: !gone && e.domain && e.path ? formatUri(e.domain, e.path) : null,
        version: gone ? null : e.version,
      },
    ])
  }
  return done
}

// Lore 里换了路径、映射到别的应用或层的节点：去重键跟着变了，按键找不到之前的导入，不认出来就会在新位置再建一条。
// 按节点 uuid 认：之前导入时的键这次的计划已经不再产生、Lore 里的 URI 也变了，才算换了路径。
// 加了一个同类应用（节点多了一个目标）时原来的键仍在计划里，换个 --persona 时人格层两边的人格不同，都不算；
// 之前的导入事件没记 loreUri 的不判断。返回：这次计划里的去重键 → 之前按别的键导入的那些记忆
function movedInLore(
  plan: ImportPlan,
  done: Map<string, ImportedMemory[]>,
): Map<string, ImportedMemory[]> {
  const planned = new Set(plan.memories.map((m) => m.importKey))
  const byNode = new Map<string, ImportedMemory[]>()
  for (const m of [...done.values()].flat()) {
    byNode.set(m.loreNodeUuid, [...(byNode.get(m.loreNodeUuid) ?? []), m])
  }
  const moved = new Map<string, ImportedMemory[]>()
  for (const item of plan.memories) {
    if (done.has(item.importKey)) continue
    const persona = item.context.targetPersona
    const earlier = (byNode.get(String(item.context.loreNodeUuid)) ?? []).filter(
      (m) =>
        !planned.has(m.key) &&
        m.loreUri !== null &&
        m.loreUri !== item.source &&
        !(persona && m.targetPersona && m.targetPersona !== persona),
    )
    if (earlier.length) moved.set(item.importKey, earlier)
  }
  return moved
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
  'update' | 'current' | 'edited' | 'moved' | 'deleted' | 'skipped' | 'unmapped' | 'unreadable'

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

  const service = importerService(target)
  const sync: SyncPlan = { items: [], goneFromLore: [] }
  const reported = new Set<ImportedMemory>()
  const report = (m: ImportedMemory, item: Omit<SyncItem, 'changes'> & Partial<SyncItem>) => {
    reported.add(m)
    sync.items.push({ changes: [], ...item })
  }
  const moved = movedInLore(plan, done)
  for (const item of plan.memories) {
    const source = item.source
    // 去重键变了的：已经被人移到新位置的算改过，其余列为换了路径
    for (const m of moved.get(item.importKey) ?? []) {
      if (m.state === 'deleted' || !m.uri) {
        report(m, { source, uri: m.importedUri ?? item.request.uri, state: 'deleted' })
      } else if (m.uri === item.request.uri) {
        report(m, { source, uri: m.uri, state: 'edited' })
      } else {
        report(m, { source, uri: m.uri, state: 'moved', target: item.request.uri })
      }
    }
    for (const m of done.get(item.importKey) ?? []) {
      if (m.state === 'deleted' || !m.uri) {
        report(m, { source, uri: m.importedUri ?? item.request.uri, state: 'deleted' })
        continue
      }
      if (!untouched(m)) {
        report(m, { source, uri: m.uri, state: 'edited' })
        continue
      }
      if (m.uri !== item.request.uri) {
        report(m, { source, uri: m.uri, state: 'moved', target: item.request.uri })
        continue
      }
      // 只有真要读出来比对的 secret 才需要主密钥
      if (m.state === 'secret' && !target.masterKey) {
        throw new Error(
          `${m.uri} 是 secret，同步要读出来比对：需要设置与服务相同的 KIOKU_MASTER_KEY`,
        )
      }
      let current
      try {
        current = await service.get(m.uri)
      } catch (err) {
        if (!(err instanceof MemoryError)) throw err
        report(m, { source, uri: m.uri, state: 'unreadable', reason: err.message })
        continue
      }
      // 读到的应当就是导入的那一条，而且版本没变；对不上就是刚刚有人动过，不去改它
      if (current.id !== m.memoryId || current.version !== m.version) {
        report(m, { source, uri: m.uri, state: 'edited' })
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
      report(
        m,
        changes.length
          ? { source, uri: m.uri, state: 'update', changes, request, context: item.context }
          : { source, uri: m.uri, state: 'current' },
      )
    }
  }
  // 剩下的是这次的计划没有对应目标的：节点不在 Lore 里了的只列出来；
  // 还在 Lore 里的，计划不导入它就给出原因，否则是计划没有映射到它（例如换了 --persona，或者对应的应用不在了），
  // 都列出来，不能悄悄不同步
  const nodeByUuid = new Map(snapshot.nodes.map((n) => [n.uuid, n]))
  const skipReasons = new Map<string, string[]>()
  for (const s of plan.skipped)
    skipReasons.set(s.source, [...(skipReasons.get(s.source) ?? []), s.reason])
  for (const m of all) {
    if (reported.has(m) || m.state === 'deleted' || !m.uri) continue
    const node = nodeByUuid.get(m.loreNodeUuid)
    if (!node) {
      sync.goneFromLore.push(m.uri)
      continue
    }
    const reasons = skipReasons.get(node.uri)
    report(
      m,
      reasons
        ? { source: node.uri, uri: m.uri, state: 'skipped', reason: reasons.join('；') }
        : { source: node.uri, uri: m.uri, state: 'unmapped' },
    )
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
      const reason = err instanceof MemoryError ? err.message : dataWriteFailure(err)
      if (reason === null) throw err
      result.failed.push({ uri: item.uri, reason })
    }
  }
  return result
}

// 计划的指纹：看计划与执行时都对不带勾选的基准计划算，所以勾选不影响它。
// 覆盖人格与这次会不会新建它、应用映射、哪些应用会被设默认人格（新建的也算）或在用别的人格、
// 每个写入目标（来源、URI、层、priority、disclosure、排好序的关键词、正文的哈希、新建或已导入）、
// 不导入的、提醒、要更新的同步项与 Lore 里没有了的；都排好序，所以打乱导出的行序不会变。
// 不覆盖版本号、时间与人格本身在不在：只有真要写的东西变了才算计划变了
export function planFingerprint(plan: ImportPlan, preview: ImportPreview, sync: SyncPlan): string {
  const canonical = <T>(items: T[]) => items.map((item) => JSON.stringify(item)).sort()
  return createHash('sha256')
    .update(
      JSON.stringify({
        persona: plan.persona,
        createsPersona: preview.createsPersona,
        appsGivenPersona: [...preview.appsGivenPersona].sort(),
        appsOtherPersona: [...preview.appsOtherPersona].sort(),
        newAppsWithPersona: [...preview.newAppsWithPersona].sort(),
        apps: canonical(
          plan.apps.map((m) => ({
            runtime: m.runtime,
            apps: canonical(m.apps.map((a) => [a.slug, a.create, a.runtimeFamily])),
          })),
        ),
        targets: canonical(
          preview.targets.map(({ item, state }) => ({
            source: item.source,
            uri: item.request.uri,
            layer: item.request.layer ?? null,
            priority: item.request.priority,
            disclosure: item.request.disclosure ?? null,
            glossary: [...item.request.glossary].sort(),
            content: createHash('sha256').update(item.request.content).digest('hex'),
            state,
          })),
        ),
        skipped: canonical(plan.skipped.map((s) => [s.source, s.reason])),
        warnings: canonical(plan.warnings.map((w) => [w.uri, w.kind])),
        updates: canonical(
          sync.items
            .filter((i) => i.state === 'update')
            .map((i) => ({ uri: i.uri, changes: [...i.changes].sort() })),
        ),
        goneFromLore: [...sync.goneFromLore].sort(),
      }),
    )
    .digest('hex')
}

// 这个空间里已写入的 Lore 数据的时间：各导入与同步事件记下的导出时间，没有的是命令行写的（读的是当时的库），取事件时间
export async function loreDataTime(db: Db, spaceId: string): Promise<Date | null> {
  const [row] = await withSpace(db, spaceId, (tx) =>
    tx
      .select({
        at: sql<Date | null>`max(coalesce((${memoryEvents.context}->>'loreExportedAt')::timestamptz, ${memoryEvents.createdAt}))`.mapWith(
          memoryEvents.createdAt,
        ),
      })
      .from(memoryEvents)
      .where(
        and(
          inArray(memoryEvents.eventType, ['import', 'sync']),
          sql`${memoryEvents.context}->>'source' = 'lore'`,
        ),
      ),
  )
  return row?.at ?? null
}

// 文件比已写入的数据旧、这次又有要写入的内容时，返回那个数据时间。同步只看是否相等，旧文件会把正文改回去，
// 指纹拦不住：两次算的是同一份旧文件。同一份文件续做时导出时间相等，不算旧
export function staleAgainst(
  exportedAt: string,
  dataTime: Date | null,
  preview: ImportPreview,
  sync: SyncPlan,
): Date | null {
  if (!dataTime || new Date(exportedAt) >= dataTime) return null
  const writes =
    preview.targets.some((t) => t.state === 'new') || sync.items.some((i) => i.state === 'update')
  return writes ? dataTime : null
}

// 导入 secret 之前确认主密钥和服务用的是同一把：库里已有加密数据时试着解密一条。
// 返回 false 表示库里还没有加密数据、没法确认；对不上时抛错
export async function verifyMasterKey(
  db: Db,
  spaceId: string,
  masterKey: MasterKey,
): Promise<boolean> {
  // 读库出错时原样抛出，只有解密失败才说是主密钥不一致。实例设置里加密保存的接口 Key，有一个就拿来试
  const [stored] = await sealedSettingsKeys(db)
  if (stored) {
    try {
      decryptSecret(decryptionKey(masterKey, stored.keyId), stored.sealed, stored.aad)
      return true
    } catch {
      throw new Error(
        `KIOKU_MASTER_KEY 解不开已保存的${stored.label} Key：它和服务使用的主密钥不一致`,
      )
    }
  }
  const [sealed] = await withSpace(db, spaceId, (tx) =>
    tx
      .select({
        id: memories.id,
        ciphertext: memories.ciphertext,
        wrappedKey: memories.wrappedKey,
        keyId: memories.keyId,
      })
      .from(memories)
      .where(and(isNotNull(memories.ciphertext), isNotNull(memories.wrappedKey)))
      .limit(1),
  )
  if (!sealed) return false
  try {
    decryptSecret(
      decryptionKey(masterKey, sealed.keyId),
      { ciphertext: sealed.ciphertext!, wrappedKey: sealed.wrappedKey! },
      sealed.id,
    )
    return true
  } catch {
    throw new Error('KIOKU_MASTER_KEY 解不开已有的 secret 记忆：它和服务使用的主密钥不一致')
  }
}
