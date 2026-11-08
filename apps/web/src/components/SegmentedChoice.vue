<script setup lang="ts" generic="T extends string">
import { useId } from 'vue'

// 分段按钮：几个互斥的选项排成一条。底下是原生的单选框，方向键切换、Tab 进出整组，读屏读得出是单选组；
// 选中的反白，焦点框画在整段外面。禁用的项方向键跳过
defineProps<{
  items: readonly { value: T; label: string; disabled?: boolean }[]
  // 整组的名字，读屏读这一句
  label: string
}>()
const model = defineModel<T>({ required: true })
const name = useId()
</script>

<template>
  <fieldset class="segmented">
    <legend class="sr-only">{{ label }}</legend>
    <label
      v-for="item in items"
      :key="item.value"
      class="segment"
      :class="{ on: model === item.value, disabled: item.disabled }"
    >
      <input
        type="radio"
        class="sr-only"
        :name="name"
        :value="item.value"
        :checked="model === item.value"
        :disabled="item.disabled"
        @change="model = item.value"
      />
      <span>{{ item.label }}</span>
    </label>
  </fieldset>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  flex: none;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 1px solid var(--ui-border-accented);
}
.segment {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.segment + .segment {
  border-left: 1px solid var(--ui-border-accented);
}
.segment:hover:not(.disabled):not(.on) {
  background: var(--ui-bg-muted);
}
.segment.on {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
  font-weight: 500;
}
.segment.disabled {
  color: var(--ui-text-dimmed);
  cursor: not-allowed;
}
.segment:has(input:focus-visible) {
  z-index: 1;
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: 1px;
}
</style>
