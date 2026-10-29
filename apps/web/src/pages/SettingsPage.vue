<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import BackupSettings from '../components/BackupSettings.vue'
import EmbeddingSettings from '../components/EmbeddingSettings.vue'
import ExtractionSettings from '../components/ExtractionSettings.vue'
import SpaceImport from '../components/SpaceImport.vue'

const toast = useToast()
const queryClient = useQueryClient()

// 主密钥：轮换还没换完时每隔几秒刷新，看得到还剩多少条是旧主密钥包装的；出了错就不再刷新（错误显示出来）
const masterKey = useQuery({
  queryKey: ['settings', 'master-key'],
  queryFn: api.masterKeyStatus,
  refetchInterval: (query) => {
    const data = query.state.data
    const left = data
      ? data.remaining.memories + data.remaining.credentials + data.remaining.settings
      : 0
    return left > 0 && !data?.lastError ? 5_000 : false
  },
})
const remaining = computed(() => {
  const r = masterKey.data.value?.remaining
  return r ? r.memories + r.credentials + r.settings : 0
})

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
            <h2 class="font-medium">主密钥</h2>
            <p class="mt-1 text-sm text-muted">
              加密 secret 记忆、托管的凭据值与这里的接口 Key，配在服务器的 KIOKU_MASTER_KEY
              里。标识是哈希，推不出密钥本身，用来核对配的是哪一把。
            </p>
          </template>
          <UAlert
            v-if="masterKey.isError.value"
            color="error"
            variant="subtle"
            :title="
              masterKey.error.value instanceof ApiError ? masterKey.error.value.message : '读取失败'
            "
          />
          <div v-else-if="masterKey.data.value" class="space-y-2 text-sm">
            <p v-if="!masterKey.data.value.configured" class="text-muted">
              没有配置主密钥：secret 记忆、托管的凭据与接口 Key 都不能保存。
            </p>
            <template v-else>
              <p>
                标识 <span class="font-mono">{{ masterKey.data.value.currentId }}</span>
              </p>
              <template v-if="masterKey.data.value.previousId">
                <p>
                  正在轮换：旧主密钥
                  <span class="font-mono">{{ masterKey.data.value.previousId }}</span> 包装的还剩
                  {{ remaining }} 条（secret 记忆
                  {{ masterKey.data.value.remaining.memories }}、托管的凭据
                  {{ masterKey.data.value.remaining.credentials }}、接口 Key
                  {{ masterKey.data.value.remaining.settings }}）
                </p>
                <UAlert
                  v-if="masterKey.data.value.lastError"
                  color="error"
                  variant="subtle"
                  :title="masterKey.data.value.lastError.message"
                />
                <p v-if="remaining === 0" class="text-success">
                  已经换完：可以从配置里去掉 KIOKU_MASTER_KEY_PREVIOUS，再重启服务。
                </p>
              </template>
            </template>
          </div>
        </UCard>

        <BackupSettings />

        <SpaceImport />

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
