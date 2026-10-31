<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import BackupSettings from '../components/BackupSettings.vue'
import EmbeddingSettings from '../components/EmbeddingSettings.vue'
import ExtractionSettings from '../components/ExtractionSettings.vue'
import Hint from '../components/Hint.vue'
import RetentionSettings from '../components/RetentionSettings.vue'
import SpaceImport from '../components/SpaceImport.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import PropertyList from '../components/strata/PropertyList.vue'
import SettingsBlock from '../components/strata/SettingsBlock.vue'
import SettingsFrame from '../components/strata/SettingsFrame.vue'
import { INSTANCE_SECTIONS } from '../settingsSections'

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

// 哪些小节有未保存的改动：切走之后表单看不见了，子导航上标出来
const dirty = reactive({ embedding: false, extraction: false, backup: false, retention: false })
const recallDirty = computed(
  () =>
    Boolean(recallSettings.data.value) &&
    retentionDays.value !== recallSettings.data.value?.retentionDays,
)
const unsaved = computed(() => [
  ...Object.entries(dirty).flatMap(([key, changed]) => (changed ? [key] : [])),
  ...(recallDirty.value ? ['recall'] : []),
])
</script>

<template>
  <SettingsFrame title="实例设置" :sections="INSTANCE_SECTIONS" :unsaved="unsaved">
    <template #embedding>
      <EmbeddingSettings v-model:dirty="dirty.embedding" />
    </template>

    <template #extraction>
      <ExtractionSettings v-model:dirty="dirty.extraction" />
    </template>

    <template #master-key>
      <SettingsBlock title="主密钥">
        <template #note>
          用于加密机密记忆、托管的凭据值与接口 Key。
          <Hint>
            在服务器的 KIOKU_MASTER_KEY
            中配置。标识是哈希值，无法反推密钥，用于核对当前配置的主密钥。
          </Hint>
        </template>
        <!-- 后台刷新失败时读到过的状态留着，错误放在上面 -->
        <NoteLine v-if="masterKey.isError.value" tone="error">
          {{ readFailure(masterKey.error.value) }}
        </NoteLine>
        <div v-if="masterKey.data.value" class="space-y-3">
          <p v-if="!masterKey.data.value.configured" class="text-muted">
            未配置主密钥，无法保存机密记忆、托管的凭据与接口 Key。
          </p>
          <template v-else>
            <PropertyList :groups="[[{ key: 'current', label: '标识' }]]">
              <template #current>
                <span class="font-mono text-[13px]">{{ masterKey.data.value.currentId }}</span>
              </template>
            </PropertyList>
            <template v-if="masterKey.data.value.previousId">
              <p>
                正在轮换：旧主密钥
                <span class="font-mono text-[13px]">{{ masterKey.data.value.previousId }}</span>
                还有 {{ remaining }} 条待重新包装（机密记忆
                {{ masterKey.data.value.remaining.memories }}、托管的凭据
                {{ masterKey.data.value.remaining.credentials }}、接口 Key
                {{ masterKey.data.value.remaining.settings }}）
              </p>
              <NoteLine v-if="masterKey.data.value.lastError" tone="error">
                {{ masterKey.data.value.lastError.message }}
              </NoteLine>
              <p v-if="remaining === 0" class="text-success">
                轮换完成。可以从配置中移除 KIOKU_MASTER_KEY_PREVIOUS，然后重启服务。
              </p>
            </template>
          </template>
        </div>
      </SettingsBlock>
    </template>

    <template #backup>
      <BackupSettings v-model:dirty="dirty.backup" />
    </template>

    <template #import>
      <SpaceImport />
    </template>

    <template #retention>
      <RetentionSettings v-model:dirty="dirty.retention" />
    </template>

    <template #recall>
      <SettingsBlock title="召回记录">
        <template #note>
          明细到期后删除，仅保留每条记忆的累计召回次数。
          <Hint>明细包括命中的记忆、分数与打码后的提示语。</Hint>
        </template>
        <NoteLine v-if="recallSettings.isError.value" tone="error">
          {{ readFailure(recallSettings.error.value) }}
          <template #actions>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :loading="recallSettings.isFetching.value"
              @click="recallSettings.refetch()"
              >重试</UButton
            >
          </template>
        </NoteLine>
        <USkeleton v-if="recallSettings.isPending.value" class="h-16 w-full" />
        <form
          v-else-if="recallSettings.data.value"
          class="space-y-3"
          @submit.prevent="saveRetention"
        >
          <UFormField label="明细保留天数" help="1 到 365 天">
            <UInputNumber v-model="retentionDays" :min="1" :max="365" class="w-32" />
          </UFormField>
          <UButton
            type="submit"
            color="primary"
            variant="outline"
            :loading="savingRetention"
            :disabled="!retentionDays || retentionDays === recallSettings.data.value?.retentionDays"
            >保存</UButton
          >
        </form>
      </SettingsBlock>
    </template>
  </SettingsFrame>
</template>
