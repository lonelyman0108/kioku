<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  CLIENT_TUNING_KEYS,
  PromptSupplement,
  RECALL_KEYS,
  type UpdateClientAdvanced,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import {
  BOOT_EXTRAS,
  SUPPLEMENT_MAX,
  clientAdvancedKey,
  overriddenAt,
  refreshAdvanced,
  type BootExtra,
} from '../advancedSettings'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { fieldProblems, useSavedText } from '../composables/useSavedField'
import { useTuningFields } from '../composables/useTuningFields'
import BootExtrasRow from './BootExtrasRow.vue'
import PromptSupplementEditor from './PromptSupplementEditor.vue'
import TuningRow from './TuningRow.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SectionHeading from './strata/SectionHeading.vue'

// 客户端详情里这个客户端的覆盖：召回与启动加载的几项（没覆盖的沿用记忆圈）与使用指引的补充。
const props = defineProps<{ circleId: string; clientId: string }>()
const toast = useToast()
const queryClient = useQueryClient()

const view = useQuery({
  queryKey: computed(() => clientAdvancedKey(props.circleId, props.clientId)),
  queryFn: ({ queryKey: [, , cid, id] }) => api.clientAdvanced(cid, id),
})
const editable = computed(() => view.data.value?.canEdit ?? false)

const RECALL = RECALL_KEYS
const tuning = useTuningFields(
  CLIENT_TUNING_KEYS,
  () => view.data.value?.effective,
  () => view.data.value?.inherited,
  () => overriddenAt(view.data.value?.sources, 'client'),
)
const { fields } = tuning
const guidance = useSavedText(
  () => (view.data.value ? (view.data.value.overrides['prompts.guidance'] ?? '') : undefined),
  PromptSupplement,
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
const row = (key: (typeof CLIENT_TUNING_KEYS)[number]) => ({
  setting: key,
  invalid: fields[key].invalid.value,
  source: tuning.sourceOf(key),
  inherited: view.data.value?.inherited[key] ?? 0,
})

// 换了客户端时之前的输入作废：跟着新的基准走
watch(
  () => props.clientId,
  () => {
    tuning.reset()
    guidance.reset()
  },
)

const restoreExtra = (extra: BootExtra) =>
  [`boot.${extra}.enabled`, `boot.${extra}.count`].forEach((k) =>
    tuning.restore(k as (typeof CLIENT_TUNING_KEYS)[number]),
  )

function discard() {
  tuning.reset()
  guidance.reset()
}

const saving = ref(false)
async function save() {
  if (saving.value || !changedCount.value || problem.value) return
  const { circleId, clientId } = props
  const submitted = tuning.snapshot()
  const text = guidance.value.value
  const body: Record<string, unknown> = { ...tuning.patch() }
  if (guidance.changed.value) body['prompts.guidance'] = text.trim() ? text : null
  saving.value = true
  try {
    const saved = await api.saveClientAdvanced(circleId, clientId, body as UpdateClientAdvanced)
    if (clientId === props.clientId) {
      tuning.commit(submitted, saved.effective)
      guidance.commit(text, saved.overrides['prompts.guidance'] ?? '')
    }
    queryClient.setQueryData(clientAdvancedKey(circleId, clientId), saved)
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
    <p class="note">未覆盖的项沿用记忆圈的设置。</p>
    <ReadFailureNote v-if="view.isError.value" :query="view" />
    <USkeleton v-if="view.isPending.value" class="mt-4 h-40 w-full" />
    <form v-else-if="view.data.value" @submit.prevent="save">
      <TuningRow
        v-for="key in RECALL"
        :key="key"
        v-model="fields[key].value.value"
        v-bind="row(key)"
        level="记忆圈"
        :editable="editable"
        @restore="tuning.restore(key)"
      />
      <TuningRow
        v-model="fields['boot.charBudget'].value.value"
        v-bind="row('boot.charBudget')"
        level="记忆圈"
        :editable="editable"
        @restore="tuning.restore('boot.charBudget')"
      />
      <BootExtrasRow
        :values="tuning.values.value"
        :sources="tuning.sources.value"
        :invalid="BOOT_EXTRAS.some((e) => fields[`boot.${e.key}.count`].invalid.value)"
        :inherited="view.data.value.inherited"
        level="记忆圈"
        :editable="editable"
        @set="tuning.set"
        @restore="restoreExtra"
      />
      <h3 class="sub-heading">
        使用指引的补充 ·
        {{ view.data.value.guidance.kind === 'chat' ? '群聊机器人' : '编码 Agent' }}
      </h3>
      <PromptSupplementEditor
        v-model="guidance.value.value"
        label="使用指引的补充"
        :fixed="[{ text: view.data.value.guidance.fixed }]"
        why="工具用法、凭据与安全规则，改动会放开注入"
        :inherited="{ level: '实例', text: view.data.value.guidance.instance }"
        level="客户端"
        :editable="editable"
        :invalid="guidance.invalid.value"
      />
      <p v-if="!editable" class="pt-4 text-muted">仅客户端所有者可修改。</p>
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
  margin-top: 8px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.sub-heading {
  margin-top: 22px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 14px;
  font-weight: 600;
}
</style>
