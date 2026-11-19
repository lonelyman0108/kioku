import type {
  BrowseGroupBy,
  CircleKind,
  EntryBrowseResponse,
  EntryKind,
  Sensitivity,
  StrataBand,
} from '@kioku/contracts'

import { entryBand } from './strata/strata'

// 记忆浏览目录的节点：第一级为按选定维度分出来的组，第二级为各词条。
// 同一词条有多个主题或切面时可能出现在多个组里，因此 UTree 行键使用 item:<groupKey>:<shortId>
export type TreeNodeKind = 'group' | 'entry' | 'note'

export const GROUP_BY_OPTIONS: { value: BrowseGroupBy; label: string }[] = [
  { value: 'topic', label: '主题' },
  { value: 'realm', label: '场域' },
  { value: 'env', label: '环境' },
  { value: 'runtime', label: '客户端' },
  { value: 'project', label: '项目' },
  { value: 'kind', label: '类型' },
  { value: 'circle', label: '记忆圈' },
]

export interface MemoryTreeItem {
  key: string
  label: string
  kind: TreeNodeKind
  shortId?: string
  circleId?: string
  circleSlug?: string | null
  band?: StrataBand | null
  entryKind?: EntryKind | null
  sensitivity?: Sensitivity | null
  priority?: number | null
  variantCount?: number | null
  groupKey?: string
  count?: number
  disabled?: boolean
  children?: MemoryTreeItem[]
  [key: string]: unknown
}

export const groupNodeKey = (groupKey: string) => `group:${groupKey}`
export const entryNodeKey = (groupKey: string, shortId: string) => `item:${groupKey}:${shortId}`

export const selectable = (item: Pick<MemoryTreeItem, 'kind'>) => item.kind === 'entry'

// 把动态分组浏览接口的响应转成树节点
export function buildBrowseTree(
  response: EntryBrowseResponse,
  currentCircle: { id: string; kind: CircleKind } | null,
  circleKinds?: ReadonlyMap<string, CircleKind>,
): MemoryTreeItem[] {
  const items: MemoryTreeItem[] = response.groups.map((group) => {
    const children: MemoryTreeItem[] = group.items.map((item) => {
      const circleKind =
        item.circleId === currentCircle?.id
          ? currentCircle.kind
          : (circleKinds?.get(item.circleId) ??
            (item.circleSlug === 'personal' ? 'personal' : 'shared'))
      const band = entryBand(
        { kind: item.kind, circleId: item.circleId, circleKind },
        currentCircle,
      )
      return {
        key: entryNodeKey(group.key, item.shortId),
        label: item.title,
        kind: 'entry',
        shortId: item.shortId,
        circleId: item.circleId,
        circleSlug: item.circleSlug,
        band,
        entryKind: item.kind,
        sensitivity: item.sensitivity,
        priority: item.priority,
        variantCount: item.variantCount,
      }
    })
    return {
      key: groupNodeKey(group.key),
      groupKey: group.key,
      label: group.label,
      kind: 'group',
      count: group.count,
      children,
    }
  })
  if (response.truncated) {
    items.push({
      key: 'note:truncated',
      label: '条目过多，仅显示前部分结果',
      kind: 'note',
      disabled: true,
    })
  }
  return items
}

// 在树里找短 ID 对应的第一条（或优先匹配的已选行键）及其所属分组键
export function keysForShortId(
  items: readonly MemoryTreeItem[],
  shortId: string,
  preferredKey?: string | null,
): { groupKey: string; itemKey: string; item: MemoryTreeItem } | null {
  let first: { groupKey: string; itemKey: string; item: MemoryTreeItem } | null = null
  for (const group of items) {
    if (group.kind !== 'group' || !group.children) continue
    for (const child of group.children) {
      if (child.kind !== 'entry' || child.shortId !== shortId) continue
      const match = { groupKey: group.key, itemKey: child.key, item: child }
      if (preferredKey && child.key === preferredKey) return match
      first ??= match
    }
  }
  return first
}

export function findTreeItem(
  items: readonly MemoryTreeItem[] | undefined,
  key: string,
): MemoryTreeItem | undefined {
  for (const item of items ?? []) {
    if (item.key === key) return item
    const hit = findTreeItem(item.children, key)
    if (hit) return hit
  }
  return undefined
}

// 目录里一行的位置：第几行，以及画引线要知道的事。
export interface TreeRowPlace {
  index: number
  depth: number
  prefix: boolean[]
  last: boolean
  label: string
  parentKey: string | null
  disabled: boolean
}

// 展开着的节点里每一行的位置。分组没有引线，它的下一级词条才开始画
export function treeRowPlaces(
  items: readonly MemoryTreeItem[],
  expanded: readonly string[],
): Map<string, TreeRowPlace> {
  const open = new Set(expanded)
  const places = new Map<string, TreeRowPlace>()
  const walk = (
    level: readonly MemoryTreeItem[],
    depth: number,
    prefix: boolean[],
    parentKey: string | null,
  ) => {
    level.forEach((item, i) => {
      const last = i === level.length - 1
      places.set(item.key, {
        index: places.size,
        depth,
        prefix,
        last,
        label: item.label,
        parentKey,
        disabled: item.disabled === true,
      })
      if (item.children && open.has(item.key)) {
        walk(item.children, depth + 1, depth === 0 ? [] : [...prefix, !last], item.key)
      }
    })
  }
  walk(items, 0, [], null)
  return places
}

// 一行要画的引线：祖先穿过去的竖线和自己这一级的竖线，最后一条带一小段横线连到这一行
export function guideLines(
  place: Pick<TreeRowPlace, 'depth' | 'prefix' | 'last'>,
): { left: number; end: boolean; tick: boolean }[] {
  const x = (level: number) => 14 + (level - 1) * 16
  const lines = place.prefix.flatMap((has, i) =>
    has ? [{ left: x(i + 1), end: false, tick: false }] : [],
  )
  if (place.depth > 0) lines.push({ left: x(place.depth), end: place.last, tick: true })
  return lines
}

// 打字跳转：下一个名字以这些字开头的行。同一个字连着按时在以它开头的行之间循环
export function typeaheadMatch(
  places: ReadonlyMap<string, TreeRowPlace>,
  search: string,
  current: string | null,
): string | null {
  const rows = [...places].filter(([, place]) => !place.disabled)
  if (!rows.length || !search) return null
  const repeated = [...search].every((char) => char === search[0])
  const needle = (repeated ? search[0]! : search).toLowerCase()
  const at = current ? rows.findIndex(([key]) => key === current) : -1
  const from = needle.length === 1 ? at + 1 : Math.max(at, 0)
  for (let i = 0; i < rows.length; i++) {
    const [key, place] = rows[(from + i) % rows.length]!
    if (place.label.toLowerCase().startsWith(needle)) return key
  }
  return null
}

// 左键要跳到的上一级。展开着的行由组件库收起，顶层分组没有上一级
export function parentRow(
  places: ReadonlyMap<string, TreeRowPlace>,
  expanded: readonly string[],
  key: string,
): string | null {
  const place = places.get(key)
  if (!place || place.depth === 0 || expanded.includes(key)) return null
  return place.parentKey && places.has(place.parentKey) ? place.parentKey : null
}

// 窄屏上目录和详情只显示一个，切换之后原来有焦点的元素藏起来了，焦点会掉到 body。
// 打开一条时放到详情的标题，返回时放回原来那一行
export function focusAfterSelect(
  narrow: boolean,
  shortId: string | null,
  previous: string | null,
): { to: 'title' } | { to: 'row'; shortId: string } | null {
  if (!narrow) return null
  if (shortId) return { to: 'title' }
  return previous ? { to: 'row', shortId: previous } : null
}
