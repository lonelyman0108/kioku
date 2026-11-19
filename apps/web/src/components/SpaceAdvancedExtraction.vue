<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  DREAM_KEYS,
  EXTRACTION_KEYS,
  PromptSupplement,
  type TuningKey,
  type UpdateCircleAdvanced,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import {
  circleAdvancedKey,
  formatTuning,
  overriddenAt,
  refreshAdvanced,
  SUPPLEMENT_MAX,
  TUNING_META,
} from '../advancedSettings'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { fieldProblems, useSavedText } from '../composables/useSavedField'
import { useTuningFields } from '../composables/useTuningFields'
import PromptSupplementEditor from './PromptSupplementEditor.vue'
import TuningRow from './TuningRow.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar, { type SaveBarChange } from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsStageBar from './strata/SettingsStageBar.vue'

// 抽取与整理的高级项：每批轮数、空闲时长、会话摘要有效期、整理的请求次数与建议条数，以及两段规则的补充。
// 没覆盖的沿用实例默认；只有记忆圈所有者能改
const props = defineProps<{ circleId: string }>()
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const queryClient = useQueryClient()

const view = useQuery({
  queryKey: computed(() => circleAdvancedKey(props.circleId)),
  enabled: computed(() => Boolean(props.circleId)),
  queryFn: ({ queryKey: [, , cid] }) => api.circleAdvanced(cid),
})
const editable = computed(() => view.data.value?.canEdit ?? false)

const EXTRACTION = EXTRACTION_KEYS
const DREAM = DREAM_KEYS
const KEYS = [...EXTRACTION, ...DREAM] as const
const tuning = useTuningFields(
  KEYS,
  () => view.data.value?.effective,
  () => view.data.value?.instance,
  () => overriddenAt(view.data.value?.sources, 'circle'),
)
const { fields } = tuning
const rules = {
  extraction: useSavedText(
    () =>
      view.data.value ? (view.data.value.overrides['prompts.extractionRules'] ?? '') : undefined,
    PromptSupplement,
    SUPPLEMENT_MAX,
  ),
  dream: useSavedText(
    () => (view.data.value ? (view.data.value.overrides['prompts.dreamRules'] ?? '') : undefined),
    PromptSupplement,
    SUPPLEMENT_MAX,
  ),
}
const changedCount = computed(
  () =>
    tuning.changedKeys.value.length +
    Number(rules.extraction.changed.value) +
    Number(rules.dream.changed.value),
)
watch(
  () => changedCount.value > 0,
  (d) => (dirtyModel.value = d),
  { immediate: true },
)
const problem = computed(
  () =>
    [
      tuning.problem.value,
      fieldProblems([
        { label: '抽取规则的补充', issue: rules.extraction.issue.value },
        { label: '整理规则的补充', issue: rules.dream.issue.value },
      ]),
    ]
      .filter(Boolean)
      .join('；') || null,
)

type StageTab = 'all' | 'extraction' | 'dream'
const stage = ref<StageTab>('all')
const onlyOverridden = ref(false)
const STAGES: { key: StageTab; label: string }[] = [
  { key: 'all', label: '全部高级项' },
  { key: 'extraction', label: '抽取参数与规则' },
  { key: 'dream', label: '整理参数与规则' },
]
const overriddenCount = computed(
  () =>
    KEYS.filter((k) => tuning.sourceOf(k) === 'overridden').length +
    Number(Boolean(rules.extraction.value.value.trim())) +
    Number(Boolean(rules.dream.value.value.trim())),
)

const inheritedOf = (key: TuningKey) => view.data.value?.instance[key] ?? 0
const row = (key: (typeof KEYS)[number]) => ({
  setting: key,
  invalid: fields[key].invalid.value,
  source: tuning.sourceOf(key),
  inherited: inheritedOf(key),
})
const rowVisible = (key: (typeof KEYS)[number]) =>
  !onlyOverridden.value || tuning.sourceOf(key) === 'overridden' || fields[key].changed.value

const showExtractionPrompt = computed(
  () =>
    !onlyOverridden.value ||
    Boolean(view.data.value?.overrides['prompts.extractionRules']?.trim()) ||
    Boolean(rules.extraction.value.value.trim()) ||
    rules.extraction.changed.value,
)
const showDreamPrompt = computed(
  () =>
    !onlyOverridden.value ||
    Boolean(view.data.value?.overrides['prompts.dreamRules']?.trim()) ||
    Boolean(rules.dream.value.value.trim()) ||
    rules.dream.changed.value,
)
const extractionBlockEmpty = computed(
  () => !EXTRACTION.some(rowVisible) && !showExtractionPrompt.value,
)
const dreamBlockEmpty = computed(() => !DREAM.some(rowVisible) && !showDreamPrompt.value)

function promptDiff(label: string, savedText: string | undefined, nextText: string): SaveBarChange {
  const hadSaved = Boolean(savedText?.trim())
  const hasNext = Boolean(nextText.trim())
  return {
    label,
    before: hadSaved ? '已填写' : '未补充',
    after: hasNext ? (hadSaved ? '已修改' : '已填写') : hadSaved ? '清空' : '未补充（空白将忽略）',
  }
}

const changeDiffs = computed<SaveBarChange[]>(() => {
  const saved = view.data.value?.effective
  if (!saved) return []
  const patch = tuning.patch()
  const list: SaveBarChange[] = tuning.changedKeys.value.map((k) => {
    const before = formatTuning(k, saved[k])
    const afterVal = patch[k] === null ? inheritedOf(k) : (tuning.values.value[k] ?? undefined)
    const after =
      patch[k] === null
        ? `沿用实例（${formatTuning(k, inheritedOf(k))}）`
        : formatTuning(k, afterVal)
    return { label: TUNING_META[k].label, before, after }
  })
  if (rules.extraction.changed.value) {
    list.push(
      promptDiff(
        '抽取规则的补充',
        view.data.value?.overrides['prompts.extractionRules'],
        rules.extraction.value.value,
      ),
    )
  }
  if (rules.dream.changed.value) {
    list.push(
      promptDiff(
        '整理规则的补充',
        view.data.value?.overrides['prompts.dreamRules'],
        rules.dream.value.value,
      ),
    )
  }
  return list
})

function discard() {
  tuning.reset()
  rules.extraction.reset()
  rules.dream.reset()
}

const saving = ref(false)
async function save() {
  if (saving.value || !changedCount.value || problem.value) return
  const cid = props.circleId
  const submitted = tuning.snapshot()
  const extraction = rules.extraction.value.value
  const dream = rules.dream.value.value
  const body: Record<string, unknown> = { ...tuning.patch() }
  // 补充为空就是去掉这一级的补充
  if (rules.extraction.changed.value)
    body['prompts.extractionRules'] = extraction.trim() ? extraction : null
  if (rules.dream.changed.value) body['prompts.dreamRules'] = dream.trim() ? dream : null
  saving.value = true
  try {
    const saved = await api.saveCircleAdvanced(cid, body as UpdateCircleAdvanced)
    if (cid === props.circleId) {
      tuning.commit(submitted, saved.effective)
      rules.extraction.commit(extraction, saved.overrides['prompts.extractionRules'] ?? '')
      rules.dream.commit(dream, saved.overrides['prompts.dreamRules'] ?? '')
    }
    queryClient.setQueryData(circleAdvancedKey(cid), saved)
    await refreshAdvanced(queryClient)
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const fixedOf = (key: 'prompts.extractionRules' | 'prompts.dreamRules', titles: string[]) =>
  (view.data.value?.fixedPrompts[key] ?? []).map((text, i) => ({ title: titles[i], text }))
</script>

<template>
  <div>
    <ReadFailureNote v-if="view.isError.value" :query="view" />
    <USkeleton v-if="view.isPending.value" class="mt-4 h-48 w-full" />
    <form v-else-if="view.data.value" @submit.prevent="save">
      <SettingsStageBar
        v-model:stage="stage"
        v-model:only-overridden="onlyOverridden"
        :stages="STAGES"
        :overridden-count="overriddenCount"
        aria-label="高级设置分段"
      />

      <SettingsBlock
        v-show="stage === 'all' || stage === 'extraction'"
        title="抽取的高级项"
        :badge="editable ? '记忆圈所有者 · 表单保存' : '仅记忆圈所有者可修改'"
        :tone="editable ? 'form' : 'readonly'"
        wide
      >
        <template #note>未覆盖的项沿用实例默认。</template>
        <p v-if="extractionBlockEmpty" class="py-3 text-muted">
          当前分段暂无已覆盖实例默认的参数或补充。
        </p>
        <TuningRow
          v-for="key in EXTRACTION"
          v-show="rowVisible(key)"
          :key="key"
          v-model="fields[key].value.value"
          v-bind="row(key)"
          level="实例"
          :editable="editable"
          @restore="tuning.restore(key)"
        />
        <div v-show="showExtractionPrompt">
          <h4 class="sub-heading">抽取规则的补充</h4>
          <PromptSupplementEditor
            v-model="rules.extraction.value.value"
            label="抽取规则的补充"
            :fixed="
              fixedOf('prompts.extractionRules', ['抽取事实与会话摘要', '预算用完、只写会话摘要时'])
            "
            why="输出格式、防注入与敏感信息的规则，改动会让聊天内容操纵抽取"
            :inherited="{
              level: '实例',
              text: view.data.value.instancePrompts['prompts.extractionRules'],
            }"
            level="记忆圈"
            :editable="editable"
            :invalid="rules.extraction.invalid.value"
          />
        </div>
      </SettingsBlock>
      <SettingsBlock
        v-show="stage === 'all' || stage === 'dream'"
        title="整理的高级项"
        :badge="editable ? '记忆圈所有者 · 表单保存' : '仅记忆圈所有者可修改'"
        :tone="editable ? 'form' : 'readonly'"
        wide
      >
        <p v-if="dreamBlockEmpty" class="py-3 text-muted">
          当前分段暂无已覆盖实例默认的参数或补充。
        </p>
        <TuningRow
          v-for="key in DREAM"
          v-show="rowVisible(key)"
          :key="key"
          v-model="fields[key].value.value"
          v-bind="row(key)"
          level="实例"
          :editable="editable"
          @restore="tuning.restore(key)"
        />
        <div v-show="showDreamPrompt">
          <h4 class="sub-heading">整理规则的补充</h4>
          <PromptSupplementEditor
            v-model="rules.dream.value.value"
            label="整理规则的补充"
            :fixed="fixedOf('prompts.dreamRules', ['记下的记忆', '来自对话的事实与会话摘要'])"
            why="输出格式、防注入与凭据占位符的规则，改动会让记忆正文操纵整理"
            :inherited="{
              level: '实例',
              text: view.data.value.instancePrompts['prompts.dreamRules'],
            }"
            level="记忆圈"
            :editable="editable"
            :invalid="rules.dream.invalid.value"
          />
        </div>
      </SettingsBlock>
      <p v-if="!editable" class="pt-6 text-muted">仅记忆圈所有者可修改。</p>
      <SaveBar
        v-if="editable"
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
.sub-heading {
  margin-top: 18px;
  font-weight: 500;
}
</style>
