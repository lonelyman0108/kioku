<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { EmbeddingTestResult } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'

const toast = useToast()
const queryClient = useQueryClient()
const settings = useQuery({ queryKey: ['settings', 'embedding'], queryFn: api.embeddingSettings })

// apiKey 留空表示沿用已保存的 Key；勾选「清除」时发 null
const form = reactive({ baseUrl: '', model: '', apiKey: '', clearKey: false })
watch(
  () => settings.data.value,
  (s) => {
    if (!s) return
    form.baseUrl = s.baseUrl ?? ''
    form.model = s.model ?? ''
  },
  { immediate: true },
)

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await api.saveEmbeddingSettings({
      baseUrl: form.baseUrl,
      model: form.model,
      ...(form.clearKey ? { apiKey: null } : form.apiKey ? { apiKey: form.apiKey } : {}),
    })
    form.apiKey = ''
    form.clearKey = false
    await queryClient.invalidateQueries({ queryKey: ['settings', 'embedding'] })
    toast.add({ title: '已保存，后台会为全部记忆重新生成向量', color: 'success' })
    startPolling()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

// 补齐向量之后的一段时间里每隔几秒刷新一次覆盖率，看得到进度
const POLL_INTERVAL_MS = 3_000
const POLL_DURATION_MS = 120_000
const polling = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | undefined
const status = useQuery({
  queryKey: ['settings', 'embedding', 'status'],
  queryFn: api.embeddingStatus,
  refetchInterval: computed(() => (polling.value ? POLL_INTERVAL_MS : false)),
})
const coverage = computed(() => {
  const s = status.data.value
  return s && s.eligible ? Math.round((s.embedded / s.eligible) * 100) : null
})
// 全部补齐了就不用再刷新
watch(
  () => status.data.value,
  (s) => {
    if (polling.value && s && s.eligible > 0 && s.embedded >= s.eligible) polling.value = false
  },
)
onBeforeUnmount(() => clearTimeout(pollTimer))
function startPolling() {
  polling.value = true
  clearTimeout(pollTimer)
  pollTimer = setTimeout(() => (polling.value = false), POLL_DURATION_MS)
}

const rebuilding = ref(false)
async function rebuild() {
  rebuilding.value = true
  try {
    await api.rebuildEmbeddings()
    toast.add({ title: '已排进队列，后台会检查全部记忆、补齐缺少或过时的向量', color: 'success' })
    startPolling()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '排队失败', color: 'error' })
  } finally {
    rebuilding.value = false
  }
}

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

const testing = ref(false)
const result = ref<EmbeddingTestResult | null>(null)
async function test() {
  testing.value = true
  try {
    result.value = await api.testEmbedding()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '测试失败', color: 'error' })
  } finally {
    testing.value = false
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
        <UAlert
          v-if="settings.isError.value"
          color="error"
          variant="subtle"
          :title="
            settings.error.value instanceof ApiError ? settings.error.value.message : '读取设置失败'
          "
        />
        <UCard>
          <template #header>
            <h2 class="font-medium">嵌入模型</h2>
            <p class="mt-1 text-sm text-muted">
              OpenAI 兼容的 /embeddings 接口，需要支持 dimensions 参数，向量维度固定为
              {{ settings.data.value?.dimensions ?? 1024 }}。
              整个实例共用一个模型；更换模型后会在后台重新生成全部向量。
            </p>
          </template>
          <form class="space-y-4" @submit.prevent="save">
            <UFormField label="接口地址" help="例如 https://api.example.com/v1">
              <UInput v-model="form.baseUrl" class="w-full font-mono" required />
            </UFormField>
            <UFormField label="模型">
              <UInput v-model="form.model" class="w-full font-mono" required />
            </UFormField>
            <UFormField
              label="API Key"
              :help="
                settings.data.value?.hasApiKey
                  ? '已保存（加密存储）。留空表示不修改；更换了接口主机时必须重新填写'
                  : '用实例主密钥加密后存库'
              "
            >
              <UInput
                v-model="form.apiKey"
                type="password"
                autocomplete="off"
                class="w-full"
                :disabled="form.clearKey"
              />
            </UFormField>
            <UCheckbox
              v-if="settings.data.value?.hasApiKey"
              v-model="form.clearKey"
              label="清除已保存的 Key（新接口不需要 Key）"
            />
            <div class="flex flex-wrap items-center gap-2">
              <UButton type="submit" :icon="icons.save" :loading="saving">保存</UButton>
              <UButton
                :icon="icons.test"
                color="neutral"
                variant="subtle"
                :loading="testing"
                :disabled="!settings.data.value?.configured"
                @click="test"
              >
                测试连通
              </UButton>
              <span
                v-if="result"
                class="text-sm"
                :class="result.ok ? 'text-success' : 'text-error'"
              >
                {{ result.ok ? `正常，耗时 ${result.latencyMs} ms` : result.error }}
              </span>
            </div>
          </form>
        </UCard>

        <UCard>
          <template #header>
            <h2 class="font-medium">向量</h2>
            <p class="mt-1 text-sm text-muted">
              整个实例里应当有向量的记忆（没删除、不是
              secret、有正文）有多少已经生成。新写入的记忆会自动排队；
              换过模型、或嵌入接口出过错之后，可以手动补齐。
            </p>
          </template>
          <UAlert
            v-if="status.isError.value"
            color="error"
            variant="subtle"
            :title="
              status.error.value instanceof ApiError ? status.error.value.message : '读取失败'
            "
          />
          <div v-else-if="status.data.value" class="space-y-3">
            <div class="flex items-baseline gap-2">
              <span class="text-2xl font-semibold tabular-nums">
                {{ status.data.value.embedded }} / {{ status.data.value.eligible }}
              </span>
              <span class="text-sm text-muted">
                {{
                  status.data.value.model ? `模型 ${status.data.value.model}` : '还没有配置嵌入模型'
                }}
              </span>
            </div>
            <UProgress v-if="coverage !== null" :model-value="coverage" />
            <div class="flex flex-wrap items-center gap-2">
              <UButton
                :icon="icons.vector"
                :loading="rebuilding"
                :disabled="!status.data.value.configured"
                @click="rebuild"
              >
                补齐向量
              </UButton>
              <UButton
                :icon="icons.refresh"
                color="neutral"
                variant="ghost"
                :loading="status.isRefetching.value"
                @click="status.refetch()"
              >
                刷新
              </UButton>
              <span v-if="polling" class="text-sm text-muted">正在跟进进度……</span>
            </div>
          </div>
        </UCard>

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
