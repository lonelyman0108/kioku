<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { formatTime } from '../time'

const props = defineProps<{ spaceId: string; editable: boolean }>()

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = computed(() => ['extraction-budget', props.spaceId])
const usage = useQuery({ queryKey, queryFn: () => api.extractionBudget(props.spaceId) })

const form = reactive<{ monthlyTokens?: number; dailyWritesPerSubject?: number }>({})
watch(
  () => usage.data.value,
  (u) => {
    if (!u) return
    form.monthlyTokens = u.monthlyTokens
    form.dailyWritesPerSubject = u.dailyWritesPerSubject
  },
  { immediate: true },
)
const dirty = computed(
  () =>
    !!usage.data.value &&
    (form.monthlyTokens !== usage.data.value.monthlyTokens ||
      form.dailyWritesPerSubject !== usage.data.value.dailyWritesPerSubject),
)
const percent = computed(() => {
  const u = usage.data.value
  if (!u) return null
  return u.monthlyTokens ? Math.min(100, Math.round((u.usedTokens / u.monthlyTokens) * 100)) : 100
})

const saving = ref(false)
async function save() {
  if (form.monthlyTokens === undefined || form.dailyWritesPerSubject === undefined) return
  saving.value = true
  try {
    await api.saveExtractionBudget(props.spaceId, {
      monthlyTokens: form.monthlyTokens,
      dailyWritesPerSubject: form.dailyWritesPerSubject,
    })
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
        从群聊与私聊里抽取事实花的
        token。用到八成时概览会提醒；用完之后只写会话摘要、不再抽取事实，下个月恢复（按 UTC
        的自然月算）。每个对象每天最多写这么多条事实，防止被人刷。
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
        <UProgress
          v-if="percent !== null"
          :model-value="percent"
          :color="percent >= 100 ? 'error' : percent >= 80 ? 'warning' : 'primary'"
        />
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
