<script setup lang="ts">
import { ENTRY_TABS, type EntryDetailResponse, type EntryTab } from '@kioku/contracts'
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import CreateMemoryModal from '../components/CreateMemoryModal.vue'
import MemoryEditor from '../components/MemoryEditor.vue'
import MemoryList from '../components/MemoryList.vue'
import EmptyState from '../components/ui/EmptyState.vue'
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
const editorRef = ref<InstanceType<typeof MemoryEditor> | null>(null)
const viewport = useViewport()
const narrow = computed(() => viewport.value.width < 1024)

watch(selectedId, async (id) => {
  if (id && narrow.value) {
    await nextTick()
    editorRef.value?.focusTitle()
  }
})

function select(shortId: string | null) {
  void router.replace(withQuery({ id: shortId }))
}

function setTab(next: EntryTab) {
  void router.replace(withQuery({ tab: next === 'all' ? null : next }))
}

function setFilter(key: 'env' | 'realm' | 'project', value: string | null) {
  void router.replace(withQuery({ [key]: value }))
}

function clearFilters() {
  void router.replace(withQuery({ env: null, realm: null, project: null }))
}

function invalidateEntries() {
  void queryClient.invalidateQueries({ queryKey: ['entries'] })
}

function onCreated(detail: EntryDetailResponse) {
  queryClient.setQueryData(['entry', detail.entry.shortId], detail)
  invalidateEntries()
  void router.replace(withQuery({ tab: null, id: detail.entry.shortId }))
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
</script>

<template>
  <div class="memories-layout" :class="{ 'has-selection': Boolean(selectedId) }">
    <MemoryList
      class="list-col"
      :tab="tab"
      :search="searchInput"
      :env="env"
      :realm="realm"
      :project="project"
      :selected-id="selectedId"
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
      @select="select"
      @create="createOpen = true"
      @refresh="entriesQuery.refetch()"
      @load-more="entriesQuery.fetchNextPage()"
      @clear-filters="clearFilters"
    />

    <section class="detail-col" aria-label="记忆详情">
      <MemoryEditor
        v-if="selectedId"
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
          <button type="button" class="back-btn" @click="select(null)">
            <UIcon :name="icons.back" class="back-icon" />
            返回列表
          </button>
        </template>
      </MemoryEditor>
      <div v-else class="detail-empty">
        <EmptyState
          title="选择或新建记忆"
          description="从左侧按关键词、项目、环境或场域筛选记忆，或新建一条常驻规则。"
        >
          <template #actions>
            <UButton @click="createOpen = true">新建记忆</UButton>
          </template>
        </EmptyState>
      </div>
    </section>

    <CreateMemoryModal v-model:open="createOpen" :facets="facets" @created="onCreated" />
  </div>
</template>

<style scoped>
.memories-layout {
  display: grid;
  flex: 1;
  grid-template-columns: 360px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.detail-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.detail-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.back-btn {
  display: none;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.back-icon {
  display: inline-block;
  width: 15px;
  height: 15px;
}
@media (max-width: 1023.98px) {
  .memories-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .has-selection .list-col,
  .memories-layout:not(.has-selection) .detail-col {
    display: none;
  }
  .back-btn {
    display: inline-flex;
  }
}
</style>
