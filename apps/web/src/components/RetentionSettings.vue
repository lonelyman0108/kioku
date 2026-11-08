<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { RetentionView } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { attemptNote, pauseText, retentionSummary, retentionTotal } from '../retention'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsTable from './strata/SettingsTable.vue'
import { fieldProblems, useSavedField } from '../composables/useSavedField'

// 两种保留天数一张表：已删除的记忆（保留期，每天清理）与召回明细（每小时清理）。两项共用一个保存条，
// 保存时只调改了的那项的接口。有没有没保存的修改交给页面在左栏标出来
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = ['settings', 'retention']
const recallKey = ['settings', 'recall']

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
// 召回事件明细的保留天数：更早的明细在下一次清理时并入每条记忆的累计次数后删除
const recallSettings = useQuery({ queryKey: recallKey, queryFn: api.recallSettings })

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

// 两项各和载入时的基准比；服务端的值在后台变了而本地没改时跟上，本地改过时不动（useSavedField）
const days = useSavedField(() => view.value?.days, { min: 1, max: 3650 })
const recallDays = useSavedField(() => recallSettings.data.value?.retentionDays, {
  min: 1,
  max: 365,
})
const changedCount = computed(() => Number(days.changed.value) + Number(recallDays.changed.value))
watch(
  () => changedCount.value > 0,
  (changed) => (dirtyModel.value = changed),
  { immediate: true },
)
// 有一项填得不对时不保存：保存条写出是哪一项、怎么不对，那一行写出范围
const problem = computed(() =>
  fieldProblems([
    { label: '已删除的记忆', issue: days.issue.value },
    { label: '召回明细', issue: recallDays.issue.value },
  ]),
)
// 改短了：下一次清理就按新的天数删。和改动、保存一样拿基准比
const shortened = computed(() => {
  const next = days.value.value
  const base = days.baseline.value
  return typeof next === 'number' && base !== undefined && next < base
})

function discard() {
  days.reset()
  recallDays.reset()
}

const saving = ref(false)
async function save() {
  if (saving.value || changedCount.value === 0 || problem.value) return
  const retention = days.changed.value ? days.value.value : null
  const recall = recallDays.changed.value ? recallDays.value.value : null
  saving.value = true
  const results = await Promise.allSettled([
    typeof retention === 'number'
      ? api.saveRetentionDays({ days: retention }).then((saved) => {
          days.commit(retention, saved.days)
          queryClient.setQueryData(queryKey, saved)
        })
      : null,
    typeof recall === 'number'
      ? api.saveRecallSettings({ retentionDays: recall }).then(async (saved) => {
          recallDays.commit(recall, saved.retentionDays)
          queryClient.setQueryData(recallKey, saved)
          // 召回分析与概览的「从未被召回」都按召回明细的保留天数算
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['recall-stats'] }),
            queryClient.invalidateQueries({ queryKey: ['overview'] }),
          ])
        })
      : null,
  ])
  saving.value = false
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) {
    const err: unknown = failed.reason
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } else {
    toast.add({ title: '已保存', color: 'success' })
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

const lastRun = computed(() => view.value?.status.lastRun ?? null)
const removed = computed(() => (lastRun.value ? retentionSummary(lastRun.value.counts) : []))
const attempt = computed(() => attemptNote(view.value?.status.lastAttempt ?? null))
</script>

<template>
  <SettingsBlock title="保留期" wide>
    <template #note>
      超过保留期的内容将被永久删除，之后只能从备份恢复。
      <Hint>
        <p>
          已删除的记忆连同历史、向量与召回统计一起删除。同样按这个天数清理的还有：已被取代的事实、过期的会话摘要，以及抽取记录、凭据事件、已删除的凭据，以及断开后不再有凭据指向的密码库连接。
        </p>
        <p class="mt-1">
          每天清理一次。保留期内已删除的记忆与凭据可以恢复。召回明细到期后删除，仅保留每条记忆的累计召回次数；明细包括命中的记忆、分数与打码后的提示语。
        </p>
      </Hint>
    </template>
    <!-- 标题和后果说明一直在；后台刷新失败时读到过的设置留着，错误放在上面 -->
    <ReadFailureNote v-if="settings.isError.value" :query="settings" />
    <ReadFailureNote v-if="recallSettings.isError.value" :query="recallSettings" />
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
    <NoteLine v-if="view?.status.lastError" tone="error">
      {{ view.status.lastError.message }}
      <template #detail>
        {{ formatTime(view.status.lastError.at) }}（{{ formatRelative(view.status.lastError.at) }}）
      </template>
    </NoteLine>
    <p v-if="attempt" class="pb-3 text-warning">{{ attempt }}</p>
    <USkeleton
      v-if="settings.isPending.value || recallSettings.isPending.value"
      class="h-24 w-full"
    />
    <form v-else-if="view || recallSettings.data.value" @submit.prevent="save">
      <SettingsTable>
        <thead>
          <tr>
            <th>数据</th>
            <th>保留</th>
            <th>到期后</th>
            <th>最近一次清理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="view">
            <td>已删除的记忆</td>
            <td>
              <span class="days">
                <UInputNumber
                  v-model="days.value.value"
                  :min="1"
                  :max="3650"
                  size="sm"
                  class="w-28"
                  aria-label="已删除的记忆的保留天数"
                />
                <span class="unit">天</span>
              </span>
              <p v-if="days.invalid.value" class="invalid">请填写 1 到 3650 之间的整数。</p>
            </td>
            <td>永久删除，只能从备份恢复</td>
            <td>
              <template v-if="lastRun">
                <span :title="formatTime(lastRun.at)">{{ formatRelative(lastRun.at) }}</span>
                <span class="unit">
                  {{
                    lastRun.paused
                      ? '暂停中，仅清理已删除账号留下的历史'
                      : `删除 ${retentionTotal(lastRun.counts)} 条`
                  }}
                </span>
                <Hint v-if="removed.length">
                  <ul>
                    <li v-for="item in removed" :key="item.label">
                      {{ item.label }} {{ item.count }} 条
                    </li>
                  </ul>
                </Hint>
              </template>
              <span v-else-if="waiting" class="text-muted">正在清理…</span>
              <span v-else-if="!view.status.lastAttempt" class="text-muted">尚未清理</span>
            </td>
          </tr>
          <tr v-if="recallSettings.data.value">
            <td>召回明细</td>
            <td>
              <span class="days">
                <UInputNumber
                  v-model="recallDays.value.value"
                  :min="1"
                  :max="365"
                  size="sm"
                  class="w-28"
                  aria-label="召回明细的保留天数"
                />
                <span class="unit">天</span>
              </span>
              <p v-if="recallDays.invalid.value" class="invalid">请填写 1 到 365 之间的整数。</p>
            </td>
            <td>并入每条记忆的累计召回次数</td>
            <td class="text-muted">每小时清理一次</td>
          </tr>
        </tbody>
      </SettingsTable>
      <p class="pt-2 text-xs text-muted">
        已删除的记忆 1 到 3650 天，召回明细 1 到 365 天，默认都是 30 天。
      </p>
      <p v-if="shortened" class="pt-2 text-warning">
        缩短后，下一次清理将按新的天数永久删除，不可撤销。
      </p>
      <SaveBar :count="changedCount" :saving="saving" :problem="problem" @discard="discard" />
    </form>
  </SettingsBlock>

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

<style scoped>
.days {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.unit {
  margin-left: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.invalid {
  padding-top: 2px;
  font-size: 12px;
  color: var(--ui-error);
}
.days .unit {
  margin-left: 0;
}
</style>
