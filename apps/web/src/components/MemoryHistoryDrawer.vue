<script setup lang="ts">
import {
  stripDuplicateLeadingHeading,
  type EntryDetailResponse,
  type EntryHistoryItem,
  type EntrySnapshot,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import {
  computeStructuredDiff,
  diffEntrySnapshots,
  type SnapshotFieldChange,
  type StructuredDiff,
} from '../diff'
import { icons } from '../icons'
import {
  entryFieldLabel,
  eventTypeLabels,
  formatActorLabel,
  resolveActorDisplay,
  type ActorFilterGroup,
} from '../labels'
import { formatRelative, formatShort, formatTime } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import MemoryContent from './MemoryContent.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import DiffViewer, { type DiffContextMode, type DiffLayoutMode } from './ui/DiffViewer.vue'
import EmptyState from './ui/EmptyState.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'

type SourceFilter = 'all' | ActorFilterGroup
type InspectTab = 'diff' | 'snapshot'

const SOURCE_FILTER_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'self', label: '本人' },
  { value: 'agent', label: 'Agent' },
  { value: 'dream', label: '整理' },
]

const INSPECT_TAB_OPTIONS: { value: InspectTab; label: string; icon: string }[] = [
  { value: 'diff', label: '对比', icon: icons.compare },
  { value: 'snapshot', label: '快照', icon: icons.file },
]

const DIFF_LAYOUT_OPTIONS: { value: DiffLayoutMode; label: string; icon: string }[] = [
  { value: 'unified', label: '单栏', icon: icons.unifiedDiff },
  { value: 'split', label: '双栏', icon: icons.splitPane },
]

const DIFF_CONTEXT_OPTIONS: { value: DiffContextMode; label: string; icon: string }[] = [
  { value: 'folded', label: '折叠', icon: icons.foldVertical },
  { value: 'full', label: '全文', icon: icons.unfoldVertical },
]

const props = withDefaults(
  defineProps<{
    shortId: string
    currentVersion: number
    isDeleted: boolean
    focusEventId?: number | null
  }>(),
  { focusEventId: null },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ restored: [detail: EntryDetailResponse] }>()

const toast = useToast()
const queryClient = useQueryClient()

const history = useQuery({
  queryKey: computed(() => ['entry-history', props.shortId] as const),
  queryFn: ({ queryKey: [, sid] }) => api.entryHistory(sid, { includeSnapshots: true }),
  enabled: open,
})

const items = computed(() => history.data.value?.items ?? [])
const searchInput = ref('')
const sourceFilter = ref<SourceFilter>('all')
const activeItemId = ref<number | null>(null)
const baseItemId = ref<number | null>(null)
const inspectTab = ref<InspectTab>('diff')
const diffLayout = ref<DiffLayoutMode>('unified')
const diffContext = ref<DiffContextMode>('folded')
const mobileDetailOpen = ref(false)

const listRef = ref<HTMLElement | null>(null)
const diffViewerRef = ref<InstanceType<typeof DiffViewer> | null>(null)

const restoringItem = ref<EntryHistoryItem | null>(null)
const restoring = ref(false)
const restoreError = ref<string | null>(null)

function itemVersion(item: EntryHistoryItem): number | null {
  if (item.eventType === 'archive_note') return null
  return item.version ?? item.snapshot?.version ?? null
}

function itemTimestamp(item: EntryHistoryItem): string {
  return item.occurredAt ?? item.createdAt
}

interface ComputedItemMeta {
  previousItemId: number | null
  previousSnapshot: EntrySnapshot | null
  fieldChanges: SnapshotFieldChange[]
  diff: StructuredDiff
  hasContentDiff: boolean
}

// 预计算每条带快照记录与前一个快照的结构化差异，供搜索过滤、时间线增删计数与右侧展示共用
const metaMap = computed(() => {
  const map = new Map<number, ComputedItemMeta>()
  const list = items.value
  for (let i = 0; i < list.length; i++) {
    const curr = list[i]!
    if (!curr.snapshot) continue
    let prevItemId: number | null = null
    let prevSnap: EntrySnapshot | null = null
    for (let j = i + 1; j < list.length; j++) {
      if (list[j]?.snapshot) {
        prevItemId = list[j]!.id
        prevSnap = list[j]!.snapshot!
        break
      }
    }
    const fieldChanges = diffEntrySnapshots(prevSnap, curr.snapshot)
    const diff = computeStructuredDiff(prevSnap ? prevSnap.content : null, curr.snapshot.content)
    map.set(curr.id, {
      previousItemId: prevItemId,
      previousSnapshot: prevSnap,
      fieldChanges,
      diff,
      hasContentDiff: diff.addedCount > 0 || diff.removedCount > 0,
    })
  }
  return map
})

function summaryTextOf(item: EntryHistoryItem): string {
  const explicit = item.changeSummary?.trim()
  if (explicit) return explicit
  const fields = item.diffMeta?.changedFields ?? []
  if (fields.length > 0) {
    return `${eventTypeLabels[item.eventType]}：${fields.map(entryFieldLabel).join('、')}`
  }
  return eventTypeLabels[item.eventType]
}

function charDeltaText(item: EntryHistoryItem): string | null {
  const meta = item.diffMeta
  if (!meta) return null
  const delta = meta.contentCharsAfter - meta.contentCharsBefore
  if (delta === 0) return null
  return delta > 0 ? `+${delta} 字` : `−${Math.abs(delta)} 字`
}

const filteredItems = computed(() => {
  const q = searchInput.value.trim().toLowerCase()
  const filter = sourceFilter.value
  return items.value.filter((item) => {
    const actor = resolveActorDisplay(item.actor, item.actorMeta)
    if (filter !== 'all' && actor.group !== filter) return false
    if (!q) return true
    if (item.changeSummary?.toLowerCase().includes(q)) return true
    if (item.snapshot?.title.toLowerCase().includes(q)) return true
    if (actor.label.toLowerCase().includes(q)) return true
    if (eventTypeLabels[item.eventType].toLowerCase().includes(q)) return true
    const computedMeta = metaMap.value.get(item.id)
    if (computedMeta) {
      if (
        computedMeta.fieldChanges.some(
          (fc) =>
            fc.label.toLowerCase().includes(q) ||
            fc.before.toLowerCase().includes(q) ||
            fc.after.toLowerCase().includes(q),
        )
      ) {
        return true
      }
      if (
        computedMeta.diff.lines.some(
          (line) => line.kind !== 'same' && line.text.toLowerCase().includes(q),
        )
      ) {
        return true
      }
    }
    return false
  })
})

const snapshotItems = computed(() =>
  items.value.filter(
    (item): item is EntryHistoryItem & { snapshot: EntrySnapshot } => item.snapshot != null,
  ),
)

const activeItem = computed<EntryHistoryItem | null>(() => {
  if (activeItemId.value !== null) {
    const found = items.value.find((x) => x.id === activeItemId.value)
    if (found) return found
  }
  return filteredItems.value[0] ?? items.value[0] ?? null
})

const activeMeta = computed(() =>
  activeItem.value ? metaMap.value.get(activeItem.value.id) : null,
)

const customBaseItem = computed<(EntryHistoryItem & { snapshot: EntrySnapshot }) | null>(() => {
  if (baseItemId.value === null || !activeItem.value?.snapshot) return null
  if (baseItemId.value === activeItem.value.id) return null
  if (activeMeta.value?.previousItemId === baseItemId.value) return null
  return snapshotItems.value.find((item) => item.id === baseItemId.value) ?? null
})

function selectItem(item: EntryHistoryItem) {
  const nextPrevId = metaMap.value.get(item.id)?.previousItemId ?? null
  if (baseItemId.value === item.id || (nextPrevId !== null && baseItemId.value === nextPrevId)) {
    baseItemId.value = null
  }
  activeItemId.value = item.id
  mobileDetailOpen.value = true
  if (!item.snapshot) {
    baseItemId.value = null
    inspectTab.value = 'diff'
  }
}

function togglePinBase(item: EntryHistoryItem) {
  if (!item.snapshot) return
  if (baseItemId.value === item.id || activeMeta.value?.previousItemId === item.id) {
    baseItemId.value = null
    return
  }
  if (activeItem.value?.id === item.id) return
  baseItemId.value = item.id
  inspectTab.value = 'diff'
  mobileDetailOpen.value = true
}

const compareBaseOptions = computed<{ value: string; label: string }[]>(() => {
  const curr = activeItem.value
  if (!curr?.snapshot) return []
  const prev = activeMeta.value?.previousSnapshot ?? null
  const prevItemId = activeMeta.value?.previousItemId ?? null
  const opts: { value: string; label: string }[] = [
    {
      value: 'prev',
      label: prev ? `上一版（版本 ${prev.version}）` : '初始创建（无上一版）',
    },
  ]
  for (const cand of snapshotItems.value) {
    if (cand.id === curr.id) continue
    if (prevItemId !== null && cand.id === prevItemId) continue
    const summary = summaryTextOf(cand)
    const shortSummary = summary.length > 16 ? `${summary.slice(0, 16)}…` : summary
    opts.push({
      value: String(cand.id),
      label: `版本 ${cand.snapshot.version} · ${formatRelative(itemTimestamp(cand))}（${shortSummary}）`,
    })
  }
  return opts
})

const selectedBaseValue = computed(() =>
  customBaseItem.value ? String(customBaseItem.value.id) : 'prev',
)

function onSelectCompareBase(raw: string | number | null | undefined) {
  const val = String(raw ?? 'prev')
  if (val === 'prev') {
    baseItemId.value = null
    return
  }
  const num = Number(val)
  if (Number.isFinite(num)) {
    baseItemId.value = num === activeMeta.value?.previousItemId ? null : num
    inspectTab.value = 'diff'
  }
}

const inspectorBeforeSnapshot = computed<EntrySnapshot | null>(() => {
  if (customBaseItem.value) return customBaseItem.value.snapshot
  return activeMeta.value?.previousSnapshot ?? null
})

const inspectorBefore = computed<string | null>(
  () => inspectorBeforeSnapshot.value?.content ?? null,
)

const inspectorAfter = computed<string | null>(() => activeItem.value?.snapshot?.content ?? null)

const inspectorFieldChanges = computed<SnapshotFieldChange[]>(() => {
  if (customBaseItem.value && activeItem.value?.snapshot) {
    return diffEntrySnapshots(customBaseItem.value.snapshot, activeItem.value.snapshot)
  }
  return activeMeta.value?.fieldChanges ?? []
})

const inspectorCanShowDiff = computed(
  () => inspectTab.value === 'diff' && inspectorAfter.value !== null,
)

const inspectorHasContentDiff = computed(() => {
  if (customBaseItem.value && activeItem.value?.snapshot) {
    return (
      customBaseItem.value.snapshot.content.replace(/\r\n/g, '\n') !==
      activeItem.value.snapshot.content.replace(/\r\n/g, '\n')
    )
  }
  return Boolean(activeMeta.value?.hasContentDiff)
})

const inspectorSnapshot = computed<EntrySnapshot | null>(() => activeItem.value?.snapshot ?? null)

const appliedFocusId = ref<number | null>(null)

watch(
  [open, () => props.focusEventId, items],
  async ([isOpen, targetId, list]) => {
    if (!isOpen || !list.length) return
    if (targetId && appliedFocusId.value !== targetId) {
      const target = list.find((item) => item.id === targetId)
      if (target) {
        appliedFocusId.value = targetId
        searchInput.value = ''
        sourceFilter.value = 'all'
        baseItemId.value = null
        activeItemId.value = target.id
        mobileDetailOpen.value = true
        await nextTick()
        const rowEl = listRef.value?.querySelector<HTMLElement>(`[data-history-id="${target.id}"]`)
        rowEl?.scrollIntoView({ block: 'nearest' })
        return
      }
    }
    if (activeItemId.value === null && list[0]) {
      activeItemId.value = list[0].id
    }
  },
  { immediate: true },
)

watch([activeItemId, baseItemId, () => props.shortId], () => {
  diffContext.value = 'folded'
})

watch(open, (visible) => {
  if (!visible) {
    baseItemId.value = null
    activeItemId.value = null
    inspectTab.value = 'diff'
    diffContext.value = 'folded'
    mobileDetailOpen.value = false
    searchInput.value = ''
    sourceFilter.value = 'all'
    appliedFocusId.value = null
  }
})

async function confirmRestore() {
  const target = restoringItem.value
  const version = target ? itemVersion(target) : null
  if (!target || version === null || restoring.value) return
  restoring.value = true
  restoreError.value = null
  try {
    const detail = await api.restoreEntry(props.shortId, {
      version,
      expectedVersion: props.currentVersion,
    })
    restoringItem.value = null
    toast.add({ title: `已恢复到版本 ${version}`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', props.shortId] })
    emit('restored', detail)
    open.value = false
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      void queryClient.invalidateQueries({ queryKey: ['entry', props.shortId] })
      void queryClient.invalidateQueries({ queryKey: ['entry-history', props.shortId] })
    }
    restoreError.value = err instanceof ApiError ? err.message : '恢复失败，请重试'
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="`版本历史 · ${shortId}`"
    description="左侧切换版本，右侧审查属性与正文变更，可随时切换任意历史版本作为对比基准"
    :ui="{
      content: 'w-[95vw] max-w-[1640px] sm:max-w-[1640px] h-[90vh] max-h-[90vh] ring-2 ring-rule',
      body: 'p-0 sm:p-0 flex-1 min-h-0 overflow-hidden flex flex-col',
    }"
  >
    <template #body>
      <div v-if="history.isError.value" class="p-6">
        <ReadFailureNote :query="history" />
      </div>
      <div v-else-if="history.isPending.value" class="p-6 space-y-3">
        <USkeleton v-for="n in 4" :key="n" class="h-14 w-full" />
      </div>
      <div v-else-if="!items.length" class="p-6">
        <EmptyState title="暂无历史记录" />
      </div>

      <!-- 独立 Master-Detail 变更审查工作台：彻底与底层阅读器隔离开 -->
      <div v-else class="history-workspace" :class="{ 'mobile-detail': mobileDetailOpen }">
        <!-- 左轨：紧凑版本时间线与筛选 -->
        <aside class="ws-rail" aria-label="版本时间线">
          <div class="rail-controls">
            <UInput
              v-model="searchInput"
              size="sm"
              :icon="icons.search"
              placeholder="搜索说明、标题或改动行"
              aria-label="搜索历史记录"
              class="w-full"
            >
              <template v-if="searchInput" #trailing>
                <UButton
                  :icon="icons.cancel"
                  size="xs"
                  color="neutral"
                  variant="link"
                  aria-label="清除历史搜索"
                  @click="searchInput = ''"
                />
              </template>
            </UInput>
            <SegmentedChoice
              v-model="sourceFilter"
              :items="SOURCE_FILTER_OPTIONS"
              label="按操作来源筛选"
              compact
              class="rail-source-filter"
            />
          </div>

          <div v-if="!filteredItems.length" class="rail-empty">
            <p class="text-xs text-muted">暂无匹配的历史记录</p>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              @click="((searchInput = ''), (sourceFilter = 'all'))"
            >
              重置筛选
            </UButton>
          </div>

          <ol v-else ref="listRef" class="timeline-list">
            <li
              v-for="item in filteredItems"
              :key="item.id"
              :data-history-id="item.id"
              class="timeline-item"
              :class="{
                active: activeItem?.id === item.id,
                'is-base': customBaseItem?.id === item.id,
                'is-archive': item.eventType === 'archive_note',
                'is-focused': focusEventId === item.id,
              }"
            >
              <button type="button" class="timeline-select" @click="selectItem(item)">
                <div class="tl-top">
                  <span class="tl-badges">
                    <span v-if="itemVersion(item) !== null" class="tl-ver font-mono">
                      版本 {{ itemVersion(item) }}
                    </span>
                    <span v-else class="tl-archive-tag">历史归档</span>
                    <span v-if="itemVersion(item) === currentVersion && !isDeleted" class="tl-curr">
                      当前
                    </span>
                    <span v-if="customBaseItem?.id === item.id" class="tl-base-badge">基准</span>
                  </span>
                  <time
                    class="tl-time"
                    :datetime="itemTimestamp(item)"
                    :title="formatTime(itemTimestamp(item))"
                  >
                    {{ formatRelative(itemTimestamp(item)) }}
                  </time>
                </div>

                <p class="tl-summary">{{ summaryTextOf(item) }}</p>

                <div class="tl-foot">
                  <span class="tl-actor">{{ formatActorLabel(item.actor, item.actorMeta) }}</span>
                  <span
                    v-if="metaMap.get(item.id)?.hasContentDiff"
                    class="tl-diff-stat tabular-nums"
                  >
                    <span v-if="metaMap.get(item.id)!.diff.addedCount" class="stat-add">
                      +{{ metaMap.get(item.id)!.diff.addedCount }}
                    </span>
                    <span v-if="metaMap.get(item.id)!.diff.removedCount" class="stat-del">
                      −{{ metaMap.get(item.id)!.diff.removedCount }}
                    </span>
                  </span>
                  <span v-else-if="metaMap.get(item.id)?.fieldChanges.length" class="tl-meta-only">
                    属性 {{ metaMap.get(item.id)!.fieldChanges.length }} 项
                  </span>
                </div>
              </button>

              <!-- 悬停浮现快捷设为对比基准按钮，默认上一版无需重复固定 -->
              <button
                v-if="
                  item.snapshot &&
                  activeItem?.snapshot &&
                  item.id !== activeItem.id &&
                  item.id !== activeMeta?.previousItemId
                "
                type="button"
                class="tl-pin-base"
                :class="{ 'is-pinned': customBaseItem?.id === item.id }"
                :aria-label="
                  customBaseItem?.id === item.id
                    ? `取消版本 ${item.snapshot.version} 作为对比基准`
                    : `将版本 ${item.snapshot.version} 设为对比基准`
                "
                @click.stop="togglePinBase(item)"
              >
                <UIcon :name="icons.compare" class="tl-pin-icon" aria-hidden="true" />
                <span>{{ customBaseItem?.id === item.id ? '取消基准' : '设为基准' }}</span>
              </button>
            </li>
          </ol>
        </aside>

        <!-- 右侧主区：宽屏 Git 风格变更审查器 -->
        <section class="ws-main" aria-label="变更详情">
          <div v-if="!activeItem" class="p-6">
            <EmptyState title="请选择左侧历史记录" />
          </div>

          <template v-else>
            <header class="ws-commit-bar">
              <div class="commit-top">
                <div class="commit-title-wrap">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :icon="icons.back"
                    class="mobile-back"
                    @click="mobileDetailOpen = false"
                  >
                    时间线
                  </UButton>
                  <h3 class="commit-title">
                    <template v-if="customBaseItem && activeItem.snapshot">
                      版本 {{ customBaseItem.snapshot.version }} → 版本
                      {{ activeItem.snapshot.version }}
                    </template>
                    <template v-else>
                      {{ summaryTextOf(activeItem) }}
                    </template>
                  </h3>
                </div>

                <div class="commit-actions">
                  <div
                    v-if="activeItem.snapshot && compareBaseOptions.length > 1"
                    class="compare-picker"
                  >
                    <span class="compare-picker-label">对比基准</span>
                    <USelect
                      :model-value="selectedBaseValue"
                      :items="compareBaseOptions"
                      value-key="value"
                      size="xs"
                      aria-label="选择对比基准版本"
                      class="compare-select"
                      @update:model-value="onSelectCompareBase"
                    />
                    <UButton
                      v-if="customBaseItem"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :icon="icons.cancel"
                      @click="baseItemId = null"
                    >
                      切回上一版
                    </UButton>
                  </div>

                  <UButton
                    v-if="
                      activeItem.snapshot &&
                      !isDeleted &&
                      activeItem.snapshot.version !== currentVersion
                    "
                    size="xs"
                    :icon="icons.restore"
                    @click="((restoringItem = activeItem), (restoreError = null))"
                  >
                    恢复此版本
                  </UButton>
                </div>
              </div>

              <div class="commit-meta">
                <template v-if="customBaseItem && activeItem.snapshot">
                  <span class="font-mono font-medium">
                    跨版本累计变动（版本 {{ customBaseItem.snapshot.version }} → 版本
                    {{ activeItem.snapshot.version }}）
                  </span>
                  <span>·</span>
                  <span>目标变更：{{ summaryTextOf(activeItem) }}</span>
                </template>
                <template v-else>
                  <span v-if="itemVersion(activeItem) !== null" class="font-mono font-medium">
                    版本 {{ itemVersion(activeItem) }}
                  </span>
                  <span v-else class="tl-archive-tag">历史归档</span>
                  <span v-if="activeItem.eventType !== 'archive_note'">
                    {{ eventTypeLabels[activeItem.eventType] }}
                  </span>
                  <span>·</span>
                  <span>{{ formatActorLabel(activeItem.actor, activeItem.actorMeta) }}</span>
                  <span>·</span>
                  <time
                    :datetime="itemTimestamp(activeItem)"
                    :title="formatTime(itemTimestamp(activeItem))"
                  >
                    {{ formatTime(itemTimestamp(activeItem)) }}
                  </time>
                  <template v-if="charDeltaText(activeItem)">
                    <span>·</span>
                    <span class="tabular-nums">{{ charDeltaText(activeItem) }}</span>
                  </template>
                  <template
                    v-if="activeItem.occurredAt && activeItem.occurredAt !== activeItem.createdAt"
                  >
                    <span>·</span>
                    <span>原记录时间 {{ formatShort(activeItem.occurredAt) }}</span>
                  </template>
                </template>
              </div>
            </header>

            <!-- 审查工具栏（图标 + 精简短词） -->
            <div v-if="inspectorAfter !== null" class="ws-toolbar">
              <div class="toolbar-group">
                <SegmentedChoice
                  v-model="inspectTab"
                  :items="INSPECT_TAB_OPTIONS"
                  label="审查视图"
                  compact
                />
                <template v-if="inspectorCanShowDiff && inspectorHasContentDiff">
                  <SegmentedChoice
                    v-model="diffLayout"
                    :items="DIFF_LAYOUT_OPTIONS"
                    label="对比排版方式"
                    compact
                    class="split-toggle"
                  />
                  <SegmentedChoice
                    v-if="diffViewerRef?.canToggleContext"
                    v-model="diffContext"
                    :items="DIFF_CONTEXT_OPTIONS"
                    label="上下文显示模式"
                    compact
                  />
                  <UButton
                    v-if="diffContext === 'folded' && diffViewerRef?.manualExpanded"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :icon="icons.foldVertical"
                    @click="diffViewerRef?.resetExpansion()"
                  >
                    重新折叠
                  </UButton>
                </template>
              </div>

              <div
                v-if="
                  inspectorCanShowDiff &&
                  inspectorHasContentDiff &&
                  (diffViewerRef?.hunkCount ?? 0) > 0
                "
                class="toolbar-group"
              >
                <span class="toolbar-stat tabular-nums">
                  <span class="stat-add">+{{ diffViewerRef?.addedCount ?? 0 }}</span>
                  <span class="stat-del">−{{ diffViewerRef?.removedCount ?? 0 }}</span>
                  <span class="text-muted">
                    · {{ (diffViewerRef?.focusedHunk ?? 0) + 1 }}/{{
                      diffViewerRef?.hunkCount ?? 0
                    }}
                    处
                  </span>
                </span>
                <template v-if="(diffViewerRef?.hunkCount ?? 0) > 1">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    :icon="icons.up"
                    @click="diffViewerRef?.jumpHunk(-1)"
                  >
                    上一处
                  </UButton>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    :icon="icons.down"
                    @click="diffViewerRef?.jumpHunk(1)"
                  >
                    下一处
                  </UButton>
                </template>
              </div>
            </div>

            <!-- 右侧滚动内容区 -->
            <div class="ws-body">
              <!-- 纯历史归档说明（无快照） -->
              <div v-if="inspectorAfter === null && activeItem" class="archive-note-card">
                <div class="archive-note-title">
                  <UIcon :name="icons.history" class="archive-note-icon" aria-hidden="true" />
                  <span>历史归档记录</span>
                </div>
                <p class="archive-note-text">{{ summaryTextOf(activeItem) }}</p>
                <p class="text-xs text-muted">该记录由历史流水账沉淀而来，不含独立正文快照。</p>
              </div>

              <!-- 变更对比模式 -->
              <template v-else-if="inspectTab === 'diff' && inspectorAfter !== null">
                <div v-if="inspectorFieldChanges.length" class="attr-card">
                  <div class="attr-card-head">
                    属性变动（{{ inspectorFieldChanges.length }} 项）
                  </div>
                  <table class="attr-table">
                    <thead>
                      <tr>
                        <th class="attr-col-name">属性</th>
                        <th>改前</th>
                        <th>改后</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="fc in inspectorFieldChanges" :key="fc.field">
                        <td class="attr-name">{{ fc.label }}</td>
                        <td>
                          <span class="attr-del">{{ fc.before }}</span>
                        </td>
                        <td>
                          <span class="attr-add">{{ fc.after }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <DiffViewer
                  v-if="inspectorHasContentDiff"
                  ref="diffViewerRef"
                  v-model:layout="diffLayout"
                  v-model:context-mode="diffContext"
                  :before="inspectorBefore"
                  :after="inspectorAfter"
                  :show-toolbar="false"
                  :context="3"
                  :expand-step="10"
                />
                <p v-else-if="inspectorFieldChanges.length" class="diff-empty-note">
                  本次仅调整属性，正文未改动。
                </p>
                <p v-else class="diff-empty-note">两版本属性与正文完全一致。</p>
              </template>

              <!-- 完整快照预览模式 -->
              <div v-else-if="inspectorSnapshot" class="snapshot-card">
                <div class="snapshot-head">
                  <span class="font-medium">{{ inspectorSnapshot.title }}</span>
                  <span class="font-mono text-xs text-muted">
                    版本 {{ inspectorSnapshot.version }} ·
                    {{ inspectorSnapshot.isPinned ? '常驻' : '按需' }}
                  </span>
                </div>
                <div v-if="inspectorSnapshot.summary?.trim()" class="snapshot-summary">
                  <span class="snapshot-summary-label">现行概要</span>
                  <p>{{ inspectorSnapshot.summary }}</p>
                </div>
                <div class="snapshot-body">
                  <MemoryContent
                    width="full"
                    :content="
                      stripDuplicateLeadingHeading(
                        inspectorSnapshot.title,
                        inspectorSnapshot.content,
                      )
                    "
                  />
                </div>
              </div>
            </div>
          </template>
        </section>
      </div>
    </template>
  </UModal>

  <ConsequenceModal
    :open="restoringItem !== null"
    title="恢复此历史版本？"
    :consequences="[
      `将以版本 ${restoringItem ? (itemVersion(restoringItem) ?? '') : ''} 的标题、现行概要、正文与场景覆盖当前内容。`,
      '此次恢复会记为一次新版本，现有内容仍保留在历史记录中。',
    ]"
    action="确认恢复"
    :busy="restoring"
    :error="restoreError"
    @confirm="confirmRestore"
    @close="restoringItem = null"
  />
</template>

<style scoped>
.history-workspace {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--ui-bg);
}
.ws-rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.rail-controls {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--ui-border);
}
.rail-source-filter {
  width: 100%;
}
.rail-source-filter :deep(.segment) {
  flex: 1;
  justify-content: center;
  padding: 0 6px;
}
.rail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 14px;
}
.timeline-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.timeline-item {
  position: relative;
  border-bottom: 1px solid var(--ui-border);
  border-left: 3px solid transparent;
}
.timeline-item.is-archive {
  border-left-color: var(--ui-border-accented);
}
.timeline-item.is-focused {
  border-left-color: var(--ui-warning);
}
.timeline-item.is-base {
  border-left-color: var(--ui-info);
  background: color-mix(in srgb, var(--ui-info) 6%, var(--ui-bg-muted));
}
.timeline-item.active {
  background: var(--ui-bg);
  border-left-color: var(--ui-rule);
}
.timeline-select {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
}
.timeline-select:hover {
  background: var(--ui-bg-elevated);
}
.timeline-item.active .timeline-select:hover {
  background: var(--ui-bg);
}
.tl-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
}
.tl-badges {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.tl-ver {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.tl-archive-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.tl-curr {
  padding: 0 5px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  line-height: 1.4;
}
.tl-base-badge {
  padding: 0 5px;
  border: 1px solid var(--ui-info);
  color: var(--ui-info);
  font-size: 12px;
  line-height: 1.4;
}
.tl-time {
  font-size: 12px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.tl-summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.45;
  color: var(--ui-text-highlighted);
}
.tl-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.tl-actor {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-diff-stat {
  display: inline-flex;
  gap: 4px;
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
}
.tl-meta-only {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.stat-add {
  color: var(--ui-success);
  font-weight: 600;
}
.stat-del {
  color: var(--ui-error);
  font-weight: 600;
}
.tl-pin-base {
  position: absolute;
  right: 8px;
  bottom: 7px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-toned);
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
  transition: opacity 120ms ease;
}
.timeline-item:hover .tl-pin-base,
.timeline-item:focus-within .tl-pin-base,
.tl-pin-base.is-pinned {
  opacity: 1;
  pointer-events: auto;
}
.tl-pin-base:hover {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.tl-pin-base.is-pinned {
  border-color: var(--ui-info);
  color: var(--ui-info);
}
.tl-pin-icon {
  display: inline-block;
  flex: none;
  width: 11px;
  height: 11px;
}
.compare-picker {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.compare-picker-label {
  font-size: 12px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.compare-select {
  min-width: 13rem;
  max-width: 22rem;
}

/* 右侧主审查区 */
.ws-main {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg);
}
.ws-commit-bar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-bright);
}
.commit-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.commit-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.commit-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.commit-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.commit-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.ws-toolbar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.toolbar-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.toolbar-stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.ws-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.attr-card {
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
}
.attr-card-head {
  padding: 6px 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-toned);
}
.attr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  line-height: 1.55;
}
.attr-table th,
.attr-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--ui-border-muted);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.attr-table th {
  border-bottom-color: var(--ui-border);
  background: var(--ui-bg);
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.attr-table tr:last-child td {
  border-bottom: 0;
}
.attr-col-name,
.attr-name {
  width: 5.5rem;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
.attr-del {
  padding: 1px 4px;
  background: var(--ui-diff-del-bg);
  color: var(--ui-error);
}
.attr-add {
  padding: 1px 4px;
  background: var(--ui-diff-add-bg);
  color: var(--ui-success);
  font-weight: 500;
}
.diff-empty-note {
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 13px;
  color: var(--ui-text-muted);
}
.archive-note-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--ui-border-accented);
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.archive-note-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.archive-note-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.archive-note-text {
  font-size: 14px;
  line-height: 1.65;
  color: var(--ui-text-highlighted);
}
.snapshot-card {
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
}
.snapshot-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 14px;
}
.snapshot-summary {
  margin: 12px 14px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.snapshot-summary-label {
  display: block;
  margin-bottom: 2px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.snapshot-body {
  padding: 14px 18px;
}
.mobile-back {
  display: none;
}
@container (max-width: 639.98px) {
  .split-toggle {
    display: none;
  }
}
@media (max-width: 839.98px) {
  .history-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
  .ws-main {
    display: none;
  }
  .history-workspace.mobile-detail .ws-rail {
    display: none;
  }
  .history-workspace.mobile-detail .ws-main {
    display: flex;
  }
  .mobile-back {
    display: inline-flex;
  }
}
</style>
