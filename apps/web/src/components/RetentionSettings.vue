<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { RetentionView } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { retentionSummary } from '../retention'
import { formatRelative, formatTime } from '../time'

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = ['settings', 'retention']

// 点了「现在开始清理」之后每隔几秒刷新，等这一次清理的结果出来（最多等两分钟）。
// 轮询间隔用计算属性：写成函数时，查询空闲着才开始等，不会触发轮询
const waiting = ref(false)
const settings = useQuery({
  queryKey,
  queryFn: api.retentionSettings,
  refetchInterval: computed(() => (waiting.value ? 3_000 : false)),
})
const view = computed(() => settings.data.value)

// 最近一次清理的结果（做完了或者出了错）有没有变
const outcomeOf = (v: RetentionView | undefined) =>
  `${v?.status.lastRun?.at ?? ''}|${v?.status.lastError?.at ?? ''}`
let seen = ''
let giveUp: ReturnType<typeof setTimeout> | undefined
function stopWaiting() {
  waiting.value = false
  clearTimeout(giveUp)
}
onBeforeUnmount(stopWaiting)
watch(view, (v) => {
  if (waiting.value && outcomeOf(v) !== seen) stopWaiting()
})

const days = ref<number | undefined>()
watch(
  () => view.value?.days,
  (saved) => (days.value = saved),
  { immediate: true },
)
// 改短了：下一次清理就按新的天数删
const shortened = computed(() => Boolean(view.value && days.value && days.value < view.value.days))

const saving = ref(false)
async function save() {
  const value = days.value
  if (saving.value || !value) return
  saving.value = true
  try {
    queryClient.setQueryData(queryKey, await api.saveRetentionDays({ days: value }))
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const confirmingResume = ref(false)
const resuming = ref(false)
async function resume() {
  if (resuming.value) return
  resuming.value = true
  try {
    seen = outcomeOf(view.value)
    queryClient.setQueryData(queryKey, await api.resumeRetention())
    confirmingResume.value = false
    waiting.value = true
    clearTimeout(giveUp)
    giveUp = setTimeout(stopWaiting, 2 * 60_000)
    toast.add({ title: '暂停已结束，马上开始清理', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '没能开始清理', color: 'error' })
  } finally {
    resuming.value = false
  }
}

const removed = computed(() => {
  const counts = view.value?.status.lastRun?.counts
  return counts ? retentionSummary(counts) : []
})
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-medium">保留期</h2>
      <p class="mt-1 text-sm text-muted">
        删掉的记忆（连同历史、向量与召回统计）、被新事实推翻的事实、过期的会话摘要，以及抽取记录、凭据事件、已删除的凭据与凭据源，过了保留期就永久删除，每天清理一次。保留期内删掉的记忆与凭据还能撤销删除，更早的只能从备份里找回。和召回事件明细的保留天数是两回事。
      </p>
    </template>
    <UAlert
      v-if="settings.isError.value && !view"
      color="error"
      variant="subtle"
      :title="settings.error.value instanceof ApiError ? settings.error.value.message : '读取失败'"
    />
    <div v-else-if="view" class="space-y-4">
      <div v-if="view.pause" class="space-y-2">
        <UAlert
          color="warning"
          variant="subtle"
          :icon="icons.expired"
          :title="`从备份恢复于 ${formatTime(view.pause.restoredAt)}，清理暂停到 ${formatTime(view.pause.until)}`"
          description="恢复出的已删除记录按删除的时间早就过了保留期，照常清理会马上把它们永久删掉。暂停到恢复的时间加上保留天数（调保留天数时跟着变），要从备份里找回的在这之前撤销删除；之后自动照常清理。"
        />
        <UButton
          color="neutral"
          variant="subtle"
          :loading="resuming"
          @click="confirmingResume = true"
        >
          现在开始清理
        </UButton>
      </div>
      <form class="flex flex-wrap items-end gap-2" @submit.prevent="save">
        <UFormField label="保留天数" help="1 到 3650 天，默认 30 天">
          <UInputNumber v-model="days" :min="1" :max="3650" class="w-32" />
        </UFormField>
        <UButton
          type="submit"
          :icon="icons.save"
          :loading="saving"
          :disabled="!days || days === view.days"
        >
          保存
        </UButton>
      </form>
      <p v-if="shortened" class="text-sm text-warning">
        改短之后，下一次清理就按新的天数永久删除，删掉的不能撤销。
      </p>

      <USeparator />
      <div class="space-y-2 text-sm">
        <UAlert
          v-if="view.status.lastError"
          color="error"
          variant="subtle"
          :title="view.status.lastError.message"
          :description="`${formatTime(view.status.lastError.at)}（${formatRelative(view.status.lastError.at)}）`"
        />
        <template v-if="view.status.lastRun">
          <p>
            最近一次清理：{{ formatTime(view.status.lastRun.at) }}（{{
              formatRelative(view.status.lastRun.at)
            }}），按 {{ view.status.lastRun.days }} 天算
          </p>
          <ul v-if="removed.length" class="divide-y divide-default">
            <li
              v-for="item in removed"
              :key="item.label"
              class="flex items-baseline justify-between gap-4 py-1.5"
            >
              <span>{{ item.label }}</span>
              <span class="shrink-0 tabular-nums">{{ item.count }} 条</span>
            </li>
          </ul>
          <p v-else class="text-muted">没有到期的</p>
        </template>
        <p v-else-if="waiting" class="text-muted">正在清理…</p>
        <p v-else class="text-muted">还没有清理过：每天一次，跟在每小时的定时清理后面做。</p>
      </div>
    </div>
  </UCard>

  <UModal
    :open="confirmingResume"
    title="现在开始清理？"
    :dismissible="!resuming"
    @update:open="(v) => !v && !resuming && (confirmingResume = false)"
  >
    <template #body>
      <p class="text-sm">
        恢复出的已删除记录里，删除超过 {{ view?.days }}
        天的会被永久删除，不能撤销。要从这份备份里找回的，先在记忆页或凭据页撤销删除。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="resuming"
          @click="confirmingResume = false"
          >取消</UButton
        >
        <UButton color="error" :loading="resuming" @click="resume">开始清理</UButton>
      </div>
    </template>
  </UModal>
</template>
