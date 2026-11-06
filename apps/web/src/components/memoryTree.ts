import {
  CURATED_LAYERS,
  LAYER_NAMES,
  type AppInfo,
  type CuratedLayer,
  type Layer,
  type MemoryChildren,
  type PersonaInfo,
  type Sensitivity,
} from '@kioku/contracts'

import { identifierOf } from '../coordinates'
import { personaRows } from '../personas'

// 记忆目录的一个节点。第一级是四个根（本人、应用、人格、通用），键就是归属的名字（user、app、persona、core）；
// 人格与应用的根下先列出各个人格、应用，键是它们的坐标开头（persona://<人格>、app://<应用>）；再往下是坐标的各级。
// children 为 undefined 表示叶子；为数组时可以展开，loaded 为 false 时展开才去加载
export type TreeNodeKind = 'root' | 'entity' | 'memory' | 'folder' | 'note'

export interface MemoryTreeItem {
  label: string
  uri: string
  kind: TreeNodeKind
  // 这一级本身有没有记忆；没有时是虚拟节点（位置），只能展开不能打开
  exists: boolean
  loaded: boolean
  // 这一级本身的记忆的归属、敏感级与 priority，树上标出来；虚拟节点为空。根与人格、应用只有归属
  layer?: Layer | null
  sensitivity?: Sensitivity | null
  priority?: number | null
  // 行尾的数字：下一级有几个
  count?: number
  // 人格或应用的 id 与一句说明（继承了谁）
  entityId?: string
  meta?: string
  children?: MemoryTreeItem[]
  [key: string]: unknown
}

// 打开或选中之前，下一级先放一个「加载中」占位，展开时再替换
const loadingRow = (key: string): MemoryTreeItem => ({
  label: '加载中……',
  uri: `${key}#loading`,
  kind: 'note',
  exists: false,
  loaded: true,
  disabled: true,
})

// 能选中的行：根、人格与应用、记忆；位置（虚拟节点）只能展开，「加载中」这类说明行不能选
export const selectable = (item: Pick<MemoryTreeItem, 'kind'>) =>
  item.kind === 'root' || item.kind === 'entity' || item.kind === 'memory'

// 地址里选中的不是记忆、而是目录里的一个根、人格或应用时写在 node 参数里：根写归属的名字，
// 人格与应用写 persona:<id>、app:<id>（标识只在目录里当键用；从别处链过来时手里有的是 id）
export type NodeRef =
  { kind: 'root'; layer: CuratedLayer } | { kind: 'persona' | 'app'; id: string }

export function parseNodeParam(value: string | null): NodeRef | null {
  if (!value) return null
  if ((CURATED_LAYERS as readonly string[]).includes(value)) {
    return { kind: 'root', layer: value as CuratedLayer }
  }
  const match = /^(persona|app):(.+)$/.exec(value)
  return match ? { kind: match[1] as 'persona' | 'app', id: match[2]! } : null
}

export const nodeParam = (ref: NodeRef) =>
  ref.kind === 'root' ? ref.layer : `${ref.kind}:${ref.id}`

// 地址里的 node 在目录里是哪一行：根就是它自己，人格与应用换成坐标开头。列表还没读到时为 null
export function nodeKeyOf(
  ref: NodeRef,
  personas: readonly Pick<PersonaInfo, 'id' | 'slug'>[] | undefined,
  apps: readonly Pick<AppInfo, 'id' | 'slug'>[] | undefined,
): string | null {
  if (ref.kind === 'root') return ref.layer
  const list = ref.kind === 'persona' ? personas : apps
  const slug = list?.find((entity) => entity.id === ref.id)?.slug
  return slug ? `${ref.kind}://${slug}` : null
}

// 目录里一行对应的 node 参数：根与人格、应用；记忆和位置没有
export function nodeOfItem(item: Pick<MemoryTreeItem, 'kind' | 'uri' | 'layer' | 'entityId'>) {
  if (item.kind === 'root') return item.uri
  if (item.kind === 'entity' && item.entityId) return `${item.layer}:${item.entityId}`
  return null
}

// 四个根，顺序和地层柱一致
export function rootItems(layers: readonly CuratedLayer[]): MemoryTreeItem[] {
  return layers.map((layer) => ({
    label: LAYER_NAMES[layer],
    uri: layer,
    kind: 'root' as const,
    exists: false,
    loaded: false,
    layer,
    children: [loadingRow(layer)],
  }))
}

// 人格或应用的根下面那一层：每个人格、应用一行，下面是它的坐标开头下的各级。
// 人格按继承关系排，被继承的在前，继承了谁写在行尾
export function entityItems(
  layer: 'persona' | 'app',
  list: readonly (PersonaInfo | AppInfo)[],
): MemoryTreeItem[] {
  const ordered =
    layer === 'persona'
      ? personaRows(list as PersonaInfo[]).map((row) => row.persona)
      : [...list].sort((a, b) => a.name.localeCompare(b.name))
  const nameOf = (id: string | null) =>
    id ? (list.find((entity) => entity.id === id)?.name ?? null) : null
  return ordered.map((entity) => {
    const parent = 'extendsId' in entity ? nameOf(entity.extendsId) : null
    const key = `${layer}://${entity.slug}`
    return {
      label: entity.name,
      uri: key,
      kind: 'entity' as const,
      exists: false,
      loaded: false,
      layer,
      entityId: entity.id,
      ...(parent ? { meta: `继承${parent}` } : {}),
      children: [loadingRow(key)],
    }
  })
}

// 把接口返回的一层子节点转成树节点：有记忆的写标题，位置写它在坐标里的那一段；有下一级的先放一个「加载中」占位。
// 这一级超过上限被截断时，末尾放一个说明，不让人以为已经列全
export function toTreeItems(result: MemoryChildren): MemoryTreeItem[] {
  const items: MemoryTreeItem[] = result.children.map((child) => ({
    label: child.exists ? child.title?.trim() || identifierOf(child.uri) : identifierOf(child.uri),
    uri: child.uri,
    kind: child.exists ? ('memory' as const) : ('folder' as const),
    exists: child.exists,
    loaded: child.childCount === 0,
    layer: child.layer,
    sensitivity: child.sensitivity,
    priority: child.priority,
    count: child.childCount,
    ...(child.childCount > 0 ? { children: [loadingRow(child.uri)] } : {}),
  }))
  if (result.truncated) {
    items.push({
      label: `此级条目过多，仅显示前 ${result.children.length} 个`,
      uri: `${result.children.at(-1)?.uri ?? ''}#more`,
      kind: 'note',
      exists: false,
      loaded: true,
      disabled: true,
    })
  }
  return items
}

// 新建或删除之后，需要重新加载的父级：根（归属的名字）或上一级。persona://<人格> 的父级是 persona 根
export function parentOf(uri: string): string {
  const [domain, path = ''] = uri.split('://')
  const segments = path.split('/')
  return segments.length <= 1 ? domain! : `${domain}://${segments.slice(0, -1).join('/')}`
}

// 树里的深度：根是 0，core://a 与 persona://<人格> 是 1
export function depthOf(key: string): number {
  const path = key.split('://')[1]
  return path === undefined ? 0 : path.split('/').length
}

// 展开到某个节点要经过的各级：根与每一级上层，不含节点自己；根自己的是它本身
export function ancestorsOf(uri: string): string[] {
  const ancestors: string[] = []
  for (let key = parentOf(uri); ; key = parentOf(key)) {
    ancestors.unshift(key)
    if (!key.includes('://')) return ancestors
  }
}

// 坐标：上一级退一级灰度，最后一段是这条记忆的标识
export function splitUri(uri: string): { parent: string; leaf: string } {
  const at = uri.lastIndexOf('/')
  return at < 0
    ? { parent: '', leaf: uri }
    : { parent: uri.slice(0, at + 1), leaf: uri.slice(at + 1) }
}

// 目录里一行的位置：第几行，以及画引线要知道的事。
// prefix 的每一项对应一层祖先，true 表示那一层还有后面的兄弟，这一行要画一条穿过去的竖线；
// last 表示这一行是同一级的最后一个，自己的竖线画到一半为止
export interface TreeRowPlace {
  index: number
  depth: number
  prefix: boolean[]
  last: boolean
  label: string
  // 「加载中」这类说明行：不能选中
  disabled: boolean
}

// 展开着的节点里每一行的位置。根没有引线，它的下一级才开始画
export function treeRowPlaces(
  items: readonly MemoryTreeItem[],
  expanded: readonly string[],
): Map<string, TreeRowPlace> {
  const open = new Set(expanded)
  const places = new Map<string, TreeRowPlace>()
  const walk = (level: readonly MemoryTreeItem[], depth: number, prefix: boolean[]) => {
    level.forEach((item, i) => {
      const last = i === level.length - 1
      places.set(item.uri, {
        index: places.size,
        depth,
        prefix,
        last,
        label: item.label,
        disabled: item.disabled === true,
      })
      if (item.children && open.has(item.uri)) {
        walk(item.children, depth + 1, depth === 0 ? [] : [...prefix, !last])
      }
    })
  }
  walk(items, 0, [])
  return places
}

// 一行要画的引线：祖先穿过去的竖线和自己这一级的竖线，最后一条带一小段横线连到这一行。
// 横向位置按层算：第一层的竖线在 14px，每深一层多 16px
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
  const at = current ? rows.findIndex(([uri]) => uri === current) : -1
  // 只有一个字时从下一行找，好在同样开头的行之间往下走；打了好几个字时当前行还符合就留在原地
  const from = needle.length === 1 ? at + 1 : Math.max(at, 0)
  for (let i = 0; i < rows.length; i++) {
    const [uri, place] = rows[(from + i) % rows.length]!
    if (place.label.toLowerCase().startsWith(needle)) return uri
  }
  return null
}

// 左键要跳到的上一级。展开着的行是收起（组件库做），根没有上一级。
// 虚拟滚动下上一级可能没渲染，组件库找不到它，所以按路径算
export function parentRow(
  places: ReadonlyMap<string, TreeRowPlace>,
  expanded: readonly string[],
  uri: string,
): string | null {
  const place = places.get(uri)
  if (!place || place.depth === 0 || expanded.includes(uri)) return null
  const parent = parentOf(uri)
  return places.has(parent) ? parent : null
}

// 窄屏上目录和详情只显示一个，切换之后原来有焦点的元素藏起来了，焦点会掉到 body。
// 打开一条时放到详情的标题，返回时放回原来那一行。宽屏两边都在，不用动
export function focusAfterSelect(
  narrow: boolean,
  uri: string | null,
  previous: string | null,
): { to: 'title' } | { to: 'row'; uri: string } | null {
  if (!narrow) return null
  if (uri) return { to: 'title' }
  return previous ? { to: 'row', uri: previous } : null
}
