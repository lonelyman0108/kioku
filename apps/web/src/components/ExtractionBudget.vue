<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { fieldProblems, useSavedField } from '../composables/useSavedField'
import { formatTime } from '../time'
import Hint from './Hint.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar, { type SaveBarChange } from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsRow from './strata/SettingsRow.vue'

const props = defineProps<{ circleId: string; editable: boolean }>()
// 有没有没保存的修改：交给页面统一做离开前的确认
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = computed(() => ['extraction-budget', props.circleId] as const)
const usage = useQuery({
  queryKey,
  enabled: computed(() => Boolean(props.circleId)),
  queryFn: ({ queryKey: [, cid] }) => api.extractionBudget(cid),
})

// 两项各和服务端最新的预算比（useSavedField）：用量隔一会儿就刷新，预算本身变了时基准跟上，本地改过的输入留着
const monthly = useSavedField(() => usage.data.value?.monthlyTokens, {
  min: 0,
  max: 1_000_000_000,
})
const daily = useSavedField(() => usage.data.value?.dailyWritesPerSubject, { min: 0, max: 1000 })
// 改了几项：保存条上写，有改动就报给页面
const changedCount = computed(() => Number(monthly.changed.value) + Number(daily.changed.value))
const dirty = computed(() => changedCount.value > 0)
// 有一项填得不对时不保存：保存条写出是哪一项、怎么不对，那一行写出范围
const problem = computed(() =>
  fieldProblems([
    { label: '每月 token 上限', issue: monthly.issue.value },
    { label: '每日写入上限', issue: daily.issue.value },
  ]),
)
watch(dirty, (d) => (dirtyModel.value = d), { immediate: true })
// 向下取整：差一点用完时不显示成 100%；颜色看是不是真的用完了，和服务端换成只写摘要的条件一致
const progress = computed(() => {
  const u = usage.data.value
  if (!u) return null
  const over = u.usedTokens >= u.monthlyTokens
  const remaining = Math.max(u.monthlyTokens - u.usedTokens, 0)
  return {
    percent: over ? 100 : Math.floor((u.usedTokens / Math.max(u.monthlyTokens, 1)) * 100),
    remaining,
    color: over ? 'error' : u.usedTokens >= u.monthlyTokens * 0.8 ? 'warning' : 'primary',
  } as const
})

const budgetChanges = computed<SaveBarChange[]>(() => {
  const u = usage.data.value
  if (!u) return []
  const list: SaveBarChange[] = []
  if (monthly.changed.value) {
    const next = monthly.value.value
    list.push({
      label: '每月 token 上限',
      before: `${u.monthlyTokens.toLocaleString('en-US')} token`,
      after: next == null ? '—' : `${next.toLocaleString('en-US')} token`,
    })
  }
  if (daily.changed.value) {
    const next = daily.value.value
    list.push({
      label: '每日写入上限',
      before: `${u.dailyWritesPerSubject} 条`,
      after: next == null ? '—' : `${next} 条`,
    })
  }
  return list
})

function discard() {
  monthly.reset()
  daily.reset()
}

const saving = ref(false)
async function save() {
  if (saving.value || changedCount.value === 0 || problem.value) return
  const cid = props.circleId
  const monthlyTokens = monthly.value.value
  const dailyWritesPerSubject = daily.value.value
  if (typeof monthlyTokens !== 'number' || typeof dailyWritesPerSubject !== 'number') return
  saving.value = true
  try {
    const saved = await api.saveExtractionBudget(cid, {
      monthlyTokens,
      dailyWritesPerSubject,
    })
    if (cid === props.circleId) {
      monthly.commit(monthlyTokens, saved.monthlyTokens)
      daily.commit(dailyWritesPerSubject, saved.dailyWritesPerSubject)
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['extraction-budget', cid] }),
      queryClient.invalidateQueries({ queryKey: ['overview', cid] }),
    ])
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsBlock
    title="抽取预算"
    :badge="editable ? '记忆圈所有者 · 表单保存' : '仅记忆圈所有者可修改'"
    :tone="editable ? 'form' : 'readonly'"
  >
    <template #note>
      抽取事实与整理共用此 token 预算。
      <Hint>
        用量达到 80% 时在概览提醒。用完后本月仅写会话摘要，不再抽取事实，整理暂停，下月恢复（按 UTC
        自然月计算）。每个联系人每天的事实写入有上限，防止恶意刷写。
      </Hint>
    </template>
    <!-- 后台刷新失败时读到过的用量留着，错误放在上面 -->
    <ReadFailureNote v-if="usage.isError.value" :query="usage" />
    <USkeleton v-if="usage.isPending.value" class="h-24 w-full" />
    <div v-else-if="usage.data.value">
      <SettingsRow
        label="本月用量"
        :description="`从 ${formatTime(usage.data.value.periodStart)} 起`"
      >
        <div class="w-full max-w-sm space-y-1.5">
          <div class="usage-line">
            <p>
              <span class="font-semibold tabular-nums">{{
                usage.data.value.usedTokens.toLocaleString()
              }}</span>
              <span class="text-xs text-muted">
                / {{ usage.data.value.monthlyTokens.toLocaleString() }} token</span
              >
            </p>
            <span v-if="progress" class="usage-pct tabular-nums">
              {{ progress.percent }}% · 剩余 {{ progress.remaining.toLocaleString() }}
            </span>
          </div>
          <UProgress v-if="progress" :model-value="progress.percent" :color="progress.color" />
        </div>
      </SettingsRow>
      <form v-if="editable" @submit.prevent="save">
        <SettingsRow label="每月 token 上限" description="抽取与整理合计" for="budget-monthly">
          <UInputNumber
            id="budget-monthly"
            v-model="monthly.value.value"
            :min="0"
            :max="1_000_000_000"
            :step="100_000"
            class="w-44"
          />
          <span class="text-xs text-muted">token</span>
          <p v-if="monthly.invalid.value" class="w-full text-xs text-error">
            请填写 0 到 1,000,000,000 之间的整数。
          </p>
        </SettingsRow>
        <SettingsRow
          label="每个联系人每日写入上限"
          description="超出后当天不再写入这个联系人的事实"
          for="budget-daily"
        >
          <UInputNumber
            id="budget-daily"
            v-model="daily.value.value"
            :min="0"
            :max="1000"
            class="w-32"
          />
          <span class="text-xs text-muted">条</span>
          <p v-if="daily.invalid.value" class="w-full text-xs text-error">
            请填写 0 到 1000 之间的整数。
          </p>
        </SettingsRow>
        <SaveBar
          :count="changedCount"
          :saving="saving"
          :problem="problem"
          :changes="budgetChanges"
          @discard="discard"
        />
      </form>
      <template v-else>
        <SettingsRow label="每个联系人每日写入上限">
          {{ usage.data.value.dailyWritesPerSubject }} 条
        </SettingsRow>
        <p class="pt-3 text-muted">仅记忆圈所有者可修改预算。</p>
      </template>
    </div>
  </SettingsBlock>
</template>

<style scoped>
.usage-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px 12px;
}
.usage-pct {
  font-size: 12px;
  color: var(--ui-text-muted);
}
</style>
