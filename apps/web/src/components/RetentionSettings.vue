<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { RetentionView } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { attemptNote, pauseText, retentionSummary } from '../retention'
import { formatRelative, formatTime } from '../time'

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = ['settings', 'retention']

// 点了「现在开始清理」之后每隔几秒刷新，等这一次清理的结果出来。清理队列同时只跑一个，正有一次在跑时要等它做完
// （最长约半小时），所以只等两分钟，之后不再转圈、提示稍后再看。
// 轮询间隔用计算属性：写成函数时，查询空闲着才开始等，不会触发轮询
const waiting = ref(false)
const settings = useQuery({
  queryKey,
  queryFn: api.retentionSettings,
  refetchInterval: computed(() => (waiting.value ? 3_000 : false)),
})
const view = computed(() => settings.data.value)

// 清理的结果（做完了、没做完、出了错）有没有变
const outcomeOf = (v: RetentionView | undefined) => JSON.stringify(v?.status ?? null)
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

const pause = computed(() =>
  view.value?.pause ? pauseText(view.value.pause, view.value.days) : null,
)

// 确认框的话在打开时记下一份；开着的时候暂停没了（到期了，或者别人已经提前开始），就关掉并说明
const confirmingResume = ref(false)
const confirmText = ref('')
function askResume() {
  if (!pause.value) return
  confirmText.value = pause.value.confirm
  confirmingResume.value = true
}
watch(pause, (now) => {
  if (now || !confirmingResume.value || resuming.value) return
  confirmingResume.value = false
  toast.add({ title: '暂停已经结束，不用再提前开始', color: 'info' })
})

const resuming = ref(false)
async function resume() {
  if (resuming.value) return
  resuming.value = true
  try {
    const { queued, ...next } = await api.resumeRetention()
    queryClient.setQueryData(queryKey, next)
    confirmingResume.value = false
    // 排上了才等这一次的结果；没排上时下一次定时清理（每小时）照样会做，不用转圈
    if (queued) {
      seen = outcomeOf(next)
      waiting.value = true
      clearTimeout(giveUp)
      giveUp = setTimeout(() => {
        if (!waiting.value) return
        stopWaiting()
        toast.add({ title: '清理在后台进行，稍后再看', color: 'info' })
      }, 2 * 60_000)
      toast.add({
        title: '已排进清理队列',
        description: '正有一次在跑时会等它结束再开始',
        color: 'success',
      })
    } else {
      toast.add({ title: '已结束暂停，下一次定时清理时开始', color: 'info' })
    }
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
const attempt = computed(() => attemptNote(view.value?.status.lastAttempt ?? null))
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
      <div v-if="pause" class="space-y-2">
        <UAlert
          color="warning"
          variant="subtle"
          :icon="icons.expired"
          :title="pause.title"
          :description="pause.description"
        />
        <UButton color="neutral" variant="subtle" :loading="resuming" @click="askResume">
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
        <p v-if="attempt" class="text-warning">{{ attempt }}</p>
        <template v-if="view.status.lastRun">
          <p>
            最近一次清理：{{ formatTime(view.status.lastRun.at) }}（{{
              formatRelative(view.status.lastRun.at)
            }}），{{
              view.status.lastRun.paused
                ? '暂停中，只清了删账号留下的历史'
                : `按 ${view.status.lastRun.days} 天算`
            }}
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
        <p v-else-if="!view.status.lastAttempt" class="text-muted">
          还没有清理过：每天一次，跟在每小时的定时清理后面做。
        </p>
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
      <p class="text-sm">{{ confirmText }}</p>
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
