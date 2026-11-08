<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { APP_TUNING_KEYS, type UpdateAppAdvanced } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import {
  appAdvancedKey,
  BOOT_EXTRAS,
  refreshAdvanced,
  SUPPLEMENT_MAX,
  type BootExtra,
} from '../advancedSettings'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { fieldProblems, useSavedText } from '../composables/useSavedField'
import { useTuningFields } from '../composables/useTuningFields'
import BootExtrasRow from './BootExtrasRow.vue'
import PromptSupplement from './PromptSupplement.vue'
import TuningRow from './TuningRow.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SectionHeading from './strata/SectionHeading.vue'

// 应用详情里这个应用的覆盖：召回与启动加载的几项（没覆盖的沿用空间）与使用指引的补充。
// 使用指引按应用的运行时，接在编码 Agent 或群聊机器人的固定部分与实例的补充后面。只有应用所有者能改
const props = defineProps<{ spaceId: string; appId: string }>()
const toast = useToast()
const queryClient = useQueryClient()

const view = useQuery({
  queryKey: computed(() => appAdvancedKey(props.spaceId, props.appId)),
  queryFn: ({ queryKey: [, , sid, id] }) => api.appAdvanced(sid, id),
})
const editable = computed(() => view.data.value?.canEdit ?? false)

const RECALL = [
  'recall.limit',
  'recall.minScore',
  'recall.subjectFacts',
  'recall.chatInlineChars',
] as const
const tuning = useTuningFields(
  APP_TUNING_KEYS,
  () => view.data.value?.effective,
  () => view.data.value?.inherited,
)
const { fields } = tuning
const guidance = useSavedText(
  () => (view.data.value ? (view.data.value.overrides['prompts.guidance'] ?? '') : undefined),
  SUPPLEMENT_MAX,
)
const changedCount = computed(
  () => tuning.changedKeys.value.length + Number(guidance.changed.value),
)
const problem = computed(
  () =>
    [
      tuning.problem.value,
      fieldProblems([{ label: '使用指引的补充', issue: guidance.issue.value }]),
    ]
      .filter(Boolean)
      .join('；') || null,
)
const row = (key: (typeof APP_TUNING_KEYS)[number]) => ({
  setting: key,
  invalid: fields[key].invalid.value,
  source: tuning.sourceOf(key),
  inherited: view.data.value?.inherited[key] ?? 0,
})

// 换了应用时之前的输入作废：跟着新的基准走
watch(
  () => props.appId,
  () => {
    tuning.reset()
    guidance.reset()
  },
)

const restoreExtra = (extra: BootExtra) =>
  [`boot.${extra}.enabled`, `boot.${extra}.count`].forEach((k) =>
    tuning.restore(k as (typeof APP_TUNING_KEYS)[number]),
  )

function discard() {
  tuning.reset()
  guidance.reset()
}

const saving = ref(false)
async function save() {
  if (saving.value || !changedCount.value || problem.value) return
  const { spaceId, appId } = props
  const submitted = tuning.snapshot()
  const text = guidance.value.value
  const body: Record<string, unknown> = { ...tuning.patch() }
  if (guidance.changed.value) body['prompts.guidance'] = text.trim() ? text : null
  saving.value = true
  try {
    const saved = await api.saveAppAdvanced(spaceId, appId, body as UpdateAppAdvanced)
    if (appId === props.appId) {
      tuning.commit(submitted, saved.effective)
      guidance.commit(text, saved.overrides['prompts.guidance'] ?? '')
    }
    queryClient.setQueryData(appAdvancedKey(spaceId, appId), saved)
    await refreshAdvanced(queryClient)
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="app-advanced">
    <SectionHeading title="召回与启动加载" />
    <p class="note">未覆盖的项沿用空间的设置。</p>
    <ReadFailureNote v-if="view.isError.value" :query="view" />
    <USkeleton v-if="view.isPending.value" class="mt-4 h-40 w-full" />
    <form v-else-if="view.data.value" @submit.prevent="save">
      <TuningRow
        v-for="key in RECALL"
        :key="key"
        v-model="fields[key].value.value"
        v-bind="row(key)"
        level="空间"
        :editable="editable"
        @restore="tuning.restore(key)"
      />
      <TuningRow
        v-model="fields['boot.charBudget'].value.value"
        v-bind="row('boot.charBudget')"
        level="空间"
        :editable="editable"
        @restore="tuning.restore('boot.charBudget')"
      />
      <BootExtrasRow
        :values="tuning.values.value"
        :sources="tuning.sources.value"
        :invalid="BOOT_EXTRAS.some((e) => fields[`boot.${e.key}.count`].invalid.value)"
        :inherited="view.data.value.inherited"
        level="空间"
        :editable="editable"
        @set="tuning.set"
        @restore="restoreExtra"
      />
      <h3 class="sub-heading">
        使用指引的补充 ·
        {{ view.data.value.guidance.kind === 'chat' ? '群聊机器人' : '编码 Agent' }}
      </h3>
      <PromptSupplement
        v-model="guidance.value.value"
        label="使用指引的补充"
        :fixed="[{ text: view.data.value.guidance.fixed }]"
        why="工具用法、凭据与安全规则，改动会放开注入"
        :inherited="{ level: '实例', text: view.data.value.guidance.instance }"
        level="应用"
        :editable="editable"
        :invalid="guidance.invalid.value"
      />
      <p v-if="!editable" class="pt-4 text-muted">仅应用所有者可修改。</p>
      <SaveBar
        v-if="editable"
        :count="changedCount"
        :saving="saving"
        :problem="problem"
        @discard="discard"
      />
    </form>
  </section>
</template>

<style scoped>
.note {
  padding-top: 8px;
  color: var(--ui-text-muted);
}
.sub-heading {
  margin-top: 20px;
  font-weight: 500;
}
</style>
