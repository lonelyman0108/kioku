<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import EmbeddingSettings from '../components/EmbeddingSettings.vue'
import ExtractionSettings from '../components/ExtractionSettings.vue'

const toast = useToast()
const queryClient = useQueryClient()

// 召回事件明细的保留天数：更早的明细在下一次清理时并入每条记忆的累计次数后删除
const recallSettings = useQuery({ queryKey: ['settings', 'recall'], queryFn: api.recallSettings })
const retentionDays = ref<number | undefined>()
watch(
  () => recallSettings.data.value?.retentionDays,
  (days) => (retentionDays.value = days),
  { immediate: true },
)
const savingRetention = ref(false)
async function saveRetention() {
  const days = retentionDays.value
  if (savingRetention.value || !days) return
  savingRetention.value = true
  try {
    await api.saveRecallSettings({ retentionDays: days })
    // 召回分析与概览的「从没被召回」都按保留天数算
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['settings', 'recall'] }),
      queryClient.invalidateQueries({ queryKey: ['recall-stats'] }),
      queryClient.invalidateQueries({ queryKey: ['overview'] }),
    ])
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    savingRetention.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="实例设置" />
    </template>
    <template #body>
      <!-- 面板内容区是固定高度的竖向 flex 容器：卡片直接放进去会在内容超出时被压扁，所以包一层 -->
      <div class="max-w-2xl space-y-6">
        <EmbeddingSettings />

        <ExtractionSettings />

        <UCard>
          <template #header>
            <h2 class="font-medium">召回事件</h2>
            <p class="mt-1 text-sm text-muted">
              每次召回的明细（命中的记忆、分数、打过码的提示语）保留这么多天，更早的只留下每条记忆被召回的累计次数。
            </p>
          </template>
          <UAlert
            v-if="recallSettings.isError.value && !recallSettings.data.value"
            color="error"
            variant="subtle"
            :title="
              recallSettings.error.value instanceof ApiError
                ? recallSettings.error.value.message
                : '读取失败'
            "
          />
          <form v-else class="flex flex-wrap items-end gap-2" @submit.prevent="saveRetention">
            <UFormField label="明细保留天数" help="1 到 365 天">
              <UInputNumber v-model="retentionDays" :min="1" :max="365" class="w-32" />
            </UFormField>
            <UButton
              type="submit"
              :loading="savingRetention"
              :disabled="
                !retentionDays || retentionDays === recallSettings.data.value?.retentionDays
              "
              >保存</UButton
            >
          </form>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
