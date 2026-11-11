<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  DREAM_KEYS,
  EXTRACTION_KEYS,
  PromptSupplement,
  type UpdateSpaceAdvanced,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import {
  overriddenAt,
  refreshAdvanced,
  spaceAdvancedKey,
  SUPPLEMENT_MAX,
} from '../advancedSettings'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { fieldProblems, useSavedText } from '../composables/useSavedField'
import { useTuningFields } from '../composables/useTuningFields'
import PromptSupplementEditor from './PromptSupplementEditor.vue'
import TuningRow from './TuningRow.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 抽取与整理的高级项：每批轮数、空闲时长、会话摘要有效期、整理的请求次数与建议条数，以及两段规则的补充。
// 没覆盖的沿用实例默认；只有空间所有者能改
const props = defineProps<{ spaceId: string }>()
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const queryClient = useQueryClient()

const view = useQuery({
  queryKey: computed(() => spaceAdvancedKey(props.spaceId)),
  queryFn: ({ queryKey: [, , sid] }) => api.spaceAdvanced(sid),
})
const editable = computed(() => view.data.value?.canEdit ?? false)

const EXTRACTION = EXTRACTION_KEYS
const DREAM = DREAM_KEYS
const KEYS = [...EXTRACTION, ...DREAM] as const
const tuning = useTuningFields(
  KEYS,
  () => view.data.value?.effective,
  () => view.data.value?.instance,
  () => overriddenAt(view.data.value?.sources, 'space'),
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
const row = (key: (typeof KEYS)[number]) => ({
  setting: key,
  invalid: fields[key].invalid.value,
  source: tuning.sourceOf(key),
  inherited: view.data.value?.instance[key] ?? 0,
})

function discard() {
  tuning.reset()
  rules.extraction.reset()
  rules.dream.reset()
}

const saving = ref(false)
async function save() {
  if (saving.value || !changedCount.value || problem.value) return
  const sid = props.spaceId
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
    const saved = await api.saveSpaceAdvanced(sid, body as UpdateSpaceAdvanced)
    if (sid === props.spaceId) {
      tuning.commit(submitted, saved.effective)
      rules.extraction.commit(extraction, saved.overrides['prompts.extractionRules'] ?? '')
      rules.dream.commit(dream, saved.overrides['prompts.dreamRules'] ?? '')
    }
    queryClient.setQueryData(spaceAdvancedKey(sid), saved)
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
    <form v-if="view.data.value" @submit.prevent="save">
      <SettingsBlock title="抽取的高级项" wide>
        <template #note>未覆盖的项沿用实例默认。</template>
        <TuningRow
          v-for="key in EXTRACTION"
          :key="key"
          v-model="fields[key].value.value"
          v-bind="row(key)"
          level="实例"
          :editable="editable"
          @restore="tuning.restore(key)"
        />
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
          level="空间"
          :editable="editable"
          :invalid="rules.extraction.invalid.value"
        />
      </SettingsBlock>
      <SettingsBlock title="整理的高级项" wide>
        <TuningRow
          v-for="key in DREAM"
          :key="key"
          v-model="fields[key].value.value"
          v-bind="row(key)"
          level="实例"
          :editable="editable"
          @restore="tuning.restore(key)"
        />
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
          level="空间"
          :editable="editable"
          :invalid="rules.dream.invalid.value"
        />
      </SettingsBlock>
      <p v-if="!editable" class="pt-6 text-muted">仅空间所有者可修改。</p>
      <SaveBar
        v-if="editable"
        :count="changedCount"
        :saving="saving"
        :problem="problem"
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
