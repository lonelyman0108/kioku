<script setup lang="ts">
import {
  effectiveBootMode,
  type EntryFacetsSummary,
  type EntryListItem,
  type EntryTab,
  type EntryTabCounts,
  type PinnedGroup,
  type ProjectScope,
} from '@kioku/contracts'
import { computed, nextTick, ref, watch } from 'vue'

import { icons } from '../icons'
import { bootModeLabels, entryTabIcons, entryTabLabels, envDisplayName } from '../labels'
import { splitWikiLinks } from '../markdown'
import type { ReadState } from '../query'
import { runtimeName } from '../runtimes'
import { formatRelative, formatTime, isExpired } from '../time'
import EmptyState from './ui/EmptyState.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import WikiText from './ui/WikiText.vue'

const GLOBAL_FULL_CHAR_CAP = 3_500
const SINGLE_GLOBAL_FULL_WARN_CHARS = 1_200

const props = withDefaults(
  defineProps<{
    tab: EntryTab
    pinnedGroup?: PinnedGroup | null
    search: string
    env: string | null
    realm: string | null
    project: string | null
    runtime: string | null
    topic: string | null
    projectScope: ProjectScope | null
    selectedId: string | null
    items: readonly EntryListItem[]
    linkedTitles?: Readonly<Record<string, string>> | null
    facets: EntryFacetsSummary | null
    counts: EntryTabCounts | null
    query: ReadState & {
      isError: { readonly value: boolean }
      isPending: { readonly value: boolean }
    }
    hasNextPage: boolean
    fetchingNextPage: boolean
    hasChatModel?: boolean
    batchBusy?: boolean
  }>(),
  { hasChatModel: false, batchBusy: false, pinnedGroup: null, linkedTitles: null },
)

const emit = defineEmits<{
  'update:pinnedGroup': [value: PinnedGroup | null]
  'update:search': [value: string]
  'update:env': [value: string | null]
  'update:realm': [value: string | null]
  'update:project': [value: string | null]
  'update:runtime': [value: string | null]
  'update:topic': [value: string | null]
  'update:projectScope': [value: ProjectScope | null]
  select: [shortId: string]
  capture: []
  create: []
  openRail: []
  loadMore: []
  clearFilters: []
  resetFilters: []
  batchOrganize: [mode: 'tidy' | 'cross_memory', shortIds: string[]]
}>()

const filterOpen = ref(false)
const listScrollRef = ref<HTMLElement | null>(null)
const batchMode = ref(false)
const selectedBatchIds = ref<string[]>([])
const BATCH_MAX = 20

const canUseBatch = computed(
  () => props.hasChatModel && props.tab !== 'episodes' && props.tab !== 'trash',
)

watch(canUseBatch, (allowed) => {
  if (!allowed) {
    batchMode.value = false
    selectedBatchIds.value = []
  }
})

function toggleBatchMode() {
  batchMode.value = !batchMode.value
  selectedBatchIds.value = []
}

function toggleBatchItem(item: EntryListItem) {
  if (item.kind !== 'entry') return
  const sid = item.shortId
  if (selectedBatchIds.value.includes(sid)) {
    selectedBatchIds.value = selectedBatchIds.value.filter((id) => id !== sid)
    return
  }
  if (selectedBatchIds.value.length >= BATCH_MAX) return
  selectedBatchIds.value = [...selectedBatchIds.value, sid]
}

function onRowClick(item: EntryListItem) {
  if (batchMode.value) {
    toggleBatchItem(item)
    return
  }
  emit('select', item.shortId)
}

function submitBatch(mode: 'tidy' | 'cross_memory') {
  if (selectedBatchIds.value.length < 2 || props.batchBusy) return
  emit('batchOrganize', mode, [...selectedBatchIds.value])
}

function exitBatchMode() {
  batchMode.value = false
  selectedBatchIds.value = []
}

const PROJECT_SCOPE_OPTIONS: { value: ProjectScope; label: string }[] = [
  { value: 'unassigned', label: '无项目归属' },
  { value: 'assigned', label: '已关联项目' },
]

interface ActiveFilterPill {
  key: 'projectScope' | 'topic' | 'project' | 'runtime' | 'env' | 'realm'
  label: string
  icon: string
}

const activeFilters = computed<ActiveFilterPill[]>(() => {
  const pills: ActiveFilterPill[] = []
  if (props.projectScope) {
    pills.push({
      key: 'projectScope',
      label: `归属：${props.projectScope === 'unassigned' ? '无项目归属' : '已关联项目'}`,
      icon: icons.projectScope,
    })
  }
  if (props.topic) pills.push({ key: 'topic', label: `主题：${props.topic}`, icon: icons.topic })
  if (props.project) {
    pills.push({ key: 'project', label: `项目：${props.project}`, icon: icons.project })
  }
  if (props.runtime) {
    pills.push({
      key: 'runtime',
      label: `客户端：${runtimeName(props.runtime)}`,
      icon: icons.terminal,
    })
  }
  if (props.env) {
    pills.push({ key: 'env', label: `环境：${envDisplayName(props.env)}`, icon: icons.env })
  }
  if (props.realm) pills.push({ key: 'realm', label: `场域：${props.realm}`, icon: icons.realm })
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
  else if (key === 'runtime') emit('update:runtime', null)
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
  for (const rt of item.runtimes) {
    tags.push({ key: `rt:${rt}`, label: runtimeName(rt), kind: 'scope' })
  }
  for (const e of item.envs) tags.push({ key: `e:${e}`, label: envDisplayName(e), kind: 'scope' })
  for (const r of item.realms) tags.push({ key: `r:${r}`, label: r, kind: 'scope' })
  if (tags.length > 0) return tags.slice(0, 3)
  return item.topics.slice(0, 2).map((t) => ({ key: `t:${t}`, label: t, kind: 'topic' as const }))
}

function isGlobalEntry(item: EntryListItem): boolean {
  return (
    item.envs.length === 0 &&
    item.realms.length === 0 &&
    item.projects.length === 0 &&
    item.runtimes.length === 0
  )
}

function entryBootChars(item: EntryListItem): number {
  return (item.charCount ?? 0) + item.title.length
}

const displayItems = computed<readonly EntryListItem[]>(() => {
  if (props.tab === 'pinned' && props.pinnedGroup === 'global_full' && !props.search.trim()) {
    return [...props.items].sort((a, b) => entryBootChars(b) - entryBootChars(a))
  }
  return props.items
})

function rowBootStatusLabel(item: EntryListItem): string {
  const mode = effectiveBootMode(item)
  if (props.tab !== 'pinned') return bootModeLabels[mode]
  if (mode === 'index') return '目录常驻'
  if (mode === 'full') return isGlobalEntry(item) ? '全局全文' : '场景全文'
  return bootModeLabels[mode]
}

function isOversizedGlobalPinned(item: EntryListItem): boolean {
  return (
    props.tab === 'pinned' &&
    effectiveBootMode(item) === 'full' &&
    isGlobalEntry(item) &&
    entryBootChars(item) > SINGLE_GLOBAL_FULL_WARN_CHARS
  )
}

function rowSubtitle(item: EntryListItem): { isChange: boolean; text: string } | null {
  const lastChange = item.lastChangeSummary?.trim()
  if (lastChange) return { isChange: true, text: lastChange }
  const fallback = item.snippet?.trim() || item.summary?.trim() || item.disclosure?.trim()
  if (fallback) return { isChange: false, text: fallback }
  return null
}

function hasRowLeadingMeta(item: EntryListItem): boolean {
  return item.isPinned || item.kind === 'episode'
}

function hasRowSub(item: EntryListItem): boolean {
  return hasRowLeadingMeta(item) || isExpired(item.validTo) || rowSubtitle(item) !== null
}

function resolveWikiPlainText(text: string): string {
  const titles = props.linkedTitles
  return splitWikiLinks(text)
    .map((seg) => {
      if (!seg.link) return seg.text
      const { shortId, alias } = seg.link
      const resolved = titles && Object.hasOwn(titles, shortId) ? titles[shortId] : null
      return alias ?? resolved ?? shortId
    })
    .join('')
}

function subtitleTitle(item: EntryListItem): string | undefined {
  const sub = rowSubtitle(item)
  if (!sub) return undefined
  const resolved = resolveWikiPlainText(sub.text)
  return sub.isChange ? `近改：${resolved}` : resolved
}

const pinnedWatermark = computed(() => {
  if (props.tab !== 'pinned' || !props.counts) return null
  const globalCount = props.counts.globalFullPinnedCount ?? 0
  const globalChars = props.counts.globalFullPinnedChars ?? 0
  const overChars = Math.max(0, globalChars - GLOBAL_FULL_CHAR_CAP)
  return {
    globalCount,
    globalChars,
    overChars,
    globalOverCap: globalChars > GLOBAL_FULL_CHAR_CAP,
  }
})

const pinnedGroupLabel: Record<PinnedGroup, string> = {
  global_full: '全局全文',
  scoped_full: '场景全文',
  index: '目录常驻',
}

const viewContextLabel = computed(() => {
  if (props.tab === 'pinned' && props.pinnedGroup) {
    return `${pinnedGroupLabel[props.pinnedGroup]} · ${props.items.length}${props.hasNextPage ? '+' : ''} 条`
  }
  const base = entryTabLabels[props.tab]
  const loaded = props.items.length
  const total = props.counts?.[props.tab]
  if (!props.search.trim() && !hasFilters.value && total !== undefined) {
    return `${base} · ${total} 条`
  }
  return `${base} · 命中 ${loaded}${props.hasNextPage ? '+' : ''} 条`
})

watch(
  () => props.selectedId,
  async (sid) => {
    if (!sid) return
    await nextTick()
    const rows = listScrollRef.value?.querySelectorAll<HTMLElement>('.entry-row[data-short-id]')
    if (!rows) return
    for (const row of rows) {
      if (row.dataset.shortId === sid) {
        row.scrollIntoView({ block: 'nearest' })
        break
      }
    }
  },
)

defineExpose({ filterOpen, exitBatchMode, displayItems })
</script>

<template>
  <section class="list-pane" aria-label="记忆列表">
    <!-- 窄屏目录抽屉入口条（合并视图计数与批量开关，避免下方重复一行） -->
    <div class="mobile-rail-bar">
      <div class="mobile-rail-left">
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :icon="icons.menu"
          class="shrink-0 whitespace-nowrap"
          @click="emit('openRail')"
        >
          目录
        </UButton>
        <span class="mobile-view-label tabular-nums" :title="viewContextLabel">
          {{ viewContextLabel }}
        </span>
      </div>
      <div class="meta-right">
        <button
          v-if="hasFilters || search.trim() || pinnedGroup !== null"
          type="button"
          class="meta-link"
          @click="emit('resetFilters')"
        >
          清除筛选
        </button>
        <UButton
          v-if="canUseBatch && (batchMode || displayItems.length >= 2)"
          size="xs"
          :color="batchMode ? 'primary' : 'neutral'"
          :variant="batchMode ? 'solid' : 'ghost'"
          :icon="batchMode ? icons.cancel : icons.listChecks"
          class="shrink-0 whitespace-nowrap"
          @click="toggleBatchMode"
        >
          {{ batchMode ? '退出批量' : '批量整理' }}
        </UButton>
      </div>
    </div>

    <!-- 中栏顶部：精简筛选框 + 多维筛选 + 新建 -->
    <header class="list-head" aria-label="列表筛选与新建">
      <div class="search-wrap">
        <UInput
          id="memories-search"
          name="q"
          type="text"
          size="sm"
          aria-label="筛选当前列表"
          :model-value="search"
          :icon="icons.search"
          placeholder="筛选当前列表…"
          :ui="{ base: search ? 'text-[13px]/5 pe-8' : 'text-[13px]/5' }"
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

      <UPopover v-model:open="filterOpen" :content="{ align: 'end', sideOffset: 6 }">
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          :icon="icons.filter"
          :aria-expanded="filterOpen"
          class="shrink-0"
        >
          <span>筛选</span>
          <span v-if="activeFilters.length" class="filter-count tabular-nums">
            {{ activeFilters.length }}
          </span>
        </UButton>

        <template #content>
          <div class="filter-popover">
            <div class="popover-head">
              <span class="popover-title">
                <UIcon :name="icons.filter" class="popover-title-icon" aria-hidden="true" />
                <span>多维筛选</span>
              </span>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="icons.restore"
                :disabled="!hasFilters"
                @click="emit('clearFilters')"
              >
                重置全部
              </UButton>
            </div>

            <div class="facet-group">
              <span class="facet-label">
                <UIcon :name="icons.projectScope" class="facet-icon" aria-hidden="true" />
                <span>归属范围</span>
              </span>
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
              <span class="facet-label">
                <UIcon :name="icons.topic" class="facet-icon" aria-hidden="true" />
                <span>主题</span>
              </span>
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
              <span class="facet-label">
                <UIcon :name="icons.project" class="facet-icon" aria-hidden="true" />
                <span>项目</span>
              </span>
              <div class="facet-chips">
                <button
                  v-for="p in facets.projects"
                  :key="`p:${p}`"
                  type="button"
                  class="chip font-mono"
                  :class="{ active: project === p }"
                  @click="emit('update:project', toggleValue(project, p))"
                >
                  {{ p }}
                </button>
              </div>
            </div>

            <div v-if="facets?.runtimes?.length" class="facet-group">
              <span class="facet-label">
                <UIcon :name="icons.terminal" class="facet-icon" aria-hidden="true" />
                <span>客户端</span>
              </span>
              <div class="facet-chips">
                <button
                  v-for="rt in facets.runtimes"
                  :key="`rt:${rt}`"
                  type="button"
                  class="chip"
                  :class="{ active: runtime === rt }"
                  @click="emit('update:runtime', toggleValue(runtime, rt))"
                >
                  {{ runtimeName(rt) }}
                </button>
              </div>
            </div>

            <div v-if="facets?.envs.length" class="facet-group">
              <span class="facet-label">
                <UIcon :name="icons.env" class="facet-icon" aria-hidden="true" />
                <span>环境</span>
              </span>
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
              <span class="facet-label">
                <UIcon :name="icons.realm" class="facet-icon" aria-hidden="true" />
                <span>场域</span>
              </span>
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

      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        :icon="icons.add"
        title="新建正式记忆"
        class="shrink-0"
        @click="emit('create')"
      >
        新建
      </UButton>
    </header>

    <!-- 上下文薄条：视图计数、清除筛选与低噪批量整理开关 -->
    <div class="list-meta-bar">
      <span class="meta-summary tabular-nums">{{ viewContextLabel }}</span>
      <div class="meta-right">
        <button
          v-if="hasFilters || search.trim() || pinnedGroup !== null"
          type="button"
          class="meta-link"
          @click="emit('resetFilters')"
        >
          清除筛选
        </button>
        <UButton
          v-if="canUseBatch && (batchMode || displayItems.length >= 2)"
          size="xs"
          :color="batchMode ? 'primary' : 'neutral'"
          :variant="batchMode ? 'solid' : 'ghost'"
          :icon="batchMode ? icons.cancel : icons.listChecks"
          @click="toggleBatchMode"
        >
          {{ batchMode ? '退出批量' : '批量整理' }}
        </UButton>
      </div>
    </div>

    <!-- 仅在存在激活筛选时显示可移除条件条 -->
    <div v-if="activeFilters.length" class="active-filters-bar">
      <span v-for="pill in activeFilters" :key="pill.key" class="active-pill">
        <UIcon :name="pill.icon" class="pill-dim-icon" aria-hidden="true" />
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
    </div>

    <!-- 全局全文超预算紧凑提示 -->
    <div v-if="pinnedWatermark?.globalOverCap" class="pinned-overcap-wrap">
      <div class="pinned-overcap-banner" role="status">
        <div class="overcap-body">
          <UIcon :name="icons.warning" class="overcap-icon" aria-hidden="true" />
          <p
            class="overcap-text tabular-nums"
            :title="`全局全文已超出 ${GLOBAL_FULL_CHAR_CAP.toLocaleString()} 字预算上限（当前 ${pinnedWatermark.globalChars.toLocaleString()} 字），建议改为目录常驻或补充场景限定`"
          >
            全局全文超预算 +{{ pinnedWatermark.overChars.toLocaleString() }} 字
          </p>
        </div>
        <button
          v-if="pinnedGroup !== 'global_full'"
          type="button"
          class="meta-link"
          @click="emit('update:pinnedGroup', 'global_full')"
        >
          看这 {{ pinnedWatermark.globalCount }} 条
        </button>
        <button v-else type="button" class="meta-link" @click="emit('update:pinnedGroup', null)">
          全部常驻
        </button>
      </div>
    </div>

    <!-- 列表滚动区 -->
    <div ref="listScrollRef" class="list-scroll">
      <div v-if="query.isError.value" class="p-4">
        <ReadFailureNote :query="query" />
      </div>
      <div v-if="query.isPending.value" class="space-y-2 p-3">
        <USkeleton v-for="n in 7" :key="n" class="h-16 w-full" />
      </div>
      <template v-else-if="displayItems.length">
        <ul role="listbox" aria-label="记忆清单">
          <li v-for="item in displayItems" :key="item.shortId" role="none">
            <div
              role="option"
              tabindex="0"
              class="entry-row"
              :class="{
                selected: item.shortId === selectedId,
                'has-batch-check': batchMode && item.kind === 'entry',
                'is-pinned': effectiveBootMode(item) === 'full',
                'is-pinned-index': effectiveBootMode(item) === 'index',
                'is-episode': item.kind === 'episode' && !item.isPinned,
              }"
              :data-short-id="item.shortId"
              :title="`${item.title}（${item.shortId}）`"
              :aria-selected="
                batchMode ? selectedBatchIds.includes(item.shortId) : item.shortId === selectedId
              "
              :aria-current="!batchMode && item.shortId === selectedId ? 'true' : undefined"
              @click="onRowClick(item)"
              @keydown.enter.self="onRowClick(item)"
              @keydown.space.prevent.self="onRowClick(item)"
            >
              <span
                v-if="batchMode && item.kind === 'entry'"
                class="batch-check"
                aria-hidden="true"
              >
                <input
                  type="checkbox"
                  tabindex="-1"
                  :checked="selectedBatchIds.includes(item.shortId)"
                  :disabled="
                    !selectedBatchIds.includes(item.shortId) && selectedBatchIds.length >= BATCH_MAX
                  "
                  readonly
                />
              </span>

              <span class="row-main">
                <span class="row-head">
                  <span class="row-title">{{ item.title }}</span>
                  <time
                    class="row-time tabular-nums"
                    :datetime="item.updatedAt"
                    :title="formatTime(item.updatedAt)"
                  >
                    {{ formatRelative(item.updatedAt) }}
                  </time>
                </span>

                <span v-if="hasRowSub(item)" class="row-sub">
                  <template v-if="item.isPinned">
                    <span
                      class="sub-status"
                      :class="{ 'is-index': effectiveBootMode(item) === 'index' }"
                    >
                      <UIcon
                        :name="effectiveBootMode(item) === 'index' ? icons.bookmark : icons.pin"
                        class="sub-status-icon"
                        aria-hidden="true"
                      />
                      <span>{{ rowBootStatusLabel(item) }}</span>
                    </span>
                    <span
                      v-if="tab === 'pinned'"
                      class="sub-chars tabular-nums"
                      :class="{ 'is-warn': isOversizedGlobalPinned(item) }"
                      :title="
                        isOversizedGlobalPinned(item)
                          ? '单条超过 1,200 字建议上限，建议改为目录常驻或补充场景限定'
                          : '记忆总字数（含标题与正文）'
                      "
                    >
                      {{ entryBootChars(item).toLocaleString() }} 字
                    </span>
                  </template>
                  <template v-else-if="item.kind === 'episode'">
                    <span class="sub-status is-episode">
                      <UIcon
                        :name="icons.messageSquare"
                        class="sub-status-icon"
                        aria-hidden="true"
                      />
                      <span>摘要</span>
                    </span>
                  </template>
                  <template v-if="isExpired(item.validTo)">
                    <span v-if="hasRowLeadingMeta(item)" class="sub-dot" aria-hidden="true">·</span>
                    <span class="sub-status is-warn">
                      <UIcon :name="icons.clock" class="sub-status-icon" aria-hidden="true" />
                      <span>已过期</span>
                    </span>
                  </template>
                  <template v-if="rowSubtitle(item)">
                    <span
                      v-if="hasRowLeadingMeta(item) || isExpired(item.validTo)"
                      class="sub-dot"
                      aria-hidden="true"
                      >·</span
                    >
                    <span class="row-disclosure" :title="subtitleTitle(item)">
                      <span v-if="rowSubtitle(item)!.isChange" class="sub-change-prefix"
                        >近改：</span
                      ><WikiText
                        :text="rowSubtitle(item)!.text"
                        :titles="linkedTitles"
                        :interactive="!batchMode"
                        compact
                        @open="emit('select', $event)"
                      />
                    </span>
                  </template>
                </span>

                <span v-if="rowTags(item).length" class="row-tags">
                  <span
                    v-for="tag in rowTags(item)"
                    :key="tag.key"
                    class="row-tag"
                    :class="`is-${tag.kind}`"
                    :title="
                      tag.kind === 'topic' ? `主题标签：${tag.label}（不限定适用场景）` : undefined
                    "
                  >
                    <template v-if="tag.kind === 'topic'">#{{ tag.label }}</template>
                    <template v-else>{{ tag.label }}</template>
                  </span>
                </span>
              </span>
            </div>
          </li>
        </ul>

        <div v-if="hasNextPage" class="flex justify-center py-3">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.chevronsDown"
            :loading="fetchingNextPage"
            @click="emit('loadMore')"
          >
            加载更多
          </UButton>
        </div>
      </template>

      <EmptyState
        v-else-if="!query.isError.value"
        :icon="search.trim() || hasFilters ? icons.search : entryTabIcons[tab]"
        :title="
          search.trim() || hasFilters
            ? '暂无匹配记忆'
            : tab === 'pinned' && pinnedGroup
              ? '当前分组暂无常驻记忆'
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
            : tab === 'pinned' && pinnedGroup
              ? '该常驻分组下尚无记忆，可切换回全部常驻查看。'
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
            :icon="icons.restore"
            @click="emit('resetFilters')"
          >
            重置筛选
          </UButton>
          <UButton size="sm" :icon="icons.capture" @click="emit('capture')">随手记</UButton>
        </template>
        <template v-else-if="tab === 'pinned' && pinnedGroup" #actions>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.restore"
            @click="emit('update:pinnedGroup', null)"
          >
            显示全部常驻
          </UButton>
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

    <div v-if="batchMode" class="batch-bar" role="region" aria-label="批量整理操作栏">
      <span class="batch-status tabular-nums">
        已选 {{ selectedBatchIds.length }} / {{ BATCH_MAX }} 条
      </span>
      <div class="batch-actions">
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :icon="icons.tidy"
          :loading="batchBusy"
          :disabled="selectedBatchIds.length < 2"
          @click="submitBatch('tidy')"
        >
          规范所选
        </UButton>
        <UButton
          size="xs"
          :icon="icons.links"
          :loading="batchBusy"
          :disabled="selectedBatchIds.length < 2"
          @click="submitBatch('cross_memory')"
        >
          查重与关联
        </UButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.list-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--ui-bg);
}
.mobile-rail-bar {
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.mobile-rail-left {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mobile-view-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.list-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.search-wrap {
  flex: 1 1 0;
  min-width: 0;
}
.filter-count {
  padding: 0 4px;
  background: var(--ui-selected);
  color: var(--ui-on-selected);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.35;
}
.filter-popover {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(26rem, calc(100vw - 2rem));
  max-height: min(70vh, calc(var(--reka-popover-content-available-height, 70vh) - 12px));
  overflow-y: auto;
  padding: 14px 16px;
}
.filter-popover > * {
  flex-shrink: 0;
}
.popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
}
.popover-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.popover-title-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.facet-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.facet-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.facet-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
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
.list-meta-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 34px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.meta-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.meta-link {
  font-size: 12px;
  color: var(--ui-text-toned);
  text-decoration: underline;
  text-underline-offset: 2px;
  white-space: nowrap;
  cursor: pointer;
}
.meta-link:hover {
  color: var(--ui-text-highlighted);
}
.active-filters-bar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.active-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-elevated);
  font-size: 12px;
  color: var(--ui-text-highlighted);
}
.pill-dim-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-muted);
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
  flex: none;
  width: 12px;
  height: 12px;
}
.pinned-overcap-wrap {
  flex: none;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.pinned-overcap-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-left: 3px solid var(--ui-warning);
  background: var(--ui-bg-bright);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-toned);
}
.overcap-body {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.overcap-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-warning);
}
.overcap-text {
  margin: 0;
  min-width: 0;
}
.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.entry-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 10px 12px 10px 14px;
  border-bottom: 1px solid var(--ui-border-muted);
  background: var(--ui-bg);
  text-align: left;
  cursor: pointer;
}
.entry-row:focus-visible {
  outline-offset: -2px;
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
.entry-row.is-pinned-index::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: repeating-linear-gradient(to bottom, var(--ui-rule) 0 4px, transparent 4px 7px);
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
  --wiki-chip-bg: transparent;
  --wiki-chip-fg: var(--ui-on-selected);
  --wiki-chip-border: var(--ui-on-selected-muted);
  --wiki-chip-icon: var(--ui-on-selected-muted);
  --wiki-chip-hover-border: var(--ui-on-selected);
  --wiki-chip-hover-bg: transparent;
  --wiki-chip-hover-icon: var(--ui-on-selected);
  --wiki-chip-missing-fg: var(--ui-on-selected-muted);
}
.entry-row.selected.is-pinned::before {
  background: var(--ui-on-selected);
}
.entry-row.selected.is-pinned-index::before {
  background: repeating-linear-gradient(
    to bottom,
    var(--ui-on-selected-muted) 0 4px,
    transparent 4px 7px
  );
}
.entry-row.selected.is-episode::before {
  background: repeating-linear-gradient(
    to bottom,
    var(--ui-on-selected-muted) 0 5px,
    transparent 5px 9px
  );
}
.batch-check {
  display: inline-flex;
  align-items: flex-start;
  padding-top: 3px;
  flex: none;
}
.batch-check input[type='checkbox'] {
  pointer-events: none;
  accent-color: var(--ui-primary);
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.row-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ui-text-highlighted);
}
.entry-row.selected .row-title {
  color: var(--ui-on-selected);
}
.row-time {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
  white-space: nowrap;
}
.entry-row.selected .row-time {
  color: var(--ui-on-selected-muted);
}
.row-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.entry-row.selected .row-sub {
  color: var(--ui-on-selected-muted);
}
.sub-chars {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.sub-chars.is-warn {
  color: var(--ui-warning);
  font-weight: 500;
}
.entry-row.selected .sub-chars {
  color: var(--ui-on-selected-muted);
}
.entry-row.selected .sub-chars.is-warn {
  color: var(--ui-on-selected);
}
.sub-dot {
  flex: none;
  color: var(--ui-border-accented);
}
.entry-row.selected .sub-dot {
  color: var(--ui-on-selected-muted);
}
.sub-status {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.sub-status-icon {
  display: inline-block;
  flex: none;
  width: 11px;
  height: 11px;
}
.sub-status.is-index {
  color: var(--ui-text-toned);
}
.sub-status.is-episode {
  color: var(--ui-info);
}
.sub-status.is-warn {
  color: var(--ui-warning);
}
.entry-row.selected .sub-status,
.entry-row.selected .sub-status.is-index,
.entry-row.selected .sub-status.is-episode,
.entry-row.selected .sub-status.is-warn {
  color: var(--ui-on-selected);
}
.row-disclosure {
  flex: 1 1 auto;
  min-width: 0;
  overflow: clip;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-disclosure :deep(.wiki-chip.is-compact) {
  font-size: 12px;
  line-height: 1.3;
  vertical-align: 0;
}
.sub-change-prefix {
  color: var(--ui-text-toned);
  font-weight: 500;
}
.entry-row.selected .sub-change-prefix {
  color: var(--ui-on-selected);
}
.row-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.row-tag {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
}
.row-tag.is-proj {
  font-family: var(--font-mono);
  color: var(--ui-text-toned);
}
.entry-row.selected .row-tag {
  border-color: color-mix(in srgb, var(--ui-on-selected) 35%, transparent);
  background: transparent;
  color: var(--ui-on-selected-muted);
}
.batch-bar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.batch-status {
  font-size: 12px;
  color: var(--ui-text-toned);
}
.batch-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
@media (max-width: 1279.98px) {
  .mobile-rail-bar {
    display: flex;
  }
  .list-meta-bar {
    display: none;
  }
}
@media (max-width: 767.98px), (pointer: coarse) {
  .mobile-rail-bar {
    min-height: 44px;
  }
  .chip {
    min-height: 32px;
    padding: 4px 9px;
  }
}
</style>
