<script setup lang="ts">
import type { TuningKey } from '@kioku/contracts'
import { computed, useId } from 'vue'

import { formatTuning, isDecimal, rangeOf, TUNING_META } from '../advancedSettings'
import SourceTag from './SourceTag.vue'
import SettingsRow from './strata/SettingsRow.vue'

// 一项高级设置的设置行：名称与说明、数字框（最低分是滑块加数字），右侧写来源。
// level 是上一级的名称（实例、空间），inherited 是上一级的值；只读时控件禁用、不给恢复
const props = defineProps<{
  setting: TuningKey
  invalid: boolean
  source: 'inherited' | 'overridden'
  level: string
  inherited: number | boolean
  editable: boolean
}>()
const emit = defineEmits<{ restore: [] }>()
// 表单里的值（useSavedField 的 value）；清空时为 null
const model = defineModel<number | null | undefined>({ required: true })

const id = useId()
const meta = computed(() => TUNING_META[props.setting])
const range = computed(() => rangeOf(props.setting))
const slider = computed(() => props.setting === 'recall.minScore')
const step = computed(() =>
  isDecimal(props.setting) ? 0.01 : props.setting === 'boot.charBudget' ? 1000 : 1,
)
const sliderValue = computed({
  get: () => model.value ?? 0,
  set: (v: number) => (model.value = Math.round(v * 100) / 100),
})
const rangeText = computed(() =>
  isDecimal(props.setting)
    ? `请填写 ${range.value.min.toFixed(2)} 到 ${range.value.max.toFixed(2)} 之间、最多两位小数的数。`
    : `请填写 ${range.value.min.toLocaleString('en-US')} 到 ${range.value.max.toLocaleString('en-US')} 之间的整数。`,
)
</script>

<template>
  <SettingsRow :label="meta.label" :description="meta.description" :for="id">
    <template v-if="slider">
      <USlider
        v-model="sliderValue"
        :min="0"
        :max="1"
        :step="0.01"
        :disabled="!editable"
        class="w-44"
        aria-hidden="true"
        tabindex="-1"
      />
      <UInputNumber
        :id="id"
        v-model="model"
        :min="range.min"
        :max="range.max"
        :step="step"
        :format-options="{ minimumFractionDigits: 2, maximumFractionDigits: 2 }"
        :disabled="!editable"
        class="w-28"
      />
    </template>
    <template v-else>
      <UInputNumber
        :id="id"
        v-model="model"
        :min="range.min"
        :max="range.max"
        :step="step"
        :disabled="!editable"
        :class="setting === 'boot.charBudget' ? 'w-36' : 'w-28'"
      />
      <span v-if="meta.unit" class="text-xs text-muted">{{ meta.unit }}</span>
    </template>
    <p v-if="invalid" class="w-full text-xs text-error">{{ rangeText }}</p>
    <template #source>
      <SourceTag
        :source="source"
        :level="level"
        :value="formatTuning(setting, inherited)"
        :editable="editable"
        @restore="emit('restore')"
      />
    </template>
  </SettingsRow>
</template>
