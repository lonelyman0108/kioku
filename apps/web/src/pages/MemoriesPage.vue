<script setup lang="ts">
import {
  ENTRY_TABS,
  PINNED_GROUPS,
  PROJECT_SCOPES,
  type EntryDetailResponse,
  type EntryListResponse,
  type EntryTab,
  type PinnedGroup,
  type ProjectScope,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/vue-query'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import BootPreviewDrawer from '../components/BootPreviewDrawer.vue'
import ConsequenceModal from '../components/ConsequenceModal.vue'
import CreateMemoryModal from '../components/CreateMemoryModal.vue'
import MemoryEditor from '../components/MemoryEditor.vue'
import MemoryIndexRail from '../components/MemoryIndexRail.vue'
import MemoryList from '../components/MemoryList.vue'
import QuickCaptureModal from '../components/QuickCaptureModal.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import { useDebounced } from '../composables/useDebounced'
import { useSession } from '../composables/useSession'
import { useViewport } from '../composables/useViewport'
import { icons } from '../icons'
import { entryRoute } from '../routes'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()
const hasChatModel = computed(() => Boolean(me.data.value?.hasChatModel))
const batchBusy = ref(false)

function textQuery(key: string): string | null {
  const v = route.query[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function withQuery(changes: Record<string, string | null>) {
  const query = { ...route.query }
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete query[k]
    else query[k] = v
  }
  return { query }
}

const selectedId = computed(() => textQuery('id'))
const tab = computed<EntryTab>(() => {
  const raw = textQuery('tab')
  return raw && (ENTRY_TABS as readonly string[]).includes(raw) ? (raw as EntryTab) : 'all'
})
const pinnedGroup = computed<PinnedGroup | null>(() => {
  if (tab.value !== 'pinned') return null
  const raw = textQuery('pinnedGroup')
  return raw && (PINNED_GROUPS as readonly string[]).includes(raw) ? (raw as PinnedGroup) : null
})
const env = computed(() => textQuery('env'))
const realm = computed(() => textQuery('realm'))
const project = computed(() => textQuery('project'))
const runtime = computed(() => textQuery('runtime'))
const topic = computed(() => textQuery('topic'))
const projectScope = computed<ProjectScope | null>(() => {
  const raw = textQuery('projectScope')
  return raw && (PROJECT_SCOPES as readonly string[]).includes(raw) ? (raw as ProjectScope) : null
})
const routeSearch = computed(() => textQuery('q') ?? '')

const searchInput = ref(routeSearch.value)
const debouncedSearch = useDebounced(searchInput, 250)
watch(debouncedSearch, (val) => {
  const clean = val.trim()
  if (clean !== routeSearch.value) void router.replace(withQuery({ q: clean || null }))
})
watch(routeSearch, (val) => {
  if (val !== searchInput.value.trim()) searchInput.value = val
})

const entriesQuery = useInfiniteQuery({
  queryKey: computed(
    () =>
      [
        'entries',
        {
          tab: tab.value,
          pinnedGroup: tab.value === 'pinned' ? (pinnedGroup.value ?? undefined) : undefined,
          limit: tab.value === 'pinned' && pinnedGroup.value === 'global_full' ? 100 : undefined,
          q: routeSearch.value || undefined,
          env: env.value ?? undefined,
          realm: realm.value ?? undefined,
          project: project.value ?? undefined,
          runtime: runtime.value ?? undefined,
          topic: topic.value ?? undefined,
          projectScope: projectScope.value ?? undefined,
        },
      ] as const,
  ),
  queryFn: ({ pageParam, queryKey: [, params] }) => api.entries({ ...params, cursor: pageParam }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  placeholderData: keepPreviousData,
})

const inboxQuery = useQuery({
  queryKey: ['inbox'] as const,
  queryFn: () => api.inbox(),
  enabled: computed(() => Boolean(me.data.value)),
  staleTime: 30_000,
})
const pendingInboxCount = computed(() => inboxQuery.data.value?.pendingCount ?? 0)

const firstPage = computed(() => entriesQuery.data.value?.pages[0] ?? null)
const items = computed(() => entriesQuery.data.value?.pages.flatMap((p) => p.items) ?? [])
const facets = computed(() => firstPage.value?.facets ?? null)
const counts = computed(() => firstPage.value?.counts ?? null)
const linkedTitles = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const page of entriesQuery.data.value?.pages ?? []) {
    if (page.linkedTitles) Object.assign(map, page.linkedTitles)
    for (const item of page.items) {
      if (item.title) map[item.shortId] = item.title
    }
  }
  return map
})

const createInitialScope = computed(() => ({
  projects: project.value ? [project.value] : [],
  realms: realm.value ? [realm.value] : [],
  runtimes: runtime.value ? [runtime.value] : [],
  envs: env.value ? [env.value] : [],
}))

const createOpen = ref(false)
const captureOpen = ref(false)
const bootPreviewOpen = ref(false)
const railOpen = ref(false)
const captureDraft = ref('')
const fullscreen = ref(false)
const layoutRef = ref<HTMLElement | null>(null)
const listRef = ref<InstanceType<typeof MemoryList> | null>(null)
const editorRef = ref<InstanceType<typeof MemoryEditor> | null>(null)
const viewport = useViewport()
const isPhone = computed(() => viewport.value.width < 768)
const compactRail = computed(() => viewport.value.width < 1280)

const INDEX_RAIL_WIDTH = 216
const LIST_WIDTH_STORAGE_KEY = 'kioku:memories-list-width'
const LIST_WIDTH_DEFAULT = 336
const LIST_WIDTH_MIN = 280
const LIST_WIDTH_MIN_COMPACT = 256
const LIST_WIDTH_MAX = 520
const DETAIL_MIN_WIDTH = 520
const DETAIL_MIN_WIDTH_COMPACT = 480

function readStoredListWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(LIST_WIDTH_STORAGE_KEY))
    if (Number.isFinite(raw) && raw >= LIST_WIDTH_MIN_COMPACT && raw <= LIST_WIDTH_MAX) {
      return Math.round(raw)
    }
  } catch {
    // 隐私模式或存储受限时退回默认宽度
  }
  return LIST_WIDTH_DEFAULT
}

function saveListWidth(width: number) {
  try {
    window.localStorage.setItem(LIST_WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // 忽略存储写入异常
  }
}

const storedListWidth = ref<number>(readStoredListWidth())
const containerWidth = ref<number>(0)
const resizing = ref(false)
let layoutObserver: ResizeObserver | null = null

const activeRailWidth = computed(() => (compactRail.value ? 0 : INDEX_RAIL_WIDTH))
const listMinWidth = computed(() =>
  viewport.value.width < 1024 ? LIST_WIDTH_MIN_COMPACT : LIST_WIDTH_MIN,
)
const detailMinWidth = computed(() =>
  viewport.value.width < 1024 ? DETAIL_MIN_WIDTH_COMPACT : DETAIL_MIN_WIDTH,
)

const maxAllowedWidth = computed(() => {
  const viewportFallback = Math.min(viewport.value.width, 1840)
  const effectiveContainer = containerWidth.value > 0 ? containerWidth.value : viewportFallback
  return Math.max(
    listMinWidth.value,
    Math.min(LIST_WIDTH_MAX, effectiveContainer - activeRailWidth.value - detailMinWidth.value),
  )
})

const effectiveListWidth = computed(() =>
  Math.max(listMinWidth.value, Math.min(storedListWidth.value, maxAllowedWidth.value)),
)

const isFullscreen = computed(() => Boolean(selectedId.value) && fullscreen.value && !isPhone.value)

let dragStartX = 0
let dragStartWidth = LIST_WIDTH_DEFAULT

function onPointerMove(event: PointerEvent) {
  if (!resizing.value) return
  const next = Math.round(
    Math.max(
      listMinWidth.value,
      Math.min(maxAllowedWidth.value, dragStartWidth + (event.clientX - dragStartX)),
    ),
  )
  storedListWidth.value = next
}

function stopResize() {
  if (!resizing.value) return
  resizing.value = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stopResize)
  window.removeEventListener('pointercancel', stopResize)
  window.removeEventListener('blur', stopResize)
  saveListWidth(storedListWidth.value)
}

function startResize(event: PointerEvent) {
  if (isPhone.value || isFullscreen.value || event.button !== 0) return
  event.preventDefault()
  dragStartX = event.clientX
  dragStartWidth = effectiveListWidth.value
  resizing.value = true
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopResize)
  window.addEventListener('pointercancel', stopResize)
  window.addEventListener('blur', stopResize)
}

function resetListWidth() {
  storedListWidth.value = LIST_WIDTH_DEFAULT
  saveListWidth(LIST_WIDTH_DEFAULT)
}

function onSplitterKeydown(event: KeyboardEvent) {
  if (isPhone.value || isFullscreen.value) return
  const step = event.shiftKey ? 40 : 16
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    storedListWidth.value = Math.max(listMinWidth.value, effectiveListWidth.value - step)
    saveListWidth(storedListWidth.value)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    storedListWidth.value = Math.min(maxAllowedWidth.value, effectiveListWidth.value + step)
    saveListWidth(storedListWidth.value)
  } else if (event.key === 'Home') {
    event.preventDefault()
    resetListWidth()
  }
}

watch([isPhone, isFullscreen], ([phone, fs]) => {
  if (phone || fs) stopResize()
  if (phone) fullscreen.value = false
})

watch(compactRail, (compact) => {
  if (!compact) railOpen.value = false
})

// 平板双栏与桌面三栏默认保持右侧展开：未选中记忆且真实列表就绪、无地址栏弹窗参数时自动定位首条
watch(
  [
    items,
    selectedId,
    isPhone,
    () => entriesQuery.isPending.value,
    () => entriesQuery.isPlaceholderData.value,
    () => route.query.capture,
    () => route.query.create,
  ],
  ([list, sid, phone, pending, placeholder, captureFlag, createFlag]) => {
    if (phone || pending || placeholder || sid || list.length === 0) return
    if (
      captureFlag === '1' ||
      captureFlag === 'true' ||
      createFlag === '1' ||
      createFlag === 'true'
    ) {
      return
    }
    const first = listRef.value?.displayItems[0] ?? list[0]
    if (first) void router.replace(withQuery({ id: first.shortId }))
  },
  { immediate: true },
)

watch(selectedId, async (id) => {
  if (!id) {
    fullscreen.value = false
    return
  }
  if (isPhone.value) {
    await nextTick()
    editorRef.value?.focusTitle()
  }
})

// 支持通过 ?capture=1&draft=... 打开随手记并清理地址栏参数
watch(
  () => [route.query.capture, route.query.draft] as const,
  ([captureFlag, draftParam]) => {
    if (captureFlag !== '1' && captureFlag !== 'true') return
    captureDraft.value = typeof draftParam === 'string' ? draftParam : ''
    captureOpen.value = true
    void router.replace(withQuery({ capture: null, draft: null }))
  },
  { immediate: true },
)

// 支持通过 ?create=1 打开新建记忆并清理地址栏参数
watch(
  () => route.query.create,
  (createFlag) => {
    if (createFlag !== '1' && createFlag !== 'true') return
    createOpen.value = true
    void router.replace(withQuery({ create: null }))
  },
  { immediate: true },
)

function openCapture(draft = '') {
  captureDraft.value = draft
  captureOpen.value = true
}

function select(shortId: string | null) {
  void router.replace(withQuery({ id: shortId }))
}

function openEntryFromCapture(shortId: string) {
  if (route.name !== 'memories') {
    void router.push(entryRoute(shortId))
    return
  }
  select(shortId)
}

function toggleFullscreen() {
  if (!selectedId.value || isPhone.value) return
  fullscreen.value = !fullscreen.value
}

function setTab(next: EntryTab) {
  railOpen.value = false
  void router.replace(
    withQuery({
      tab: next === 'all' ? null : next,
      pinnedGroup: null,
    }),
  )
}

function setPinnedGroup(value: PinnedGroup | null) {
  railOpen.value = false
  void router.replace(
    withQuery({
      ...(value !== null ? { tab: 'pinned' } : {}),
      pinnedGroup: value,
    }),
  )
}

function setFilter(
  key: 'env' | 'realm' | 'project' | 'runtime' | 'topic' | 'projectScope',
  value: string | null,
) {
  railOpen.value = false
  const changes: Record<string, string | null> = { [key]: value }
  if (key === 'project' && value !== null && projectScope.value === 'unassigned') {
    changes.projectScope = null
  } else if (key === 'projectScope' && value === 'unassigned' && project.value !== null) {
    changes.project = null
  }
  void router.replace(withQuery(changes))
}

function clearFilters() {
  void router.replace(
    withQuery({
      env: null,
      realm: null,
      project: null,
      runtime: null,
      topic: null,
      projectScope: null,
    }),
  )
}

function resetAllFilters() {
  searchInput.value = ''
  void router.replace(
    withQuery({
      q: null,
      pinnedGroup: null,
      env: null,
      realm: null,
      project: null,
      runtime: null,
      topic: null,
      projectScope: null,
    }),
  )
}

function invalidateEntries() {
  void queryClient.invalidateQueries({ queryKey: ['entries'] })
  void queryClient.invalidateQueries({ queryKey: ['boot-preview'] })
}

interface PendingBatchOrganize {
  mode: 'tidy' | 'cross_memory'
  shortIds: string[]
}

const pendingBatch = ref<PendingBatchOrganize | null>(null)
const batchError = ref<string | null>(null)

function onBatchOrganize(mode: 'tidy' | 'cross_memory', shortIds: string[]) {
  if (batchBusy.value || shortIds.length < 2) return
  batchError.value = null
  pendingBatch.value = { mode, shortIds }
}

async function confirmBatchOrganize() {
  const pending = pendingBatch.value
  if (!pending || batchBusy.value) return
  batchBusy.value = true
  batchError.value = null
  try {
    const res = await api.runDream({ mode: pending.mode, targetShortIds: pending.shortIds })
    if (res.started) {
      const label = pending.mode === 'tidy' ? '规范整理' : '查重与关联'
      pendingBatch.value = null
      listRef.value?.exitBatchMode()
      toast.add({
        title: `已发起所选 ${pending.shortIds.length} 条记忆的${label}任务`,
        color: 'success',
        actions: [
          {
            label: '前往整理',
            icon: icons.listChecks,
            color: 'neutral',
            variant: 'outline',
            onClick: () => void router.push({ name: 'organize' }),
          },
        ],
      })
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    } else {
      batchError.value = res.reason ?? '已有整理任务在执行中'
    }
  } catch (err) {
    batchError.value = err instanceof ApiError ? err.message : '发起批量整理失败'
  } finally {
    batchBusy.value = false
  }
}

function onCreated(detail: EntryDetailResponse) {
  queryClient.setQueryData(['entry', detail.entry.shortId], detail)
  invalidateEntries()
  void router.replace(withQuery({ tab: null, pinnedGroup: null, id: detail.entry.shortId }))
}

function onCaptureCreated(detail: EntryDetailResponse) {
  queryClient.setQueryData(['entry', detail.entry.shortId], detail)
  invalidateEntries()
}

function onChanged(detail: EntryDetailResponse) {
  queryClient.setQueryData(['entry', detail.entry.shortId], detail)
  invalidateEntries()
}

function onDeleted(shortId: string) {
  const currentList = listRef.value?.displayItems ?? items.value
  const deletedIdx = currentList.findIndex((item) => item.shortId === shortId)
  const remaining = currentList.filter((item) => item.shortId !== shortId)
  const nextItem =
    !isPhone.value && remaining.length > 0
      ? remaining[Math.min(Math.max(0, deletedIdx), remaining.length - 1)]
      : null
  queryClient.setQueriesData<InfiniteData<EntryListResponse>>({ queryKey: ['entries'] }, (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.shortId !== shortId),
          })),
        }
      : old,
  )
  queryClient.removeQueries({ queryKey: ['entry', shortId], exact: true })
  invalidateEntries()
  select(nextItem ? nextItem.shortId : null)
}

function onRestored(detail: EntryDetailResponse) {
  queryClient.setQueryData(['entry', detail.entry.shortId], detail)
  invalidateEntries()
  void router.replace(withQuery({ tab: null, pinnedGroup: null, id: detail.entry.shortId }))
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

function hasOpenOverlay(): boolean {
  if (createOpen.value || captureOpen.value || bootPreviewOpen.value || railOpen.value) return true
  if (listRef.value?.filterOpen) return true
  return Boolean(document.querySelector('[role="dialog"], [data-reka-popper-content-wrapper]'))
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || hasOpenOverlay()) return

  const editing = Boolean(editorRef.value?.isEditing())

  if (event.key === 'Escape') {
    if (editing) {
      event.preventDefault()
      editorRef.value?.exitEditing()
      return
    }
    if (isEditableElement(event.target)) return
    if (isFullscreen.value) {
      event.preventDefault()
      fullscreen.value = false
    } else if (isPhone.value && selectedId.value) {
      event.preventDefault()
      select(null)
    }
    return
  }

  if (editing || isEditableElement(event.target)) return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (
    event.key === 'ArrowDown' ||
    event.key === 'j' ||
    event.key === 'ArrowUp' ||
    event.key === 'k'
  ) {
    const list = listRef.value?.displayItems ?? items.value
    if (!list.length) return
    event.preventDefault()
    const currentIndex = list.findIndex((item) => item.shortId === selectedId.value)
    const nextIndex =
      event.key === 'ArrowDown' || event.key === 'j'
        ? currentIndex < 0
          ? 0
          : Math.min(list.length - 1, currentIndex + 1)
        : currentIndex <= 0
          ? 0
          : currentIndex - 1
    const target = list[nextIndex]
    if (target) select(target.shortId)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (layoutRef.value && typeof ResizeObserver !== 'undefined') {
    containerWidth.value = layoutRef.value.clientWidth
    layoutObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) containerWidth.value = Math.round(w)
    })
    layoutObserver.observe(layoutRef.value)
  }
})
onBeforeUnmount(() => {
  stopResize()
  layoutObserver?.disconnect()
  layoutObserver = null
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    ref="layoutRef"
    class="memories-layout"
    :class="{
      'has-selection': Boolean(selectedId),
      'is-fullscreen': isFullscreen,
      'is-resizing': resizing,
    }"
    :style="!isFullscreen && !isPhone ? { '--list-width': `${effectiveListWidth}px` } : undefined"
  >
    <div class="rail-col">
      <MemoryIndexRail
        :tab="tab"
        :pinned-group="pinnedGroup"
        :project="project"
        :realm="realm"
        :runtime="runtime"
        :facets="facets"
        :counts="counts"
        :pending-inbox-count="pendingInboxCount"
        @update:tab="setTab"
        @update:pinned-group="setPinnedGroup"
        @update:project="(v) => setFilter('project', v)"
        @update:realm="(v) => setFilter('realm', v)"
        @update:runtime="(v) => setFilter('runtime', v)"
        @preview-boot="bootPreviewOpen = true"
      />
    </div>

    <div class="list-col">
      <MemoryList
        ref="listRef"
        :tab="tab"
        :pinned-group="pinnedGroup"
        :search="searchInput"
        :env="env"
        :realm="realm"
        :project="project"
        :runtime="runtime"
        :topic="topic"
        :project-scope="projectScope"
        :selected-id="selectedId"
        :items="items"
        :linked-titles="linkedTitles"
        :facets="facets"
        :counts="counts"
        :query="entriesQuery"
        :has-next-page="Boolean(entriesQuery.hasNextPage.value)"
        :fetching-next-page="entriesQuery.isFetchingNextPage.value"
        :has-chat-model="hasChatModel"
        :batch-busy="batchBusy"
        @update:pinned-group="setPinnedGroup"
        @update:search="(v) => (searchInput = v)"
        @update:env="(v) => setFilter('env', v)"
        @update:realm="(v) => setFilter('realm', v)"
        @update:project="(v) => setFilter('project', v)"
        @update:runtime="(v) => setFilter('runtime', v)"
        @update:topic="(v) => setFilter('topic', v)"
        @update:project-scope="(v) => setFilter('projectScope', v)"
        @select="select"
        @capture="openCapture()"
        @create="createOpen = true"
        @open-rail="railOpen = true"
        @load-more="entriesQuery.fetchNextPage()"
        @clear-filters="clearFilters"
        @reset-filters="resetAllFilters"
        @batch-organize="onBatchOrganize"
      />
    </div>

    <section class="detail-col" aria-label="记忆详情">
      <div
        v-if="!isFullscreen && !isPhone"
        class="pane-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调节列表与详情宽度"
        :aria-valuenow="effectiveListWidth"
        :aria-valuemin="listMinWidth"
        :aria-valuemax="maxAllowedWidth"
        tabindex="0"
        title="拖动调节宽度，双击恢复默认"
        @pointerdown="startResize"
        @dblclick="resetListWidth"
        @keydown="onSplitterKeydown"
      />

      <MemoryEditor
        v-if="selectedId"
        :key="selectedId"
        ref="editorRef"
        :short-id="selectedId"
        :facets="facets"
        :fullscreen="isFullscreen"
        :show-back="isPhone"
        @changed="onChanged"
        @deleted="onDeleted"
        @restored="onRestored"
        @open="select"
        @toggle-fullscreen="toggleFullscreen"
        @back="select(null)"
      />
      <div v-else class="detail-empty">
        <EmptyState
          :icon="icons.memories"
          title="选择或新建一条记忆"
          description="从左侧目录与清单切换记忆，或直接使用随手记与新建沉淀内容。"
        >
          <template #actions>
            <UButton size="sm" :icon="icons.capture" @click="openCapture()">随手记</UButton>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :icon="icons.add"
              @click="createOpen = true"
            >
              新建记忆
            </UButton>
          </template>
        </EmptyState>
      </div>
    </section>

    <USlideover
      v-model:open="railOpen"
      side="left"
      title="目录与状态"
      :ui="{
        content: 'max-w-72 sm:max-w-72',
        body: 'p-0 sm:p-0 flex flex-col min-h-0 overflow-hidden',
      }"
    >
      <template #body>
        <MemoryIndexRail
          :tab="tab"
          :pinned-group="pinnedGroup"
          :project="project"
          :realm="realm"
          :runtime="runtime"
          :facets="facets"
          :counts="counts"
          :pending-inbox-count="pendingInboxCount"
          @update:tab="setTab"
          @update:pinned-group="setPinnedGroup"
          @update:project="(v) => setFilter('project', v)"
          @update:realm="(v) => setFilter('realm', v)"
          @update:runtime="(v) => setFilter('runtime', v)"
          @preview-boot="((railOpen = false), (bootPreviewOpen = true))"
        />
      </template>
    </USlideover>

    <CreateMemoryModal
      v-model:open="createOpen"
      :facets="facets"
      :initial-scope="createInitialScope"
      @created="onCreated"
    />
    <QuickCaptureModal
      v-model:open="captureOpen"
      :initial-text="captureDraft"
      @applied="onChanged"
      @created="onCaptureCreated"
      @open-entry="openEntryFromCapture"
    />
    <BootPreviewDrawer v-model:open="bootPreviewOpen" :facets="facets" @select="select" />
    <ConsequenceModal
      :open="pendingBatch !== null"
      tone="primary"
      :title="
        pendingBatch
          ? `对所选 ${pendingBatch.shortIds.length} 条记忆发起${pendingBatch.mode === 'tidy' ? '规范整理' : '查重与关联'}？`
          : ''
      "
      :title-icon="pendingBatch?.mode === 'tidy' ? icons.tidy : icons.links"
      :consequences="
        pendingBatch
          ? [
              `将对所选 ${pendingBatch.shortIds.length} 条记忆调用对话模型执行${pendingBatch.mode === 'tidy' ? '逐条规范整理' : '查重与关联'}。`,
              '整理结果仅写入待确认建议，不会直接修改现有记忆。',
              '执行期间可随时在整理页或顶部导航栏取消。',
            ]
          : []
      "
      action="开始整理"
      :action-icon="pendingBatch?.mode === 'tidy' ? icons.tidy : icons.links"
      :busy="batchBusy"
      :error="batchError"
      @confirm="confirmBatchOrganize"
      @close="((pendingBatch = null), (batchError = null))"
    />
  </div>
</template>

<style scoped>
.memories-layout {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: 216px var(--list-width, 336px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  width: 100%;
  max-width: 1840px;
  margin-inline: auto;
  min-width: 0;
  min-height: 0;
}
.memories-layout.is-resizing {
  user-select: none;
  cursor: col-resize;
}
@media (min-width: 1841px) {
  .memories-layout {
    border-inline: 1px solid var(--ui-border-muted);
  }
}
.rail-col {
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--ui-border-accented);
}
.list-col {
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--ui-border-accented);
}
.detail-col {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg);
}
.detail-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.memories-layout.is-fullscreen {
  grid-template-columns: minmax(0, 1fr);
}
.memories-layout.is-fullscreen .rail-col,
.memories-layout.is-fullscreen .list-col {
  display: none;
}
.pane-splitter {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -5px;
  z-index: 15;
  width: 9px;
  cursor: col-resize;
  touch-action: none;
}
.pane-splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: var(--ui-rule);
  opacity: 0;
  transition: opacity 140ms ease;
}
.pane-splitter:hover::after,
.pane-splitter:focus-visible::after,
.memories-layout.is-resizing .pane-splitter::after {
  opacity: 1;
}
.pane-splitter:focus-visible {
  outline: 0;
}
@media (max-width: 1279.98px) {
  .memories-layout {
    grid-template-columns: var(--list-width, 288px) minmax(0, 1fr);
    max-width: none;
  }
  .rail-col {
    display: none;
  }
  .memories-layout.is-fullscreen {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 767.98px) {
  .memories-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .pane-splitter {
    display: none;
  }
  .list-col {
    border-right: 0;
  }
  .memories-layout.has-selection .list-col {
    display: none;
  }
  .memories-layout:not(.has-selection) .detail-col {
    display: none;
  }
}
</style>
