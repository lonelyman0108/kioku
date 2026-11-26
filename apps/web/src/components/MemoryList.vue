<script setup lang="ts">
import {
  ENTRY_TABS,
  type EntryFacetsSummary,
  type EntryListItem,
  type EntryTab,
  type EntryTabCounts,
  type ProjectScope,
} from '@kioku/contracts'
import { useKbd } from '@nuxt/ui/composables'
import { computed, nextTick, ref, watch } from 'vue'

import { icons } from '../icons'
import { entryTabLabels, envDisplayName } from '../labels'
import type { ReadState } from '../query'
import { formatRelative, formatTime, isExpired } from '../time'
import EmptyState from './ui/EmptyState.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'

const props = withDefaults(
  defineProps<{
    tab: EntryTab
    search: string
    env: string | null
    realm: string | null
    project: string | null
    topic: string | null
    projectScope: ProjectScope | null
    selectedId: string | null
    compact?: boolean
    items: readonly EntryListItem[]
    facets: EntryFacetsSummary | null
    counts: EntryTabCounts | null
    query: ReadState & {
      isError: { readonly value: boolean }
      isPending: { readonly value: boolean }
    }
    hasNextPage: boolean
    fetchingNextPage: boolean
  }>(),
  { compact: false },
)

const emit = defineEmits<{
  'update:tab': [value: EntryTab]
  'update:search': [value: string]
  'update:env': [value: string | null]
  'update:realm': [value: string | null]
  'update:project': [value: string | null]
  'update:topic': [value: string | null]
  'update:projectScope': [value: ProjectScope | null]
  select: [shortId: string]
  capture: []
  create: []
  refresh: []
  loadMore: []
  clearFilters: []
}>()

const { getKbdKey } = useKbd()
const captureShortcut = computed(() => {
  const mod = getKbdKey('meta')?.trim() || 'Ctrl'
  return mod === '⌘' ? '⌘J' : `${mod}+J`
})

const filterOpen = ref(false)
const listScrollRef = ref<HTMLElement | null>(null)

const PROJECT_SCOPE_OPTIONS: { value: ProjectScope; label: string }[] = [
  { value: 'unassigned', label: '无项目归属' },
  { value: 'assigned', label: '已关联项目' },
]

interface ActiveFilterPill {
  key: 'projectScope' | 'topic' | 'project' | 'env' | 'realm'
  label: string
}

const activeFilters = computed<ActiveFilterPill[]>(() => {
  const pills: ActiveFilterPill[] = []
  if (props.projectScope) {
    pills.push({
      key: 'projectScope',
      label: `归属：${props.projectScope === 'unassigned' ? '无项目归属' : '已关联项目'}`,
    })
  }
  if (props.topic) pills.push({ key: 'topic', label: `主题：${props.topic}` })
  if (props.project) pills.push({ key: 'project', label: `项目：${props.project}` })
  if (props.env) pills.push({ key: 'env', label: `环境：${envDisplayName(props.env)}` })
  if (props.realm) pills.push({ key: 'realm', label: `场域：${props.realm}` })
  return pills
})

const hasFilters = computed(() => activeFilters.value.length > 0)

function toggleValue<T extends string>(current: T | null, next: T): T | null {
  return current === next ? null : next
}

function removeFilter(key: ActiveFilterPill['key']) {
  if (key === 'projectScope') emit('update:projectScope', null)
  else if (key === 'topic') emit('update:topic', null)
  else if (key === 'project') emit('update:project', null)
  else if (key === 'env') emit('update:env', null)
  else emit('update:realm', null)
}

interface RowTag {
  key: string
  label: string
  kind: 'proj' | 'scope' | 'topic'
}

function rowTags(item: EntryListItem): RowTag[] {
  const tags: RowTag[] = []
  for (const p of item.projects) tags.push({ key: `p:${p}`, label: p, kind: 'proj' })
  for (const e of item.envs) tags.push({ key: `e:${e}`, label: envDisplayName(e), kind: 'scope' })
  for (const r of item.realms) tags.push({ key: `r:${r}`, label: r, kind: 'scope' })
  if (tags.length > 0) return tags.slice(0, 4)
  return item.topics.slice(0, 2).map((t) => ({ key: `t:${t}`, label: t, kind: 'topic' as const }))
}

const summaryText = computed(() => {
  const loaded = props.items.length
  const total = props.counts?.[props.tab]
  if (!props.search.trim() && !hasFilters.value && total !== undefined) {
    return `共 ${total} 条记忆`
  }
  return `当前列表 ${loaded}${props.hasNextPage ? '+' : ''} 条记忆`
})

watch(
  () => props.selectedId,
  async (sid) => {
    if (!sid) return
    await nextTick()
    const rows = listScrollRef.value?.querySelectorAll<HTMLElement>('[data-short-id]')
    if (!rows) return
    for (const row of rows) {
      if (row.dataset.shortId === sid) {
        row.scrollIntoView({ block: 'nearest' })
        break
      }
    }
  },
)

defineExpose({ filterOpen })
</script>

<template>
  <div class="list-shell">
    <!-- 收敛式顶栏工具条：视图分段、搜索、多维筛选与主操作 -->
    <header class="list-toolbar" aria-label="筛选与操作栏">
      <div class="toolbar-row">
        <div class="view-tabs" role="tablist" aria-label="记忆视图">
          <button
            v-for="value in ENTRY_TABS"
            :key="value"
            type="button"
            role="tab"
            class="view-tab"
            :class="{ active: tab === value }"
            :aria-selected="tab === value"
            :title="
              value === 'pinned'
                ? '实线轨对应列表中的常驻记忆'
                : value === 'episodes'
                  ? '虚线轨对应列表中的近期会话摘要'
                  : undefined
            "
            @click="emit('update:tab', value)"
          >
            <span v-if="value === 'pinned'" class="rail-swatch solid" aria-hidden="true" />
            <span v-else-if="value === 'episodes'" class="rail-swatch dashed" aria-hidden="true" />
            <span>{{ entryTabLabels[value] }}</span>
            <span v-if="counts?.[value] !== undefined" class="tab-num">{{ counts[value] }}</span>
          </button>
        </div>

        <div class="search-wrap">
          <UInput
            id="memories-search"
            name="q"
            type="text"
            aria-label="搜索记忆"
            :model-value="search"
            :icon="icons.search"
            placeholder="搜索标题、正文、触发场景或短 ID"
            :ui="{ base: search ? 'text-[13px]/5 pe-9' : 'text-[13px]/5' }"
            class="w-full"
            @update:model-value="(v) => emit('update:search', String(v ?? ''))"
          >
            <template v-if="search" #trailing>
              <UButton
                :icon="icons.cancel"
                size="xs"
                color="neutral"
                variant="link"
                aria-label="清除搜索"
                @click="emit('update:search', '')"
              />
            </template>
          </UInput>
        </div>

        <UPopover v-model:open="filterOpen" :content="{ align: 'start', sideOffset: 6 }">
          <UButton
            color="neutral"
            variant="outline"
            :icon="icons.filter"
            :aria-expanded="filterOpen"
          >
            筛选
            <span v-if="activeFilters.length" class="filter-count">{{ activeFilters.length }}</span>
          </UButton>

          <template #content>
            <div class="filter-popover">
              <div class="popover-head">
                <span class="popover-title">多维筛选</span>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :disabled="!hasFilters"
                  @click="emit('clearFilters')"
                >
                  重置全部
                </UButton>
              </div>

              <div class="facet-group">
                <span class="facet-label">归属范围</span>
                <div class="facet-chips">
                  <button
                    v-for="opt in PROJECT_SCOPE_OPTIONS"
                    :key="opt.value"
                    type="button"
                    class="chip"
                    :class="{ active: projectScope === opt.value }"
                    @click="emit('update:projectScope', toggleValue(projectScope, opt.value))"
                  >
                    {{ opt.label }}
                  </button>
                </div>
              </div>

              <div v-if="facets?.topics.length" class="facet-group">
                <span class="facet-label">主题</span>
                <div class="facet-chips">
                  <button
                    v-for="t in facets.topics"
                    :key="`t:${t}`"
                    type="button"
                    class="chip"
                    :class="{ active: topic === t }"
                    @click="emit('update:topic', toggleValue(topic, t))"
                  >
                    {{ t }}
                  </button>
                </div>
              </div>

              <div v-if="facets?.projects.length" class="facet-group">
                <span class="facet-label">项目</span>
                <div class="facet-chips">
                  <button
                    v-for="p in facets.projects"
                    :key="`p:${p}`"
                    type="button"
                    class="chip"
                    :class="{ active: project === p }"
                    @click="emit('update:project', toggleValue(project, p))"
                  >
                    {{ p }}
                  </button>
                </div>
              </div>

              <div v-if="facets?.envs.length" class="facet-group">
                <span class="facet-label">环境</span>
                <div class="facet-chips">
                  <button
                    v-for="e in facets.envs"
                    :key="`e:${e}`"
                    type="button"
                    class="chip"
                    :class="{ active: env === e }"
                    @click="emit('update:env', toggleValue(env, e))"
                  >
                    {{ envDisplayName(e) }}
                  </button>
                </div>
              </div>

              <div v-if="facets?.realms.length" class="facet-group">
                <span class="facet-label">场域</span>
                <div class="facet-chips">
                  <button
                    v-for="r in facets.realms"
                    :key="`r:${r}`"
                    type="button"
                    class="chip"
                    :class="{ active: realm === r }"
                    @click="emit('update:realm', toggleValue(realm, r))"
                  >
                    {{ r }}
                  </button>
                </div>
              </div>
            </div>
          </template>
        </UPopover>

        <div class="toolbar-actions">
          <UButton
            :icon="icons.refresh"
            color="neutral"
            variant="ghost"
            :loading="query.isFetching.value && !fetchingNextPage"
            @click="emit('refresh')"
          >
            刷新
          </UButton>
          <UButton
            :icon="icons.capture"
            :title="`记录一条习惯、约定或事实更新，自动归并至既有记忆（${captureShortcut}）`"
            @click="emit('capture')"
          >
            随手记
            <span class="action-kbd" aria-hidden="true">{{ captureShortcut }}</span>
          </UButton>
          <UButton color="neutral" variant="outline" :icon="icons.add" @click="emit('create')">
            新建
          </UButton>
        </div>
      </div>

      <!-- 仅存在激活筛选时展示已选条件条 -->
      <div v-if="activeFilters.length" class="active-filters-bar">
        <span v-for="pill in activeFilters" :key="pill.key" class="active-pill">
          <span>{{ pill.label }}</span>
          <button
            type="button"
            class="pill-remove"
            :aria-label="`移除${pill.label}`"
            @click="removeFilter(pill.key)"
          >
            <UIcon :name="icons.cancel" class="pill-remove-icon" />
          </button>
        </span>
        <UButton size="xs" color="neutral" variant="ghost" @click="emit('clearFilters')">
          清除全部
        </UButton>
      </div>
    </header>

    <!-- 列表滚动主体 -->
    <section class="list-pane" :class="{ 'is-compact': compact }" aria-label="记忆列表">
      <div class="list-meta-bar">
        <span>{{ summaryText }}</span>
        <div v-if="!compact" class="list-hint" aria-hidden="true">
          <span>↑ ↓ 切换</span>
          <span>Esc 关闭详情</span>
          <span>{{ captureShortcut }} 随手记</span>
        </div>
      </div>

      <div ref="listScrollRef" class="list-scroll">
        <div v-if="query.isError.value" class="p-4">
          <ReadFailureNote :query="query" />
        </div>
        <div v-if="query.isPending.value" class="space-y-2 p-4">
          <USkeleton v-for="n in 6" :key="n" class="h-16 w-full" />
        </div>
        <template v-else-if="items.length">
          <ul role="listbox" aria-label="记忆清单">
            <li v-for="item in items" :key="item.shortId" role="none">
              <button
                type="button"
                role="option"
                class="entry-row"
                :class="{
                  selected: item.shortId === selectedId,
                  'is-pinned': item.isPinned,
                  'is-episode': item.kind === 'episode' && !item.isPinned,
                }"
                :data-short-id="item.shortId"
                :title="item.title"
                :aria-selected="item.shortId === selectedId"
                :aria-current="item.shortId === selectedId ? 'true' : undefined"
                @click="emit('select', item.shortId)"
              >
                <span class="row-main">
                  <span class="row-title">{{ item.title }}</span>
                  <span class="row-sub">
                    <span class="row-id">{{ item.shortId }}</span>
                    <template v-if="item.isPinned">
                      <span class="sub-dot" aria-hidden="true">·</span>
                      <span class="sub-status">常驻</span>
                    </template>
                    <template v-else-if="item.kind === 'episode'">
                      <span class="sub-dot" aria-hidden="true">·</span>
                      <span class="sub-status is-episode">摘要</span>
                    </template>
                    <template v-if="isExpired(item.validTo)">
                      <span class="sub-dot" aria-hidden="true">·</span>
                      <span class="sub-status is-warn">已过期</span>
                    </template>
                    <template v-if="item.snippet || item.disclosure">
                      <span class="sub-dot sub-disclosure-sep" aria-hidden="true">·</span>
                      <span class="row-disclosure">{{ item.snippet ?? item.disclosure }}</span>
                    </template>
                  </span>
                </span>

                <span class="row-aside">
                  <time
                    class="row-time"
                    :datetime="item.updatedAt"
                    :title="formatTime(item.updatedAt)"
                  >
                    {{ formatRelative(item.updatedAt) }}
                  </time>
                  <span v-if="rowTags(item).length" class="row-tags">
                    <span
                      v-for="tag in rowTags(item)"
                      :key="tag.key"
                      class="row-tag"
                      :class="`is-${tag.kind}`"
                    >
                      {{ tag.label }}
                    </span>
                  </span>
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
            search.trim() || hasFilters
              ? '暂无匹配记忆'
              : tab === 'trash'
                ? '回收站为空'
                : tab === 'episodes'
                  ? '暂无近期摘要'
                  : tab === 'pinned'
                    ? '暂无常驻记忆'
                    : tab === 'regular'
                      ? '暂无按需记忆'
                      : '暂无记忆'
          "
          :description="
            search.trim() || hasFilters
              ? '尝试调整关键词或清除筛选条件。'
              : tab === 'all'
                ? '使用随手记快速沉淀，或新建第一条正式记忆。'
                : null
          "
        >
          <template v-if="search.trim() || hasFilters" #actions>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              @click="(emit('clearFilters'), emit('update:search', ''))"
            >
              重置筛选
            </UButton>
            <UButton size="sm" :icon="icons.capture" @click="emit('capture')">随手记</UButton>
          </template>
          <template v-else-if="tab === 'all'" #actions>
            <UButton size="sm" :icon="icons.capture" @click="emit('capture')">随手记</UButton>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :icon="icons.add"
              @click="emit('create')"
            >
              新建记忆
            </UButton>
          </template>
        </EmptyState>
      </div>
    </section>
  </div>
</template>

<style scoped>
.list-shell {
  display: contents;
}
.list-toolbar {
  grid-column: 1 / -1;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.toolbar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.view-tabs {
  display: inline-flex;
  align-items: stretch;
  flex: none;
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--ui-border-accented);
  background: transparent;
}
.view-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-right: 1px solid var(--ui-border);
  font-size: 13px;
  color: var(--ui-text-muted);
  white-space: nowrap;
  cursor: pointer;
}
.view-tab:last-child {
  border-right: 0;
}
.view-tab:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.view-tab.active {
  background: var(--ui-selected);
  color: var(--ui-on-selected);
  font-weight: 500;
}
.tab-num {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.view-tab.active .tab-num {
  color: var(--ui-on-selected-muted);
}
/* 统一线轨图例：顶栏分段与列表左缘保持一致（实线=常驻，虚线=近期摘要） */
.rail-swatch {
  display: inline-block;
  flex: none;
  width: 3px;
  height: 12px;
}
.rail-swatch.solid {
  background: var(--ui-rule);
}
.rail-swatch.dashed {
  background: repeating-linear-gradient(to bottom, var(--ui-info) 0 3px, transparent 3px 6px);
}
.view-tab.active .rail-swatch.solid {
  background: var(--ui-on-selected);
}
.view-tab.active .rail-swatch.dashed {
  background: repeating-linear-gradient(
    to bottom,
    var(--ui-on-selected) 0 3px,
    transparent 3px 6px
  );
}
.search-wrap {
  flex: 1 1 14rem;
  min-width: 12rem;
  max-width: 26rem;
}
.filter-count {
  padding: 0 5px;
  background: var(--ui-selected);
  color: var(--ui-on-selected);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.4;
}
.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: none;
  margin-left: auto;
}
.action-kbd {
  font-family: var(--font-mono);
  font-size: 12px;
}
.filter-popover {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(32rem, calc(100vw - 2rem));
  max-height: 70vh;
  overflow-y: auto;
  padding: 14px 16px;
}
.popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
}
.popover-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.facet-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.facet-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.facet-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.chip:hover {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.chip.active {
  border-color: var(--ui-selected);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.active-filters-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.active-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 7px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-elevated);
  font-size: 12px;
  color: var(--ui-text-highlighted);
}
.pill-remove {
  display: inline-flex;
  align-items: center;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.pill-remove:hover {
  color: var(--ui-error);
}
.pill-remove-icon {
  display: inline-block;
  width: 12px;
  height: 12px;
}
.list-pane {
  grid-column: 1;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg);
}
.list-meta-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 36px;
  min-height: 36px;
  padding: 0 20px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.list-hint {
  display: flex;
  align-items: center;
  gap: 12px;
}
.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
/* 全宽清单行：主行纯粹放标题以保持左缘严格对齐，左缘 3px 静默线轨不占正文宽度 */
.entry-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 20px;
  width: 100%;
  padding: 12px 20px;
  border-bottom: 1px solid var(--ui-border-muted);
  background: var(--ui-bg);
  text-align: left;
  cursor: pointer;
}
.entry-row.is-pinned::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--ui-rule);
}
.entry-row.is-episode::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: repeating-linear-gradient(to bottom, var(--ui-info) 0 5px, transparent 5px 9px);
}
.entry-row:hover {
  background: var(--ui-bg-muted);
}
.entry-row.selected,
.entry-row.selected:hover {
  background: var(--ui-selected);
  color: var(--ui-on-selected);
  border-bottom-color: var(--ui-selected);
}
.entry-row.selected.is-pinned::before {
  background: var(--ui-on-selected);
}
.entry-row.selected.is-episode::before {
  background: repeating-linear-gradient(
    to bottom,
    var(--ui-on-selected-muted) 0 5px,
    transparent 5px 9px
  );
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.row-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ui-text-highlighted);
}
.entry-row.selected .row-title {
  color: var(--ui-on-selected);
}
.row-sub {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.entry-row.selected .row-sub {
  color: var(--ui-on-selected-muted);
}
.row-id {
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.entry-row.selected .row-id {
  color: var(--ui-on-selected-muted);
}
.sub-dot {
  flex: none;
  color: var(--ui-border-accented);
}
.entry-row.selected .sub-dot {
  color: var(--ui-on-selected-muted);
}
.sub-status {
  flex: none;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.sub-status.is-episode {
  color: var(--ui-info);
}
.sub-status.is-warn {
  color: var(--ui-warning);
}
.entry-row.selected .sub-status,
.entry-row.selected .sub-status.is-episode,
.entry-row.selected .sub-status.is-warn {
  color: var(--ui-on-selected);
}
.row-disclosure {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-aside {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  gap: 6px;
  flex: none;
  min-width: 9rem;
}
.row-time {
  font-size: 12px;
  color: var(--ui-text-dimmed);
  white-space: nowrap;
}
.entry-row.selected .row-time {
  color: var(--ui-on-selected-muted);
}
.row-tags {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.row-tag {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-toned);
  white-space: nowrap;
}
.row-tag.is-proj {
  border-color: var(--ui-border-accented);
  font-family: var(--font-mono);
}
.row-tag.is-topic {
  color: var(--ui-text-muted);
}
.entry-row.selected .row-tag {
  border-color: var(--ui-on-selected-muted);
  background: transparent;
  color: var(--ui-on-selected-muted);
}
/* 抽屉收窄（compact）态：标题保持完整 2 行可读，召回说明隐藏，时间与标签转至底部一行 */
.list-pane.is-compact .list-meta-bar {
  padding: 0 16px;
}
.list-pane.is-compact .entry-row {
  grid-template-columns: minmax(0, 1fr);
  padding: 11px 16px;
  gap: 4px;
}
.list-pane.is-compact .row-title {
  font-size: 14px;
}
.list-pane.is-compact .row-disclosure,
.list-pane.is-compact .sub-disclosure-sep {
  display: none;
}
.list-pane.is-compact .row-aside {
  flex-direction: row-reverse;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  width: 100%;
}
.list-pane.is-compact .row-tags {
  justify-content: flex-start;
}
@media (max-width: 1023.98px) {
  .list-toolbar {
    padding: 10px 14px;
  }
  .view-tab {
    padding: 0 8px;
  }
  .toolbar-actions {
    margin-left: 0;
  }
  .list-meta-bar {
    padding: 0 14px;
  }
  .list-hint {
    display: none;
  }
  .entry-row {
    grid-template-columns: minmax(0, 1fr);
    padding: 11px 14px;
    gap: 4px;
  }
  .row-title {
    font-size: 14px;
  }
  .row-disclosure,
  .sub-disclosure-sep {
    display: none;
  }
  .row-aside {
    flex-direction: row-reverse;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    width: 100%;
  }
  .row-tags {
    justify-content: flex-start;
  }
}
</style>
