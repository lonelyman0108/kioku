import { createHash, randomUUID } from 'node:crypto'

import {
  CreateEntryRequest,
  DEFAULT_SENSITIVITY,
  DISCLOSURE_MAX,
  deriveEntryTitle,
  findPlaintextCredentials,
  firstMarkdownHeading,
  LoreBackupUpload,
  RUNTIME_FAMILIES,
  SENSITIVITY_NAMES,
  Slug,
  TopicTag,
  TOPICS_MAX,
  TraitKey,
  UpdateEntryRequest,
  WhenCondition,
  bootEligible,
  normalizeWhen,
  whenSignature,
  type CircleKind,
  type LoreSyncChange,
  type LoreTargetState,
  type LoreWarningKind,
  type PlaintextKind,
  type RuntimeFamily,
  type Sensitivity,
} from '@kioku/contracts'
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type postgres from 'postgres'

import { canUseCredential, consoleAccess, type Access } from '../access/access'
import { normalizeRealms } from '../access/realms'
import { vaultAad } from '../credential/vault'
import {
  looksLikePlaintextCredential,
  mentionsPlaceholder,
  placeholderAllowed,
  placeholderIdentifiers,
  replaceOutsidePlaceholders,
  scanPlaceholders,
} from '../credential/placeholders'
import { evaluateSensitiveContent, loadCirclePrivacy } from '../credential/privacy'
import { openCredentialValues, type KnownCredentialValues } from '../credential/service'
import { decryptSecret } from '../crypto/envelope'
import { decryptionKey, type MasterKey } from '../crypto/keyring'
import { sealedSettingsKeys } from '../crypto/rotation'
import { pgErrorCode, withCircle, withCircles, type Db, type Tx } from '../db/client'
import {
  circles,
  clients,
  credentials,
  entries,
  entryEvents,
  entryGlossary,
  entryVariants,
  facetTerms,
  legacyUris,
  personaTraits,
  personas,
  vaultConnections,
} from '../db/schema'
import { MemoryError } from '../memory/errors'
import { syncEntryLinks } from '../memory/links'
import {
  buildSearchHeader,
  openVariantContent,
  sealVariantContent,
  syncCredentialRefs,
  toStoredSnapshot,
} from '../memory/service'
import { insertWithAllocatedShortId } from '../memory/shortId'

export { LoreBackupUpload }

// Lore 节点迁移工具：按记忆圈 + 切面 + 独立人格确定性映射并写入 legacy_uris
const LORE_URI = /^([a-z][a-z0-9_]{0,31}):\/\/([a-z0-9_-]{1,64}(?:\/[a-z0-9_-]{1,64}){0,15})$/
const TRAIT_CONTENT_MAX = 20_000
const TRAIT_TITLE_MAX = 120
const MAX_KEYWORDS = 32
export const MAX_DISCLOSURE = DISCLOSURE_MAX
const CREDENTIAL_PATH = /credential|password|passwd|secret|token|密码|凭据/i

export const CONVERTED_KEY = 'plaintextCredentials'
export const PLAN_CHANGED = '来源或此记忆圈在查看计划后已变化，请重新查看计划'

const UNCONVERTIBLE = '值无法转存（太短或太长、前后有空白，或含无法使用的字符）'

const CIRCLE_KIND_NAMES: Record<CircleKind, string> = {
  personal: '个人圈',
  shared: '共享圈',
}

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
  recallEvents: number | null
}

// 在只读事务里读出全部节点，保证不会改动 Lore 的数据
export async function readLore(sqlClient: postgres.Sql): Promise<LoreSnapshot> {
  return sqlClient.begin('read only', async (tx) => {
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
      const uri = `${p.domain}://${p.path}`
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

export function lastSegment(uri: string): string {
  const path = uri.split('://')[1] ?? uri
  return path.split('/').filter(Boolean).at(-1) ?? path
}

// 写进去的标题：正文第一个 # 标题，没有就用来源路径的最后一段；机密词条只用最后一段（不从正文提取明文标题）
export function loreTitle(content: string | null, legacyUri: string, secret: boolean): string {
  const fallback = lastSegment(legacyUri)
  if (secret) return fallback
  return (content ? firstMarkdownHeading(content) : null) ?? fallback
}

// 默认敏感级：preferences:// 在个人圈用 internal（本人私聊开启后可用），core:// 用 internal，其余个人记忆用 private
export function plainSensitivity(loreUri: string, targetCircleKind: CircleKind): Sensitivity {
  if (loreUri.startsWith('preferences://') || loreUri.startsWith('core://')) {
    return 'internal'
  }
  return DEFAULT_SENSITIVITY[targetCircleKind]
}

const extrasOf = (node: LoreNode) => [node.disclosure ?? '', ...node.keywords].join('\n')

// 截断超过 LIMITS 的 disclosure 时不切开 UTF-16 代理对，否则存库转为 U+FFFD 后同步会一直判为有差异
function truncateDisclosure(text: string): string {
  const cut = text.slice(0, MAX_DISCLOSURE)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

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

export interface PlaintextSpot {
  index: number
  line: number
  kind: PlaintextKind
  value: string
  credential: { id: string; identifier: string; name: string; field: string } | null
}

export function plaintextSpots(
  content: string | null,
  known: KnownCredentialValues | null,
): PlaintextSpot[] {
  const text = content ?? ''
  return findPlaintextCredentials(text).map((m, index) => {
    const value = text.slice(m.start, m.end)
    const entry = known?.entries.find((e) => e.value === value)
    return {
      index,
      line: m.line,
      kind: m.kind,
      value,
      credential: entry
        ? { id: entry.id, identifier: entry.identifier, name: entry.name, field: entry.field }
        : null,
    }
  })
}

export type PlaintextConversion = { line: number; value: string } & (
  | { credential: { identifier: string; field: string }; problem?: undefined }
  | { credential: null; problem: 'stale' | 'unconvertible' }
)

export interface ConvertedRef {
  identifier: string
  field: string
}

const placeholderOf = (ref: ConvertedRef) => `{{cred:${ref.identifier}#${ref.field}}}`

export interface CircleRef {
  id: string
  kind: CircleKind
  slug: string
  name: string
}

export interface ExistingClient {
  id: string
  slug: string
  runtimeFamily: string
  ownerAccountId: string
  defaultPersonaId: string | null
}

export interface ClientMapping {
  runtime: string
  clients: { slug: string; create: boolean; runtimeFamily: RuntimeFamily }[]
}

export interface PlannedTarget {
  source: string
  legacyUri: string
  targetCircleId: string
  targetCircleKind: CircleKind
  isSoul: boolean
  traitKey?: string
  sortOrder?: number
  personaSlug?: string
  runtimeSlug?: string
  runtimeLabel?: string
  title: string
  content: string
  topics: string[]
  when: WhenCondition
  whenSignature: string
  sensitivity: Sensitivity
  priority: number
  disclosure: string | null
  glossary: string[]
  boot: boolean
  createdAt: Date
  updatedAt: Date
  importKey: string
  context: Record<string, unknown>
  converted?: { content: string; title: string; refs: ConvertedRef[] }
  plaintextKept?: string[]
}

export interface ImportPlanError {
  kind: 'secretNotFound' | 'excludeNotFound'
  uri: string
}

export interface ImportPlan {
  persona: { slug: string; name: string }
  clients: ClientMapping[]
  targets: PlannedTarget[]
  skipped: {
    source: string
    reason: string
    target?: Pick<PlannedTarget, 'importKey' | 'context'>
  }[]
  droppedKeywords: { source: string; keyword: string; reason: string }[]
  warnings: { legacyUri: string; kind: LoreWarningKind }[]
  errors: ImportPlanError[]
}

export interface ImportOptions {
  accountId: string
  persona: { slug: string; name: string }
  secretUris: ReadonlySet<string>
  excludeUris?: ReadonlySet<string>
  exportedAt?: string
  quoteMalformed?: boolean
  convert?: ReadonlyMap<string, PlaintextConversion[]>
}

export interface ImportKeyParts {
  loreNodeUuid?: unknown
  targetCircleId?: unknown
  targetPersona?: unknown
}

export function importKeyOf(context: ImportKeyParts): string {
  const circle = context.targetCircleId ? String(context.targetCircleId) : ''
  const persona = context.targetPersona ? `#${String(context.targetPersona)}` : ''
  return `${String(context.loreNodeUuid)}@${circle}${persona}`
}

function sanitizeTopics(rawSegments: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of rawSegments) {
    const parsed = TopicTag.safeParse(raw)
    if (!parsed.success || seen.has(parsed.data)) continue
    seen.add(parsed.data)
    out.push(parsed.data)
    if (out.length >= TOPICS_MAX) break
  }
  return out
}

function deriveTraitKey(subSegments: readonly string[]): { key: string; sortOrder: number } {
  if (!subSegments.length) return { key: 'soul', sortOrder: 0 }
  let raw = subSegments
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!raw || !/^[a-z0-9]/.test(raw)) raw = `soul-${raw}`.replace(/^-+/, '')
  const trimmed = raw.slice(0, 64)
  const parsed = TraitKey.safeParse(trimmed)
  return { key: parsed.success ? parsed.data : 'soul', sortOrder: 1 }
}

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

function convertTarget(
  target: Pick<
    PlannedTarget,
    | 'legacyUri'
    | 'targetCircleKind'
    | 'title'
    | 'content'
    | 'topics'
    | 'disclosure'
    | 'glossary'
    | 'priority'
  >,
  sensitivity: Sensitivity,
  conversions: PlaintextConversion[],
): Pick<PlannedTarget, 'converted' | 'plaintextKept'> {
  const reasons: { list: PlaintextConversion[]; text: (lines: string) => string }[] = []
  const keep = (list: PlaintextConversion[], text: (lines: string) => string) => {
    if (list.length) reasons.push({ list, text })
  }
  keep(
    conversions.filter((c) => c.problem === 'stale'),
    (lines) =>
      `正文第 ${lines} 行的疑似明文与计划中的凭据已对不上（凭据可能刚修改或删除），照原样写入，可在待处理中转存`,
  )
  keep(
    conversions.filter((c) => c.problem === 'unconvertible'),
    (lines) => `正文第 ${lines} 行的${UNCONVERTIBLE}，照原样写入`,
  )
  let usable = conversions.filter((c) => c.credential)
  if (usable.length && !placeholderAllowed(target.targetCircleKind, 'entry', sensitivity)) {
    keep(
      usable,
      (lines) =>
        `${target.legacyUri} 映射到${CIRCLE_KIND_NAMES[target.targetCircleKind]} · ${SENSITIVITY_NAMES[sensitivity]}，凭据占位符只能放在个人圈、正式词条且敏感级不低于私密的记忆中：正文第 ${lines} 行的疑似明文照原样写入`,
    )
    usable = []
  }
  const elsewhere = [
    target.legacyUri,
    target.title,
    target.disclosure ?? '',
    ...target.topics,
    ...target.glossary,
  ]
  const clash = usable.filter(
    (c) =>
      elsewhere.some((t) => t.includes(c.value)) || placeholderOf(c.credential!).includes(c.value),
  )
  keep(
    clash,
    (lines) =>
      `正文第 ${lines} 行的值也出现在来源路径、标题、主题标签、触发场景或关键词中（这些位置不能写占位符），照原样写入`,
  )
  usable = usable.filter((c) => !clash.includes(c))

  let converted: PlannedTarget['converted']
  if (usable.length) {
    let content = target.content
    const refs = new Map<string, ConvertedRef>()
    for (const c of [...usable].sort((a, b) => b.value.length - a.value.length)) {
      const swapped = replaceOutsidePlaceholders(content, c.value, placeholderOf(c.credential!))
      content = swapped.text
      if (swapped.replaced) refs.set(placeholderOf(c.credential!), c.credential!)
    }
    const title = loreTitle(content, target.legacyUri, sensitivity === 'secret')
    if (
      CreateEntryRequest.safeParse({
        title,
        content,
        topics: target.topics,
        sensitivity,
        priority: target.priority,
        ...(target.disclosure ? { disclosure: target.disclosure } : {}),
        glossary: target.glossary,
      }).success
    ) {
      converted = { content, title, refs: [...refs.values()] }
    } else {
      keep(
        usable,
        (lines) => `换成占位符后正文超出长度上限：正文第 ${lines} 行的疑似明文照原样写入`,
      )
    }
  }
  const written = converted?.content ?? target.content
  const remains = (c: PlaintextConversion) =>
    replaceOutsidePlaceholders(written, c.value, '').replaced > 0
  const kept = reasons.flatMap(({ list, text }) => {
    const left = list.filter(remains)
    if (!left.length) return []
    return [text([...new Set(left.map((c) => c.line))].sort((a, b) => a - b).join('、'))]
  })
  return {
    ...(converted ? { converted } : {}),
    ...(kept.length ? { plaintextKept: kept } : {}),
  }
}

export function planImport(
  snapshot: LoreSnapshot,
  targetCircles: { target: CircleRef; personal: CircleRef },
  existingClients: ExistingClient[],
  options: ImportOptions,
): ImportPlan {
  const plan: ImportPlan = {
    persona: options.persona,
    clients: [],
    targets: [],
    skipped: [],
    droppedKeywords: [],
    warnings: [],
    errors: [],
  }

  const slugOf = (runtime: string) => runtime.toLowerCase().replace(/_/g, '-')
  const runtimeOf = (uri: string) => /^core:\/\/agent\/([^/]+)/.exec(uri)?.[1]
  const runtimes = new Set(
    snapshot.nodes.map((n) => runtimeOf(n.uri)).filter((r): r is string => Boolean(r)),
  )
  const ownClients = existingClients.filter((c) => c.ownerAccountId === options.accountId)
  const clientsByRuntime = new Map<string, ClientMapping['clients'] | string>()

  const clientsFor = (runtime: string): ClientMapping['clients'] | string => {
    const cached = clientsByRuntime.get(runtime)
    if (cached) return cached
    const slug = slugOf(runtime)
    const otherSlugs = new Set([...runtimes].filter((r) => r !== runtime).map(slugOf))
    const family = (RUNTIME_FAMILIES as readonly string[]).includes(runtime)
      ? (runtime as RuntimeFamily)
      : 'other'
    const bySlug = ownClients.filter((c) => c.slug === slug)
    const byFamily = ownClients.filter(
      (c) => c.runtimeFamily === runtime && !otherSlugs.has(c.slug),
    )
    const matched = bySlug.length ? bySlug : byFamily
    let mapped: ClientMapping['clients'] | string = matched.map((c) => ({
      slug: c.slug,
      create: false,
      runtimeFamily: c.runtimeFamily as RuntimeFamily,
    }))
    if (!mapped.length) {
      if (existingClients.some((c) => c.slug === slug)) {
        mapped = `接入实例标识 ${slug} 已被其他成员占用。请先在管理界面新建一个属于当前账号的接入实例，再重新导入。`
      } else if (!Slug.safeParse(slug).success) {
        mapped = `运行时 ${runtime} 无法作为接入实例标识`
      } else {
        mapped = [{ slug, create: true, runtimeFamily: family }]
      }
    }
    clientsByRuntime.set(runtime, mapped)
    if (typeof mapped !== 'string') plan.clients.push({ runtime, clients: mapped })
    return mapped
  }

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
  const excludedNodes = nodesOf(options.excludeUris ?? [], 'excludeNotFound')
  const plannedTraits = new Set<string>()
  const plannedEntries = new Map<string, string>()

  for (const node of snapshot.nodes) {
    for (const alias of node.aliases) {
      plan.skipped.push({ source: alias, reason: `是 ${node.uri} 的别名，Kioku 保留唯一源路径` })
    }
    if (excludedNodes.has(node.uuid)) {
      plan.skipped.push({ source: node.uri, reason: '本次选择不导入' })
      continue
    }
    if (!node.content) {
      plan.skipped.push({ source: node.uri, reason: '正文为空' })
      continue
    }
    const malformed = scanPlaceholders(node.content).malformed[0]
    if (malformed) {
      const quoted = options.quoteMalformed ? ` ${malformed}` : ''
      plan.skipped.push({
        source: node.uri,
        reason: `正文含格式错误的凭据占位符${quoted}。说明文字提到这种写法时，请去掉花括号。`,
      })
      continue
    }
    const lore = LORE_URI.exec(node.uri)
    if (!lore) {
      plan.skipped.push({ source: node.uri, reason: 'URI 不符合 Lore 的格式' })
      continue
    }
    const domain = lore[1]!
    const path = lore[2]!
    const segments = path.split('/')

    const secret = secretNodes.has(node.uuid)
    const extras = extrasOf(node)
    if (!secret && [node.uri, ...node.aliases].some((u) => CREDENTIAL_PATH.test(u))) {
      plan.warnings.push({ legacyUri: node.uri, kind: 'credentialPath' })
    } else if (!secret && looksLikePlaintextCredential(`${node.content}\n${extras}`)) {
      plan.warnings.push({
        legacyUri: node.uri,
        kind: looksLikePlaintextCredential(node.content) ? 'credentialContent' : 'credentialExtras',
      })
    } else if (secret && looksLikePlaintextCredential(extras)) {
      plan.warnings.push({ legacyUri: node.uri, kind: 'secretExtras' })
    }

    let disclosure = node.disclosure?.trim() || null
    if (disclosure && disclosure.length > MAX_DISCLOSURE) {
      plan.warnings.push({ legacyUri: node.uri, kind: 'disclosureTruncated' })
      disclosure = truncateDisclosure(disclosure)
    }
    if (disclosure && mentionsPlaceholder(disclosure)) {
      plan.skipped.push({
        source: node.uri,
        reason: '触发场景中有凭据占位符：占位符只能写在正文中',
      })
      continue
    }

    const glossary = keywordsOf(node, plan)
    const hasRefs = scanPlaceholders(node.content).refs.length > 0

    let circle: CircleRef
    let isSoul = false
    let traitKey: string | undefined
    let sortOrder: number | undefined
    let personaSlug: string | undefined
    let runtimeSlug: string | undefined
    let runtimeLabel: string | undefined
    let topics: string[]
    let when: WhenCondition = {}
    let targetClientSlug: string | null = null

    if (domain === 'core' && segments[0] === 'soul') {
      isSoul = true
      circle = targetCircles.target
      const trait = deriveTraitKey(segments.slice(1))
      traitKey = trait.key
      sortOrder = trait.sortOrder
      personaSlug = options.persona.slug
      topics = sanitizeTopics(segments)
    } else if (domain === 'core' && segments[0] === 'agent' && segments.length > 1) {
      const runtime = segments[1]!
      const mapped = clientsFor(runtime)
      if (typeof mapped === 'string') {
        plan.skipped.push({ source: node.uri, reason: mapped })
        continue
      }
      circle = targetCircles.target
      runtimeSlug = slugOf(runtime)
      runtimeLabel = runtime
      when = normalizeWhen({ runtime: [runtimeSlug] })
      topics = sanitizeTopics(['agent', ...segments.slice(2, -1)])
      targetClientSlug = mapped[0]?.slug ?? null
    } else if (domain === 'core') {
      circle = targetCircles.target
      if (segments.length === 1) topics = sanitizeTopics(segments)
      else topics = sanitizeTopics(segments.slice(0, -1))
    } else {
      circle = targetCircles.personal
      topics = sanitizeTopics([domain, ...segments.slice(0, -1)])
    }

    const sensitivity: Sensitivity = secret ? 'secret' : plainSensitivity(node.uri, circle.kind)
    const context: Record<string, unknown> = {
      source: 'lore',
      loreUri: node.uri,
      legacyUri: node.uri,
      loreNodeUuid: node.uuid,
      targetCircleId: circle.id,
      targetClient: targetClientSlug,
      targetPersona: personaSlug ?? null,
      previousVersions: node.previousVersions,
      ...(options.exportedAt ? { loreExportedAt: options.exportedAt } : {}),
    }
    const importKey = importKeyOf({
      loreNodeUuid: node.uuid,
      targetCircleId: circle.id,
      targetPersona: personaSlug ?? null,
    })

    if (isSoul) {
      if (node.content.length > TRAIT_CONTENT_MAX) {
        plan.skipped.push({
          source: node.uri,
          reason: `人格设定正文超过 ${TRAIT_CONTENT_MAX} 个字符上限`,
        })
        continue
      }
      if (hasRefs) {
        plan.skipped.push({
          source: node.uri,
          reason: '人格设定不能包含凭据占位符',
        })
        continue
      }
      const traitUnique = `${personaSlug}:${traitKey}`
      if (plannedTraits.has(traitUnique)) {
        plan.skipped.push({
          source: node.uri,
          reason: `和已计划的人格设定键 ${traitKey} 冲突`,
        })
        continue
      }
      plannedTraits.add(traitUnique)
      const heading = firstMarkdownHeading(node.content)
      const traitTitle = (heading ?? traitKey!).slice(0, TRAIT_TITLE_MAX)
      plan.targets.push({
        source: node.uri,
        legacyUri: node.uri,
        targetCircleId: circle.id,
        targetCircleKind: circle.kind,
        isSoul: true,
        ...(traitKey ? { traitKey } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
        ...(personaSlug ? { personaSlug } : {}),
        title: traitTitle,
        content: node.content,
        topics,
        when: {},
        whenSignature: '{}',
        sensitivity: secret ? 'secret' : 'internal',
        priority: node.priority,
        disclosure,
        glossary,
        boot: true,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        importKey,
        context,
      })
      continue
    }

    if (hasRefs && !placeholderAllowed(circle.kind, 'entry', sensitivity)) {
      plan.skipped.push({
        source: node.uri,
        reason: `正文含凭据占位符，只能放在个人圈、正式词条且敏感级不低于私密的记忆中，当前目标为${CIRCLE_KIND_NAMES[circle.kind]} · ${SENSITIVITY_NAMES[sensitivity]}`,
        target: { importKey, context },
      })
      continue
    }

    const title = loreTitle(node.content, node.uri, secret)
    const parsedEntry = CreateEntryRequest.safeParse({
      title,
      content: node.content,
      when,
      topics,
      sensitivity,
      priority: node.priority,
      ...(disclosure ? { disclosure } : {}),
      glossary,
    })
    if (!parsedEntry.success) {
      plan.skipped.push({
        source: node.uri,
        reason: parsedEntry.error.issues.map((i) => i.message).join('；'),
        target: { importKey, context },
      })
      continue
    }

    const entryDedup = `${circle.id}:${node.uuid}`
    if (plannedEntries.has(entryDedup)) {
      plan.skipped.push({
        source: node.uri,
        reason: `节点 ${node.uuid} 已在本次计划中映射到当前记忆圈`,
        target: { importKey, context },
      })
      continue
    }
    plannedEntries.set(entryDedup, node.uri)

    const whenSig = whenSignature(parsedEntry.data.when ?? {})
    const normalizedWhen = normalizeWhen(parsedEntry.data.when)
    const conversions = options.convert?.get(node.uuid)
    const baseTarget = {
      legacyUri: node.uri,
      targetCircleKind: circle.kind,
      title,
      content: parsedEntry.data.content!,
      topics: parsedEntry.data.topics,
      disclosure: parsedEntry.data.disclosure ?? null,
      glossary: parsedEntry.data.glossary,
      priority: parsedEntry.data.priority,
    }
    const extraConversion = conversions?.length
      ? convertTarget(baseTarget, sensitivity, conversions)
      : {}

    plan.targets.push({
      source: node.uri,
      legacyUri: node.uri,
      targetCircleId: circle.id,
      targetCircleKind: circle.kind,
      isSoul: false,
      ...(runtimeSlug !== undefined ? { runtimeSlug } : {}),
      ...(runtimeLabel !== undefined ? { runtimeLabel } : {}),
      title,
      content: parsedEntry.data.content!,
      topics: parsedEntry.data.topics,
      when: normalizedWhen,
      whenSignature: whenSig,
      sensitivity,
      priority: parsedEntry.data.priority,
      disclosure: parsedEntry.data.disclosure ?? null,
      glossary: parsedEntry.data.glossary,
      boot: bootEligible('entry', parsedEntry.data.priority),
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      importKey,
      context,
      ...extraConversion,
    })
  }

  // 与 frontend loreBackup.ts:370-377 对齐：勾掉运行时下全部节点时不建空接入实例，全部勾掉什么都不改
  const keptNonSoulRuntimes = new Set(
    plan.targets.filter((t) => !t.isSoul && t.runtimeLabel).map((t) => runtimeOf(t.source)),
  )
  const excludedRuntimes = new Set(
    snapshot.nodes.filter((n) => excludedNodes.has(n.uuid)).map((n) => runtimeOf(n.uri)),
  )
  const nothingLeft = excludedNodes.size > 0 && !plan.targets.length
  plan.clients = plan.clients.filter(
    (m) =>
      keptNonSoulRuntimes.has(m.runtime) ||
      (!nothingLeft && !excludedRuntimes.has(m.runtime) && m.clients.every((c) => !c.create)),
  )

  return plan
}

export function assertExecutable(plan: ImportPlan, masterKey: MasterKey | null): void {
  if (plan.errors.length) {
    const lines = plan.errors.map((e) =>
      e.kind === 'secretNotFound'
        ? `要标记为机密的 ${e.uri} 在 Lore 中不存在`
        : `要跳过的 ${e.uri} 在 Lore 中不存在`,
    )
    throw new MemoryError(400, `计划有误，无法执行：${lines.join('；')}`)
  }
  if (!masterKey && plan.targets.some((t) => !t.isSoul && t.sensitivity === 'secret')) {
    throw new MemoryError(400, '当前实例未配置主密钥，无法导入机密节点')
  }
}

export interface ImportTarget {
  db: Db
  circleId: string
  personalCircleId: string
  accountId: string
  masterKey: MasterKey | null
}

export interface PlanSnapshot extends ImportTarget {
  tx: Tx
}

function uniqueCircleIds(target: Pick<ImportTarget, 'circleId' | 'personalCircleId'>): string[] {
  return target.circleId === target.personalCircleId
    ? [target.circleId]
    : [target.circleId, target.personalCircleId]
}

export async function resolveCirclesForImport(
  db: Db,
  accountId: string,
  targetCircleId: string,
): Promise<{ target: CircleRef; personal: CircleRef }> {
  const rows = await db
    .select({
      id: circles.id,
      kind: circles.kind,
      slug: circles.slug,
      name: circles.name,
      ownerAccountId: circles.ownerAccountId,
    })
    .from(circles)
    .where(
      sql`(${circles.id} = ${targetCircleId} or (${circles.kind} = 'personal' and ${circles.ownerAccountId} = ${accountId}))`,
    )
  const target = rows.find((r) => r.id === targetCircleId)
  if (!target) throw new MemoryError(404, '目标记忆圈不存在')
  const personal = rows.find((r) => r.kind === 'personal' && r.ownerAccountId === accountId)
  if (!personal) throw new MemoryError(400, '当前账号缺少个人记忆圈')
  return {
    target: { id: target.id, kind: target.kind, slug: target.slug, name: target.name },
    personal: { id: personal.id, kind: personal.kind, slug: personal.slug, name: personal.name },
  }
}

export function existingImportClientsIn(tx: Tx, circleId: string): Promise<ExistingClient[]> {
  return tx
    .select({
      id: clients.id,
      slug: clients.slug,
      runtimeFamily: clients.runtimeFamily,
      ownerAccountId: clients.ownerAccountId,
      defaultPersonaId: clients.defaultPersonaId,
    })
    .from(clients)
    .where(eq(clients.circleId, circleId))
    .orderBy(asc(clients.slug))
}

export function existingImportClients(db: Db, circleId: string): Promise<ExistingClient[]> {
  return withCircle(db, circleId, (tx) => existingImportClientsIn(tx, circleId))
}

// 只读快照：全部查询在同一条可重复读的只读事务里按顺序执行，禁止 Promise.all 并发复用连接
export function inPlanSnapshot<T>(
  target: ImportTarget,
  fn: (snapshot: PlanSnapshot) => Promise<T>,
): Promise<T> {
  return withCircles(
    target.db,
    { read: uniqueCircleIds(target) },
    (tx) => fn({ ...target, db: tx as unknown as Db, tx }),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

export interface ImportedEntry {
  key: string
  circleId: string
  entryId: string | null
  eventShortId: string
  shortId: string | null
  loreNodeUuid: string
  loreUri: string | null
  legacyUri: string | null
  state: 'secret' | 'plain' | 'deleted'
  version: number | null
}

export interface ImportRecords {
  entries: Map<string, ImportedEntry[]>
  // 已有设定段的键 `${personaSlug}:${traitKey}`
  traits: Set<string>
  // 已有 soul 设定段的人格 slug（按字典序）
  soulPersonas: string[]
}

async function importRecordsIn(tx: Tx, targetCircleId: string): Promise<ImportRecords> {
  const imported = await tx
    .select({
      circleId: entryEvents.circleId,
      entryId: entryEvents.entryId,
      eventShortId: entryEvents.shortId,
      context: entryEvents.context,
      afterLegacyUri: sql<string | null>`${entryEvents.after}->>'legacyUri'`,
      currentShortId: entries.shortId,
      sensitivity: entries.sensitivity,
      deletedAt: entries.deletedAt,
      version: entries.version,
    })
    .from(entryEvents)
    .leftJoin(entries, eq(entries.id, entryEvents.entryId))
    .where(
      and(eq(entryEvents.eventType, 'import'), sql`${entryEvents.context}->>'source' = 'lore'`),
    )
    .orderBy(entryEvents.id)

  const entriesMap = new Map<string, ImportedEntry[]>()
  for (const e of imported) {
    const ctx = e.context as {
      loreNodeUuid?: unknown
      loreUri?: unknown
      legacyUri?: unknown
    }
    if (typeof ctx.loreNodeUuid !== 'string' || !ctx.loreNodeUuid) continue
    const loreUri = typeof ctx.loreUri === 'string' ? ctx.loreUri : null
    const legacyUri =
      typeof ctx.legacyUri === 'string'
        ? ctx.legacyUri
        : typeof e.afterLegacyUri === 'string'
          ? e.afterLegacyUri
          : loreUri
    const gone = e.deletedAt !== null || e.sensitivity === null || e.entryId === null
    const key = importKeyOf({ loreNodeUuid: ctx.loreNodeUuid, targetCircleId: e.circleId })
    const item: ImportedEntry = {
      key,
      circleId: e.circleId,
      entryId: e.entryId,
      eventShortId: e.eventShortId,
      shortId: gone ? null : (e.currentShortId ?? e.eventShortId),
      loreNodeUuid: ctx.loreNodeUuid,
      loreUri,
      legacyUri,
      state: gone ? 'deleted' : e.sensitivity === 'secret' ? 'secret' : 'plain',
      version: gone ? null : e.version,
    }
    entriesMap.set(key, [...(entriesMap.get(key) ?? []), item])
  }

  const traitRows = await tx
    .select({
      slug: personas.slug,
      traitKey: personaTraits.traitKey,
    })
    .from(personaTraits)
    .innerJoin(personas, eq(personas.id, personaTraits.personaId))
    .where(eq(personas.circleId, targetCircleId))

  const traits = new Set<string>()
  const soulSet = new Set<string>()
  for (const t of traitRows) {
    traits.add(`${t.slug}:${t.traitKey}`)
    if (t.traitKey === 'soul') soulSet.add(t.slug)
  }

  return { entries: entriesMap, traits, soulPersonas: [...soulSet].sort() }
}

function movedInLore(plan: ImportPlan, done: ImportRecords): Map<string, ImportedEntry[]> {
  const targets = [
    ...plan.targets.filter((t) => !t.isSoul),
    ...plan.skipped.flatMap((s) => (s.target ? [{ source: s.source, ...s.target }] : [])),
  ]
  const planned = new Set(targets.map((t) => t.importKey))
  const byNode = new Map<string, ImportedEntry[]>()
  for (const m of [...done.entries.values()].flat()) {
    byNode.set(m.loreNodeUuid, [...(byNode.get(m.loreNodeUuid) ?? []), m])
  }
  const moved = new Map<string, ImportedEntry[]>()
  for (const item of targets) {
    const records = done.entries.get(item.importKey)
    if (records?.length) {
      // 同圈内节点更换了 Lore 源 URI 也记为 moved
      const diffUri = records.filter((m) => m.loreUri !== null && m.loreUri !== item.source)
      const sameUri = records.filter((m) => m.loreUri === null || m.loreUri === item.source)
      if (!sameUri.length && diffUri.length) moved.set(item.importKey, diffUri)
      continue
    }
    const earlier = (byNode.get(String(item.context.loreNodeUuid)) ?? []).filter(
      (m) => !planned.has(m.key) && m.loreUri !== null && m.loreUri !== item.source,
    )
    if (earlier.length) moved.set(item.importKey, earlier)
  }
  return moved
}

function priorImport(
  item: PlannedTarget,
  done: ImportRecords,
  moved: Map<string, ImportedEntry[]>,
): { state: LoreTargetState; found: ImportedEntry[] } {
  if (item.isSoul) {
    const key = `${item.personaSlug}:${item.traitKey}`
    return { state: done.traits.has(key) ? 'imported' : 'new', found: [] }
  }
  const earlier = moved.get(item.importKey)
  if (earlier) return { state: 'moved', found: earlier }
  const found = done.entries.get(item.importKey)
  return found?.length ? { state: 'imported', found } : { state: 'new', found: [] }
}

function writesNewPersona(
  plan: ImportPlan,
  done: ImportRecords,
  moved: Map<string, ImportedEntry[]>,
): boolean {
  return plan.targets.some((t) => t.isSoul && priorImport(t, done, moved).state === 'new')
}

function personaEffect(
  current: { ownerAccountId: string; defaultPersonaId: string | null } | undefined,
  accountId: string,
  persona: { used: boolean; id: string | null },
): 'blocked' | 'given' | 'other' | 'none' {
  if (current?.ownerAccountId !== accountId) return 'blocked'
  if (!persona.used) return 'none'
  if (current.defaultPersonaId === null) return 'given'
  return current.defaultPersonaId === persona.id ? 'none' : 'other'
}

export interface TargetPreview {
  item: PlannedTarget
  state: LoreTargetState
  current: { shortId: string | null; secret: boolean }[]
}

export interface ImportPreview {
  targets: TargetPreview[]
  personaExists: boolean
  createsPersona: boolean
  importedPersonas: string[]
  clientsGivenPersona: string[]
  clientsOtherPersona: string[]
  newClientsWithPersona: string[]
}

export async function previewImport(
  snap: PlanSnapshot,
  plan: ImportPlan,
  done: ImportRecords,
): Promise<ImportPreview> {
  const moved = movedInLore(plan, done)
  const [persona] = await snap.tx
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.circleId, snap.circleId), eq(personas.slug, plan.persona.slug)))
    .limit(1)
  const clientRows = await snap.tx
    .select({
      slug: clients.slug,
      ownerAccountId: clients.ownerAccountId,
      defaultPersonaId: clients.defaultPersonaId,
    })
    .from(clients)
    .where(eq(clients.circleId, snap.circleId))

  const clientBySlug = new Map(clientRows.map((r) => [r.slug, r]))
  const writes = writesNewPersona(plan, done, moved)
  const used = Boolean(persona) || writes

  const preview: ImportPreview = {
    targets: plan.targets.map((item) => {
      const { state, found } = priorImport(item, done, moved)
      return {
        item,
        state,
        current: found.map((m) => ({
          shortId: m.shortId,
          secret: m.state === 'secret',
        })),
      }
    }),
    personaExists: Boolean(persona),
    createsPersona: writes && !persona,
    importedPersonas: done.soulPersonas,
    clientsGivenPersona: [],
    clientsOtherPersona: [],
    newClientsWithPersona: [],
  }

  for (const mapping of plan.clients) {
    for (const c of mapping.clients) {
      const current = clientBySlug.get(c.slug)
      if (c.create && !current) {
        if (used) preview.newClientsWithPersona.push(c.slug)
        continue
      }
      const effect = personaEffect(current, snap.accountId, { used, id: persona?.id ?? null })
      if (effect === 'given') preview.clientsGivenPersona.push(c.slug)
      else if (effect === 'other') preview.clientsOtherPersona.push(c.slug)
    }
  }
  return preview
}

export interface BasePlan {
  plan: ImportPlan
  imports: ImportRecords
}

export async function planImportFor(
  snap: PlanSnapshot,
  snapshot: LoreSnapshot,
  targetCircles: { target: CircleRef; personal: CircleRef },
  existingClients: ExistingClient[],
  options: ImportOptions,
): Promise<BasePlan> {
  const imports = await importRecordsIn(snap.tx, targetCircles.target.id)
  const plan = planImport(snapshot, targetCircles, existingClients, options)
  return { plan, imports }
}

function sameImports(plan: ImportPlan, a: ImportRecords, b: ImportRecords): boolean {
  const nodes = new Set(
    plan.targets.filter((t) => !t.isSoul).map((t) => String(t.context.loreNodeUuid)),
  )
  const canonicalEntries = (records: ImportRecords) =>
    [...records.entries.values()]
      .flat()
      .filter((m) => nodes.has(m.loreNodeUuid))
      .map((m) => JSON.stringify([m.key, m.loreNodeUuid, m.loreUri]))
      .sort()
      .join('\n')
  const canonicalTraits = (records: ImportRecords) => [...records.traits].sort().join('\n')
  return canonicalEntries(a) === canonicalEntries(b) && canonicalTraits(a) === canonicalTraits(b)
}

function dataWriteFailure(err: unknown): string | null {
  const code = pgErrorCode(err)
  if (!code?.startsWith('22') && !code?.startsWith('23')) return null
  console.error('写入 Lore 的节点时数据库报错', { code })
  return `写入数据库失败（${code}）`
}

function importerAccess(circleId: string, circleKind: CircleKind, accountId: string): Access {
  return {
    ...consoleAccess(circleId, circleKind, 'owner', accountId, []),
    writeProvenance: 'system',
  }
}

async function verifyWriteCredentialRefs(
  tx: Tx,
  input: {
    circleId: string
    circleKind: CircleKind
    accountId: string
    content: string
    sensitivity: Sensitivity
  },
): Promise<Set<string>> {
  const { refs, malformed } = scanPlaceholders(input.content)
  if (malformed.length) {
    throw new MemoryError(400, '凭据占位符格式错误')
  }
  if (!refs.length) return new Set()
  if (!placeholderAllowed(input.circleKind, 'entry', input.sensitivity)) {
    throw new MemoryError(400, '当前目标不支持使用凭据占位符')
  }
  const identifiers = [...new Set(refs.map((r) => r.identifier))]
  const access = importerAccess(input.circleId, input.circleKind, input.accountId)
  const rows = await tx
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.circleId, input.circleId),
        eq(credentials.ownerAccountId, input.accountId),
        inArray(credentials.identifier, identifiers),
        isNull(credentials.deletedAt),
      ),
    )
    .for('share')

  for (const identifier of identifiers) {
    const row = rows.find((r) => r.identifier === identifier)
    if (!row || !canUseCredential(access, row)) {
      throw new MemoryError(400, `正文引用的凭据不存在或不可用：${identifier}`)
    }
    for (const ref of refs) {
      if (ref.identifier !== identifier || ref.field === null) continue
      if (!row.fields.some((f) => f.name === ref.field)) {
        throw new MemoryError(400, `凭据 ${identifier} 上不存在字段 ${ref.field}`)
      }
    }
  }
  return new Set(identifiers)
}

export interface ImportResult {
  personaUsed: boolean
  personaCreated: boolean
  clientsCreated: string[]
  clientsGivenPersona: string[]
  clientsOtherPersona: string[]
  created: string[]
  previouslyImported: string[]
  secretAlreadyImported: { legacyUri: string; shortId: string }[]
  movedInLore: { legacyUri: string; shortId: string | null }[]
  failed: { source: string; reason: string }[]
  plaintextConverted: string[]
  plaintextKept: { source: string; reason: string }[]
}

export async function applyImport(
  target: ImportTarget,
  plan: ImportPlan,
  expected?: ImportRecords,
): Promise<ImportResult> {
  const result: ImportResult = {
    personaUsed: false,
    personaCreated: false,
    clientsCreated: [],
    clientsGivenPersona: [],
    clientsOtherPersona: [],
    created: [],
    previouslyImported: [],
    secretAlreadyImported: [],
    movedInLore: [],
    failed: [],
    plaintextConverted: [],
    plaintextKept: [],
  }

  let done: ImportRecords = { entries: new Map(), traits: new Set(), soulPersonas: [] }
  let moved = new Map<string, ImportedEntry[]>()
  let personaId: string | null = null

  await withCircles(
    target.db,
    { read: uniqueCircleIds(target), write: [target.circleId] },
    async (tx) => {
      done = await importRecordsIn(tx, target.circleId)
      if (expected && !sameImports(plan, done, expected)) {
        throw new MemoryError(409, PLAN_CHANGED)
      }
      moved = movedInLore(plan, done)

      const needsNewPersona = plan.targets.some(
        (t) =>
          t.isSoul && t.sensitivity !== 'secret' && priorImport(t, done, moved).state === 'new',
      )
      const [createdPersona] = needsNewPersona
        ? await tx
            .insert(personas)
            .values({
              circleId: target.circleId,
              slug: plan.persona.slug,
              name: plan.persona.name,
            })
            .onConflictDoNothing()
            .returning({ id: personas.id })
        : []

      personaId =
        createdPersona?.id ??
        (
          await tx
            .select({ id: personas.id })
            .from(personas)
            .where(
              and(eq(personas.circleId, target.circleId), eq(personas.slug, plan.persona.slug)),
            )
            .limit(1)
        )[0]?.id ??
        null
      result.personaCreated = Boolean(createdPersona)
      result.personaUsed = personaId !== null

      for (const mapping of plan.clients) {
        for (const c of mapping.clients) {
          if (c.create) {
            const rows = await tx
              .insert(clients)
              .values({
                circleId: target.circleId,
                slug: c.slug,
                name: mapping.runtime,
                runtimeFamily: c.runtimeFamily,
                ownerAccountId: target.accountId,
                defaultPersonaId: personaId,
                config: { personMemoryMode: 'strict' },
              })
              .onConflictDoNothing()
              .returning({ slug: clients.slug })
            if (rows.length) {
              result.clientsCreated.push(c.slug)
              continue
            }
          }
          const [current] = await tx
            .select({
              ownerAccountId: clients.ownerAccountId,
              defaultPersonaId: clients.defaultPersonaId,
            })
            .from(clients)
            .where(and(eq(clients.circleId, target.circleId), eq(clients.slug, c.slug)))
            .for('update')
          const effect = personaEffect(current, target.accountId, {
            used: result.personaUsed,
            id: personaId,
          })
          if (effect === 'given') {
            await tx
              .update(clients)
              .set({ defaultPersonaId: personaId, updatedAt: new Date() })
              .where(and(eq(clients.circleId, target.circleId), eq(clients.slug, c.slug)))
            result.clientsGivenPersona.push(c.slug)
          } else if (effect === 'other') {
            result.clientsOtherPersona.push(c.slug)
          }
        }
      }

      // 导入 core://soul* 设定段至 persona_traits；严格拒绝标成机密（防止明文写入人格）
      for (const item of plan.targets) {
        if (!item.isSoul) continue
        if (item.sensitivity === 'secret') {
          result.failed.push({
            source: item.legacyUri,
            reason: '人格设定（core://soul）不支持标记为机密',
          })
          continue
        }
        const { state } = priorImport(item, done, moved)
        if (state !== 'new' || !personaId) continue
        const targetPersonaId = personaId
        try {
          await tx.transaction(async (sp) => {
            await sp
              .insert(personaTraits)
              .values({
                circleId: target.circleId,
                personaId: targetPersonaId,
                traitKey: item.traitKey!,
                title: item.title,
                content: item.content,
                sortOrder: item.sortOrder ?? 0,
                updatedAt: item.updatedAt,
              })
              .onConflictDoNothing()
          })
        } catch (err) {
          const reason = dataWriteFailure(err)
          if (reason === null) throw err
          result.failed.push({ source: item.legacyUri, reason })
        }
      }
    },
  )

  for (const item of plan.targets) {
    if (item.isSoul) continue
    const { state, found } = priorImport(item, done, moved)
    if (state === 'moved') {
      for (const m of found) {
        result.movedInLore.push({ legacyUri: item.legacyUri, shortId: m.shortId })
      }
    }
    if (state !== 'new') {
      const skippedShortId =
        found.find((f) => f.shortId !== null)?.shortId ?? found[0]?.eventShortId
      if (skippedShortId) result.previouslyImported.push(skippedShortId)
      if (item.converted || item.plaintextKept) {
        result.plaintextKept.push({
          source: item.legacyUri,
          reason: '之前已导入过，这次不改它的正文：疑似明文可在待处理中转存',
        })
      }
      if (item.sensitivity === 'secret') {
        for (const f of found) {
          if (f.state !== 'plain' || !f.shortId) continue
          result.secretAlreadyImported.push({ legacyUri: item.legacyUri, shortId: f.shortId })
        }
      }
      continue
    }

    const writtenContent = item.converted?.content ?? item.content
    const writtenTitleRaw = item.converted?.title ?? item.title

    try {
      const shortId = await withCircle(target.db, item.targetCircleId, async (tx, now) => {
        if (item.runtimeSlug) {
          await tx
            .insert(facetTerms)
            .values({
              circleId: item.targetCircleId,
              dimensionKey: 'runtime',
              slug: item.runtimeSlug,
              label: item.runtimeLabel ?? item.runtimeSlug,
              implies: {},
              aliases: [],
              autoRegistered: true,
            })
            .onConflictDoNothing()
        }

        const credIdentifiers = await verifyWriteCredentialRefs(tx, {
          circleId: item.targetCircleId,
          circleKind: item.targetCircleKind,
          accountId: target.accountId,
          content: writtenContent,
          sensitivity: item.sensitivity,
        })

        const { settings: privacy } = await loadCirclePrivacy(tx, item.targetCircleId)
        const outcome =
          item.sensitivity === 'secret' ? null : evaluateSensitiveContent(writtenContent, privacy)

        const ownerAccountId = item.targetCircleKind === 'personal' ? target.accountId : null
        const realms = normalizeRealms(item.when.realm ?? [])
        const createdAt = item.createdAt.getTime() > now.getTime() ? now : item.createdAt
        const updatedAt = item.updatedAt.getTime() > now.getTime() ? now : item.updatedAt
        const validFrom = createdAt

        const { shortId: allocated, value: inserted } = await insertWithAllocatedShortId(
          tx,
          async (sp, candidateShortId) => {
            const title = deriveEntryTitle(
              writtenTitleRaw,
              [{ content: writtenContent }],
              candidateShortId,
              item.sensitivity,
            )
            const [entryRow] = await sp
              .insert(entries)
              .values({
                circleId: item.targetCircleId,
                circleKind: item.targetCircleKind,
                shortId: candidateShortId,
                kind: 'entry',
                provenance: 'owner',
                originScope: 'global',
                clientId: null,
                ownerAccountId,
                subjectId: null,
                subjectKind: null,
                conversationId: null,
                realms,
                topics: item.topics,
                title,
                sensitivity: item.sensitivity,
                priority: item.priority,
                disclosure: item.disclosure,
                validFrom,
                validTo: null,
                expiresAt: null,
                version: 1,
                createdAt,
                updatedAt,
              })
              .returning()

            const variantId = randomUUID()
            const searchHeader = buildSearchHeader({
              sensitivity: item.sensitivity,
              title,
              topics: item.topics,
              disclosure: item.disclosure,
              glossary: item.glossary,
            })
            const sealed =
              item.sensitivity === 'secret'
                ? sealVariantContent(target.masterKey!, variantId, writtenContent)
                : null

            const [variantRow] = await sp
              .insert(entryVariants)
              .values({
                id: variantId,
                circleId: item.targetCircleId,
                entryId: entryRow!.id,
                kind: 'entry',
                sensitivity: item.sensitivity,
                when: item.when,
                whenSignature: item.whenSignature,
                sortOrder: 0,
                searchHeader,
                content: item.sensitivity === 'secret' ? null : writtenContent,
                ciphertext: sealed?.ciphertext ?? null,
                wrappedKey: sealed?.wrappedKey ?? null,
                keyId: sealed?.keyId ?? null,
                sensitiveCredential: outcome?.hasCredential ?? false,
                sensitivePii: outcome?.hasPii ?? false,
                sensitiveFindings: outcome?.findings ?? [],
              })
              .returning()

            return { entryRow: entryRow!, variantRow: variantRow! }
          },
        )

        const { entryRow, variantRow } = inserted

        if (item.glossary.length) {
          await tx
            .insert(entryGlossary)
            .values(
              item.glossary.map((keyword) => ({
                circleId: item.targetCircleId,
                entryId: entryRow.id,
                keyword,
              })),
            )
            .onConflictDoNothing()
        }

        await syncCredentialRefs(
          tx,
          item.targetCircleId,
          entryRow.id,
          item.sensitivity === 'secret' ? new Set() : credIdentifiers,
        )

        await syncEntryLinks(tx, {
          circleId: item.targetCircleId,
          entryId: entryRow.id,
          shortId: allocated,
          sensitivity: entryRow.sensitivity,
          provenance: entryRow.provenance,
          variants: [
            {
              id: variantRow.id,
              content: entryRow.sensitivity === 'secret' ? null : writtenContent,
            },
          ],
        })

        await tx
          .insert(legacyUris)
          .values({
            circleId: item.targetCircleId,
            entryId: entryRow.id,
            legacyUri: item.legacyUri,
            source: 'lore',
          })
          .onConflictDoNothing()

        const snap = toStoredSnapshot(
          entryRow,
          [{ when: item.when, content: writtenContent }],
          item.glossary,
        )
        await tx.insert(entryEvents).values({
          circleId: item.targetCircleId,
          entryId: entryRow.id,
          shortId: allocated,
          eventType: 'import',
          provenance: 'owner',
          actorAccountId: target.accountId,
          before: null,
          after: { ...snap, legacyUri: item.legacyUri },
          context: item.converted
            ? { ...item.context, [CONVERTED_KEY]: item.converted.refs }
            : item.context,
        })

        return allocated
      })

      result.created.push(shortId)
      if (item.converted) result.plaintextConverted.push(shortId)
      for (const reason of item.plaintextKept ?? []) {
        result.plaintextKept.push({ source: item.legacyUri, reason })
      }
    } catch (err) {
      if (err instanceof MemoryError) {
        result.failed.push({ source: item.legacyUri, reason: err.message })
        continue
      }
      const reason = dataWriteFailure(err)
      if (reason === null) throw err
      result.failed.push({ source: item.legacyUri, reason })
    }
  }

  return result
}

export type SyncState =
  'update' | 'current' | 'edited' | 'moved' | 'deleted' | 'skipped' | 'unmapped' | 'unreadable'

export interface SyncUpdate {
  circleId: string
  entryId: string
  shortId: string
  legacyUri: string
  expectedVersion: number
  title?: string
  content?: string
  priority?: number
  disclosure?: string | null
  glossaryAdd?: string[]
  glossaryRemove?: string[]
}

export interface SyncItem {
  source: string
  legacyUri: string
  shortId: string
  title: string
  state: SyncState
  target?: string
  reason?: string
  changes: LoreSyncChange[]
  update?: SyncUpdate
  context?: Record<string, unknown>
}

export interface SyncPlan {
  items: SyncItem[]
  goneFromLore: string[]
}

type ProtectedContent =
  { kind: 'ok'; content: string } | { kind: 'unknown' | 'missing'; ref: ConvertedRef }

function protectLoreContent(
  content: string,
  current: string,
  refs: ConvertedRef[],
  known: KnownCredentialValues | null,
): ProtectedContent {
  const live = refs.filter((ref) => current.includes(placeholderOf(ref)))
  const values: { ref: ConvertedRef; value: string }[] = []
  for (const ref of live) {
    const value = known?.entries.find(
      (e) => e.identifier === ref.identifier && e.field === ref.field,
    )?.value
    if (value === undefined) return { kind: 'unknown', ref }
    values.push({ ref, value })
  }
  let text = content
  for (const { ref, value } of [...values].sort((a, b) => b.value.length - a.value.length)) {
    const swapped = replaceOutsidePlaceholders(text, value, placeholderOf(ref))
    if (!swapped.replaced && !text.includes(placeholderOf(ref))) return { kind: 'missing', ref }
    text = swapped.text
  }
  return { kind: 'ok', content: text }
}

function unknownReason(ref: ConvertedRef, known: KnownCredentialValues | null | undefined): string {
  const at = `${ref.identifier}#${ref.field}`
  const head = `导入时已换成 ${at} 的占位符`
  if (known === undefined) return `${head}，命令行无法核对凭据的值：请在管理界面同步`
  if (known === null) return `${head}，这次没有读取凭据的值：请重新查看计划`
  if (known.unconvertible.has(at)) {
    return `${head}，这条凭据现在的${UNCONVERTIBLE}，无法按值核对，这次不同步`
  }
  const source = known.unresolved.get(ref.identifier)
  if (source === 'master_key') return `${head}，服务端未配置主密钥，无法读取凭据的值，这次不同步`
  if (source === 'vault') return `${head}，密码库连接或条目暂时不可用，这次不同步`
  if (source === 'hosted') return `${head}，这条凭据的值无法解密，这次不同步`
  return `${head}，这条凭据已删除或没有这个字段，这次不同步`
}

function convertedRefs(raw: unknown): ConvertedRef[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r: unknown) => {
    const ref = r as { identifier?: unknown; field?: unknown } | null
    return typeof ref?.identifier === 'string' && typeof ref.field === 'string'
      ? [{ identifier: ref.identifier, field: ref.field }]
      : []
  })
}

export async function planSync(
  snap: PlanSnapshot,
  plan: ImportPlan,
  snapshot: LoreSnapshot,
  done: ImportRecords,
  known?: KnownCredentialValues | null,
): Promise<SyncPlan> {
  const all = [...done.entries.values()].flat()
  const live = all.filter((m) => m.state !== 'deleted' && m.entryId)
  const liveIds = live.map((m) => m.entryId!)

  const written = liveIds.length
    ? await snap.tx
        .select({
          entryId: entryEvents.entryId,
          version: sql<number | null>`max((${entryEvents.after}->>'version')::int)`,
        })
        .from(entryEvents)
        .where(
          and(
            inArray(entryEvents.entryId, liveIds),
            inArray(entryEvents.eventType, ['import', 'sync']),
            sql`${entryEvents.context}->>'source' = 'lore'`,
          ),
        )
        .groupBy(entryEvents.entryId)
    : []
  const writtenVersion = new Map(written.map((w) => [w.entryId, w.version]))

  const convertedRows = liveIds.length
    ? await snap.tx
        .select({
          entryId: entryEvents.entryId,
          refs: sql<unknown>`${entryEvents.context}->${CONVERTED_KEY}::text`,
        })
        .from(entryEvents)
        .where(
          and(
            inArray(entryEvents.entryId, liveIds),
            inArray(entryEvents.eventType, ['import', 'sync']),
            sql`${entryEvents.context}->>'source' = 'lore'`,
            sql`${entryEvents.context}->${CONVERTED_KEY}::text is not null`,
          ),
        )
    : []
  const convertedOf = new Map<string, ConvertedRef[]>()
  for (const row of convertedRows) {
    const refs = new Map(
      (convertedOf.get(row.entryId!) ?? []).map((r) => [placeholderOf(r), r] as const),
    )
    for (const ref of convertedRefs(row.refs)) refs.set(placeholderOf(ref), ref)
    convertedOf.set(row.entryId!, [...refs.values()])
  }

  // 批量顺序读取当前条目、切片、关键词（禁止同事务并行）
  const liveEntriesMap = new Map<string, typeof entries.$inferSelect>()
  const liveVariantsMap = new Map<string, (typeof entryVariants.$inferSelect)[]>()
  const liveGlossaryMap = new Map<string, string[]>()
  if (liveIds.length) {
    const entryRows = await snap.tx.select().from(entries).where(inArray(entries.id, liveIds))
    for (const r of entryRows) liveEntriesMap.set(r.id, r)

    const variantRows = await snap.tx
      .select()
      .from(entryVariants)
      .where(inArray(entryVariants.entryId, liveIds))
      .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.createdAt))
    for (const v of variantRows) {
      liveVariantsMap.set(v.entryId, [...(liveVariantsMap.get(v.entryId) ?? []), v])
    }

    const glossaryRows = await snap.tx
      .select({ entryId: entryGlossary.entryId, keyword: entryGlossary.keyword })
      .from(entryGlossary)
      .where(inArray(entryGlossary.entryId, liveIds))
      .orderBy(asc(entryGlossary.keyword))
    for (const g of glossaryRows) {
      liveGlossaryMap.set(g.entryId, [...(liveGlossaryMap.get(g.entryId) ?? []), g.keyword])
    }
  }

  const untouched = (m: ImportedEntry) =>
    m.version !== null && writtenVersion.get(m.entryId) === m.version

  const sync: SyncPlan = { items: [], goneFromLore: [] }
  const nodeByUuid = new Map(snapshot.nodes.map((n) => [n.uuid, n]))
  const reported = new Set<ImportedEntry>()
  const report = (
    m: ImportedEntry,
    fallbackUri: string,
    item: Omit<SyncItem, 'changes' | 'title' | 'shortId'> & Partial<SyncItem>,
  ) => {
    reported.add(m)
    const content = nodeByUuid.get(m.loreNodeUuid)?.content ?? null
    const shortId = item.shortId ?? m.shortId ?? m.eventShortId
    sync.items.push({
      changes: [],
      title: loreTitle(content, fallbackUri, m.state === 'secret'),
      shortId,
      ...item,
    })
  }

  const moved = movedInLore(plan, done)
  for (const item of plan.targets) {
    if (item.isSoul) continue
    const source = item.source
    for (const m of moved.get(item.importKey) ?? []) {
      const legacy = m.legacyUri ?? m.loreUri ?? item.legacyUri
      if (m.state === 'deleted' || !m.shortId) {
        report(m, legacy, { source, legacyUri: legacy, state: 'deleted' })
      } else if (m.circleId === item.targetCircleId && m.loreUri === source) {
        report(m, legacy, { source, legacyUri: legacy, state: 'edited' })
      } else {
        report(m, legacy, {
          source,
          legacyUri: legacy,
          state: 'moved',
          target: item.legacyUri,
        })
      }
    }

    for (const m of done.entries.get(item.importKey) ?? []) {
      if (reported.has(m)) continue
      const legacy = m.legacyUri ?? m.loreUri ?? item.legacyUri
      if (m.state === 'deleted' || !m.shortId || !m.entryId) {
        report(m, legacy, { source, legacyUri: legacy, state: 'deleted' })
        continue
      }
      if (!untouched(m)) {
        report(m, legacy, { source, legacyUri: legacy, state: 'edited' })
        continue
      }
      if (m.circleId !== item.targetCircleId || (m.loreUri !== null && m.loreUri !== source)) {
        report(m, legacy, {
          source,
          legacyUri: legacy,
          state: 'moved',
          target: item.legacyUri,
        })
        continue
      }

      const currentEntry = liveEntriesMap.get(m.entryId)
      const currentVariants = liveVariantsMap.get(m.entryId) ?? []
      if (!currentEntry || currentEntry.version !== m.version || currentVariants.length !== 1) {
        report(m, legacy, { source, legacyUri: legacy, state: 'edited' })
        continue
      }

      if (m.state === 'secret' && !snap.masterKey) {
        throw new Error(
          `${currentEntry.shortId} 是机密记忆，同步要读出来比对：需要设置与服务相同的 KIOKU_MASTER_KEY`,
        )
      }

      const variant = currentVariants[0]!
      let currentContent = variant.content ?? ''
      if (currentEntry.sensitivity === 'secret') {
        try {
          currentContent = openVariantContent(snap.masterKey!, variant.id, variant)
        } catch {
          report(m, legacy, {
            source,
            legacyUri: legacy,
            state: 'unreadable',
            reason: '无法使用当前 KIOKU_MASTER_KEY 解密该机密词条',
          })
          continue
        }
      }

      const refs = convertedOf.get(m.entryId) ?? []
      let wantContent = item.content
      if (refs.length) {
        const prepared = protectLoreContent(wantContent, currentContent, refs, known ?? null)
        if (prepared.kind !== 'ok') {
          const at = `${prepared.ref.identifier}#${prepared.ref.field}`
          report(
            m,
            legacy,
            prepared.kind === 'missing'
              ? {
                  source,
                  legacyUri: legacy,
                  state: 'skipped',
                  reason: `导入时已换成 ${at} 的占位符，Lore 的正文里找不到这条凭据现在的值：值换过的，请把 Lore 里的值换成这个占位符；Lore 里删掉了这一处的，在 Kioku 里同样删掉这个占位符，改过之后这条记忆不再随 Lore 同步`,
                }
              : {
                  source,
                  legacyUri: legacy,
                  state: 'unreadable',
                  reason: unknownReason(prepared.ref, known),
                },
          )
          continue
        }
        wantContent = prepared.content
      }

      const update: SyncUpdate = {
        circleId: currentEntry.circleId,
        entryId: currentEntry.id,
        shortId: currentEntry.shortId,
        legacyUri: legacy,
        expectedVersion: currentEntry.version,
      }
      const changes: LoreSyncChange[] = []
      if (currentContent !== wantContent) {
        update.content = wantContent
        changes.push('content')
      }
      const title = deriveEntryTitle(
        loreTitle(wantContent, legacy, currentEntry.sensitivity === 'secret'),
        [{ content: wantContent }],
        currentEntry.shortId,
        currentEntry.sensitivity,
      )
      if (currentEntry.title !== title) {
        update.title = title
        changes.push('title')
      }
      if (currentEntry.priority !== item.priority) {
        update.priority = item.priority
        changes.push('priority')
      }
      if ((currentEntry.disclosure ?? null) !== (item.disclosure ?? null)) {
        update.disclosure = item.disclosure ?? null
        changes.push('disclosure')
      }
      const currentGlossary = liveGlossaryMap.get(currentEntry.id) ?? []
      const wantedGlossary = new Set(item.glossary)
      const add = [...wantedGlossary].filter((k) => !currentGlossary.includes(k))
      const remove = currentGlossary.filter((k) => !wantedGlossary.has(k))
      if (add.length || remove.length) {
        if (add.length) update.glossaryAdd = add
        if (remove.length) update.glossaryRemove = remove
        changes.push('glossary')
      }

      report(
        m,
        legacy,
        changes.length
          ? {
              source,
              legacyUri: legacy,
              title,
              state: 'update',
              changes,
              update,
              context: refs.length ? { ...item.context, [CONVERTED_KEY]: refs } : item.context,
            }
          : { source, legacyUri: legacy, title, state: 'current' },
      )
    }
  }

  const nodeReasons = new Map<string, string[]>()
  const targetReason = new Map<ImportedEntry, string>()
  for (const s of plan.skipped) {
    if (!s.target) {
      nodeReasons.set(s.source, [...(nodeReasons.get(s.source) ?? []), s.reason])
      continue
    }
    const key = s.target.importKey
    for (const m of [...(done.entries.get(key) ?? []), ...(moved.get(key) ?? [])]) {
      if (!targetReason.has(m)) targetReason.set(m, s.reason)
    }
  }

  for (const m of all) {
    if (reported.has(m) || m.state === 'deleted' || !m.shortId) continue
    const legacy = m.legacyUri ?? m.loreUri ?? m.shortId
    const node = nodeByUuid.get(m.loreNodeUuid)
    if (!node) {
      sync.goneFromLore.push(legacy)
      continue
    }
    const reason = targetReason.get(m)
    const reasons = [
      ...new Set([...(nodeReasons.get(node.uri) ?? []), ...(reason ? [reason] : [])]),
    ]
    report(
      m,
      legacy,
      reasons.length
        ? { source: node.uri, legacyUri: legacy, state: 'skipped', reason: reasons.join('；') }
        : { source: node.uri, legacyUri: legacy, state: 'unmapped' },
    )
  }

  return sync
}

export async function hasConvertedImports(
  db: Db,
  target: Pick<ImportTarget, 'circleId' | 'personalCircleId'>,
): Promise<boolean> {
  const [row] = await withCircles(db, { read: uniqueCircleIds(target) }, (tx) =>
    tx
      .select({ id: entryEvents.id })
      .from(entryEvents)
      .where(
        and(
          inArray(entryEvents.eventType, ['import', 'sync']),
          sql`${entryEvents.context}->>'source' = 'lore'`,
          sql`${entryEvents.context}->${CONVERTED_KEY}::text is not null`,
        ),
      )
      .limit(1),
  )
  return Boolean(row)
}

export interface SyncResult {
  updated: string[]
  failed: { source: string; reason: string }[]
}

export async function applySync(target: ImportTarget, sync: SyncPlan): Promise<SyncResult> {
  const result: SyncResult = { updated: [], failed: [] }
  for (const item of sync.items) {
    if (item.state !== 'update' || !item.update) continue
    const upd = item.update
    try {
      await withCircle(target.db, upd.circleId, async (tx, now) => {
        const [before] = await tx
          .select()
          .from(entries)
          .where(and(eq(entries.id, upd.entryId), isNull(entries.deletedAt)))
          .for('update')
        if (!before || before.version !== upd.expectedVersion) {
          throw new MemoryError(409, '词条刚被修改或删除，本次不同步')
        }
        const existingVariants = await tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, before.id))
          .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.createdAt))
        if (existingVariants.length !== 1) {
          throw new MemoryError(409, '词条结构已变化，本次不同步')
        }
        const vRow = existingVariants[0]!
        const oldGlossary = (
          await tx
            .select({ keyword: entryGlossary.keyword })
            .from(entryGlossary)
            .where(eq(entryGlossary.entryId, before.id))
            .orderBy(asc(entryGlossary.keyword))
        ).map((g) => g.keyword)

        const oldContent =
          before.sensitivity === 'secret'
            ? openVariantContent(target.masterKey!, vRow.id, vRow)
            : (vRow.content ?? '')

        const nextContent = upd.content ?? oldContent
        const nextTitle = upd.title ?? before.title
        const nextPriority = upd.priority ?? before.priority
        const nextDisclosure = upd.disclosure === undefined ? before.disclosure : upd.disclosure

        const parsedCheck = UpdateEntryRequest.safeParse({
          id: before.shortId,
          title: nextTitle,
          content: nextContent,
          priority: nextPriority,
          disclosure: nextDisclosure,
        })
        if (!parsedCheck.success) {
          throw new MemoryError(400, parsedCheck.error.issues.map((i) => i.message).join('；'))
        }

        const glossarySet = new Set(oldGlossary)
        for (const k of upd.glossaryAdd ?? []) glossarySet.add(k)
        for (const k of upd.glossaryRemove ?? []) glossarySet.delete(k)
        const nextGlossary = [...glossarySet].sort()

        await verifyWriteCredentialRefs(tx, {
          circleId: before.circleId,
          circleKind: before.circleKind,
          accountId: target.accountId,
          content: nextContent,
          sensitivity: before.sensitivity,
        })

        const [updatedEntry] = await tx
          .update(entries)
          .set({
            title: nextTitle,
            priority: nextPriority,
            disclosure: nextDisclosure,
            version: before.version + 1,
            updatedAt: now.getTime() > before.updatedAt.getTime() ? now : before.updatedAt,
          })
          .where(
            and(
              eq(entries.id, before.id),
              eq(entries.version, before.version),
              isNull(entries.deletedAt),
            ),
          )
          .returning()
        if (!updatedEntry) throw new MemoryError(409, '词条刚被修改，请重新生成计划')

        const header = buildSearchHeader({
          sensitivity: before.sensitivity,
          title: nextTitle,
          topics: before.topics,
          disclosure: nextDisclosure,
          glossary: nextGlossary,
        })
        const { settings: privacy } = await loadCirclePrivacy(tx, before.circleId)
        const outcome =
          before.sensitivity === 'secret' ? null : evaluateSensitiveContent(nextContent, privacy)
        const sealed =
          before.sensitivity === 'secret'
            ? sealVariantContent(target.masterKey!, vRow.id, nextContent)
            : null

        await tx
          .update(entryVariants)
          .set({
            content: before.sensitivity === 'secret' ? null : nextContent,
            searchHeader: header,
            ciphertext: sealed?.ciphertext ?? null,
            wrappedKey: sealed?.wrappedKey ?? null,
            keyId: sealed?.keyId ?? null,
            sensitiveCredential: outcome?.hasCredential ?? false,
            sensitivePii: outcome?.hasPii ?? false,
            sensitiveFindings: outcome?.findings ?? [],
            updatedAt: now,
          })
          .where(eq(entryVariants.id, vRow.id))

        if (upd.glossaryAdd !== undefined || upd.glossaryRemove !== undefined) {
          await tx.delete(entryGlossary).where(eq(entryGlossary.entryId, before.id))
          if (nextGlossary.length) {
            await tx
              .insert(entryGlossary)
              .values(
                nextGlossary.map((keyword) => ({
                  circleId: before.circleId,
                  entryId: before.id,
                  keyword,
                })),
              )
              .onConflictDoNothing()
          }
        }

        const credIds =
          before.sensitivity === 'secret' ? new Set<string>() : placeholderIdentifiers(nextContent)
        await syncCredentialRefs(tx, before.circleId, before.id, credIds)
        await syncEntryLinks(tx, {
          circleId: before.circleId,
          entryId: before.id,
          shortId: before.shortId,
          sensitivity: before.sensitivity,
          provenance: before.provenance,
          variants: [
            {
              id: vRow.id,
              content: before.sensitivity === 'secret' ? null : nextContent,
            },
          ],
        })

        const beforeSnap = toStoredSnapshot(
          before,
          [{ when: normalizeWhen(vRow.when), content: oldContent }],
          oldGlossary,
        )
        const afterSnap = toStoredSnapshot(
          updatedEntry,
          [{ when: normalizeWhen(vRow.when), content: nextContent }],
          nextGlossary,
        )
        await tx.insert(entryEvents).values({
          circleId: before.circleId,
          entryId: before.id,
          shortId: before.shortId,
          eventType: 'sync',
          provenance: 'owner',
          actorAccountId: target.accountId,
          before: { ...beforeSnap, legacyUri: upd.legacyUri },
          after: { ...afterSnap, legacyUri: upd.legacyUri },
          context: { ...item.context, changes: item.changes },
        })
      })
      result.updated.push(upd.shortId)
    } catch (err) {
      const reason = err instanceof MemoryError ? err.message : dataWriteFailure(err)
      if (reason === null) throw err
      result.failed.push({ source: upd.legacyUri, reason })
    }
  }
  return result
}

export function planFingerprint(plan: ImportPlan, preview: ImportPreview, sync: SyncPlan): string {
  const canonical = <T>(items: T[]) => items.map((item) => JSON.stringify(item)).sort()
  return createHash('sha256')
    .update(
      JSON.stringify({
        persona: plan.persona,
        createsPersona: preview.createsPersona,
        clientsGivenPersona: [...preview.clientsGivenPersona].sort(),
        clientsOtherPersona: [...preview.clientsOtherPersona].sort(),
        newClientsWithPersona: [...preview.newClientsWithPersona].sort(),
        clients: canonical(
          plan.clients.map((m) => ({
            runtime: m.runtime,
            clients: canonical(m.clients.map((c) => [c.slug, c.create, c.runtimeFamily])),
          })),
        ),
        targets: canonical(
          preview.targets.map(({ item, state }) => ({
            source: item.source,
            legacyUri: item.legacyUri,
            targetCircleId: item.targetCircleId,
            targetCircleKind: item.targetCircleKind,
            isSoul: item.isSoul,
            traitKey: item.traitKey ?? null,
            topics: item.topics,
            when: item.when,
            title: item.title,
            priority: item.priority,
            disclosure: item.disclosure,
            glossary: [...item.glossary].sort(),
            content: createHash('sha256').update(item.content).digest('hex'),
            state,
          })),
        ),
        skipped: canonical(plan.skipped.map((s) => [s.source, s.reason])),
        warnings: canonical(plan.warnings.map((w) => [w.legacyUri, w.kind])),
        updates: canonical(
          sync.items
            .filter((i) => i.state === 'update')
            .map((i) => ({
              legacyUri: i.legacyUri,
              shortId: i.shortId,
              title: i.title,
              changes: [...i.changes].sort(),
            })),
        ),
        goneFromLore: [...sync.goneFromLore].sort(),
      }),
    )
    .digest('hex')
}

export async function loreDataTimeIn(tx: Tx): Promise<Date | null> {
  const [row] = await tx
    .select({
      at: sql<Date | null>`max(coalesce((${entryEvents.context}->>'loreExportedAt')::timestamptz, ${entryEvents.createdAt}))`.mapWith(
        entryEvents.createdAt,
      ),
    })
    .from(entryEvents)
    .where(
      and(
        inArray(entryEvents.eventType, ['import', 'sync']),
        sql`${entryEvents.context}->>'source' = 'lore'`,
      ),
    )
  return row?.at ?? null
}

export async function loreDataTime(
  db: Db,
  target: Pick<ImportTarget, 'circleId' | 'personalCircleId'>,
): Promise<Date | null> {
  return withCircles(db, { read: uniqueCircleIds(target) }, (tx) => loreDataTimeIn(tx))
}

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

export async function verifyMasterKey(
  db: Db,
  target: Pick<ImportTarget, 'circleId' | 'personalCircleId'>,
  masterKey: MasterKey,
): Promise<boolean> {
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
  const circleIds = (await db.select({ id: circles.id }).from(circles)).map((c) => c.id)
  if (!circleIds.length) return false
  const checkIds = [...new Set([...uniqueCircleIds(target), ...circleIds])]
  const found = await withCircles(db, { read: checkIds }, async (tx) => {
    const [variant] = await tx
      .select({
        id: entryVariants.id,
        ciphertext: entryVariants.ciphertext,
        wrappedKey: entryVariants.wrappedKey,
        keyId: entryVariants.keyId,
      })
      .from(entryVariants)
      .where(and(isNotNull(entryVariants.ciphertext), isNotNull(entryVariants.wrappedKey)))
      .limit(1)
    if (variant) return { kind: 'variant' as const, row: variant }

    const [cred] = await tx
      .select({
        id: credentials.id,
        ciphertext: credentials.ciphertext,
        wrappedKey: credentials.wrappedKey,
        keyId: credentials.keyId,
      })
      .from(credentials)
      .where(and(isNotNull(credentials.ciphertext), isNotNull(credentials.wrappedKey)))
      .limit(1)
    if (cred) return { kind: 'cred' as const, row: cred }

    const [conn] = await tx
      .select({
        id: vaultConnections.id,
        ciphertext: vaultConnections.ciphertext,
        wrappedKey: vaultConnections.wrappedKey,
        keyId: vaultConnections.keyId,
      })
      .from(vaultConnections)
      .where(
        and(
          isNotNull(vaultConnections.ciphertext),
          isNotNull(vaultConnections.wrappedKey),
          ne(vaultConnections.status, 'disconnected'),
        ),
      )
      .limit(1)
    if (conn) return { kind: 'vault' as const, row: conn }
    return null
  })
  if (!found) return false
  try {
    if (found.kind === 'variant') {
      openVariantContent(masterKey, found.row.id, found.row)
    } else if (found.kind === 'cred') {
      openCredentialValues(masterKey, {
        id: found.row.id,
        ciphertext: found.row.ciphertext!,
        wrappedKey: found.row.wrappedKey!,
        keyId: found.row.keyId,
      })
    } else {
      decryptSecret(
        decryptionKey(masterKey, found.row.keyId),
        { ciphertext: found.row.ciphertext!, wrappedKey: found.row.wrappedKey! },
        vaultAad(found.row.id),
      )
    }
    return true
  } catch {
    throw new Error('KIOKU_MASTER_KEY 解不开已有的加密数据：它和服务使用的主密钥不一致')
  }
}
