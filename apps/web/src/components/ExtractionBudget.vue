<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { formatTime } from '../time'

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

const saving = ref(false)
async function save() {
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
  <UCard class="max-w-2xl shrink-0">
    <template #header>
      <h2 class="font-medium">抽取预算</h2>
      <p class="mt-1 text-sm text-muted">
        从群聊与私聊里抽取事实、Dream 整理记忆花的
        token，两者共用。用到八成时概览会提醒；用完之后只写会话摘要、不再抽取事实，Dream
        也不再整理，下个月恢复（按 UTC 的自然月算）。每个对象每天最多写这么多条事实，防止被人刷。
      </p>
    </template>
    <UAlert
      v-if="usage.isError.value && !usage.data.value"
      color="error"
      variant="subtle"
      :title="usage.error.value instanceof ApiError ? usage.error.value.message : '读取失败'"
    />
    <USkeleton v-else-if="!usage.data.value" class="h-24 w-full" />
    <div v-else class="space-y-4">
      <div class="space-y-2">
        <p class="text-sm">
          本月已用
          <span class="font-semibold tabular-nums">{{
            usage.data.value.usedTokens.toLocaleString()
          }}</span>
          / {{ usage.data.value.monthlyTokens.toLocaleString() }} token
          <span class="text-xs text-muted"
            >（从 {{ formatTime(usage.data.value.periodStart) }} 起）</span
          >
        </p>
        <UProgress v-if="progress" :model-value="progress.percent" :color="progress.color" />
      </div>
      <form v-if="editable" class="flex flex-wrap items-end gap-3" @submit.prevent="save">
        <UFormField label="每月 token 上限">
          <UInputNumber
            v-model="form.monthlyTokens"
            :min="0"
            :max="1_000_000_000"
            :step="100_000"
            class="w-44"
          />
        </UFormField>
        <UFormField label="每个对象每天最多写几条">
          <UInputNumber v-model="form.dailyWritesPerSubject" :min="0" :max="1000" class="w-32" />
        </UFormField>
        <UButton type="submit" :icon="icons.save" :loading="saving" :disabled="!dirty">
          保存
        </UButton>
      </form>
      <p v-else class="text-sm text-muted">
        每个对象每天最多写 {{ usage.data.value.dailyWritesPerSubject }} 条事实。只有空间 owner
        能改预算。
      </p>
    </div>
  </UCard>
</template>
