<script setup lang="ts">
import type {
  DreamOutcome,
  DreamRunSummary,
  DreamState,
  EmbeddingBackfillState,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { dreamModeLabels, dreamOutcomeLabels } from '../labels'
import { entryRoute, settingsRoute } from '../routes'
import {
  collectNewDreamRuns,
  computeOverallProgress,
  filterVisibleHistory,
  formatDreamTaskScope,
  isActiveTaskIssue,
  isAfterWatermark,
  latestFailedTimestamp,
  latestInboxFailureTimestamp,
  mergeTaskHistory,
  parseDismissedIssueKeys,
  serializeDismissedIssueKeys,
  splitTaskHistory,
  type TaskHistoryItem,
} from '../taskCenter'
import { formatRelative, formatTime } from '../time'
import {
  readStoredString,
  subscribeStoredString,
  UI_STORAGE_KEYS,
  writeStoredString,
} from '../uiState'

const RING_SIZE = 20
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const PARTIAL_FAILED_COLLAPSE_THRESHOLD = 5
const PARTIAL_FAILED_PREVIEW_COUNT = 3

const props = defineProps<{
  dreamState: DreamState | null
  embeddingBackfill: EmbeddingBackfillState | null
}>()

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()

const open = ref(false)
const historyExpanded = ref(false)
const expandedFailedKeys = ref<Record<string, boolean>>({})
const cancellingDream = ref(false)
const cancellingBackfill = ref(false)
const startingBackfill = ref(false)
const removingQueueId = ref<string | null>(null)
const clearingQueue = ref(false)
const retryingKey = ref<string | null>(null)

const clearedBefore = ref<string | null>(readStoredString(UI_STORAGE_KEYS.tasksClearedBefore))
const ackErrorAt = ref<string | null>(readStoredString(UI_STORAGE_KEYS.tasksAckErrorAt))
const dismissedIssueKeys = ref<Set<string>>(
  parseDismissedIssueKeys(readStoredString(UI_STORAGE_KEYS.tasksDismissedIssueIds)),
)

const stopClearedSync = subscribeStoredString(UI_STORAGE_KEYS.tasksClearedBefore, (value) => {
  clearedBefore.value = value
})
const stopAckSync = subscribeStoredString(UI_STORAGE_KEYS.tasksAckErrorAt, (value) => {
  ackErrorAt.value = value
})
const stopDismissedSync = subscribeStoredString(UI_STORAGE_KEYS.tasksDismissedIssueIds, (value) => {
  dismissedIssueKeys.value = parseDismissedIssueKeys(value)
})
onBeforeUnmount(() => {
  stopClearedSync()
  stopAckSync()
  stopDismissedSync()
})

// 仅在抽屉打开时按需读取模型与向量覆盖率，复用于模型设置页缓存
const modelsSettingsQuery = useQuery({
  queryKey: ['models-settings'] as const,
  queryFn: () => api.modelsSettings(),
  enabled: open,
  staleTime: 30_000,
})

const embeddingCoverage = computed(() => modelsSettingsQuery.data.value?.embeddingCoverage ?? null)
const missingEmbeddings = computed(() => {
  const c = embeddingCoverage.value
  if (!c || !c.model) return 0
  return Math.max(0, c.total - c.embedded)
})

const dreamRunning = computed(() => Boolean(props.dreamState?.running))
const dreamProgress = computed(() => props.dreamState?.progress ?? null)
const activeDreamTask = computed(() => props.dreamState?.activeTask ?? null)
const queuedDreamTasks = computed(() => props.dreamState?.queued ?? [])
const queuedCount = computed(() => queuedDreamTasks.value.length)
const backfillRunning = computed(() => Boolean(props.embeddingBackfill?.running))
const activeCount = computed(() => (dreamRunning.value ? 1 : 0) + (backfillRunning.value ? 1 : 0))
const hasBusyTasks = computed(() => activeCount.value > 0 || queuedCount.value > 0)
const ringCount = computed(() => (activeCount.value > 0 ? activeCount.value : queuedCount.value))

const allHistory = computed(() => mergeTaskHistory(props.dreamState, props.embeddingBackfill))
const visibleHistory = computed(() => filterVisibleHistory(allHistory.value, clearedBefore.value))
const splitHistory = computed(() =>
  splitTaskHistory(visibleHistory.value, dismissedIssueKeys.value),
)
const pinnedIssues = computed(() => splitHistory.value.issues)
const archivedHistory = computed(() => splitHistory.value.recent)

const unreadIssues = computed(() =>
  allHistory.value.filter(
    (item) =>
      isActiveTaskIssue(item, dismissedIssueKeys.value) &&
      isAfterWatermark(item.finishedAt, clearedBefore.value) &&
      isAfterWatermark(item.finishedAt, ackErrorAt.value),
  ),
)
const unreadFailedCount = computed(() => unreadIssues.value.length)
const unreadOnlyPartial = computed(
  () =>
    unreadIssues.value.length > 0 && unreadIssues.value.every((item) => item.outcome === 'partial'),
)
const unreadBadgeText = computed(() =>
  unreadFailedCount.value > 9 ? '9+' : String(unreadFailedCount.value),
)

const overallProgress = computed(() =>
  computeOverallProgress(props.dreamState, props.embeddingBackfill),
)
const ringDashArray = computed(() => {
  if (overallProgress.value === null) {
    return `${(RING_CIRCUMFERENCE * 0.28).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`
  }
  const len = (overallProgress.value / 100) * RING_CIRCUMFERENCE
  return `${len.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`
})

const activeDreamMode = computed(
  () => dreamProgress.value?.mode ?? activeDreamTask.value?.mode ?? 'standard',
)
const dreamModeLabel = computed(() => dreamModeLabels[activeDreamMode.value])
const activeDreamTriggerLabel = computed(() =>
  activeDreamTask.value?.trigger === 'scheduled' ? '定时触发' : '手动发起',
)
const dreamStageText = computed(() => {
  if (dreamProgress.value?.stage) return `${dreamProgress.value.stage}中`
  if (dreamProgress.value && dreamProgress.value.total > 0) return `${dreamModeLabel.value}中`
  return '准备中…'
})
const dreamPercent = computed(() => {
  const p = dreamProgress.value
  if (!p || p.total <= 0) return null
  return Math.min(100, Math.round((p.processed / p.total) * 100))
})

const dreamQueueSummaryText = computed(() => {
  if (dreamRunning.value && queuedCount.value > 0) {
    return `1 项进行中 · ${queuedCount.value} 项等待`
  }
  if (dreamRunning.value) return '1 项进行中'
  if (queuedCount.value > 0) return `${queuedCount.value} 项等待`
  return '空闲'
})

const backfillPercent = computed(() => {
  const b = props.embeddingBackfill
  if (!b || b.total <= 0) return null
  return Math.min(100, Math.round((b.processed / b.total) * 100))
})

const triggerTooltip = computed(() => {
  const parts: string[] = []
  if (activeCount.value > 0) {
    parts.push(
      overallProgress.value !== null
        ? `${activeCount.value} 项进行中（${overallProgress.value}%）`
        : `${activeCount.value} 项进行中`,
    )
  }
  if (queuedCount.value > 0) {
    parts.push(`${queuedCount.value} 项等待`)
  }
  if (unreadFailedCount.value > 0) {
    parts.push(
      unreadOnlyPartial.value && unreadFailedCount.value === 1
        ? '最近一次整理部分失败'
        : `有 ${unreadFailedCount.value} 条异常未查看`,
    )
  }
  if (parts.length === 0) return '后台任务：空闲'
  return `后台任务：${parts.join(' · ')}`
})

function advanceWatermark(target: typeof ackErrorAt, storageKey: string, candidate: string | null) {
  if (!candidate) return
  if (target.value && !isAfterWatermark(candidate, target.value)) return
  target.value = candidate
  writeStoredString(storageKey, candidate)
}

function acknowledgeErrors() {
  const latestFail = latestFailedTimestamp(visibleHistory.value, dismissedIssueKeys.value)
  advanceWatermark(ackErrorAt, UI_STORAGE_KEYS.tasksAckErrorAt, latestFail)
}

watch(open, (visible) => {
  if (visible) {
    acknowledgeErrors()
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    void queryClient.invalidateQueries({ queryKey: ['models-settings'] })
  }
})

watch(visibleHistory, () => {
  if (open.value) acknowledgeErrors()
})

function persistDismissedKey(key: string) {
  if (dismissedIssueKeys.value.has(key)) return
  const next = new Set(dismissedIssueKeys.value)
  next.add(key)
  dismissedIssueKeys.value = next
  writeStoredString(UI_STORAGE_KEYS.tasksDismissedIssueIds, serializeDismissedIssueKeys(next))
}

function dismissIssue(item: TaskHistoryItem) {
  persistDismissedKey(item.key)
  if (item.source === 'dream' && item.id === props.dreamState?.recentRuns[0]?.id) {
    const prevDismissed = readStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt)
    if (!prevDismissed || isAfterWatermark(item.finishedAt, prevDismissed)) {
      writeStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt, item.finishedAt)
    }
  }
}

function visibleFailedItems(item: TaskHistoryItem) {
  const list = item.failedItems ?? []
  if (list.length <= PARTIAL_FAILED_COLLAPSE_THRESHOLD || expandedFailedKeys.value[item.key]) {
    return list
  }
  return list.slice(0, PARTIAL_FAILED_PREVIEW_COUNT)
}

function hiddenFailedCount(item: TaskHistoryItem): number {
  const total = item.failedItems?.length ?? 0
  if (total <= PARTIAL_FAILED_COLLAPSE_THRESHOLD || expandedFailedKeys.value[item.key]) return 0
  return total - PARTIAL_FAILED_PREVIEW_COUNT
}

function toggleFailedItemsExpand(key: string) {
  expandedFailedKeys.value = {
    ...expandedFailedKeys.value,
    [key]: !expandedFailedKeys.value[key],
  }
}

function clearHistory() {
  const newest = archivedHistory.value[0]?.finishedAt ?? visibleHistory.value[0]?.finishedAt ?? null
  if (!newest) return
  advanceWatermark(clearedBefore, UI_STORAGE_KEYS.tasksClearedBefore, newest)
  advanceWatermark(ackErrorAt, UI_STORAGE_KEYS.tasksAckErrorAt, newest)
  if (pinnedIssues.value.length === 0) {
    const latestFailure = latestInboxFailureTimestamp(props.dreamState)
    const dismissTarget =
      latestFailure && isAfterWatermark(latestFailure, newest) ? latestFailure : newest
    const prevDismissed = readStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt)
    if (!prevDismissed || isAfterWatermark(dismissTarget, prevDismissed)) {
      writeStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt, dismissTarget)
    }
  }
}

function outcomeTone(outcome: DreamOutcome): string {
  if (outcome === 'ok') return 'is-ok'
  if (outcome === 'failed') return 'is-error'
  if (outcome === 'partial') return 'is-warning'
  return 'is-muted'
}

function outcomeTagText(item: TaskHistoryItem): string {
  if (item.outcome === 'skipped') return '无变更'
  if (item.outcome === 'partial') return '部分失败'
  return dreamOutcomeLabels[item.outcome]
}

function retryButtonLabel(item: TaskHistoryItem): string {
  if (item.source === 'dream' && item.outcome === 'partial' && item.failedItems?.length) {
    return `重试失败项 (${item.failedItems.length})`
  }
  return '立即重试'
}

function notifyDreamRunCompletion(run: DreamRunSummary) {
  const modeLabel = run.mode ? dreamModeLabels[run.mode] : '记忆整理'
  const onOrganize = route.name === 'organize'
  const organizeAction = !onOrganize
    ? [
        {
          label: '前往整理',
          icon: icons.listChecks,
          color: 'neutral' as const,
          variant: 'outline' as const,
          onClick: () => void router.push({ name: 'organize' }),
        },
      ]
    : undefined

  if (run.outcome === 'cancelled') {
    toast.add({
      title:
        run.suggested > 0
          ? `${modeLabel}已取消，已保留 ${run.suggested} 条待确认建议`
          : `${modeLabel}已取消`,
      ...(run.abortedReason && run.abortedReason !== '已手动取消'
        ? { description: run.abortedReason }
        : {}),
      color: 'neutral',
      orientation: 'horizontal',
      ...(run.suggested > 0 && organizeAction ? { actions: organizeAction } : {}),
    })
  } else if (run.outcome === 'failed') {
    toast.add({
      title: run.error ? `${modeLabel}失败：${run.error}` : `${modeLabel}失败`,
      color: 'error',
      orientation: 'horizontal',
      ...(organizeAction ? { actions: organizeAction } : {}),
    })
  } else if (run.outcome === 'partial') {
    const errReason = run.error?.trim() || run.failedItems?.[0]?.reason?.trim()
    toast.add({
      title:
        run.suggested > 0
          ? `${modeLabel}部分完成，生成 ${run.suggested} 条待确认建议`
          : `${modeLabel}部分失败`,
      ...(errReason ? { description: errReason } : {}),
      color: 'warning',
      orientation: 'horizontal',
      ...(organizeAction ? { actions: organizeAction } : {}),
    })
  } else if (run.outcome === 'skipped') {
    toast.add({
      title: `${modeLabel}完成，当前无可整理项`,
      color: 'neutral',
      orientation: 'horizontal',
    })
  } else {
    toast.add({
      title:
        run.suggested > 0
          ? `${modeLabel}完成，生成 ${run.suggested} 条待确认建议`
          : `${modeLabel}完成，暂无新增建议`,
      color: 'success',
      orientation: 'horizontal',
      ...(run.suggested > 0 && organizeAction ? { actions: organizeAction } : {}),
    })
  }
}

// 按 recentRuns 增量推送每条新完成记录，确保队列连续衔接时不漏报任何任务结果
const initializedDream = ref(false)
const lastSeenDreamRunId = ref<string | null>(null)
watch(
  () => props.dreamState?.recentRuns,
  (runs) => {
    if (!props.dreamState) return
    const list = runs ?? []
    if (!initializedDream.value) {
      initializedDream.value = true
      lastSeenDreamRunId.value = list[0]?.id ?? null
      return
    }
    const newRuns = collectNewDreamRuns(list, lastSeenDreamRunId.value)
    if (!newRuns.length) return
    lastSeenDreamRunId.value = list[0]!.id
    let cascadeAbortedCount = 0
    for (const run of newRuns) {
      if (
        run.outcome === 'cancelled' &&
        run.abortedReason?.startsWith('因前序任务触发上游故障已中止')
      ) {
        cascadeAbortedCount++
        continue
      }
      notifyDreamRunCompletion(run)
    }
    if (cascadeAbortedCount > 0) {
      toast.add({
        title: `上游故障已中止后续 ${cascadeAbortedCount} 项等待任务`,
        color: 'error',
        orientation: 'horizontal',
      })
    }
  },
  { immediate: true },
)

const initializedBackfill = ref(false)
const lastSeenBackfillRunId = ref<string | null>(null)
function currentBackfillRunKey(state: EmbeddingBackfillState | null): string | null {
  return state?.recentRuns?.[0]?.id ?? state?.lastFinishedAt ?? null
}
watch(
  () => [props.embeddingBackfill?.running, currentBackfillRunKey(props.embeddingBackfill)] as const,
  ([running, runKey]) => {
    const bf = props.embeddingBackfill
    if (!bf) return
    if (!initializedBackfill.value) {
      initializedBackfill.value = true
      lastSeenBackfillRunId.value = runKey
      return
    }
    if (!running && runKey && runKey !== lastSeenBackfillRunId.value) {
      lastSeenBackfillRunId.value = runKey
      void queryClient.invalidateQueries({ queryKey: ['models-settings'] })
      if (bf.lastOutcome === 'cancelled') {
        toast.add({
          title:
            bf.lastUpdatedCount > 0
              ? `向量补齐已取消，已更新 ${bf.lastUpdatedCount} 条索引`
              : '向量补齐已取消',
          color: 'neutral',
        })
      } else if (bf.lastOutcome === 'failed') {
        toast.add({
          title: bf.lastError ? `向量补齐失败：${bf.lastError}` : '向量补齐失败',
          color: 'error',
        })
      } else if (bf.lastOutcome === 'ok') {
        toast.add({
          title:
            bf.lastUpdatedCount > 0
              ? `向量补齐完成，已更新 ${bf.lastUpdatedCount} 条索引`
              : '向量索引已是最新状态',
          color: 'success',
        })
      }
    }
  },
  { immediate: true },
)

async function cancelDream() {
  if (cancellingDream.value) return
  cancellingDream.value = true
  try {
    const res = await api.cancelDream()
    if (!res.cancelled) {
      toast.add({ title: '当前没有可取消的整理任务', color: 'neutral' })
    }
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '取消整理失败', color: 'error' })
  } finally {
    cancellingDream.value = false
  }
}

async function removeQueuedTask(jobId: string, modeLabel: string) {
  if (removingQueueId.value || clearingQueue.value) return
  removingQueueId.value = jobId
  try {
    const res = await api.removeQueuedDream(jobId)
    if (res.removed) {
      toast.add({ title: `已移出等待任务：${modeLabel}`, color: 'neutral' })
    } else {
      toast.add({ title: '该任务已开始执行或已被移出', color: 'neutral' })
    }
    await queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '移出队列失败', color: 'error' })
  } finally {
    removingQueueId.value = null
  }
}

async function clearQueue() {
  if (clearingQueue.value) return
  clearingQueue.value = true
  try {
    const res = await api.clearDreamQueue()
    if (res.removed > 0) {
      toast.add({ title: `已清空 ${res.removed} 项等待任务`, color: 'neutral' })
    } else {
      toast.add({ title: '当前没有等待中的整理任务', color: 'neutral' })
    }
    await queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '清空队列失败', color: 'error' })
  } finally {
    clearingQueue.value = false
  }
}

async function startBackfill() {
  if (startingBackfill.value || backfillRunning.value) return false
  startingBackfill.value = true
  try {
    const res = await api.backfillEmbeddings()
    if (res.queued > 0) {
      toast.add({ title: `已开始补齐 ${res.queued} 条向量索引`, color: 'success' })
    } else {
      toast.add({ title: '向量索引已是最新状态', color: 'neutral' })
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
      queryClient.invalidateQueries({ queryKey: ['models-settings'] }),
    ])
    return res.queued > 0
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '触发向量补齐失败', color: 'error' })
    return false
  } finally {
    startingBackfill.value = false
  }
}

async function cancelBackfill() {
  if (cancellingBackfill.value) return
  cancellingBackfill.value = true
  try {
    const res = await api.cancelEmbeddingBackfill()
    if (!res.cancelled) {
      toast.add({ title: '当前没有可取消的向量补齐任务', color: 'neutral' })
    }
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    void queryClient.invalidateQueries({ queryKey: ['models-settings'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '取消补齐失败', color: 'error' })
  } finally {
    cancellingBackfill.value = false
  }
}

async function retryHistoryItem(item: TaskHistoryItem, scope?: 'failed_only' | 'full') {
  if (retryingKey.value) return
  retryingKey.value = item.key
  try {
    if (item.source === 'backfill') {
      const started = await startBackfill()
      if (started && isActiveTaskIssue(item, dismissedIssueKeys.value)) {
        persistDismissedKey(item.key)
      }
      return
    }
    const targetScope =
      scope ?? (item.outcome === 'partial' && item.failedItems?.length ? 'failed_only' : 'full')
    const res = await api.retryDreamRun(item.id, { scope: targetScope })
    if (res.started) {
      if (res.status === 'queued') {
        toast.add({
          title: `已加入整理队列，当前排第 ${res.position ?? 1} 位`,
          description: item.title,
          color: 'success',
        })
      } else {
        toast.add({
          title:
            targetScope === 'failed_only' && item.failedItems?.length
              ? `已开始重试失败项（${item.failedItems.length} 条）`
              : `已重新发起${item.title}`,
          color: 'success',
        })
      }
    } else {
      toast.add({ title: res.reason ?? '当前无法重新发起该任务', color: 'neutral' })
    }
    await queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '重试任务失败', color: 'error' })
  } finally {
    retryingKey.value = null
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    title="后台任务"
    :ui="{ content: 'max-w-[26.5rem] sm:max-w-[26.5rem]', body: 'p-0 sm:p-0' }"
  >
    <button
      type="button"
      class="task-trigger tabular-nums"
      :class="{
        'is-running': hasBusyTasks,
        'is-error': !hasBusyTasks && unreadFailedCount > 0 && !unreadOnlyPartial,
        'is-warning': !hasBusyTasks && unreadFailedCount > 0 && unreadOnlyPartial,
        'has-badge': unreadFailedCount > 0,
      }"
      :title="triggerTooltip"
      :aria-label="triggerTooltip"
      :aria-expanded="open"
    >
      <span v-if="hasBusyTasks" class="ring-box" aria-hidden="true">
        <svg
          class="ring-svg"
          :class="{ 'is-indeterminate': overallProgress === null }"
          :width="RING_SIZE"
          :height="RING_SIZE"
          :viewBox="`0 0 ${RING_SIZE} ${RING_SIZE}`"
        >
          <circle
            class="ring-track"
            :cx="RING_SIZE / 2"
            :cy="RING_SIZE / 2"
            :r="RING_RADIUS"
            fill="none"
            :stroke-width="RING_STROKE"
          />
          <circle
            class="ring-arc"
            :cx="RING_SIZE / 2"
            :cy="RING_SIZE / 2"
            :r="RING_RADIUS"
            fill="none"
            :stroke-width="RING_STROKE"
            :stroke-dasharray="ringDashArray"
          />
        </svg>
        <span class="ring-count">{{ ringCount }}</span>
      </span>
      <UIcon
        v-else
        :name="
          unreadFailedCount > 0
            ? unreadOnlyPartial
              ? icons.warning
              : icons.error
            : icons.tasksIdle
        "
        class="idle-icon"
        :class="{
          'is-error': unreadFailedCount > 0 && !unreadOnlyPartial,
          'is-warning': unreadFailedCount > 0 && unreadOnlyPartial,
        }"
        aria-hidden="true"
      />
      <span v-if="unreadFailedCount > 0" class="corner-badge" aria-hidden="true">
        {{ unreadBadgeText }}
      </span>
    </button>

    <template #body>
      <div class="drawer-shell tabular-nums">
        <!-- 异常任务置顶区块，无未处理异常时整块隐藏 -->
        <section v-if="pinnedIssues.length > 0" class="drawer-section" aria-label="异常任务">
          <div class="section-head">
            <h3 class="section-title is-error">异常任务（{{ pinnedIssues.length }}）</h3>
          </div>

          <div class="issue-list">
            <article
              v-for="item in pinnedIssues"
              :key="item.key"
              class="issue-item"
              :class="{ 'is-partial': item.outcome === 'partial' }"
            >
              <div class="issue-top">
                <span class="issue-name">{{ item.title }}</span>
                <span class="status-tag" :class="outcomeTone(item.outcome)">
                  {{ outcomeTagText(item) }}
                </span>
                <time
                  class="item-time"
                  :datetime="item.finishedAt"
                  :title="formatTime(item.finishedAt)"
                >
                  {{ formatRelative(item.finishedAt) }}
                </time>
              </div>

              <p class="issue-reason" :class="{ 'is-error': item.outcome === 'failed' }">
                {{ item.errorDetail || item.summary }}
              </p>

              <div v-if="item.outcome === 'partial' && item.failedItems?.length" class="issue-ids">
                <div v-for="fi in visibleFailedItems(item)" :key="fi.shortId" class="issue-id-line">
                  <RouterLink
                    :to="entryRoute(fi.shortId)"
                    class="issue-id-link"
                    :title="fi.title ? `${fi.title}（${fi.shortId}）` : fi.shortId"
                    @click="open = false"
                  >
                    {{ fi.shortId }}
                  </RouterLink>
                  <span class="issue-id-reason">{{ fi.reason }}</span>
                </div>

                <button
                  v-if="item.failedItems.length > PARTIAL_FAILED_COLLAPSE_THRESHOLD"
                  type="button"
                  class="issue-expand-btn"
                  @click="toggleFailedItemsExpand(item.key)"
                >
                  {{
                    hiddenFailedCount(item) > 0
                      ? `展开其余 ${hiddenFailedCount(item)} 项`
                      : '收起明细'
                  }}
                </button>
              </div>

              <div class="issue-actions">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.refresh"
                  :loading="retryingKey === item.key"
                  :disabled="Boolean(retryingKey && retryingKey !== item.key)"
                  class="ink-outline-btn"
                  @click="retryHistoryItem(item)"
                >
                  {{ retryButtonLabel(item) }}
                </UButton>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.cancel"
                  :disabled="retryingKey === item.key"
                  @click="dismissIssue(item)"
                >
                  忽略
                </UButton>
              </div>
            </article>
          </div>
        </section>

        <!-- 记忆整理顺序队列区块 -->
        <section class="drawer-section" aria-label="记忆整理">
          <div class="section-head">
            <h3 class="section-title">记忆整理</h3>
            <div class="section-meta-right">
              <span class="section-hint">{{ dreamQueueSummaryText }}</span>
              <button
                v-if="queuedCount >= 2"
                type="button"
                class="text-link-btn"
                :disabled="clearingQueue"
                @click="clearQueue"
              >
                {{ clearingQueue ? '清空中…' : '清空队列' }}
              </button>
            </div>
          </div>

          <p v-if="!dreamRunning && queuedCount === 0" class="section-empty-line">
            当前没有进行中或等待中的整理任务。
          </p>

          <div v-else class="tl-list">
            <div v-if="dreamRunning" class="tl-row">
              <div class="tl-axis" aria-hidden="true">
                <span class="tl-dot is-active" />
                <span class="tl-line" />
              </div>
              <div class="tl-body is-active">
                <div class="tl-top">
                  <span class="tl-title">{{ dreamModeLabel }}</span>
                  <span v-if="dreamProgress && dreamProgress.total > 0" class="tl-stat">
                    {{ dreamProgress.processed }}/{{ dreamProgress.total }} · {{ dreamPercent }}%
                  </span>
                  <span v-else class="tl-stat">准备中…</span>
                </div>

                <p class="tl-sub">
                  {{ activeDreamTriggerLabel }} · {{ dreamStageText
                  }}<template v-if="dreamProgress && dreamProgress.suggested > 0">
                    · 已生成 {{ dreamProgress.suggested }} 条</template
                  >
                </p>

                <div
                  class="progress-track"
                  role="progressbar"
                  aria-label="整理任务进度"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  :aria-valuenow="dreamPercent ?? undefined"
                >
                  <div
                    v-if="dreamPercent !== null"
                    class="progress-fill"
                    :style="{ width: `${dreamPercent}%` }"
                  />
                  <div v-else class="progress-indeterminate" />
                </div>

                <div class="tl-actions">
                  <RouterLink :to="{ name: 'organize' }" class="quiet-action" @click="open = false">
                    <UIcon :name="icons.listChecks" class="quiet-icon" aria-hidden="true" />
                    <span>前往整理</span>
                  </RouterLink>
                  <button
                    type="button"
                    class="quiet-action is-danger"
                    :disabled="cancellingDream"
                    @click="cancelDream"
                  >
                    <UIcon :name="icons.stop" class="quiet-icon" aria-hidden="true" />
                    <span>{{ cancellingDream ? '取消中…' : '取消' }}</span>
                  </button>
                </div>
              </div>
            </div>

            <div v-for="(q, idx) in queuedDreamTasks" :key="q.id" class="tl-row">
              <div class="tl-axis" aria-hidden="true">
                <span class="tl-dot" />
                <span class="tl-line" />
              </div>
              <div class="tl-body is-queued">
                <div class="tl-queued-info">
                  <div class="tl-queued-title">
                    <span class="tl-seq">#{{ idx + 1 }}</span>
                    <span>{{ dreamModeLabels[q.mode] }}</span>
                  </div>
                  <p class="tl-sub is-truncate">
                    {{ q.trigger === 'scheduled' ? '定时触发' : '手动发起' }} ·
                    {{ formatDreamTaskScope(q.mode, q.params, q.targetCount) }}
                  </p>
                </div>
                <button
                  type="button"
                  class="quiet-action"
                  :disabled="removingQueueId === q.id || clearingQueue"
                  @click="removeQueuedTask(q.id, dreamModeLabels[q.mode])"
                >
                  <UIcon :name="icons.cancel" class="quiet-icon" aria-hidden="true" />
                  <span>移出</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 向量索引状态与补齐区块 -->
        <section class="drawer-section" aria-label="向量索引">
          <div class="section-head">
            <h3 class="section-title">向量索引</h3>
          </div>

          <div v-if="backfillRunning" class="tl-body is-active">
            <div class="tl-top">
              <span class="tl-title">正在补齐索引</span>
              <span v-if="embeddingBackfill && embeddingBackfill.total > 0" class="tl-stat">
                {{ embeddingBackfill.processed }}/{{ embeddingBackfill.total }} ·
                {{ backfillPercent }}%
              </span>
              <span v-else class="tl-stat">准备中…</span>
            </div>

            <p class="tl-sub">
              {{ embeddingBackfill?.model || '正在为缺失向量的记忆建立检索索引' }}
            </p>

            <div
              class="progress-track"
              role="progressbar"
              aria-label="向量补齐进度"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="backfillPercent ?? undefined"
            >
              <div
                v-if="backfillPercent !== null"
                class="progress-fill"
                :style="{ width: `${backfillPercent}%` }"
              />
              <div v-else class="progress-indeterminate" />
            </div>

            <div class="tl-actions">
              <button
                type="button"
                class="quiet-action is-danger"
                :disabled="cancellingBackfill"
                @click="cancelBackfill"
              >
                <UIcon :name="icons.stop" class="quiet-icon" aria-hidden="true" />
                <span>{{ cancellingBackfill ? '取消中…' : '取消' }}</span>
              </button>
            </div>
          </div>

          <div v-else-if="embeddingCoverage?.model && missingEmbeddings > 0" class="vec-inline-row">
            <span class="vec-summary">
              <strong class="vec-ratio">
                {{ embeddingCoverage.embedded }}/{{ embeddingCoverage.total }}
              </strong>
              <span class="vec-missing">缺 {{ missingEmbeddings }} 条</span>
            </span>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.database"
              :loading="startingBackfill"
              @click="startBackfill"
            >
              补齐
            </UButton>
          </div>

          <p v-else-if="embeddingCoverage?.model" class="section-empty-line">
            <span class="vec-ratio">
              {{ embeddingCoverage.embedded }}/{{ embeddingCoverage.total }}
            </span>
            · 已全部完成索引
          </p>

          <div v-else-if="modelsSettingsQuery.data.value" class="vec-unconfigured">
            <span class="section-empty-line">尚未启用嵌入模型</span>
            <RouterLink :to="settingsRoute('models')" class="text-link-btn" @click="open = false">
              模型设置
            </RouterLink>
          </div>
        </section>

        <!-- 近期记录（默认折叠，点击展开） -->
        <section class="drawer-section" aria-label="近期记录">
          <button
            type="button"
            class="history-fold-btn"
            :aria-expanded="historyExpanded"
            @click="historyExpanded = !historyExpanded"
          >
            <span class="history-fold-lead">
              <UIcon
                :name="historyExpanded ? icons.chevronDown : icons.chevronRight"
                class="quiet-icon"
                aria-hidden="true"
              />
              <span>近期记录（{{ archivedHistory.length }}）</span>
            </span>
            <span class="history-fold-hint">{{ historyExpanded ? '收起' : '展开' }}</span>
          </button>

          <div v-if="historyExpanded" class="archived-wrap">
            <div v-if="archivedHistory.length > 0" class="archived-toolbar">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="icons.eraser"
                @click="clearHistory"
              >
                清空记录
              </UButton>
            </div>

            <ul v-if="archivedHistory.length > 0" class="archived-list">
              <li v-for="item in archivedHistory" :key="item.key" class="archived-item">
                <div class="archived-main">
                  <div class="archived-top">
                    <span class="archived-title">{{ item.title }}</span>
                    <span v-if="item.trigger === 'scheduled'" class="status-tag is-muted">
                      定时
                    </span>
                    <span class="status-tag" :class="outcomeTone(item.outcome)">
                      {{ outcomeTagText(item) }}
                    </span>
                    <span v-if="item.retriedByRunId" class="status-tag is-muted">已重试</span>
                    <time
                      class="item-time"
                      :datetime="item.finishedAt"
                      :title="formatTime(item.finishedAt)"
                    >
                      {{ formatRelative(item.finishedAt) }}
                    </time>
                  </div>
                  <p class="archived-summary">{{ item.summary }}</p>
                  <p
                    v-if="item.errorDetail && item.errorDetail !== item.summary"
                    class="archived-error"
                    :class="item.outcome === 'partial' ? 'is-warning' : 'is-error'"
                  >
                    {{ item.errorDetail }}
                  </p>
                </div>

                <button
                  v-if="item.outcome === 'cancelled' && !item.retriedByRunId"
                  type="button"
                  class="quiet-action shrink-0"
                  :disabled="Boolean(retryingKey)"
                  @click="retryHistoryItem(item, 'full')"
                >
                  <UIcon :name="icons.refresh" class="quiet-icon" aria-hidden="true" />
                  <span>重新发起</span>
                </button>
              </li>
            </ul>

            <p v-else class="section-empty-line">暂无近期记录。</p>
          </div>
        </section>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
.task-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  border: 1px solid var(--ui-border-accented);
  background: transparent;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.task-trigger:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.task-trigger.is-running {
  border-color: var(--ui-rule);
  background: var(--ui-bg-bright);
  color: var(--ui-text-highlighted);
}
.task-trigger.is-error {
  border-color: var(--ui-error);
}
.task-trigger.is-warning {
  border-color: var(--ui-warning);
}
.task-trigger.has-badge {
  margin-right: 3px;
}

.idle-icon {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  color: currentColor;
}
.idle-icon.is-error {
  color: var(--ui-error);
}
.idle-icon.is-warning {
  color: var(--ui-warning);
}

.ring-box {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
}
.ring-svg {
  display: block;
  transform: rotate(-90deg);
}
.ring-svg.is-indeterminate {
  animation: kioku-ring-spin 1.1s linear infinite;
}
.ring-track {
  stroke: var(--ui-border-accented);
}
.ring-arc {
  stroke: var(--ui-text-highlighted);
  transition: stroke-dasharray 220ms ease;
}
.ring-count {
  position: absolute;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  color: var(--ui-text-highlighted);
}

.corner-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  background: var(--ui-error);
  color: var(--ui-text-inverted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}

.drawer-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.drawer-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 18px;
}
.drawer-section + .drawer-section {
  border-top: 1px solid var(--ui-border);
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.section-title.is-error {
  color: var(--ui-error);
}
.section-meta-right {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.section-hint {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.section-empty-line {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.text-link-btn {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 12px;
  color: var(--ui-text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 65%, transparent);
  text-underline-offset: 3px;
  cursor: pointer;
}
.text-link-btn:hover:not(:disabled) {
  text-decoration-color: currentColor;
}
.text-link-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 异常任务卡片 */
.issue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.issue-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-left: 2px solid var(--ui-error);
  background: var(--ui-bg-bright);
}
.issue-item.is-partial {
  border-left-color: var(--ui-warning);
}
.issue-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.issue-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.issue-reason {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.issue-reason.is-error {
  color: var(--ui-error);
}
.issue-ids {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 35%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-warning) 7%, var(--ui-bg-bright));
  font-size: 12px;
}
.issue-id-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.issue-id-link {
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.issue-id-link:hover {
  color: var(--ui-error);
}
.issue-id-reason {
  min-width: 0;
  color: var(--ui-text-toned);
  overflow-wrap: anywhere;
}
.issue-expand-btn {
  align-self: flex-start;
  padding: 2px 0 0;
  font-size: 12px;
  color: var(--ui-text-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.issue-expand-btn:hover {
  color: var(--ui-text-highlighted);
}
.issue-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}
.ink-outline-btn {
  border-color: var(--ui-rule);
}

.status-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-toned);
  white-space: nowrap;
}
.status-tag.is-ok {
  border-color: var(--ui-success);
  color: var(--ui-success);
}
.status-tag.is-warning {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.status-tag.is-error {
  border-color: var(--ui-error);
  color: var(--ui-error);
}
.status-tag.is-muted {
  border-color: var(--ui-border);
  color: var(--ui-text-muted);
}
.item-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--ui-text-dimmed);
  white-space: nowrap;
}

/* 记忆整理 1px 竖线时间轴 */
.tl-list {
  display: flex;
  flex-direction: column;
}
.tl-row {
  position: relative;
  display: flex;
  gap: 11px;
  padding-bottom: 10px;
}
.tl-row:last-child {
  padding-bottom: 0;
}
.tl-axis {
  position: relative;
  width: 12px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.tl-dot {
  width: 9px;
  height: 9px;
  margin-top: 6px;
  border: 1.5px solid var(--ui-rule);
  background: var(--ui-bg);
  z-index: 1;
  flex: none;
}
.tl-dot.is-active {
  background: var(--ui-rule);
}
.tl-line {
  position: absolute;
  top: 15px;
  bottom: -6px;
  left: 50%;
  width: 1px;
  background: var(--ui-border-accented);
  transform: translateX(-0.5px);
}
.tl-row:last-child .tl-line {
  display: none;
}
.tl-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-bright);
}
.tl-body.is-active {
  border-color: var(--ui-border-accented);
}
.tl-body.is-queued {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
}
.tl-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tl-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.tl-stat {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-toned);
  white-space: nowrap;
}
.tl-sub {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.tl-sub.is-truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-queued-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tl-queued-title {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.tl-seq {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.tl-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding-top: 2px;
}

.progress-track {
  position: relative;
  height: 4px;
  overflow: hidden;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg);
}
.progress-fill {
  height: 100%;
  background: var(--ui-rule);
  transition: width 180ms ease;
}
.progress-indeterminate {
  position: absolute;
  inset: 0 auto 0 0;
  width: 35%;
  background: var(--ui-rule);
  animation: kioku-indeterminate 1.4s ease-in-out infinite;
}

.quiet-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  background: transparent;
  font-size: 12px;
  color: var(--ui-text-muted);
  white-space: nowrap;
  cursor: pointer;
}
.quiet-action:hover:not(:disabled) {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.quiet-action.is-danger {
  color: var(--ui-error);
}
.quiet-action.is-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-error) 10%, var(--ui-bg-bright));
  color: var(--ui-error);
}
.quiet-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.quiet-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}

/* 向量索引极简单行栏 */
.vec-inline-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-bright);
  font-size: 13px;
}
.vec-summary {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.vec-ratio {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.vec-missing {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.vec-unconfigured {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* 近期记录折叠区 */
.history-fold-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.history-fold-btn:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.history-fold-lead {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.history-fold-hint {
  color: var(--ui-text-muted);
}
.archived-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.archived-toolbar {
  display: flex;
  justify-content: flex-end;
}
.archived-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--ui-border);
}
.archived-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 12px;
}
.archived-item:last-child {
  border-bottom: 0;
}
.archived-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.archived-top {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.archived-title {
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.archived-summary {
  line-height: 1.5;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.archived-error {
  padding-left: 8px;
  border-left: 2px solid var(--ui-error);
  line-height: 1.45;
  color: var(--ui-error);
  overflow-wrap: anywhere;
}
.archived-error.is-warning {
  border-left-color: var(--ui-warning);
  color: var(--ui-warning);
}

@keyframes kioku-ring-spin {
  from {
    transform: rotate(-90deg);
  }
  to {
    transform: rotate(270deg);
  }
}
@keyframes kioku-indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(300%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ring-svg.is-indeterminate,
  .progress-indeterminate {
    animation: none;
  }
}
</style>
