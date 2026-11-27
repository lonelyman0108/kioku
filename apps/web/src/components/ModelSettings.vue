<script setup lang="ts">
import {
  DEFAULT_CROSS_MEMORY_INTERVAL_HOURS,
  DEFAULT_DREAM_INTERVAL_HOURS,
  DEFAULT_TIDY_INTERVAL_HOURS,
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
import {
  reasoningEffortDescriptions,
  reasoningEffortLabels,
  reasoningEffortWireValues,
} from '../labels'
import { ME_KEY } from '../query'
import Hint from './Hint.vue'
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

const inboxQuery = useQuery({
  queryKey: ['inbox'] as const,
  queryFn: () => api.inbox(),
  staleTime: 30_000,
})
const backfillState = computed(() => inboxQuery.data.value?.embeddingBackfill ?? null)
const backfillRunning = computed(() => Boolean(backfillState.value?.running))

const reasoningSelectItems = REASONING_EFFORTS.map((value) => {
  const wire = reasoningEffortWireValues[value]
  return {
    value,
    label: wire
      ? `${reasoningEffortLabels[value]} · ${wire}`
      : `${reasoningEffortLabels[value]}（不注入参数）`,
  }
})

const taskOverrideSelectItems: { value: TaskEffortChoice; label: string }[] = [
  { value: 'inherit', label: '跟随全局' },
  ...REASONING_EFFORTS.filter((v): v is Exclude<ReasoningEffort, 'default'> => v !== 'default').map(
    (value) => ({
      value,
      label: `${reasoningEffortLabels[value]} · ${reasoningEffortWireValues[value]}`,
    }),
  ),
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

interface DreamScheduleDraft {
  enabled: boolean
  intervalHours: number
}

const form = reactive<{
  embedding: EndpointDraft
  chatLlm: ChatEndpointDraft
  dream: {
    standard: DreamScheduleDraft
    crossMemory: DreamScheduleDraft
    tidy: DreamScheduleDraft
  }
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
  dream: {
    standard: { enabled: true, intervalHours: DEFAULT_DREAM_INTERVAL_HOURS },
    crossMemory: { enabled: false, intervalHours: DEFAULT_CROSS_MEMORY_INTERVAL_HOURS },
    tidy: { enabled: false, intervalHours: DEFAULT_TIDY_INTERVAL_HOURS },
  },
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
  form.dream.standard = {
    enabled: data.dream.enabled,
    intervalHours: data.dream.intervalHours,
  }
  form.dream.crossMemory = {
    enabled: data.dream.crossMemory?.enabled ?? false,
    intervalHours: data.dream.crossMemory?.intervalHours ?? DEFAULT_CROSS_MEMORY_INTERVAL_HOURS,
  }
  form.dream.tidy = {
    enabled: data.dream.tidy?.enabled ?? false,
    intervalHours: data.dream.tidy?.intervalHours ?? DEFAULT_TIDY_INTERVAL_HOURS,
  }
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

const selectedWireValue = computed(() => reasoningEffortWireValues[form.chatLlm.reasoningEffort])

const activeOverrideCount = computed(
  () =>
    (form.chatLlm.fastEffort !== 'inherit' ? 1 : 0) +
    (form.chatLlm.organizeEffort !== 'inherit' ? 1 : 0),
)

const overrideSummaryText = computed(() => {
  const parts: string[] = []
  if (form.chatLlm.fastEffort !== 'inherit') {
    const wire = reasoningEffortWireValues[form.chatLlm.fastEffort]
    parts.push(`快速：${reasoningEffortLabels[form.chatLlm.fastEffort]} (${wire})`)
  }
  if (form.chatLlm.organizeEffort !== 'inherit') {
    const wire = reasoningEffortWireValues[form.chatLlm.organizeEffort]
    parts.push(`整理：${reasoningEffortLabels[form.chatLlm.organizeEffort]} (${wire})`)
  }
  return parts.length ? parts.join(' · ') : '全部跟随全局'
})

const scheduleRows = computed(
  () =>
    [
      {
        key: 'standard' as const,
        label: '增量整理',
        desc: '整理近期新增或改动的记忆与会话摘要',
        icon: icons.sparkles,
        draft: form.dream.standard,
      },
      {
        key: 'crossMemory' as const,
        label: '查重/关联',
        desc: '全库扫描重复合并、补全双链与常驻巡检',
        icon: icons.links,
        draft: form.dream.crossMemory,
      },
      {
        key: 'tidy' as const,
        label: '规范整理',
        desc: '批量规范脏标题、补概要并剥离旧日志',
        icon: icons.tidy,
        draft: form.dream.tidy,
      },
    ] as const,
)

function formatDaysHint(hours: number): string | null {
  if (!Number.isFinite(hours) || hours < 24 || hours % 24 !== 0) return null
  return `即每 ${hours / 24} 天`
}

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
  if (
    form.dream.standard.enabled !== saved.dream.enabled ||
    form.dream.standard.intervalHours !== saved.dream.intervalHours
  ) {
    count++
  }
  const savedCrossEnabled = saved.dream.crossMemory?.enabled ?? false
  const savedCrossInterval =
    saved.dream.crossMemory?.intervalHours ?? DEFAULT_CROSS_MEMORY_INTERVAL_HOURS
  if (
    form.dream.crossMemory.enabled !== savedCrossEnabled ||
    form.dream.crossMemory.intervalHours !== savedCrossInterval
  ) {
    count++
  }
  const savedTidyEnabled = saved.dream.tidy?.enabled ?? false
  const savedTidyInterval = saved.dream.tidy?.intervalHours ?? DEFAULT_TIDY_INTERVAL_HOURS
  if (
    form.dream.tidy.enabled !== savedTidyEnabled ||
    form.dream.tidy.intervalHours !== savedTidyInterval
  ) {
    count++
  }
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
  for (const row of scheduleRows.value) {
    if (
      row.draft.intervalHours < DREAM_INTERVAL_HOURS_MIN ||
      row.draft.intervalHours > DREAM_INTERVAL_HOURS_MAX
    ) {
      return `${row.label}间隔须在 ${DREAM_INTERVAL_HOURS_MIN} 到 ${DREAM_INTERVAL_HOURS_MAX} 小时之间`
    }
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
        enabled: form.dream.standard.enabled,
        intervalHours: Number(form.dream.standard.intervalHours),
        crossMemory: {
          enabled: form.dream.crossMemory.enabled,
          intervalHours: Number(form.dream.crossMemory.intervalHours),
        },
        tidy: {
          enabled: form.dream.tidy.enabled,
          intervalHours: Number(form.dream.tidy.intervalHours),
        },
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
  const wire = reasoningEffortWireValues[res.probedEffort]
  const src = res.probedSource ? `（${res.probedSource}）` : ''
  return ` · 探测思考等级：${level} (${wire})${src}`
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
const cancellingBackfill = ref(false)
async function rebuildEmbeddings() {
  if (rebuilding.value || backfillRunning.value) return
  rebuilding.value = true
  try {
    const res = await api.backfillEmbeddings()
    toast.add({ title: `已加入向量重建队列（${res.queued} 条）`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['models-settings'] })
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '触发重建失败', color: 'error' })
  } finally {
    rebuilding.value = false
  }
}

async function cancelBackfill() {
  if (cancellingBackfill.value || !backfillRunning.value) return
  cancellingBackfill.value = true
  try {
    const res = await api.cancelEmbeddingBackfill()
    if (!res.cancelled) {
      toast.add({ title: '当前没有可取消的向量补齐任务', color: 'neutral' })
    }
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    void queryClient.invalidateQueries({ queryKey: ['models-settings'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '取消补齐失败', color: 'error' })
  } finally {
    cancellingBackfill.value = false
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
        <SectionHeading title="嵌入模型（向量检索）" :icon="icons.database" :level="2">
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
                :icon="icons.cancel"
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
            :icon="icons.plug"
            :loading="testing === 'embedding'"
            :disabled="!form.embedding.baseUrl.trim() || !form.embedding.model.trim()"
            @click="runTest('embedding')"
          >
            测试连接
          </UButton>
          <span
            v-if="testResults.embedding"
            class="test-result"
            :class="testResults.embedding.ok ? 'text-success' : 'text-error'"
          >
            <UIcon
              :name="testResults.embedding.ok ? icons.checkCircle : icons.error"
              class="test-result-icon"
              aria-hidden="true"
            />
            <span>
              {{
                testResults.embedding.ok
                  ? `连接正常（${testResults.embedding.latencyMs} ms${testResults.embedding.dimensions ? `，${testResults.embedding.dimensions} 维` : ''}）`
                  : `连接失败：${testResults.embedding.error ?? '未知原因'}`
              }}
            </span>
          </span>
        </div>

        <div v-if="coverage" class="coverage-box">
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span class="coverage-label">
              <UIcon
                :name="
                  backfillRunning
                    ? icons.loader
                    : coveragePercent === 100
                      ? icons.checkCircle
                      : icons.layers
                "
                class="coverage-icon"
                :class="{
                  'is-complete': !backfillRunning && coveragePercent === 100,
                  'is-spinning': backfillRunning,
                }"
                aria-hidden="true"
              />
              <span>
                <template v-if="backfillRunning">
                  向量索引补齐中<template v-if="backfillState && backfillState.total > 0"
                    >：<strong class="tabular-nums">{{ backfillState.processed }}</strong> /
                    <span class="tabular-nums">{{ backfillState.total }}</span></template
                  >
                  <template v-if="backfillState?.model"> · {{ backfillState.model }}</template>
                </template>
                <template v-else>
                  向量索引覆盖：<strong class="tabular-nums">{{ coverage.embedded }}</strong> /
                  <span class="tabular-nums">{{ coverage.total }}</span>
                  <template v-if="coveragePercent !== null">（{{ coveragePercent }}%）</template>
                  <template v-if="coverage.model"> · {{ coverage.model }}</template>
                </template>
              </span>
            </span>
            <UButton
              v-if="backfillRunning"
              type="button"
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.stop"
              :loading="cancellingBackfill"
              @click="cancelBackfill"
            >
              取消补齐
            </UButton>
            <UButton
              v-else
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
        <SectionHeading title="对话与整理模型（可选）" :icon="icons.sparkles" :level="2">
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
                :icon="icons.cancel"
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
                透传 OpenAI 兼容接口的 reasoning_effort 参数（none / minimal / low / medium / high /
                xhigh / max）；选「跟随默认」不附加该字段，开启后会按档位自动放宽输出上限。
              </Hint>
            </template>

            <div class="effort-control-row">
              <USelect
                v-model="form.chatLlm.reasoningEffort"
                :items="reasoningSelectItems"
                value-key="value"
                aria-label="对话模型默认思考等级"
                class="effort-select"
              />
              <span class="effort-wire-badge font-mono">
                <UIcon :name="icons.gauge" class="effort-wire-icon" aria-hidden="true" />
                <span>
                  {{
                    selectedWireValue
                      ? `reasoning_effort = "${selectedWireValue}"`
                      : '不注入思考参数'
                  }}
                </span>
              </span>
            </div>

            <p class="effort-desc">
              {{ reasoningEffortDescriptions[form.chatLlm.reasoningEffort] }}
            </p>

            <div class="override-disclosure">
              <button
                type="button"
                class="override-toggle"
                :aria-expanded="taskOverridesOpen"
                @click="taskOverridesOpen = !taskOverridesOpen"
              >
                <span class="override-toggle-lead">
                  <UIcon
                    :name="taskOverridesOpen ? icons.chevronDown : icons.chevronRight"
                    class="override-chevron"
                    aria-hidden="true"
                  />
                  <UIcon :name="icons.sliders" class="override-icon" aria-hidden="true" />
                  <span>按任务覆盖</span>
                  <span v-if="activeOverrideCount > 0" class="override-badge tabular-nums">
                    已设 {{ activeOverrideCount }} 项
                  </span>
                </span>
                <span class="override-summary">{{ overrideSummaryText }}</span>
              </button>

              <div v-if="taskOverridesOpen" class="override-box">
                <div class="override-item">
                  <div class="override-meta">
                    <span class="override-title">
                      <UIcon :name="icons.trigger" class="override-title-icon" aria-hidden="true" />
                      <span>快速任务</span>
                    </span>
                    <span class="override-desc">随手记归并与会话摘要，建议关闭或设低以防超时</span>
                  </div>
                  <USelect
                    v-model="form.chatLlm.fastEffort"
                    :items="taskOverrideSelectItems"
                    value-key="value"
                    size="sm"
                    aria-label="快速任务思考等级"
                    class="override-select"
                  />
                </div>
                <div class="override-item">
                  <div class="override-meta">
                    <span class="override-title">
                      <UIcon
                        :name="icons.sparkles"
                        class="override-title-icon"
                        aria-hidden="true"
                      />
                      <span>整理任务</span>
                    </span>
                    <span class="override-desc"
                      >增量整理、查重/关联与规范整理，可按需提高推理深度</span
                    >
                  </div>
                  <USelect
                    v-model="form.chatLlm.organizeEffort"
                    :items="taskOverrideSelectItems"
                    value-key="value"
                    size="sm"
                    aria-label="整理任务思考等级"
                    class="override-select"
                  />
                </div>
                <p class="override-footnote">
                  不同模型支持的最高档位不同（如 xhigh / max），调整后可点击下方「测试连接」验证。
                </p>
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
            :icon="icons.plug"
            :loading="testing === 'chat_llm'"
            :disabled="!form.chatLlm.baseUrl.trim() || !form.chatLlm.model.trim()"
            @click="runTest('chat_llm')"
          >
            测试连接
          </UButton>
          <span
            v-if="testResults.chat_llm"
            class="test-result"
            :class="testResults.chat_llm.ok ? 'text-success' : 'text-error'"
          >
            <UIcon
              :name="testResults.chat_llm.ok ? icons.checkCircle : icons.error"
              class="test-result-icon"
              aria-hidden="true"
            />
            <span>
              {{
                testResults.chat_llm.ok
                  ? `连接正常（${testResults.chat_llm.latencyMs} ms${formatChatProbeSuffix(testResults.chat_llm)}）`
                  : `连接失败：${testResults.chat_llm.error ?? '未知原因'}${formatChatProbeSuffix(testResults.chat_llm)}`
              }}
            </span>
          </span>
        </div>
      </section>

      <!-- 定时整理（三模式独立配置） -->
      <section class="space-y-3">
        <SectionHeading title="定时整理" :icon="icons.calendarClock" :level="2" />
        <p class="text-xs text-muted">
          三种整理各自独立计时；生成的建议均进入待处理队列，确认后才写入记忆。
        </p>
        <div class="schedule-list">
          <div
            v-for="row in scheduleRows"
            :key="row.key"
            class="schedule-row"
            :class="{ 'is-disabled': !row.draft.enabled }"
          >
            <div class="schedule-info">
              <div class="schedule-title-row">
                <UIcon :name="row.icon" class="schedule-icon" aria-hidden="true" />
                <span class="schedule-name">{{ row.label }}</span>
              </div>
              <p class="schedule-desc">{{ row.desc }}</p>
            </div>
            <div class="schedule-controls">
              <USwitch
                v-model="row.draft.enabled"
                :aria-label="`启用定时${row.label}`"
                label="启用"
              />
              <div class="schedule-interval tabular-nums">
                <span class="interval-label">每</span>
                <UInputNumber
                  v-model="row.draft.intervalHours"
                  :min="DREAM_INTERVAL_HOURS_MIN"
                  :max="DREAM_INTERVAL_HOURS_MAX"
                  :disabled="!row.draft.enabled"
                  :aria-label="`${row.label}间隔小时`"
                  size="sm"
                  class="w-28"
                />
                <span class="interval-label">
                  小时<template v-if="formatDaysHint(row.draft.intervalHours)"
                    >（{{ formatDaysHint(row.draft.intervalHours) }}）</template
                  >
                </span>
              </div>
            </div>
          </div>
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
.test-result {
  display: inline-flex;
  align-items: flex-start;
  gap: 5px;
  font-size: 12px;
}
.test-result-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}
.coverage-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.coverage-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.coverage-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.coverage-icon.is-complete {
  color: var(--ui-success);
}
.coverage-icon.is-spinning {
  color: var(--ui-text-highlighted);
  animation: model-spin 1.1s linear infinite;
}
@keyframes model-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .coverage-icon.is-spinning {
    animation: none;
  }
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

/* 思考等级主选择与协议参数预览 */
.effort-control-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.effort-select {
  width: 15.5rem;
  max-width: 100%;
}
.effort-wire-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 4px 9px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-toned);
}
.effort-wire-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.effort-desc {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}

/* 按任务覆盖（默认收起，带内联摘要） */
.override-disclosure {
  margin-top: 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.override-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  width: 100%;
  padding: 7px 10px;
  background: var(--ui-bg-muted);
  text-align: left;
  font-size: 13px;
  color: var(--ui-text-highlighted);
  cursor: pointer;
}
.override-toggle:hover {
  background: var(--ui-bg-elevated);
}
.override-toggle-lead {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.override-chevron,
.override-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.override-badge {
  padding: 0 5px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  color: var(--ui-text-highlighted);
}
.override-summary {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.override-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
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
  flex: 1 1 14rem;
}
.override-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.override-title-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-toned);
}
.override-desc {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.override-select {
  width: 13.5rem;
  max-width: 100%;
}
.override-footnote {
  padding-top: 8px;
  border-top: 1px dashed var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}

/* 三模式独立定时整理日程表 */
.schedule-list {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.schedule-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  padding: 12px 14px;
}
.schedule-row + .schedule-row {
  border-top: 1px solid var(--ui-border);
}
.schedule-row.is-disabled {
  background: var(--ui-bg-muted);
}
.schedule-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 15rem;
}
.schedule-title-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.schedule-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-toned);
}
.schedule-row.is-disabled .schedule-icon {
  color: var(--ui-text-muted);
}
.schedule-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.schedule-desc {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.schedule-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
}
.schedule-interval {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.interval-label {
  font-size: 12px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
</style>
