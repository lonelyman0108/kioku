<script setup lang="ts">
import {
  ENTRY_TABS,
  type EntryFacetsSummary,
  type EntryListItem,
  type EntryTab,
  type EntryTabCounts,
} from '@kioku/contracts'
import type { TabsItem } from '@nuxt/ui'
import { computed } from 'vue'

import { icons } from '../icons'
import { entryTabLabels, envDisplayName } from '../labels'
import type { ReadState } from '../query'
import { formatRelative, formatTime, isExpired } from '../time'
import EmptyState from './ui/EmptyState.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'

const props = defineProps<{
  tab: EntryTab
  search: string
  env: string | null
  realm: string | null
  project: string | null
  selectedId: string | null
  items: readonly EntryListItem[]
  facets: EntryFacetsSummary | null
  counts: EntryTabCounts | null
  query: ReadState & {
    isError: { readonly value: boolean }
    isPending: { readonly value: boolean }
  }
  hasNextPage: boolean
  fetchingNextPage: boolean
}>()

const emit = defineEmits<{
  'update:tab': [value: EntryTab]
  'update:search': [value: string]
  'update:env': [value: string | null]
  'update:realm': [value: string | null]
  'update:project': [value: string | null]
  select: [shortId: string]
  create: []
  refresh: []
  loadMore: []
  clearFilters: []
}>()

const tabItems = computed<TabsItem[]>(() =>
  ENTRY_TABS.map((value) => {
    const count = props.counts?.[value]
    return {
      value,
      label: count !== undefined ? `${entryTabLabels[value]} ${count}` : entryTabLabels[value],
    }
  }),
)

const hasFilters = computed(() => Boolean(props.env || props.realm || props.project))

function toggleChip(current: string | null, next: string): string | null {
  return current === next ? null : next
}

function scopeSummary(item: EntryListItem): string[] {
  const tags: string[] = []
  for (const p of item.projects) tags.push(p)
  for (const e of item.envs) tags.push(envDisplayName(e))
  for (const r of item.realms) tags.push(r)
  return tags.slice(0, 4)
}
</script>

<template>
  <section class="list-pane" aria-label="记忆列表">
    <div class="list-search">
      <UInput
        :model-value="search"
        :icon="icons.search"
        placeholder="搜索标题、正文、短 ID"
        size="sm"
        class="min-w-0 flex-1"
        @update:model-value="(v) => emit('update:search', String(v ?? ''))"
      />
      <UButton
        :icon="icons.refresh"
        size="sm"
        color="neutral"
        variant="ghost"
        aria-label="刷新"
        :loading="query.isFetching.value && !fetchingNextPage"
        @click="emit('refresh')"
      />
      <UButton size="sm" :icon="icons.add" @click="emit('create')">新建</UButton>
    </div>

    <div class="list-tabs">
      <UTabs
        :model-value="tab"
        :items="tabItems"
        :content="false"
        variant="link"
        size="sm"
        :ui="{ root: 'min-w-0 w-full', list: 'border-0', trigger: 'px-2 py-0 h-10 text-xs/5' }"
        @update:model-value="(v) => emit('update:tab', v as EntryTab)"
      />
    </div>

    <div
      v-if="
        facets &&
        (facets.projects.length || facets.envs.length || facets.realms.length || hasFilters)
      "
      class="filter-bar"
    >
      <div v-if="facets.projects.length" class="filter-group">
        <span class="filter-label">项目</span>
        <button
          v-for="p in facets.projects"
          :key="`p:${p}`"
          type="button"
          class="chip"
          :class="{ active: project === p }"
          @click="emit('update:project', toggleChip(project, p))"
        >
          {{ p }}
        </button>
      </div>
      <div v-if="facets.envs.length" class="filter-group">
        <span class="filter-label">环境</span>
        <button
          v-for="e in facets.envs"
          :key="`e:${e}`"
          type="button"
          class="chip"
          :class="{ active: env === e }"
          @click="emit('update:env', toggleChip(env, e))"
        >
          {{ envDisplayName(e) }}
        </button>
      </div>
      <div v-if="facets.realms.length" class="filter-group">
        <span class="filter-label">场域</span>
        <button
          v-for="r in facets.realms"
          :key="`r:${r}`"
          type="button"
          class="chip"
          :class="{ active: realm === r }"
          @click="emit('update:realm', toggleChip(realm, r))"
        >
          {{ r }}
        </button>
      </div>
      <button v-if="hasFilters" type="button" class="chip-clear" @click="emit('clearFilters')">
        清除筛选
      </button>
    </div>

    <div class="list-scroll">
      <div v-if="query.isError.value" class="p-3">
        <ReadFailureNote :query="query" />
      </div>
      <div v-if="query.isPending.value" class="space-y-2 p-3">
        <USkeleton v-for="n in 6" :key="n" class="h-14 w-full" />
      </div>
      <template v-else-if="items.length">
        <ul>
          <li v-for="item in items" :key="item.shortId">
            <button
              type="button"
              class="entry-row"
              :class="{ selected: item.shortId === selectedId }"
              :aria-current="item.shortId === selectedId ? 'true' : undefined"
              @click="emit('select', item.shortId)"
            >
              <span class="row-top">
                <UIcon v-if="item.isPinned" :name="icons.pin" class="row-pin" aria-label="常驻" />
                <span class="row-title">{{ item.title }}</span>
                <time
                  class="row-time"
                  :datetime="item.updatedAt"
                  :title="formatTime(item.updatedAt)"
                >
                  {{ formatRelative(item.updatedAt) }}
                </time>
              </span>
              <span v-if="item.snippet || item.disclosure" class="row-sub">
                {{ item.snippet ?? item.disclosure }}
              </span>
              <span class="row-meta">
                <span class="font-mono">{{ item.shortId }}</span>
                <span v-if="item.kind === 'episode'" class="meta-tag">摘要</span>
                <span v-if="isExpired(item.validTo)" class="meta-tag warn">已过期</span>
                <span v-for="tag in scopeSummary(item)" :key="tag" class="meta-tag">{{ tag }}</span>
              </span>
            </button>
          </li>
        </ul>
        <div v-if="hasNextPage" class="flex justify-center py-3">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :loading="fetchingNextPage"
            @click="emit('loadMore')"
          >
            加载更多
          </UButton>
        </div>
      </template>
      <EmptyState
        v-else-if="!query.isError.value"
        :title="
          search.trim()
            ? '暂无匹配记忆'
            : tab === 'trash'
              ? '回收站为空'
              : tab === 'episodes'
                ? '暂无近期摘要'
                : tab === 'pinned'
                  ? '暂无常驻记忆'
                  : '暂无记忆'
        "
        :description="
          search.trim() || hasFilters
            ? '尝试调整关键词或清除筛选条件。'
            : tab === 'all'
              ? '新建第一条记忆，或接入编码工具后自动沉淀。'
              : null
        "
      >
        <template v-if="tab === 'all' && !search.trim() && !hasFilters" #actions>
          <UButton size="sm" @click="emit('create')">新建记忆</UButton>
        </template>
      </EmptyState>
    </div>
  </section>
</template>

<style scoped>
.list-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--ui-rule);
}
.list-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--ui-border);
}
.list-tabs {
  flex: none;
  padding: 0 6px;
  border-bottom: 1px solid var(--ui-border);
}
.filter-bar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.filter-group {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.filter-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.chip {
  padding: 1px 6px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.chip:hover {
  background: var(--ui-bg-elevated);
}
.chip.active {
  border-color: var(--ui-selected);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.chip-clear {
  font-size: 12px;
  color: var(--ui-text-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.entry-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
  cursor: pointer;
}
.entry-row:hover {
  background: var(--ui-bg-elevated);
}
.entry-row.selected,
.entry-row.selected:hover {
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.row-pin {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.entry-row.selected .row-pin {
  color: var(--ui-on-selected);
}
.row-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-time {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.row-sub {
  overflow: hidden;
  font-size: 13px;
  line-height: 1.45;
  color: var(--ui-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.meta-tag {
  padding: 0 4px;
  border: 1px solid var(--ui-border-accented);
  line-height: 1.4;
}
.meta-tag.warn {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.entry-row.selected .row-time,
.entry-row.selected .row-sub,
.entry-row.selected .row-meta {
  color: var(--ui-on-selected-muted);
}
.entry-row.selected .meta-tag {
  border-color: var(--ui-on-selected-muted);
  color: var(--ui-on-selected);
}
@media (max-width: 1023.98px) {
  .list-pane {
    border-right: 0;
  }
}
</style>
