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
  type TriggerDreamRequest,
} from '@kioku/contracts'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import ConsequenceModal from '../components/ConsequenceModal.vue'
import DreamSuggestionCard from '../components/DreamSuggestionCard.vue'
import HygieneSweepDrawer from '../components/HygieneSweepDrawer.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import NoteLine from '../components/ui/NoteLine.vue'
import ReadFailureNote from '../components/ui/ReadFailureNote.vue'
import { useSession } from '../composables/useSession'
import { isTitleOnlyTidy } from '../diff'
import { icons } from '../icons'
import {
  bootModeIcons,
  bootModeLabels,
  dreamKindIcons,
  dreamKindLabels,
  dreamModeLabels,
  dreamOutcomeLabels,
} from '../labels'
import { entryRoute, settingsRoute } from '../routes'
import { formatRelative, formatTime } from '../time'

type KindFilter = 'all' | DreamSuggestionKind

const FILTER_ORDER: readonly DreamSuggestionKind[] = [
  'adjust_boot_mode',
  'link_entries',
  'merge_duplicates',
  'tidy',
  'distill_episode',
  'update',
  'mark_stale',
]

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()

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
const statusPopoverOpen = ref(false)
const failedDetailsOpen = ref(false)
const sweepOpen = ref(false)

const progressPercent = computed(() =>
  progress.value && progress.value.total > 0
    ? Math.min(100, Math.round((progress.value.processed / progress.value.total) * 100))
    : 0,
)

const runningStageLabel = computed(() => {
  if (progress.value?.stage) return `${progress.value.stage}中`
  if (progress.value?.mode === 'tidy') return '规范整理中'
  if (progress.value?.mode === 'cross_memory') return '查重/关联中'
  return '增量整理中'
})

const runningModeIcon = computed(() =>
  progress.value?.mode === 'tidy'
    ? icons.tidy
    : progress.value?.mode === 'cross_memory'
      ? icons.links
      : icons.sparkles,
)

interface ScheduleDisplayItem {
  mode: DreamMode
  label: string
  icon: string
  enabled: boolean
  intervalHours: number
  lastRunAt: string | null
}

const scheduleItems = computed<ScheduleDisplayItem[]>(() => {
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

const enabledSchedules = computed(() => scheduleItems.value.filter((item) => item.enabled))

const scheduleSummaryText = computed(() => {
  const list = enabledSchedules.value
  if (list.length === 0) return '定时关闭'
  if (list.length === 1) {
    const only = list[0]!
    return `${only.label} 每 ${only.intervalHours}h`
  }
  return `定时已开 ${list.length} 项`
})

function formatScheduleInterval(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) {
    return `每 ${hours / 24} 天（${hours}h）`
  }
  return `每 ${hours} 小时`
}

// ---- 分类筛选（与路由 query.kind 同步，仅渲染非零分类） ----
function parseKindQuery(raw: unknown): KindFilter {
  if (typeof raw !== 'string') return 'all'
  return (DREAM_KINDS as readonly string[]).includes(raw) ? (raw as DreamSuggestionKind) : 'all'
}

const kindFilter = ref<KindFilter>(parseKindQuery(route.query.kind))

watch(
  () => route.query.kind,
  (raw) => {
    const parsed = parseKindQuery(raw)
    if (parsed !== kindFilter.value) kindFilter.value = parsed
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

const filterTabs = computed<{ value: KindFilter; label: string; icon: string; count: number }[]>(
  () => [
    { value: 'all', label: '全部', icon: icons.layers, count: kindCounts.value.all },
    ...FILTER_ORDER.filter((k) => DREAM_KINDS.includes(k) && kindCounts.value[k] > 0).map((k) => ({
      value: k as KindFilter,
      label: dreamKindLabels[k],
      icon: dreamKindIcons[k],
      count: kindCounts.value[k],
    })),
  ],
)

watch(
  [data, kindCounts, kindFilter],
  ([loaded, counts, currentKind]) => {
    if (!loaded) return
    if (currentKind !== 'all' && counts[currentKind] === 0) {
      kindFilter.value = 'all'
    }
  },
  { immediate: true },
)

const filteredItems = computed(() =>
  kindFilter.value === 'all'
    ? items.value
    : items.value.filter((item) => item.kind === kindFilter.value),
)

function onFilterTabKeydown(event: KeyboardEvent, index: number) {
  const tabs = filterTabs.value
  if (!tabs.length) return
  let nextIdx = -1
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIdx = (index + 1) % tabs.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
    nextIdx = (index - 1 + tabs.length) % tabs.length
  else if (event.key === 'Home') nextIdx = 0
  else if (event.key === 'End') nextIdx = tabs.length - 1
  if (nextIdx < 0) return
  event.preventDefault()
  kindFilter.value = tabs[nextIdx]!.value
  const listEl = (event.currentTarget as HTMLElement | null)?.parentElement
  listEl?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIdx]?.focus()
}

// ---- 台账行元数据与风险判定 ----
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

// 合并、移入回收站或存在完整性/缩水告警的行强制先展开核对，避免盲点误操作
function isHighRisk(s: DreamSuggestionView): boolean {
  return s.kind === 'merge_duplicates' || s.kind === 'mark_stale' || hasIntegrityAlert(s)
}

// 批量应用安全项仅放行无缺链/缺凭据、非高风险且属于纯标题/概要或启动加载/补全双链的建议
function isSafeForBatch(s: DreamSuggestionView): boolean {
  if (s.kind === 'merge_duplicates' || s.kind === 'mark_stale') return false
  if (hasIntegrityAlert(s)) return false
  if (s.kind === 'adjust_boot_mode') return true
  if (s.kind === 'link_entries') return Boolean(s.proposedLinks?.length)
  return isTitleOnlyTidy(s)
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

function tidyDeltaPrimaryPill(s: DreamSuggestionView): string {
  const parts: string[] = []
  const titleChanged = hasTitleDiff(s)
  const body = contentDeltaInfo(s)
  if (titleChanged) parts.push(s.kind === 'tidy' ? '规范标题' : '更新标题')
  if (body.label) parts.push(body.label)
  if (!parts.length && hasSummaryDiff(s)) parts.push('更新概要')
  return parts.length ? parts.join(' + ') : s.kind === 'tidy' ? '规范调整' : '更新内容'
}

function tidyDeltaSubText(s: DreamSuggestionView): {
  text: string
  warn: boolean
  icon?: string
} | null {
  const integ = computeIntegrityOf(s)
  if (integ && (integ.missingLinks.length > 0 || integ.missingCreds.length > 0)) {
    return { text: '存在引用缺失，请展开核对后再应用', warn: true, icon: icons.shieldAlert }
  }
  const body = contentDeltaInfo(s)
  if (integ?.severeShrink) {
    return {
      text: `正文缩减 ${Math.abs(body.pct)}%，请展开核对变更与归档说明`,
      warn: true,
      icon: icons.warning,
    }
  }
  const bits: string[] = []
  if (hasSummaryDiff(s)) bits.push('更新现行概要')
  if (s.archivedNotes?.length) bits.push(`归档 ${s.archivedNotes.length} 条历史说明`)
  if (!bits.length && body.changed && !hasTitleDiff(s)) {
    const base = baseEntryOf(s)
    if (base && s.proposedContent) {
      bits.push(
        `篇幅 ${base.content.length.toLocaleString()} → ${s.proposedContent.length.toLocaleString()} 字`,
      )
    }
  }
  return bits.length ? { text: bits.join('，'), warn: false } : null
}

function firstLinkAnchor(s: DreamSuggestionView): string | null {
  const raw = s.proposedLinks?.[0]?.anchorHeading?.replace(/^#{1,6}\s*/, '').trim()
  return raw || null
}

// ---- 行展开与勾选状态（进入页面默认全部折叠） ----
const expandedIds = ref<string[]>([])
const selectedIds = ref<string[]>([])

watch(
  filteredItems,
  (list) => {
    const valid = new Set(list.map((i) => i.id))
    expandedIds.value = expandedIds.value.filter((id) => valid.has(id))
    selectedIds.value = selectedIds.value.filter((id) => valid.has(id))
  },
  { immediate: true },
)

function isExpanded(id: string): boolean {
  return expandedIds.value.includes(id)
}

function toggleExpand(id: string) {
  if (expandedIds.value.includes(id)) {
    expandedIds.value = expandedIds.value.filter((x) => x !== id)
  } else {
    expandedIds.value = [...expandedIds.value, id]
  }
}

const anyVisibleExpanded = computed(() =>
  filteredItems.value.some((item) => expandedIds.value.includes(item.id)),
)

function toggleAllExpanded() {
  if (anyVisibleExpanded.value) {
    expandedIds.value = []
  } else {
    expandedIds.value = filteredItems.value.map((i) => i.id)
  }
}

const visibleSelectedItems = computed(() =>
  filteredItems.value.filter((i) => selectedIds.value.includes(i.id)),
)
const safeSelectedItems = computed(() => visibleSelectedItems.value.filter(isSafeForBatch))
const hasUnsafeSelected = computed(() =>
  visibleSelectedItems.value.some((item) => !isSafeForBatch(item)),
)
const allVisibleSelected = computed(
  () =>
    filteredItems.value.length > 0 &&
    visibleSelectedItems.value.length === filteredItems.value.length,
)
const someVisibleSelected = computed(
  () =>
    visibleSelectedItems.value.length > 0 &&
    visibleSelectedItems.value.length < filteredItems.value.length,
)

function toggleSelectAll() {
  if (allVisibleSelected.value) {
    selectedIds.value = []
  } else {
    selectedIds.value = filteredItems.value.map((i) => i.id)
  }
}

function toggleSelectRow(id: string) {
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((x) => x !== id)
  } else {
    selectedIds.value = [...selectedIds.value, id]
  }
}

function clearSelection() {
  selectedIds.value = []
}

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
  dreamConfirmError.value = null
  pendingDreamConfirm.value = confirm
}

function openCrossMemoryConfirm() {
  requestHeavyDreamConfirm({
    req: { mode: 'cross_memory', scope: 'full_corpus' },
    title: '发起全库查重/关联？',
    action: '开始查重/关联',
    icon: icons.links,
    consequences: [
      '将对全部活跃记忆扫描重复合并、缺失双链与常驻结构，会触发多轮模型调用并耗时数分钟。',
      '整理结果仅写入待处理建议，不会直接修改现有记忆。',
      '执行期间可随时在待处理页或顶部导航栏取消。',
    ],
  })
}

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
          ? '已发起查重/关联整理'
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

const organizeMenuItems = computed<DropdownMenuItem[][]>(() => {
  const count = tidyPendingCount.value
  const disabledLlm = modelRunDisabled.value

  const openFullTidyConfirm = () =>
    requestHeavyDreamConfirm({
      req: { mode: 'tidy', pinnedFirst: true, all: true },
      title: `发起全量规范整理（${count} 条）？`,
      action: '开始规范整理',
      icon: icons.tidy,
      consequences: [
        `将逐条对全部 ${count} 条待规范记忆执行标题规范、概要补全与旧日志剥离，会触发多轮模型调用。`,
        '整理结果仅写入待处理建议，不会直接修改现有记忆。',
        '执行期间可随时在待处理页或顶部导航栏取消。',
      ],
    })

  const tidyChildren: DropdownMenuItem[] = []
  if (count > 10) {
    tidyChildren.push({
      label: '本批 10 条（常驻优先）',
      icon: icons.tidy,
      disabled: disabledLlm,
      onSelect: () => void triggerDream({ mode: 'tidy', pinnedFirst: true, limit: 10 }),
    })
  }
  if (count > 20) {
    tidyChildren.push({
      label: '本批 20 条（常驻优先）',
      icon: icons.tidy,
      disabled: disabledLlm,
      onSelect: () => void triggerDream({ mode: 'tidy', pinnedFirst: true, limit: 20 }),
    })
  }
  if (count > 10) {
    tidyChildren.push({
      label: `全部待规范（${count} 条）`,
      icon: icons.listChecks,
      disabled: disabledLlm,
      onSelect: openFullTidyConfirm,
    })
  }

  const tidyItem: DropdownMenuItem =
    count > 10
      ? {
          label: `规范整理（${count} 条）`,
          description: '逐条规范脏标题、补概要并剥离旧日志',
          icon: icons.tidy,
          disabled: disabledLlm,
          children: tidyChildren,
        }
      : {
          label: count > 0 ? `规范整理（${count} 条）` : '规范整理',
          description: count > 0 ? '逐条规范脏标题、补概要并剥离旧日志' : '当前暂无待规范存量',
          icon: icons.tidy,
          disabled: disabledLlm || count <= 0,
          onSelect: openFullTidyConfirm,
        }

  return [
    [
      {
        label: '增量整理',
        description: '整理近期新增或改动的记忆与会话摘要',
        icon: icons.sparkles,
        disabled: disabledLlm,
        onSelect: () => void triggerDream({ mode: 'standard' }),
      },
      {
        label: '查重/关联',
        description: '全库扫描重复合并、补全双链与常驻巡检',
        icon: icons.links,
        disabled: disabledLlm,
        onSelect: openCrossMemoryConfirm,
      },
      tidyItem,
    ],
    [
      {
        label: '结构检查',
        description: '不消耗模型，检查并清理重复标题、旧引用与悬空断链',
        icon: icons.shieldCheck,
        onSelect: () => {
          sweepOpen.value = true
        },
      },
      {
        label: '刷新列表',
        description: '重新获取最新待处理队列',
        icon: icons.refresh,
        onSelect: () => {
          void inboxQuery.refetch()
        },
      },
    ],
  ]
})

// ---- 应用、8 秒撤销与批量操作 ----
const busyId = ref<string | null>(null)
const batchBusy = ref(false)
const batchDismissBusy = ref(false)
const undoingKeys = new Set<string>()
const undoneKeys = new Set<string>()

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
    toast.add({
      title: `已撤销对「${title}」的应用，恢复至版本 ${previousVersion}`,
      color: 'success',
    })
  } catch (err) {
    toast.add({
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
    // 合并重复会同时软删其他重复记忆，不支持单条恢复撤销，避免误导
    const canOfferUndo =
      suggestion?.kind !== 'merge_duplicates' &&
      applied &&
      applied.previousVersion !== undefined &&
      applied.version !== undefined
    if (canOfferUndo) {
      const { shortId, title, previousVersion, version } = applied
      toast.add({
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
        ? `，并自动重定向 ${res.redirectedBacklinkCount} 条引用双链`
        : ''
      toast.add({
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
    toast.add({ title: err instanceof ApiError ? err.message : '应用失败', color: 'error' })
    if (err instanceof ApiError && err.status === 409) {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    }
  } finally {
    busyId.value = null
  }
}

function onQuickApply(s: DreamSuggestionView) {
  if (isHighRisk(s)) {
    toggleExpand(s.id)
    return
  }
  void onApply(s.id, {})
}

async function onDismiss(id: string) {
  if (busyId.value || batchBusy.value || batchDismissBusy.value) return
  busyId.value = id
  try {
    await api.dismissSuggestion(id)
    toast.add({ title: '已忽略建议', color: 'neutral' })
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '操作失败', color: 'error' })
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

async function batchApplySafe() {
  const chosen = safeSelectedItems.value
  if (batchBusy.value || batchDismissBusy.value || busyId.value || !chosen.length) return
  batchBusy.value = true
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
  selectedIds.value = selectedIds.value.filter((id) => !appliedIds.has(id))
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
    toast.add({ title: `已批量应用 ${okCount} 条安全建议`, color: 'success' })
  } else {
    toast.add({
      title: `批量应用完成：成功 ${okCount} 条，失败 ${failCount} 条`,
      color: okCount > 0 ? 'warning' : 'error',
    })
  }
  batchBusy.value = false
}

async function batchDismissSelected() {
  const chosen = visibleSelectedItems.value
  if (batchBusy.value || batchDismissBusy.value || busyId.value || !chosen.length) return
  batchDismissBusy.value = true
  let okCount = 0
  let failCount = 0
  for (const s of chosen) {
    try {
      await api.dismissSuggestion(s.id)
      okCount++
    } catch {
      failCount++
    }
  }
  selectedIds.value = []
  await queryClient.invalidateQueries({ queryKey: ['inbox'] })
  if (failCount === 0) {
    toast.add({ title: `已批量忽略 ${okCount} 条建议`, color: 'neutral' })
  } else {
    toast.add({
      title: `批量忽略完成：成功 ${okCount} 条，失败 ${failCount} 条`,
      color: okCount > 0 ? 'warning' : 'error',
    })
  }
  batchDismissBusy.value = false
}
</script>

<template>
  <div class="inbox-page">
    <div class="inbox-shell">
      <!-- 顶部单行指挥条 -->
      <header class="command-bar" aria-label="待处理指挥条">
        <div class="command-left">
          <h1 class="page-title">待处理</h1>

          <UPopover
            v-if="state || data"
            v-model:open="statusPopoverOpen"
            :content="{ align: 'start', sideOffset: 6 }"
          >
            <button
              type="button"
              class="status-summary-btn tabular-nums"
              :aria-expanded="statusPopoverOpen"
            >
              <template v-if="state?.running">
                <span class="status-chunk status-running">
                  <UIcon :name="runningModeIcon" class="status-inline-icon" aria-hidden="true" />
                  <span>{{ runningStageLabel }}</span>
                </span>
                <template v-if="progress && progress.total > 0">
                  <span class="hair-sep" aria-hidden="true" />
                  <span>{{ progress.processed }} / {{ progress.total }} 条</span>
                </template>
                <span class="hair-sep" aria-hidden="true" />
                <span :class="items.length > 0 ? 'status-count-hot' : 'status-count-clear'">
                  {{ items.length }} 条待处理
                </span>
              </template>
              <template v-else>
                <span
                  class="status-chunk"
                  :class="items.length > 0 ? 'status-count-hot' : 'status-count-clear'"
                >
                  <UIcon :name="icons.inbox" class="status-inline-icon" aria-hidden="true" />
                  <span>{{ items.length }} 条待处理</span>
                </span>
                <span class="hair-sep" aria-hidden="true" />
                <span v-if="state?.lastRunAt" :title="formatTime(state.lastRunAt)">
                  上次 {{ formatRelative(state.lastRunAt) }}
                </span>
                <span v-else>尚未整理</span>
                <span class="hair-sep" aria-hidden="true" />
                <span class="status-chunk">
                  <UIcon
                    :name="icons.calendarClock"
                    class="status-inline-icon"
                    aria-hidden="true"
                  />
                  <span>{{ scheduleSummaryText }}</span>
                </span>
              </template>
              <UIcon :name="icons.chevronDown" class="status-caret" aria-hidden="true" />
            </button>

            <template #content>
              <div class="status-popover">
                <div class="popover-head">
                  <span class="popover-title">
                    <UIcon
                      :name="icons.calendarClock"
                      class="popover-head-icon"
                      aria-hidden="true"
                    />
                    <span>整理状态与定时</span>
                  </span>
                  <span class="popover-state" :class="{ 'is-active': state?.running }">
                    {{ state?.running ? '整理中' : '空闲' }}
                  </span>
                </div>

                <ul class="popover-schedules tabular-nums" aria-label="定时整理日程">
                  <li v-for="sched in scheduleItems" :key="sched.mode" class="popover-sched-row">
                    <span class="popover-sched-name">
                      <UIcon :name="sched.icon" class="popover-sched-icon" aria-hidden="true" />
                      <span>{{ sched.label }}</span>
                    </span>
                    <span class="popover-sched-val" :class="{ 'is-enabled': sched.enabled }">
                      {{ sched.enabled ? formatScheduleInterval(sched.intervalHours) : '已关闭' }}
                    </span>
                  </li>
                </ul>

                <dl class="kv-list tabular-nums">
                  <dt>待规范存量</dt>
                  <dd>{{ tidyPendingCount }} 条</dd>
                  <dt>对话模型</dt>
                  <dd>{{ hasChatModel ? '已启用' : '未配置' }}</dd>
                  <dt>上次整理</dt>
                  <dd>
                    <span v-if="state?.running">正在整理…</span>
                    <template v-else-if="state?.lastRunAt">
                      {{ formatRelative(state.lastRunAt) }}
                      <template v-if="state.lastOutcome">
                        （{{ dreamOutcomeLabels[state.lastOutcome] }}）
                      </template>
                    </template>
                    <span v-else>尚未执行过</span>
                  </dd>
                  <template v-if="latestRun">
                    <dt>最近批次</dt>
                    <dd>
                      评估 {{ latestRun.considered }} 条，生成 {{ latestRun.suggested }} 条
                      <template v-if="latestRun.retriedCount">
                        （重试 {{ latestRun.retriedCount }} 次）
                      </template>
                    </dd>
                  </template>
                </dl>

                <p
                  v-if="!state?.running && state?.lastError"
                  class="popover-error"
                  :class="{ 'is-partial': state.lastOutcome === 'partial' }"
                >
                  <UIcon
                    :name="state.lastOutcome === 'partial' ? icons.warning : icons.error"
                    class="popover-error-icon"
                    aria-hidden="true"
                  />
                  <span>
                    {{
                      state.lastOutcome === 'partial' ? state.lastError : `错误：${state.lastError}`
                    }}
                  </span>
                </p>

                <div
                  v-if="!state?.running && latestFailedItems.length > 0"
                  class="popover-failures"
                >
                  <div class="failures-head tabular-nums">
                    <span>失败明细（{{ latestFailedItems.length }} 条）</span>
                    <button
                      type="button"
                      class="failures-toggle"
                      :aria-expanded="failedDetailsOpen"
                      @click="failedDetailsOpen = !failedDetailsOpen"
                    >
                      <UIcon
                        :name="failedDetailsOpen ? icons.chevronDown : icons.chevronRight"
                        class="failures-toggle-icon"
                        aria-hidden="true"
                      />
                      <span>{{ failedDetailsOpen ? '收起' : '展开' }}</span>
                    </button>
                  </div>

                  <ul v-if="failedDetailsOpen" class="failures-list">
                    <li v-for="item in latestFailedItems" :key="item.shortId" class="failure-row">
                      <div class="failure-top">
                        <RouterLink
                          :to="entryRoute(item.shortId)"
                          class="text-primary font-mono text-xs"
                          @click="statusPopoverOpen = false"
                        >
                          {{ item.shortId }}
                        </RouterLink>
                        <span class="failure-title">{{ item.title }}</span>
                      </div>
                      <p class="failure-reason">{{ item.reason }}</p>
                    </li>
                  </ul>

                  <UButton
                    v-if="hasChatModel"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    :icon="icons.refresh"
                    :loading="retryFailedBusy"
                    :disabled="modelRunDisabled"
                    block
                    @click="
                      ((statusPopoverOpen = false),
                      triggerDream({
                        mode: latestRunMode,
                        targetShortIds: latestRetryableShortIds,
                      }))
                    "
                  >
                    仅重试失败项（{{ latestRetryableShortIds.length }} 条）
                  </UButton>
                </div>

                <div class="popover-foot">
                  <span>确认后才写入记忆</span>
                  <RouterLink
                    :to="settingsRoute('models')"
                    class="popover-foot-link text-primary"
                    @click="statusPopoverOpen = false"
                  >
                    <UIcon :name="icons.models" class="popover-foot-icon" aria-hidden="true" />
                    <span>前往模型设置</span>
                  </RouterLink>
                </div>
              </div>
            </template>
          </UPopover>
        </div>

        <div class="command-right">
          <div class="split-action">
            <UButton
              v-if="me.data.value && !hasChatModel"
              size="sm"
              :icon="icons.shieldCheck"
              @click="sweepOpen = true"
            >
              结构检查
            </UButton>
            <UButton
              v-else
              size="sm"
              :icon="icons.sparkles"
              :loading="standardBusy"
              :disabled="modelRunDisabled"
              @click="triggerDream({ mode: 'standard' })"
            >
              {{ state?.running ? '整理中' : '增量整理' }}
            </UButton>

            <UDropdownMenu
              :items="organizeMenuItems"
              :content="{ align: 'end', sideOffset: 6 }"
              :ui="{
                content: 'w-80',
                item: 'items-start py-2',
                itemLeadingIcon: 'mt-0.5',
                itemDescription: 'whitespace-normal text-xs text-muted',
              }"
            >
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.sliders"
                :trailing-icon="icons.chevronDown"
                :loading="inboxQuery.isFetching.value && !state?.running"
              >
                更多
              </UButton>
            </UDropdownMenu>
          </div>
        </div>
      </header>

      <div class="inbox-body">
        <ReadFailureNote v-if="inboxQuery.isError.value" :query="inboxQuery" />

        <NoteLine v-if="me.data.value && !hasChatModel" tone="warning">
          尚未配置对话与整理模型，智能整理未启用；仍可执行结构检查。
          <template #actions>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :icon="icons.models"
              :to="settingsRoute('models')"
            >
              前往模型设置
            </UButton>
          </template>
        </NoteLine>

        <!-- 运行中实时进度条 -->
        <div v-if="state?.running" class="run-banner tabular-nums" role="status" aria-live="polite">
          <div class="run-banner-left">
            <UIcon :name="runningModeIcon" class="banner-icon" aria-hidden="true" />
            <span class="run-banner-title">{{ runningStageLabel }}</span>
            <span v-if="progress" class="run-banner-meta">
              已生成 {{ progress.suggested }} 条建议<template v-if="progress.failed > 0"
                >，失败 {{ progress.failed }} 条</template
              >
            </span>
            <span v-else class="run-banner-meta">任务已入队，正在准备候选记忆…</span>
          </div>
          <div class="run-banner-right">
            <template v-if="progress && progress.total > 0">
              <div
                class="run-progress-track"
                role="progressbar"
                aria-label="整理进度"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="progressPercent"
              >
                <div class="run-progress-fill" :style="{ width: `${progressPercent}%` }" />
              </div>
              <span class="run-banner-count">
                {{ progress.processed }} / {{ progress.total }} 条
              </span>
            </template>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.stop"
              :loading="cancellingDream"
              @click="cancelDream"
            >
              取消整理
            </UButton>
          </div>
        </div>

        <!-- 上次存在失败项或报错时的就地重试条 -->
        <div
          v-if="!state?.running && (latestFailedItems.length > 0 || state?.lastError)"
          class="failure-banner"
          :class="{
            'is-partial': state?.lastOutcome === 'partial' || state?.lastOutcome === 'cancelled',
          }"
          role="status"
        >
          <div class="failure-banner-head">
            <div class="failure-banner-msg">
              <UIcon
                :name="
                  state?.lastOutcome === 'partial' || state?.lastOutcome === 'cancelled'
                    ? icons.warning
                    : icons.error
                "
                class="banner-icon"
                aria-hidden="true"
              />
              <span v-if="latestFailedItems.length > 0" class="tabular-nums">
                上次整理有 {{ latestFailedItems.length }} 条记忆处理失败
                <template v-if="state?.lastError">（{{ state.lastError }}）</template>
              </span>
              <span v-else>{{ state?.lastError }}</span>
            </div>
            <div class="failure-banner-actions">
              <UButton
                v-if="latestFailedItems.length > 0"
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="failedDetailsOpen ? icons.chevronDown : icons.chevronRight"
                :aria-expanded="failedDetailsOpen"
                @click="failedDetailsOpen = !failedDetailsOpen"
              >
                {{ failedDetailsOpen ? '收起明细' : '查看明细' }}
              </UButton>
              <UButton
                v-if="hasChatModel && latestRetryableShortIds.length > 0"
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.refresh"
                :loading="retryFailedBusy"
                :disabled="modelRunDisabled"
                @click="
                  triggerDream({
                    mode: latestRunMode,
                    targetShortIds: latestRetryableShortIds,
                  })
                "
              >
                仅重试失败项（{{ latestRetryableShortIds.length }} 条）
              </UButton>
            </div>
          </div>

          <ul v-if="failedDetailsOpen && latestFailedItems.length > 0" class="banner-failure-list">
            <li v-for="item in latestFailedItems" :key="item.shortId" class="banner-failure-item">
              <RouterLink :to="entryRoute(item.shortId)" class="text-primary font-mono text-xs">
                {{ item.shortId }}
              </RouterLink>
              <span class="banner-failure-title">{{ item.title }}</span>
              <span class="banner-failure-reason">{{ item.reason }}</span>
            </li>
          </ul>
        </div>

        <!-- 骨架加载 -->
        <div v-if="inboxQuery.isPending.value" class="space-y-3">
          <USkeleton v-for="n in 4" :key="n" class="h-16 w-full" />
        </div>

        <!-- 主体：非零分类筛选轨 + 速审台账表 -->
        <template v-else-if="items.length > 0">
          <section class="ledger-controls" aria-label="分类筛选与批量操作">
            <div class="filter-tabs" role="tablist" aria-label="按建议性质筛选">
              <button
                v-for="(tab, idx) in filterTabs"
                :key="tab.value"
                type="button"
                role="tab"
                class="filter-tab"
                :aria-selected="kindFilter === tab.value"
                :tabindex="kindFilter === tab.value ? 0 : -1"
                @click="kindFilter = tab.value"
                @keydown="onFilterTabKeydown($event, idx)"
              >
                <UIcon :name="tab.icon" class="tab-icon" aria-hidden="true" />
                <span>{{ tab.label }}</span>
                <span class="tab-count tabular-nums">{{ tab.count }}</span>
              </button>
            </div>

            <div class="batch-zone">
              <template v-if="visibleSelectedItems.length > 0">
                <span class="batch-selected-note tabular-nums">
                  已选 {{ visibleSelectedItems.length }} 条
                </span>
                <UButton
                  size="xs"
                  :icon="icons.listChecks"
                  :loading="batchBusy"
                  :disabled="safeSelectedItems.length === 0 || busyId !== null || batchDismissBusy"
                  @click="batchApplySafe"
                >
                  批量应用安全项（{{ safeSelectedItems.length }} 条）
                </UButton>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.cancel"
                  :loading="batchDismissBusy"
                  :disabled="batchBusy || busyId !== null"
                  @click="batchDismissSelected"
                >
                  批量忽略
                </UButton>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.undelete"
                  :disabled="batchBusy || batchDismissBusy"
                  @click="clearSelection"
                >
                  取消选择
                </UButton>
                <span v-if="hasUnsafeSelected" class="quiet-hint">
                  <UIcon :name="icons.shieldAlert" class="quiet-hint-icon" aria-hidden="true" />
                  <span>高风险项须展开核对</span>
                </span>
              </template>
              <UButton
                v-else-if="filteredItems.length > 0"
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="anyVisibleExpanded ? icons.foldVertical : icons.unfoldVertical"
                @click="toggleAllExpanded"
              >
                {{ anyVisibleExpanded ? '全部收起' : '全部展开' }}
              </UButton>
            </div>
          </section>

          <section class="ledger-wrap" aria-label="待处理审校台账">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th scope="col" class="col-target">
                    <label class="th-object">
                      <input
                        type="checkbox"
                        class="ledger-check"
                        aria-label="全选当前筛选结果"
                        :checked="allVisibleSelected"
                        :indeterminate.prop="someVisibleSelected"
                        :disabled="batchBusy || batchDismissBusy || filteredItems.length === 0"
                        @change="toggleSelectAll"
                      />
                      <span>对象</span>
                    </label>
                  </th>
                  <th scope="col" class="col-delta">具体改动</th>
                  <th scope="col" class="col-meta">性质与时间</th>
                  <th scope="col" class="col-actions">快速决断</th>
                </tr>
              </thead>

              <tbody>
                <template v-for="s in filteredItems" :key="s.id">
                  <tr
                    class="ledger-row"
                    :class="[
                      `row-kind-${s.kind}`,
                      {
                        'is-expanded': isExpanded(s.id),
                        'is-selected': selectedIds.includes(s.id),
                      },
                    ]"
                  >
                    <!-- 列 1：对象 -->
                    <td class="cell-target" @click="toggleExpand(s.id)">
                      <div class="target-wrap">
                        <input
                          type="checkbox"
                          class="ledger-check"
                          :aria-label="`选择 ${targetTitleOf(s)}`"
                          :checked="selectedIds.includes(s.id)"
                          :disabled="batchBusy || batchDismissBusy"
                          @click.stop
                          @change="toggleSelectRow(s.id)"
                        />
                        <div class="target-info">
                          <span class="target-title">{{ targetTitleOf(s) }}</span>
                          <span class="target-sub">
                            <span v-if="baseEntryOf(s)" class="short-id font-mono">
                              {{ baseEntryOf(s)!.shortId }}
                            </span>
                            <span v-if="baseEntryOf(s)?.isPinned" class="tiny-cue">
                              <UIcon
                                :name="
                                  effectiveBootMode(baseEntryOf(s)!) === 'index'
                                    ? icons.bookmark
                                    : icons.pin
                                "
                                class="tiny-cue-icon"
                                aria-hidden="true"
                              />
                              <span>常驻</span>
                            </span>
                            <span
                              v-if="s.kind === 'merge_duplicates' && s.entries.length > 1"
                              class="tiny-cue tabular-nums"
                            >
                              <UIcon
                                :name="icons.layers"
                                class="tiny-cue-icon"
                                aria-hidden="true"
                              />
                              <span>等 {{ s.entries.length }} 条</span>
                            </span>
                          </span>
                        </div>
                      </div>
                    </td>

                    <!-- 列 2：具体改动 -->
                    <td class="cell-delta" @click="toggleExpand(s.id)">
                      <!-- 调整启动加载 -->
                      <template
                        v-if="s.kind === 'adjust_boot_mode' && baseEntryOf(s) && s.proposedBootMode"
                      >
                        <div class="delta-primary">
                          <span class="delta-pill delta-pill-old">
                            <UIcon
                              :name="bootModeIcons[effectiveBootMode(baseEntryOf(s)!)]"
                              class="delta-pill-icon"
                              aria-hidden="true"
                            />
                            <span>{{ bootModeLabels[effectiveBootMode(baseEntryOf(s)!)] }}</span>
                          </span>
                          <UIcon
                            :name="icons.arrowRight"
                            class="delta-arrow-icon"
                            aria-hidden="true"
                          />
                          <span class="delta-pill delta-pill-ochre">
                            <UIcon
                              :name="bootModeIcons[s.proposedBootMode]"
                              class="delta-pill-icon"
                              aria-hidden="true"
                            />
                            <span>{{ bootModeLabels[s.proposedBootMode] }}</span>
                          </span>
                          <span v-if="hasSummaryDiff(s)" class="delta-pill">
                            <UIcon
                              :name="icons.summary"
                              class="delta-pill-icon"
                              aria-hidden="true"
                            />
                            <span>+ 补概要</span>
                          </span>
                        </div>
                        <div class="delta-sub tabular-nums">
                          <template
                            v-if="
                              effectiveBootMode(baseEntryOf(s)!) === 'full' &&
                              s.proposedBootMode === 'index'
                            "
                          >
                            原全文
                            {{ baseEntryOf(s)!.content.length.toLocaleString() }}
                            字，启动改为目录索引
                          </template>
                          <template v-else>调整会话启动加载方式，保留正文与检索</template>
                        </div>
                      </template>

                      <!-- 补全双链 -->
                      <template v-else-if="s.kind === 'link_entries'">
                        <div class="delta-primary">
                          <span class="delta-pill delta-pill-lake tabular-nums">
                            <UIcon :name="icons.links" class="delta-pill-icon" aria-hidden="true" />
                            <span>+{{ s.proposedLinks?.length ?? 0 }} 双链</span>
                          </span>
                          <template v-if="s.proposedLinks?.length">
                            <UIcon
                              :name="icons.arrowRight"
                              class="delta-arrow-icon"
                              aria-hidden="true"
                            />
                            <span class="delta-target-name">
                              {{
                                s.proposedLinks[0]!.targetTitle ||
                                s.proposedLinks[0]!.targetShortId
                              }}<template v-if="s.proposedLinks.length > 1">
                                等 {{ s.proposedLinks.length }} 条</template
                              >
                            </span>
                          </template>
                        </div>
                        <div class="delta-sub">
                          <template v-if="firstLinkAnchor(s)">
                            写入小节「{{ firstLinkAnchor(s) }}」，不改写其余正文
                          </template>
                          <template v-else>追加至相关记忆，不改写其余正文</template>
                        </div>
                      </template>

                      <!-- 合并重复记忆 -->
                      <template v-else-if="s.kind === 'merge_duplicates'">
                        <div class="delta-primary">
                          <span class="delta-pill delta-pill-new tabular-nums">
                            <UIcon :name="icons.merge" class="delta-pill-icon" aria-hidden="true" />
                            <span>合并 {{ s.entries.length }} 条</span>
                          </span>
                          <UIcon
                            :name="icons.arrowRight"
                            class="delta-arrow-icon"
                            aria-hidden="true"
                          />
                          <span class="delta-target-name">
                            {{ s.proposedTitle?.trim() || baseEntryOf(s)?.title }}
                          </span>
                        </div>
                        <div
                          class="delta-sub tabular-nums"
                          :class="{ 'delta-sub-warn': (s.affectedBacklinkCount ?? 0) > 0 }"
                        >
                          <template v-if="(s.affectedBacklinkCount ?? 0) > 0">
                            <UIcon
                              :name="icons.arrowLeftRight"
                              class="delta-sub-icon"
                              aria-hidden="true"
                            />
                            <span>
                              自动重定向 {{ s.affectedBacklinkCount }} 条反链，其余重复项移入回收站
                            </span>
                          </template>
                          <template v-else>保留主词条，其余重复项移入回收站</template>
                        </div>
                      </template>

                      <!-- 提炼会话摘要 -->
                      <template v-else-if="s.kind === 'distill_episode'">
                        <div class="delta-primary">
                          <span class="delta-pill delta-pill-moss">
                            <UIcon
                              :name="icons.promote"
                              class="delta-pill-icon"
                              aria-hidden="true"
                            />
                            <span>提炼为正式记忆</span>
                          </span>
                          <template v-if="s.proposedTitle?.trim()">
                            <UIcon
                              :name="icons.arrowRight"
                              class="delta-arrow-icon"
                              aria-hidden="true"
                            />
                            <span class="delta-target-name">{{ s.proposedTitle }}</span>
                          </template>
                        </div>
                        <div class="delta-sub tabular-nums">
                          提炼自 {{ s.entries.length }} 条会话摘要
                          <template v-if="s.proposedContent">
                            · 约 {{ s.proposedContent.length.toLocaleString() }} 字
                          </template>
                        </div>
                      </template>

                      <!-- 标记过时记忆 -->
                      <template v-else-if="s.kind === 'mark_stale'">
                        <div class="delta-primary">
                          <span class="delta-pill delta-pill-brick">
                            <UIcon
                              :name="icons.remove"
                              class="delta-pill-icon"
                              aria-hidden="true"
                            />
                            <span>移入回收站</span>
                          </span>
                        </div>
                        <div class="delta-sub line-clamp-1">{{ s.reason }}</div>
                      </template>

                      <!-- 规范与精简 / 更新记忆内容 -->
                      <template v-else>
                        <div class="delta-primary">
                          <span class="delta-pill delta-pill-moss tabular-nums">
                            <UIcon
                              :name="s.kind === 'tidy' ? icons.tidy : icons.updateDoc"
                              class="delta-pill-icon"
                              aria-hidden="true"
                            />
                            <span>{{ tidyDeltaPrimaryPill(s) }}</span>
                          </span>
                          <template v-if="hasTitleDiff(s) && s.proposedTitle?.trim()">
                            <UIcon
                              :name="icons.arrowRight"
                              class="delta-arrow-icon"
                              aria-hidden="true"
                            />
                            <span class="delta-target-name">{{ s.proposedTitle }}</span>
                          </template>
                        </div>
                        <div
                          v-if="tidyDeltaSubText(s)"
                          class="delta-sub tabular-nums"
                          :class="{ 'delta-sub-warn': tidyDeltaSubText(s)!.warn }"
                        >
                          <UIcon
                            v-if="tidyDeltaSubText(s)!.icon"
                            :name="tidyDeltaSubText(s)!.icon!"
                            class="delta-sub-icon"
                            aria-hidden="true"
                          />
                          <span>{{ tidyDeltaSubText(s)!.text }}</span>
                        </div>
                      </template>
                    </td>

                    <!-- 列 3：性质与时间 -->
                    <td class="cell-meta" @click="toggleExpand(s.id)">
                      <div class="kind-line">
                        <UIcon
                          :name="dreamKindIcons[s.kind]"
                          class="kind-icon"
                          aria-hidden="true"
                        />
                        <span>{{ dreamKindLabels[s.kind] }}</span>
                      </div>
                      <div class="time-line">
                        <time :datetime="s.createdAt" :title="formatTime(s.createdAt)">
                          {{ formatRelative(s.createdAt) }}
                        </time>
                      </div>
                    </td>

                    <!-- 列 4：快速决断 -->
                    <td class="cell-actions">
                      <div class="row-actions">
                        <template v-if="isHighRisk(s)">
                          <UButton
                            size="xs"
                            color="neutral"
                            variant="outline"
                            :icon="isExpanded(s.id) ? icons.foldVertical : icons.compare"
                            :aria-expanded="isExpanded(s.id)"
                            @click.stop="toggleExpand(s.id)"
                          >
                            {{ isExpanded(s.id) ? '收起' : '展开核对' }}
                          </UButton>
                          <UButton
                            size="xs"
                            color="neutral"
                            variant="ghost"
                            :icon="icons.cancel"
                            :disabled="batchBusy || batchDismissBusy || busyId !== null"
                            @click.stop="onDismiss(s.id)"
                          >
                            忽略
                          </UButton>
                        </template>

                        <template v-else>
                          <UButton
                            size="xs"
                            color="primary"
                            variant="outline"
                            :icon="icons.check"
                            :loading="busyId === s.id"
                            :disabled="
                              batchBusy || batchDismissBusy || (busyId !== null && busyId !== s.id)
                            "
                            @click.stop="onQuickApply(s)"
                          >
                            应用
                          </UButton>
                          <UButton
                            size="xs"
                            color="neutral"
                            variant="ghost"
                            :icon="icons.cancel"
                            :disabled="batchBusy || batchDismissBusy || busyId !== null"
                            @click.stop="onDismiss(s.id)"
                          >
                            忽略
                          </UButton>
                          <button
                            type="button"
                            class="btn-expand"
                            :aria-expanded="isExpanded(s.id)"
                            @click.stop="toggleExpand(s.id)"
                          >
                            <span>{{ isExpanded(s.id) ? '收起' : '详情' }}</span>
                            <UIcon
                              :name="icons.chevronDown"
                              class="expand-chevron"
                              aria-hidden="true"
                            />
                          </button>
                        </template>
                      </div>
                    </td>
                  </tr>

                  <!-- 行内 65/35 展开审校面板 -->
                  <tr v-if="isExpanded(s.id)" class="inspector-row" :class="`row-kind-${s.kind}`">
                    <td colspan="4">
                      <DreamSuggestionCard
                        :suggestion="s"
                        layout="inspector"
                        :busy="busyId === s.id"
                        :disabled="
                          batchBusy || batchDismissBusy || (busyId !== null && busyId !== s.id)
                        "
                        @apply="onApply"
                        @dismiss="onDismiss"
                      />
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>

            <footer class="ledger-footnote">
              <UIcon :name="icons.history" class="footnote-icon" aria-hidden="true" />
              <span>所有应用均记入版本历史，支持 8 秒内撤销。</span>
            </footer>
          </section>
        </template>

        <!-- 空态 -->
        <div v-else-if="!inboxQuery.isError.value" class="empty-frame">
          <EmptyState
            :icon="icons.checkCircle"
            tone="success"
            title="暂无待处理建议"
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
                查重/关联
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
            </template>
          </EmptyState>
        </div>
      </div>
    </div>

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
.inbox-page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.inbox-shell {
  width: 100%;
  max-width: 1200px;
  margin-inline: auto;
  padding: 20px 32px 56px;
}

/* ---- 顶部单行指挥条 ---- */
.command-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--ui-rule);
}
.command-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  min-width: 0;
}
.page-title {
  font-size: 24px;
  font-weight: 500;
  line-height: 1.3;
  letter-spacing: -0.005em;
  color: var(--ui-text-highlighted);
}
.status-summary-btn {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 9px;
  padding: 4px 10px;
  border: 1px solid var(--ui-border-accented);
  background: transparent;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.status-summary-btn:hover,
.status-summary-btn[aria-expanded='true'] {
  border-color: var(--ui-rule);
  background: var(--ui-bg-bright);
  color: var(--ui-text-highlighted);
}
.status-count-hot {
  font-weight: 600;
  color: var(--ui-error);
}
.status-count-clear {
  font-weight: 600;
  color: var(--ui-success);
}
.status-running {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.status-chunk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.status-inline-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.hair-sep {
  display: inline-block;
  flex: none;
  width: 1px;
  height: 11px;
  background: var(--ui-border-accented);
}
.status-caret {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}

.command-right {
  display: flex;
  align-items: center;
  flex: none;
}
.split-action {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* 状态 Popover 详情 */
.status-popover {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 14px 16px;
  background: var(--ui-bg-bright);
}
.popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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
.popover-head-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.popover-schedules {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 12px;
}
.popover-sched-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.popover-sched-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-toned);
}
.popover-sched-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.popover-sched-val {
  color: var(--ui-text-muted);
}
.popover-sched-val.is-enabled {
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.popover-state {
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.popover-state.is-active {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.kv-list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  font-size: 13px;
}
.kv-list dt {
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.kv-list dd {
  text-align: right;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.popover-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--ui-error);
  background: var(--ui-bg);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-error);
  overflow-wrap: anywhere;
}
.popover-error-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}
.popover-error.is-partial {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.popover-failures {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
}
.failures-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.failures-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  cursor: pointer;
}
.failures-toggle-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.failures-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.failure-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-border);
}
.failure-row:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}
.failure-top {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.failure-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--ui-text-highlighted);
}
.failure-reason {
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.popover-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.popover-foot-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.popover-foot-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}

/* ---- 主区与进度/失败横幅 ---- */
.inbox-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 14px;
}

.run-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  padding: 9px 14px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-bright);
  font-size: 13px;
}
.run-banner-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.run-banner-title {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.run-banner-meta {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.run-banner-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.run-progress-track {
  width: 160px;
  height: 6px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg);
}
.run-progress-fill {
  height: 100%;
  background: var(--ui-rule);
  transition: width 180ms ease;
}
.run-banner-count {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.banner-icon {
  display: inline-block;
  flex: none;
  width: 15px;
  height: 15px;
}

.failure-banner {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 14px;
  border: 1px solid var(--ui-error);
  background: color-mix(in srgb, var(--ui-error) 5%, var(--ui-bg));
  font-size: 13px;
}
.failure-banner.is-partial {
  border-color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 6%, var(--ui-bg));
}
.failure-banner-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 14px;
}
.failure-banner-msg {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ui-error);
  min-width: 0;
}
.failure-banner.is-partial .failure-banner-msg {
  color: var(--ui-warning);
}
.failure-banner-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.banner-failure-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
  font-size: 12px;
}
.banner-failure-item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
}
.banner-failure-title {
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.banner-failure-reason {
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}

/* ---- 非零分类筛选轨 + 批量条 ---- */
.ledger-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  border-bottom: 1px solid var(--ui-border-accented);
  min-height: 42px;
}
.filter-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 2px;
  margin-bottom: -1px;
}
.filter-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 8px;
  border-bottom: 2px solid transparent;
  font-size: 13px;
  color: var(--ui-text-muted);
  white-space: nowrap;
  cursor: pointer;
}
.filter-tab:hover {
  color: var(--ui-text-highlighted);
}
.filter-tab[aria-selected='true'] {
  border-bottom-color: var(--ui-rule);
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.tab-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.tab-count {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.filter-tab[aria-selected='true'] .tab-count {
  color: var(--ui-text-highlighted);
}
.batch-zone {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
}
.batch-selected-note {
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.quiet-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.quiet-hint-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}

/* ---- 四列纸墨速审台账表 ---- */
.ledger-wrap {
  width: 100%;
}
.ledger-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.ledger-table thead th {
  padding: 9px 12px;
  border-bottom: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
  text-align: left;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
  vertical-align: middle;
  white-space: nowrap;
}
.ledger-table thead th.col-actions {
  text-align: right;
}
.col-target {
  width: 27%;
}
.col-delta {
  width: 38%;
}
.col-meta {
  width: 14%;
}
.col-actions {
  width: 21%;
}

.th-object {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}
.ledger-check {
  flex: none;
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--ui-primary);
  cursor: pointer;
}

.ledger-row {
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
  transition: background-color 110ms ease;
}
.ledger-row:hover {
  background: var(--ui-bg-elevated);
}
.ledger-row.is-selected {
  background: var(--ui-bg-muted);
}
.ledger-row.is-expanded {
  background: var(--ui-bg-bright);
}
.ledger-row td {
  padding: 12px;
  vertical-align: middle;
}
.ledger-row td:first-child {
  position: relative;
  padding-left: 14px;
}
.ledger-row td:first-child::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: transparent;
}
.ledger-row.is-expanded td:first-child::before,
.ledger-row:hover td:first-child::before {
  background: var(--row-accent, var(--ui-text-muted));
}
.ledger-row.is-expanded td:first-child::before {
  bottom: -1px;
  z-index: 1;
}

/* 语义色点与左缘坐标线 */
.row-kind-merge_duplicates {
  --row-accent: var(--ui-rule);
}
.row-kind-link_entries {
  --row-accent: var(--ui-info);
}
.row-kind-adjust_boot_mode {
  --row-accent: var(--ui-warning);
}
.row-kind-mark_stale {
  --row-accent: var(--ui-error);
}
.row-kind-tidy,
.row-kind-update,
.row-kind-distill_episode {
  --row-accent: var(--ui-text-muted);
}

.cell-target,
.cell-delta,
.cell-meta {
  cursor: pointer;
}

/* 列 1：对象 */
.target-wrap {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}
.target-wrap .ledger-check {
  margin-top: 3px;
}
.target-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.target-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.target-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.short-id {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.tiny-cue {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 4px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.35;
  color: var(--ui-text-muted);
}
.tiny-cue-icon {
  display: inline-block;
  flex: none;
  width: 11px;
  height: 11px;
}

/* 列 2：具体改动 */
.delta-primary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px 7px;
  font-size: 14px;
  line-height: 1.45;
  color: var(--ui-text-highlighted);
}
.delta-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
}
.delta-pill-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.delta-pill-old {
  border-style: dashed;
  background: transparent;
  color: var(--ui-text-muted);
}
.delta-pill-new {
  border-color: var(--ui-rule);
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.delta-pill-lake {
  border-color: var(--ui-info);
  background: color-mix(in srgb, var(--ui-info) 8%, var(--ui-bg-bright));
  font-weight: 600;
  color: var(--ui-info);
}
.delta-pill-moss {
  border-color: var(--ui-success);
  background: color-mix(in srgb, var(--ui-success) 8%, var(--ui-bg-bright));
  font-weight: 600;
  color: var(--ui-success);
}
.delta-pill-ochre {
  border-color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 8%, var(--ui-bg-bright));
  font-weight: 600;
  color: var(--ui-warning);
}
.delta-pill-brick {
  border-color: var(--ui-error);
  background: color-mix(in srgb, var(--ui-error) 8%, var(--ui-bg-bright));
  font-weight: 600;
  color: var(--ui-error);
}
.delta-arrow-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.delta-target-name {
  font-weight: 600;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.delta-sub {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.delta-sub-warn {
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
  font-weight: 500;
  color: var(--ui-warning);
}
.delta-sub-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  margin-top: 2px;
}

/* 列 3：性质与时间 */
.kind-line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-toned);
  white-space: nowrap;
}
.kind-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--row-accent, var(--ui-text-muted));
}
.time-line {
  margin-top: 2px;
  font-size: 12px;
  color: var(--ui-text-muted);
}

/* 列 4：快速决断 */
.cell-actions {
  text-align: right;
}
.row-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
.btn-expand {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 26px;
  padding: 0 7px;
  border: 1px solid transparent;
  font-size: 12px;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.btn-expand:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.ledger-row.is-expanded .btn-expand {
  border-color: var(--ui-border-accented);
  background: var(--ui-bg-muted);
  color: var(--ui-text-highlighted);
}
.expand-chevron {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  transition: transform 150ms ease;
}
.ledger-row.is-expanded .expand-chevron {
  transform: rotate(180deg);
}

/* 行内展开审校面板外框：与主行同样以 3px ::before 贴齐内缘，避免 border-collapse 居中错位 */
.inspector-row {
  border-bottom: 1px solid var(--ui-rule);
}
.inspector-row > td {
  position: relative;
  padding: 0 0 0 3px;
}
.inspector-row > td::before {
  content: '';
  position: absolute;
  left: 0;
  top: -1px;
  bottom: 0;
  width: 3px;
  background: var(--row-accent, var(--ui-rule));
  pointer-events: none;
  z-index: 1;
}

.ledger-footnote {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.footnote-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}

.empty-frame {
  padding: 16px;
  border: 1px dashed var(--ui-border-accented);
  background: var(--ui-bg-bright);
}

/* ---- 窄屏退化为紧凑纸墨卡片（390px 零横向溢出） ---- */
@media (max-width: 960px) {
  .inbox-shell {
    padding: 16px 16px 40px;
  }
}

@media (max-width: 820px) {
  .command-bar {
    flex-direction: column;
    align-items: stretch;
  }
  .command-right {
    justify-content: flex-start;
  }
  .run-banner {
    flex-direction: column;
    align-items: stretch;
  }
  .run-progress-track {
    flex: 1;
    width: auto;
  }

  .ledger-table,
  .ledger-table tbody,
  .ledger-table tr,
  .ledger-table td {
    display: block;
    width: 100%;
  }
  .ledger-table thead {
    display: none;
  }
  .ledger-row {
    position: relative;
    padding: 12px 12px 12px 14px;
    border-bottom: 1px solid var(--ui-border-accented);
  }
  .ledger-row td {
    padding: 0;
  }
  .ledger-row td:first-child {
    position: static;
    padding-left: 0;
  }
  .ledger-row .cell-delta {
    margin-top: 8px;
    padding-left: 25px;
  }
  .ledger-row .cell-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
    padding-left: 25px;
  }
  .ledger-row .cell-meta .time-line {
    margin-top: 0;
  }
  .ledger-row .cell-actions {
    margin-top: 10px;
    padding-top: 8px;
    padding-left: 25px;
    border-top: 1px solid var(--ui-border-muted);
    text-align: left;
  }
  .row-actions {
    width: 100%;
    justify-content: flex-start;
  }
  .row-actions .btn-expand {
    margin-left: auto;
  }
  .inspector-row > td {
    padding: 0 0 0 3px;
  }
}
</style>
