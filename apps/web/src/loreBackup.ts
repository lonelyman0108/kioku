import {
  LORE_BACKUP_FORMAT,
  LORE_BACKUP_TABLES,
  LORE_UPLOAD_MAX_BYTES,
  type LoreBackupUpload,
  type LoreImportPlan,
  type LorePlanNode,
  type LorePlanTarget,
  type LoreSyncChange,
  type LoreSyncState,
  type LoreTargetState,
} from '@kioku/contracts'

import { ApiError } from './api/client'
import { formatBytes } from './backup'

// 从 Lore 导入时界面用的纯逻辑：裁剪导出文件、勾选换算成请求、勾选之后这次写什么、计划的分组、执行失败的说明

type Row = Record<string, unknown>

// 文件本身的问题：文字是这里写的，可以直接给人看
export class LoreFileError extends Error {}

// 裁剪：导出里除了要用的五张表还有 Lore 的接口 Key（app_settings）、事件与 dream 日记，这些不离开浏览器。
// 废弃版本的正文也去掉：只用来数旧版本，里面可能有轮换过的明文。结果只有 format、created_at 与五张表
export function trimLoreBackup(raw: unknown): LoreBackupUpload {
  const data = raw as { format?: unknown; created_at?: unknown; tables?: unknown } | null
  if (data?.format !== LORE_BACKUP_FORMAT) throw new LoreFileError('不是 Lore 的导出文件')
  if (typeof data.created_at !== 'string') throw new LoreFileError('导出文件里没有导出时间')
  const from = (data.tables ?? {}) as Record<string, unknown>
  const rowsOf = (table: string): Row[] => {
    const rows = from[table]
    if (!Array.isArray(rows)) throw new LoreFileError(`导出文件里没有 ${table} 这张表`)
    return rows as Row[]
  }
  const tables = Object.fromEntries(
    LORE_BACKUP_TABLES.map((table) => [table, rowsOf(table)]),
  ) as LoreBackupUpload['tables']
  // 不是明确没废弃的都去掉正文：宁可让服务端报这一行不对，不多传
  tables.memories = tables.memories.map((row) => {
    if (row.deprecated === false) return row
    const rest = { ...row }
    delete rest.content
    return rest
  })
  return { format: LORE_BACKUP_FORMAT, created_at: data.created_at, tables }
}

// 读选中的文件并裁剪。原始内容读完就丢，不留在页面的状态里
export async function readLoreBackup(file: File): Promise<LoreBackupUpload> {
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    throw new LoreFileError('读不出这个文件，或者它不是 JSON')
  }
  const trimmed = trimLoreBackup(raw)
  const size = new TextEncoder().encode(JSON.stringify(trimmed)).length
  if (size > LORE_UPLOAD_MAX_BYTES) {
    throw new LoreFileError(
      `裁剪之后还有 ${formatBytes(size)}，超过 ${formatBytes(LORE_UPLOAD_MAX_BYTES)} 的上限`,
    )
  }
  return trimmed
}

// 主机是不是回环或内网：这些地址走 http 时 Token 不经过公网
function isInternalHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase()
  // 没有点的主机名（容器名、局域网里的机器名）与内网专用的后缀
  if (!name.includes('.') && !name.includes(':')) return true
  if (/\.(local|internal|lan|home\.arpa)$/.test(name)) return true
  if (name.includes(':')) return /^(::1$|f[cd]|fe[89ab])/.test(name)
  const octets = name.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) return false
  const [a, b] = octets as [number, number, number, number]
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

// 地址是 http 而且不是内网：Token 会明文经过网络（这个 Token 还能清空整个 Lore）
export function tokenInClear(address: string): boolean {
  try {
    const url = new URL(address.trim())
    return url.protocol === 'http:' && !isInternalHost(url.hostname)
  } catch {
    return false
  }
}

const hasNewTarget = (node: LorePlanNode) => node.targets.some((t) => t.state === 'new')

// 能不能勾 secret：只对要新建的目标起作用，导入过的要到记忆详情里改
export function secretSelectable(node: LorePlanNode): boolean {
  return hasNewTarget(node)
}

// 「不导入」对全部导入过的节点就是这次不同步
export const excludeLabel = (node: LorePlanNode) => (hasNewTarget(node) ? '不导入' : '这次不同步')

// 勾选按节点 uuid 记（重看计划时 URI 可能变了），发请求时换成现在的 URI。计划里已经没有的节点不发，
// 不起作用的 secret 也不发；同时勾了 secret 和不导入时只算不导入
export function selectionOf(
  plan: LoreImportPlan,
  secret: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): { secretUris: string[]; excludeUris: string[] } {
  const excludeUris = plan.nodes.filter((n) => excluded.has(n.uuid)).map((n) => n.uri)
  const secretUris = plan.nodes
    .filter((n) => secret.has(n.uuid) && !excluded.has(n.uuid) && secretSelectable(n))
    .map((n) => n.uri)
  return { secretUris, excludeUris }
}

// 勾选之后这次到底会动什么。计划是不带勾选的基准计划，服务端执行时按勾选重算，勾选只让写入变少，这里要和它算的一样
export interface SelectionEffects {
  // 这次会写的目标：节点没勾掉，而且是新建的，或者有要更新的同步项。导入过没变化的、Lore 里换了路径的、
  // 在 Kioku 里删除了的都不写
  create: number
  update: number
  // 这次会写、写进去之后会进启动上下文的目标（就是计划里的那些对象）：secret 不进。数量与徽章都看它
  boot: ReadonlySet<LorePlanTarget>
  bootNodes: number
  // 这次会写的节点的正文引用的凭据
  credentialRefs: string[]
  // 没勾掉的节点里还有没有要新建的人格层目标（已导入的、换了路径的都不算）。有才会在人格不存在时新建；
  // 没有时已有的人格照常用，不存在就没有人格可用：不设默认人格，新建的应用默认人格为空
  writesPersona: boolean
  // 还会动到的应用
  apps: LoreImportPlan['apps']
  appsGivenPersona: string[]
  appsOtherPersona: string[]
}

const underRuntime = (uri: string, runtime: string) =>
  uri === `core://agent/${runtime}` || uri.startsWith(`core://agent/${runtime}/`)

export function selectionEffects(
  plan: LoreImportPlan,
  secret: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): SelectionEffects {
  const updateKey = (source: string, uri: string) => JSON.stringify([source, uri])
  const updates = new Set(
    plan.sync.items.filter((i) => i.state === 'update').map((i) => updateKey(i.source, i.uri)),
  )
  const kept = plan.nodes.filter((n) => !excluded.has(n.uuid))
  const boot = new Set<LorePlanTarget>()
  const refs = new Set<string>()
  let create = 0
  let update = 0
  let bootNodes = 0
  for (const node of kept) {
    const written = node.targets.filter(
      (t) => t.state === 'new' || updates.has(updateKey(node.uri, t.uri)),
    )
    if (!written.length) continue
    create += written.filter((t) => t.state === 'new').length
    update += written.filter((t) => t.state !== 'new').length
    for (const ref of node.credentialRefs) refs.add(ref)
    // 新建的看这次勾没勾 secret；同步不改敏感级，要更新的看这个 URI 上的记忆现在是不是 secret
    const entering = written.filter(
      (t) =>
        t.boot &&
        !(t.state === 'new'
          ? secret.has(node.uuid)
          : t.current.some((c) => c.uri === t.uri && c.secret)),
    )
    for (const target of entering) boot.add(target)
    if (entering.length) bootNodes++
  }
  // 和服务端 planImport 循环结束后的过滤同一个规则：勾掉一个运行时下的全部节点，就不建它的应用，也不设它们的默认人格；
  // 计划里有映射却没有节点可勾的（已有的应用，节点都在映射之后被跳过了）不随勾选变；全部勾掉就什么都不动
  const apps =
    plan.nodes.length && !kept.length
      ? []
      : plan.apps.filter(({ runtime }) => {
          const nodes = plan.nodes.filter((n) => underRuntime(n.uri, runtime))
          return !nodes.length || nodes.some((n) => !excluded.has(n.uuid))
        })
  const slugs = new Set(apps.flatMap((m) => m.apps.map((a) => a.slug)))
  const writesPersona = kept.some((n) =>
    n.targets.some((t) => t.layer === 'persona' && t.state === 'new'),
  )
  const personaUsed = writesPersona || plan.persona.exists
  return {
    create,
    update,
    boot,
    bootNodes,
    credentialRefs: [...refs].sort(),
    writesPersona,
    apps,
    appsGivenPersona: personaUsed ? plan.appsGivenPersona.filter((slug) => slugs.has(slug)) : [],
    appsOtherPersona: personaUsed ? plan.appsOtherPersona.filter((slug) => slugs.has(slug)) : [],
  }
}

// 文件比已写入的数据旧时怎么提示。服务端按勾选之后的计划判断要不要确认，这里算的要和它一样：
// 还有要写的才要确认（confirm）；没有要写的不用确认，只说一声「Lore 里已经没有」可能只是文件旧（older）
export function staleNotice(
  plan: LoreImportPlan,
  effects: Pick<SelectionEffects, 'create' | 'update'>,
): 'confirm' | 'older' | null {
  if (!plan.dataTime || plan.exportedAt >= plan.dataTime) return null
  return plan.staleSince && effects.create + effects.update > 0 ? 'confirm' : 'older'
}

export const targetStateLabels: Record<LoreTargetState, string> = {
  new: '新建',
  imported: '已导入',
  moved: 'Lore 里换了路径',
}

const SYNC_CHANGE_LABELS: Record<LoreSyncChange, string> = {
  content: '正文',
  priority: 'priority',
  disclosure: 'disclosure',
  glossary: '关键词',
}

export interface SyncGroup {
  state: LoreSyncState | 'gone'
  title: string
  lines: string[]
}

const SYNC_TITLES: Record<Exclude<LoreSyncState, 'current'>, string> = {
  update: '按 Lore 更新',
  edited: '导入后在 Kioku 里改过或移动过，不同步（要跟上 Lore 就手动改）',
  moved:
    'Lore 里换了路径，不同步：移动可能改变层与可见范围，要手动移动（移动之后这条就只能手动更新）',
  deleted: '在 Kioku 里删除了，不同步',
  skipped: '这次的计划不导入这个节点，没有同步',
  unmapped: '这次的计划没有映射到它（例如换了人格，或者对应的应用不在了），没有同步',
  unreadable: '读不出来，没有同步',
}

// 同步差异：和命令行 --sync 打印的是同一份。已是最新的只给个数，其余每种列出来，没有的不出现
export function syncGroups(plan: LoreImportPlan): { current: number; groups: SyncGroup[] } {
  const of = (state: LoreSyncState) => plan.sync.items.filter((i) => i.state === state)
  const groups: SyncGroup[] = []
  const add = (state: SyncGroup['state'], title: string, lines: string[]) => {
    if (lines.length) groups.push({ state, title, lines })
  }
  add(
    'update',
    SYNC_TITLES.update,
    of('update').map((i) => `${i.uri}：${i.changes.map((c) => SYNC_CHANGE_LABELS[c]).join('、')}`),
  )
  add(
    'edited',
    SYNC_TITLES.edited,
    of('edited').map((i) => i.uri),
  )
  add(
    'moved',
    SYNC_TITLES.moved,
    of('moved').map((i) => `${i.uri} → ${i.target ?? ''}`),
  )
  add(
    'deleted',
    SYNC_TITLES.deleted,
    of('deleted').map((i) => i.uri),
  )
  add(
    'skipped',
    SYNC_TITLES.skipped,
    of('skipped').map((i) => `${i.uri}：${i.reason ?? ''}`),
  )
  add(
    'unmapped',
    SYNC_TITLES.unmapped,
    of('unmapped').map((i) => i.uri),
  )
  add(
    'unreadable',
    SYNC_TITLES.unreadable,
    of('unreadable').map((i) => `${i.uri}：${i.reason ?? ''}`),
  )
  add('gone', 'Lore 里已经没有这个节点，Kioku 里保留（要删就手动删）', plan.sync.goneFromLore)
  return { current: of('current').length, groups }
}

// 看计划时能筛的几种节点
export const NODE_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'new', label: '新建' },
  { value: 'imported', label: '已导入' },
  { value: 'moved', label: '换了路径' },
  { value: 'boot', label: '会进启动上下文' },
  { value: 'refs', label: '引用凭据' },
  { value: 'credential', label: '像凭据' },
] as const
export type NodeFilter = (typeof NODE_FILTERS)[number]['value']

export const looksLikeCredential = (node: LorePlanNode) =>
  node.credentialHints.path || node.credentialHints.content || node.credentialHints.extras

// boot 是不带勾选时的 selectionEffects 的结果：筛选不随勾选变，勾掉的节点不从列表里消失，还能勾回来
export function matchesFilter(
  node: LorePlanNode,
  filter: NodeFilter,
  boot: ReadonlySet<LorePlanTarget>,
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'boot':
      return node.targets.some((t) => boot.has(t))
    case 'refs':
      return node.credentialRefs.length > 0
    case 'credential':
      return looksLikeCredential(node)
    default:
      return node.targets.some((t) => t.state === filter)
  }
}

// 结果算不算全部做成：有失败的、这次要 secret 却还是明文的，都不能显示成成功
export function importProblems(result: {
  failed: unknown[]
  secretAlreadyImported: unknown[]
  sync: { failed: unknown[] }
}): boolean {
  return (
    result.failed.length > 0 ||
    result.secretAlreadyImported.length > 0 ||
    result.sync.failed.length > 0
  )
}

// 执行失败之后怎么办。
// changed：计划变了（409），什么都没写，要重看计划；
// partial：5xx（网关超时时请求可能已经到了服务端）与网络错误，可能写了一部分，要重看计划，已写入的会显示成已导入；
// refused：别的（429、400、403、413 这些）都是写入之前就拒绝了，看过的计划还算数，只显示错误的文字
export interface ApplyFailure {
  kind: 'changed' | 'partial' | 'refused'
  message: string
}

export function applyFailureOf(err: unknown): ApplyFailure {
  if (err instanceof ApiError) {
    if (err.status === 409) return { kind: 'changed', message: err.message }
    return { kind: err.status >= 500 ? 'partial' : 'refused', message: err.message }
  }
  if (err instanceof LoreFileError) return { kind: 'refused', message: err.message }
  return { kind: 'partial', message: '网络出错了' }
}

// 接着重看计划之后的说明（refused 不重看，用不到）：重看也失败时不能说已经重新算过。服务端报写到一半时自己说了可能写了一部分
export function applyFailureNotice({ kind, message }: ApplyFailure, replanned: boolean): string {
  const partly =
    kind === 'partial' && !message.includes('可能已写入一部分') ? '可能已经写入了一部分。' : ''
  if (!replanned) {
    return `${message}。${partly}接着重看计划也失败了：看下面的错误，处理之后点「看计划」，勾选还在。`
  }
  return kind === 'partial'
    ? `${message}。${partly}已经重新算过计划：已写入的显示成已导入，勾选还在，再确认一次就接着做。`
    : `${message}。已经重新算过计划，勾选还在。`
}
