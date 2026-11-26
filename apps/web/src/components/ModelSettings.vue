<script setup lang="ts">
import {
  DEFAULT_DREAM_INTERVAL_HOURS,
  DREAM_INTERVAL_HOURS_MAX,
  DREAM_INTERVAL_HOURS_MIN,
  type ModelKind,
  type ModelsSettingsResponse,
  type TestModelResponse,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { ME_KEY } from '../query'
import NoteLine from './ui/NoteLine.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import SaveBar from './ui/SaveBar.vue'
import SectionHeading from './ui/SectionHeading.vue'

const dirtyModel = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const queryClient = useQueryClient()

const settingsQuery = useQuery({
  queryKey: ['models-settings'] as const,
  queryFn: () => api.modelsSettings(),
})

interface EndpointDraft {
  enabled: boolean
  baseUrl: string
  model: string
  apiKey: string
  clearKey: boolean
  hasApiKey: boolean
}

const form = reactive<{
  embedding: EndpointDraft
  chatLlm: EndpointDraft
  dreamEnabled: boolean
  dreamIntervalHours: number
}>({
  embedding: {
    enabled: false,
    baseUrl: '',
    model: '',
    apiKey: '',
    clearKey: false,
    hasApiKey: false,
  },
  chatLlm: {
    enabled: false,
    baseUrl: '',
    model: '',
    apiKey: '',
    clearKey: false,
    hasApiKey: false,
  },
  dreamEnabled: true,
  dreamIntervalHours: DEFAULT_DREAM_INTERVAL_HOURS,
})

function syncFromSaved(data: ModelsSettingsResponse) {
  form.embedding = {
    enabled: data.embedding?.enabled ?? false,
    baseUrl: data.embedding?.baseUrl ?? '',
    model: data.embedding?.model ?? '',
    apiKey: '',
    clearKey: false,
    hasApiKey: data.embedding?.hasApiKey ?? false,
  }
  form.chatLlm = {
    enabled: data.chatLlm?.enabled ?? false,
    baseUrl: data.chatLlm?.baseUrl ?? '',
    model: data.chatLlm?.model ?? '',
    apiKey: '',
    clearKey: false,
    hasApiKey: data.chatLlm?.hasApiKey ?? false,
  }
  form.dreamEnabled = data.dream.enabled
  form.dreamIntervalHours = data.dream.intervalHours
}

watch(
  () => settingsQuery.data.value,
  (data) => {
    if (data && !dirtyModel.value) syncFromSaved(data)
  },
  { immediate: true },
)

const hasMasterKey = computed(() => settingsQuery.data.value?.hasMasterKey ?? true)
const coverage = computed(() => settingsQuery.data.value?.embeddingCoverage ?? null)
const coveragePercent = computed(() => {
  const c = coverage.value
  if (!c || !c.total) return null
  return Math.round((c.embedded / c.total) * 100)
})

function endpointChanged(
  draft: EndpointDraft,
  saved: ModelsSettingsResponse['embedding'],
): boolean {
  const savedEnabled = saved?.enabled ?? false
  const savedUrl = saved?.baseUrl ?? ''
  const savedModel = saved?.model ?? ''
  return (
    draft.enabled !== savedEnabled ||
    draft.baseUrl.trim() !== savedUrl ||
    draft.model.trim() !== savedModel ||
    draft.apiKey.trim().length > 0 ||
    draft.clearKey
  )
}

const dirtyCount = computed(() => {
  const saved = settingsQuery.data.value
  if (!saved) return 0
  let count = 0
  if (endpointChanged(form.embedding, saved.embedding)) count++
  if (endpointChanged(form.chatLlm, saved.chatLlm)) count++
  if (form.dreamEnabled !== saved.dream.enabled) count++
  if (form.dreamIntervalHours !== saved.dream.intervalHours) count++
  return count
})

watch(
  () => dirtyCount.value > 0,
  (changed) => {
    dirtyModel.value = changed
  },
  { immediate: true },
)

const validationProblem = computed(() => {
  if (form.embedding.enabled && (!form.embedding.baseUrl.trim() || !form.embedding.model.trim())) {
    return '启用嵌入模型时须填写接口地址与模型名称'
  }
  if (form.chatLlm.enabled && (!form.chatLlm.baseUrl.trim() || !form.chatLlm.model.trim())) {
    return '启用对话与整理模型时须填写接口地址与模型名称'
  }
  if (
    form.dreamIntervalHours < DREAM_INTERVAL_HOURS_MIN ||
    form.dreamIntervalHours > DREAM_INTERVAL_HOURS_MAX
  ) {
    return `整理间隔须在 ${DREAM_INTERVAL_HOURS_MIN} 到 ${DREAM_INTERVAL_HOURS_MAX} 小时之间`
  }
  return null
})

function buildEndpointPayload(draft: EndpointDraft) {
  if (!draft.enabled && !draft.baseUrl.trim() && !draft.model.trim()) return null
  if (!draft.baseUrl.trim() || !draft.model.trim()) return null
  return {
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    enabled: draft.enabled,
    ...(draft.clearKey
      ? { apiKey: null }
      : draft.apiKey.trim()
        ? { apiKey: draft.apiKey.trim() }
        : {}),
  }
}

const saving = ref(false)
async function save() {
  if (saving.value || !dirtyCount.value || validationProblem.value) return
  saving.value = true
  try {
    const saved = await api.saveModelsSettings({
      embedding: buildEndpointPayload(form.embedding),
      chatLlm: buildEndpointPayload(form.chatLlm),
      dream: {
        enabled: form.dreamEnabled,
        intervalHours: Number(form.dreamIntervalHours),
      },
    })
    queryClient.setQueryData(['models-settings'], saved)
    syncFromSaved(saved)
    void queryClient.invalidateQueries({ queryKey: ME_KEY })
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    toast.add({ title: '模型与整理设置已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

function discard() {
  if (settingsQuery.data.value) syncFromSaved(settingsQuery.data.value)
}

const testing = ref<ModelKind | null>(null)
const testResults = reactive<Partial<Record<ModelKind, TestModelResponse>>>({})

async function runTest(kind: ModelKind) {
  const draft = kind === 'embedding' ? form.embedding : form.chatLlm
  if (!draft.baseUrl.trim() || !draft.model.trim() || testing.value) return
  testing.value = kind
  try {
    testResults[kind] = await api.testModel({
      kind,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      ...(draft.apiKey.trim()
        ? { apiKey: draft.apiKey.trim(), useSavedKey: false }
        : { useSavedKey: draft.hasApiKey && !draft.clearKey }),
    })
  } catch (err) {
    testResults[kind] = {
      ok: false,
      latencyMs: 0,
      error: err instanceof ApiError ? err.message : '测试失败',
    }
  } finally {
    testing.value = null
  }
}

const rebuilding = ref(false)
async function rebuildEmbeddings() {
  if (rebuilding.value) return
  rebuilding.value = true
  try {
    const res = await api.backfillEmbeddings()
    toast.add({ title: `已加入向量重建队列（${res.queued} 条）`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['models-settings'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '触发重建失败', color: 'error' })
  } finally {
    rebuilding.value = false
  }
}
</script>

<template>
  <form class="space-y-8" @submit.prevent="save">
    <ReadFailureNote v-if="settingsQuery.isError.value" :query="settingsQuery" />
    <NoteLine v-if="!hasMasterKey" tone="warning">
      未配置主密钥 KIOKU_MASTER_KEY，无法加密保存模型 API Key（无密钥的本地服务仍可填写地址）。
    </NoteLine>

    <div v-if="settingsQuery.isPending.value" class="space-y-4">
      <USkeleton v-for="n in 3" :key="n" class="h-32 w-full" />
    </div>

    <template v-else-if="settingsQuery.data.value">
      <!-- 嵌入模型 -->
      <section class="space-y-4">
        <SectionHeading title="嵌入模型（向量检索）" :level="2">
          <template #actions>
            <USwitch v-model="form.embedding.enabled" label="启用" />
          </template>
        </SectionHeading>

        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="接口地址（OpenAI 兼容）">
            <UInput
              v-model="form.embedding.baseUrl"
              placeholder="https://api.example.com/v1"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField label="模型名称">
            <UInput
              v-model="form.embedding.model"
              placeholder="text-embedding-3-small"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField
            label="API Key"
            :help="
              form.embedding.hasApiKey && !form.embedding.clearKey
                ? '已保存密钥；留空表示保持不变'
                : '本地无鉴权服务可留空'
            "
            class="sm:col-span-2"
          >
            <div class="flex gap-2">
              <UInput
                v-model="form.embedding.apiKey"
                type="password"
                :placeholder="form.embedding.hasApiKey ? '••••••••' : 'sk-...'"
                class="min-w-0 flex-1 font-mono"
                autocomplete="off"
                @update:model-value="form.embedding.clearKey = false"
              />
              <UButton
                v-if="form.embedding.hasApiKey && !form.embedding.clearKey"
                type="button"
                size="sm"
                color="neutral"
                variant="outline"
                @click="((form.embedding.clearKey = true), (form.embedding.apiKey = ''))"
              >
                清除密钥
              </UButton>
            </div>
          </UFormField>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <UButton
            type="button"
            size="sm"
            color="neutral"
            variant="outline"
            :loading="testing === 'embedding'"
            :disabled="!form.embedding.baseUrl.trim() || !form.embedding.model.trim()"
            @click="runTest('embedding')"
          >
            测试连接
          </UButton>
          <span
            v-if="testResults.embedding"
            class="text-xs"
            :class="testResults.embedding.ok ? 'text-success' : 'text-error'"
          >
            {{
              testResults.embedding.ok
                ? `连接正常（${testResults.embedding.latencyMs} ms${testResults.embedding.dimensions ? `，${testResults.embedding.dimensions} 维` : ''}）`
                : `连接失败：${testResults.embedding.error ?? '未知原因'}`
            }}
          </span>
        </div>

        <div v-if="coverage" class="coverage-box">
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>
              向量索引覆盖：<strong class="tabular-nums">{{ coverage.embedded }}</strong> /
              <span class="tabular-nums">{{ coverage.total }}</span>
              <template v-if="coveragePercent !== null">（{{ coveragePercent }}%）</template>
              <template v-if="coverage.model"> · {{ coverage.model }}</template>
            </span>
            <UButton
              type="button"
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.refresh"
              :loading="rebuilding"
              :disabled="!settingsQuery.data.value?.embedding?.enabled"
              @click="rebuildEmbeddings"
            >
              重建索引
            </UButton>
          </div>
          <div v-if="coveragePercent !== null" class="meter">
            <i :style="{ width: `${coveragePercent}%` }" />
          </div>
        </div>
      </section>

      <!-- 对话与整理模型 -->
      <section class="space-y-4">
        <SectionHeading title="对话与整理模型（可选）" :level="2">
          <template #actions>
            <USwitch v-model="form.chatLlm.enabled" label="启用" />
          </template>
        </SectionHeading>
        <p class="text-xs text-muted">
          用于自动生成会话摘要与整理建议；不配置时基础存储、双链与检索仍完整可用。
        </p>

        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="接口地址（OpenAI 兼容）">
            <UInput
              v-model="form.chatLlm.baseUrl"
              placeholder="https://api.example.com/v1"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField label="模型名称">
            <UInput
              v-model="form.chatLlm.model"
              placeholder="gpt-4o-mini"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField
            label="API Key"
            :help="
              form.chatLlm.hasApiKey && !form.chatLlm.clearKey
                ? '已保存密钥；留空表示保持不变'
                : '本地无鉴权服务可留空'
            "
            class="sm:col-span-2"
          >
            <div class="flex gap-2">
              <UInput
                v-model="form.chatLlm.apiKey"
                type="password"
                :placeholder="form.chatLlm.hasApiKey ? '••••••••' : 'sk-...'"
                class="min-w-0 flex-1 font-mono"
                autocomplete="off"
                @update:model-value="form.chatLlm.clearKey = false"
              />
              <UButton
                v-if="form.chatLlm.hasApiKey && !form.chatLlm.clearKey"
                type="button"
                size="sm"
                color="neutral"
                variant="outline"
                @click="((form.chatLlm.clearKey = true), (form.chatLlm.apiKey = ''))"
              >
                清除密钥
              </UButton>
            </div>
          </UFormField>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <UButton
            type="button"
            size="sm"
            color="neutral"
            variant="outline"
            :loading="testing === 'chat_llm'"
            :disabled="!form.chatLlm.baseUrl.trim() || !form.chatLlm.model.trim()"
            @click="runTest('chat_llm')"
          >
            测试连接
          </UButton>
          <span
            v-if="testResults.chat_llm"
            class="text-xs"
            :class="testResults.chat_llm.ok ? 'text-success' : 'text-error'"
          >
            {{
              testResults.chat_llm.ok
                ? `连接正常（${testResults.chat_llm.latencyMs} ms）`
                : `连接失败：${testResults.chat_llm.error ?? '未知原因'}`
            }}
          </span>
        </div>
      </section>

      <!-- 定时整理 -->
      <section class="space-y-4">
        <SectionHeading title="定时整理" :level="2" />
        <div class="flex flex-wrap items-end gap-6">
          <div class="pb-1.5">
            <USwitch v-model="form.dreamEnabled" label="启用后台定时整理" />
          </div>
          <UFormField label="整理间隔（小时）" class="w-40">
            <UInputNumber
              v-model="form.dreamIntervalHours"
              :min="DREAM_INTERVAL_HOURS_MIN"
              :max="DREAM_INTERVAL_HOURS_MAX"
              :disabled="!form.dreamEnabled"
              class="w-full"
            />
          </UFormField>
        </div>
      </section>

      <SaveBar
        :count="dirtyCount"
        :saving="saving"
        :problem="validationProblem"
        @discard="discard"
      />
    </template>
  </form>
</template>

<style scoped>
.coverage-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.meter {
  position: relative;
  height: 6px;
  border: 1px solid var(--ui-rule);
}
.meter i {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--ui-text-highlighted);
}
</style>
