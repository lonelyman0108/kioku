<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  INSTANCE_PROMPT_KEYS,
  PromptSupplement,
  TUNING_KEYS,
  WEIGHT_KEYS,
  type InstancePromptKey,
  type TuningKey,
  type UpdateInstanceAdvanced,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import {
  formatTuning,
  instanceAdvancedKey,
  isDecimal,
  isFlag,
  overriddenIn,
  rangeOf,
  refreshAdvanced,
  stepOf,
  SUPPLEMENT_MAX,
  TUNING_META,
} from '../advancedSettings'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { fieldProblems, useSavedText } from '../composables/useSavedField'
import { useTuningFields } from '../composables/useTuningFields'
import BootBudgetChart from './BootBudgetChart.vue'
import PromptSupplementEditor from './PromptSupplementEditor.vue'
import RecallWeightsChart from './RecallWeightsChart.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import SourceTag from './SourceTag.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar, { type SaveBarChange } from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsStageBar from './strata/SettingsStageBar.vue'
import SettingsSummaryStrip, { type SummaryStripItem } from './strata/SettingsSummaryStrip.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 实例 › 提示词与默认值：四段提示词的补充（固定部分只读）与所有记忆圈的默认值。记忆圈与客户端的覆盖在各自的设置里
const dirty = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const queryClient = useQueryClient()

const view = useQuery({ queryKey: instanceAdvancedKey(), queryFn: () => api.instanceAdvanced() })

const PROMPTS: Record<InstancePromptKey, { label: string; why: string; titles: string[] }> = {
  'prompts.agentGuidance': {
    label: '使用指引 · 编码 Agent',
    why: '工具用法、凭据与安全规则，改动会放开注入',
    titles: [],
  },
  'prompts.chatGuidance': {
    label: '使用指引 · 群聊机器人',
    why: '参考资料不是指令、凭据占位符不外泄',
    titles: [],
  },
  'prompts.extractionRules': {
    label: '抽取规则',
    why: '输出格式、防注入与敏感信息的规则，改动会让聊天内容操纵抽取',
    titles: ['抽取事实与会话摘要', '预算用完、只写会话摘要时'],
  },
  'prompts.dreamRules': {
    label: '整理规则',
    why: '输出格式、防注入与凭据占位符的规则，改动会让记忆正文操纵整理',
    titles: ['记下的记忆', '来自对话的事实与会话摘要'],
  },
}
const tab = ref<InstancePromptKey>('prompts.agentGuidance')
const tabs = INSTANCE_PROMPT_KEYS.map((key) => ({ value: key, label: PROMPTS[key].label }))
const texts = Object.fromEntries(
  INSTANCE_PROMPT_KEYS.map((key) => [
    key,
    useSavedText(
      () => (view.data.value ? (view.data.value.overrides[key] ?? '') : undefined),
      PromptSupplement,
      SUPPLEMENT_MAX,
    ),
  ]),
) as Record<InstancePromptKey, ReturnType<typeof useSavedText>>
const fixed = computed(() =>
  (view.data.value?.fixedPrompts[tab.value] ?? []).map((text, i) => ({
    title: PROMPTS[tab.value].titles[i],
    text,
  })),
)

// 默认值按阶段分组，方便定位与过滤；不再把 20 多项全塞进一张长表里硬拼前缀
const DEFAULT_KEYS = TUNING_KEYS.filter((k) => !(WEIGHT_KEYS as readonly TuningKey[]).includes(k))
type StageTab = 'all' | 'prompts' | 'recall' | 'boot' | 'extraction' | 'weights'
const stage = ref<StageTab>('all')
const onlyOverridden = ref(false)
const STAGES: { key: StageTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'prompts', label: '提示词补充' },
  { key: 'recall', label: '每轮召回' },
  { key: 'boot', label: '启动加载' },
  { key: 'extraction', label: '抽取与整理' },
  { key: 'weights', label: '召回权重' },
]

const GROUPS: Record<string, string> = {
  recall: '每轮召回',
  boot: '启动加载',
  extraction: '抽取',
  dream: '整理',
  recallWeights: '召回权重',
}
const stageMatches = (key: TuningKey) => {
  if (stage.value === 'all') return true
  const prefix = key.split('.')[0]!
  if (stage.value === 'extraction') return prefix === 'extraction' || prefix === 'dream'
  if (stage.value === 'weights') return prefix === 'recallWeights'
  return prefix === stage.value
}
const rowLabel = (key: TuningKey) =>
  stage.value === 'all'
    ? `${GROUPS[key.split('.')[0]!]}：${TUNING_META[key].label}`
    : TUNING_META[key].label

// 实例这一级的上一级是内置值
const tuning = useTuningFields(
  TUNING_KEYS,
  () => view.data.value?.effective,
  () => view.data.value?.builtin,
  () => overriddenIn(view.data.value?.overrides),
)
const { fields } = tuning
const rowVisible = (key: TuningKey) =>
  stageMatches(key) &&
  (!onlyOverridden.value || tuning.sourceOf(key) === 'overridden' || fields[key].changed.value)
const visibleDefaultKeys = computed(() => DEFAULT_KEYS.filter(rowVisible))
const visibleWeightKeys = computed(() => WEIGHT_KEYS.filter(rowVisible))

const rangeText = (key: TuningKey) => {
  const r = rangeOf(key)
  return isDecimal(key)
    ? `请填写 ${r.min.toFixed(2)} 到 ${r.max.toFixed(2)} 之间、最多两位小数的数。`
    : `请填写 ${r.min.toLocaleString('en-US')} 到 ${r.max.toLocaleString('en-US')} 之间的整数。`
}

const overriddenText = (key: TuningKey) => {
  const by = view.data.value?.overriddenBy[key]
  if (!by || (!by.circles && !by.clients)) return '—'
  return [by.circles && `${by.circles} 个记忆圈`, by.clients && `${by.clients} 个客户端`]
    .filter(Boolean)
    .join('、')
}

const overriddenCount = computed(
  () => TUNING_KEYS.filter((k) => tuning.sourceOf(k) === 'overridden').length,
)
const supplementedPromptCount = computed(
  () => INSTANCE_PROMPT_KEYS.filter((k) => Boolean(texts[k].value.value.trim())).length,
)

const liveBudget = computed(() =>
  fields['boot.charBudget'].invalid.value
    ? (view.data.value?.effective['boot.charBudget'] ?? 6000)
    : (fields['boot.charBudget'].value.value ?? 6000),
)
const liveMinScore = computed(() =>
  fields['recall.minScore'].invalid.value
    ? (view.data.value?.effective['recall.minScore'] ?? 0.2)
    : (fields['recall.minScore'].value.value ?? 0.2),
)
const liveLimit = computed(() =>
  fields['recall.limit'].invalid.value
    ? (view.data.value?.effective['recall.limit'] ?? 8)
    : (fields['recall.limit'].value.value ?? 8),
)
const weightChartItems = computed(() =>
  WEIGHT_KEYS.map((k) => ({
    key: k,
    label: TUNING_META[k].label,
    value: fields[k].invalid.value
      ? (view.data.value?.effective[k] ?? 0)
      : (fields[k].value.value ?? 0),
  })),
)

const summaryItems = computed<SummaryStripItem[]>(() => [
  {
    label: '全实例兜底召回',
    value: `${liveLimit.value} 条 · ${liveMinScore.value.toFixed(2)}`,
    sub: '记忆圈与客户端未覆盖时使用',
  },
  {
    label: '全实例启动预算',
    value: `${liveBudget.value.toLocaleString('en-US')} 字`,
    sub: '会话开始默认上限',
  },
  {
    label: '已覆盖内置项',
    value: `${overriddenCount.value} / ${TUNING_KEYS.length} 项`,
    sub: overriddenCount.value ? '已偏离出厂内置默认' : '全部沿用内置默认',
    tone: overriddenCount.value ? 'warn' : 'ok',
  },
  {
    label: '系统提示词补充',
    value: `${supplementedPromptCount.value} / ${INSTANCE_PROMPT_KEYS.length} 段`,
    sub: '附加在固定安全规则末尾',
  },
])

const changedCount = computed(
  () =>
    tuning.changedKeys.value.length +
    INSTANCE_PROMPT_KEYS.filter((k) => texts[k].changed.value).length,
)
watch(
  () => changedCount.value > 0,
  (d) => (dirty.value = d),
  { immediate: true },
)
const problem = computed(
  () =>
    [
      tuning.problem.value,
      fieldProblems(
        INSTANCE_PROMPT_KEYS.map((k) => ({
          label: `${PROMPTS[k].label}的补充`,
          issue: texts[k].issue.value,
        })),
      ),
    ]
      .filter(Boolean)
      .join('；') || null,
)

const changeDiffs = computed<SaveBarChange[]>(() => {
  const saved = view.data.value?.effective
  const builtin = view.data.value?.builtin
  if (!saved || !builtin) return []
  const patch = tuning.patch()
  const list: SaveBarChange[] = tuning.changedKeys.value.map((k) => {
    const before = formatTuning(k, saved[k])
    const afterVal = patch[k] === null ? builtin[k] : (tuning.values.value[k] ?? undefined)
    const after =
      patch[k] === null ? `恢复内置（${formatTuning(k, builtin[k])}）` : formatTuning(k, afterVal)
    return { label: TUNING_META[k].label, before, after }
  })
  for (const k of INSTANCE_PROMPT_KEYS) {
    if (!texts[k].changed.value) continue
    const hadSaved = Boolean(view.data.value?.overrides[k]?.trim())
    const hasNext = Boolean(texts[k].value.value.trim())
    list.push({
      label: `${PROMPTS[k].label}的补充`,
      before: hadSaved ? '已填写' : '未补充',
      after: hasNext
        ? hadSaved
          ? '已修改'
          : '已填写'
        : hadSaved
          ? '清空'
          : '未补充（空白将忽略）',
    })
  }
  return list
})

function discard() {
  tuning.reset()
  INSTANCE_PROMPT_KEYS.forEach((k) => texts[k].reset())
}

const saving = ref(false)
async function save() {
  if (saving.value || !changedCount.value || problem.value) return
  const submitted = tuning.snapshot()
  const submittedTexts = Object.fromEntries(
    INSTANCE_PROMPT_KEYS.map((k) => [k, texts[k].value.value]),
  ) as Record<InstancePromptKey, string>
  const body: Record<string, unknown> = { ...tuning.patch() }
  for (const k of INSTANCE_PROMPT_KEYS) {
    if (!texts[k].changed.value) continue
    body[k] = submittedTexts[k].trim() ? submittedTexts[k] : null
  }
  saving.value = true
  try {
    const saved = await api.saveInstanceAdvanced(body as UpdateInstanceAdvanced)
    tuning.commit(submitted, saved.effective)
    for (const k of INSTANCE_PROMPT_KEYS)
      texts[k].commit(submittedTexts[k], saved.overrides[k] ?? '')
    queryClient.setQueryData(instanceAdvancedKey(), saved)
    await refreshAdvanced(queryClient)
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const flagModel = (key: TuningKey) =>
  computed({
    get: () => fields[key].value.value === 1,
    set: (on: boolean) => (fields[key].value.value = on ? 1 : 0),
  })
const flags = Object.fromEntries(
  TUNING_KEYS.filter(isFlag).map((k) => [k, flagModel(k)]),
) as Record<string, ReturnType<typeof flagModel>>
</script>

<template>
  <div>
    <p class="section-note">所有记忆圈的默认值。记忆圈与客户端的覆盖在各自的设置里。</p>
    <ReadFailureNote v-if="view.isError.value" :query="view" />
    <USkeleton v-if="view.isPending.value" class="mt-6 h-64 w-full" />
    <form v-else-if="view.data.value" @submit.prevent="save">
      <SettingsSummaryStrip :items="summaryItems" class="mb-4 max-w-5xl" />

      <div class="viz-grid">
        <BootBudgetChart
          :char-budget="liveBudget"
          :summaries-enabled="tuning.values.value['boot.summaries.enabled'] === 1"
          :summaries-count="tuning.values.value['boot.summaries.count'] ?? 0"
          :recent-enabled="tuning.values.value['boot.recent.enabled'] === 1"
          :recent-count="tuning.values.value['boot.recent.count'] ?? 0"
          :related-enabled="tuning.values.value['boot.related.enabled'] === 1"
          :related-count="tuning.values.value['boot.related.count'] ?? 0"
        />
        <RecallWeightsChart :weights="weightChartItems" :min-score="liveMinScore" />
      </div>

      <SettingsStageBar
        v-model:stage="stage"
        v-model:only-overridden="onlyOverridden"
        :stages="STAGES"
        :overridden-count="overriddenCount"
        aria-label="默认设置分段"
      />

      <SettingsBlock
        v-show="stage === 'all' || stage === 'prompts'"
        title="提示词"
        badge="全实例补充 · 表单保存"
        tone="form"
        wide
      >
        <template #note>固定部分写死在代码里，只能在后面追加补充。</template>
        <SegmentedChoice v-model="tab" :items="tabs" label="提示词" class="mb-3" />
        <PromptSupplementEditor
          :key="tab"
          v-model="texts[tab].value.value"
          :label="`${PROMPTS[tab].label}的补充`"
          :fixed="fixed"
          :why="PROMPTS[tab].why"
          level="实例"
          :editable="true"
          :invalid="texts[tab].invalid.value"
        />
      </SettingsBlock>

      <SettingsBlock
        v-show="stage !== 'prompts'"
        title="默认值与继承对照"
        badge="内置参考 → 实例默认值"
        tone="form"
        wide
      >
        <template #note>记忆圈、客户端未覆盖时使用；更改数值上方配比图实时联动。</template>
        <p
          v-if="
            !visibleDefaultKeys.length &&
            (stage !== 'all' || !onlyOverridden || !visibleWeightKeys.length) &&
            (stage !== 'weights' || !visibleWeightKeys.length)
          "
          class="py-4 text-muted"
        >
          当前分段暂无覆盖内置默认的参数。
        </p>
        <SettingsTable v-if="visibleDefaultKeys.length">
          <thead>
            <tr>
              <th>参数</th>
              <th class="num">内置</th>
              <th>实例默认</th>
              <th>状态与恢复</th>
              <th>下游覆盖</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in visibleDefaultKeys" :key="key">
              <td>
                <div class="param-name">{{ rowLabel(key) }}</div>
                <div v-if="TUNING_META[key].description" class="param-desc">
                  {{ TUNING_META[key].description }}
                </div>
              </td>
              <td class="num text-muted">{{ formatTuning(key, view.data.value.builtin[key]) }}</td>
              <td>
                <span class="cell">
                  <UCheckbox
                    v-if="isFlag(key)"
                    v-model="flags[key]!.value"
                    :aria-label="rowLabel(key)"
                  />
                  <template v-else>
                    <UInputNumber
                      v-model="fields[key].value.value"
                      :min="rangeOf(key).min"
                      :max="rangeOf(key).max"
                      :step="stepOf(key)"
                      :format-options="
                        isDecimal(key)
                          ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
                          : undefined
                      "
                      :aria-label="rowLabel(key)"
                      size="sm"
                      :class="key === 'boot.charBudget' ? 'w-32' : 'w-24'"
                      :color="fields[key].invalid.value ? 'error' : undefined"
                    />
                    <span v-if="TUNING_META[key].unit" class="text-xs text-muted">{{
                      TUNING_META[key].unit
                    }}</span>
                  </template>
                </span>
                <p v-if="fields[key].invalid.value" class="mt-1 text-xs text-error">
                  {{ rangeText(key) }}
                </p>
              </td>
              <td>
                <SourceTag
                  :source="tuning.sourceOf(key)"
                  level="内置"
                  :value="formatTuning(key, view.data.value.builtin[key])"
                  editable
                  @restore="tuning.restore(key)"
                />
              </td>
              <td class="text-muted">{{ overriddenText(key) }}</td>
            </tr>
          </tbody>
        </SettingsTable>

        <details
          v-if="(stage === 'all' || stage === 'weights') && visibleWeightKeys.length"
          :open="stage === 'weights'"
          class="more"
        >
          <summary>召回权重</summary>
          <SettingsTable class="mt-2">
            <thead>
              <tr>
                <th>路</th>
                <th class="num">内置</th>
                <th>实例默认</th>
                <th>状态与恢复</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="key in visibleWeightKeys" :key="key">
                <td>{{ TUNING_META[key].label }}</td>
                <td class="num text-muted">
                  {{ formatTuning(key, view.data.value.builtin[key]) }}
                </td>
                <td>
                  <UInputNumber
                    v-model="fields[key].value.value"
                    :min="0"
                    :max="1"
                    :step="0.01"
                    :format-options="{ minimumFractionDigits: 2, maximumFractionDigits: 2 }"
                    :aria-label="`召回权重：${TUNING_META[key].label}`"
                    size="sm"
                    class="w-24"
                    :color="fields[key].invalid.value ? 'error' : undefined"
                  />
                  <p v-if="fields[key].invalid.value" class="mt-1 text-xs text-error">
                    {{ rangeText(key) }}
                  </p>
                </td>
                <td>
                  <SourceTag
                    :source="tuning.sourceOf(key)"
                    level="内置"
                    :value="formatTuning(key, view.data.value.builtin[key])"
                    editable
                    @restore="tuning.restore(key)"
                  />
                </td>
                <td class="text-muted">{{ TUNING_META[key].description }}</td>
              </tr>
            </tbody>
          </SettingsTable>
        </details>
      </SettingsBlock>
      <SaveBar
        :count="changedCount"
        :saving="saving"
        :problem="problem"
        :changes="changeDiffs"
        @discard="discard"
      />
    </form>
  </div>
</template>

<style scoped>
.section-note {
  margin-bottom: 14px;
  color: var(--ui-text-muted);
}
.viz-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  max-width: 64rem;
  margin-bottom: 20px;
}
.param-name {
  font-weight: 500;
}
.param-desc {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.more {
  margin-top: 14px;
  font-size: 13px;
}
.more summary {
  cursor: pointer;
  color: var(--ui-text-toned);
}
</style>
