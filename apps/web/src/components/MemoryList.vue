<script setup lang="ts">
import {
  effectiveBootMode,
  ENTRY_TABS,
  type EntryFacetsSummary,
  type EntryListItem,
  type EntryTab,
  type EntryTabCounts,
  type PinnedGroup,
  type ProjectScope,
} from '@kioku/contracts'
import { useKbd } from '@nuxt/ui/composables'
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
    compact?: boolean
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
  { compact: false, hasChatModel: false, batchBusy: false, pinnedGroup: null, linkedTitles: null },
)

const emit = defineEmits<{
  'update:tab': [value: EntryTab]
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
  refresh: []
  loadMore: []
  clearFilters: []
  previewBoot: []
  batchOrganize: [mode: 'tidy' | 'cross_memory', shortIds: string[]]
}>()

const { getKbdKey } = useKbd()
const captureShortcut = computed(() => {
  const mod = getKbdKey('meta')?.trim() || 'Ctrl'
  return mod === '⌘' ? '⌘J' : `${mod}+J`
})

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
  if (tags.length > 0) return tags.slice(0, 4)
  return item.topics.slice(0, 2).map((t) => ({ key: `t:${t}`, label: t, kind: 'topic' as const }))
}

const GLOBAL_FULL_CHAR_CAP = 3_500
const SINGLE_GLOBAL_FULL_WARN_CHARS = 1_200

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
  if (props.tab === 'pinned' && props.pinnedGroup === 'global_full') {
    return [...props.items].sort((a, b) => entryBootChars(b) - entryBootChars(a))
  }
  return props.items
})

function togglePinnedGroup(group: PinnedGroup) {
  emit('update:pinnedGroup', props.pinnedGroup === group ? null : group)
}

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
  const scopedCount = props.counts.scopedFullPinnedCount ?? 0
  const indexCount = props.counts.indexPinnedCount ?? 0
  const overChars = Math.max(0, globalChars - GLOBAL_FULL_CHAR_CAP)
  return {
    globalCount,
    globalChars,
    scopedCount,
    indexCount,
    overChars,
    globalOverCap: globalChars > GLOBAL_FULL_CHAR_CAP,
  }
})

const isFiltered = computed(() => Boolean(props.search.trim()) || hasFilters.value)

const summaryText = computed<string | null>(() => {
  const loaded = props.items.length
  const total = props.counts?.[props.tab]
  if (!isFiltered.value && total !== undefined) {
    if (props.tab === 'pinned' && pinnedWatermark.value) return null
    return props.tab === 'pinned' ? `共 ${total} 条常驻` : `共 ${total} 条记忆`
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

defineExpose({ filterOpen, exitBatchMode, displayItems })
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
            <UIcon :name="entryTabIcons[value]" class="view-tab-icon" aria-hidden="true" />
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
            placeholder="搜索标题、正文或触发场景"
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
                    class="chip"
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
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="icons.restore"
          @click="emit('clearFilters')"
        >
          清除全部
        </UButton>
      </div>
    </header>

    <!-- 列表滚动主体 -->
    <section class="list-pane" :class="{ 'is-compact': compact }" aria-label="记忆列表">
      <div class="list-meta-bar" :class="{ 'is-pinned-bar': pinnedWatermark !== null }">
        <div class="meta-summary tabular-nums">
          <span v-if="summaryText">{{ summaryText }}</span>
          <template v-if="pinnedWatermark">
            <span v-if="summaryText" class="meta-sep" aria-hidden="true">·</span>
            <div class="pinned-group-bar" role="group" aria-label="常驻分组筛选">
              <button
                type="button"
                class="pinned-group-btn pinned-budget"
                :class="{
                  active: pinnedGroup === 'global_full',
                  'is-over': pinnedWatermark.globalOverCap,
                }"
                :aria-pressed="pinnedGroup === 'global_full'"
                :title="
                  pinnedWatermark.globalOverCap
                    ? '点击仅查看全局全文常驻记忆并按字数降序排列'
                    : '无场景限定的全局全文常驻默认上限为 3,500 字，点击筛选查看'
                "
                @click="togglePinnedGroup('global_full')"
              >
                <UIcon
                  :name="pinnedWatermark.globalOverCap ? icons.warning : icons.gauge"
                  class="pinned-budget-icon"
                  aria-hidden="true"
                />
                <span>
                  全局全文 {{ pinnedWatermark.globalCount }} 条 ·
                  {{ pinnedWatermark.globalChars.toLocaleString() }} /
                  {{ GLOBAL_FULL_CHAR_CAP.toLocaleString() }} 字
                </span>
              </button>
              <button
                type="button"
                class="pinned-group-btn"
                :class="{ active: pinnedGroup === 'scoped_full' }"
                :aria-pressed="pinnedGroup === 'scoped_full'"
                title="点击仅查看带场景限定的全文常驻记忆"
                @click="togglePinnedGroup('scoped_full')"
              >
                场景全文 {{ pinnedWatermark.scopedCount }} 条
              </button>
              <button
                type="button"
                class="pinned-group-btn"
                :class="{ active: pinnedGroup === 'index' }"
                :aria-pressed="pinnedGroup === 'index'"
                title="点击仅查看目录常驻记忆"
                @click="togglePinnedGroup('index')"
              >
                目录常驻 {{ pinnedWatermark.indexCount }} 条
              </button>
              <button
                v-if="pinnedGroup !== null"
                type="button"
                class="pinned-group-reset"
                @click="emit('update:pinnedGroup', null)"
              >
                全部常驻
              </button>
            </div>
          </template>
        </div>
        <div class="meta-right">
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
          <UButton
            v-if="tab === 'pinned'"
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.terminal"
            @click="emit('previewBoot')"
          >
            预览终端加载
          </UButton>
          <div v-else-if="!compact && !batchMode" class="list-hint" aria-hidden="true">
            <span>↑ ↓ 切换</span>
            <span>Esc 关闭详情</span>
          </div>
        </div>
      </div>

      <div v-if="pinnedWatermark?.globalOverCap" class="pinned-overcap-wrap">
        <div class="pinned-overcap-banner" role="status">
          <div class="overcap-body">
            <UIcon :name="icons.warning" class="overcap-icon" aria-hidden="true" />
            <p class="overcap-text tabular-nums">
              全局全文已超出 {{ GLOBAL_FULL_CHAR_CAP.toLocaleString() }} 字预算上限（当前
              {{ pinnedWatermark.globalChars.toLocaleString() }} 字，超出
              {{ pinnedWatermark.overChars.toLocaleString() }}
              字），超出部分在会话启动时将自动降为目录常驻。建议将长篇参考改为目录常驻，或为特定项目/客户端补充场景标签。
            </p>
          </div>
          <div class="overcap-actions">
            <UButton
              v-if="pinnedGroup !== 'global_full'"
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.filter"
              @click="emit('update:pinnedGroup', 'global_full')"
            >
              查看这 {{ pinnedWatermark.globalCount }} 条（按字数）
            </UButton>
            <UButton
              v-else
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.restore"
              @click="emit('update:pinnedGroup', null)"
            >
              显示全部常驻
            </UButton>
          </div>
        </div>
      </div>

      <div ref="listScrollRef" class="list-scroll">
        <div v-if="query.isError.value" class="p-4">
          <ReadFailureNote :query="query" />
        </div>
        <div v-if="query.isPending.value" class="space-y-2 p-4">
          <USkeleton v-for="n in 6" :key="n" class="h-16 w-full" />
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
                      !selectedBatchIds.includes(item.shortId) &&
                      selectedBatchIds.length >= BATCH_MAX
                    "
                    readonly
                  />
                </span>
                <span class="row-main">
                  <span class="row-title">{{ item.title }}</span>
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
                            ? '单条超过 1,200 字建议上限，建议改为目录常驻或补充场景标签'
                            : '词条总字数（含标题与正文）'
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
                      <span v-if="hasRowLeadingMeta(item)" class="sub-dot" aria-hidden="true"
                        >·</span
                      >
                      <span class="sub-status is-warn">
                        <UIcon :name="icons.clock" class="sub-status-icon" aria-hidden="true" />
                        <span>已过期</span>
                      </span>
                    </template>
                    <template v-if="rowSubtitle(item)">
                      <span
                        v-if="hasRowLeadingMeta(item) || isExpired(item.validTo)"
                        class="sub-dot sub-disclosure-sep"
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
                      :title="
                        tag.kind === 'topic'
                          ? `主题标签：${tag.label}（不限定触发场景）`
                          : undefined
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
              @click="
                (emit('clearFilters'), emit('update:search', ''), emit('update:pinnedGroup', null))
              "
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
          已选 {{ selectedBatchIds.length }} / {{ BATCH_MAX }} 条（至少选 2 条）
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
            查重/关联
          </UButton>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.list-shell {
  display: contents;
}
.batch-check {
  display: inline-flex;
  align-items: flex-start;
  padding-top: 4px;
  flex: none;
}
.batch-check input[type='checkbox'] {
  pointer-events: none;
  accent-color: var(--ui-primary);
}
.batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 16px;
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
.view-tab-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
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
  gap: 8px 12px;
  min-height: 36px;
  padding: 5px 20px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.list-meta-bar.is-pinned-bar {
  flex-wrap: wrap;
}
.meta-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  min-width: 0;
}
.meta-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  margin-left: auto;
}
.meta-sep {
  color: var(--ui-border-accented);
}
.pinned-group-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.pinned-group-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 2px 8px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.pinned-group-btn:hover {
  border-color: var(--ui-rule);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.pinned-budget {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pinned-budget-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.pinned-budget.is-over {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
  font-weight: 500;
}
.pinned-budget.is-over:hover {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.pinned-group-btn.active,
.pinned-group-btn.active:hover,
.pinned-budget.is-over.active,
.pinned-budget.is-over.active:hover {
  border-color: var(--ui-selected);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
  font-weight: 500;
}
.pinned-group-reset {
  padding: 2px 6px;
  border: 0;
  background: transparent;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.pinned-group-reset:hover {
  color: var(--ui-text-highlighted);
}
.pinned-overcap-wrap {
  flex: none;
  padding: 8px 20px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.pinned-overcap-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 14px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  border-left: 3px solid var(--ui-warning);
  background: var(--ui-bg-bright);
  font-size: 12px;
  line-height: 1.6;
  color: var(--ui-text-toned);
}
.overcap-body {
  flex: 1 1 18rem;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.overcap-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 3px;
  color: var(--ui-warning);
}
.overcap-text {
  margin: 0;
  min-width: 0;
}
.overcap-actions {
  flex: none;
  display: inline-flex;
  align-items: center;
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
.entry-row:focus-visible {
  outline-offset: -2px;
}
.entry-row.has-batch-check {
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 4px 12px;
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
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 13px;
  line-height: 1.55;
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
  overflow: hidden;
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
  border-style: dashed;
  background: transparent;
  color: var(--ui-text-dimmed);
}
.entry-row.selected .row-tag {
  border-color: var(--ui-on-selected-muted);
  background: transparent;
  color: var(--ui-on-selected-muted);
}
.entry-row.selected .row-tag.is-topic {
  border-style: dashed;
}
/* 抽屉收窄（compact）态：标题与单行副行均保持可读，时间与标签转至底部一行 */
.list-pane.is-compact .list-meta-bar {
  padding: 5px 16px;
}
.list-pane.is-compact .pinned-overcap-wrap {
  padding: 8px 16px;
}
.list-pane.is-compact :deep(.wiki-chip.is-compact .wiki-chip-label) {
  max-width: 11em;
}
.list-pane.is-compact .entry-row {
  grid-template-columns: minmax(0, 1fr);
  padding: 11px 16px;
  gap: 4px;
}
.list-pane.is-compact .entry-row.has-batch-check {
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 10px;
}
.list-pane.is-compact .entry-row.has-batch-check .row-aside {
  grid-column: 2;
}
.list-pane.is-compact .row-title {
  font-size: 14px;
}
.list-pane.is-compact .row-sub {
  font-size: 12px;
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
    padding: 6px 14px;
  }
  .pinned-overcap-wrap {
    padding: 8px 14px;
  }
  .list-hint {
    display: none;
  }
  .entry-row {
    grid-template-columns: minmax(0, 1fr);
    padding: 11px 14px;
    gap: 4px;
  }
  .entry-row.has-batch-check {
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 10px;
  }
  .entry-row.has-batch-check .row-aside {
    grid-column: 2;
  }
  .row-title {
    font-size: 14px;
  }
  .row-sub {
    font-size: 12px;
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
