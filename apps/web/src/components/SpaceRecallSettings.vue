<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  APP_TUNING_KEYS,
  WEIGHT_KEYS,
  type TuningKey,
  type UpdateSpaceAdvanced,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import {
  BOOT_EXTRAS,
  formatTuning,
  overriddenAt,
  refreshAdvanced,
  runtimeName,
  spaceAdvancedKey,
  TUNING_META,
  type BootExtra,
} from '../advancedSettings'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { useTuningFields } from '../composables/useTuningFields'
import { icons } from '../icons'
import BootExtrasRow from './BootExtrasRow.vue'
import Hint from './Hint.vue'
import RecallTrial from './RecallTrial.vue'
import TuningRow from './TuningRow.vue'
import EmptyState from './strata/EmptyState.vue'
import FlagTag from './strata/FlagTag.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsRow from './strata/SettingsRow.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 空间 › 召回与启动加载：空间内应用的默认值。没覆盖的项沿用实例默认，应用可以再单独覆盖。
// 只有空间所有者能改（canEdit），别的成员只读：控件禁用，不显示保存条
const dirty = defineModel<boolean>('dirty', { default: false })
const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))

const view = useQuery({
  queryKey: computed(() => spaceAdvancedKey(spaceId.value)),
  queryFn: ({ queryKey: [, , sid] }) => api.spaceAdvanced(sid),
})
const apps = useQuery({
  queryKey: computed(() => ['apps', spaceId.value]),
  queryFn: () => api.apps(spaceId.value),
})
const editable = computed(() => view.data.value?.canEdit ?? false)

const tuning = useTuningFields(
  APP_TUNING_KEYS,
  () => view.data.value?.effective,
  () => view.data.value?.instance,
  () => overriddenAt(view.data.value?.sources, 'space'),
)
const { fields } = tuning
const changedCount = computed(() => tuning.changedKeys.value.length)
watch(
  () => changedCount.value > 0,
  (d) => (dirty.value = d),
  { immediate: true },
)
const inheritedOf = (key: TuningKey) => view.data.value?.instance[key] ?? 0

// 每一行：名称旁边的表单值、来源与恢复
const row = (key: (typeof APP_TUNING_KEYS)[number]) => ({
  setting: key,
  invalid: fields[key].invalid.value,
  source: tuning.sourceOf(key),
  inherited: inheritedOf(key),
})
const restoreExtra = (extra: BootExtra) =>
  [`boot.${extra}.enabled`, `boot.${extra}.count`].forEach((k) =>
    tuning.restore(k as (typeof APP_TUNING_KEYS)[number]),
  )
const appCount = computed(() => apps.data.value?.length ?? 0)
const overriddenApps = computed(() => view.data.value?.apps ?? [])
const overriddenLabel = (overrides: Record<string, unknown>) =>
  Object.entries(overrides)
    .map(
      ([k, v]) =>
        `${TUNING_META[k as TuningKey].label} ${formatTuning(k as TuningKey, v as number | boolean)}`,
    )
    .join('、')
const spaceValue = (overrides: Record<string, unknown>) =>
  Object.keys(overrides)
    .map((k) => formatTuning(k as TuningKey, view.data.value?.effective[k as TuningKey]))
    .join('、')
const weights = computed(() => {
  const instance = view.data.value?.instance
  if (!instance) return []
  return WEIGHT_KEYS.map((key) => ({
    key,
    ...TUNING_META[key],
    value: formatTuning(key, instance[key]),
  }))
})
// 试算用表单里的值；不合法时用生效的值
const trialMinScore = computed(() =>
  fields['recall.minScore'].invalid.value
    ? (view.data.value?.effective['recall.minScore'] ?? 0)
    : (fields['recall.minScore'].value.value ?? 0),
)
const trialLimit = computed(() =>
  fields['recall.limit'].invalid.value
    ? (view.data.value?.effective['recall.limit'] ?? 1)
    : (fields['recall.limit'].value.value ?? 1),
)

const saving = ref(false)
async function save() {
  if (saving.value || !changedCount.value || tuning.problem.value) return
  const sid = spaceId.value
  const submitted = tuning.snapshot()
  saving.value = true
  try {
    const saved = await api.saveSpaceAdvanced(sid, tuning.patch() as UpdateSpaceAdvanced)
    if (sid === spaceId.value) tuning.commit(submitted, saved.effective)
    queryClient.setQueryData(spaceAdvancedKey(sid), saved)
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
  <div>
    <p class="section-note">空间内应用的默认值。未覆盖的项沿用实例默认，应用可以再单独覆盖。</p>
    <p class="chain" aria-label="取值顺序">
      <span class="chain-step"><UIcon :name="icons.instance" aria-hidden="true" />实例默认</span>
      <UIcon :name="icons.chevronRight" class="chain-arrow" aria-hidden="true" />
      <span class="chain-step on" aria-current="true"
        ><UIcon :name="icons.space" aria-hidden="true" />空间 · {{ space?.name }}</span
      >
      <UIcon :name="icons.chevronRight" class="chain-arrow" aria-hidden="true" />
      <span class="chain-step"
        ><UIcon :name="icons.apps" aria-hidden="true" />应用 · {{ appCount }} 个，{{
          overriddenApps.length
        }}
        个有覆盖</span
      >
    </p>
    <ReadFailureNote v-if="view.isError.value" :query="view" />
    <USkeleton v-if="view.isPending.value" class="mt-6 h-64 w-full" />
    <form v-else-if="view.data.value" @submit.prevent="save">
      <SettingsBlock title="每轮召回" wide>
        <template #note>提交提示语时注入的候选。</template>
        <TuningRow
          v-model="fields['recall.limit'].value.value"
          v-bind="row('recall.limit')"
          level="实例"
          :editable="editable"
          @restore="tuning.restore('recall.limit')"
        />
        <TuningRow
          v-model="fields['recall.minScore'].value.value"
          v-bind="row('recall.minScore')"
          level="实例"
          :editable="editable"
          @restore="tuning.restore('recall.minScore')"
        />
        <RecallTrial
          :space-id="spaceId"
          :min-score="trialMinScore"
          :limit="trialLimit"
          :app-overrides="overriddenApps"
        />
        <TuningRow
          v-model="fields['recall.subjectFacts'].value.value"
          v-bind="row('recall.subjectFacts')"
          level="实例"
          :editable="editable"
          @restore="tuning.restore('recall.subjectFacts')"
        />
        <TuningRow
          v-model="fields['recall.chatInlineChars'].value.value"
          v-bind="row('recall.chatInlineChars')"
          level="实例"
          :editable="editable"
          @restore="tuning.restore('recall.chatInlineChars')"
        />
        <details class="more">
          <summary>召回权重（仅实例可改）</summary>
          <SettingsTable class="mt-2 max-w-xl">
            <thead>
              <tr>
                <th>路</th>
                <th class="num">权重</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in weights" :key="w.key">
                <td>{{ w.label }}</td>
                <td class="num">{{ w.value }}</td>
                <td class="text-muted">{{ w.description }}</td>
              </tr>
            </tbody>
          </SettingsTable>
        </details>
      </SettingsBlock>

      <SettingsBlock title="启动加载" wide>
        <template #note>会话开始时注入。</template>
        <TuningRow
          v-model="fields['boot.charBudget'].value.value"
          v-bind="row('boot.charBudget')"
          level="实例"
          :editable="editable"
          @restore="tuning.restore('boot.charBudget')"
        />
        <BootExtrasRow
          :values="tuning.values.value"
          :sources="tuning.sources.value"
          :invalid="BOOT_EXTRAS.some((e) => fields[`boot.${e.key}.count`].invalid.value)"
          :inherited="view.data.value.instance"
          level="实例"
          :editable="editable"
          @set="tuning.set"
          @restore="restoreExtra"
        />
        <SettingsRow label="客户端上限" description="客户端自身的限制，不可调">
          <SettingsTable class="max-w-xs">
            <thead>
              <tr>
                <th>客户端</th>
                <th class="num">完整接收</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in view.data.value.hostLimits" :key="h.runtimeFamily">
                <td>{{ runtimeName(h.runtimeFamily) }}</td>
                <td class="num">{{ h.chars.toLocaleString('en-US') }} 字</td>
              </tr>
              <tr>
                <td>其他</td>
                <td class="num text-muted">不限</td>
              </tr>
            </tbody>
          </SettingsTable>
          <template #source>
            <FlagTag><UIcon :name="icons.secret" class="lock" aria-hidden="true" />固定</FlagTag>
            <Hint>字数预算取设置与客户端上限中较小的一个，并为使用指引与附带内容留出余量。</Hint>
          </template>
        </SettingsRow>
      </SettingsBlock>

      <SettingsBlock title="应用的覆盖" wide>
        <template #note>在应用详情里修改。</template>
        <EmptyState v-if="!overriddenApps.length" title="暂无应用覆盖" />
        <SettingsTable v-else>
          <thead>
            <tr>
              <th>应用</th>
              <th>覆盖的项与应用的值</th>
              <th>空间的值</th>
              <th>使用指引的补充</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in overriddenApps" :key="a.id">
              <td>
                <RouterLink :to="{ name: 'app', params: { spaceId, appId: a.id } }" class="app-link"
                  ><UIcon :name="icons.apps" aria-hidden="true" />{{ a.name }}</RouterLink
                >
              </td>
              <td>{{ overriddenLabel(a.overrides) || '—' }}</td>
              <td class="font-mono">{{ spaceValue(a.overrides) || '—' }}</td>
              <td>{{ a.hasGuidance ? '有' : '—' }}</td>
            </tr>
          </tbody>
        </SettingsTable>
      </SettingsBlock>

      <p v-if="!editable" class="pt-6 text-muted">仅空间所有者可修改。</p>
      <SaveBar
        v-if="editable"
        :count="changedCount"
        :saving="saving"
        :problem="tuning.problem.value"
        @discard="tuning.reset()"
      />
    </form>
  </div>
</template>

<style scoped>
.section-note {
  color: var(--ui-text-muted);
}
.chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 14px 0 28px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.chain-step {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 1px dashed var(--ui-border-accented);
}
.chain-step.on {
  border: 1px solid var(--ui-text-highlighted);
  color: var(--ui-text-highlighted);
}
.chain-arrow {
  width: 12px;
  height: 12px;
}
.more {
  margin-top: 12px;
  font-size: 13px;
}
.more summary {
  cursor: pointer;
  color: var(--ui-text-toned);
}
.lock {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 3px;
  vertical-align: -2px;
}
.app-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
