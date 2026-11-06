import {
  CURATED_LAYERS,
  NAMESPACED_LAYERS,
  URI_PATTERN,
  type CuratedLayer,
  type Sensitivity,
} from '@kioku/contracts'

// 坐标（代码里叫 uri）的拆分与拼接：开头://位置/标识。开头就是归属，人格与应用的开头还带着人格或应用的标识，
// 位置是开头与标识之间的各级，标识是最后一段。格式由 contracts 的 URI_PATTERN 定，这里只拆，不校验

export interface Coordinate {
  layer: CuratedLayer
  // 人格或应用的标识；通用与本人为 null
  entity: string | null
  // 开头与标识之间的各级
  position: string[]
  identifier: string
}

const isCurated = (value: string): value is CuratedLayer =>
  (CURATED_LAYERS as readonly string[]).includes(value)
export const isNamespaced = (layer: CuratedLayer) =>
  (NAMESPACED_LAYERS as readonly string[]).includes(layer)

// 开头之后的各段；不是四种开头之一时为 null
function segmentsOf(uri: string): { layer: CuratedLayer; segments: string[] } | null {
  const at = uri.indexOf('://')
  if (at < 0) return null
  const head = uri.slice(0, at)
  if (!isCurated(head)) return null
  const rest = uri.slice(at + 3)
  return { layer: head, segments: rest ? rest.split('/') : [] }
}

// 这条坐标归哪一类；不是四种开头之一时为 null
export function layerOfUri(uri: string): CuratedLayer | null {
  return segmentsOf(uri)?.layer ?? null
}

export function parseCoordinate(uri: string): Coordinate | null {
  const parsed = segmentsOf(uri)
  if (!parsed) return null
  const { layer } = parsed
  const segments = [...parsed.segments]
  const entity = isNamespaced(layer) ? (segments.shift() ?? null) : null
  if (isNamespaced(layer) && !entity) return null
  const identifier = segments.pop()
  if (!identifier) return null
  return { layer, entity, position: segments, identifier }
}

// 坐标的开头：core://、user://、persona://<人格>/、app://<应用>/
export function coordinateHead(layer: CuratedLayer, entity: string | null): string {
  return isNamespaced(layer) ? `${layer}://${entity ?? ''}/` : `${layer}://`
}

export function formatCoordinate(c: Coordinate): string {
  return coordinateHead(c.layer, c.entity) + [...c.position, c.identifier].join('/')
}

// 坐标的最后一段
export function identifierOf(uri: string): string {
  const path = uri.split('://')[1] ?? uri
  return path.split('/').pop() ?? path
}

// 给人看的名字：标题，没有时（接口还没给标题的列表）退回标识
export function memoryTitle(memory: { uri: string; title?: string | null }): string {
  return memory.title?.trim() || identifierOf(memory.uri)
}

/* ———— 新建与移动的表单 ———— */

// 表单里的坐标：归属、人格或应用的标识、位置（用 / 分隔的各级，可以为空）与标识
export interface CoordinateDraft {
  layer: CuratedLayer
  entity: string | null
  position: string
  identifier: string
}

// 新建时每类归属默认的敏感级：本人不设公开，默认私密；应用默认内部；人格与通用默认公开
export const DEFAULT_SENSITIVITY: Record<CuratedLayer, Sensitivity> = {
  user: 'private',
  app: 'internal',
  persona: 'public',
  core: 'public',
}

const SEGMENT = /^[a-z0-9_-]{1,64}$/
// 坐标里开头之后最多 16 段，人格与应用的标识也算一段
const MAX_SEGMENTS = 16

export const positionSegments = (position: string) =>
  position
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)

// 拼成的坐标；还拼不出来（没选人格或应用、没填标识）时为 null
export function draftUri(draft: CoordinateDraft): string | null {
  if (isNamespaced(draft.layer) && !draft.entity) return null
  const identifier = draft.identifier.trim()
  if (!identifier) return null
  return formatCoordinate({
    layer: draft.layer,
    entity: isNamespaced(draft.layer) ? draft.entity : null,
    position: positionSegments(draft.position),
    identifier,
  })
}

// 表单还差什么：一次只说一件，按从上到下的顺序
export function draftProblem(draft: CoordinateDraft): string | null {
  if (draft.layer === 'persona' && !draft.entity) return '选择人格'
  if (draft.layer === 'app' && !draft.entity) return '选择应用'
  const segments = positionSegments(draft.position)
  if (segments.some((segment) => !SEGMENT.test(segment))) {
    return '位置的每一级只能用小写字母、数字、_ 或 -，最长 64 个字符'
  }
  const identifier = draft.identifier.trim()
  if (!identifier) return '填写标识'
  if (!SEGMENT.test(identifier)) return '标识只能用小写字母、数字、_ 或 -，最长 64 个字符'
  const count = segments.length + 1 + (isNamespaced(draft.layer) ? 1 : 0)
  if (count > MAX_SEGMENTS) return `坐标最多 ${MAX_SEGMENTS} 级，人格或应用的标识也算一级`
  const uri = draftUri(draft)
  return uri && URI_PATTERN.test(uri) ? null : '坐标格式错误'
}

// 从标题猜一个标识：只认英文字母、数字与 _、-，空格换成 _；中文标题猜不出来，要自己填
export function identifierFromTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 64)
}

// 从目录里选中的那一行（根、人格或应用、位置、记忆）带出新建的归属与位置。
// 记忆本身作为位置：新建的放在它下面一级
export function draftFromKey(key: string): Partial<CoordinateDraft> {
  const at = key.indexOf('://')
  if (at < 0) {
    return (CURATED_LAYERS as readonly string[]).includes(key) ? { layer: key as CuratedLayer } : {}
  }
  const head = key.slice(0, at)
  if (!(CURATED_LAYERS as readonly string[]).includes(head)) return {}
  const layer = head as CuratedLayer
  const segments = key
    .slice(at + 3)
    .split('/')
    .filter(Boolean)
  if (isNamespaced(layer)) {
    const [entity = null, ...position] = segments
    return { layer, entity, position: position.join('/') }
  }
  return { layer, position: segments.join('/') }
}

// 现有的坐标拆回表单：移动时从这里改起
export function draftFromUri(uri: string): CoordinateDraft | null {
  const c = parseCoordinate(uri)
  return c
    ? { layer: c.layer, entity: c.entity, position: c.position.join('/'), identifier: c.identifier }
    : null
}
