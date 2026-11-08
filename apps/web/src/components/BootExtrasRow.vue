<script setup lang="ts">
import type { TuningKey, TuningValues } from '@kioku/contracts'

import { BOOT_EXTRAS, formatTuning, TUNING_META, type BootExtra } from '../advancedSettings'
import SourceTag from './SourceTag.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 启动加载的附带内容：三块各一行，开关、条数与适用范围，右侧写来源。开关或条数有一项和上一级不同就算覆盖，
// 恢复两项一起。表单值由调用方的 useTuningFields 持有：这里只报改动（set）与恢复（restore）
const props = defineProps<{
  // 表单里的值，开关按 0、1
  values: Partial<Record<TuningKey, number | null | undefined>>
  invalid: boolean
  sources: Partial<Record<TuningKey, 'inherited' | 'overridden'>>
  inherited: TuningValues
  level: string
  editable: boolean
}>()
const emit = defineEmits<{
  set: [key: TuningKey, value: number | null]
  restore: [extra: BootExtra]
}>()

const enabledKey = (extra: BootExtra) => `boot.${extra}.enabled` as const
const countKey = (extra: BootExtra) => `boot.${extra}.count` as const
const sourceOf = (extra: BootExtra) =>
  props.sources[enabledKey(extra)] === 'overridden' ||
  props.sources[countKey(extra)] === 'overridden'
    ? 'overridden'
    : 'inherited'
const inheritedText = (extra: BootExtra) =>
  props.inherited[enabledKey(extra)]
    ? `${formatTuning(countKey(extra), props.inherited[countKey(extra)])} 条`
    : '关'
</script>

<template>
  <!-- 表格放在名称下面、占满整行：放在控件那一栏时窄屏挤不下来源 -->
  <div class="extras">
    <p class="extras-name">附带内容</p>
    <p class="extras-description">字数不够时，排在后面的不附。</p>
    <SettingsTable>
      <thead>
        <tr>
          <th class="w-8"><span class="sr-only">附带</span></th>
          <th>内容</th>
          <th>条数</th>
          <th class="text-right"><span class="sr-only">来源</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="extra in BOOT_EXTRAS" :key="extra.key">
          <td>
            <UCheckbox
              :model-value="values[enabledKey(extra.key)] === 1"
              :disabled="!editable"
              :aria-label="TUNING_META[enabledKey(extra.key)].label"
              @update:model-value="(on) => emit('set', enabledKey(extra.key), on === true ? 1 : 0)"
            />
          </td>
          <td>
            <span class="extra-name">{{ TUNING_META[enabledKey(extra.key)].label }}</span>
            <span class="extra-scope">适用：{{ extra.scope }}</span>
          </td>
          <td>
            <UInputNumber
              :model-value="values[countKey(extra.key)] ?? undefined"
              :min="0"
              :max="20"
              :disabled="!editable || values[enabledKey(extra.key)] !== 1"
              :aria-label="TUNING_META[countKey(extra.key)].label"
              size="sm"
              class="w-24"
              @update:model-value="
                (v) => emit('set', countKey(extra.key), (v as number | null) ?? null)
              "
            />
          </td>
          <td class="text-right">
            <SourceTag
              :source="sourceOf(extra.key)"
              :level="level"
              :value="inheritedText(extra.key)"
              :editable="editable"
              @restore="emit('restore', extra.key)"
            />
          </td>
        </tr>
      </tbody>
    </SettingsTable>
    <p v-if="invalid" class="w-full text-xs text-error">条数请填写 0 到 20 之间的整数。</p>
  </div>
</template>

<style scoped>
.extras {
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border);
}
.extras-name {
  font-weight: 500;
}
.extras-description {
  margin-bottom: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.extra-name {
  display: block;
  white-space: nowrap;
}
.extra-scope {
  display: block;
  font-size: 12px;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
</style>
