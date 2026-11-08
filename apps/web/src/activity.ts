import {
  ACTIVITY_ACTOR_PATTERN,
  ACTIVITY_FIELDS,
  ACTIVITY_MAX_SPAN_DAYS,
  ACTIVITY_TYPES,
  CURATED_LAYERS,
  type ActivityFacets,
  type ActivityFieldChange,
  type ActivityItem,
} from '@kioku/contracts'
import type { LocationQuery, LocationQueryRaw } from 'vue-router'

import { layerLabels, sensitivityLabels } from './labels'
import { localDate } from './time'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// 本地日期（YYYY-MM-DD）与 Date 互换，都按本地时间的零点
export function parseDay(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return localDate(d) === key ? d : null
}
export const addDays = (key: string, n: number) => {
  const d = parseDay(key)!
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n))
}
// 两个本地日期之间差几天（to − from）
export const daysBetween = (from: string, to: string) =>
  Math.round((parseDay(to)!.getTime() - parseDay(from)!.getTime()) / 86_400_000)

// 一天的小标题：11 月 8 日 · 周日 · 今天；不是今年的写上年份
export function dayHeading(key: string, today: string): string {
  const d = parseDay(key)!
  const year = key.slice(0, 4) === today.slice(0, 4) ? '' : `${d.getFullYear()} 年 `
  const rel = key === today ? '今天' : key === addDays(today, -1) ? '昨天' : ''
  return [`${year}${d.getMonth() + 1} 月 ${d.getDate()} 日`, `周${WEEKDAYS[d.getDay()]}`, rel]
    .filter(Boolean)
    .join(' · ')
}

// ---- 地址里的状态 ----

export const QUICK_RANGES = ['today', '7', '30', 'all'] as const
export type QuickRange = (typeof QUICK_RANGES)[number]
export const quickRangeLabels: Record<QuickRange, string> = {
  today: '今天',
  7: '近 7 天',
  30: '近 30 天',
  all: '全部',
}
// 没写范围时看近 30 天
export const DEFAULT_RANGE: QuickRange = '30'

export const FILTER_GROUPS = ['actor', 'type', 'layer', 'field'] as const
export type FilterGroup = (typeof FILTER_GROUPS)[number]
// 地址里每一组取消勾选的值写在哪个参数里
const OFF_PARAMS: Record<FilterGroup, string> = {
  actor: 'noActor',
  type: 'noType',
  layer: 'noLayer',
  field: 'noField',
}
// 每一组可选的值：操作者随数据变（从筛选计数来），其余三组是固定的
export const FIXED_OPTIONS = {
  type: ACTIVITY_TYPES as readonly string[],
  layer: CURATED_LAYERS as readonly string[],
  field: ACTIVITY_FIELDS as readonly string[],
}

export interface ActivityState {
  // 快捷范围；自选了日期时为 null，范围在 from、to（本地日期，两头都含）
  range: QuickRange | null
  from: string | null
  to: string | null
  // 每一组取消勾选的值
  off: Record<FilterGroup, string[]>
  q: string
  // 选中的事件
  event: number | null
}

// 地址里最多留这么多个取消勾选的操作者，和接口的上限一致
export const MAX_ACTOR_FILTER = 50

const DAY = /^\d{4}-\d{2}-\d{2}$/
const one = (v: LocationQuery[string] | undefined) => (typeof v === 'string' ? v : null)
const list = (v: LocationQuery[string] | undefined) => {
  const s = one(v)
  return s ? [...new Set(s.split(',').filter(Boolean))] : []
}

// 从地址里读出状态；写错的、不认识的值丢掉，退回默认
export function parseState(query: LocationQuery, today: string): ActivityState {
  const range = QUICK_RANGES.find((r) => r === one(query.range)) ?? null
  let from = one(query.from)
  let to = one(query.to)
  const custom = !range && !!from && !!to && DAY.test(from) && DAY.test(to)
  if (custom && parseDay(from!) && parseDay(to!)) {
    if (from! > to!) [from, to] = [to, from]
    if (to! > today) to = today
    if (from! > to!) from = to
    if (daysBetween(from!, to!) >= ACTIVITY_MAX_SPAN_DAYS) {
      from = addDays(to!, -(ACTIVITY_MAX_SPAN_DAYS - 1))
    }
  } else {
    from = null
    to = null
  }
  const off = {} as Record<FilterGroup, string[]>
  for (const g of FILTER_GROUPS) {
    const values = list(query[OFF_PARAMS[g]])
    // 写法不对的操作者、超出上限的丢掉：接口遇到一个就整个请求 400
    off[g] =
      g === 'actor'
        ? values.filter((v) => ACTIVITY_ACTOR_PATTERN.test(v)).slice(0, MAX_ACTOR_FILTER)
        : values.filter((v) => FIXED_OPTIONS[g].includes(v))
  }
  const event = one(query.event)
  const selected = !!event && /^\d{1,15}$/.test(event) && Number(event) > 0
  return {
    range: from ? null : (range ?? DEFAULT_RANGE),
    from,
    to,
    off,
    q: (one(query.q) ?? '').trim().slice(0, 100),
    event: selected ? Number(event) : null,
  }
}

// 状态写回地址：默认值不写
export function stateQuery(state: ActivityState): LocationQueryRaw {
  const query: LocationQueryRaw = {}
  if (state.from && state.to) {
    query.from = state.from
    query.to = state.to
  } else if (state.range && state.range !== DEFAULT_RANGE) {
    query.range = state.range
  }
  for (const g of FILTER_GROUPS) {
    if (state.off[g].length) query[OFF_PARAMS[g]] = state.off[g].join(',')
  }
  if (state.q) query.q = state.q
  if (state.event !== null) query.event = String(state.event)
  return query
}

// 选中的日期范围（本地日期，两头都含）；全部时为 null
export function selectedDays(
  state: ActivityState,
  today: string,
): { from: string; to: string } | null {
  if (state.from && state.to) return { from: state.from, to: state.to }
  switch (state.range) {
    case 'today':
      return { from: today, to: today }
    case '7':
      return { from: addDays(today, -6), to: today }
    case 'all':
      return null
    default:
      return { from: addDays(today, -29), to: today }
  }
}

// 本地日期范围换成接口要的时间：不早于第一天的零点，早于最后一天的下一个零点
// utc 时按 UTC 的零点（服务端认不出浏览器的时区、退回按 UTC 分天时）
export function dayBounds(
  days: { from: string; to: string },
  utc = false,
): { from: string; to: string } {
  const start = (key: string) =>
    utc ? new Date(`${key}T00:00:00.000Z`).toISOString() : parseDay(key)!.toISOString()
  return { from: start(days.from), to: start(addDays(days.to, 1)) }
}

// 一个时间落在哪一天：平时按本地日期，utc 时按 UTC 日期
export const dayKeyOf = (iso: string, utc = false) =>
  utc ? new Date(iso).toISOString().slice(0, 10) : localDate(new Date(iso))

// 交给接口的筛选（多个值用逗号连起来）。操作与归属全部取消勾选时（只会是手写的地址）当作没有筛选：
// 界面上这两组至少留一项。字段可以全部取消：没有改动字段的事件（新建、删除等）不受字段筛选影响，
// 全部取消就只剩它们
export type FilterQuery = Record<string, string | undefined>
export function filterQuery(state: ActivityState, today: string, utc = false): FilterQuery {
  const query: FilterQuery = {}
  const days = selectedDays(state, today)
  if (days) Object.assign(query, dayBounds(days, utc))
  for (const g of ['type', 'layer', 'field'] as const) {
    if (!state.off[g].length) continue
    const kept = FIXED_OPTIONS[g].filter((v) => !state.off[g].includes(v))
    if (g === 'field') query.field = [...kept, 'none'].join(',')
    else if (kept.length) query[g] = kept.join(',')
  }
  if (state.off.actor.length) query.exceptActor = state.off.actor.join(',')
  if (state.q) query.q = state.q
  return query
}

// ---- 按天分组与折叠 ----

export interface ActivityRow {
  item: ActivityItem
  // 同一个人接着改同一条记忆的后几次，折叠在这一行下面
  more: ActivityItem[]
}
export interface ActivityDay {
  key: string
  heading: string
  rows: ActivityRow[]
  // 这一天读到的条数（翻页之前可能不全）
  loaded: number
}

// 能并在一起的两次改动：都是修改，同一个操作者，同一条记忆
const foldable = (a: ActivityItem, b: ActivityItem) =>
  a.type === 'update' &&
  b.type === 'update' &&
  a.actorKey === b.actorKey &&
  a.memoryId === b.memoryId

// 按本地日期分组，同一天里同一个操作者接着修改同一条记忆折叠成一行。接口按时间倒序给，
// 翻页时后面的页接在同一天后面，组的先后和里面的先后都不动
export function groupByDay(
  items: readonly ActivityItem[],
  today: string,
  utc = false,
): ActivityDay[] {
  const days: ActivityDay[] = []
  for (const item of items) {
    const key = dayKeyOf(item.createdAt, utc)
    let day = days.at(-1)
    if (day?.key !== key) {
      day = { key, heading: dayHeading(key, today), rows: [], loaded: 0 }
      days.push(day)
    }
    day.loaded++
    const last = day.rows.at(-1)
    if (last && foldable(last.item, item)) last.more.push(item)
    else day.rows.push({ item, more: [] })
  }
  return days
}

// ---- 日历 ----

export interface CalendarCell {
  key: string
  date: number
  inMonth: boolean
  future: boolean
  today: boolean
  selected: boolean
  count: number
  heat: 0 | 1 | 2 | 3 | 4
}

// 每格的深浅按条数分四档
export const heatOf = (n: number): CalendarCell['heat'] =>
  n <= 0 ? 0 : n <= 1 ? 1 : n <= 3 ? 2 : n <= 8 ? 3 : 4

// 一个月的格子，从周一开始，补满前后的几天；最后一行全是下个月的不要
export function monthGrid(
  month: string,
  today: string,
  counts: ReadonlyMap<string, number>,
  selected: { from: string; to: string } | null,
): CalendarCell[] {
  const first = parseDay(`${month}-01`)!
  const lead = (first.getDay() + 6) % 7
  const cells: CalendarCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), 1 - lead + i)
    const inMonth = d.getMonth() === first.getMonth()
    // 一行从下个月开始时，这一行与后面的都不要（2027 年 2 月从周一开始、只有 28 天，第五行就是下个月）
    if (i % 7 === 0 && !inMonth && d > first) break
    const key = localDate(d)
    const count = counts.get(key) ?? 0
    cells.push({
      key,
      date: d.getDate(),
      inMonth,
      future: key > today,
      today: key === today,
      selected: key <= today && (!selected || (key >= selected.from && key <= selected.to)),
      count,
      heat: heatOf(count),
    })
  }
  return cells
}

// 日历上一个月的范围（本地日期，两头都含），按天计数用
export function gridDays(month: string): { from: string; to: string } {
  const cells = monthGrid(month, '9999-12-31', new Map(), null)
  return { from: cells[0]!.key, to: cells.at(-1)!.key }
}

export const monthOf = (key: string) => key.slice(0, 7)
export function shiftMonth(month: string, n: number): string {
  const d = parseDay(`${month}-01`)!
  return localDate(new Date(d.getFullYear(), d.getMonth() + n, 1)).slice(0, 7)
}

// 点日历上的一天：只看这一天；按住 Shift 时从上次点的那天选到这一天，跨度超出上限时从这一天往回截
export function pickDay(
  day: string,
  anchor: string | null,
  extend: boolean,
): { from: string; to: string } {
  if (!extend || !anchor) return { from: day, to: day }
  const [from, to] = anchor < day ? [anchor, day] : [day, anchor]
  if (daysBetween(from, to) >= ACTIVITY_MAX_SPAN_DAYS) {
    return day === to
      ? { from: addDays(to, -(ACTIVITY_MAX_SPAN_DAYS - 1)), to }
      : { from, to: addDays(from, ACTIVITY_MAX_SPAN_DAYS - 1) }
  }
  return { from, to }
}

// 柱条最多这么多根：全部时历史很长，只留最近的
const MAX_SPARK_DAYS = ACTIVITY_MAX_SPAN_DAYS * 2

// 每天的柱条：范围内每一天一根，没有改动的是 0。全部时从最早有改动的那天算起，最多留最近的 MAX_SPARK_DAYS 天
export function sparkDays(
  days: { from: string; to: string } | null,
  counts: readonly { day: string; count: number }[],
  today: string,
): { day: string; count: number }[] {
  const last = days?.to ?? today
  const earliest = addDays(last, -(MAX_SPARK_DAYS - 1))
  const start = days?.from ?? counts[0]?.day ?? today
  const first = start < earliest ? earliest : start
  const byDay = new Map(counts.map((c) => [c.day, c.count]))
  const out: { day: string; count: number }[] = []
  for (let d = first; d <= last; d = addDays(d, 1)) {
    out.push({ day: d, count: byDay.get(d) ?? 0 })
  }
  return out
}

// ---- 筛选的选项 ----

export interface FacetOption {
  key: string
  count: number
}
// 每一组的选项与条数：固定的几组列全，没有条数的为 0；操作者只列有条数的，加上取消勾选了、这次没出现的
export function facetOptions(
  facets: ActivityFacets | undefined,
  off: Record<FilterGroup, string[]>,
): Record<FilterGroup, FacetOption[]> {
  const counts = (pairs: [string, number][]) => new Map(pairs)
  const type = counts(facets?.types.map((t) => [t.type, t.count]) ?? [])
  const layer = counts(facets?.layers.map((l) => [l.layer, l.count]) ?? [])
  const field = counts(facets?.fields.map((f) => [f.field, f.count]) ?? [])
  const actors: FacetOption[] = facets?.actors.map((a) => ({ key: a.key, count: a.count })) ?? []
  for (const key of off.actor)
    if (!actors.some((a) => a.key === key)) actors.push({ key, count: 0 })
  return {
    actor: actors,
    // 操作只列出现过的和取消勾选了的：十几种里平时只用到几种
    type: ACTIVITY_TYPES.filter((t) => type.has(t) || off.type.includes(t)).map((key) => ({
      key,
      count: type.get(key) ?? 0,
    })),
    layer: CURATED_LAYERS.map((key) => ({ key, count: layer.get(key) ?? 0 })),
    field: ACTIVITY_FIELDS.map((key) => ({ key, count: field.get(key) ?? 0 })),
  }
}

// 勾选或取消一项之后这一组取消勾选的值；不改时返回 null：
// - 会把当前列出来的选项全部取消（allowEmpty 为假）：操作只列出现过的，把看得到的几项全取消，列表注定是空的。
//   操作、归属、操作者是这样；字段可以全部取消（只剩没有改动字段的事件），传 allowEmpty
// - 取消勾选的个数超出 max：地址与接口都只收这么多（操作者的 MAX_ACTOR_FILTER），界面在筛选那里写明已达上限
export function toggleOff(
  listed: readonly FacetOption[],
  off: readonly string[],
  key: string,
  on: boolean,
  options: { allowEmpty?: boolean; max?: number } = {},
): string[] | null {
  const next = new Set(off)
  if (on) next.delete(key)
  else next.add(key)
  if (on) return [...next]
  if (options.max !== undefined && next.size > options.max) return null
  if (!options.allowEmpty && listed.length && listed.every((o) => next.has(o.key))) return null
  return [...next]
}

// ---- 改动的标签 ----

// 坐标改了哪里：去掉前后共同的开头几级，写成 …/a → …/b；开头（归属）就不同时写全
function uriChange(before: string, after: string): string {
  const a = before.split('/')
  const b = after.split('/')
  let same = 0
  while (same < a.length - 1 && same < b.length - 1 && a[same] === b[same]) same++
  // 前两段是「core:」和空串，再往后才是共同的位置
  if (same <= 2) return `${before} → ${after}`
  return `…/${a.slice(same).join('/')} → …/${b.slice(same).join('/')}`
}
const shortDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}

// 表格里一个字段改了什么，写成很短的一段：正文 +2 −1、优先级 1 → 0、标题改名
export function changeSummary(change: ActivityFieldChange): string {
  switch (change.field) {
    case 'content':
      if (change.added === null || change.removed === null) return ''
      return [change.added && `+${change.added}`, change.removed && `−${change.removed}`]
        .filter(Boolean)
        .join(' ')
    case 'glossary': {
      const words = (sign: string, list: string[]) =>
        list.length === 1 ? `${sign}${list[0]}` : list.length ? `${sign}${list.length}` : ''
      return [words('+', change.added), words('−', change.removed)].filter(Boolean).join(' ')
    }
    case 'priority':
      return `${change.before} → ${change.after}`
    case 'layer':
      return `${layerLabels[change.before]} → ${layerLabels[change.after]}`
    case 'sensitivity':
      return `${sensitivityLabels[change.before]} → ${sensitivityLabels[change.after]}`
    case 'uri':
      return change.before && change.after ? uriChange(change.before, change.after) : ''
    case 'validTo':
      if (!change.after) return '长期有效'
      return change.before ? `改为 ${shortDate(change.after)}` : `至 ${shortDate(change.after)}`
    case 'title':
      return '改名'
    case 'disclosure':
      return !change.before ? '新增' : !change.after ? '清除' : '改写'
  }
}
