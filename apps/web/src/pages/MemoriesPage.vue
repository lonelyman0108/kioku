<script setup lang="ts">
import {
  ENTRY_TABS,
  PROJECT_SCOPES,
  type EntryDetailResponse,
  type EntryTab,
  type ProjectScope,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import BootPreviewDrawer from '../components/BootPreviewDrawer.vue'
import CreateMemoryModal from '../components/CreateMemoryModal.vue'
import MemoryEditor from '../components/MemoryEditor.vue'
import MemoryList from '../components/MemoryList.vue'
import QuickCaptureModal from '../components/QuickCaptureModal.vue'
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

const firstPage = computed(() => entriesQuery.data.value?.pages[0] ?? null)
const items = computed(() => entriesQuery.data.value?.pages.flatMap((p) => p.items) ?? [])
const facets = computed(() => firstPage.value?.facets ?? null)
const counts = computed(() => firstPage.value?.counts ?? null)

const createOpen = ref(false)
const captureOpen = ref(false)
const bootPreviewOpen = ref(false)
const captureDraft = ref('')
const fullscreen = ref(false)
const layoutRef = ref<HTMLElement | null>(null)
const listRef = ref<InstanceType<typeof MemoryList> | null>(null)
const editorRef = ref<InstanceType<typeof MemoryEditor> | null>(null)
const viewport = useViewport()
const narrow = computed(() => viewport.value.width < 1024)

const LIST_WIDTH_STORAGE_KEY = 'kioku:memories-list-width'
const LIST_WIDTH_DEFAULT = 380
const LIST_WIDTH_MIN = 280
const LIST_WIDTH_MAX = 640
const DETAIL_MIN_WIDTH = 560

function readStoredListWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(LIST_WIDTH_STORAGE_KEY))
    if (Number.isFinite(raw) && raw >= LIST_WIDTH_MIN && raw <= LIST_WIDTH_MAX) {
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

const maxAllowedWidth = computed(() => {
  const viewportFallback = Math.min(viewport.value.width, 1840)
  const effectiveContainer = containerWidth.value > 0 ? containerWidth.value : viewportFallback
  return Math.max(LIST_WIDTH_MIN, Math.min(LIST_WIDTH_MAX, effectiveContainer - DETAIL_MIN_WIDTH))
})

const effectiveListWidth = computed(() =>
  Math.max(LIST_WIDTH_MIN, Math.min(storedListWidth.value, maxAllowedWidth.value)),
)

const isPeek = computed(() => Boolean(selectedId.value) && !fullscreen.value)
const isFullscreen = computed(() => Boolean(selectedId.value) && fullscreen.value)

let dragStartX = 0
let dragStartWidth = LIST_WIDTH_DEFAULT

function onPointerMove(event: PointerEvent) {
  if (!resizing.value) return
  const next = Math.round(
    Math.max(
      LIST_WIDTH_MIN,
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
  if (narrow.value || !isPeek.value || event.button !== 0) return
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
  if (narrow.value || !isPeek.value) return
  const step = event.shiftKey ? 40 : 16
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    storedListWidth.value = Math.max(LIST_WIDTH_MIN, effectiveListWidth.value - step)
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

watch([narrow, isPeek], ([isNarrow, peek]) => {
  if (isNarrow || !peek) stopResize()
})

watch(selectedId, async (id) => {
  if (!id) {
    fullscreen.value = false
    return
  }
  if (narrow.value) {
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
  if (!selectedId.value) return
  fullscreen.value = !fullscreen.value
}

function setTab(next: EntryTab) {
  void router.replace(withQuery({ tab: next === 'all' ? null : next }))
}

function setFilter(
  key: 'env' | 'realm' | 'project' | 'runtime' | 'topic' | 'projectScope',
  value: string | null,
) {
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

function invalidateEntries() {
  void queryClient.invalidateQueries({ queryKey: ['entries'] })
  void queryClient.invalidateQueries({ queryKey: ['boot-preview'] })
}

async function onBatchOrganize(mode: 'tidy' | 'cross_memory', shortIds: string[]) {
  if (batchBusy.value || shortIds.length < 2) return
  batchBusy.value = true
  try {
    const res = await api.runDream({ mode, targetShortIds: shortIds })
    if (res.started) {
      const label = mode === 'tidy' ? '规范整理' : '查重与关联'
      toast.add({
        title: `已发起所选 ${shortIds.length} 条记忆的${label}任务`,
        color: 'success',
        actions: [
          {
            label: '前往待处理',
            color: 'neutral',
            variant: 'outline',
            onClick: () => void router.push({ name: 'inbox' }),
          },
        ],
      })
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    } else {
      toast.add({ title: res.reason ?? '已有整理任务在执行中', color: 'neutral' })
    }
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '发起批量整理失败', color: 'error' })
  } finally {
    batchBusy.value = false
  }
}

function onCreated(detail: EntryDetailResponse) {
  queryClient.setQueryData(['entry', detail.entry.shortId], detail)
  invalidateEntries()
  void router.replace(withQuery({ tab: null, id: detail.entry.shortId }))
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
  queryClient.removeQueries({ queryKey: ['entry', shortId], exact: true })
  invalidateEntries()
  select(null)
}

function onRestored(detail: EntryDetailResponse) {
  queryClient.setQueryData(['entry', detail.entry.shortId], detail)
  invalidateEntries()
  void router.replace(withQuery({ tab: null, id: detail.entry.shortId }))
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

function hasOpenOverlay(): boolean {
  if (createOpen.value || captureOpen.value || bootPreviewOpen.value) return true
  if (listRef.value?.filterOpen) return true
  return Boolean(document.querySelector('[role="dialog"], [data-reka-popper-content-wrapper]'))
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || hasOpenOverlay()) return

  if (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'j'
  ) {
    event.preventDefault()
    openCapture()
    return
  }

  const editing = Boolean(editorRef.value?.isEditing())

  if (event.key === 'Escape') {
    if (editing) {
      event.preventDefault()
      editorRef.value?.exitEditing()
      return
    }
    if (isEditableElement(event.target)) return
    if (fullscreen.value) {
      event.preventDefault()
      fullscreen.value = false
    } else if (selectedId.value) {
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
    const list = items.value
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
      'is-peek': isPeek,
      'is-fullscreen': isFullscreen,
      'is-resizing': resizing,
    }"
    :style="isPeek && !narrow ? { '--list-width': `${effectiveListWidth}px` } : undefined"
  >
    <MemoryList
      ref="listRef"
      :tab="tab"
      :search="searchInput"
      :env="env"
      :realm="realm"
      :project="project"
      :runtime="runtime"
      :topic="topic"
      :project-scope="projectScope"
      :selected-id="selectedId"
      :compact="isPeek"
      :items="items"
      :facets="facets"
      :counts="counts"
      :query="entriesQuery"
      :has-next-page="Boolean(entriesQuery.hasNextPage.value)"
      :fetching-next-page="entriesQuery.isFetchingNextPage.value"
      :has-chat-model="hasChatModel"
      :batch-busy="batchBusy"
      @update:tab="setTab"
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
      @refresh="entriesQuery.refetch()"
      @load-more="entriesQuery.fetchNextPage()"
      @clear-filters="clearFilters"
      @preview-boot="bootPreviewOpen = true"
      @batch-organize="onBatchOrganize"
    />

    <Transition name="detail-reveal">
      <section v-if="selectedId" class="detail-col" aria-label="记忆详情">
        <div
          v-if="isPeek && !narrow"
          class="pane-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调节列表与详情宽度"
          :aria-valuenow="effectiveListWidth"
          :aria-valuemin="LIST_WIDTH_MIN"
          :aria-valuemax="maxAllowedWidth"
          tabindex="0"
          title="拖动调节宽度，双击恢复默认"
          @pointerdown="startResize"
          @dblclick="resetListWidth"
          @keydown="onSplitterKeydown"
        />
        <MemoryEditor
          :key="selectedId"
          ref="editorRef"
          :short-id="selectedId"
          :facets="facets"
          @changed="onChanged"
          @deleted="onDeleted"
          @restored="onRestored"
          @open="select"
        >
          <template #nav>
            <div class="nav-group">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="icons.back"
                class="mobile-back-btn"
                @click="select(null)"
              >
                返回列表
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="fullscreen ? icons.minimize : icons.maximize"
                class="desktop-only-btn"
                @click="toggleFullscreen"
              >
                {{ fullscreen ? '退出全屏' : '全屏展开' }}
              </UButton>
            </div>
            <div class="nav-group">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="icons.cancel"
                class="desktop-only-btn"
                title="关闭详情（Esc）"
                @click="select(null)"
              >
                关闭
              </UButton>
            </div>
          </template>
        </MemoryEditor>
      </section>
    </Transition>

    <CreateMemoryModal v-model:open="createOpen" :facets="facets" @created="onCreated" />
    <QuickCaptureModal
      v-model:open="captureOpen"
      :initial-text="captureDraft"
      @applied="onChanged"
      @created="onCaptureCreated"
      @open-entry="openEntryFromCapture"
    />
    <BootPreviewDrawer v-model:open="bootPreviewOpen" :facets="facets" @select="select" />
  </div>
</template>

<style scoped>
.memories-layout {
  display: grid;
  flex: 1 1 auto;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  max-width: 76rem;
  margin-inline: auto;
  min-width: 0;
  min-height: 0;
  transition: max-width 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.memories-layout.has-selection {
  max-width: 1840px;
}
.memories-layout.is-resizing {
  transition: none;
  user-select: none;
  cursor: col-resize;
}
@media (min-width: 1217px) {
  .memories-layout:not(.has-selection) {
    border-inline: 1px solid var(--ui-border-muted);
  }
}
@media (min-width: 1841px) {
  .memories-layout.has-selection {
    border-inline: 1px solid var(--ui-border-muted);
  }
}
.memories-layout.is-peek {
  grid-template-columns: var(--list-width, 380px) minmax(0, 1fr);
}
.memories-layout.is-peek :deep(.list-pane) {
  border-right: 1px solid var(--ui-rule);
}
.memories-layout.is-fullscreen :deep(.list-pane) {
  display: none;
}
.detail-col {
  position: relative;
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg);
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
.detail-reveal-enter-active {
  transition:
    opacity 200ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.detail-reveal-leave-active {
  transition: opacity 140ms ease;
}
.detail-reveal-enter-from {
  opacity: 0;
  transform: translateX(18px);
}
.detail-reveal-leave-to {
  opacity: 0;
}
.memories-layout.is-fullscreen .detail-col {
  grid-column: 1;
  grid-row: 2;
}
.nav-group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.mobile-back-btn {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  .memories-layout,
  .detail-reveal-enter-active,
  .detail-reveal-leave-active {
    transition: none;
  }
}
@media (max-width: 1023.98px) {
  .memories-layout,
  .memories-layout.is-peek {
    grid-template-columns: minmax(0, 1fr);
    max-width: none;
  }
  .pane-splitter {
    display: none;
  }
  .memories-layout.is-peek :deep(.list-pane) {
    border-right: 0;
  }
  .memories-layout.has-selection {
    grid-template-rows: minmax(0, 1fr);
  }
  .memories-layout.has-selection :deep(.list-toolbar),
  .memories-layout.has-selection :deep(.list-pane) {
    display: none;
  }
  .memories-layout.has-selection .detail-col {
    grid-column: 1;
    grid-row: 1;
  }
  .mobile-back-btn {
    display: inline-flex;
  }
  .desktop-only-btn {
    display: none;
  }
}
</style>
