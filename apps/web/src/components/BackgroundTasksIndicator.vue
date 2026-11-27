<script setup lang="ts">
import type { DreamOutcome, DreamState, EmbeddingBackfillState } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { dreamModeLabels, dreamOutcomeLabels } from '../labels'
import { settingsRoute } from '../routes'
import {
  computeOverallProgress,
  filterVisibleHistory,
  isAfterWatermark,
  isTaskIssueOutcome,
  latestFailedTimestamp,
  latestInboxFailureTimestamp,
  mergeTaskHistory,
  TASK_HISTORY_LIMIT,
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

const props = defineProps<{
  dreamState: DreamState | null
  embeddingBackfill: EmbeddingBackfillState | null
}>()

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()

const open = ref(false)
const cancellingDream = ref(false)
const cancellingBackfill = ref(false)
const clearedBefore = ref<string | null>(readStoredString(UI_STORAGE_KEYS.tasksClearedBefore))
const ackErrorAt = ref<string | null>(readStoredString(UI_STORAGE_KEYS.tasksAckErrorAt))

const stopClearedSync = subscribeStoredString(UI_STORAGE_KEYS.tasksClearedBefore, (value) => {
  clearedBefore.value = value
})
const stopAckSync = subscribeStoredString(UI_STORAGE_KEYS.tasksAckErrorAt, (value) => {
  ackErrorAt.value = value
})
onBeforeUnmount(() => {
  stopClearedSync()
  stopAckSync()
})

const dreamRunning = computed(() => Boolean(props.dreamState?.running))
const dreamProgress = computed(() => props.dreamState?.progress ?? null)
const backfillRunning = computed(() => Boolean(props.embeddingBackfill?.running))
const activeCount = computed(() => (dreamRunning.value ? 1 : 0) + (backfillRunning.value ? 1 : 0))

const allHistory = computed(() => mergeTaskHistory(props.dreamState, props.embeddingBackfill))
const visibleHistory = computed(() => filterVisibleHistory(allHistory.value, clearedBefore.value))
const unreadIssues = computed(() =>
  allHistory.value.filter(
    (item) =>
      isTaskIssueOutcome(item.outcome) &&
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

const issueHistoryCount = computed(
  () => visibleHistory.value.filter((item) => isTaskIssueOutcome(item.outcome)).length,
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

const dreamModeLabel = computed(() => {
  const mode = dreamProgress.value?.mode
  if (mode === 'tidy') return dreamModeLabels.tidy
  if (mode === 'cross_memory') return dreamModeLabels.cross_memory
  return dreamModeLabels.standard
})

const dreamModeIcon = computed(() => {
  const mode = dreamProgress.value?.mode
  if (mode === 'tidy') return icons.tidy
  if (mode === 'cross_memory') return icons.links
  return icons.sparkles
})

const dreamStageText = computed(() => {
  if (dreamProgress.value?.stage) return `${dreamProgress.value.stage}中`
  return `${dreamModeLabel.value}中`
})

const dreamPercent = computed(() => {
  const p = dreamProgress.value
  if (!p || p.total <= 0) return null
  return Math.min(100, Math.round((p.processed / p.total) * 100))
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
        ? `${activeCount.value} 项运行中（${overallProgress.value}%）`
        : `${activeCount.value} 项运行中`,
    )
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
  const latestFail = latestFailedTimestamp(visibleHistory.value)
  advanceWatermark(ackErrorAt, UI_STORAGE_KEYS.tasksAckErrorAt, latestFail)
}

watch(open, (visible) => {
  if (visible) {
    acknowledgeErrors()
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  }
})

watch(visibleHistory, () => {
  if (open.value) acknowledgeErrors()
})

function clearHistory() {
  const newest = visibleHistory.value[0]?.finishedAt ?? null
  if (!newest) return
  advanceWatermark(clearedBefore, UI_STORAGE_KEYS.tasksClearedBefore, newest)
  advanceWatermark(ackErrorAt, UI_STORAGE_KEYS.tasksAckErrorAt, newest)
  const latestFailure = latestInboxFailureTimestamp(props.dreamState)
  const dismissTarget =
    latestFailure && isAfterWatermark(latestFailure, newest) ? latestFailure : newest
  const prevDismissed = readStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt)
  if (!prevDismissed || isAfterWatermark(dismissTarget, prevDismissed)) {
    writeStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt, dismissTarget)
  }
}

function outcomeIcon(outcome: DreamOutcome): string {
  if (outcome === 'ok') return icons.checkCircle
  if (outcome === 'failed') return icons.error
  if (outcome === 'partial') return icons.warning
  if (outcome === 'cancelled') return icons.stop
  return icons.info
}

function outcomeTone(outcome: DreamOutcome): string {
  if (outcome === 'ok') return 'is-ok'
  if (outcome === 'failed') return 'is-error'
  if (outcome === 'partial') return 'is-warning'
  return 'is-muted'
}

function outcomeTagText(item: TaskHistoryItem): string {
  if (item.outcome === 'skipped') return '无变更'
  return dreamOutcomeLabels[item.outcome]
}

// 监听后台任务由运行转为空闲且产生新完成记录时推送一次结果提醒，避免首次加载或排队超时误报
const initializedDream = ref(false)
const prevDreamRunning = ref(false)
const lastSeenDreamRunId = ref<string | null>(null)
watch(
  dreamRunning,
  (running) => {
    const latest = props.dreamState?.recentRuns[0] ?? null
    if (!initializedDream.value) {
      if (props.dreamState !== null) {
        initializedDream.value = true
        prevDreamRunning.value = running
        lastSeenDreamRunId.value = latest?.id ?? null
      }
      return
    }
    if (!prevDreamRunning.value && running) {
      lastSeenDreamRunId.value = latest?.id ?? lastSeenDreamRunId.value
    } else if (
      prevDreamRunning.value &&
      !running &&
      latest &&
      latest.id !== lastSeenDreamRunId.value
    ) {
      lastSeenDreamRunId.value = latest.id
      const modeLabel = latest.mode ? dreamModeLabels[latest.mode] : '记忆整理'
      const onInbox = route.name === 'inbox'
      const inboxAction = !onInbox
        ? [
            {
              label: '前往待处理',
              icon: icons.inbox,
              color: 'neutral' as const,
              variant: 'outline' as const,
              onClick: () => void router.push({ name: 'inbox' }),
            },
          ]
        : undefined
      if (latest.outcome === 'cancelled') {
        toast.add({
          title:
            latest.suggested > 0
              ? `${modeLabel}已取消，已保留 ${latest.suggested} 条待处理建议`
              : `${modeLabel}已取消`,
          color: 'neutral',
          orientation: 'horizontal',
          ...(latest.suggested > 0 && inboxAction ? { actions: inboxAction } : {}),
        })
      } else if (latest.outcome === 'failed') {
        toast.add({
          title: latest.error ? `${modeLabel}失败：${latest.error}` : `${modeLabel}失败`,
          color: 'error',
          orientation: 'horizontal',
          ...(inboxAction ? { actions: inboxAction } : {}),
        })
      } else if (latest.outcome === 'partial') {
        const errReason = latest.error?.trim() || latest.failedItems?.[0]?.reason?.trim()
        toast.add({
          title:
            latest.suggested > 0
              ? `${modeLabel}部分完成，生成 ${latest.suggested} 条待处理建议`
              : `${modeLabel}部分失败`,
          ...(errReason ? { description: errReason } : {}),
          color: 'warning',
          orientation: 'horizontal',
          ...(inboxAction ? { actions: inboxAction } : {}),
        })
      } else if (latest.outcome === 'skipped') {
        toast.add({
          title: `${modeLabel}完成，当前无可整理项`,
          color: 'neutral',
          orientation: 'horizontal',
        })
      } else {
        toast.add({
          title:
            latest.suggested > 0
              ? `${modeLabel}完成，生成 ${latest.suggested} 条待处理建议`
              : `${modeLabel}完成，暂无新增建议`,
          color: 'success',
          orientation: 'horizontal',
          ...(latest.suggested > 0 && inboxAction ? { actions: inboxAction } : {}),
        })
      }
    }
    prevDreamRunning.value = running
  },
  { immediate: true },
)

const initializedBackfill = ref(false)
const prevBackfillRunning = ref(false)
const lastSeenBackfillRunId = ref<string | null>(null)
function currentBackfillRunKey(state: EmbeddingBackfillState | null): string | null {
  return state?.recentRuns?.[0]?.id ?? state?.lastFinishedAt ?? null
}
watch(
  backfillRunning,
  (running) => {
    const bf = props.embeddingBackfill
    const runKey = currentBackfillRunKey(bf)
    if (!initializedBackfill.value) {
      if (bf !== null) {
        initializedBackfill.value = true
        prevBackfillRunning.value = running
        lastSeenBackfillRunId.value = runKey
      }
      return
    }
    if (!prevBackfillRunning.value && running) {
      lastSeenBackfillRunId.value = runKey ?? lastSeenBackfillRunId.value
    } else if (
      prevBackfillRunning.value &&
      !running &&
      runKey &&
      runKey !== lastSeenBackfillRunId.value
    ) {
      lastSeenBackfillRunId.value = runKey
      void queryClient.invalidateQueries({ queryKey: ['models-settings'] })
      if (bf?.lastOutcome === 'cancelled') {
        toast.add({
          title:
            bf.lastUpdatedCount > 0
              ? `向量补齐已取消，已更新 ${bf.lastUpdatedCount} 条索引`
              : '向量补齐已取消',
          color: 'neutral',
        })
      } else if (bf?.lastOutcome === 'failed') {
        toast.add({
          title: bf.lastError ? `向量补齐失败：${bf.lastError}` : '向量补齐失败',
          color: 'error',
        })
      } else if (bf?.lastOutcome === 'ok') {
        toast.add({
          title:
            bf.lastUpdatedCount > 0
              ? `向量补齐完成，已更新 ${bf.lastUpdatedCount} 条索引`
              : '向量索引已是最新状态',
          color: 'success',
        })
      }
    }
    prevBackfillRunning.value = running
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
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    title="后台任务"
    :description="`最多保留最近 ${TASK_HISTORY_LIMIT} 条记录`"
    :ui="{ content: 'max-w-[26.5rem] sm:max-w-[26.5rem]', body: 'p-0 sm:p-0' }"
  >
    <button
      type="button"
      class="task-trigger tabular-nums"
      :class="{
        'is-running': activeCount > 0,
        'is-error': activeCount === 0 && unreadFailedCount > 0 && !unreadOnlyPartial,
        'is-warning': activeCount === 0 && unreadFailedCount > 0 && unreadOnlyPartial,
        'has-badge': unreadFailedCount > 0,
      }"
      :title="triggerTooltip"
      :aria-label="triggerTooltip"
      :aria-expanded="open"
    >
      <span v-if="activeCount > 0" class="ring-box" aria-hidden="true">
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
        <span class="ring-count">{{ activeCount }}</span>
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
        <div class="stat-strip">
          <div class="stat-cell">
            <span class="stat-label">进行中</span>
            <strong class="stat-value">{{ activeCount }}</strong>
          </div>
          <div class="stat-cell">
            <span class="stat-label">近期记录</span>
            <strong class="stat-value">{{ visibleHistory.length }}</strong>
          </div>
          <div class="stat-cell">
            <span class="stat-label">异常</span>
            <strong class="stat-value" :class="{ 'is-error': issueHistoryCount > 0 }">
              {{ issueHistoryCount }}
            </strong>
          </div>
        </div>

        <section v-if="activeCount > 0" class="drawer-section">
          <div class="section-head">
            <h3 class="section-title">
              <UIcon :name="icons.loader" class="section-spin-icon" aria-hidden="true" />
              <span>进行中（{{ activeCount }}）</span>
            </h3>
            <span class="section-hint">可随时取消</span>
          </div>

          <div class="active-list">
            <div v-if="dreamRunning" class="active-card">
              <div class="active-card-head">
                <span class="active-name">
                  <UIcon :name="dreamModeIcon" class="active-icon" aria-hidden="true" />
                  <span>{{ dreamStageText }}</span>
                </span>
                <span v-if="dreamProgress && dreamProgress.total > 0" class="active-count">
                  {{ dreamProgress.processed }} / {{ dreamProgress.total }} 条
                </span>
                <span v-else class="active-count">准备中…</span>
              </div>

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

              <p class="active-meta">
                <template v-if="dreamProgress">
                  已生成 {{ dreamProgress.suggested }} 条建议<template
                    v-if="dreamProgress.failed > 0"
                  >
                    · 失败 {{ dreamProgress.failed }} 条</template
                  >
                </template>
                <template v-else>正在筛选候选记忆，确认后才会写入记忆库。</template>
              </p>

              <div class="active-actions">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.inbox"
                  :to="{ name: 'inbox' }"
                  @click="open = false"
                >
                  前往待处理
                </UButton>
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

            <div v-if="backfillRunning" class="active-card">
              <div class="active-card-head">
                <span class="active-name">
                  <UIcon :name="icons.database" class="active-icon" aria-hidden="true" />
                  <span>向量索引补齐</span>
                </span>
                <span v-if="embeddingBackfill && embeddingBackfill.total > 0" class="active-count">
                  {{ embeddingBackfill.processed }} / {{ embeddingBackfill.total }} 条
                </span>
                <span v-else class="active-count">准备中…</span>
              </div>

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

              <p class="active-meta">
                <template v-if="embeddingBackfill?.model">
                  模型：{{ embeddingBackfill.model }}
                </template>
                <template v-else>正在为缺失向量的记忆建立检索索引。</template>
              </p>

              <div class="active-actions">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.models"
                  :to="settingsRoute('models')"
                  @click="open = false"
                >
                  模型设置
                </UButton>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.stop"
                  :loading="cancellingBackfill"
                  @click="cancelBackfill"
                >
                  取消补齐
                </UButton>
              </div>
            </div>
          </div>
        </section>

        <section class="drawer-section">
          <div class="section-head">
            <h3 class="section-title">
              <UIcon :name="icons.history" class="section-icon" aria-hidden="true" />
              <span>最近记录（{{ visibleHistory.length }} / {{ TASK_HISTORY_LIMIT }}）</span>
            </h3>
            <UButton
              v-if="visibleHistory.length > 0"
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="icons.eraser"
              @click="clearHistory"
            >
              清空记录
            </UButton>
          </div>

          <ul v-if="visibleHistory.length > 0" class="history-list">
            <li v-for="item in visibleHistory" :key="item.key" class="history-row">
              <UIcon
                :name="outcomeIcon(item.outcome)"
                class="history-status-icon"
                :class="outcomeTone(item.outcome)"
                aria-hidden="true"
              />
              <div class="history-body">
                <div class="history-top">
                  <span class="history-title">
                    <UIcon :name="item.icon" class="history-kind-icon" aria-hidden="true" />
                    <span>{{ item.title }}</span>
                  </span>
                  <span v-if="item.trigger === 'scheduled'" class="history-trigger-tag">定时</span>
                  <span class="history-outcome-tag" :class="outcomeTone(item.outcome)">
                    {{ outcomeTagText(item) }}
                  </span>
                  <time
                    class="history-time"
                    :datetime="item.finishedAt"
                    :title="formatTime(item.finishedAt)"
                  >
                    {{ formatRelative(item.finishedAt) }}
                  </time>
                </div>
                <p class="history-summary" :class="{ 'is-error': item.outcome === 'failed' }">
                  {{ item.summary }}
                </p>
                <p
                  v-if="item.errorDetail && item.errorDetail !== item.summary"
                  class="history-error-detail"
                  :class="item.outcome === 'partial' ? 'is-warning' : 'is-error'"
                >
                  {{ item.errorDetail }}
                </p>
                <div v-if="item.routeTarget" class="history-links">
                  <RouterLink
                    v-if="item.routeTarget === 'inbox'"
                    :to="{ name: 'inbox' }"
                    class="history-link"
                    @click="open = false"
                  >
                    查看待处理
                  </RouterLink>
                  <RouterLink
                    v-else-if="item.routeTarget === 'models'"
                    :to="settingsRoute('models')"
                    class="history-link"
                    @click="open = false"
                  >
                    模型设置
                  </RouterLink>
                </div>
              </div>
            </li>
          </ul>

          <div v-else class="history-empty">
            <UIcon :name="icons.tasksIdle" class="empty-icon" aria-hidden="true" />
            <p class="empty-title">暂无后台任务记录</p>
            <p class="empty-desc">
              记忆整理与向量索引补齐会在此实时展示进度，并保留最近 {{ TASK_HISTORY_LIMIT }} 条记录。
            </p>
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
.stat-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 16px;
}
.stat-cell + .stat-cell {
  border-left: 1px solid var(--ui-border);
}
.stat-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.stat-value {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--ui-text-highlighted);
}
.stat-value.is-error {
  color: var(--ui-error);
}

.drawer-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 20px;
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.section-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.section-spin-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-highlighted);
  animation: kioku-spin 1.1s linear infinite;
}
.section-hint {
  font-size: 12px;
  color: var(--ui-text-muted);
}

.active-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.active-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.active-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
.active-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.active-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.active-count {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.progress-track {
  position: relative;
  height: 6px;
  overflow: hidden;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-bright);
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
.active-meta {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.active-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 2px;
}

.history-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--ui-border);
}
.history-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 0;
  border-bottom: 1px solid var(--ui-border);
}
.history-status-icon {
  display: inline-block;
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 3px;
  color: var(--ui-text-muted);
}
.history-status-icon.is-ok {
  color: var(--ui-success);
}
.history-status-icon.is-warning {
  color: var(--ui-warning);
}
.history-status-icon.is-error {
  color: var(--ui-error);
}
.history-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.history-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.history-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.history-kind-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.history-trigger-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
}
.history-outcome-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-toned);
}
.history-outcome-tag.is-ok {
  border-color: var(--ui-success);
  color: var(--ui-success);
}
.history-outcome-tag.is-warning {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.history-outcome-tag.is-error {
  border-color: var(--ui-error);
  color: var(--ui-error);
}
.history-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--ui-text-dimmed);
  white-space: nowrap;
}
.history-summary {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.history-summary.is-error {
  color: var(--ui-error);
}
.history-error-detail {
  margin-top: 2px;
  padding-left: 8px;
  border-left: 2px solid var(--ui-error);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-error);
  overflow-wrap: anywhere;
}
.history-error-detail.is-warning {
  border-left-color: var(--ui-warning);
  color: var(--ui-warning);
}
.history-links {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 2px;
}
.history-link {
  font-size: 12px;
  color: var(--ui-text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 70%, transparent);
  text-underline-offset: 3px;
}
.history-link:hover {
  text-decoration-color: currentColor;
}

.history-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 16px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  text-align: center;
}
.empty-icon {
  display: inline-block;
  width: 20px;
  height: 20px;
  color: var(--ui-text-dimmed);
}
.empty-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.empty-desc {
  max-width: 24ch;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}

@keyframes kioku-spin {
  to {
    transform: rotate(360deg);
  }
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
  .section-spin-icon,
  .progress-indeterminate {
    animation: none;
  }
}
</style>
