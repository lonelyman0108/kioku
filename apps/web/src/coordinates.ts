import { CURATED_LAYERS, NAMESPACED_LAYERS, type CuratedLayer } from '@kioku/contracts'

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
