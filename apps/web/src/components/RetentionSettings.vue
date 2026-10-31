<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { RetentionView } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { attemptNote, pauseText, retentionSummary } from '../retention'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsColumns from './strata/SettingsColumns.vue'

// 有没有没保存的修改：切到别的小节之后表单看不见了，交给页面在子导航上标出来
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = ['settings', 'retention']

// 点了「立即开始清理」之后每隔几秒刷新，等这一次清理的结果出来。清理队列同时只跑一个，正有一次在跑时要等它做完
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
watch(
  () => Boolean(view.value) && days.value !== view.value?.days,
  (changed) => (dirtyModel.value = changed),
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
  toast.add({ title: '暂停已结束，无需提前开始', color: 'info' })
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
        toast.add({ title: '清理正在后台进行，请稍后查看', color: 'info' })
      }, 2 * 60_000)
      toast.add({
        title: '已加入清理队列',
        description: '如有清理正在进行，将等其结束后开始',
        color: 'success',
      })
    } else {
      toast.add({ title: '暂停已结束，将在下一次定时清理时开始', color: 'info' })
    }
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '无法开始清理', color: 'error' })
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
  <SettingsColumns>
    <SettingsBlock title="保留期">
      <template #note>
        超过保留期的内容将被永久删除，之后只能从备份恢复。
        <Hint>
          <p>
            范围：已删除的记忆（连同历史、向量与召回统计）、已被取代的事实、过期的会话摘要，以及抽取记录、凭据事件、已删除的凭据与凭据源。
          </p>
          <p class="mt-1">
            每天清理一次。保留期内已删除的记忆与凭据可以恢复。此设置与召回明细的保留天数相互独立。
          </p>
        </Hint>
      </template>
      <!-- 标题和后果说明一直在；后台刷新失败时读到过的设置留着，错误放在上面 -->
      <NoteLine v-if="settings.isError.value" tone="error">
        {{ readFailure(settings.error.value) }}
        <template #actions>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :loading="settings.isFetching.value"
            @click="settings.refetch()"
            >重试</UButton
          >
        </template>
      </NoteLine>
      <NoteLine v-if="pause" tone="warning">
        {{ pause.title }}
        <template #detail>
          {{ pause.description }}
          <Hint>{{ pause.detail }}</Hint>
        </template>
        <template #actions>
          <UButton color="neutral" variant="outline" :loading="resuming" @click="askResume">
            立即开始清理
          </UButton>
        </template>
      </NoteLine>
      <USkeleton v-if="settings.isPending.value" class="h-24 w-full" />
      <form v-else-if="view" class="space-y-3" @submit.prevent="save">
        <UFormField label="保留天数" help="1 到 3650 天，默认 30 天">
          <UInputNumber v-model="days" :min="1" :max="3650" class="w-32" />
        </UFormField>
        <p v-if="shortened" class="text-warning">
          缩短后，下一次清理将按新的天数永久删除，不可撤销。
        </p>
        <UButton
          type="submit"
          color="primary"
          variant="outline"
          :loading="saving"
          :disabled="!days || days === view.days"
        >
          保存
        </UButton>
      </form>
    </SettingsBlock>

    <template v-if="view" #side>
      <SettingsBlock title="最近一次清理">
        <NoteLine v-if="view.status.lastError" tone="error">
          {{ view.status.lastError.message }}
          <template #detail>
            {{ formatTime(view.status.lastError.at) }}（{{
              formatRelative(view.status.lastError.at)
            }}）
          </template>
        </NoteLine>
        <p v-if="attempt" class="text-warning">{{ attempt }}</p>
        <template v-if="view.status.lastRun">
          <p>
            {{ formatTime(view.status.lastRun.at) }}（{{
              formatRelative(view.status.lastRun.at)
            }}），{{
              view.status.lastRun.paused
                ? '暂停中，仅清理已删除账号留下的历史'
                : `按 ${view.status.lastRun.days} 天计算`
            }}
          </p>
          <ul v-if="removed.length" class="mt-2 border-t border-default">
            <li
              v-for="item in removed"
              :key="item.label"
              class="flex items-baseline justify-between gap-4 border-b border-default py-1.5"
            >
              <span>{{ item.label }}</span>
              <span class="shrink-0 font-mono text-[13px]">{{ item.count }} 条</span>
            </li>
          </ul>
          <p v-else class="mt-2 text-muted">暂无到期内容</p>
        </template>
        <p v-else-if="waiting" class="text-muted">正在清理…</p>
        <p v-else-if="!view.status.lastAttempt" class="text-muted">
          尚未清理。每天一次，在每小时的定时清理之后执行。
        </p>
      </SettingsBlock>
    </template>
  </SettingsColumns>

  <UModal
    :open="confirmingResume"
    title="立即开始清理？"
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
