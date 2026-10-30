import {
  LORE_BACKUP_FORMAT,
  LORE_BACKUP_TABLES,
  LORE_UPLOAD_MAX_BYTES,
  type LoreBackupUpload,
  type LoreImportPlan,
  type LorePlanNode,
  type LoreSyncChange,
  type LoreSyncState,
  type LoreTargetState,
} from '@kioku/contracts'

import { formatBytes } from './backup'

// 从 Lore 导入时界面用的纯逻辑：裁剪导出文件、勾选换算成请求、计划的分组

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

export function matchesFilter(node: LorePlanNode, filter: NodeFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'boot':
      return node.targets.some((t) => t.boot)
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
