<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { formatTime } from '../time'
import Hint from './Hint.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsRow from './strata/SettingsRow.vue'

const props = defineProps<{ spaceId: string; editable: boolean }>()
// 有没有没保存的修改：交给页面统一做离开前的确认
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = computed(() => ['extraction-budget', props.spaceId])
const usage = useQuery({ queryKey, queryFn: () => api.extractionBudget(props.spaceId) })

// 表单从哪一版预算载入；用量隔一会儿就刷新，只有预算本身变了、而且没有改动时才跟上，免得冲掉没保存的输入
const form = reactive<{ monthlyTokens?: number; dailyWritesPerSubject?: number }>({})
const baseline = ref<{ monthlyTokens: number; dailyWritesPerSubject: number } | null>(null)
const dirty = computed(
  () =>
    baseline.value !== null &&
    (form.monthlyTokens !== baseline.value.monthlyTokens ||
      form.dailyWritesPerSubject !== baseline.value.dailyWritesPerSubject),
)
watch(
  () => usage.data.value,
  (u) => {
    if (!u || dirty.value) return
    baseline.value = {
      monthlyTokens: u.monthlyTokens,
      dailyWritesPerSubject: u.dailyWritesPerSubject,
    }
    form.monthlyTokens = u.monthlyTokens
    form.dailyWritesPerSubject = u.dailyWritesPerSubject
  },
  { immediate: true },
)
watch(dirty, (d) => (dirtyModel.value = d), { immediate: true })
// 向下取整：差一点用完时不显示成 100%；颜色看是不是真的用完了，和服务端换成只写摘要的条件一致
const progress = computed(() => {
  const u = usage.data.value
  if (!u) return null
  const over = u.usedTokens >= u.monthlyTokens
  return {
    percent: over ? 100 : Math.floor((u.usedTokens / u.monthlyTokens) * 100),
    color: over ? 'error' : u.usedTokens >= u.monthlyTokens * 0.8 ? 'warning' : 'primary',
  } as const
})

// 改了几项：保存条上写
const changedCount = computed(() =>
  baseline.value
    ? Number(form.monthlyTokens !== baseline.value.monthlyTokens) +
      Number(form.dailyWritesPerSubject !== baseline.value.dailyWritesPerSubject)
    : 0,
)
function discard() {
  if (!baseline.value) return
  form.monthlyTokens = baseline.value.monthlyTokens
  form.dailyWritesPerSubject = baseline.value.dailyWritesPerSubject
}

const saving = ref(false)
async function save() {
  if (saving.value) return
  if (form.monthlyTokens === undefined || form.dailyWritesPerSubject === undefined) return
  saving.value = true
  try {
    const saved = await api.saveExtractionBudget(props.spaceId, {
      monthlyTokens: form.monthlyTokens,
      dailyWritesPerSubject: form.dailyWritesPerSubject,
    })
    baseline.value = {
      monthlyTokens: saved.monthlyTokens,
      dailyWritesPerSubject: saved.dailyWritesPerSubject,
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKey.value }),
      queryClient.invalidateQueries({ queryKey: ['overview', props.spaceId] }),
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
  <SettingsBlock title="抽取预算">
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
          <p>
            <span class="font-semibold tabular-nums">{{
              usage.data.value.usedTokens.toLocaleString()
            }}</span>
            <span class="text-xs text-muted">
              / {{ usage.data.value.monthlyTokens.toLocaleString() }} token</span
            >
          </p>
          <UProgress v-if="progress" :model-value="progress.percent" :color="progress.color" />
        </div>
      </SettingsRow>
      <form v-if="editable" @submit.prevent="save">
        <SettingsRow label="每月 token 上限" description="抽取与整理合计" for="budget-monthly">
          <UInputNumber
            id="budget-monthly"
            v-model="form.monthlyTokens"
            :min="0"
            :max="1_000_000_000"
            :step="100_000"
            class="w-44"
          />
          <span class="text-xs text-muted">token</span>
        </SettingsRow>
        <SettingsRow
          label="每个联系人每日写入上限"
          description="超出后当天不再写入这个联系人的事实"
          for="budget-daily"
        >
          <UInputNumber
            id="budget-daily"
            v-model="form.dailyWritesPerSubject"
            :min="0"
            :max="1000"
            class="w-32"
          />
          <span class="text-xs text-muted">条</span>
        </SettingsRow>
        <SaveBar :count="changedCount" :saving="saving" @discard="discard" />
      </form>
      <template v-else>
        <SettingsRow label="每个联系人每日写入上限">
          {{ usage.data.value.dailyWritesPerSubject }} 条
        </SettingsRow>
        <p class="pt-3 text-muted">仅空间所有者可修改预算。</p>
      </template>
    </div>
  </SettingsBlock>
</template>
