import type { Layer, MemoryChildren, Sensitivity } from '@kioku/contracts'

// 读 domain 列表的查询选项。目录的加载在 serially 的队列里等这个结果，不能等重试，离线时也不能卡住。
// 查询会合并进行中的请求，先发起的那一处决定重试和网络模式，所以用到这个查询的地方都带上
export const DOMAINS_QUERY_OPTIONS = { retry: false, networkMode: 'always' } as const

// 记忆树的一个节点。children 为 undefined 表示叶子；为数组时可以展开，loaded 为 false 时展开才去加载
export interface MemoryTreeItem {
  label: string
  uri: string
  // 这一级路径本身有没有记忆；没有时是虚拟节点，只能展开不能打开
  exists: boolean
  loaded: boolean
  // 这一级本身的记忆的层、敏感级与 priority，树上标出来；虚拟节点为空
  layer?: Layer | null
  sensitivity?: Sensitivity | null
  priority?: number | null
  // 行尾的数字：domain 根是这个 domain 的记忆条数，其余是下一级有几个路径
  count?: number
  children?: MemoryTreeItem[]
  [key: string]: unknown
}

export function lastSegment(uri: string): string {
  const path = uri.split('://')[1] ?? uri
  return path.split('/').pop() ?? path
}

// 把接口返回的一层子节点转成树节点；有下一级的先放一个「加载中」占位，展开时再替换。
// 这一级超过上限被截断时，末尾放一个说明，不让人以为已经列全
export function toTreeItems(result: MemoryChildren): MemoryTreeItem[] {
  const items: MemoryTreeItem[] = result.children.map((child) => ({
    label: lastSegment(child.uri),
    uri: child.uri,
    exists: child.exists,
    loaded: child.childCount === 0,
    layer: child.layer,
    sensitivity: child.sensitivity,
    priority: child.priority,
    count: child.childCount,
    ...(child.childCount > 0
      ? {
          children: [
            {
              label: '加载中……',
              uri: `${child.uri}#loading`,
              exists: false,
              loaded: true,
              disabled: true,
            },
          ],
        }
      : {}),
  }))
  if (result.truncated) {
    items.push({
      label: `此级条目过多，仅显示前 ${result.children.length} 个`,
      uri: `${result.children.at(-1)?.uri ?? ''}#more`,
      exists: false,
      loaded: true,
      disabled: true,
    })
  }
  return items
}

// 新建或删除之后，需要重新加载的父级：domain 根或上一级路径
export function parentOf(uri: string): string {
  const [domain, path = ''] = uri.split('://')
  const segments = path.split('/')
  return segments.length <= 1 ? domain! : `${domain}://${segments.slice(0, -1).join('/')}`
}

// 树里的深度：domain 根是 0，core://a 是 1
export function depthOf(key: string): number {
  const path = key.split('://')[1]
  return path === undefined ? 0 : path.split('/').length
}

// 展开到某个节点要经过的各级：domain 根与每一级上层路径，不含节点自己
export function ancestorsOf(uri: string): string[] {
  const ancestors: string[] = []
  for (let key = parentOf(uri); ; key = parentOf(key)) {
    ancestors.unshift(key)
    if (!key.includes('://')) return ancestors
  }
}

// URI 是地址：上一级路径退一级灰度，最后一段是这条记忆的名字
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

// 展开着的节点里每一行的位置。domain 根没有引线，它的下一级才开始画
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

// 左键要跳到的上一级。展开着的行是收起（组件库做），domain 根没有上一级。
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
