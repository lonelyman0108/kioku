<script setup lang="ts">
import {
  ENTRY_TABS,
  PROJECT_SCOPES,
  type EntryDetailResponse,
  type EntryTab,
  type ProjectScope,
} from '@kioku/contracts'
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import CreateMemoryModal from '../components/CreateMemoryModal.vue'
import MemoryEditor from '../components/MemoryEditor.vue'
import MemoryList from '../components/MemoryList.vue'
import QuickCaptureModal from '../components/QuickCaptureModal.vue'
import { useDebounced } from '../composables/useDebounced'
import { useViewport } from '../composables/useViewport'
import { icons } from '../icons'

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()

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
const captureDraft = ref('')
const fullscreen = ref(false)
const listRef = ref<InstanceType<typeof MemoryList> | null>(null)
const editorRef = ref<InstanceType<typeof MemoryEditor> | null>(null)
const viewport = useViewport()
const narrow = computed(() => viewport.value.width < 1024)

const isPeek = computed(() => Boolean(selectedId.value) && !fullscreen.value)
const isFullscreen = computed(() => Boolean(selectedId.value) && fullscreen.value)

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

function toggleFullscreen() {
  if (!selectedId.value) return
  fullscreen.value = !fullscreen.value
}

function setTab(next: EntryTab) {
  void router.replace(withQuery({ tab: next === 'all' ? null : next }))
}

function setFilter(
  key: 'env' | 'realm' | 'project' | 'topic' | 'projectScope',
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
    withQuery({ env: null, realm: null, project: null, topic: null, projectScope: null }),
  )
}

function invalidateEntries() {
  void queryClient.invalidateQueries({ queryKey: ['entries'] })
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
  if (createOpen.value || captureOpen.value) return true
  if (listRef.value?.filterOpen) return true
  return Boolean(document.querySelector('[role="dialog"], [data-reka-popper-content-wrapper]'))
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || hasOpenOverlay()) return

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
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

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="memories-layout"
    :class="{
      'has-selection': Boolean(selectedId),
      'is-peek': isPeek,
      'is-fullscreen': isFullscreen,
    }"
  >
    <MemoryList
      ref="listRef"
      :tab="tab"
      :search="searchInput"
      :env="env"
      :realm="realm"
      :project="project"
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
      @update:tab="setTab"
      @update:search="(v) => (searchInput = v)"
      @update:env="(v) => setFilter('env', v)"
      @update:realm="(v) => setFilter('realm', v)"
      @update:project="(v) => setFilter('project', v)"
      @update:topic="(v) => setFilter('topic', v)"
      @update:project-scope="(v) => setFilter('projectScope', v)"
      @select="select"
      @capture="openCapture()"
      @create="createOpen = true"
      @refresh="entriesQuery.refetch()"
      @load-more="entriesQuery.fetchNextPage()"
      @clear-filters="clearFilters"
    />

    <section v-if="selectedId" class="detail-col" aria-label="记忆详情">
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

    <CreateMemoryModal v-model:open="createOpen" :facets="facets" @created="onCreated" />
    <QuickCaptureModal
      v-model:open="captureOpen"
      :initial-text="captureDraft"
      @applied="onChanged"
      @created="onCaptureCreated"
      @open-entry="select"
    />
  </div>
</template>

<style scoped>
.memories-layout {
  display: grid;
  flex: 1;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.memories-layout.is-peek {
  grid-template-columns: clamp(360px, 40%, 520px) minmax(0, 1fr);
}
.memories-layout.is-peek :deep(.list-pane) {
  border-right: 1px solid var(--ui-rule);
}
.memories-layout.is-fullscreen :deep(.list-pane) {
  display: none;
}
.detail-col {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg);
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
@media (max-width: 1023.98px) {
  .memories-layout,
  .memories-layout.is-peek {
    grid-template-columns: minmax(0, 1fr);
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
