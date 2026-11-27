<script setup lang="ts">
import {
  DEFAULT_DREAM_INTERVAL_HOURS,
  DREAM_INTERVAL_HOURS_MAX,
  DREAM_INTERVAL_HOURS_MIN,
  REASONING_EFFORTS,
  type ModelKind,
  type ModelsSettingsResponse,
  type ReasoningEffort,
  type TestModelResponse,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { reasoningEffortLabels } from '../labels'
import { ME_KEY } from '../query'
import Hint from './Hint.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import NoteLine from './ui/NoteLine.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import SaveBar from './ui/SaveBar.vue'
import SectionHeading from './ui/SectionHeading.vue'

type TaskEffortChoice = 'inherit' | Exclude<ReasoningEffort, 'default'>

const dirtyModel = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const queryClient = useQueryClient()

const settingsQuery = useQuery({
  queryKey: ['models-settings'] as const,
  queryFn: () => api.modelsSettings(),
})

const reasoningOptions = REASONING_EFFORTS.map((value) => ({
  value,
  label: reasoningEffortLabels[value],
}))

const taskOverrideOptions: readonly { value: TaskEffortChoice; label: string }[] = [
  { value: 'inherit', label: '跟随全局' },
  { value: 'off', label: reasoningEffortLabels.off },
  { value: 'low', label: reasoningEffortLabels.low },
  { value: 'medium', label: reasoningEffortLabels.medium },
  { value: 'high', label: reasoningEffortLabels.high },
]

interface EndpointDraft {
  enabled: boolean
  baseUrl: string
  model: string
  apiKey: string
  clearKey: boolean
  hasApiKey: boolean
}

interface ChatEndpointDraft extends EndpointDraft {
  reasoningEffort: ReasoningEffort
  fastEffort: TaskEffortChoice
  organizeEffort: TaskEffortChoice
}

const form = reactive<{
  embedding: EndpointDraft
  chatLlm: ChatEndpointDraft
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
    reasoningEffort: 'default',
    fastEffort: 'inherit',
    organizeEffort: 'inherit',
  },
  dreamEnabled: true,
  dreamIntervalHours: DEFAULT_DREAM_INTERVAL_HOURS,
})

const taskOverridesOpen = ref(false)

function toTaskChoice(value: ReasoningEffort | undefined): TaskEffortChoice {
  return value && value !== 'default' ? value : 'inherit'
}

function syncFromSaved(data: ModelsSettingsResponse) {
  form.embedding = {
    enabled: data.embedding?.enabled ?? false,
    baseUrl: data.embedding?.baseUrl ?? '',
    model: data.embedding?.model ?? '',
    apiKey: '',
    clearKey: false,
    hasApiKey: data.embedding?.hasApiKey ?? false,
  }
  const fastEffort = toTaskChoice(data.chatLlm?.taskReasoningEffort?.fast)
  const organizeEffort = toTaskChoice(data.chatLlm?.taskReasoningEffort?.organize)
  form.chatLlm = {
    enabled: data.chatLlm?.enabled ?? false,
    baseUrl: data.chatLlm?.baseUrl ?? '',
    model: data.chatLlm?.model ?? '',
    apiKey: '',
    clearKey: false,
    hasApiKey: data.chatLlm?.hasApiKey ?? false,
    reasoningEffort: data.chatLlm?.reasoningEffort ?? 'default',
    fastEffort,
    organizeEffort,
  }
  if (fastEffort !== 'inherit' || organizeEffort !== 'inherit') {
    taskOverridesOpen.value = true
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

const activeOverrideCount = computed(
  () =>
    (form.chatLlm.fastEffort !== 'inherit' ? 1 : 0) +
    (form.chatLlm.organizeEffort !== 'inherit' ? 1 : 0),
)

interface ChatProbeTarget {
  effort: ReasoningEffort
  sourceLabel: string | null
}

// 优先探测显式设置的按任务覆盖（整理任务优先于快速任务），否则探测全局思考等级
const chatProbeTarget = computed<ChatProbeTarget>(() => {
  if (form.chatLlm.organizeEffort !== 'inherit') {
    return { effort: form.chatLlm.organizeEffort, sourceLabel: '整理任务覆盖' }
  }
  if (form.chatLlm.fastEffort !== 'inherit') {
    return { effort: form.chatLlm.fastEffort, sourceLabel: '快速任务覆盖' }
  }
  return {
    effort: form.chatLlm.reasoningEffort,
    sourceLabel: form.chatLlm.reasoningEffort !== 'default' ? '全局设置' : null,
  }
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

function chatEndpointChanged(
  draft: ChatEndpointDraft,
  saved: ModelsSettingsResponse['chatLlm'],
): boolean {
  if (endpointChanged(draft, saved)) return true
  const savedEffort = saved?.reasoningEffort ?? 'default'
  const savedFast = toTaskChoice(saved?.taskReasoningEffort?.fast)
  const savedOrganize = toTaskChoice(saved?.taskReasoningEffort?.organize)
  return (
    draft.reasoningEffort !== savedEffort ||
    draft.fastEffort !== savedFast ||
    draft.organizeEffort !== savedOrganize
  )
}

const dirtyCount = computed(() => {
  const saved = settingsQuery.data.value
  if (!saved) return 0
  let count = 0
  if (endpointChanged(form.embedding, saved.embedding)) count++
  if (chatEndpointChanged(form.chatLlm, saved.chatLlm)) count++
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
  const hasExplicitThinking =
    form.chatLlm.reasoningEffort !== 'default' || activeOverrideCount.value > 0
  if (hasExplicitThinking && (!form.chatLlm.baseUrl.trim() || !form.chatLlm.model.trim())) {
    return '配置思考等级时须同时填写对话模型的接口地址与模型名称'
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

function buildChatPayload(draft: ChatEndpointDraft) {
  const base = buildEndpointPayload(draft)
  if (!base) return null
  const hasOverride = draft.fastEffort !== 'inherit' || draft.organizeEffort !== 'inherit'
  return {
    ...base,
    reasoningEffort: draft.reasoningEffort,
    taskReasoningEffort: hasOverride
      ? {
          ...(draft.fastEffort !== 'inherit' ? { fast: draft.fastEffort } : {}),
          ...(draft.organizeEffort !== 'inherit' ? { organize: draft.organizeEffort } : {}),
        }
      : null,
  }
}

const saving = ref(false)
async function save() {
  if (saving.value || !dirtyCount.value || validationProblem.value) return
  saving.value = true
  try {
    const saved = await api.saveModelsSettings({
      embedding: buildEndpointPayload(form.embedding),
      chatLlm: buildChatPayload(form.chatLlm),
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

interface ModelTestDisplay extends TestModelResponse {
  probedEffort?: ReasoningEffort
  probedSource?: string | null
}

const testing = ref<ModelKind | null>(null)
const testResults = reactive<Partial<Record<ModelKind, ModelTestDisplay>>>({})

function formatChatProbeSuffix(res: ModelTestDisplay): string {
  if (!res.probedEffort || res.probedEffort === 'default') return ''
  const level = reasoningEffortLabels[res.probedEffort]
  const src = res.probedSource ? `（${res.probedSource}）` : ''
  return ` · 探测思考等级：${level}${src}`
}

async function runTest(kind: ModelKind) {
  const draft = kind === 'embedding' ? form.embedding : form.chatLlm
  if (!draft.baseUrl.trim() || !draft.model.trim() || testing.value) return
  testing.value = kind
  delete testResults[kind]
  const probe = kind === 'chat_llm' ? chatProbeTarget.value : null
  try {
    const res = await api.testModel({
      kind,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      ...(draft.apiKey.trim()
        ? { apiKey: draft.apiKey.trim(), useSavedKey: false }
        : { useSavedKey: draft.hasApiKey && !draft.clearKey }),
      ...(probe ? { reasoningEffort: probe.effort } : {}),
    })
    testResults[kind] = probe
      ? { ...res, probedEffort: probe.effort, probedSource: probe.sourceLabel }
      : res
  } catch (err) {
    testResults[kind] = {
      ok: false,
      latencyMs: 0,
      error: err instanceof ApiError ? err.message : '测试失败',
      ...(probe ? { probedEffort: probe.effort, probedSource: probe.sourceLabel } : {}),
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
                ? '已保存密钥，留空保持不变'
                : undefined
            "
            class="sm:col-span-2"
          >
            <div class="flex gap-2">
              <UInput
                v-model="form.embedding.apiKey"
                type="password"
                :placeholder="
                  form.embedding.hasApiKey && !form.embedding.clearKey
                    ? '••••••••'
                    : 'sk-...（无需鉴权可留空）'
                "
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
                ? '已保存密钥，留空保持不变'
                : undefined
            "
            class="sm:col-span-2"
          >
            <div class="flex gap-2">
              <UInput
                v-model="form.chatLlm.apiKey"
                type="password"
                :placeholder="
                  form.chatLlm.hasApiKey && !form.chatLlm.clearKey
                    ? '••••••••'
                    : 'sk-...（无需鉴权可留空）'
                "
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

          <UFormField
            label="思考等级"
            :ui="{ labelWrapper: 'justify-start gap-1.5' }"
            class="sm:col-span-2"
          >
            <template #hint>
              <Hint label="思考等级说明">
                选「跟随默认」时不附加思考参数，兼容非推理模型；开启后会按档位自动放宽输出上限。
              </Hint>
            </template>
            <div class="effort-row">
              <SegmentedChoice
                v-model="form.chatLlm.reasoningEffort"
                :items="reasoningOptions"
                label="对话模型默认思考等级"
              />
              <button
                type="button"
                class="override-toggle"
                :aria-expanded="taskOverridesOpen"
                @click="taskOverridesOpen = !taskOverridesOpen"
              >
                <UIcon
                  :name="taskOverridesOpen ? icons.chevronDown : icons.chevronRight"
                  class="override-chevron"
                  aria-hidden="true"
                />
                <span>
                  {{
                    activeOverrideCount > 0
                      ? `按任务覆盖（已设 ${activeOverrideCount} 项）`
                      : '按任务覆盖'
                  }}
                </span>
              </button>
            </div>

            <div v-if="taskOverridesOpen" class="override-box">
              <div class="override-item">
                <div class="override-meta">
                  <span class="override-title">快速任务</span>
                  <span class="override-desc">随手记归并与会话摘要，建议关闭或设低以防超时</span>
                </div>
                <SegmentedChoice
                  v-model="form.chatLlm.fastEffort"
                  :items="taskOverrideOptions"
                  label="快速任务思考等级"
                  compact
                />
              </div>
              <div class="override-item">
                <div class="override-meta">
                  <span class="override-title">整理任务</span>
                  <span class="override-desc">后台整理与存量规范整理，可按需提高推理深度</span>
                </div>
                <SegmentedChoice
                  v-model="form.chatLlm.organizeEffort"
                  :items="taskOverrideOptions"
                  label="整理任务思考等级"
                  compact
                />
              </div>
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
                ? `连接正常（${testResults.chat_llm.latencyMs} ms${formatChatProbeSuffix(testResults.chat_llm)}）`
                : `连接失败：${testResults.chat_llm.error ?? '未知原因'}${formatChatProbeSuffix(testResults.chat_llm)}`
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
.effort-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
}
.override-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid transparent;
  font-size: 12px;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.override-toggle:hover {
  border-color: var(--ui-border-accented);
  background: var(--ui-bg-muted);
  color: var(--ui-text-highlighted);
}
.override-chevron {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.override-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.override-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 14px;
}
.override-item + .override-item {
  padding-top: 10px;
  border-top: 1px solid var(--ui-border);
}
.override-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.override-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.override-desc {
  font-size: 12px;
  color: var(--ui-text-muted);
}
</style>
