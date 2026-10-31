import {
  LAYERS,
  SENSITIVITIES,
  type AccessCell,
  type KeyAccessMatrix,
  type KeyScopes,
  type Layer,
  type LayerCount,
  type Sensitivity,
} from '@kioku/contracts'

import { layerLabels, sensitivityLabels } from '../../labels'

// 地层编码的全部计算：颜色表示层，纹理表示敏感级，纵向顺序固定。地层柱、窄柱、色块、岩芯、矩阵都从这里取

export type TextureScale = 'lg' | 'sm'
export type StrataCounts = Record<Layer, Record<Sensitivity, number>>
export type AccessRow = KeyAccessMatrix['contexts'][number]['rows'][number]

// 地层柱上选中或悬停的位置：一层、一个敏感级，或者一层里的一段
export interface StrataSelection {
  layer: Layer | null
  sensitivity: Sensitivity | null
}

// 纵向顺序：情节在上，基础在下
export const STACK: readonly Layer[] = [
  'episode',
  'subject',
  'private',
  'owner',
  'app',
  'persona',
  'base',
]

// 联系人和情节两层来自对话，和前五层隔开，边框用虚线
export const isConversationLayer = (layer: Layer) => layer === 'subject' || layer === 'episode'

// 只放提示层的一句话说明
export const layerHints: Record<Layer, string> = {
  base: '通用准则，全空间共享',
  persona: '人格设定，可继承',
  app: '某个应用独有',
  owner: '本人的习惯与偏好',
  private: '本人的私人事务',
  subject: '从对话中记下的人和群',
  episode: '会话摘要，到期清除',
}

export const sensitivityHints: Record<Sensitivity, string> = {
  public: '任何上下文可见',
  internal: '仅受信应用与上下文',
  private: '仅本人的私密上下文',
  secret: '加密存储，不进召回，仅可按 URI 读取',
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)

/* ———— 条数 ———— */

const emptyRow = (): Record<Sensitivity, number> => ({
  public: 0,
  internal: 0,
  private: 0,
  secret: 0,
})

export function tallyCounts(rows: readonly LayerCount[]): StrataCounts {
  const counts = Object.fromEntries(LAYERS.map((l) => [l, emptyRow()])) as StrataCounts
  for (const row of rows) counts[row.layer][row.sensitivity] += row.count
  return counts
}

export const layerTotal = (counts: StrataCounts, layer: Layer) =>
  sum(SENSITIVITIES.map((s) => counts[layer][s]))

// 记忆的条数不含来自对话的两层，后者单独说
export const curatedTotal = (counts: StrataCounts) =>
  sum(STACK.filter((l) => !isConversationLayer(l)).map((l) => layerTotal(counts, l)))

export const conversationTotal = (counts: StrataCounts) =>
  sum(STACK.filter(isConversationLayer).map((l) => layerTotal(counts, l)))

export const sensitivityTotal = (counts: StrataCounts, sensitivity: Sensitivity) =>
  sum(STACK.filter((l) => !isConversationLayer(l)).map((l) => counts[l][sensitivity]))

/* ———— 几何 ———— */

export interface Band {
  layer: Layer
  y: number
  h: number
}

// 按权重把 total 分成整数份，合起来正好是 total。每份至少 min，放不下时 min 退到平分的大小。
// 按比例算不够 min 的先固定，剩下的由其他份按权重分；固定一份可能让别的也不够，循环到稳定
function allot(weights: readonly number[], total: number, min: number): number[] {
  const floor = Math.min(min, Math.floor(total / weights.length))
  const indexes = weights.map((_, i) => i)
  const fixed = new Set<number>()
  let unit = 0
  for (;;) {
    const free = indexes.filter((i) => !fixed.has(i))
    unit = free.length ? (total - fixed.size * floor) / sum(free.map((i) => weights[i]!)) : 0
    const tooSmall = free.filter((i) => weights[i]! * unit < floor)
    if (!tooSmall.length) break
    tooSmall.forEach((i) => fixed.add(i))
  }
  const exact = weights.map((weight, i) => (fixed.has(i) ? floor : weight * unit))
  // 先取整，余下的给小数部分最大的那几份
  const whole = exact.map(Math.floor)
  const order = exact
    .map((v, i) => ({ i, rest: v - Math.floor(v) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (let left = total - sum(whole), k = 0; left > 0; left--, k++) {
    const target = order[k % order.length]!.i
    whole[target] = whole[target]! + 1
  }
  return whole
}

// 带高按条数的平方根分配，小层也读得清。没有条数时等高（岩芯脱离数据时用）。
// 每条带至少 min 高，否则一层很大时小层取整成 0 就消失了，要放文字的带也会挤在一起。
// 来自对话的两层在上，和下面五层之间留 gap
export function stackBands(counts: StrataCounts | null, height: number, gap = 0, min = 1): Band[] {
  const weights = STACK.map((l) => (counts ? Math.sqrt(Math.max(layerTotal(counts, l), 1)) : 1))
  const heights = allot(weights, Math.max(0, Math.floor(height - gap)), min)
  let start = 0
  return STACK.map((layer, i) => {
    const band = { layer, y: start + (isConversationLayer(layer) ? 0 : gap), h: heights[i]! }
    start += band.h
    return band
  })
}

export interface Segment {
  sensitivity: Sensitivity
  count: number
  x: number
  w: number
}

// 带内按条数分段，0 条的不画。很小的段也留 min 的宽度，从别的段里匀出来；结果都是整数像素，合起来正好是 width
export function segments(row: Record<Sensitivity, number>, width: number, min = 1): Segment[] {
  const present = SENSITIVITIES.filter((s) => row[s] > 0)
  if (!present.length || width <= 0) return []
  const widths = allot(
    present.map((s) => row[s]),
    width,
    min,
  )
  let x = 0
  return present.map((sensitivity, i) => {
    const w = widths[i]!
    const segment = { sensitivity, count: row[sensitivity], x, w }
    x += w
    return segment
  })
}

/* ———— 上色 ———— */

export interface PaintRect {
  x: number | string
  y: number | string
  width: number | string
  height: number | string
  fill: string
  opacity?: number
}

export interface Box {
  x: number | string
  y: number | string
  width: number | string
  height: number | string
}

export const TEXTURES = {
  dots: { lg: 'strata-dots-lg', sm: 'strata-dots-sm' },
  lines: { lg: 'strata-lines-lg', sm: 'strata-lines-sm' },
  // 压在满色的条上，挖出虚线的缺口
  gaps: { lg: 'strata-gaps-lg', sm: 'strata-gaps-sm' },
} as const

// 公开无纹理，内部圆点，私密斜线；机密是实心，也没有纹理
export function textureId(sensitivity: Sensitivity, scale: TextureScale): string | null {
  if (sensitivity === 'internal') return TEXTURES.dots[scale]
  if (sensitivity === 'private') return TEXTURES.lines[scale]
  return null
}

const layerFill = (layer: Layer | null) =>
  layer ? `var(--layer-${layer})` : 'var(--strata-neutral)'

// 一块区域的画法：层色打底，上面叠敏感级的纹理；没有层时（图例）用中性底色
export function paintCell(
  layer: Layer | null,
  sensitivity: Sensitivity,
  box: Box,
  scale: TextureScale = 'lg',
): PaintRect[] {
  if (sensitivity === 'secret') return [{ ...box, fill: 'var(--strata-solid)' }]
  const rects: PaintRect[] = [{ ...box, fill: layerFill(layer) }]
  const texture = textureId(sensitivity, scale)
  if (texture) rects.push({ ...box, fill: `url(#${texture})` })
  return rects
}

// 小色块：机密是实心深色，左边留一条层色，不然看不出是哪一层。没有敏感级时只画层色
export function paintSwatch(
  layer: Layer | null,
  sensitivity: Sensitivity | null,
  width: number,
  height: number,
): PaintRect[] {
  const box = { x: 0, y: 0, width, height }
  if (!sensitivity) return [{ ...box, fill: layerFill(layer) }]
  const rects = paintCell(layer, sensitivity, box, 'sm')
  if (sensitivity === 'secret' && layer) {
    rects.push({ ...box, width: Math.max(4, Math.round(width / 4)), fill: layerFill(layer) })
  }
  return rects
}

export function swatchText(layer: Layer | null, sensitivity: Sensitivity | null): string {
  return [layer && layerLabels[layer], sensitivity && sensitivityLabels[sensitivity]]
    .filter(Boolean)
    .join(' ')
}

/* ———— 权限范围 ———— */

// 一格的权限：怎么读（召回、按 URI、读不到）和怎么写的组合。
// 对象层与情节层的写指对话抽取能写进去，不能按 URI 直接写，和普通的写是两回事，每种读法都单独一种
export type AccessKind =
  | 'read-write'
  | 'read-extract'
  | 'read'
  | 'explicit-write'
  | 'explicit-extract'
  | 'explicit'
  | 'write'
  | 'extract'
  | 'none'

export const accessKindLabels: Record<AccessKind, string> = {
  'read-write': '读写',
  'read-extract': '读取且抽取写入',
  read: '只读',
  'explicit-write': '按 URI 读取且可写',
  'explicit-extract': '按 URI 读取且抽取写入',
  explicit: '仅按 URI 读取',
  write: '仅写入',
  extract: '仅抽取写入',
  none: '无权限',
}

const ACCESS_KINDS: Record<AccessCell['read'], Record<'write' | 'extract' | 'none', AccessKind>> = {
  recall: { write: 'read-write', extract: 'read-extract', none: 'read' },
  explicit: { write: 'explicit-write', extract: 'explicit-extract', none: 'explicit' },
  none: { write: 'write', extract: 'extract', none: 'none' },
}

export function accessKind(layer: Layer, cell: AccessCell): AccessKind {
  const writing = !cell.write ? 'none' : isConversationLayer(layer) ? 'extract' : 'write'
  return ACCESS_KINDS[cell.read][writing]
}

// 同一套编码表示权限，岩芯上没有文字，每种都要一眼能分开。
// 底色说怎么读：满色能读能写，淡色读得到但不能直接写，实心只能按 URI 读取，空白读不到。
// 下沿的条说怎么写：满色的条能写，虚线的条只能靠抽取写入。读写已经是满色，不再加条
export function paintAccess(
  layer: Layer,
  sensitivity: Sensitivity,
  kind: AccessKind,
  box: Box,
  bar: { y: number | string; height: number | string },
  scale: TextureScale = 'lg',
): PaintRect[] {
  const full = layerFill(layer)
  const solid = { ...box, fill: 'var(--strata-explicit)' }
  const writeBar = { ...box, ...bar, fill: full }
  const extractBar = [writeBar, { ...box, ...bar, fill: `url(#${TEXTURES.gaps[scale]})` }]
  const recall = (strong: boolean) => {
    const tint = `color-mix(in srgb, ${full} var(--strata-tint), var(--ui-bg))`
    const rects: PaintRect[] = [{ ...box, fill: strong ? full : tint }]
    const texture = textureId(sensitivity, scale)
    if (texture)
      rects.push({ ...box, fill: `url(#${texture})`, ...(strong ? {} : { opacity: 0.55 }) })
    return rects
  }
  switch (kind) {
    case 'read-write':
      return recall(true)
    case 'read-extract':
      return [...recall(false), ...extractBar]
    case 'read':
      return recall(false)
    case 'explicit-write':
      return [solid, writeBar]
    case 'explicit-extract':
      return [solid, ...extractBar]
    case 'explicit':
      return [solid]
    case 'write':
      return [writeBar]
    case 'extract':
      return extractBar
    case 'none':
      return []
  }
}

// Key 的签发范围换算成格子，只看层和敏感级；机密只能按 URI 读取，要上限到机密。
// 这不是实际权限：人格、应用和会话上下文的规则都没算（没有人格的应用写不了人格层，这里仍画成可写），
// 实际碰得到哪些格子看权限范围矩阵，由服务端的 accessMatrix 给
export function issuedScopeRows(scopes: KeyScopes): AccessRow[] {
  const limit = SENSITIVITIES.indexOf(scopes.maxSensitivity)
  return LAYERS.map((layer) => ({
    layer,
    cells: SENSITIVITIES.map((sensitivity, rank) => {
      const reachable = rank <= limit
      const readable = reachable && scopes.readLayers.includes(layer)
      return {
        sensitivity,
        read: !readable
          ? ('none' as const)
          : sensitivity === 'secret'
            ? ('explicit' as const)
            : ('recall' as const),
        write: reachable && scopes.writeLayers.includes(layer),
      }
    }),
  }))
}

// 这份权限碰得到的最高敏感级（下标），一格都碰不到时是 -1。矩阵在这里画一条边界线
export function deepestColumn(rows: readonly AccessRow[]): number {
  let deepest = -1
  for (const row of rows) {
    row.cells.forEach((cell, i) => {
      if ((cell.read !== 'none' || cell.write) && i > deepest) deepest = i
    })
  }
  return deepest
}

// 接口不保证顺序，统一成地层柱的顺序
export function orderRows(rows: readonly AccessRow[]): AccessRow[] {
  return STACK.flatMap((layer) => rows.filter((row) => row.layer === layer))
}

// 岩芯每一格的位置：纵向和地层柱同一套带，横向四列是四个敏感级
export interface CoreCell extends Box {
  layer: Layer
  sensitivity: Sensitivity
  kind: AccessKind
  barY: number
  barHeight: number
}

export function coreCells(
  rows: readonly AccessRow[],
  width: number,
  height: number,
  counts: StrataCounts | null = null,
  gap = 3,
  // 带之间的分隔线占 1px，下沿的条至少 2px，再留出看得见底色的地方
  minBand = 6,
): { bands: Band[]; columns: number[]; cells: CoreCell[] } {
  const bands = stackBands(counts, height, gap, minBand)
  const columns = [0, 1, 2, 3, 4].map((i) => Math.round((i / 4) * width))
  const cells: CoreCell[] = []
  for (const band of bands) {
    const row = rows.find((r) => r.layer === band.layer)
    if (!row) continue
    SENSITIVITIES.forEach((sensitivity, i) => {
      const cell = row.cells.find((c) => c.sensitivity === sensitivity)
      if (!cell) return
      // 条不能比格子高，否则画到相邻的带上
      const barHeight = Math.min(band.h, Math.max(2, Math.round(band.h * 0.3)))
      cells.push({
        layer: band.layer,
        sensitivity,
        kind: accessKind(band.layer, cell),
        x: columns[i]!,
        y: band.y,
        width: columns[i + 1]! - columns[i]!,
        height: band.h,
        barY: band.y + band.h - barHeight,
        barHeight,
      })
    })
  }
  return { bands, columns, cells }
}
