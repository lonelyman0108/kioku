<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import {
  BROWSE_GROUP_BYS,
  SENSITIVITIES,
  STRATA_BANDS,
  type BrowseGroupBy,
  type ConsoleEntryView,
  type Sensitivity,
  type StrataBand,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { invalidateActivity } from '../activity'
import CreateMemoryModal from '../components/CreateMemoryModal.vue'
import CrossCirclePreviewDrawer from '../components/CrossCirclePreviewDrawer.vue'
import DeletedMemories from '../components/DeletedMemories.vue'
import ExpiredMemories from '../components/ExpiredMemories.vue'
import MemoryEditor from '../components/MemoryEditor.vue'
import MemoryListView from '../components/MemoryListView.vue'
import {
  GROUP_BY_OPTIONS,
  buildBrowseTree,
  findTreeItem,
  focusAfterSelect,
  guideLines,
  keysForShortId,
  parentRow,
  selectable,
  treeRowPlaces,
  typeaheadMatch,
  type MemoryTreeItem,
} from '../components/memoryTree'
import EmptyState from '../components/strata/EmptyState.vue'
import MemoryFlags from '../components/strata/MemoryFlags.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import StrataRibbon from '../components/strata/StrataRibbon.vue'
import StrataSwatch from '../components/strata/StrataSwatch.vue'
import { tallyCounts } from '../components/strata/strata'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { useViewport } from '../composables/useViewport'
import { icons } from '../icons'
import { invalidateInboxCounts } from '../inbox'
import { statsChanged } from '../memoryDetail'
import { entryRoute } from '../routes'
import { circleSettingsRoute } from '../settingsSections'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()

const circleId = computed(() => String(route.params.circleId))
const selectedId = computed(() => (typeof route.query.id === 'string' ? route.query.id : null))
const { circleKind, role, canWrite } = useMemoryPermissions(circleId)

function withQuery(changes: Record<string, string | null>) {
  const query = { ...route.query }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete query[key]
    else query[key] = value
  }
  return { query }
}
function select(id: string | null) {
  return router.replace(withQuery({ id }))
}

type View = 'tree' | 'list' | 'deleted' | 'expired'
const views: View[] = ['tree', 'list', 'deleted', 'expired']
const viewItems: TabsItem[] = [
  { label: '目录', value: 'tree' },
  { label: '列表', value: 'list' },
  { label: '已过期', value: 'expired' },
  { label: '已删除', value: 'deleted' },
]
const view = computed<View>(() => views.find((v) => v === route.query.view) ?? 'tree')
function setView(value: string | number) {
  void router.replace(withQuery({ view: value === 'tree' ? null : String(value) }))
}

const groupBy = computed<BrowseGroupBy>(() => {
  const raw = route.query.groupBy
  return typeof raw === 'string' &&
    raw !== 'circle' &&
    (BROWSE_GROUP_BYS as readonly string[]).includes(raw)
    ? (raw as BrowseGroupBy)
    : 'topic'
})
function setGroupBy(value: BrowseGroupBy) {
  void router.replace(withQuery({ groupBy: value === 'topic' ? null : value }))
}

// 窄柱与列表上方的总数都来自概览的统计，和概览页共用一份缓存。写入时只标记过期，在统计可能变了时重取一次
const overview = useQuery({
  queryKey: computed(() => ['overview', circleId.value] as const),
  queryFn: ({ queryKey: [, cid] }) => api.overview(cid),
  staleTime: 60_000,
})
function refreshCounts() {
  void overview.refetch()
  void invalidateInboxCounts(queryClient, circleId.value)
}

const stackCounts = computed(() => {
  const data = overview.data.value
  return data
    ? tallyCounts({
        circleKind: circleKind.value,
        counts: [...data.counts, ...data.extractedCounts],
      })
    : null
})

// 窄柱筛选落在列表上；切到别的视图时条件留在地址里，窄柱不亮
const filterBand = computed(() => {
  const band = route.query.band as StrataBand
  return view.value === 'list' && STRATA_BANDS.includes(band) ? band : null
})
const filterSensitivity = computed(() => {
  const sensitivity = route.query.sensitivity as Sensitivity
  return view.value === 'list' && SENSITIVITIES.includes(sensitivity) ? sensitivity : null
})
function selectBand(band: StrataBand) {
  const same = filterBand.value === band
  void router.replace(
    withQuery({
      view: 'list',
      band: same ? null : band,
      sensitivity: same ? filterSensitivity.value : null,
      kind: null,
    }),
  )
}
function clearStrataFilter() {
  void router.replace(withQuery({ band: null, sensitivity: null, kind: null }))
}

const currentBand = ref<StrataBand | null>(null)
watch(selectedId, () => (currentBand.value = null))
const nearBand = ref<StrataBand | null>(null)
function onIndexHover(event: MouseEvent) {
  const row = (event.target as Element).closest?.('[data-band]')
  nearBand.value = (row?.getAttribute('data-band') as StrataBand | undefined) ?? null
}

const browse = useQuery({
  queryKey: computed(() => ['entry-browse', circleId.value, groupBy.value] as const),
  queryFn: ({ queryKey: [, cid, gb] }) =>
    api.browseEntries(cid, {
      groupBy: gb,
      ...(gb === 'kind' ? {} : { kind: 'entry' }),
    }),
})
const treeItems = computed<MemoryTreeItem[]>(() =>
  browse.data.value
    ? buildBrowseTree(browse.data.value, { id: circleId.value, kind: circleKind.value })
    : [],
)

const expanded = ref<string[]>([])
const expandedInitializedFor = ref('')
const preferredItemKey = ref<string | null>(null)

const selectedMatch = computed(() =>
  selectedId.value
    ? keysForShortId(treeItems.value, selectedId.value, preferredItemKey.value)
    : null,
)
const selectedKey = computed(() => selectedMatch.value?.itemKey ?? null)
const selectedItem = computed(() =>
  selectedKey.value ? findTreeItem(treeItems.value, selectedKey.value) : undefined,
)

watch(
  [treeItems, circleId, groupBy],
  ([items, cid, gb]) => {
    const scopeKey = `${cid}:${gb}`
    const groupKeys = items.filter((item) => item.kind === 'group').map((item) => item.key)
    if (!groupKeys.length) {
      if (expandedInitializedFor.value !== scopeKey) expanded.value = []
      return
    }
    if (expandedInitializedFor.value !== scopeKey) {
      expandedInitializedFor.value = scopeKey
      const initial = groupKeys.length <= 24 ? groupKeys : groupKeys.slice(0, 5)
      if (selectedMatch.value && !initial.includes(selectedMatch.value.groupKey)) {
        initial.push(selectedMatch.value.groupKey)
      }
      expanded.value = initial
    } else if (selectedMatch.value && !expanded.value.includes(selectedMatch.value.groupKey)) {
      expanded.value = [...expanded.value, selectedMatch.value.groupKey]
    }
  },
  { immediate: true },
)

watch(selectedMatch, (match) => {
  if (match && !expanded.value.includes(match.groupKey)) {
    expanded.value = [...expanded.value, match.groupKey]
  }
})

const createOpen = ref(false)
// 刚删掉的那条：目录和列表马上就要去掉它，窄屏返回时焦点不放回那一行
let deletedId: string | null = null

// 列表、浏览目录、已删除、已过期、变更记录、关联搜索与凭据引用按圈失效；概览只标记过期
function invalidateCircleMemories(cid: string) {
  for (const key of [
    'entry-list',
    'entry-browse',
    'entry-deleted',
    'entry-expired',
    'entry-glossary',
    'credentials',
    'credential-references',
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key, cid] })
  }
  void queryClient.invalidateQueries({ queryKey: ['entry-link-search'] })
  void invalidateInboxCounts(queryClient, cid)
  invalidateActivity(queryClient, cid)
  void queryClient.invalidateQueries({
    queryKey: ['overview', cid],
    refetchType: 'none',
  })
}
function invalidateLists() {
  invalidateCircleMemories(circleId.value)
}

function resetEntry(shortId: string, cid = circleId.value) {
  void queryClient.resetQueries({ queryKey: ['entry', cid, shortId], exact: true })
}

function refresh() {
  invalidateLists()
  refreshCounts()
}

// 点名字只选中打开，点箭头只展开收起
function clickedChevron(event: Event) {
  const original = (event as CustomEvent<{ originalEvent: Event }>).detail.originalEvent
  return !!(original.target as Element | null)?.closest?.('[data-chevron]')
}
function onToggle(event: Event, item: MemoryTreeItem) {
  const original = (event as CustomEvent<{ originalEvent: Event }>).detail.originalEvent
  if (original.type === 'click' && selectable(item) && !clickedChevron(event)) {
    event.preventDefault()
  }
}
function onSelect(event: Event, item: MemoryTreeItem) {
  event.preventDefault()
  if (!selectable(item) || clickedChevron(event) || !item.shortId) return
  preferredItemKey.value = item.key
  void select(item.shortId)
}

async function onCreated(created: ConsoleEntryView) {
  resetEntry(created.shortId)
  invalidateLists()
  refreshCounts()
  await select(created.shortId)
}

async function onDeleted(shortId: string) {
  deletedId = shortId
  await select(null)
  await nextTick()
  resetEntry(shortId)
  invalidateLists()
  refreshCounts()
  deletedId = null
}

function onChanged(entry: ConsoleEntryView, before?: ConsoleEntryView) {
  invalidateLists()
  if (!before || statsChanged(before, entry)) refreshCounts()
}

async function onMoved(entry: ConsoleEntryView, toCircleId: string) {
  const fromCircleId = circleId.value
  invalidateLists()
  if (toCircleId !== fromCircleId) invalidateCircleMemories(toCircleId)
  refreshCounts()
  if (entry.circleId === fromCircleId) {
    return onChanged(entry)
  }
  toast.add({ title: `已迁移「${entry.title || entry.shortId}」`, color: 'success' })
  await router.replace(entryRoute(toCircleId, entry.shortId))
  await nextTick()
  resetEntry(entry.shortId, fromCircleId)
}

async function onRevived(shortId: string) {
  invalidateLists()
  refreshCounts()
  await select(shortId)
}

const crossPreview = ref<{ circleId: string; shortId: string } | null>(null)

function openLinked(shortId: string, targetCircleId?: string) {
  if (targetCircleId && targetCircleId !== circleId.value) {
    crossPreview.value = { circleId: targetCircleId, shortId }
    return
  }
  void router.push(withQuery({ id: shortId }))
}

async function switchToCrossCircle(targetCircleId: string, shortId: string) {
  const failure = await router.push(entryRoute(targetCircleId, shortId))
  if (!failure) crossPreview.value = null
}

watch(circleId, () => {
  createOpen.value = false
  crossPreview.value = null
  preferredItemKey.value = null
  expanded.value = []
})

// 目录一行多高：窄屏和触屏要点得准，高一些。虚拟滚动按这个高度算位置，要和样式一致
const viewport = useViewport()
const narrow = computed(() => viewport.value.width < 1024)
const coarsePointer = window.matchMedia('(pointer: coarse)').matches
const rowHeight = computed(() => (narrow.value || coarsePointer ? 36 : 28))
const places = computed(() => treeRowPlaces(treeItems.value, expanded.value))
const treeRef = ref<{ $el: HTMLElement } | null>(null)
function scrollToRow(key: string | null) {
  const el = treeRef.value?.$el
  if (!el) return
  const place = key ? places.value.get(key) : undefined
  if (place) {
    const top = place.index * rowHeight.value
    if (top < el.scrollTop || top + rowHeight.value > el.scrollTop + el.clientHeight) {
      el.scrollTop = top - el.clientHeight / 2
    }
  }
  // 目录刚从隐藏变成显示时，位置变了也不发 scroll 事件，虚拟滚动不知道，替它发一个
  el.dispatchEvent(new Event('scroll'))
}
const hasSelection = computed(() => Boolean(selectedId.value))
const indexVisible = computed(() => !narrow.value || !hasSelection.value)
watch(indexVisible, async (visible) => {
  if (!visible) return
  await nextTick()
  scrollToRow(selectedKey.value)
})

let focusWait = 0
function focusTreeRow(key: string, missing?: () => void) {
  cancelAnimationFrame(focusWait)
  scrollToRow(key)
  const attempt = (left: number) => {
    focusWait = requestAnimationFrame(() => {
      const row = treeRef.value?.$el.querySelector<HTMLElement>(
        `[data-row-key="${CSS.escape(key)}"]`,
      )
      if (row) row.focus()
      else if (left > 0) attempt(left - 1)
      else missing?.()
    })
  }
  attempt(10)
}
const hasModifier = (event: KeyboardEvent) => event.altKey || event.metaKey || event.ctrlKey
function onTreeLeftKey(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' || hasModifier(event)) return
  const key = (event.target as HTMLElement).dataset.rowKey
  const parent = key ? parentRow(places.value, expanded.value, key) : null
  if (!parent) return
  event.preventDefault()
  event.stopPropagation()
  focusTreeRow(parent)
}
let typed = ''
let typedAt = 0
function onTreeKeydown(event: KeyboardEvent) {
  if (event.key.length !== 1 || event.key === ' ' || hasModifier(event)) return
  typed = event.timeStamp - typedAt < 1000 ? typed + event.key : event.key
  typedAt = event.timeStamp
  const current = (document.activeElement as HTMLElement | null)?.dataset.rowKey ?? null
  const key = typeaheadMatch(places.value, typed, current)
  if (key) focusTreeRow(key)
}
const treeVirtualize = computed(() => ({
  estimateSize: rowHeight.value,
  overscan: 16,
  textContent: () => '',
}))
watch(view, async (next) => {
  if (next !== 'tree' || !selectedKey.value) return
  await nextTick()
  scrollToRow(selectedKey.value)
})

const editorRef = ref<{ focusTitle: () => void } | null>(null)
const indexColumn = ref<HTMLElement | null>(null)
function focusIndexRow(shortId: string) {
  const fallback = () =>
    indexColumn.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  if (shortId === deletedId) return fallback()
  if (view.value === 'tree') {
    const match = keysForShortId(treeItems.value, shortId, preferredItemKey.value)
    return match ? focusTreeRow(match.itemKey, fallback) : fallback()
  }
  const row = listScroller.value?.querySelector<HTMLElement>(
    `button[data-short-id="${CSS.escape(shortId)}"]`,
  )
  if (!row) return fallback()
  row.scrollIntoView({ block: 'center' })
  row.focus({ preventScroll: true })
}
watch(selectedId, async (id, previous) => {
  const target = focusAfterSelect(narrow.value, id, previous)
  if (!target) return
  await nextTick()
  if (target.to === 'title') editorRef.value?.focusTitle()
  else focusIndexRow(target.shortId)
})

// 三个列表共用一个滚动区：各记各的位置，切回来还在原处
const listScroller = ref<HTMLElement | null>(null)
const listScrollTops = new Map<View, number>()
watch(
  view,
  async (next, previous) => {
    if (listScroller.value) listScrollTops.set(previous, listScroller.value.scrollTop)
    await nextTick()
    if (listScroller.value) listScroller.value.scrollTop = listScrollTops.get(next) ?? 0
  },
  { flush: 'pre' },
)

const createInitialTopic = computed(() =>
  typeof route.query.topic === 'string' && route.query.topic ? route.query.topic : null,
)
</script>

<template>
  <div class="memories" :class="{ 'has-selection': hasSelection }">
    <aside class="ribbon-column">
      <StrataRibbon
        :counts="stackCounts"
        :circle-kind="circleKind"
        :selected="filterBand"
        :sensitivity="filterSensitivity"
        :all-active="view === 'tree' || view === 'list'"
        :current="currentBand"
        :near="nearBand"
        @select="selectBand"
        @clear="clearStrataFilter"
      />
    </aside>

    <section
      ref="indexColumn"
      class="index-column"
      aria-label="记忆"
      @mouseover="onIndexHover"
      @mouseleave="nearBand = null"
    >
      <div class="index-head">
        <UTabs
          :model-value="view"
          :items="viewItems"
          :content="false"
          variant="link"
          size="md"
          :ui="{ root: 'min-w-0', list: 'border-0', trigger: 'px-2 py-0 h-11 text-sm/5' }"
          @update:model-value="setView"
        />
        <div class="flex shrink-0 items-center gap-1">
          <UButton
            :icon="icons.refresh"
            size="sm"
            color="neutral"
            variant="ghost"
            aria-label="刷新"
            @click="refresh"
          />
          <UButton
            v-if="canWrite"
            size="sm"
            color="primary"
            variant="outline"
            @click="createOpen = true"
          >
            新建
          </UButton>
        </div>
      </div>

      <div class="ribbon-flat">
        <StrataRibbon
          orientation="horizontal"
          :counts="stackCounts"
          :circle-kind="circleKind"
          :selected="filterBand"
          :sensitivity="filterSensitivity"
          @select="selectBand"
          @clear="clearStrataFilter"
        />
      </div>

      <template v-if="view === 'tree'">
        <div class="group-bar">
          <div class="group-meta">
            <span v-if="overview.data.value" class="index-count-num">
              <b>{{ overview.data.value.total }}</b> 条
            </span>
          </div>
          <label class="group-select-wrap">
            <span class="group-label">分组</span>
            <USelect
              :model-value="groupBy"
              :items="GROUP_BY_OPTIONS"
              size="xs"
              aria-label="分组维度"
              @update:model-value="(v) => setGroupBy(v as BrowseGroupBy)"
            />
          </label>
        </div>

        <div v-if="browse.isError.value" class="index-note">
          <ReadFailureNote :query="browse" />
        </div>
        <div v-if="browse.isPending.value" class="space-y-2 p-3.5">
          <USkeleton v-for="n in 6" :key="n" class="h-7 w-full" />
        </div>
        <UTree
          v-else-if="treeItems.length"
          ref="treeRef"
          :key="`${rowHeight}|${groupBy}`"
          v-model:expanded="expanded"
          class="memory-tree"
          aria-label="记忆目录"
          :model-value="selectedItem"
          :items="treeItems"
          :get-key="(item) => item.key"
          :virtualize="treeVirtualize"
          @toggle="onToggle"
          @select="onSelect"
          @keydown="onTreeKeydown"
          @keydown.capture="onTreeLeftKey"
        >
          <template #item-wrapper="{ item, expanded: open, selected }">
            <div
              class="tree-row"
              :class="{
                selected,
                group: item.kind === 'group',
                note: item.disabled,
              }"
              :style="{
                height: `${rowHeight}px`,
                paddingLeft: `${5 + (places.get(item.key)?.depth ?? 0) * 16}px`,
              }"
              :data-band="item.band ?? undefined"
              :data-row-key="item.key"
              :data-short-id="item.shortId ?? undefined"
            >
              <template v-if="places.get(item.key)">
                <template v-for="line in guideLines(places.get(item.key)!)" :key="line.left">
                  <i class="guide" :class="{ end: line.end }" :style="{ left: `${line.left}px` }" />
                  <i v-if="line.tick" class="tick" :style="{ left: `${line.left}px` }" />
                </template>
              </template>
              <span
                v-if="item.children"
                class="chevron"
                :class="{ open }"
                data-chevron
                aria-hidden="true"
              >
                <svg width="8" height="8" viewBox="0 0 8 8">
                  <path d="M2 1l4 3-4 3z" fill="currentColor" />
                </svg>
              </span>
              <span v-else class="chevron" />

              <StrataSwatch
                v-if="item.kind === 'entry' && item.band && item.sensitivity"
                class="me-[7px] shrink-0"
                :band="item.band"
                :sensitivity="item.sensitivity"
                :local="!item.circleId || item.circleId === circleId"
              />
              <span class="tree-label" :title="item.label">{{ item.label }}</span>
              <span class="tree-trail">
                <MemoryFlags
                  v-if="item.kind === 'entry'"
                  :kind="item.entryKind"
                  :sensitivity="item.sensitivity"
                  :priority="item.priority"
                  :variant-count="item.variantCount"
                  local
                />
                <span v-if="item.kind === 'group' && item.count !== undefined" class="tree-count">
                  {{ item.count }}
                </span>
              </span>
            </div>
          </template>
        </UTree>
        <EmptyState
          v-else-if="browse.data.value"
          class="index-empty"
          title="当前记忆圈暂无记忆"
          :description="
            canWrite ? '可新建一条正式记忆，或先配置语境词典。' : '当前账号是查看者，无法新建记忆。'
          "
        >
          <template v-if="canWrite" #actions>
            <UButton size="sm" color="primary" @click="createOpen = true">新建记忆</UButton>
          </template>
        </EmptyState>
      </template>

      <!-- 列表、已删除与已过期切走时不卸载：保留筛选与位置 -->
      <div v-show="view !== 'tree'" ref="listScroller" class="index-scroll">
        <KeepAlive>
          <MemoryListView
            v-if="view === 'list'"
            :circle-id="circleId"
            :circle-kind="circleKind"
            :can-see-secret="role === 'owner'"
            :selected-id="selectedId"
            :overview="overview.data.value"
            @select="select"
          />
          <DeletedMemories
            v-else-if="view === 'deleted'"
            :circle-id="circleId"
            @restored="onRevived"
            @show-expired="setView('expired')"
          />
          <ExpiredMemories
            v-else-if="view === 'expired'"
            :circle-id="circleId"
            @reactivated="onRevived"
          />
        </KeepAlive>
      </div>
    </section>

    <section class="detail-column" aria-label="详情">
      <MemoryEditor
        v-if="selectedId"
        :key="`${circleId}|${selectedId}`"
        ref="editorRef"
        :circle-id="circleId"
        :short-id="selectedId"
        @deleted="onDeleted"
        @changed="onChanged"
        @moved="onMoved"
        @open="openLinked"
        @band="currentBand = $event"
      >
        <template #nav>
          <button type="button" class="back" @click="select(null)">
            <UIcon :name="icons.back" class="size-4" />
            返回
          </button>
        </template>
      </MemoryEditor>
      <div v-else class="detail-empty">
        <EmptyState
          title="选择或新建记忆"
          description="从左侧按主题、场域、环境、客户端、项目或形态浏览记忆，也可通过双链将相关记忆串联起来。"
        >
          <template #actions>
            <UButton v-if="canWrite" color="primary" @click="createOpen = true">新建记忆</UButton>
            <UButton
              color="neutral"
              variant="outline"
              :to="circleSettingsRoute(circleId, 'vocabulary')"
            >
              语境词典
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              :to="{ name: 'personas', params: { circleId } }"
            >
              人格
            </UButton>
          </template>
        </EmptyState>
      </div>
    </section>

    <CreateMemoryModal
      v-model:open="createOpen"
      :circle-id="circleId"
      :initial-topic="createInitialTopic"
      @created="onCreated"
    />

    <CrossCirclePreviewDrawer
      :target="crossPreview"
      :current-circle-id="circleId"
      @close="crossPreview = null"
      @switch-to="switchToCrossCircle"
    />
  </div>
</template>

<style scoped>
.memories {
  display: grid;
  grid-template-columns: 104px 370px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.ribbon-column {
  border-right: 1px solid var(--ui-border);
  overflow-y: auto;
}
.ribbon-flat {
  display: none;
  padding: 8px 16px;
  border-bottom: 1px solid var(--ui-border);
}
.index-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--ui-border-accented);
}
.index-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 45px;
  padding: 0 12px 0 8px;
  border-bottom: 1px solid var(--ui-border);
}
.group-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--ui-border);
}
.group-meta {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.index-count-num b {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--ui-text);
}
.group-select-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.group-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.index-note {
  padding: 12px 14px 0;
}
.index-empty {
  padding: 18px 14px;
  font-size: 14px;
  color: var(--ui-text-muted);
}
.index-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.index-column :deep(.memory-tree) {
  flex: 1;
  min-height: 0;
  padding: 5px 0 16px;
  overflow-x: hidden;
}
.tree-row {
  position: relative;
  display: flex;
  align-items: center;
  padding-right: 12px;
  font-size: 14px;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.tree-row.note {
  cursor: default;
}
.tree-row:not(.note):hover {
  background: var(--ui-bg-elevated);
}
.tree-row:focus-visible {
  outline-offset: -2px;
}
.tree-row.group {
  color: var(--ui-text);
  font-weight: 500;
}
.tree-row.note {
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--ui-text-muted);
}
/* 选中的行写在各类行的后面：选择器的优先级相同，后写的才压得住 */
.tree-row.selected,
.tree-row.selected:hover {
  --strata-frame: var(--strata-selected-frame);
  --flag-muted: var(--strata-on-selected-muted);
  --flag-solid: var(--strata-on-selected);
  --flag-on-solid: var(--strata-selected);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ui-border-accented);
}
.guide.end {
  bottom: 50%;
}
.tick {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 1px;
  background: var(--ui-border-accented);
}
.tree-row.selected .guide,
.tree-row.selected .tick {
  background: var(--strata-on-selected-muted);
}
.chevron {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  align-self: stretch;
  margin-right: 3px;
  color: var(--ui-text-muted);
}
.chevron:hover {
  color: var(--ui-text-highlighted);
}
.chevron svg {
  transition: transform 0.1s linear;
}
@media (pointer: coarse) {
  .chevron {
    justify-content: flex-start;
    width: 28px;
    padding-left: 5px;
  }
  .chevron::before {
    content: '';
    position: absolute;
    inset: 0 0 0 -5px;
  }
}
.chevron.open svg {
  transform: rotate(90deg);
}
.tree-row.selected .chevron {
  color: var(--strata-on-selected);
}
.tree-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree-meta {
  flex: none;
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.tree-row.selected .tree-meta {
  color: var(--strata-on-selected-muted);
}
.tree-trail {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding-left: 8px;
  font-family: var(--font-sans);
}
.tree-count {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.tree-row.selected .tree-count {
  color: var(--strata-on-selected-muted);
}
.detail-column {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.detail-empty {
  padding: 32px;
  color: var(--ui-text-muted);
}
.back {
  display: none;
  align-items: center;
  gap: 3px;
  height: 32px;
  margin: -4px 0 4px -3px;
  font-size: 14px;
  color: var(--ui-text-muted);
}

@media (max-width: 1240px) {
  .memories {
    grid-template-columns: 104px 324px minmax(0, 1fr);
  }
}
@media (max-width: 1023.98px) {
  .memories {
    grid-template-columns: minmax(0, 1fr);
  }
  .ribbon-column {
    display: none;
  }
  .ribbon-flat {
    display: block;
  }
  .back {
    display: inline-flex;
  }
  .index-column {
    border-right: 0;
  }
  .has-selection .index-column,
  .memories:not(.has-selection) .detail-column {
    display: none;
  }
  .index-head {
    padding: 0 16px 0 7px;
  }
  .group-bar,
  .index-empty {
    padding-left: 16px;
    padding-right: 16px;
  }
  .detail-empty {
    padding: 16px;
  }
}
</style>
