import {
  SENSITIVITIES,
  STRATA_BANDS,
  sensitivityAllowed,
  type AccessCell,
  type CircleAccessMatrix,
  type CircleKind,
  type EntryKind,
  type KindCount,
  type LensKeyScopes,
  type Sensitivity,
  type StrataBand,
} from '@kioku/contracts'

import { bandLabels, scopesSummary, sensitivityLabels } from '../../labels'

// 地层编码的全部计算：色带表示形态与来源范围，纹理表示敏感级，纵向顺序固定。地层柱、窄柱、色块、岩芯与权限范围表格共用

export type TextureScale = 'lg' | 'sm'
export type StrataCounts = Record<StrataBand, Record<Sensitivity, number>>
export type KindAccessRow = CircleAccessMatrix['rows'][number]

export interface BandAccessRow {
  band: StrataBand
  cells: CircleAccessMatrix['rows'][number]['cells']
}

export interface StrataSelection {
  band: StrataBand | null
  sensitivity: Sensitivity | null
}

// 纵向顺序：自上而下为会话摘要、联系人事实、个人圈词条、共享客场圈词条、独立人格、主场圈正式词条
export const STACK: readonly StrataBand[] = STRATA_BANDS

// 来自对话的两类在最上方，以虚线与下面四类隔开
export const isConversationBand = (band: StrataBand) => band === 'episode' || band === 'fact'
export const isConversationKind = (kind: EntryKind) => kind === 'episode' || kind === 'fact'

export const bandHints: Record<StrataBand, string> = {
  episode: '所在的群或私聊，无会话上下文时仅限本接入实例的所属成员',
  fact: '记下它的群或私聊；启用拟人跨群识人时可在非隔离群间按需召回',
  personal: '个人记忆圈中的词条；关联客场时仅最高优先级且未限定场域的词条可穿透启动加载',
  'shared-away': '所关联共享客场记忆圈中的词条',
  persona: '独立人格设定条目，按设定键沿继承链覆盖',
  primary: '当前主场记忆圈中的正式词条',
}

export const entryKindHints: Record<EntryKind, string> = {
  entry: '主动整理保存的正式词条，支持多切面变体与双链',
  fact: '从群聊或私聊中抽取的联系人与群事实',
  episode: '按会话保留的近期讨论摘要，到期后自动清理',
}

export const sensitivityHints: Record<Sensitivity, string> = {
  public: '任何会话上下文可见',
  internal: '仅受信客户端与本人私聊提权上下文可见',
  private: '仅本机私密上下文可见',
  secret: '密文存储，不进召回，仅主场圈且通过场域锁可按短 ID 读取',
}

export function kindBandForCircle(
  kind: EntryKind,
  circle: { circleKind: CircleKind; isPrimary: boolean },
): StrataBand {
  if (kind === 'episode') return 'episode'
  if (kind === 'fact') return 'fact'
  if (circle.isPrimary) return 'primary'
  return circle.circleKind === 'personal' ? 'personal' : 'shared-away'
}

export function entryBand(
  entry: { kind: EntryKind; circleId?: string; circleKind?: CircleKind },
  currentCircle?: { id: string; kind: CircleKind } | null,
): StrataBand {
  if (entry.kind === 'episode') return 'episode'
  if (entry.kind === 'fact') return 'fact'
  if (currentCircle && entry.circleId && entry.circleId !== currentCircle.id) {
    return entry.circleKind === 'personal' ? 'personal' : 'shared-away'
  }
  return currentCircle?.kind === 'personal' || entry.circleKind === 'personal'
    ? 'personal'
    : 'primary'
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)

/* ———— 条数 ———— */

const emptyRow = (): Record<Sensitivity, number> => ({
  public: 0,
  internal: 0,
  private: 0,
  secret: 0,
})

export interface TallySlice {
  band: StrataBand
  sensitivity: Sensitivity
  count: number
}

export interface OverviewTallyInput {
  circleKind: CircleKind
  counts: readonly KindCount[]
  extractedCounts?: readonly KindCount[]
  personalCounts?: readonly KindCount[]
  awaySharedCounts?: readonly KindCount[]
  personaCount?: number
}

export function tallyCounts(input: readonly TallySlice[] | OverviewTallyInput): StrataCounts {
  const counts = Object.fromEntries(STRATA_BANDS.map((b) => [b, emptyRow()])) as StrataCounts
  if (Array.isArray(input)) {
    for (const row of input as readonly TallySlice[]) {
      counts[row.band][row.sensitivity] += row.count
    }
    return counts
  }
  const overview = input as OverviewTallyInput
  const entryBandKey: StrataBand = overview.circleKind === 'personal' ? 'personal' : 'primary'
  for (const row of overview.counts) {
    const target: StrataBand =
      row.kind === 'episode' ? 'episode' : row.kind === 'fact' ? 'fact' : entryBandKey
    counts[target][row.sensitivity] += row.count
  }
  for (const row of overview.extractedCounts ?? []) {
    if (row.kind === 'episode' || row.kind === 'fact') {
      counts[row.kind][row.sensitivity] += row.count
    }
  }
  for (const row of overview.personalCounts ?? []) {
    if (row.kind === 'entry') counts.personal[row.sensitivity] += row.count
  }
  for (const row of overview.awaySharedCounts ?? []) {
    if (row.kind === 'entry') counts['shared-away'][row.sensitivity] += row.count
  }
  if (overview.personaCount) {
    counts.persona.public += overview.personaCount
  }
  return counts
}

export const bandTotal = (counts: StrataCounts, band: StrataBand) =>
  sum(SENSITIVITIES.map((s) => counts[band][s]))

export const curatedTotal = (counts: StrataCounts) =>
  sum(STACK.filter((b) => !isConversationBand(b)).map((b) => bandTotal(counts, b)))

export const conversationTotal = (counts: StrataCounts) =>
  sum(STACK.filter(isConversationBand).map((b) => bandTotal(counts, b)))

export const sensitivityTotal = (counts: StrataCounts, sensitivity: Sensitivity) =>
  sum(STACK.filter((b) => !isConversationBand(b)).map((b) => counts[b][sensitivity]))

export const filteredTotal = (
  counts: StrataCounts,
  band: StrataBand | null,
  sensitivity: Sensitivity | null,
) =>
  sum(
    (band ? [band] : STACK).flatMap((b) =>
      (sensitivity ? [sensitivity] : SENSITIVITIES).map((s) => counts[b][s]),
    ),
  )

/* ———— 几何 ———— */

export const FULL_COLUMN_MIN_WIDTH = 520

export function columnSize(
  viewport: { width: number; height: number },
  available = viewport.width,
) {
  if (viewport.width < 640 || available < FULL_COLUMN_MIN_WIDTH) {
    return { width: 92, height: 470, compact: true }
  }
  const height = viewport.width < 1024 ? 470 : Math.max(440, Math.min(680, viewport.height - 288))
  return { width: 216, height, compact: false }
}

export interface Band {
  band: StrataBand
  y: number
  h: number
}

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

export function stackBands(counts: StrataCounts | null, height: number, gap = 0, min = 1): Band[] {
  const weights = STACK.map((b) => (counts ? Math.sqrt(Math.max(bandTotal(counts, b), 1)) : 1))
  const heights = allot(weights, Math.max(0, Math.floor(height - gap)), min)
  let start = 0
  return STACK.map((band, i) => {
    const item = { band, y: start + (isConversationBand(band) ? 0 : gap), h: heights[i]! }
    start += item.h
    return item
  })
}

export interface Segment {
  sensitivity: Sensitivity
  count: number
  x: number
  w: number
}

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
} as const

export const DASHES: Record<TextureScale, { on: number; off: number }> = {
  lg: { on: 6, off: 4 },
  sm: { on: 3, off: 2 },
}
export const dashId = (band: StrataBand, scale: TextureScale) => `strata-dash-${band}-${scale}`

export function textureId(sensitivity: Sensitivity, scale: TextureScale): string | null {
  if (sensitivity === 'internal') return TEXTURES.dots[scale]
  if (sensitivity === 'private') return TEXTURES.lines[scale]
  return null
}

const bandFill = (band: StrataBand | null) =>
  band ? `var(--layer-${band})` : 'var(--strata-neutral)'

export function paintCell(
  band: StrataBand | null,
  sensitivity: Sensitivity,
  box: Box,
  scale: TextureScale = 'lg',
): PaintRect[] {
  if (sensitivity === 'secret') return [{ ...box, fill: 'var(--strata-solid)' }]
  const rects: PaintRect[] = [{ ...box, fill: bandFill(band) }]
  const texture = textureId(sensitivity, scale)
  if (texture) rects.push({ ...box, fill: `url(#${texture})` })
  return rects
}

export function paintSwatch(
  band: StrataBand | null,
  sensitivity: Sensitivity | null,
  width: number,
  height: number,
): PaintRect[] {
  const box = { x: 0, y: 0, width, height }
  if (!sensitivity) return [{ ...box, fill: bandFill(band) }]
  const rects = paintCell(band, sensitivity, box, 'sm')
  if (sensitivity === 'secret' && band) {
    rects.push({ ...box, width: Math.max(4, Math.round(width / 4)), fill: bandFill(band) })
  }
  return rects
}

export function swatchText(band: StrataBand | null, sensitivity: Sensitivity | null): string {
  return [band && bandLabels[band], sensitivity && sensitivityLabels[sensitivity]]
    .filter(Boolean)
    .join(' ')
}

/* ———— 权限范围 ———— */

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
  'explicit-write': '按短 ID 读取且可写',
  'explicit-extract': '按短 ID 读取且抽取写入',
  explicit: '仅按短 ID 读取',
  write: '仅写入',
  extract: '仅抽取写入',
  none: '无权限',
}

export const accessKindShortLabels: Record<AccessKind, string> = {
  'read-write': '读写',
  'read-extract': '读 · 抽取',
  read: '只读',
  'explicit-write': '按短 ID 读写',
  'explicit-extract': '按短 ID 读 · 抽取',
  explicit: '按短 ID 读',
  write: '只写',
  extract: '仅抽取',
  none: '—',
}

export function bandSensitivityAllowed(band: StrataBand, sensitivity: Sensitivity): boolean {
  if (band === 'episode' && sensitivity === 'secret') return false
  return true
}

export function accessCellText(
  band: StrataBand,
  sensitivity: Sensitivity,
  kind: AccessKind,
): string {
  const place = `${bandLabels[band]} ${sensitivityLabels[sensitivity]}`
  return bandSensitivityAllowed(band, sensitivity)
    ? `${place}：${accessKindLabels[kind]}`
    : `${place}：不适用，${bandLabels[band]}不设${sensitivityLabels[sensitivity]}`
}

export function kindAccessCellText(
  entryKind: EntryKind,
  circleKind: CircleKind,
  sensitivity: Sensitivity,
  kind: AccessKind,
  label: string,
): string {
  const place = `${label} ${sensitivityLabels[sensitivity]}`
  return sensitivityAllowed(circleKind, entryKind, sensitivity)
    ? `${place}：${accessKindLabels[kind]}`
    : `${place}：不适用，${label}不设${sensitivityLabels[sensitivity]}`
}

const ACCESS_KINDS: Record<AccessCell['read'], Record<'write' | 'extract' | 'none', AccessKind>> = {
  recall: { write: 'read-write', extract: 'read-extract', none: 'read' },
  explicit: { write: 'explicit-write', extract: 'explicit-extract', none: 'explicit' },
  none: { write: 'write', extract: 'extract', none: 'none' },
}

export function accessKind(band: StrataBand, cell: AccessCell): AccessKind {
  const writing = !cell.write ? 'none' : isConversationBand(band) ? 'extract' : 'write'
  return ACCESS_KINDS[cell.read][writing]
}

export function kindAccessKind(entryKind: EntryKind, cell: AccessCell): AccessKind {
  const writing = !cell.write ? 'none' : isConversationKind(entryKind) ? 'extract' : 'write'
  return ACCESS_KINDS[cell.read][writing]
}

export const accessFill = (band: StrataBand) => `var(--access-${band})`

const ACCESS_BAR_RATIO = 0.2
export const ACCESS_BAR_PERCENT = { y: '80%', height: '20%' }
export function accessBar(y: number, height: number): { y: number; height: number } {
  const bar = Math.min(height, Math.max(2, Math.round(height * ACCESS_BAR_RATIO)))
  return { y: y + height - bar, height: bar }
}

function aboveBar(box: Box, bar: { y: number | string }): Box {
  const height = typeof bar.y === 'number' && typeof box.y === 'number' ? bar.y - box.y : bar.y
  return { ...box, height }
}

export function paintAccess(
  band: StrataBand,
  sensitivity: Sensitivity,
  kind: AccessKind,
  box: Box,
  bar: { y: number | string; height: number | string },
  scale: TextureScale = 'lg',
): PaintRect[] {
  const full = accessFill(band)
  const solid = { ...box, fill: 'var(--strata-explicit)' }
  const writeBar = { ...box, ...bar, fill: full }
  const extractBar = { ...box, ...bar, fill: `url(#${dashId(band, scale)})` }
  const recall = (strong: boolean, textureBox: Box = box) => {
    const tint = `color-mix(in srgb, ${full} var(--strata-tint), var(--ui-bg))`
    const rects: PaintRect[] = [{ ...box, fill: strong ? full : tint }]
    const texture = textureId(sensitivity, scale)
    if (texture)
      rects.push({ ...textureBox, fill: `url(#${texture})`, ...(strong ? {} : { opacity: 0.55 }) })
    return rects
  }
  switch (kind) {
    case 'read-write':
      return recall(true)
    case 'read-extract':
      return [...recall(false, aboveBar(box, bar)), extractBar]
    case 'read':
      return recall(false)
    case 'explicit-write':
      return [solid, writeBar]
    case 'explicit-extract':
      return [solid, extractBar]
    case 'explicit':
      return [solid]
    case 'write':
      return [writeBar]
    case 'extract':
      return [extractBar]
    case 'none':
      return []
  }
}

const READ_RANK: Record<AccessCell['read'], number> = { none: 0, explicit: 1, recall: 2 }

function mergeCells(
  a: CircleAccessMatrix['rows'][number]['cells'],
  b: CircleAccessMatrix['rows'][number]['cells'],
): CircleAccessMatrix['rows'][number]['cells'] {
  return SENSITIVITIES.map((sensitivity) => {
    const ca = a.find((c) => c.sensitivity === sensitivity)
    const cb = b.find((c) => c.sensitivity === sensitivity)
    if (!ca) return cb ?? { sensitivity, read: 'none' as const, write: false }
    if (!cb) return ca
    return {
      sensitivity,
      read: READ_RANK[ca.read] >= READ_RANK[cb.read] ? ca.read : cb.read,
      write: ca.write || cb.write,
    }
  })
}

const emptyBandCells = (): CircleAccessMatrix['rows'][number]['cells'] =>
  SENSITIVITIES.map((sensitivity) => ({ sensitivity, read: 'none' as const, write: false }))

export function matrixToBandRows(circles: readonly CircleAccessMatrix[]): BandAccessRow[] {
  const buckets = new Map<StrataBand, CircleAccessMatrix['rows'][number]['cells']>()
  const put = (band: StrataBand, cells: CircleAccessMatrix['rows'][number]['cells']) => {
    const prev = buckets.get(band)
    buckets.set(band, prev ? mergeCells(prev, cells) : cells)
  }
  for (const circle of circles) {
    for (const row of circle.rows) {
      put(kindBandForCircle(row.kind, circle), row.cells)
    }
  }
  return STACK.map((band) => ({ band, cells: buckets.get(band) ?? emptyBandCells() }))
}

export function issuedScopeRows(
  scopes: LensKeyScopes,
  circleKind: CircleKind = 'shared',
): KindAccessRow[] {
  const limit = SENSITIVITIES.indexOf(scopes.maxSensitivity)
  const order: readonly EntryKind[] = ['episode', 'fact', 'entry']
  return order.map((kind) => ({
    kind,
    cells: SENSITIVITIES.map((sensitivity, rank) => {
      const reachable = rank <= limit && sensitivityAllowed(circleKind, kind, sensitivity)
      const readable = reachable && scopes.readKinds.includes(kind)
      return {
        sensitivity,
        read: !readable
          ? ('none' as const)
          : sensitivity === 'secret'
            ? ('explicit' as const)
            : ('recall' as const),
        write: reachable && scopes.writeKinds.includes(kind),
      }
    }),
  }))
}

export function issuedBandRows(
  scopes: LensKeyScopes,
  options: {
    primaryKind?: CircleKind
    linkedKinds?: readonly CircleKind[]
    hasPersona?: boolean
  } = {},
): BandAccessRow[] {
  const primaryKind = options.primaryKind ?? 'shared'
  const limit = SENSITIVITIES.indexOf(scopes.maxSensitivity)
  const cellsFor = (kind: EntryKind, circleKind: CircleKind, writeAllowed: boolean) =>
    SENSITIVITIES.map((sensitivity, rank) => {
      const reachable = rank <= limit && sensitivityAllowed(circleKind, kind, sensitivity)
      const readable = reachable && scopes.readKinds.includes(kind)
      return {
        sensitivity,
        read: !readable
          ? ('none' as const)
          : sensitivity === 'secret'
            ? ('explicit' as const)
            : ('recall' as const),
        write: writeAllowed && reachable && scopes.writeKinds.includes(kind),
      }
    })
  const hasPersonalAway = (options.linkedKinds ?? []).includes('personal')
  const hasSharedAway = (options.linkedKinds ?? []).includes('shared')
  return STACK.map((band) => {
    switch (band) {
      case 'episode':
        return { band, cells: cellsFor('episode', primaryKind, true) }
      case 'fact':
        return { band, cells: cellsFor('fact', primaryKind, true) }
      case 'personal':
        return {
          band,
          cells: hasPersonalAway ? cellsFor('entry', 'personal', false) : emptyBandCells(),
        }
      case 'shared-away':
        return {
          band,
          cells: hasSharedAway ? cellsFor('entry', 'shared', false) : emptyBandCells(),
        }
      case 'persona':
        return {
          band,
          cells:
            options.hasPersona || scopes.admin
              ? SENSITIVITIES.map((sensitivity, rank) => ({
                  sensitivity,
                  read:
                    rank <= limit && sensitivity !== 'secret'
                      ? ('recall' as const)
                      : ('none' as const),
                  write: scopes.admin && rank <= limit && sensitivity !== 'secret',
                }))
              : emptyBandCells(),
        }
      case 'primary':
        return { band, cells: cellsFor('entry', primaryKind, true) }
    }
  })
}

export function deepestColumn(
  rows: readonly { cells: readonly { read: AccessCell['read']; write: boolean }[] }[],
): number {
  let deepest = -1
  for (const row of rows) {
    row.cells.forEach((cell, i) => {
      if ((cell.read !== 'none' || cell.write) && i > deepest) deepest = i
    })
  }
  return deepest
}

const LEGEND_ORDER: AccessKind[] = [
  'read-write',
  'read-extract',
  'read',
  'explicit-write',
  'explicit-extract',
  'explicit',
  'write',
  'extract',
  'none',
]

export function presentKinds(
  circles: readonly CircleAccessMatrix[] | readonly BandAccessRow[],
): AccessKind[] {
  const present = new Set<AccessKind>(['read-write', 'read', 'none'])
  if (!circles.length) return LEGEND_ORDER.filter((k) => present.has(k))
  if ('rows' in circles[0]!) {
    for (const circle of circles as readonly CircleAccessMatrix[]) {
      for (const row of circle.rows) {
        for (const cell of row.cells) present.add(kindAccessKind(row.kind, cell))
      }
    }
  } else {
    for (const row of circles as readonly BandAccessRow[]) {
      for (const cell of row.cells) present.add(accessKind(row.band, cell))
    }
  }
  return LEGEND_ORDER.filter((kind) => present.has(kind))
}

export function orderRows(rows: readonly BandAccessRow[]): BandAccessRow[] {
  return STACK.flatMap((band) => rows.filter((row) => row.band === band))
}

const KIND_ORDER: readonly EntryKind[] = ['episode', 'fact', 'entry']
export function orderKindRows(rows: readonly KindAccessRow[]): KindAccessRow[] {
  return KIND_ORDER.flatMap((kind) => rows.filter((row) => row.kind === kind))
}

export interface CoreCell extends Box {
  band: StrataBand
  sensitivity: Sensitivity
  kind: AccessKind
  barY: number
  barHeight: number
}

export function coreCells(
  rows: readonly BandAccessRow[],
  width: number,
  height: number,
  counts: StrataCounts | null = null,
  gap = 3,
  minBand = 6,
): { bands: Band[]; columns: number[]; cells: CoreCell[] } {
  const bands = stackBands(counts, height, gap, minBand)
  const columns = [0, 1, 2, 3, 4].map((i) => Math.round((i / 4) * width))
  const cells: CoreCell[] = []
  for (const band of bands) {
    const row = rows.find((r) => r.band === band.band)
    if (!row) continue
    SENSITIVITIES.forEach((sensitivity, i) => {
      const cell = row.cells.find((c) => c.sensitivity === sensitivity)
      if (!cell) return
      const bar = accessBar(band.y, band.h)
      cells.push({
        band: band.band,
        sensitivity,
        kind: accessKind(band.band, cell),
        x: columns[i]!,
        y: band.y,
        width: columns[i + 1]! - columns[i]!,
        height: band.h,
        barY: bar.y,
        barHeight: bar.height,
      })
    })
  }
  return { bands, columns, cells }
}

export function coreName({
  label,
  rows,
  scopes,
  revoked,
}: {
  label?: string | undefined
  rows?: readonly BandAccessRow[] | null
  scopes?: LensKeyScopes | null
  revoked?: boolean
}): string {
  if (revoked) return label ? `${label}，已吊销，没有权限` : '已吊销，没有权限'
  if (rows) return label ? `${label}的权限范围` : '当前会话上下文的权限范围'
  if (scopes) return `${label ? `${label}，` : ''}签发范围：${scopesSummary(scopes)}`
  return label ? `${label}，暂无权限数据` : '暂无权限数据'
}

export function coreMark(
  model: { bands: readonly Band[]; columns: readonly number[] },
  bandKey: StrataBand,
  sensitivity: Sensitivity | null,
): Box | null {
  const band = model.bands.find((b) => b.band === bandKey)
  if (!band) return null
  const column = sensitivity ? SENSITIVITIES.indexOf(sensitivity) : 0
  const left = model.columns[column]!
  const right = sensitivity ? model.columns[column + 1]! : model.columns[model.columns.length - 1]!
  return { x: left + 0.5, y: band.y + 0.5, width: right - left - 1, height: band.h - 1 }
}
