import type { Layer, MemoryChildren, Sensitivity } from '@kioku/contracts'

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
  children?: MemoryTreeItem[]
  icon?: string
  [key: string]: unknown
}

export function lastSegment(uri: string): string {
  const path = uri.split('://')[1] ?? uri
  return path.split('/').pop() ?? path
}

// 把接口返回的一层子节点转成树节点；有下一级的先放一个「加载中」占位，展开时再替换。
// 这一级超过上限被截断时，末尾放一个说明，不让人以为已经列全
export function toTreeItems(
  result: MemoryChildren,
  icons: { folder: string; file: string },
): MemoryTreeItem[] {
  const items: MemoryTreeItem[] = result.children.map((child) => ({
    label: lastSegment(child.uri),
    uri: child.uri,
    exists: child.exists,
    loaded: child.childCount === 0,
    layer: child.layer,
    sensitivity: child.sensitivity,
    priority: child.priority,
    icon: child.childCount > 0 || !child.exists ? icons.folder : icons.file,
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
      label: `这一级太多，只显示了前 ${result.children.length} 个`,
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
