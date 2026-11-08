<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  INSTANCE_PROMPT_KEYS,
  TUNING_KEYS,
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
  rangeOf,
  refreshAdvanced,
  SUPPLEMENT_MAX,
  TUNING_META,
} from '../advancedSettings'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { fieldProblems, useSavedText } from '../composables/useSavedField'
import { useTuningFields } from '../composables/useTuningFields'
import PromptSupplement from './PromptSupplement.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 实例 › 提示词与默认值：四段提示词的补充（固定部分只读）与所有空间的默认值。空间与应用的覆盖在各自的设置里
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

// 默认值表：召回权重之外的各项；权重放在折叠里
const DEFAULT_KEYS = TUNING_KEYS.filter((k) => !k.startsWith('recallWeights.'))
const WEIGHT_KEYS = TUNING_KEYS.filter((k) => k.startsWith('recallWeights.'))
const GROUPS: Record<string, string> = {
  recall: '每轮召回',
  boot: '启动加载',
  extraction: '抽取',
  dream: '整理',
  recallWeights: '召回权重',
}
const rowLabel = (key: TuningKey) => `${GROUPS[key.split('.')[0]!]}：${TUNING_META[key].label}`
// 实例这一级的上一级是内置值
const tuning = useTuningFields(
  TUNING_KEYS,
  () => view.data.value?.effective,
  () => view.data.value?.builtin,
)
const { fields } = tuning
const overriddenText = (key: TuningKey) => {
  const by = view.data.value?.overriddenBy[key]
  if (!by || (!by.spaces && !by.apps)) return '—'
  return [by.spaces && `${by.spaces} 个空间`, by.apps && `${by.apps} 个应用`]
    .filter(Boolean)
    .join('、')
}

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
const stepOf = (key: TuningKey) =>
  rangeOf(key).decimals ? 0.01 : key === 'boot.charBudget' ? 1000 : 1
</script>

<template>
  <div>
    <p class="section-note">所有空间的默认值。空间与应用的覆盖在各自的设置里。</p>
    <ReadFailureNote v-if="view.isError.value" :query="view" />
    <USkeleton v-if="view.isPending.value" class="mt-6 h-64 w-full" />
    <form v-else-if="view.data.value" @submit.prevent="save">
      <SettingsBlock title="提示词" wide>
        <template #note>固定部分写死在代码里，只能在后面追加补充。</template>
        <SegmentedChoice v-model="tab" :items="tabs" label="提示词" class="mb-3" />
        <PromptSupplement
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

      <SettingsBlock title="默认值" wide>
        <template #note>空间、应用未覆盖时使用。</template>
        <SettingsTable>
          <thead>
            <tr>
              <th>参数</th>
              <th>实例默认</th>
              <th class="num">内置</th>
              <th>覆盖</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in DEFAULT_KEYS" :key="key">
              <td>{{ rowLabel(key) }}</td>
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
              </td>
              <td class="num text-muted">{{ formatTuning(key, view.data.value.builtin[key]) }}</td>
              <td class="text-muted">{{ overriddenText(key) }}</td>
            </tr>
          </tbody>
        </SettingsTable>
        <details class="more">
          <summary>召回权重</summary>
          <SettingsTable class="mt-2">
            <thead>
              <tr>
                <th>路</th>
                <th>实例默认</th>
                <th class="num">内置</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="key in WEIGHT_KEYS" :key="key">
                <td>{{ TUNING_META[key].label }}</td>
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
                  />
                </td>
                <td class="num text-muted">
                  {{ formatTuning(key, view.data.value.builtin[key]) }}
                </td>
                <td class="text-muted">{{ TUNING_META[key].description }}</td>
              </tr>
            </tbody>
          </SettingsTable>
        </details>
      </SettingsBlock>
      <SaveBar :count="changedCount" :saving="saving" :problem="problem" @discard="discard" />
    </form>
  </div>
</template>

<style scoped>
.section-note {
  margin-bottom: 20px;
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
