<script setup lang="ts">
import type { DreamState, EmbeddingBackfillState } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { dreamModeLabels } from '../labels'
import { settingsRoute } from '../routes'

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

const dreamRunning = computed(() => Boolean(props.dreamState?.running))
const dreamProgress = computed(() => props.dreamState?.progress ?? null)
const backfillRunning = computed(() => Boolean(props.embeddingBackfill?.running))
const activeCount = computed(() => (dreamRunning.value ? 1 : 0) + (backfillRunning.value ? 1 : 0))

watch(activeCount, (count) => {
  if (count === 0) open.value = false
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

const pillLabel = computed(() => {
  if (activeCount.value >= 2) return `后台任务（${activeCount.value}）`
  if (dreamRunning.value) {
    const p = dreamProgress.value
    if (p && p.total > 0) return `${dreamModeLabel.value} ${p.processed}/${p.total}`
    return `${dreamModeLabel.value}中`
  }
  if (backfillRunning.value) {
    const b = props.embeddingBackfill
    if (b && b.total > 0) return `向量补齐 ${b.processed}/${b.total}`
    return '向量补齐中'
  }
  return ''
})

// 监听后台任务由运行转为空闲时推送一次结果提醒，避免页面首次加载误报
const initializedDream = ref(false)
const prevDreamRunning = ref(false)
watch(
  dreamRunning,
  (running) => {
    if (!initializedDream.value) {
      if (props.dreamState !== null) {
        initializedDream.value = true
        prevDreamRunning.value = running
      }
      return
    }
    if (prevDreamRunning.value && !running) {
      const latest = props.dreamState?.recentRuns[0] ?? null
      const modeLabel = latest?.mode ? dreamModeLabels[latest.mode] : '记忆整理'
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
      if (latest?.outcome === 'cancelled') {
        toast.add({
          title:
            latest.suggested > 0
              ? `${modeLabel}已取消，已保留 ${latest.suggested} 条待处理建议`
              : `${modeLabel}已取消`,
          color: 'neutral',
          ...(latest.suggested > 0 && inboxAction ? { actions: inboxAction } : {}),
        })
      } else if (latest?.outcome === 'failed') {
        toast.add({
          title: latest.error ? `${modeLabel}失败：${latest.error}` : `${modeLabel}失败`,
          color: 'error',
          ...(inboxAction ? { actions: inboxAction } : {}),
        })
      } else if (latest?.outcome === 'partial') {
        toast.add({
          title: `${modeLabel}部分完成，生成 ${latest.suggested} 条待处理建议`,
          color: 'warning',
          ...(inboxAction ? { actions: inboxAction } : {}),
        })
      } else if (latest?.outcome === 'skipped') {
        toast.add({
          title: `${modeLabel}完成，当前无可整理项`,
          color: 'neutral',
        })
      } else if (latest) {
        toast.add({
          title:
            latest.suggested > 0
              ? `${modeLabel}完成，生成 ${latest.suggested} 条待处理建议`
              : `${modeLabel}完成，暂无新增建议`,
          color: 'success',
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
watch(
  backfillRunning,
  (running) => {
    if (!initializedBackfill.value) {
      if (props.embeddingBackfill !== null) {
        initializedBackfill.value = true
        prevBackfillRunning.value = running
      }
      return
    }
    if (prevBackfillRunning.value && !running) {
      void queryClient.invalidateQueries({ queryKey: ['models-settings'] })
      const bf = props.embeddingBackfill
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
  <UPopover v-if="activeCount > 0" v-model:open="open" :content="{ align: 'end', sideOffset: 6 }">
    <button
      type="button"
      class="task-pill tabular-nums"
      :aria-expanded="open"
      aria-label="查看正在执行的后台任务"
    >
      <UIcon :name="icons.loader" class="task-spin-icon" aria-hidden="true" />
      <span class="task-pill-label">{{ pillLabel }}</span>
      <UIcon :name="icons.chevronDown" class="task-caret" aria-hidden="true" />
    </button>

    <template #content>
      <div class="task-popover">
        <div class="popover-head">
          <span class="popover-title">
            <UIcon :name="icons.loader" class="task-spin-icon" aria-hidden="true" />
            <span>后台执行中（{{ activeCount }}）</span>
          </span>
          <span class="popover-sub">可随时取消</span>
        </div>

        <div class="task-list">
          <div v-if="dreamRunning" class="task-card tabular-nums">
            <div class="task-card-head">
              <span class="task-name">
                <UIcon :name="dreamModeIcon" class="task-icon" aria-hidden="true" />
                <span>{{ dreamStageText }}</span>
              </span>
              <span v-if="dreamProgress && dreamProgress.total > 0" class="task-count">
                {{ dreamProgress.processed }} / {{ dreamProgress.total }} 条
              </span>
              <span v-else class="task-count">准备中…</span>
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

            <p class="task-meta">
              <template v-if="dreamProgress">
                已生成 {{ dreamProgress.suggested }} 条建议<template
                  v-if="dreamProgress.failed > 0"
                >
                  · 失败 {{ dreamProgress.failed }} 条</template
                >
              </template>
              <template v-else>正在筛选候选记忆，确认后才会写入记忆库。</template>
            </p>

            <div class="task-actions">
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

          <div v-if="backfillRunning" class="task-card tabular-nums">
            <div class="task-card-head">
              <span class="task-name">
                <UIcon :name="icons.database" class="task-icon" aria-hidden="true" />
                <span>向量索引补齐</span>
              </span>
              <span v-if="embeddingBackfill && embeddingBackfill.total > 0" class="task-count">
                {{ embeddingBackfill.processed }} / {{ embeddingBackfill.total }} 条
              </span>
              <span v-else class="task-count">准备中…</span>
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

            <p class="task-meta">
              <template v-if="embeddingBackfill?.model">
                模型：{{ embeddingBackfill.model }}
              </template>
              <template v-else>正在为缺失向量的记忆建立检索索引。</template>
            </p>

            <div class="task-actions">
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
      </div>
    </template>
  </UPopover>
</template>

<style scoped>
.task-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-bright);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--ui-text-highlighted);
  white-space: nowrap;
  cursor: pointer;
}
.task-pill:hover {
  background: var(--ui-bg-elevated);
}
.task-pill-label {
  max-width: 11rem;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-spin-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-highlighted);
  animation: kioku-spin 1.1s linear infinite;
}
.task-caret {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-muted);
}
.task-popover {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(22rem, calc(100vw - 2rem));
  padding: 12px 14px;
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
.popover-sub {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.task-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.task-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.task-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
.task-name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.task-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.task-count {
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
.task-meta {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.task-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 2px;
}
@keyframes kioku-spin {
  to {
    transform: rotate(360deg);
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
  .task-spin-icon,
  .progress-indeterminate {
    animation: none;
  }
}
@media (max-width: 639.98px) {
  .task-pill-label {
    max-width: 6.5rem;
  }
}
</style>
