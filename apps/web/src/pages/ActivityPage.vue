<script setup lang="ts">
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  FILTER_GROUPS,
  FIXED_OPTIONS,
  QUICK_RANGES,
  dayBounds,
  facetOptions,
  filterQuery,
  gridDays,
  groupByDay,
  monthOf,
  parseState,
  pickDay,
  quickRangeLabels,
  selectedDays,
  sparkDays,
  stateQuery,
  type ActivityState,
  type FilterGroup,
  type QuickRange,
} from '../activity'
import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import ActivityCalendar from '../components/ActivityCalendar.vue'
import ActivityDetail from '../components/ActivityDetail.vue'
import ActivityEntry, { type EntryLayout } from '../components/ActivityEntry.vue'
import ActivityFilters from '../components/ActivityFilters.vue'
import Hint from '../components/Hint.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import { useDebounced } from '../composables/useDebounced'
import { useNow } from '../composables/useNow'
import { icons } from '../icons'
import {
  activityActorKind,
  activityActorName,
  changeLabels,
  eventLabel,
  layerLabels,
} from '../labels'
import { localDate } from '../time'

const route = useRoute()
const router = useRouter()
const spaceId = computed(() => String(route.params.spaceId))
// 页面开过零点时「今天」跟着变
const now = useNow()
const today = computed(() => localDate(now.value))
// 浏览器的时区：按天计数按它分天，和表格里按本地日期分组一致
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

// 日期范围、筛选、关键字与选中的事件都在地址里，后退前进能还原
const state = computed(() => parseState(route.query, today.value))
function update(patch: Partial<ActivityState>, replace = false) {
  const next = stateQuery({ ...state.value, ...patch })
  const to = { query: next }
  return replace ? router.replace(to) : router.push(to)
}

// 关键字：输入停一会儿才写进地址；地址变了（后退）时输入框跟着变
const qInput = ref(state.value.q)
const qDebounced = useDebounced(qInput)
watch(qDebounced, (q) => {
  if (q !== state.value.q) void update({ q: q.slice(0, 100), event: null, memory: null }, true)
})
watch(
  () => state.value.q,
  (q) => {
    if (q !== qInput.value.trim()) qInput.value = q
  },
)

const days = computed(() => selectedDays(state.value, today.value))
const filter = computed(() => filterQuery(state.value, today.value))

// 筛选计数：每组的条数，以及合计
const facets = useQuery({
  queryKey: computed(() => ['activity-facets', spaceId.value, filter.value]),
  queryFn: () => api.activityFacets(spaceId.value, filter.value),
  placeholderData: keepPreviousData,
})
const options = computed(() => facetOptions(facets.data.value, state.value.off))

// 列表：一页一页往后加载；看不到的记忆的改动服务端已经滤掉
const activity = useInfiniteQuery({
  queryKey: computed(() => ['activity', spaceId.value, filter.value]),
  queryFn: ({ pageParam }) => api.activity(spaceId.value, filter.value, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})
const items = computed(() => activity.data.value?.pages.flatMap((page) => page.items) ?? [])
const groups = computed(() => groupByDay(items.value, today.value))

// 每天的条数：选中范围内的给柱条与每天的小标题，日历上那个月的给格子
const rangeDays = useQuery({
  queryKey: computed(() => ['activity-days', spaceId.value, filter.value, tz]),
  queryFn: () => api.activityDays(spaceId.value, filter.value, tz),
  placeholderData: keepPreviousData,
})
const month = ref(monthOf(days.value?.to ?? today.value))
const calendarFilter = computed(() => ({
  ...filter.value,
  ...dayBounds(gridDays(month.value)),
}))
const calendarDays = useQuery({
  queryKey: computed(() => ['activity-days', spaceId.value, calendarFilter.value, tz]),
  queryFn: () => api.activityDays(spaceId.value, calendarFilter.value, tz),
  placeholderData: keepPreviousData,
})
const calendarCounts = computed(
  () => new Map(calendarDays.data.value?.days.map((d) => [d.day, d.count]) ?? []),
)
const dayCounts = computed(
  () => new Map(rangeDays.data.value?.days.map((d) => [d.day, d.count]) ?? []),
)
const spark = computed(() => sparkDays(days.value, rangeDays.data.value?.days ?? [], today.value))
const sparkMax = computed(() => Math.max(1, ...spark.value.map((d) => d.count)))
const shortDay = (key: string) => `${Number(key.slice(5, 7))}-${key.slice(8)}`

// 合计取筛选计数的；各类操作只列勾选着的
const total = computed(() => facets.data.value?.total ?? null)
const byType = computed(
  () =>
    facets.data.value?.types
      .filter((t) => !state.value.off.type.includes(t.type))
      .map((t) => ({ ...t, ...eventLabel(t.type) })) ?? [],
)

// 日期：点一天只看那天，按住 Shift 选一段；快捷范围
const anchor = ref<string | null>(null)
function onPick(day: string, extend: boolean) {
  const picked = pickDay(day, anchor.value, extend)
  if (!extend) anchor.value = day
  void update({ range: null, from: picked.from, to: picked.to, event: null, memory: null })
}
function onQuick(range: QuickRange) {
  anchor.value = null
  void update({ range, from: null, to: null, event: null, memory: null })
  month.value = monthOf(today.value)
}

// 筛选：每组至少留一项勾选（固定的三组），否则列表一定是空的
function onToggle(group: FilterGroup, key: string, on: boolean) {
  const off = new Set(state.value.off[group])
  if (on) off.delete(key)
  else off.add(key)
  if (group !== 'actor' && FIXED_OPTIONS[group].every((v) => off.has(v))) return
  void update({ off: { ...state.value.off, [group]: [...off] }, event: null, memory: null })
}
function onReset(group: FilterGroup) {
  void update({ off: { ...state.value.off, [group]: [] }, event: null, memory: null })
}

// 生效的筛选标签，可以逐个清掉
const groupTitles: Record<FilterGroup, string> = {
  actor: '操作者',
  type: '操作',
  layer: '归属',
  field: '字段',
}
const actorNames = computed(
  () => new Map(facets.data.value?.actors.map((a) => [a.key, a.name] as const) ?? []),
)
function valueName(group: FilterGroup, key: string): string {
  if (group === 'actor') {
    return activityActorName(activityActorKind(key), actorNames.value.get(key) ?? null)
  }
  if (group === 'type') return eventLabel(key).label
  if (group === 'layer') return layerLabels[key as keyof typeof layerLabels] ?? key
  return changeLabels[key] ?? key
}
const dateChip = computed(() => {
  const s = state.value
  if (s.range === 'all') return null
  if (s.range) return quickRangeLabels[s.range]
  const d = days.value!
  return d.from === d.to ? shortDay(d.from) : `${shortDay(d.from)} 至 ${shortDay(d.to)}`
})
const chips = computed(() =>
  FILTER_GROUPS.filter((g) => state.value.off[g].length).map((g) => ({
    group: g,
    text: `${groupTitles[g]}：不含 ${state.value.off[g].map((k) => valueName(g, k)).join('、')}`,
  })),
)

// 选中的事件：表格里点一行，详情在右边（窄屏是抽屉）
const selected = computed(() =>
  state.value.event === null ? null : (items.value.find((i) => i.id === state.value.event) ?? null),
)
function select(id: number, memoryId: string) {
  if (state.value.event === id) return
  void update({ event: id, memory: memoryId })
}
const closeDetail = () => update({ event: null, memory: null })
const detailOpen = computed(() => state.value.event !== null)

// 折叠起来的几次修改：展开哪几行只是这一页上的事，不进地址
const expanded = ref(new Set<number>())
function toggleFold(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

// 窄屏（< 1024px）：筛选与详情进抽屉。中等宽度（< 1280px）表格放不下六列：
// 平时去掉状态列（并进记忆那一列），详情打开时只留时间与记忆两列
const narrow = shallowRef(false)
const medium = shallowRef(false)
const queries: [MediaQueryList, () => void][] = []
function watchMedia(query: string, target: typeof narrow) {
  const list = window.matchMedia(query)
  const sync = () => (target.value = list.matches)
  sync()
  list.addEventListener('change', sync)
  queries.push([list, sync])
}
onMounted(() => {
  watchMedia('(max-width: 1023.98px)', narrow)
  watchMedia('(max-width: 1279.98px)', medium)
})
onBeforeUnmount(() => {
  for (const [list, sync] of queries) list.removeEventListener('change', sync)
})
const filtersOpen = ref(false)
// 表格的三种排法：full 六列；compact 没有状态列，状态并进记忆那一列；narrow 只有时间与记忆两列
const layout = computed<EntryLayout>(() => {
  if (narrow.value) return 'narrow'
  if (detailOpen.value) return medium.value ? 'narrow' : 'compact'
  return medium.value ? 'compact' : 'full'
})
const columns = computed(() => ({ narrow: 2, compact: 5, full: 6 })[layout.value])
</script>

<template>
  <div class="activity" :class="{ 'with-detail': detailOpen && !narrow }">
    <!-- 窄屏时左栏放进「筛选」打开的抽屉 -->
    <aside v-if="!narrow" class="rail" aria-label="日期与筛选">
      <ActivityCalendar
        v-model:month="month"
        :today="today"
        :counts="calendarCounts"
        :selected="days"
        @pick="onPick"
      />
      <div class="quick" role="group" aria-label="快捷范围">
        <UButton
          v-for="r in QUICK_RANGES"
          :key="r"
          size="xs"
          color="neutral"
          :variant="state.range === r ? 'solid' : 'outline'"
          :aria-pressed="state.range === r"
          @click="onQuick(r)"
        >
          {{ quickRangeLabels[r] }}
        </UButton>
      </div>
      <p class="rail-tip">点一天只看那天，按住 Shift 再点选一段。</p>
      <ActivityFilters
        :options="options"
        :facets="facets.data.value"
        :off="state.off"
        @toggle="onToggle"
        @reset="onReset"
      />
    </aside>

    <div class="main">
      <div class="toolbar">
        <h1>变更记录</h1>
        <Hint>通过访问密钥写入的改动，操作者显示为应用。</Hint>
        <UInput
          v-model="qInput"
          class="search"
          size="sm"
          :icon="icons.search"
          placeholder="标题或坐标"
          aria-label="搜索标题或坐标"
          :maxlength="100"
        />
        <span class="grow" />
        <UButton
          v-if="narrow"
          :icon="icons.filter"
          size="sm"
          color="neutral"
          variant="outline"
          @click="filtersOpen = true"
        >
          筛选
        </UButton>
        <UButton
          :icon="icons.refresh"
          size="sm"
          color="neutral"
          variant="ghost"
          aria-label="刷新"
          :loading="activity.isRefetching.value"
          @click="
            () => {
              activity.refetch()
              facets.refetch()
              rangeDays.refetch()
              calendarDays.refetch()
            }
          "
        />
      </div>

      <div class="chips">
        <span v-if="dateChip" class="chip">
          <UIcon :name="icons.calendar" class="chip-icon" />{{ dateChip }}
          <button type="button" aria-label="清除日期" class="chip-clear" @click="onQuick('all')">
            <UIcon :name="icons.cancel" />
          </button>
        </span>
        <span v-else class="chip">
          <UIcon :name="icons.calendar" class="chip-icon" />全部时间
        </span>
        <span v-for="c in chips" :key="c.group" class="chip">
          {{ c.text }}
          <button
            type="button"
            :aria-label="`清除${groupTitles[c.group]}筛选`"
            class="chip-clear"
            @click="onReset(c.group)"
          >
            <UIcon :name="icons.cancel" />
          </button>
        </span>
        <span v-if="state.q" class="chip">
          <UIcon :name="icons.search" class="chip-icon" />「{{ state.q }}」
          <button type="button" aria-label="清除关键字" class="chip-clear" @click="qInput = ''">
            <UIcon :name="icons.cancel" />
          </button>
        </span>
      </div>

      <div class="stats">
        <div>
          <p class="total">
            <b>{{ total ?? '–' }}</b
            >条
          </p>
          <p class="by-type">
            <span v-for="t in byType" :key="t.type">
              <UIcon :name="t.icon" class="type-icon" />{{ t.label }} {{ t.count }}
            </span>
          </p>
        </div>
        <div class="spark-wrap" aria-hidden="true">
          <div class="spark">
            <i
              v-for="d in spark"
              :key="d.day"
              :class="{ zero: !d.count }"
              :style="d.count ? { height: `${Math.max(8, (d.count / sparkMax) * 100)}%` } : {}"
              :title="`${shortDay(d.day)} · ${d.count} 条`"
            />
          </div>
          <div v-if="spark.length" class="spark-axis">
            <span>{{ shortDay(spark[0]!.day) }}</span
            ><span>{{ shortDay(spark.at(-1)!.day) }}</span>
          </div>
        </div>
      </div>

      <div class="table-area">
        <!-- 读取失败时已经读到的行留着：翻页失败的错误放在「加载更多」上面，其余放在最上面 -->
        <div
          v-if="activity.isError.value && !activity.isFetchNextPageError.value"
          class="table-note"
        >
          <ReadFailureNote :query="activity" />
        </div>
        <div v-if="activity.isPending.value" class="table-note space-y-3">
          <USkeleton v-for="n in 6" :key="n" class="h-8 w-full" />
        </div>
        <template v-else-if="activity.data.value">
          <table class="table" :class="layout">
            <colgroup v-if="layout === 'narrow'">
              <col class="c-time" />
              <col />
            </colgroup>
            <colgroup v-else>
              <col class="c-time" />
              <col class="c-actor" />
              <col class="c-op" />
              <col />
              <col class="c-change" />
              <col v-if="layout === 'full'" class="c-flag" />
            </colgroup>
            <thead v-if="layout !== 'narrow'">
              <tr>
                <th>时间</th>
                <th>操作者</th>
                <th>操作</th>
                <th>记忆</th>
                <th>改动</th>
                <th v-if="layout === 'full'">状态</th>
              </tr>
            </thead>
            <tbody v-for="day in groups" :key="day.key">
              <tr class="day">
                <td :colspan="columns">
                  {{ day.heading
                  }}<span class="day-count">{{ dayCounts.get(day.key) ?? day.loaded }} 条</span>
                </td>
              </tr>
              <template v-for="row in day.rows" :key="row.item.id">
                <ActivityEntry
                  :item="row.item"
                  :layout="layout"
                  :selected="state.event === row.item.id"
                  :folded="row.more.length"
                  :expanded="expanded.has(row.item.id)"
                  @select="select(row.item.id, row.item.memoryId)"
                  @toggle="toggleFold(row.item.id)"
                />
                <template v-if="expanded.has(row.item.id)">
                  <ActivityEntry
                    v-for="sub in row.more"
                    :key="sub.id"
                    :item="sub"
                    :layout="layout"
                    sub
                    :selected="state.event === sub.id"
                    @select="select(sub.id, sub.memoryId)"
                  />
                </template>
              </template>
            </tbody>
          </table>
          <p v-if="!items.length" class="empty">暂无符合筛选的改动</p>
          <div v-if="activity.isFetchNextPageError.value" class="table-note">
            <NoteLine tone="error">{{ readFailure(activity.error.value) }}</NoteLine>
          </div>
          <div v-if="activity.hasNextPage.value" class="flex justify-center py-4">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              :loading="activity.isFetchingNextPage.value"
              @click="activity.fetchNextPage()"
            >
              加载更多
            </UButton>
          </div>
        </template>
      </div>
    </div>

    <aside v-if="detailOpen && !narrow" class="detail-column">
      <ActivityDetail v-if="selected" :item="selected" :space-id="spaceId" @close="closeDetail" />
      <div v-else class="detail-missing">
        <NoteLine>
          所选改动不在当前列表中
          <template #actions>
            <UButton size="xs" color="neutral" variant="outline" @click="closeDetail">
              关闭
            </UButton>
          </template>
        </NoteLine>
      </div>
    </aside>

    <USlideover v-if="narrow" v-model:open="filtersOpen" side="left" title="日期与筛选">
      <template #body>
        <ActivityCalendar
          v-model:month="month"
          :today="today"
          :counts="calendarCounts"
          :selected="days"
          @pick="onPick"
        />
        <div class="quick" role="group" aria-label="快捷范围">
          <UButton
            v-for="r in QUICK_RANGES"
            :key="r"
            size="xs"
            color="neutral"
            :variant="state.range === r ? 'solid' : 'outline'"
            :aria-pressed="state.range === r"
            @click="onQuick(r)"
          >
            {{ quickRangeLabels[r] }}
          </UButton>
        </div>
        <ActivityFilters
          :options="options"
          :facets="facets.data.value"
          :off="state.off"
          @toggle="onToggle"
          @reset="onReset"
        />
      </template>
    </USlideover>
    <USlideover
      v-if="narrow"
      :open="detailOpen"
      title="改动详情"
      @update:open="(open) => !open && closeDetail()"
    >
      <template #content>
        <ActivityDetail
          v-if="selected"
          class="overflow-y-auto"
          :item="selected"
          :space-id="spaceId"
          @close="closeDetail"
        />
        <div v-else class="detail-missing">
          <NoteLine>所选改动不在当前列表中</NoteLine>
        </div>
      </template>
    </USlideover>
  </div>
</template>

<style scoped>
.activity {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 284px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.activity.with-detail {
  grid-template-columns: 284px minmax(0, 1fr) 400px;
}
.rail {
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 40px;
  border-right: 1px solid var(--strata-rule);
}
.quick {
  display: flex;
  gap: 4px;
  margin-top: 12px;
}
.quick > * {
  flex: 1;
  justify-content: center;
  padding-inline: 2px;
  white-space: nowrap;
}
.rail-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.main {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
.toolbar {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 58px;
  padding: 0 24px;
  background: var(--ui-bg);
}
.toolbar h1 {
  font-size: 22px;
  font-weight: 500;
  white-space: nowrap;
}
.search {
  width: 240px;
  margin-left: 6px;
}
.grow {
  flex: 1;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 0 24px 10px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 4px 0 7px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-toned);
}
.chip-icon {
  color: var(--ui-text-dimmed);
}
.chip-clear {
  display: inline-flex;
  padding: 2px;
  color: var(--ui-text-dimmed);
  cursor: pointer;
}
.chip-clear:hover {
  color: var(--ui-text);
}
.stats {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 24px;
  align-items: end;
  padding: 10px 24px 12px;
  border-top: 1px solid var(--strata-rule);
  border-bottom: 1px solid var(--strata-rule);
}
.total {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.total b {
  margin-right: 2px;
  font-size: 22px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text);
}
.by-type {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 2px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.by-type span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.type-icon {
  width: 12px;
  height: 12px;
}
.spark {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 44px;
}
.spark i {
  flex: 1;
  min-height: 1px;
  background: var(--ui-text);
}
.spark i.zero {
  height: 1px;
  background: var(--ui-border);
}
.spark-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 2px;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.table-note {
  padding: 12px 24px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
}
.c-time {
  width: 84px;
}
.c-actor {
  width: 200px;
}
.c-op {
  width: 96px;
}
.c-change {
  width: 240px;
}
.c-flag {
  width: 150px;
}
.narrow .c-time {
  width: 64px;
}
.compact .c-time {
  width: 78px;
}
.compact .c-actor {
  width: 160px;
}
.compact .c-op {
  width: 84px;
}
.compact .c-change {
  width: 156px;
}
.table th {
  position: sticky;
  top: 58px;
  z-index: 2;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  text-align: left;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
}
.table th:first-child {
  padding-left: 24px;
}
.day td {
  position: sticky;
  top: 89px;
  z-index: 1;
  height: 32px;
  padding: 0 10px 0 24px;
  border-bottom: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-toned);
}
.table.narrow .day td {
  top: 58px;
}
.day-count {
  margin-left: 8px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.empty {
  padding: 16px 24px;
  color: var(--ui-text-muted);
}
.detail-column {
  min-height: 0;
  overflow-y: auto;
  border-left: 1px solid var(--strata-rule);
}
.detail-missing {
  padding: 16px 20px;
}

@media (max-width: 1279.98px) {
  .with-detail .stats {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
}
@media (max-width: 1023.98px) {
  .activity,
  .activity.with-detail {
    grid-template-columns: minmax(0, 1fr);
  }
  .toolbar {
    position: static;
    flex-wrap: wrap;
    height: auto;
    min-height: 52px;
    padding: 8px 16px;
  }
  .search {
    order: 5;
    width: 100%;
    margin-left: 0;
  }
  .chips,
  .stats {
    padding-left: 16px;
    padding-right: 16px;
  }
  .stats {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .table th {
    position: static;
  }
  .table .day td,
  .table.narrow .day td {
    top: 0;
    padding-left: 16px;
  }
}
</style>
