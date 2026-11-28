<script setup lang="ts">
import {
  DEFAULT_CROSS_MEMORY_INTERVAL_HOURS,
  DEFAULT_DREAM_INTERVAL_HOURS,
  DEFAULT_TIDY_INTERVAL_HOURS,
  DREAM_INTERVAL_HOURS_MAX,
  DREAM_INTERVAL_HOURS_MIN,
  REASONING_EFFORTS,
  type DreamMode,
  type DreamRunSummary,
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
import { useNow } from '../composables/useNow'
import { icons } from '../icons'
import {
  dreamOutcomeLabels,
  reasoningEffortDescriptions,
  reasoningEffortLabels,
  reasoningEffortWireValues,
} from '../labels'
import { ME_KEY } from '../query'
import { settingsRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import NoteLine from './ui/NoteLine.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import SaveBar, { type SaveBarChange } from './ui/SaveBar.vue'
import SectionHeading from './ui/SectionHeading.vue'

type ModelSection = 'embed' | 'chat' | 'schedule'
type TaskEffortChoice = 'inherit' | Exclude<ReasoningEffort, 'default'>

const props = withDefaults(defineProps<{ section?: ModelSection }>(), { section: 'chat' })
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const queryClient = useQueryClient()
const now = useNow(60_000)

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
const dreamState = computed(() => inboxQuery.data.value?.dreamState ?? null)

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

function syncEmbeddingFromSaved(data: ModelsSettingsResponse) {
  form.embedding = {
    enabled: data.embedding?.enabled ?? false,
    baseUrl: data.embedding?.baseUrl ?? '',
    model: data.embedding?.model ?? '',
    apiKey: '',
    clearKey: false,
    hasApiKey: data.embedding?.hasApiKey ?? false,
  }
}

function syncChatFromSaved(data: ModelsSettingsResponse) {
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
}

function syncDreamFromSaved(data: ModelsSettingsResponse) {
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

function syncFromSaved(data: ModelsSettingsResponse) {
  syncEmbeddingFromSaved(data)
  syncChatFromSaved(data)
  syncDreamFromSaved(data)
}

watch(
  () => settingsQuery.data.value,
  (data) => {
    if (data && !dirtyModel.value) syncFromSaved(data)
  },
  { immediate: true },
)

// 切换子视图且路由守卫放行后，将当前草稿与已保存值对齐并清理旧连通测试状态
watch(
  () => props.section,
  () => {
    delete testResults.embedding
    delete testResults.chat_llm
    if (settingsQuery.data.value) syncFromSaved(settingsQuery.data.value)
  },
)

const hasMasterKey = computed(() => settingsQuery.data.value?.hasMasterKey ?? true)
const coverage = computed(() => settingsQuery.data.value?.embeddingCoverage ?? null)
const missingEmbeddings = computed(() => {
  const c = coverage.value
  if (!c) return 0
  return Math.max(0, c.total - c.embedded)
})
const coveragePercent = computed(() => {
  const c = coverage.value
  if (!c || !c.total) return null
  return Math.round((c.embedded / c.total) * 100)
})
const backfillPercent = computed(() => {
  const state = backfillState.value
  if (!state || !state.running || state.total <= 0) return null
  return Math.min(100, Math.round((state.processed / state.total) * 100))
})
const meterPercent = computed(() =>
  backfillRunning.value && backfillPercent.value !== null
    ? backfillPercent.value
    : coveragePercent.value,
)

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

const canReuseEmbeddingUrl = computed(() => {
  const embUrl = (settingsQuery.data.value?.embedding?.baseUrl ?? form.embedding.baseUrl).trim()
  return Boolean(embUrl) && embUrl !== form.chatLlm.baseUrl.trim()
})

function reuseEmbeddingUrl() {
  const embUrl = (settingsQuery.data.value?.embedding?.baseUrl ?? form.embedding.baseUrl).trim()
  if (!embUrl) return
  form.chatLlm.baseUrl = embUrl
  toast.add({ title: '已填入嵌入模型接口地址', color: 'neutral' })
}

function formatHoursHuman(hours: number): string {
  if (!Number.isFinite(hours) || hours < 1) return ''
  if (hours === 24) return '每天'
  if (hours === 12) return '每半天'
  if (hours === 168) return '每周'
  if (hours % 168 === 0) return `每 ${hours / 168} 周`
  if (hours > 24 && hours % 24 === 0) return `每 ${hours / 24} 天`
  return `每 ${hours} 小时`
}

function formatNextRunHint(lastRunAt: string | null, intervalHours: number): string | null {
  if (!lastRunAt || !Number.isFinite(intervalHours) || intervalHours < 1) return null
  const lastMs = Date.parse(lastRunAt)
  if (!Number.isFinite(lastMs)) return null
  const nextMs = lastMs + intervalHours * 3_600_000
  const diffMs = nextMs - now.value.getTime()
  if (diffMs <= 60_000) return '即将执行'
  const diffMinutes = Math.round(diffMs / 60_000)
  if (diffMinutes < 60) return `约 ${diffMinutes} 分钟后`
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `约 ${diffHours} 小时后`
  const diffDays = Math.round(diffHours / 24)
  return `约 ${diffDays} 天后`
}

function latestRunForMode(mode: DreamMode): DreamRunSummary | null {
  const runs = dreamState.value?.recentRuns ?? []
  return runs.find((r) => (r.mode ?? 'standard') === mode) ?? null
}

const scheduleRows = computed(() => {
  const schedules = dreamState.value?.schedules
  const chatEnabled = Boolean(settingsQuery.data.value?.chatLlm?.enabled)
  const defs = [
    {
      key: 'standard' as const,
      mode: 'standard' as DreamMode,
      label: '增量整理',
      desc: '整理近期新增或改动的记忆与会话摘要',
      icon: icons.sparkles,
      draft: form.dream.standard,
      lastRunAt: schedules?.standard.lastRunAt ?? dreamState.value?.lastRunAt ?? null,
    },
    {
      key: 'crossMemory' as const,
      mode: 'cross_memory' as DreamMode,
      label: '查重与关联',
      desc: '全库扫描重复合并、补全双链与常驻巡检',
      icon: icons.links,
      draft: form.dream.crossMemory,
      lastRunAt: schedules?.crossMemory.lastRunAt ?? null,
    },
    {
      key: 'tidy' as const,
      mode: 'tidy' as DreamMode,
      label: '规范整理',
      desc: '批量规范标题、补概要并归档旧日志',
      icon: icons.tidy,
      draft: form.dream.tidy,
      lastRunAt: schedules?.tidy.lastRunAt ?? null,
    },
  ] as const

  return defs.map((item) => {
    const latestRun = latestRunForMode(item.mode)
    const lastAt = item.lastRunAt ?? latestRun?.createdAt ?? null
    const nextHint =
      item.draft.enabled && chatEnabled ? formatNextRunHint(lastAt, item.draft.intervalHours) : null
    return {
      ...item,
      latestRun,
      lastAt,
      nextHint,
    }
  })
})

const enabledScheduleCount = computed(
  () => scheduleRows.value.filter((row) => row.draft.enabled).length,
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

function collectEndpointChanges(
  draft: EndpointDraft,
  saved: ModelsSettingsResponse['embedding'],
): SaveBarChange[] {
  const list: SaveBarChange[] = []
  const savedEnabled = saved?.enabled ?? false
  const savedUrl = saved?.baseUrl ?? ''
  const savedModel = saved?.model ?? ''
  if (draft.enabled !== savedEnabled) {
    list.push({
      label: '启用状态',
      before: savedEnabled ? '已启用' : '已停用',
      after: draft.enabled ? '已启用' : '已停用',
    })
  }
  if (draft.baseUrl.trim() !== savedUrl) {
    list.push({
      label: '接口地址',
      before: savedUrl || '（空）',
      after: draft.baseUrl.trim() || '（空）',
    })
  }
  if (draft.model.trim() !== savedModel) {
    list.push({
      label: '模型名称',
      before: savedModel || '（空）',
      after: draft.model.trim() || '（空）',
    })
  }
  if (draft.clearKey) {
    list.push({ label: 'API Key', before: '已保存', after: '清除' })
  } else if (draft.apiKey.trim().length > 0) {
    list.push({
      label: 'API Key',
      before: saved?.hasApiKey ? '已保存' : '未设置',
      after: '更新密钥',
    })
  }
  return list
}

const embedDirtyChanges = computed<SaveBarChange[]>(() => {
  const saved = settingsQuery.data.value
  if (!saved) return []
  return collectEndpointChanges(form.embedding, saved.embedding)
})

const chatDirtyChanges = computed<SaveBarChange[]>(() => {
  const saved = settingsQuery.data.value
  if (!saved) return []
  const list = collectEndpointChanges(form.chatLlm, saved.chatLlm)
  const savedEffort = saved.chatLlm?.reasoningEffort ?? 'default'
  if (form.chatLlm.reasoningEffort !== savedEffort) {
    list.push({
      label: '思考等级',
      before: reasoningEffortLabels[savedEffort],
      after: reasoningEffortLabels[form.chatLlm.reasoningEffort],
    })
  }
  const savedFast = toTaskChoice(saved.chatLlm?.taskReasoningEffort?.fast)
  if (form.chatLlm.fastEffort !== savedFast) {
    list.push({
      label: '快速任务思考等级',
      before: savedFast === 'inherit' ? '跟随全局' : reasoningEffortLabels[savedFast],
      after:
        form.chatLlm.fastEffort === 'inherit'
          ? '跟随全局'
          : reasoningEffortLabels[form.chatLlm.fastEffort],
    })
  }
  const savedOrganize = toTaskChoice(saved.chatLlm?.taskReasoningEffort?.organize)
  if (form.chatLlm.organizeEffort !== savedOrganize) {
    list.push({
      label: '整理任务思考等级',
      before: savedOrganize === 'inherit' ? '跟随全局' : reasoningEffortLabels[savedOrganize],
      after:
        form.chatLlm.organizeEffort === 'inherit'
          ? '跟随全局'
          : reasoningEffortLabels[form.chatLlm.organizeEffort],
    })
  }
  return list
})

const scheduleDirtyChanges = computed<SaveBarChange[]>(() => {
  const saved = settingsQuery.data.value
  if (!saved) return []
  const list: SaveBarChange[] = []
  const savedMap = {
    standard: { enabled: saved.dream.enabled, intervalHours: saved.dream.intervalHours },
    crossMemory: {
      enabled: saved.dream.crossMemory?.enabled ?? false,
      intervalHours: saved.dream.crossMemory?.intervalHours ?? DEFAULT_CROSS_MEMORY_INTERVAL_HOURS,
    },
    tidy: {
      enabled: saved.dream.tidy?.enabled ?? false,
      intervalHours: saved.dream.tidy?.intervalHours ?? DEFAULT_TIDY_INTERVAL_HOURS,
    },
  }
  for (const row of scheduleRows.value) {
    const base = savedMap[row.key]
    if (row.draft.enabled !== base.enabled || row.draft.intervalHours !== base.intervalHours) {
      list.push({
        label: row.label,
        before: base.enabled ? `每 ${base.intervalHours} 小时` : '已关闭',
        after: row.draft.enabled ? `每 ${row.draft.intervalHours} 小时` : '已关闭',
      })
    }
  }
  return list
})

const activeDirtyChanges = computed(() => {
  if (props.section === 'embed') return embedDirtyChanges.value
  if (props.section === 'chat') return chatDirtyChanges.value
  return scheduleDirtyChanges.value
})

const activeDirtyCount = computed(() => activeDirtyChanges.value.length)

watch(
  () => activeDirtyCount.value > 0,
  (changed) => {
    dirtyModel.value = changed
  },
  { immediate: true },
)

const activeValidationProblem = computed(() => {
  if (props.section === 'embed') {
    if (
      form.embedding.enabled &&
      (!form.embedding.baseUrl.trim() || !form.embedding.model.trim())
    ) {
      return '启用嵌入模型时须填写接口地址与模型名称'
    }
    return null
  }
  if (props.section === 'chat') {
    if (form.chatLlm.enabled && (!form.chatLlm.baseUrl.trim() || !form.chatLlm.model.trim())) {
      return '启用对话模型时须填写接口地址与模型名称'
    }
    const hasExplicitThinking =
      form.chatLlm.reasoningEffort !== 'default' || activeOverrideCount.value > 0
    if (hasExplicitThinking && (!form.chatLlm.baseUrl.trim() || !form.chatLlm.model.trim())) {
      return '配置思考等级时须同时填写对话模型的接口地址与模型名称'
    }
    return null
  }
  for (const row of scheduleRows.value) {
    if (
      !Number.isFinite(row.draft.intervalHours) ||
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
  if (saving.value || !activeDirtyCount.value || activeValidationProblem.value) return
  saving.value = true
  const wasDreamEnabled = settingsQuery.data.value?.dream.enabled ?? false
  try {
    let saved: ModelsSettingsResponse
    if (props.section === 'embed') {
      saved = await api.saveModelsSettings({
        embedding: buildEndpointPayload(form.embedding),
      })
    } else if (props.section === 'chat') {
      saved = await api.saveModelsSettings({
        chatLlm: buildChatPayload(form.chatLlm),
      })
    } else {
      saved = await api.saveModelsSettings({
        dream: {
          enabled: form.dream.standard.enabled,
          intervalHours: Math.round(Number(form.dream.standard.intervalHours)),
          crossMemory: {
            enabled: form.dream.crossMemory.enabled,
            intervalHours: Math.round(Number(form.dream.crossMemory.intervalHours)),
          },
          tidy: {
            enabled: form.dream.tidy.enabled,
            intervalHours: Math.round(Number(form.dream.tidy.intervalHours)),
          },
        },
      })
    }
    queryClient.setQueryData(['models-settings'], saved)
    syncFromSaved(saved)
    if (props.section === 'embed') delete testResults.embedding
    else if (props.section === 'chat') delete testResults.chat_llm
    void queryClient.invalidateQueries({ queryKey: ME_KEY })
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    if (props.section === 'chat' && !wasDreamEnabled && saved.dream.enabled) {
      toast.add({ title: '对话模型设置已保存，已自动开启增量整理', color: 'success' })
    } else if (props.section === 'embed') {
      toast.add({ title: '嵌入模型设置已保存', color: 'success' })
    } else if (props.section === 'chat') {
      toast.add({ title: '对话模型设置已保存', color: 'success' })
    } else {
      toast.add({ title: '定时计划已保存', color: 'success' })
    }
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

function discardSection() {
  const saved = settingsQuery.data.value
  if (!saved) return
  if (props.section === 'embed') {
    syncEmbeddingFromSaved(saved)
    delete testResults.embedding
  } else if (props.section === 'chat') {
    syncChatFromSaved(saved)
    delete testResults.chat_llm
  } else {
    syncDreamFromSaved(saved)
  }
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
    toast.add({
      title:
        res.queued > 0 ? `已加入向量补齐队列（${res.queued} 条）` : '当前全部记忆均已完成向量索引',
      color: 'success',
    })
    void queryClient.invalidateQueries({ queryKey: ['models-settings'] })
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '触发补齐失败', color: 'error' })
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

const triggeringMode = ref<DreamMode | null>(null)
async function triggerDreamNow(mode: DreamMode, label: string) {
  if (triggeringMode.value) return
  triggeringMode.value = mode
  try {
    const res = await api.runDream({ mode })
    if (res.status === 'queued') {
      toast.add({
        title: `已将${label}加入后台队列${res.position ? `（第 ${res.position} 位）` : ''}`,
        color: 'success',
      })
    } else if (res.started) {
      toast.add({ title: `已开始${label}`, color: 'success' })
    } else {
      toast.add({ title: res.reason ?? `${label}未启动`, color: 'neutral' })
    }
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : `发起${label}失败`, color: 'error' })
  } finally {
    triggeringMode.value = null
  }
}
</script>

<template>
  <form class="editor-pane is-single-col" @submit.prevent="save">
    <!-- 顶部吸顶标题栏 -->
    <header class="editor-head">
      <div class="head-main">
        <div class="head-identity">
          <div class="head-title-row">
            <h1>
              {{
                section === 'embed' ? '嵌入与索引' : section === 'chat' ? '对话与整理' : '定时计划'
              }}
            </h1>
          </div>

          <div v-if="section === 'embed'" class="head-status-line">
            <span class="status-pill" :class="{ 'is-ok': form.embedding.enabled }">
              <span class="status-dot" aria-hidden="true" />
              <span>{{ form.embedding.enabled ? '已启用' : '已停用' }}</span>
            </span>
            <template v-if="coverage">
              <span class="status-sep" aria-hidden="true">·</span>
              <span class="tabular-nums">
                向量覆盖 {{ coverage.embedded }} / {{ coverage.total
                }}<template v-if="coveragePercent !== null">（{{ coveragePercent }}%）</template>
              </span>
            </template>
            <template v-if="form.embedding.model.trim()">
              <span class="status-sep" aria-hidden="true">·</span>
              <code class="font-mono">{{ form.embedding.model.trim() }}</code>
            </template>
          </div>

          <div v-else-if="section === 'chat'" class="head-status-line">
            <span class="status-pill" :class="{ 'is-ok': form.chatLlm.enabled }">
              <span class="status-dot" aria-hidden="true" />
              <span>{{ form.chatLlm.enabled ? '已启用' : '已停用' }}</span>
            </span>
            <template v-if="form.chatLlm.model.trim()">
              <span class="status-sep" aria-hidden="true">·</span>
              <code class="font-mono">{{ form.chatLlm.model.trim() }}</code>
            </template>
            <span class="status-sep" aria-hidden="true">·</span>
            <span>思考等级：{{ reasoningEffortLabels[form.chatLlm.reasoningEffort] }}</span>
          </div>

          <div v-else class="head-status-line">
            <span class="tabular-nums">已启用 {{ enabledScheduleCount }} / 3 项定时整理</span>
            <span class="status-sep" aria-hidden="true">·</span>
            <span>生成的建议均进入整理页待确认</span>
          </div>
        </div>

        <div class="head-actions">
          <UButton
            v-if="section === 'embed'"
            type="button"
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.activity"
            :loading="testing === 'embedding'"
            :disabled="!form.embedding.baseUrl.trim() || !form.embedding.model.trim()"
            class="shrink-0 whitespace-nowrap"
            @click="runTest('embedding')"
          >
            测试连接
          </UButton>
          <UButton
            v-else-if="section === 'chat'"
            type="button"
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.activity"
            :loading="testing === 'chat_llm'"
            :disabled="!form.chatLlm.baseUrl.trim() || !form.chatLlm.model.trim()"
            class="shrink-0 whitespace-nowrap"
            @click="runTest('chat_llm')"
          >
            测试连接
          </UButton>
          <UButton
            v-else
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.listChecks"
            :to="{ name: 'organize' }"
            class="shrink-0 whitespace-nowrap"
          >
            前往整理页
          </UButton>
        </div>
      </div>
    </header>

    <!-- 正文滚动纸面 -->
    <div class="editor-scroll">
      <div class="page-stack">
        <ReadFailureNote v-if="settingsQuery.isError.value" :query="settingsQuery" />
        <NoteLine v-if="!hasMasterKey && section !== 'schedule'" tone="warning" flush>
          未配置主密钥 KIOKU_MASTER_KEY，无法加密保存模型 API Key（无密钥的本地服务仍可填写地址）。
        </NoteLine>

        <div v-if="settingsQuery.isPending.value" class="space-y-4">
          <USkeleton v-for="n in 3" :key="n" class="h-24 w-full" />
        </div>

        <template v-else-if="settingsQuery.data.value">
          <!-- 子视图 1：嵌入与索引 -->
          <template v-if="section === 'embed'">
            <NoteLine
              v-if="testResults.embedding"
              :tone="testResults.embedding.ok ? 'success' : 'error'"
              flush
            >
              {{
                testResults.embedding.ok
                  ? `连接正常（${testResults.embedding.latencyMs} ms${testResults.embedding.dimensions ? `，${testResults.embedding.dimensions} 维` : ''}）`
                  : `连接失败：${testResults.embedding.error ?? '未知原因'}`
              }}
            </NoteLine>

            <!-- 向量覆盖率摘要块（对齐记忆详情 summary-block） -->
            <section v-if="coverage" class="summary-block" aria-label="向量索引覆盖率">
              <div class="summary-top">
                <div class="min-w-0">
                  <div class="summary-label">
                    <UIcon
                      :name="
                        backfillRunning
                          ? icons.loader
                          : coveragePercent === 100
                            ? icons.checkCircle
                            : icons.database
                      "
                      class="summary-label-icon"
                      :class="{
                        'is-complete': !backfillRunning && coveragePercent === 100,
                        'is-spinning': backfillRunning,
                      }"
                      aria-hidden="true"
                    />
                    <span>{{ backfillRunning ? '向量索引补齐中' : '向量索引覆盖率' }}</span>
                  </div>
                  <div class="summary-metrics">
                    <template v-if="backfillRunning && backfillState && backfillState.total > 0">
                      <strong class="summary-figure tabular-nums">
                        {{ backfillState.processed }} / {{ backfillState.total }}
                      </strong>
                      <span v-if="backfillPercent !== null" class="summary-sub tabular-nums">
                        （{{ backfillPercent }}%）
                      </span>
                    </template>
                    <template v-else>
                      <strong class="summary-figure tabular-nums">
                        {{ coverage.embedded }} / {{ coverage.total }}
                      </strong>
                      <span v-if="coveragePercent !== null" class="summary-sub tabular-nums">
                        （{{ coveragePercent }}%）
                      </span>
                    </template>
                    <span class="status-sep" aria-hidden="true">·</span>
                    <span class="summary-sub">停用嵌入模型后仍保留全文检索</span>
                  </div>
                </div>

                <UButton
                  v-if="backfillRunning"
                  type="button"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.stop"
                  :loading="cancellingBackfill"
                  class="shrink-0 whitespace-nowrap"
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
                  :disabled="!settingsQuery.data.value?.embedding?.enabled || activeDirtyCount > 0"
                  class="shrink-0 whitespace-nowrap"
                  @click="rebuildEmbeddings"
                >
                  {{ missingEmbeddings > 0 ? `补齐索引（${missingEmbeddings}）` : '复核索引' }}
                </UButton>
              </div>
              <div v-if="meterPercent !== null" class="coverage-track">
                <div class="coverage-fill" :style="{ width: `${meterPercent}%` }" />
              </div>
              <p v-if="activeDirtyCount > 0" class="summary-warn">
                请先保存下方配置更改后再发起向量补齐。
              </p>
            </section>

            <section class="paper-section">
              <SectionHeading title="嵌入模型配置" :icon="icons.sliders" :level="2">
                <template #actions>
                  <USwitch
                    v-model="form.embedding.enabled"
                    :label="form.embedding.enabled ? '已启用' : '已停用'"
                  />
                </template>
              </SectionHeading>

              <div class="grid gap-4 sm:grid-cols-2">
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
                <UFormField label="API Key" class="sm:col-span-2">
                  <template #hint>
                    <span
                      class="key-state-hint"
                      :class="{
                        'is-saved': form.embedding.hasApiKey && !form.embedding.clearKey,
                        'is-clearing': form.embedding.clearKey,
                      }"
                    >
                      {{
                        form.embedding.clearKey
                          ? '保存后将清除已存密钥'
                          : form.embedding.hasApiKey
                            ? '已保存密钥，留空保持不变'
                            : '未设置'
                      }}
                    </span>
                  </template>
                  <div class="flex gap-2">
                    <UInput
                      v-model="form.embedding.apiKey"
                      type="password"
                      :placeholder="
                        form.embedding.hasApiKey && !form.embedding.clearKey
                          ? '留空保持已保存的 API Key 不变'
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
                      :icon="icons.remove"
                      class="shrink-0 whitespace-nowrap"
                      @click="((form.embedding.clearKey = true), (form.embedding.apiKey = ''))"
                    >
                      清除密钥
                    </UButton>
                    <UButton
                      v-else-if="form.embedding.clearKey"
                      type="button"
                      size="sm"
                      color="neutral"
                      variant="ghost"
                      :icon="icons.undelete"
                      class="shrink-0 whitespace-nowrap"
                      @click="form.embedding.clearKey = false"
                    >
                      恢复保留
                    </UButton>
                  </div>
                </UFormField>
              </div>
            </section>
          </template>

          <!-- 子视图 2：对话与整理 -->
          <template v-else-if="section === 'chat'">
            <NoteLine
              v-if="testResults.chat_llm"
              :tone="testResults.chat_llm.ok ? 'success' : 'error'"
              flush
            >
              {{
                testResults.chat_llm.ok
                  ? `连接正常（${testResults.chat_llm.latencyMs} ms${formatChatProbeSuffix(testResults.chat_llm)}）`
                  : `连接失败：${testResults.chat_llm.error ?? '未知原因'}${formatChatProbeSuffix(testResults.chat_llm)}`
              }}
            </NoteLine>

            <section class="paper-section">
              <SectionHeading title="对话模型配置" :icon="icons.sparkles" :level="2">
                <template #actions>
                  <UButton
                    v-if="canReuseEmbeddingUrl"
                    type="button"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :icon="icons.copy"
                    class="shrink-0 whitespace-nowrap"
                    @click="reuseEmbeddingUrl"
                  >
                    复用嵌入地址
                  </UButton>
                  <USwitch
                    v-model="form.chatLlm.enabled"
                    :label="form.chatLlm.enabled ? '已启用' : '已停用'"
                  />
                </template>
              </SectionHeading>
              <p class="section-lead">
                用于自动生成会话摘要、随手记归并与整理建议；不配置时基础存储、双链与检索仍完整可用。
              </p>

              <div class="grid gap-4 sm:grid-cols-2">
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
                <UFormField label="API Key" class="sm:col-span-2">
                  <template #hint>
                    <span
                      class="key-state-hint"
                      :class="{
                        'is-saved': form.chatLlm.hasApiKey && !form.chatLlm.clearKey,
                        'is-clearing': form.chatLlm.clearKey,
                      }"
                    >
                      {{
                        form.chatLlm.clearKey
                          ? '保存后将清除已存密钥'
                          : form.chatLlm.hasApiKey
                            ? '已保存密钥，留空保持不变'
                            : '未设置'
                      }}
                    </span>
                  </template>
                  <div class="flex gap-2">
                    <UInput
                      v-model="form.chatLlm.apiKey"
                      type="password"
                      :placeholder="
                        form.chatLlm.hasApiKey && !form.chatLlm.clearKey
                          ? '留空保持已保存的 API Key 不变'
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
                      :icon="icons.remove"
                      class="shrink-0 whitespace-nowrap"
                      @click="((form.chatLlm.clearKey = true), (form.chatLlm.apiKey = ''))"
                    >
                      清除密钥
                    </UButton>
                    <UButton
                      v-else-if="form.chatLlm.clearKey"
                      type="button"
                      size="sm"
                      color="neutral"
                      variant="ghost"
                      :icon="icons.undelete"
                      class="shrink-0 whitespace-nowrap"
                      @click="form.chatLlm.clearKey = false"
                    >
                      恢复保留
                    </UButton>
                  </div>
                </UFormField>
              </div>
            </section>

            <section class="paper-section">
              <SectionHeading title="推理与思考等级" :icon="icons.sliders" :level="2" />

              <UFormField label="默认思考等级" :ui="{ labelWrapper: 'justify-start gap-1.5' }">
                <template #hint>
                  <Hint label="思考等级说明">
                    透传 OpenAI 兼容接口的 reasoning_effort 参数（none / minimal / low / medium /
                    high / xhigh /
                    max）；选「跟随默认」不附加该字段，开启后会按档位自动放宽输出上限。
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
              </UFormField>

              <!-- 按任务覆盖（默认收起，带内联摘要） -->
              <div class="attrs-collapse">
                <button
                  type="button"
                  class="attrs-toggle"
                  :aria-expanded="taskOverridesOpen"
                  @click="taskOverridesOpen = !taskOverridesOpen"
                >
                  <span class="attrs-toggle-lead">
                    <UIcon
                      :name="taskOverridesOpen ? icons.chevronDown : icons.chevronRight"
                      class="attrs-chevron"
                      aria-hidden="true"
                    />
                    <UIcon :name="icons.sliders" class="attrs-icon" aria-hidden="true" />
                    <span>按任务覆盖</span>
                    <span v-if="activeOverrideCount > 0" class="override-badge tabular-nums">
                      已设 {{ activeOverrideCount }} 项
                    </span>
                  </span>
                  <span class="attrs-summary">{{ overrideSummaryText }}</span>
                </button>

                <div v-if="taskOverridesOpen" class="attrs-body">
                  <div class="override-item">
                    <div class="override-meta">
                      <span class="override-title">
                        <UIcon
                          :name="icons.trigger"
                          class="override-title-icon"
                          aria-hidden="true"
                        />
                        <span>快速任务</span>
                      </span>
                      <span class="override-desc"
                        >随手记归并与会话摘要，建议关闭或设低以防超时</span
                      >
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
                      <span class="override-desc">
                        增量整理、查重与关联及规范整理，可按需提高推理深度
                      </span>
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
                    不同模型支持的最高档位不同（如 xhigh / max），调整后可点击顶部「测试连接」验证。
                  </p>
                </div>
              </div>
            </section>
          </template>

          <!-- 子视图 3：定时计划 -->
          <template v-else>
            <NoteLine v-if="!settingsQuery.data.value?.chatLlm?.enabled" tone="warning" flush>
              尚未启用对话模型，定时整理开启后不会实际执行。
              <template #actions>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.sparkles"
                  :to="settingsRoute('chat')"
                >
                  配置对话模型
                </UButton>
              </template>
            </NoteLine>

            <section class="paper-section">
              <SectionHeading title="自动整理周期" :icon="icons.clock" :level="2" />
              <p class="section-lead">
                三种整理各自独立计时；生成的建议均进入整理页待确认列表，确认后才写入记忆。
              </p>

              <div class="schedule-list">
                <div
                  v-for="row in scheduleRows"
                  :key="row.key"
                  class="schedule-row"
                  :class="{ 'is-disabled': !row.draft.enabled }"
                >
                  <div class="schedule-switch">
                    <USwitch v-model="row.draft.enabled" :aria-label="`启用定时${row.label}`" />
                  </div>

                  <div class="schedule-info">
                    <div class="schedule-title-row">
                      <UIcon :name="row.icon" class="schedule-icon" aria-hidden="true" />
                      <span class="schedule-name">{{ row.label }}</span>
                    </div>
                    <p class="schedule-desc">{{ row.desc }}</p>
                    <p class="schedule-run-meta">
                      <template v-if="row.lastAt">
                        <span>
                          上次：
                          <time :datetime="row.lastAt" :title="formatTime(row.lastAt)">
                            {{ formatRelative(row.lastAt, now) }}
                          </time>
                        </span>
                        <template v-if="row.latestRun">
                          <span
                            :class="{
                              'meta-ok': row.latestRun.outcome === 'ok',
                              'meta-warn': row.latestRun.outcome === 'partial',
                              'meta-err': row.latestRun.outcome === 'failed',
                            }"
                          >
                            （{{ dreamOutcomeLabels[row.latestRun.outcome]
                            }}<template v-if="row.latestRun.suggested > 0"
                              >，新增 {{ row.latestRun.suggested }} 条建议</template
                            >）
                          </span>
                        </template>
                      </template>
                      <span v-else>上次：尚未运行</span>
                      <template v-if="row.nextHint">
                        <span class="status-sep" aria-hidden="true">·</span>
                        <span>预计下次：{{ row.nextHint }}</span>
                      </template>
                    </p>
                  </div>

                  <div class="schedule-controls">
                    <div class="schedule-interval tabular-nums">
                      <span class="interval-label">每</span>
                      <UInputNumber
                        v-model="row.draft.intervalHours"
                        :min="DREAM_INTERVAL_HOURS_MIN"
                        :max="DREAM_INTERVAL_HOURS_MAX"
                        :disabled="!row.draft.enabled"
                        :aria-label="`${row.label}间隔小时`"
                        size="sm"
                        class="w-24"
                      />
                      <span class="interval-label">小时</span>
                      <span class="interval-human">
                        {{ formatHoursHuman(row.draft.intervalHours) }}
                      </span>
                    </div>

                    <UButton
                      type="button"
                      size="xs"
                      color="neutral"
                      variant="outline"
                      :icon="icons.refresh"
                      :loading="triggeringMode === row.mode"
                      :disabled="!settingsQuery.data.value?.chatLlm?.enabled"
                      class="shrink-0 whitespace-nowrap"
                      @click="triggerDreamNow(row.mode, row.label)"
                    >
                      立即运行
                    </UButton>
                  </div>
                </div>
              </div>
            </section>
          </template>
        </template>
      </div>
    </div>

    <!-- 全宽吸底 SaveBar -->
    <div v-if="settingsQuery.data.value" class="savebar-dock">
      <div class="savebar-dock-inner">
        <SaveBar
          always-show
          :count="activeDirtyCount"
          :changes="activeDirtyChanges"
          :saving="saving"
          :problem="activeValidationProblem"
          discard-label="重置"
          save-label="保存更改"
          @discard="discardSection"
        />
      </div>
    </div>
  </form>
</template>

<style scoped>
.editor-pane {
  --canvas-max: 880px;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg);
}
.editor-head {
  flex: none;
  padding: 16px 28px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.head-main {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 16px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.head-identity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 18rem;
}
.head-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.head-title-row h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 500;
  line-height: 1.35;
  color: var(--ui-text-highlighted);
}
.head-status-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 7px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.status-sep {
  color: var(--ui-border-accented);
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.status-pill.is-ok {
  border-color: var(--ui-success);
  color: var(--ui-success);
}
.status-dot {
  display: inline-block;
  flex: none;
  width: 6px;
  height: 6px;
  background: currentColor;
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: none;
}
.editor-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 28px 32px;
}
.page-stack {
  display: flex;
  flex-direction: column;
  gap: 24px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.paper-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.section-lead {
  margin: -4px 0 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}

/* 向量覆盖率摘要块（对齐记忆详情 summary-block） */
.summary-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.summary-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 14px;
}
.summary-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.summary-label-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.summary-label-icon.is-complete {
  color: var(--ui-success);
}
.summary-label-icon.is-spinning {
  color: var(--ui-text-highlighted);
  animation: model-spin 1.1s linear infinite;
}
@keyframes model-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .summary-label-icon.is-spinning {
    animation: none;
  }
}
.summary-metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}
.summary-figure {
  font-size: 18px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.summary-sub {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.summary-warn {
  margin: 0;
  font-size: 12px;
  color: var(--ui-warning);
}
.coverage-track {
  position: relative;
  height: 5px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  overflow: hidden;
}
.coverage-fill {
  height: 100%;
  background: var(--ui-rule);
  transition: width 240ms ease;
}

.key-state-hint {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.key-state-hint.is-saved {
  color: var(--ui-success);
}
.key-state-hint.is-clearing {
  color: var(--ui-warning);
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
.attrs-collapse {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.attrs-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  font-size: 13px;
  color: var(--ui-text-highlighted);
  cursor: pointer;
}
.attrs-toggle:hover {
  background: var(--ui-bg-elevated);
}
.attrs-toggle-lead {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.attrs-chevron,
.attrs-icon {
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
.attrs-summary {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.attrs-body {
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
  margin: 0;
  padding-top: 8px;
  border-top: 1px dashed var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}

/* 三模式定时整理（无外层套娃框，纯 1px 行分隔） */
.schedule-list {
  display: flex;
  flex-direction: column;
}
.schedule-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 14px 2px;
  border-bottom: 1px solid var(--ui-border);
}
.schedule-row.is-disabled .schedule-name {
  color: var(--ui-text-muted);
}
.schedule-switch {
  display: flex;
  align-items: center;
}
.schedule-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
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
  color: var(--ui-text-dimmed);
}
.schedule-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.schedule-desc {
  margin: 0;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.schedule-run-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.meta-ok {
  color: var(--ui-success);
}
.meta-warn {
  color: var(--ui-warning);
}
.meta-err {
  color: var(--ui-error);
}
.schedule-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 10px 14px;
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
.interval-human {
  min-width: 3.5rem;
  font-size: 12px;
  color: var(--ui-text-dimmed);
  white-space: nowrap;
}

/* 全宽吸底 SaveBar 容器 */
.savebar-dock {
  flex: none;
  border-top: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
  padding-inline: 28px;
}
.savebar-dock-inner {
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.savebar-dock-inner :deep(.save-bar) {
  position: static;
  margin-top: 0;
  border: 0;
  background: transparent;
}
.savebar-dock-inner :deep(.save-main) {
  padding-inline: 0;
}
.savebar-dock-inner :deep(.save-diff-wrap) {
  padding-inline: 0;
  background: transparent;
}

@media (max-width: 860px) {
  .schedule-row {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
  }
  .schedule-controls {
    grid-column: 2;
    justify-content: flex-start;
  }
}
@media (max-width: 767.98px) {
  .editor-head {
    padding: 12px 14px 10px;
  }
  .head-title-row h1 {
    font-size: 19px;
  }
  .editor-scroll {
    padding: 14px 14px 28px;
  }
  .savebar-dock {
    padding-inline: 14px;
  }
}
</style>
