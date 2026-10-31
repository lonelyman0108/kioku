<script setup lang="ts" generic="T extends string | null">
import type { Layer, Sensitivity } from '@kioku/contracts'
import { useId } from 'vue'

import StrataSwatch from './StrataSwatch.vue'

// 带色块的单选：改层、改敏感级时看得到选了之后长什么样。都有文字，色块只是配图
defineProps<{
  label: string
  options: readonly {
    value: T
    label: string
    layer?: Layer | null
    sensitivity?: Sensitivity | null
    // 只标层，不画敏感级
    plain?: boolean
    // 没有色块，例如「按层默认」
    bare?: boolean
  }[]
  disabled?: boolean
}>()
const model = defineModel<T>({ required: true })
const name = useId()
</script>

<template>
  <div class="swatch-options" role="radiogroup" :aria-label="label">
    <label
      v-for="option in options"
      :key="String(option.value)"
      class="option"
      :class="{ on: model === option.value, disabled }"
    >
      <input
        type="radio"
        :name="name"
        :checked="model === option.value"
        :disabled="disabled"
        @change="model = option.value"
      />
      <StrataSwatch
        v-if="!option.bare"
        :layer="option.layer ?? null"
        :sensitivity="option.sensitivity ?? null"
        :plain="option.plain"
        :width="16"
        :height="11"
        decorative
      />
      <span>{{ option.label }}</span>
    </label>
  </div>
</template>

<style scoped>
.swatch-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(5.75rem, 1fr));
  gap: 5px;
}
.option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 8px 0 7px;
  border: 1px solid var(--ui-border-accented);
  font-size: 13px;
  line-height: 1.3;
  cursor: pointer;
}
.option:hover {
  border-color: var(--ui-text-muted);
}
.option.on {
  border-color: var(--strata-rule);
  box-shadow: inset 0 0 0 1px var(--strata-rule);
  font-weight: 600;
}
.option.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.option input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}
.option:has(input:focus-visible) {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: 2px;
}
</style>
