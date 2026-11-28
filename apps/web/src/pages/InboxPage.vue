<script lang="ts">
const INBOX_ACTION_TOAST_PREFIX = 'inbox-action-'
let inboxToastSeq = 0
let latestInboxToastId: string | null = null
</script>

<script setup lang="ts">
import {
  checkCaptureIntegrity,
  DREAM_KINDS,
  effectiveBootMode,
  extractCredentialPlaceholders,
  extractTargetShortIds,
  hasDuplicateLeadingHeading,
  stripDuplicateLeadingHeading,
  type ApplySuggestionRequest,
  type CaptureIntegrity,
  type DreamMode,
  type DreamSuggestionKind,
  type DreamSuggestionView,
  type InboxResponse,
  type TriggerDreamRequest,
} from '@kioku/contracts'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import ConsequenceModal from '../components/ConsequenceModal.vue'
import DreamSuggestionCard from '../components/DreamSuggestionCard.vue'
import HygieneSweepDrawer from '../components/HygieneSweepDrawer.vue'
import OrganizeIndexRail, {
  type OrganizeKindOption,
  type OrganizeScheduleItem,
  type OrganizeScopeFilter,
} from '../components/OrganizeIndexRail.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import NoteLine from '../components/ui/NoteLine.vue'
import ReadFailureNote from '../components/ui/ReadFailureNote.vue'
import { confirmDiscard, useUnsavedChangesGuard } from '../composables/unsavedChanges'
import { useSession } from '../composables/useSession'
import { useViewport } from '../composables/useViewport'
import { isTitleOnlyTidy } from '../diff'
import { icons } from '../icons'
import {
  bootModeLabels,
  dreamKindIcons,
  dreamKindLabels,
  dreamModeLabels,
  dreamOutcomeLabels,
} from '../labels'
import { entryRoute, settingsRoute } from '../routes'
import {
  isAfterWatermark,
  latestInboxFailureTimestamp,
  shouldShowInboxFailureBanner,
} from '../taskCenter'
import { formatRelative, formatTime } from '../time'
import {
  readStoredString,
  subscribeStoredString,
  UI_STORAGE_KEYS,
  writeStoredString,
} from '../uiState'

type KindFilter = 'all' | DreamSuggestionKind
type SuggestionRiskLevel = 'high' | 'medium' | 'safe'

const FILTER_ORDER: readonly DreamSuggestionKind[] = [
  'merge_duplicates',
  'mark_stale',
  'tidy',
  'distill_episode',
  'adjust_boot_mode',
  'link_entries',
  'update',
]

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()
const viewport = useViewport()
const narrow = computed(() => viewport.value.width < 1024)

const inboxQuery = useQuery({
  queryKey: ['inbox'] as const,
  queryFn: () => api.inbox(),
  refetchInterval: (query) => {
    const d = query.state.data
    return d?.dreamState.running || d?.embeddingBackfill?.running ? 2500 : false
  },
})

const data = computed(() => inboxQuery.data.value ?? null)
const items = computed(() => data.value?.items ?? [])
const tidyPendingCount = computed(() => data.value?.tidyPendingCount ?? 0)
const state = computed(() => data.value?.dreamState ?? null)
const progress = computed(() => state.value?.progress ?? null)
const latestRun = computed(() => state.value?.recentRuns[0] ?? null)
const latestFailedItems = computed(() => latestRun.value?.failedItems ?? [])
const latestRetryableShortIds = computed(() => [
  ...new Set(latestFailedItems.value.map((item) => item.shortId)),
])
const latestRunMode = computed<DreamMode>(
  () =>
    latestRun.value?.mode ??
    (latestFailedItems.value[0]?.kind === 'tidy'
      ? 'tidy'
      : latestFailedItems.value[0]?.kind === 'cross_memory'
        ? 'cross_memory'
        : 'standard'),
)
const hasChatModel = computed(() => Boolean(me.data.value?.hasChatModel))
const sweepOpen = ref(false)
const railOpen = ref(false)

// ---- 失败提示水位与跨页签同步 ----
const failureDismissedAt = ref<string | null>(
  readStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt),
)
const tasksClearedBefore = ref<string | null>(readStoredString(UI_STORAGE_KEYS.tasksClearedBefore))
const dismissedWithoutTimestamp = ref(false)
const latestFailureAt = computed(() => latestInboxFailureTimestamp(state.value))

watch(latestFailureAt, (ts) => {
  if (ts) dismissedWithoutTimestamp.value = false
})

const stopDismissSync = subscribeStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt, (value) => {
  failureDismissedAt.value = value
})
const stopTasksClearSync = subscribeStoredString(UI_STORAGE_KEYS.tasksClearedBefore, (value) => {
  tasksClearedBefore.value = value
})

const showFailureBanner = computed(
  () =>
    !dismissedWithoutTimestamp.value &&
    shouldShowInboxFailureBanner(state.value, failureDismissedAt.value, tasksClearedBefore.value),
)

function dismissFailureBanner() {
  const watermark = latestFailureAt.value
  if (!watermark) {
    dismissedWithoutTimestamp.value = true
    return
  }
  if (!failureDismissedAt.value || isAfterWatermark(watermark, failureDismissedAt.value)) {
    failureDismissedAt.value = watermark
    writeStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt, watermark)
  }
}

const progressPercent = computed(() =>
  progress.value && progress.value.total > 0
    ? Math.min(100, Math.round((progress.value.processed / progress.value.total) * 100))
    : 0,
)

const runningStageLabel = computed(() => {
  if (progress.value?.stage) return `${progress.value.stage}中`
  if (progress.value?.mode === 'tidy') return '规范整理中'
  if (progress.value?.mode === 'cross_memory') return '查重与关联中'
  return '增量整理中'
})

const runningModeIcon = computed(() =>
  progress.value?.mode === 'tidy'
    ? icons.tidy
    : progress.value?.mode === 'cross_memory'
      ? icons.links
      : icons.sparkles,
)

const scheduleItems = computed<OrganizeScheduleItem[]>(() => {
  const s = state.value
  const sc = s?.schedules
  return [
    {
      mode: 'standard',
      label: dreamModeLabels.standard,
      icon: icons.sparkles,
      enabled: sc?.standard.enabled ?? s?.enabled ?? false,
      intervalHours: sc?.standard.intervalHours ?? s?.intervalHours ?? 24,
      lastRunAt: sc?.standard.lastRunAt ?? null,
    },
    {
      mode: 'cross_memory',
      label: dreamModeLabels.cross_memory,
      icon: icons.links,
      enabled: sc?.crossMemory.enabled ?? false,
      intervalHours: sc?.crossMemory.intervalHours ?? 168,
      lastRunAt: sc?.crossMemory.lastRunAt ?? null,
    },
    {
      mode: 'tidy',
      label: dreamModeLabels.tidy,
      icon: icons.tidy,
      enabled: sc?.tidy.enabled ?? false,
      intervalHours: sc?.tidy.intervalHours ?? 72,
      lastRunAt: sc?.tidy.lastRunAt ?? null,
    },
  ]
})

const scheduleSummaryText = computed(() => {
  const enabled = scheduleItems.value.filter((item) => item.enabled)
  if (enabled.length === 0) return '定时关闭'
  if (enabled.length === 1) {
    const only = enabled[0]!
    return `${only.label} 每 ${only.intervalHours}h`
  }
  return `定时已开 ${enabled.length} 项`
})

function formatScheduleInterval(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) {
    return `每 ${hours / 24} 天（${hours}h）`
  }
  return `每 ${hours} 小时`
}

// ---- 风险等级判定与队列摘要文本 ----
function baseEntryOf(suggestion: DreamSuggestionView) {
  if (suggestion.keepId) {
    return (
      suggestion.entries.find((e) => e.id === suggestion.keepId) ?? suggestion.entries[0] ?? null
    )
  }
  return suggestion.entries[0] ?? null
}

function targetTitleOf(s: DreamSuggestionView): string {
  const base = baseEntryOf(s)
  if (s.kind === 'distill_episode') {
    return s.proposedTitle?.trim() || base?.title || '未命名记忆'
  }
  return base?.title || s.proposedTitle?.trim() || '未命名记忆'
}

function hasSummaryDiff(s: DreamSuggestionView): boolean {
  const proposed = s.proposedSummary
  if (proposed === undefined || proposed === null) return false
  const base = baseEntryOf(s)
  return proposed.trim() !== (base?.summary?.trim() ?? '')
}

function hasTitleDiff(s: DreamSuggestionView): boolean {
  if (s.kind === 'distill_episode') return false
  const base = baseEntryOf(s)
  const proposed = s.proposedTitle?.trim() ?? ''
  return Boolean(proposed && base && proposed !== base.title)
}

function computeIntegrityOf(s: DreamSuggestionView): CaptureIntegrity | null {
  if (
    s.kind === 'distill_episode' ||
    s.kind === 'mark_stale' ||
    s.kind === 'link_entries' ||
    s.kind === 'adjust_boot_mode'
  ) {
    return null
  }
  const base = baseEntryOf(s)
  const next = s.proposedContent
  if (!base || next === null) return null
  if (s.kind === 'merge_duplicates' && s.entries.length > 1) {
    const mergedSelfIds = new Set(s.entries.map((e) => e.shortId))
    const linksBeforeSet = new Set<string>()
    const credsBeforeSet = new Set<string>()
    const credKey = (p: { slug: string; field: string | null }) =>
      p.field ? `${p.slug}#${p.field}` : p.slug
    for (const item of s.entries) {
      for (const sid of extractTargetShortIds(item.content)) {
        if (!mergedSelfIds.has(sid)) linksBeforeSet.add(sid)
      }
      for (const cred of extractCredentialPlaceholders(item.content)) {
        credsBeforeSet.add(credKey(cred))
      }
    }
    const linksAfterSet = new Set(extractTargetShortIds(next))
    const credsAfterSet = new Set(extractCredentialPlaceholders(next).map(credKey))
    const missingLinks = [...linksBeforeSet].filter((id) => !linksAfterSet.has(id))
    const missingCreds = [...credsBeforeSet].filter((k) => !credsAfterSet.has(k))
    const severeShrink =
      base.content.length >= 200 && next.length < Math.floor(base.content.length * 0.5)
    return {
      intact: missingLinks.length === 0 && missingCreds.length === 0 && !severeShrink,
      linksBefore: linksBeforeSet.size,
      linksAfter: linksAfterSet.size,
      missingLinks,
      credsBefore: credsBeforeSet.size,
      credsAfter: credsAfterSet.size,
      missingCreds,
      severeShrink,
    }
  }
  return checkCaptureIntegrity(base.content, next)
}

function hasIntegrityAlert(s: DreamSuggestionView): boolean {
  const integ = computeIntegrityOf(s)
  if (!integ) return false
  return integ.missingLinks.length > 0 || integ.missingCreds.length > 0 || integ.severeShrink
}

function isHighRisk(s: DreamSuggestionView): boolean {
  return s.kind === 'merge_duplicates' || s.kind === 'mark_stale' || hasIntegrityAlert(s)
}

function isSafeForBatch(s: DreamSuggestionView): boolean {
  if (s.kind === 'merge_duplicates' || s.kind === 'mark_stale') return false
  if (hasIntegrityAlert(s)) return false
  if (s.kind === 'adjust_boot_mode') return true
  if (s.kind === 'link_entries') return Boolean(s.proposedLinks?.length)
  return isTitleOnlyTidy(s)
}

function riskLevelOf(s: DreamSuggestionView): SuggestionRiskLevel {
  if (isHighRisk(s)) return 'high'
  if (isSafeForBatch(s)) return 'safe'
  return 'medium'
}

function contentDeltaInfo(s: DreamSuggestionView): {
  changed: boolean
  pct: number
  label: string | null
} {
  const base = baseEntryOf(s)
  const next = s.proposedContent
  if (!base || next === null || next === base.content) {
    return { changed: false, pct: 0, label: null }
  }
  const before = base.content.length
  const after = next.length
  if (before === 0) return { changed: true, pct: 0, label: '调整正文' }
  const pct = Math.round(((after - before) / before) * 100)
  if (pct <= -5) return { changed: true, pct, label: `精简 ${Math.abs(pct)}%` }
  if (pct >= 5) return { changed: true, pct, label: `扩充 ${pct}%` }
  return { changed: true, pct, label: '调整正文' }
}

function queueImpactText(s: DreamSuggestionView): string {
  if (s.kind === 'adjust_boot_mode' && baseEntryOf(s) && s.proposedBootMode) {
    const base = baseEntryOf(s)!
    const fromLabel = bootModeLabels[effectiveBootMode(base)]
    const toLabel = bootModeLabels[s.proposedBootMode]
    return `${fromLabel} → ${toLabel}${hasSummaryDiff(s) ? ' · 补概要' : ''}`
  }
  if (s.kind === 'link_entries') {
    const count = s.proposedLinks?.length ?? 0
    const first = s.proposedLinks?.[0]
    const firstName = first?.targetTitle || first?.targetShortId || ''
    if (!firstName) return `建议追加 ${count} 条双链`
    return count > 1 ? `+${count} 双链 · ${firstName} 等` : `+1 双链 · ${firstName}`
  }
  if (s.kind === 'merge_duplicates') {
    const redirect = s.affectedBacklinkCount ?? 0
    return redirect > 0
      ? `合并 ${s.entries.length} 条 · 重定向 ${redirect} 条反链`
      : `合并 ${s.entries.length} 条重复记忆`
  }
  if (s.kind === 'distill_episode') {
    const len = s.proposedContent ? ` · 约 ${s.proposedContent.length.toLocaleString()} 字` : ''
    return `提炼自 ${s.entries.length} 条会话摘要${len}`
  }
  if (s.kind === 'mark_stale') {
    return s.reason || '建议移入回收站'
  }
  const integ = computeIntegrityOf(s)
  if (integ && (integ.missingLinks.length > 0 || integ.missingCreds.length > 0)) {
    return '存在引用缺失，须展开核对'
  }
  const body = contentDeltaInfo(s)
  if (integ?.severeShrink) {
    return `正文缩减 ${Math.abs(body.pct)}%，须核对变更`
  }
  const bits: string[] = []
  if (hasTitleDiff(s)) bits.push(s.kind === 'tidy' ? '规范标题' : '更新标题')
  if (body.label) bits.push(body.label)
  if (hasSummaryDiff(s)) bits.push('更新概要')
  if (s.archivedNotes?.length) bits.push(`归档 ${s.archivedNotes.length} 条`)
  return bits.length ? bits.join(' · ') : s.kind === 'tidy' ? '规范调整' : '更新记忆内容'
}

// ---- 左侧筛选与分组队列（scopeFilter 与 kindFilter 互斥单轴） ----
function parseKindQuery(raw: unknown): KindFilter {
  if (typeof raw !== 'string') return 'all'
  return (DREAM_KINDS as readonly string[]).includes(raw) ? (raw as DreamSuggestionKind) : 'all'
}

const kindFilter = ref<KindFilter>(parseKindQuery(route.query.kind))
const scopeFilter = ref<OrganizeScopeFilter>('all')

watch(
  () => route.query.kind,
  (raw) => {
    const parsed = parseKindQuery(raw)
    if (parsed !== kindFilter.value) {
      kindFilter.value = parsed
      if (parsed !== 'all') scopeFilter.value = 'all'
    }
  },
)

watch(kindFilter, (next) => {
  const current = parseKindQuery(route.query.kind)
  if (next === current) return
  const query = { ...route.query }
  if (next === 'all') delete query.kind
  else query.kind = next
  void router.replace({ query })
})

const allReviewCount = computed(() => items.value.filter((s) => !isSafeForBatch(s)).length)
const allSafeCount = computed(() => items.value.filter(isSafeForBatch).length)

const kindCounts = computed(() => {
  const counts: Record<KindFilter, number> = {
    all: items.value.length,
    tidy: 0,
    merge_duplicates: 0,
    link_entries: 0,
    adjust_boot_mode: 0,
    distill_episode: 0,
    mark_stale: 0,
    update: 0,
  }
  for (const item of items.value) {
    counts[item.kind]++
  }
  return counts
})

const nonZeroKinds = computed<OrganizeKindOption[]>(() =>
  FILTER_ORDER.filter((k) => DREAM_KINDS.includes(k) && kindCounts.value[k] > 0).map((kind) => ({
    kind,
    count: kindCounts.value[kind],
  })),
)

watch(
  [data, kindCounts, allReviewCount, allSafeCount, kindFilter, scopeFilter],
  ([loaded, counts, reviewCnt, safeCnt, curKind, curScope]) => {
    if (!loaded) return
    if (curKind !== 'all' && counts[curKind] === 0) {
      kindFilter.value = 'all'
    }
    if (curScope === 'review' && reviewCnt === 0) {
      scopeFilter.value = 'all'
    } else if (curScope === 'safe' && safeCnt === 0) {
      scopeFilter.value = 'all'
    }
  },
  { immediate: true },
)

const activeCardDirty = ref(false)
useUnsavedChangesGuard(activeCardDirty)

function confirmSwitchAway(): boolean {
  if (cardRef.value?.isReviseBusy()) return false
  if (!activeCardDirty.value && !cardRef.value?.hasUnsavedDraft()) return true
  if (!confirmDiscard()) return false
  activeCardDirty.value = false
  return true
}

function setScopeFilter(next: OrganizeScopeFilter) {
  if (next === scopeFilter.value && kindFilter.value === 'all') {
    railOpen.value = false
    return
  }
  if (!confirmSwitchAway()) return
  railOpen.value = false
  scopeFilter.value = next
  kindFilter.value = 'all'
}

function setKindFilter(next: KindFilter) {
  if (next === kindFilter.value && scopeFilter.value === 'all') {
    railOpen.value = false
    return
  }
  if (!confirmSwitchAway()) return
  railOpen.value = false
  kindFilter.value = next
  if (next !== 'all') scopeFilter.value = 'all'
}

function resetFilter() {
  if (!isFiltered.value) return
  if (!confirmSwitchAway()) return
  scopeFilter.value = 'all'
  kindFilter.value = 'all'
}

const isFiltered = computed(() => kindFilter.value !== 'all' || scopeFilter.value !== 'all')

const filteredItems = computed(() => {
  if (kindFilter.value !== 'all') {
    return items.value.filter((item) => item.kind === kindFilter.value)
  }
  if (scopeFilter.value === 'review') {
    return items.value.filter((item) => !isSafeForBatch(item))
  }
  if (scopeFilter.value === 'safe') {
    return items.value.filter(isSafeForBatch)
  }
  return items.value
})

const visibleReviewItems = computed(() =>
  filteredItems.value.filter((item) => !isSafeForBatch(item)),
)
const visibleSafeItems = computed(() => filteredItems.value.filter(isSafeForBatch))
const orderedVisibleItems = computed(() => [...visibleReviewItems.value, ...visibleSafeItems.value])

const queueHeading = computed(() => {
  if (kindFilter.value !== 'all') return dreamKindLabels[kindFilter.value]
  if (scopeFilter.value === 'review') return '须逐条核对'
  if (scopeFilter.value === 'safe') return '安全快批'
  return '全部待确认'
})

// ---- 选中建议与安全快批勾选 ----
const selectedId = ref<string | null>(null)
const selectedSafeIds = ref<string[]>([])
const cardRef = ref<InstanceType<typeof DreamSuggestionCard> | null>(null)
const queueScrollRef = ref<HTMLElement | null>(null)

watch(
  [orderedVisibleItems, narrow],
  ([list, isNarrow]) => {
    const safeValid = new Set(visibleSafeItems.value.map((i) => i.id))
    selectedSafeIds.value = selectedSafeIds.value.filter((id) => safeValid.has(id))

    const allValid = new Set(list.map((i) => i.id))
    if (selectedId.value && !allValid.has(selectedId.value)) {
      selectedId.value = !isNarrow ? (list[0]?.id ?? null) : null
      return
    }
    if (!isNarrow && !selectedId.value && list.length > 0) {
      selectedId.value = list[0]!.id
    }
  },
  { immediate: true },
)

const activeIndex = computed(() =>
  orderedVisibleItems.value.findIndex((item) => item.id === selectedId.value),
)
const activeSuggestion = computed<DreamSuggestionView | null>(() =>
  activeIndex.value >= 0 ? (orderedVisibleItems.value[activeIndex.value] ?? null) : null,
)

const selectedSafeItems = computed(() =>
  visibleSafeItems.value.filter((item) => selectedSafeIds.value.includes(item.id)),
)
const allSafeSelected = computed(
  () =>
    visibleSafeItems.value.length > 0 &&
    selectedSafeItems.value.length === visibleSafeItems.value.length,
)

const activeCardBusyOrEditing = computed(() =>
  Boolean(cardRef.value?.isEditing() || cardRef.value?.isReviseBusy()),
)

function selectSuggestion(id: string) {
  if (id === selectedId.value) return
  if (!confirmSwitchAway()) return
  selectedId.value = id
}

function backToQueue() {
  if (!confirmSwitchAway()) return
  selectedId.value = null
}

function toggleSafeRow(id: string) {
  if (selectedSafeIds.value.includes(id)) {
    selectedSafeIds.value = selectedSafeIds.value.filter((x) => x !== id)
  } else {
    selectedSafeIds.value = [...selectedSafeIds.value, id]
  }
}

function toggleSelectAllSafe() {
  if (allSafeSelected.value) {
    selectedSafeIds.value = []
  } else {
    selectedSafeIds.value = visibleSafeItems.value.map((item) => item.id)
  }
}

function clearSafeSelection() {
  selectedSafeIds.value = []
}

function scrollSelectedRowIntoView(id: string) {
  void nextTick(() => {
    const el = queueScrollRef.value?.querySelector<HTMLElement>(
      `[data-suggestion-id="${CSS.escape(id)}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  })
}

// ---- 三栏队列拖拽调宽（与记忆页 216px | 336px | 1fr 像素对齐） ----
const layoutRef = ref<HTMLElement | null>(null)
const INDEX_RAIL_WIDTH = 216
const QUEUE_WIDTH_STORAGE_KEY = 'kioku:organize-queue-width'
const QUEUE_WIDTH_DEFAULT = 336
const QUEUE_WIDTH_MIN = 280
const QUEUE_WIDTH_MAX = 480
const REVIEW_MIN_WIDTH = 520

function readStoredQueueWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(QUEUE_WIDTH_STORAGE_KEY))
    if (Number.isFinite(raw) && raw >= QUEUE_WIDTH_MIN && raw <= QUEUE_WIDTH_MAX) {
      return Math.round(raw)
    }
  } catch {
    // 隐私模式或存储受限时退回默认宽度
  }
  return QUEUE_WIDTH_DEFAULT
}

function saveQueueWidth(width: number) {
  try {
    window.localStorage.setItem(QUEUE_WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // 忽略存储写入异常
  }
}

const storedQueueWidth = ref<number>(readStoredQueueWidth())
const containerWidth = ref<number>(0)
const resizing = ref(false)
let layoutObserver: ResizeObserver | null = null

const maxAllowedQueueWidth = computed(() => {
  const viewportFallback = Math.min(viewport.value.width, 1840)
  const effectiveContainer = containerWidth.value > 0 ? containerWidth.value : viewportFallback
  return Math.max(
    QUEUE_WIDTH_MIN,
    Math.min(QUEUE_WIDTH_MAX, effectiveContainer - INDEX_RAIL_WIDTH - REVIEW_MIN_WIDTH),
  )
})

const effectiveQueueWidth = computed(() =>
  Math.max(QUEUE_WIDTH_MIN, Math.min(storedQueueWidth.value, maxAllowedQueueWidth.value)),
)

let dragStartX = 0
let dragStartWidth = QUEUE_WIDTH_DEFAULT

function onPointerMove(event: PointerEvent) {
  if (!resizing.value) return
  storedQueueWidth.value = Math.round(
    Math.max(
      QUEUE_WIDTH_MIN,
      Math.min(maxAllowedQueueWidth.value, dragStartWidth + (event.clientX - dragStartX)),
    ),
  )
}

function stopResize() {
  if (!resizing.value) return
  resizing.value = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stopResize)
  window.removeEventListener('pointercancel', stopResize)
  window.removeEventListener('blur', stopResize)
  saveQueueWidth(storedQueueWidth.value)
}

function startResize(event: PointerEvent) {
  if (narrow.value || event.button !== 0) return
  event.preventDefault()
  dragStartX = event.clientX
  dragStartWidth = effectiveQueueWidth.value
  resizing.value = true
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopResize)
  window.addEventListener('pointercancel', stopResize)
  window.addEventListener('blur', stopResize)
}

function resetQueueWidth() {
  storedQueueWidth.value = QUEUE_WIDTH_DEFAULT
  saveQueueWidth(QUEUE_WIDTH_DEFAULT)
}

function onSplitterKeydown(event: KeyboardEvent) {
  if (narrow.value) return
  const step = event.shiftKey ? 40 : 16
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    storedQueueWidth.value = Math.max(QUEUE_WIDTH_MIN, effectiveQueueWidth.value - step)
    saveQueueWidth(storedQueueWidth.value)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    storedQueueWidth.value = Math.min(maxAllowedQueueWidth.value, effectiveQueueWidth.value + step)
    saveQueueWidth(storedQueueWidth.value)
  } else if (event.key === 'Home') {
    event.preventDefault()
    resetQueueWidth()
  }
}

watch(narrow, (isNarrow) => {
  if (isNarrow) stopResize()
  if (!isNarrow) railOpen.value = false
})

// ---- 触发后台整理、分级确认与取消 ----
interface PendingDreamConfirm {
  req: Partial<TriggerDreamRequest>
  title: string
  action: string
  icon: string
  consequences: string[]
}

const triggeringMode = ref<DreamMode | 'retry' | null>(null)
const cancellingDream = ref(false)
const pendingDreamConfirm = ref<PendingDreamConfirm | null>(null)
const dreamConfirmError = ref<string | null>(null)
const standardBusy = computed(
  () =>
    triggeringMode.value === 'standard' ||
    (Boolean(state.value?.running) &&
      progress.value?.mode !== 'tidy' &&
      progress.value?.mode !== 'cross_memory'),
)
const retryFailedBusy = computed(() => triggeringMode.value === 'retry')
const modelRunDisabled = computed(
  () =>
    !data.value ||
    !hasChatModel.value ||
    Boolean(triggeringMode.value) ||
    Boolean(state.value?.running),
)

function requestHeavyDreamConfirm(confirm: PendingDreamConfirm) {
  if (modelRunDisabled.value) return
  railOpen.value = false
  dreamConfirmError.value = null
  pendingDreamConfirm.value = confirm
}

function openCrossMemoryConfirm() {
  requestHeavyDreamConfirm({
    req: { mode: 'cross_memory', scope: 'full_corpus' },
    title: '发起全库查重与关联？',
    action: '开始查重与关联',
    icon: icons.links,
    consequences: [
      '将对全部活跃记忆扫描重复合并、缺失双链与常驻结构，会触发多轮模型调用并耗时数分钟。',
      '整理结果仅写入待确认建议，不会直接修改现有记忆。',
      '执行期间可随时在整理页或顶部导航栏取消。',
    ],
  })
}

function openFullTidyConfirm() {
  const count = tidyPendingCount.value
  if (count <= 0) return
  requestHeavyDreamConfirm({
    req: { mode: 'tidy', pinnedFirst: true, all: true },
    title: `发起全量规范整理（${count} 条）？`,
    action: '开始规范整理',
    icon: icons.tidy,
    consequences: [
      `将逐条对全部 ${count} 条待规范记忆执行标题规范、概要补全与旧日志归档，会触发多轮模型调用。`,
      '整理结果仅写入待确认建议，不会直接修改现有记忆。',
      '执行期间可随时在整理页或顶部导航栏取消。',
    ],
  })
}

const tidyMenuItems = computed<DropdownMenuItem[][]>(() => {
  const count = tidyPendingCount.value
  const disabledLlm = modelRunDisabled.value
  const list: DropdownMenuItem[] = []
  if (count > 10) {
    list.push({
      label: '本批 10 条（常驻优先）',
      icon: icons.tidy,
      disabled: disabledLlm,
      onSelect: () => {
        railOpen.value = false
        void triggerDream({ mode: 'tidy', pinnedFirst: true, limit: 10 })
      },
    })
  }
  if (count > 20) {
    list.push({
      label: '本批 20 条（常驻优先）',
      icon: icons.tidy,
      disabled: disabledLlm,
      onSelect: () => {
        railOpen.value = false
        void triggerDream({ mode: 'tidy', pinnedFirst: true, limit: 20 })
      },
    })
  }
  if (count > 10) {
    list.push({
      label: `全部待规范（${count} 条）`,
      icon: icons.listChecks,
      disabled: disabledLlm,
      onSelect: openFullTidyConfirm,
    })
  }
  return [list]
})

async function confirmHeavyDream() {
  const pending = pendingDreamConfirm.value
  if (!pending || triggeringMode.value) return
  dreamConfirmError.value = null
  const ok = await triggerDream(pending.req, (msg) => {
    dreamConfirmError.value = msg
  })
  if (ok) pendingDreamConfirm.value = null
}

async function triggerDream(
  req: Partial<TriggerDreamRequest>,
  onError?: (message: string) => void,
): Promise<boolean> {
  if (triggeringMode.value || state.value?.running) return false
  const mode: DreamMode = req.mode === 'tidy' || req.mode === 'cross_memory' ? req.mode : 'standard'
  const isRetry = Boolean(req.targetShortIds?.length)
  triggeringMode.value = isRetry ? 'retry' : mode
  try {
    const res = await api.runDream(req)
    if (res.started) {
      const title = isRetry
        ? `已发起失败项重试（${req.targetShortIds!.length} 条）`
        : mode === 'cross_memory'
          ? '已发起查重与关联任务'
          : mode === 'tidy'
            ? req.all
              ? '已发起全部规范整理任务'
              : `已发起规范整理（本批 ${req.limit ?? 10} 条）`
            : '已发起增量整理任务'
      toast.add({ title, color: 'success' })
    } else {
      const msg = res.reason ?? '当前无需重复整理'
      if (onError) onError(msg)
      else toast.add({ title: msg, color: 'neutral' })
      await queryClient.invalidateQueries({ queryKey: ['inbox'] })
      return false
    }
    await queryClient.invalidateQueries({ queryKey: ['inbox'] })
    return true
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : '触发整理失败'
    if (onError) onError(msg)
    else toast.add({ title: msg, color: 'error' })
    return false
  } finally {
    triggeringMode.value = null
  }
}

function triggerRetryFailed() {
  if (!latestRetryableShortIds.value.length) return
  railOpen.value = false
  void triggerDream({
    mode: latestRunMode.value,
    targetShortIds: latestRetryableShortIds.value,
  })
}

async function cancelDream() {
  if (cancellingDream.value || !state.value?.running) return
  cancellingDream.value = true
  try {
    const res = await api.cancelDream()
    if (!res.cancelled) {
      toast.add({ title: '当前没有可取消的整理任务', color: 'neutral' })
    }
    await queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '取消整理失败', color: 'error' })
  } finally {
    cancellingDream.value = false
  }
}

// ---- 应用、8 秒撤销、乐观移除与批量安全快批 ----
const busyId = ref<string | null>(null)
const batchBusy = ref(false)
const batchDismissBusy = ref(false)
const undoingKeys = new Set<string>()
const undoneKeys = new Set<string>()

function pruneInboxCache(removedIds: ReadonlySet<string>) {
  if (!removedIds.size) return
  void queryClient.cancelQueries({ queryKey: ['inbox'] })
  queryClient.setQueryData<InboxResponse>(['inbox'], (old) => {
    if (!old) return old
    const nextItems = old.items.filter((item) => !removedIds.has(item.id))
    return {
      ...old,
      items: nextItems,
      pendingCount: nextItems.length,
    }
  })
}

function advanceAfterRemovingSet(removedIds: ReadonlySet<string>) {
  if (!removedIds.size) return
  const currentSelected = selectedId.value
  let nextSelected = currentSelected
  if (currentSelected && removedIds.has(currentSelected)) {
    const list = orderedVisibleItems.value
    const idx = list.findIndex((item) => item.id === currentSelected)
    const remaining = list.filter((item) => !removedIds.has(item.id))
    const next =
      !narrow.value && remaining.length > 0
        ? (remaining[Math.min(Math.max(0, idx), remaining.length - 1)] ?? null)
        : null
    nextSelected = next ? next.id : null
    activeCardDirty.value = false
  }
  pruneInboxCache(removedIds)
  selectedSafeIds.value = selectedSafeIds.value.filter((x) => !removedIds.has(x))
  if (currentSelected && removedIds.has(currentSelected)) {
    selectedId.value = nextSelected
  }
}

function advanceAfterRemoving(removedId: string) {
  advanceAfterRemovingSet(new Set([removedId]))
}

function showInboxActionToast(options: Omit<Parameters<typeof toast.add>[0], 'id'>) {
  toast.toasts.value = toast.toasts.value.filter(
    (item) => !String(item.id).startsWith(INBOX_ACTION_TOAST_PREFIX),
  )
  const nextId = `${INBOX_ACTION_TOAST_PREFIX}${++inboxToastSeq}`
  latestInboxToastId = nextId
  toast.add({
    orientation: 'horizontal',
    ...options,
    id: nextId,
  })
  void nextTick(() => {
    if (latestInboxToastId !== nextId) return
    toast.toasts.value = toast.toasts.value.filter(
      (item) => !String(item.id).startsWith(INBOX_ACTION_TOAST_PREFIX) || item.id === nextId,
    )
  })
}

async function undoAppliedSuggestion(
  shortId: string,
  previousVersion: number,
  appliedVersion: number,
  title: string,
) {
  const key = `${shortId}:${appliedVersion}`
  if (undoingKeys.has(key) || undoneKeys.has(key)) return
  undoingKeys.add(key)
  try {
    const restored = await api.restoreEntry(shortId, {
      version: previousVersion,
      expectedVersion: appliedVersion,
    })
    undoneKeys.add(key)
    queryClient.setQueryData(['entry', shortId], restored)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      queryClient.invalidateQueries({ queryKey: ['entry-history', shortId] }),
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
      queryClient.invalidateQueries({ queryKey: ['boot-preview'] }),
    ])
    showInboxActionToast({
      title: `已撤销对「${title}」的应用，恢复至版本 ${previousVersion}`,
      color: 'success',
    })
  } catch (err) {
    showInboxActionToast({
      title:
        err instanceof ApiError && err.status === 409
          ? `「${title}」已有其他更新，无法自动撤销，请在版本历史中手动恢复`
          : err instanceof ApiError
            ? err.message
            : '撤销失败，请在版本历史中手动恢复',
      color: err instanceof ApiError && err.status === 409 ? 'warning' : 'error',
    })
  } finally {
    undoingKeys.delete(key)
  }
}

async function onApply(id: string, body: ApplySuggestionRequest) {
  if (busyId.value || batchBusy.value || batchDismissBusy.value) return
  const suggestion = items.value.find((item) => item.id === id)
  busyId.value = id
  try {
    const res = await api.applySuggestion(id, body)
    const applied = res.entry
    advanceAfterRemoving(id)
    // 合并重复会同时软删其他重复记忆，不支持单条恢复撤销，避免误导
    const canOfferUndo =
      suggestion?.kind !== 'merge_duplicates' &&
      applied &&
      applied.previousVersion !== undefined &&
      applied.version !== undefined
    if (canOfferUndo) {
      const { shortId, title, previousVersion, version } = applied
      showInboxActionToast({
        title: `已应用到「${title}」（版本 ${version}）`,
        color: 'success',
        duration: 8000,
        actions: [
          {
            label: '查看记忆',
            icon: icons.promote,
            color: 'neutral',
            variant: 'outline',
            onClick: () => void router.push(entryRoute(shortId)),
          },
          {
            label: '撤销',
            icon: icons.undelete,
            color: 'neutral',
            variant: 'outline',
            onClick: () => void undoAppliedSuggestion(shortId, previousVersion!, version!, title),
          },
        ],
      })
    } else {
      const redirectSuffix = res.redirectedBacklinkCount
        ? `，并自动重定向 ${res.redirectedBacklinkCount} 条反链`
        : ''
      showInboxActionToast({
        title: applied
          ? `已应用到「${applied.title}」${redirectSuffix}`
          : `已应用整理建议${redirectSuffix}`,
        color: 'success',
      })
    }
    const affectedShortIds = new Set<string>([
      ...(applied ? [applied.shortId] : []),
      ...(suggestion?.entries.map((e) => e.shortId) ?? []),
      ...(suggestion?.proposedLinks?.map((l) => l.targetShortId) ?? []),
    ])
    const redirectedAny = (res.redirectedBacklinkCount ?? 0) > 0
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      queryClient.invalidateQueries({ queryKey: ['boot-preview'] }),
      ...(redirectedAny
        ? [
            queryClient.invalidateQueries({ queryKey: ['entry'] }),
            queryClient.invalidateQueries({ queryKey: ['entry-history'] }),
          ]
        : [...affectedShortIds].flatMap((sid) => [
            queryClient.invalidateQueries({ queryKey: ['entry', sid] }),
            queryClient.invalidateQueries({ queryKey: ['entry-history', sid] }),
          ])),
    ])
  } catch (err) {
    showInboxActionToast({
      title: err instanceof ApiError ? err.message : '应用失败',
      color: 'error',
    })
    if (err instanceof ApiError && err.status === 409) {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    }
  } finally {
    busyId.value = null
  }
}

async function onDismiss(id: string) {
  if (busyId.value || batchBusy.value || batchDismissBusy.value) return
  busyId.value = id
  try {
    await api.dismissSuggestion(id)
    advanceAfterRemoving(id)
    showInboxActionToast({ title: '已忽略建议', color: 'neutral' })
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    showInboxActionToast({
      title: err instanceof ApiError ? err.message : '操作失败',
      color: 'error',
    })
  } finally {
    busyId.value = null
  }
}

function buildSafeBatchPayload(s: DreamSuggestionView): ApplySuggestionRequest {
  if (s.kind === 'adjust_boot_mode') return {}
  if (s.kind === 'link_entries') return { proposedLinks: s.proposedLinks ?? [] }
  const base = baseEntryOf(s)
  const nextSummary =
    s.proposedSummary !== undefined &&
    s.proposedSummary !== null &&
    s.proposedSummary.trim() !== (base?.summary?.trim() ?? '')
      ? s.proposedSummary.trim() || null
      : undefined
  const titleChanged = Boolean(
    s.proposedTitle?.trim() && base && s.proposedTitle.trim() !== base.title,
  )
  // 若更换标题或建议剥离了原正文重复首行 H1，同步剥离避免暴露失配旧 H1
  const shouldStripOldH1 =
    base !== null &&
    hasDuplicateLeadingHeading(base.title, base.content) &&
    (titleChanged ||
      (Boolean(s.proposedContent) && s.proposedContent!.trim() !== base.content.trim()))
  const safeContent = shouldStripOldH1
    ? stripDuplicateLeadingHeading(base.title, base.content)
    : base?.content
  return {
    ...(s.proposedTitle?.trim() ? { title: s.proposedTitle.trim() } : {}),
    ...(nextSummary !== undefined ? { summary: nextSummary } : {}),
    ...(safeContent !== undefined ? { content: safeContent } : {}),
    applyArchivedNotes: false,
    ...(s.proposedChangeSummary?.trim() ? { changeSummary: s.proposedChangeSummary.trim() } : {}),
  }
}

async function batchApplySafe(targets: readonly DreamSuggestionView[] = selectedSafeItems.value) {
  const chosen = targets.filter(isSafeForBatch)
  if (
    batchBusy.value ||
    batchDismissBusy.value ||
    busyId.value ||
    activeCardBusyOrEditing.value ||
    !chosen.length
  ) {
    return
  }
  batchBusy.value = true
  try {
    const touchedShortIds = new Set<string>()
    const appliedIds = new Set<string>()
    let okCount = 0
    let failCount = 0
    for (const s of chosen) {
      const base = baseEntryOf(s)
      const body = buildSafeBatchPayload(s)
      try {
        const res = await api.applySuggestion(s.id, body)
        if (res.entry?.shortId) touchedShortIds.add(res.entry.shortId)
        if (base?.shortId) touchedShortIds.add(base.shortId)
        for (const link of s.proposedLinks ?? []) touchedShortIds.add(link.targetShortId)
        appliedIds.add(s.id)
        okCount++
      } catch {
        failCount++
      }
    }
    advanceAfterRemovingSet(appliedIds)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      queryClient.invalidateQueries({ queryKey: ['boot-preview'] }),
      ...[...touchedShortIds].flatMap((sid) => [
        queryClient.invalidateQueries({ queryKey: ['entry', sid] }),
        queryClient.invalidateQueries({ queryKey: ['entry-history', sid] }),
      ]),
    ])
    if (failCount === 0) {
      showInboxActionToast({ title: `已批量应用 ${okCount} 条安全建议`, color: 'success' })
    } else {
      showInboxActionToast({
        title: `批量应用完成：成功 ${okCount} 条，失败 ${failCount} 条`,
        color: okCount > 0 ? 'warning' : 'error',
      })
    }
  } finally {
    batchBusy.value = false
  }
}

async function batchDismissSelected() {
  const chosen = selectedSafeItems.value
  if (
    batchBusy.value ||
    batchDismissBusy.value ||
    busyId.value ||
    activeCardBusyOrEditing.value ||
    !chosen.length
  ) {
    return
  }
  batchDismissBusy.value = true
  try {
    const dismissedIds = new Set<string>()
    let okCount = 0
    let failCount = 0
    for (const s of chosen) {
      try {
        await api.dismissSuggestion(s.id)
        dismissedIds.add(s.id)
        okCount++
      } catch {
        failCount++
      }
    }
    advanceAfterRemovingSet(dismissedIds)
    await queryClient.invalidateQueries({ queryKey: ['inbox'] })
    if (failCount === 0) {
      showInboxActionToast({ title: `已批量忽略 ${okCount} 条建议`, color: 'neutral' })
    } else {
      showInboxActionToast({
        title: `批量忽略完成：成功 ${okCount} 条，失败 ${failCount} 条`,
        color: okCount > 0 ? 'warning' : 'error',
      })
    }
  } finally {
    batchDismissBusy.value = false
  }
}

// ---- 键盘快捷审校流（J/K 切换、A 应用非高风险、E 编辑、D 忽略、Esc 退出） ----
function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

function hasOpenOverlay(): boolean {
  if (sweepOpen.value || railOpen.value || pendingDreamConfirm.value !== null) return true
  return Boolean(document.querySelector('[role="dialog"], [data-reka-popper-content-wrapper]'))
}

function stepSuggestion(delta: -1 | 1) {
  const list = orderedVisibleItems.value
  if (!list.length) return
  const currentIndex = activeIndex.value
  const nextIndex =
    delta > 0
      ? currentIndex < 0
        ? 0
        : Math.min(list.length - 1, currentIndex + 1)
      : currentIndex <= 0
        ? 0
        : currentIndex - 1
  const target = list[nextIndex]
  if (target && target.id !== selectedId.value) {
    if (!confirmSwitchAway()) return
    selectedId.value = target.id
    scrollSelectedRowIntoView(target.id)
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || hasOpenOverlay()) return
  const editing = Boolean(cardRef.value?.isEditing())

  if (event.key === 'Escape') {
    if (editing) {
      event.preventDefault()
      if (cardRef.value?.canCloseEditor()) {
        cardRef.value.requestCloseEditor()
      }
      return
    }
    if (isEditableElement(event.target)) return
    if (narrow.value && selectedId.value) {
      event.preventDefault()
      backToQueue()
    }
    return
  }

  if (editing || isEditableElement(event.target)) return
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return

  const key = event.key.toLowerCase()
  if (key === 'j' || event.key === 'ArrowDown' || key === 'k' || event.key === 'ArrowUp') {
    const list = orderedVisibleItems.value
    if (!list.length) return
    event.preventDefault()
    const currentIndex = activeIndex.value
    const nextIndex =
      key === 'j' || event.key === 'ArrowDown'
        ? currentIndex < 0
          ? 0
          : Math.min(list.length - 1, currentIndex + 1)
        : currentIndex <= 0
          ? 0
          : currentIndex - 1
    const target = list[nextIndex]
    if (target && target.id !== selectedId.value) {
      if (!confirmSwitchAway()) return
      selectedId.value = target.id
      scrollSelectedRowIntoView(target.id)
    }
    return
  }

  if (event.repeat) return

  const current = activeSuggestion.value
  if (!current) return

  if (key === 'a') {
    if (!isHighRisk(current) && cardRef.value?.canApplyDirect()) {
      event.preventDefault()
      cardRef.value.applyDirect()
    }
    return
  }

  if (key === 'e') {
    if (cardRef.value?.canOpenEditor()) {
      event.preventDefault()
      cardRef.value.openEditor()
    }
    return
  }

  if (key === 'd') {
    if (
      !busyId.value &&
      !batchBusy.value &&
      !batchDismissBusy.value &&
      !cardRef.value?.isReviseBusy()
    ) {
      event.preventDefault()
      void onDismiss(current.id)
    }
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
  stopDismissSync()
  stopTasksClearSync()
  stopResize()
  layoutObserver?.disconnect()
  layoutObserver = null
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    ref="layoutRef"
    class="organize-layout"
    :class="{
      'has-selection': Boolean(activeSuggestion),
      'is-resizing': resizing,
    }"
    :style="!narrow ? { '--queue-width': `${effectiveQueueWidth}px` } : undefined"
  >
    <!-- 左栏 216px：目录、发起整理与运行底账（同记忆页左侧等宽对齐） -->
    <div class="rail-col">
      <OrganizeIndexRail
        :scope-filter="scopeFilter"
        :kind-filter="kindFilter"
        :total-count="items.length"
        :review-count="allReviewCount"
        :safe-count="allSafeCount"
        :non-zero-kinds="nonZeroKinds"
        :tidy-pending-count="tidyPendingCount"
        :has-chat-model="hasChatModel"
        :me-loaded="Boolean(me.data.value)"
        :state="state"
        :schedule-items="scheduleItems"
        :schedule-summary-text="scheduleSummaryText"
        :running-stage-label="runningStageLabel"
        :running-mode-icon="runningModeIcon"
        :progress-percent="progressPercent"
        :show-failure-banner="showFailureBanner"
        :latest-failed-items="latestFailedItems"
        :latest-retryable-short-ids="latestRetryableShortIds"
        :standard-busy="standardBusy"
        :retry-failed-busy="retryFailedBusy"
        :cancelling-dream="cancellingDream"
        :model-run-disabled="modelRunDisabled"
        :tidy-menu-items="tidyMenuItems"
        @update:scope-filter="setScopeFilter"
        @update:kind-filter="setKindFilter"
        @run-standard="triggerDream({ mode: 'standard' })"
        @run-tidy-single="openFullTidyConfirm"
        @run-cross-memory="openCrossMemoryConfirm"
        @open-sweep="sweepOpen = true"
        @cancel-dream="cancelDream"
        @retry-failed="triggerRetryFailed"
        @dismiss-failure="dismissFailureBanner"
      />
    </div>

    <!-- 中栏 336px（可拖拽）：待确认队列（严格分「须逐条核对」与「安全快批」两组） -->
    <section class="queue-col" aria-label="待确认建议队列">
      <header class="queue-head">
        <div class="queue-head-left">
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.menu"
            class="mobile-rail-btn"
            @click="railOpen = true"
          >
            目录
          </UButton>
          <span class="queue-title tabular-nums">
            {{ queueHeading }} · {{ orderedVisibleItems.length }}
          </span>
          <span v-if="!isFiltered && items.length > 0" class="queue-breakdown tabular-nums">
            核对 {{ allReviewCount }} · 快批 {{ allSafeCount }}
          </span>
        </div>

        <div class="queue-head-right">
          <UButton
            v-if="isFiltered"
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="icons.filterX"
            @click="resetFilter"
          >
            全部
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="icons.refresh"
            :loading="inboxQuery.isFetching.value && !state?.running"
            @click="inboxQuery.refetch()"
          >
            刷新
          </UButton>
        </div>
      </header>

      <div v-if="inboxQuery.isError.value || (me.data.value && !hasChatModel)" class="queue-notes">
        <ReadFailureNote v-if="inboxQuery.isError.value" :query="inboxQuery" />
        <NoteLine v-if="me.data.value && !hasChatModel" tone="warning" flush>
          尚未配置对话模型，自动整理未启用；仍可执行结构检查。
        </NoteLine>
      </div>

      <div ref="queueScrollRef" class="queue-scroll">
        <div v-if="inboxQuery.isPending.value" class="queue-skeletons">
          <USkeleton v-for="n in 5" :key="n" class="h-16 w-full" />
        </div>

        <template v-else-if="orderedVisibleItems.length > 0">
          <!-- 组 1：须逐条核对（无批量勾选框，防高风险盲点误操作） -->
          <div v-if="visibleReviewItems.length > 0" class="queue-group">
            <div class="queue-group-head">
              <span class="queue-group-title is-risk tabular-nums">
                <UIcon :name="icons.lock" class="group-icon" aria-hidden="true" />
                <span>须逐条核对（{{ visibleReviewItems.length }}）</span>
              </span>
              <span class="queue-group-hint">逐条审校</span>
            </div>

            <ul class="queue-list">
              <li v-for="s in visibleReviewItems" :key="s.id" :data-suggestion-id="s.id">
                <button
                  type="button"
                  class="queue-item queue-item-btn"
                  :class="[
                    `is-${riskLevelOf(s)}`,
                    { 'is-selected': activeSuggestion?.id === s.id },
                  ]"
                  :aria-current="activeSuggestion?.id === s.id ? 'true' : undefined"
                  @click="selectSuggestion(s.id)"
                >
                  <span
                    class="q-mark"
                    :class="isHighRisk(s) ? 'is-high' : 'is-medium'"
                    :title="
                      isHighRisk(s) ? '高风险项须展开核对，不可批量勾选' : '正文变动项须核对后应用'
                    "
                    aria-hidden="true"
                  >
                    <UIcon :name="isHighRisk(s) ? icons.lock : icons.reveal" class="q-mark-icon" />
                  </span>

                  <span class="q-body">
                    <span class="q-head">
                      <span class="q-kind" :class="`is-${riskLevelOf(s)}`">
                        <UIcon
                          :name="dreamKindIcons[s.kind]"
                          class="q-kind-icon"
                          aria-hidden="true"
                        />
                        <span>{{ dreamKindLabels[s.kind] }}</span>
                      </span>
                      <time class="q-time" :datetime="s.createdAt" :title="formatTime(s.createdAt)">
                        {{ formatRelative(s.createdAt) }}
                      </time>
                    </span>
                    <span class="q-title">{{ targetTitleOf(s) }}</span>
                    <span class="q-impact tabular-nums">{{ queueImpactText(s) }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </div>

          <!-- 组 2：安全快批（仅放行 isSafeForBatch 项，复选框与主选按钮解耦避免嵌套交互控件） -->
          <div v-if="visibleSafeItems.length > 0" class="queue-group">
            <div class="queue-group-head">
              <span class="queue-group-title is-safe tabular-nums">
                <UIcon :name="icons.shieldCheck" class="group-icon" aria-hidden="true" />
                <span>安全快批（{{ visibleSafeItems.length }}）</span>
              </span>
              <div class="queue-group-actions">
                <button
                  type="button"
                  class="group-mini-btn"
                  :disabled="batchBusy || batchDismissBusy || activeCardBusyOrEditing"
                  @click="toggleSelectAllSafe"
                >
                  {{ allSafeSelected ? '取消全选' : '全选' }}
                </button>
                <button
                  v-if="selectedSafeItems.length === 0"
                  type="button"
                  class="group-mini-btn is-apply"
                  :disabled="
                    batchBusy || batchDismissBusy || busyId !== null || activeCardBusyOrEditing
                  "
                  @click="batchApplySafe(visibleSafeItems)"
                >
                  {{ batchBusy ? '应用中…' : '全部应用' }}
                </button>
              </div>
            </div>

            <ul class="queue-list">
              <li
                v-for="s in visibleSafeItems"
                :key="s.id"
                :data-suggestion-id="s.id"
                class="queue-item is-safe"
                :class="{ 'is-selected': activeSuggestion?.id === s.id }"
              >
                <label class="q-checkbox-hit" @click.stop>
                  <input
                    type="checkbox"
                    class="q-checkbox"
                    :aria-label="`选择安全快批项「${targetTitleOf(s)}」`"
                    :checked="selectedSafeIds.includes(s.id)"
                    :disabled="batchBusy || batchDismissBusy || activeCardBusyOrEditing"
                    @change="toggleSafeRow(s.id)"
                  />
                </label>

                <button
                  type="button"
                  class="q-body q-body-btn"
                  :aria-current="activeSuggestion?.id === s.id ? 'true' : undefined"
                  @click="selectSuggestion(s.id)"
                >
                  <span class="q-head">
                    <span class="q-kind is-safe">
                      <UIcon
                        :name="dreamKindIcons[s.kind]"
                        class="q-kind-icon"
                        aria-hidden="true"
                      />
                      <span>{{ dreamKindLabels[s.kind] }}</span>
                    </span>
                    <time class="q-time" :datetime="s.createdAt" :title="formatTime(s.createdAt)">
                      {{ formatRelative(s.createdAt) }}
                    </time>
                  </span>
                  <span class="q-title">{{ targetTitleOf(s) }}</span>
                  <span class="q-impact tabular-nums">{{ queueImpactText(s) }}</span>
                </button>
              </li>
            </ul>
          </div>
        </template>

        <div v-else-if="!inboxQuery.isError.value" class="queue-empty">
          <UIcon :name="icons.checkCircle" class="queue-empty-icon" aria-hidden="true" />
          <p class="queue-empty-title">暂无待确认建议</p>
          <p class="queue-empty-desc">可在目录中发起增量整理、规范整理、查重与关联或结构检查。</p>
          <UButton
            v-if="narrow"
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.menu"
            @click="railOpen = true"
          >
            打开整理目录
          </UButton>
        </div>
      </div>

      <!-- 底部安全快批操作条 -->
      <footer v-if="selectedSafeItems.length > 0" class="queue-batch-bar">
        <div class="batch-bar-top tabular-nums">
          <span>已选 {{ selectedSafeItems.length }} 条安全快批项</span>
          <button
            type="button"
            class="batch-clear-btn"
            :disabled="batchBusy || batchDismissBusy"
            @click="clearSafeSelection"
          >
            取消选择
          </button>
        </div>
        <div class="batch-bar-actions">
          <UButton
            size="xs"
            :icon="icons.listChecks"
            :loading="batchBusy"
            :disabled="busyId !== null || batchDismissBusy || activeCardBusyOrEditing"
            class="flex-1"
            @click="batchApplySafe()"
          >
            批量应用安全项（{{ selectedSafeItems.length }}）
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.cancel"
            :loading="batchDismissBusy"
            :disabled="batchBusy || busyId !== null || activeCardBusyOrEditing"
            @click="batchDismissSelected"
          >
            批量忽略
          </UButton>
        </div>
      </footer>
    </section>

    <!-- 右栏 1fr：全高审校台（或空态整理底账） -->
    <section class="review-col" aria-label="建议审校工作台">
      <div
        v-if="!narrow"
        class="pane-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调节队列与审校台宽度"
        :aria-valuenow="effectiveQueueWidth"
        :aria-valuemin="QUEUE_WIDTH_MIN"
        :aria-valuemax="maxAllowedQueueWidth"
        tabindex="0"
        title="拖动调节宽度，双击恢复默认"
        @pointerdown="startResize"
        @dblclick="resetQueueWidth"
        @keydown="onSplitterKeydown"
      />

      <DreamSuggestionCard
        v-if="activeSuggestion"
        :key="activeSuggestion.id"
        ref="cardRef"
        :suggestion="activeSuggestion"
        layout="inspector"
        :risk-level="riskLevelOf(activeSuggestion)"
        :position="activeIndex + 1"
        :total-count="orderedVisibleItems.length"
        :show-back="narrow"
        :has-prev="activeIndex > 0"
        :has-next="activeIndex >= 0 && activeIndex < orderedVisibleItems.length - 1"
        :busy="busyId === activeSuggestion.id"
        :disabled="
          batchBusy || batchDismissBusy || (busyId !== null && busyId !== activeSuggestion.id)
        "
        @apply="onApply"
        @dismiss="onDismiss"
        @back="backToQueue"
        @prev="stepSuggestion(-1)"
        @next="stepSuggestion(1)"
        @dirty-change="activeCardDirty = $event"
      />

      <div
        v-else-if="!inboxQuery.isPending.value && !inboxQuery.isError.value"
        class="empty-workbench"
      >
        <div class="empty-workbench-inner">
          <EmptyState
            :icon="icons.checkCircle"
            tone="success"
            title="暂无待确认建议"
            description="会话摘要与记忆变动累积后，定时或手动整理会在此生成建议。"
          >
            <template #actions>
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.shieldCheck"
                @click="sweepOpen = true"
              >
                结构检查
              </UButton>
              <UButton
                v-if="hasChatModel"
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.links"
                :disabled="modelRunDisabled"
                @click="openCrossMemoryConfirm"
              >
                查重与关联
              </UButton>
              <UButton
                v-if="hasChatModel"
                size="sm"
                :icon="icons.sparkles"
                :loading="standardBusy"
                :disabled="modelRunDisabled"
                @click="triggerDream({ mode: 'standard' })"
              >
                {{ state?.running ? '整理中' : '增量整理' }}
              </UButton>
              <UButton
                v-if="me.data.value && !hasChatModel"
                size="sm"
                :icon="icons.models"
                :to="settingsRoute('models')"
              >
                前往模型设置
              </UButton>
            </template>
          </EmptyState>

          <div v-if="state" class="ledger-summary-grid">
            <div class="ledger-summary-card">
              <div class="summary-card-head">
                <UIcon :name="icons.calendarClock" class="summary-card-icon" aria-hidden="true" />
                <span>定时整理日程</span>
              </div>
              <ul class="summary-list tabular-nums">
                <li v-for="sched in scheduleItems" :key="sched.mode" class="summary-row">
                  <span class="summary-row-lead">
                    <UIcon :name="sched.icon" class="summary-row-icon" aria-hidden="true" />
                    <span>{{ sched.label }}</span>
                  </span>
                  <span class="summary-row-val" :class="{ 'is-enabled': sched.enabled }">
                    {{ sched.enabled ? formatScheduleInterval(sched.intervalHours) : '已关闭' }}
                  </span>
                </li>
              </ul>
            </div>

            <div class="ledger-summary-card">
              <div class="summary-card-head">
                <UIcon :name="icons.history" class="summary-card-icon" aria-hidden="true" />
                <span>最近运行记录</span>
              </div>
              <ul v-if="state.recentRuns.length" class="summary-list tabular-nums">
                <li v-for="run in state.recentRuns.slice(0, 4)" :key="run.id" class="summary-row">
                  <span class="summary-row-lead">
                    <span>{{ dreamModeLabels[run.mode ?? 'standard'] }}</span>
                    <span class="summary-outcome">{{ dreamOutcomeLabels[run.outcome] }}</span>
                  </span>
                  <span class="summary-row-val" :title="formatTime(run.createdAt)">
                    评 {{ run.considered }} 生 {{ run.suggested }} ·
                    {{ formatRelative(run.createdAt) }}
                  </span>
                </li>
              </ul>
              <p v-else class="summary-empty">尚未执行过自动或手动整理。</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 窄屏左侧目录与调度抽屉 -->
    <USlideover
      v-model:open="railOpen"
      side="left"
      title="目录与调度"
      :ui="{
        content: 'max-w-72 sm:max-w-72',
        body: 'p-0 sm:p-0 flex flex-col min-h-0 overflow-hidden',
      }"
    >
      <template #body>
        <OrganizeIndexRail
          :scope-filter="scopeFilter"
          :kind-filter="kindFilter"
          :total-count="items.length"
          :review-count="allReviewCount"
          :safe-count="allSafeCount"
          :non-zero-kinds="nonZeroKinds"
          :tidy-pending-count="tidyPendingCount"
          :has-chat-model="hasChatModel"
          :me-loaded="Boolean(me.data.value)"
          :state="state"
          :schedule-items="scheduleItems"
          :schedule-summary-text="scheduleSummaryText"
          :running-stage-label="runningStageLabel"
          :running-mode-icon="runningModeIcon"
          :progress-percent="progressPercent"
          :show-failure-banner="showFailureBanner"
          :latest-failed-items="latestFailedItems"
          :latest-retryable-short-ids="latestRetryableShortIds"
          :standard-busy="standardBusy"
          :retry-failed-busy="retryFailedBusy"
          :cancelling-dream="cancellingDream"
          :model-run-disabled="modelRunDisabled"
          :tidy-menu-items="tidyMenuItems"
          in-drawer
          @update:scope-filter="setScopeFilter"
          @update:kind-filter="setKindFilter"
          @run-standard="((railOpen = false), triggerDream({ mode: 'standard' }))"
          @run-tidy-single="openFullTidyConfirm"
          @run-cross-memory="openCrossMemoryConfirm"
          @open-sweep="((railOpen = false), (sweepOpen = true))"
          @cancel-dream="cancelDream"
          @retry-failed="triggerRetryFailed"
          @dismiss-failure="dismissFailureBanner"
        />
      </template>
    </USlideover>

    <HygieneSweepDrawer v-model:open="sweepOpen" />
    <ConsequenceModal
      :open="pendingDreamConfirm !== null"
      tone="primary"
      :title="pendingDreamConfirm?.title ?? ''"
      :title-icon="pendingDreamConfirm?.icon"
      :consequences="pendingDreamConfirm?.consequences ?? []"
      :action="pendingDreamConfirm?.action ?? '确认'"
      :action-icon="pendingDreamConfirm?.icon"
      :busy="triggeringMode !== null"
      :error="dreamConfirmError"
      @confirm="confirmHeavyDream"
      @close="((pendingDreamConfirm = null), (dreamConfirmError = null))"
    />
  </div>
</template>

<style scoped>
.organize-layout {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: 216px var(--queue-width, 336px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  width: 100%;
  max-width: 1840px;
  margin-inline: auto;
  min-width: 0;
  min-height: 0;
}
.organize-layout.is-resizing {
  user-select: none;
  cursor: col-resize;
}
@media (min-width: 1841px) {
  .organize-layout {
    border-inline: 1px solid var(--ui-border-muted);
  }
}
.rail-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--ui-border-accented);
}
.queue-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.review-col {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg-bright);
}

/* ---- 中栏顶部上下文条与队列 ---- */
.queue-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 40px;
  padding: 6px 10px 6px 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.queue-head-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.mobile-rail-btn {
  display: none;
}
.queue-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  white-space: nowrap;
}
.queue-breakdown {
  font-size: 12px;
  color: var(--ui-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.queue-head-right {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.queue-notes {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ui-border);
}
.queue-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.queue-skeletons {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}
.queue-group-head {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
}
.queue-group-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  color: var(--ui-text-toned);
}
.queue-group-title.is-risk {
  color: var(--ui-error);
}
.queue-group-title.is-safe {
  color: var(--ui-success);
}
.group-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.queue-group-hint {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.queue-group-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.group-mini-btn {
  padding: 1px 6px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.group-mini-btn:hover:not(:disabled) {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.group-mini-btn.is-apply {
  border-color: var(--ui-success);
  color: var(--ui-success);
  font-weight: 500;
}
.group-mini-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.queue-list {
  display: flex;
  flex-direction: column;
}
.queue-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 10px 12px 10px 10px;
  border-bottom: 1px solid var(--ui-border-muted);
  border-left: 3px solid transparent;
  background: var(--ui-bg);
  text-align: left;
  transition: background-color 100ms ease;
}
.queue-item-btn {
  cursor: pointer;
}
.queue-item:hover {
  background: var(--ui-bg-muted);
}
.queue-item-btn:focus-visible,
.q-body-btn:focus-visible {
  outline: 2px solid var(--ui-rule);
  outline-offset: -2px;
}
.queue-item.is-selected .queue-item-btn:focus-visible,
.queue-item.is-selected .q-body-btn:focus-visible {
  outline-color: var(--ui-on-selected);
}
.queue-item.is-high {
  border-left-color: var(--ui-error);
}
.queue-item.is-medium {
  border-left-color: var(--ui-warning);
}
.queue-item.is-safe {
  border-left-color: var(--ui-success);
}
.queue-item.is-selected {
  background: var(--ui-selected);
  color: var(--ui-on-selected);
  border-bottom-color: var(--ui-selected);
}
.q-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
}
.q-mark.is-high {
  border-color: var(--ui-error);
  color: var(--ui-error);
}
.q-mark.is-medium {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.queue-item.is-selected .q-mark {
  border-color: color-mix(in srgb, var(--ui-on-selected) 40%, transparent);
  background: transparent;
  color: var(--ui-on-selected);
}
.q-mark-icon {
  display: inline-block;
  flex: none;
  width: 11px;
  height: 11px;
}
.q-checkbox-hit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  margin-top: 2px;
  cursor: pointer;
}
.q-checkbox {
  flex: none;
  width: 15px;
  height: 15px;
  accent-color: var(--ui-primary);
  cursor: pointer;
}
.queue-item.is-selected .q-checkbox {
  accent-color: var(--ui-on-selected);
}
.q-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.q-body-btn {
  text-align: left;
  cursor: pointer;
}
.q-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.q-kind {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ui-text-toned);
}
.q-kind.is-high {
  border-color: var(--ui-error);
  color: var(--ui-error);
}
.q-kind.is-medium {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.q-kind.is-safe {
  border-color: var(--ui-success);
  color: var(--ui-success);
}
.queue-item.is-selected .q-kind {
  border-color: color-mix(in srgb, var(--ui-on-selected) 35%, transparent);
  background: color-mix(in srgb, var(--ui-on-selected) 14%, transparent);
  color: var(--ui-on-selected);
}
.q-kind-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.q-time {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.queue-item.is-selected .q-time {
  color: var(--ui-on-selected-muted);
}
.q-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--ui-text-highlighted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.queue-item.is-selected .q-title {
  font-weight: 600;
  color: var(--ui-on-selected);
}
.q-impact {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-item.is-selected .q-impact {
  color: var(--ui-on-selected-muted);
}

.queue-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 40px 20px;
  text-align: center;
}
.queue-empty-icon {
  display: inline-block;
  width: 24px;
  height: 24px;
  color: var(--ui-success);
}
.queue-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.queue-empty-desc {
  font-size: 12px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}

/* 队列底部安全快批条 */
.queue-batch-bar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--ui-rule);
  background: var(--ui-bg-elevated);
}
.batch-bar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.batch-clear-btn {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-muted);
  text-decoration: underline;
  cursor: pointer;
}
.batch-clear-btn:hover {
  color: var(--ui-text-highlighted);
}
.batch-bar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ---- 拖拽分隔线（同记忆页） ---- */
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
.organize-layout.is-resizing .pane-splitter::after {
  opacity: 1;
}
.pane-splitter:focus-visible {
  outline: 0;
}

/* ---- 空态右栏：整理底账 ---- */
.empty-workbench {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: var(--ui-bg);
}
.empty-workbench-inner {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 740px;
}
.ledger-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.ledger-summary-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
}
.summary-card-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.summary-card-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.summary-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
}
.summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.summary-row-lead {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-toned);
}
.summary-row-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.summary-outcome {
  padding: 0 4px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.summary-row-val {
  color: var(--ui-text-muted);
  text-align: right;
}
.summary-row-val.is-enabled {
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.summary-empty {
  font-size: 12px;
  color: var(--ui-text-muted);
}

/* ---- 窄屏 < 1024px 降级为单栏切换 + 左目录抽屉 ---- */
@media (max-width: 1023.98px) {
  .organize-layout {
    grid-template-columns: minmax(0, 1fr);
    max-width: none;
  }
  .rail-col,
  .pane-splitter {
    display: none;
  }
  .mobile-rail-btn {
    display: inline-flex;
  }
  .queue-col {
    border-right: 0;
  }
  .organize-layout.has-selection .queue-col {
    display: none;
  }
  .organize-layout:not(.has-selection) .review-col {
    display: none;
  }
}
@media (max-width: 767.98px), (pointer: coarse) {
  .q-checkbox-hit {
    width: 36px;
    height: 36px;
    margin: -8px -4px -8px -8px;
  }
  .group-mini-btn {
    min-height: 32px;
    padding: 4px 10px;
  }
}
</style>
