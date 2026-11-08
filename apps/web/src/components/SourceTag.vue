<script setup lang="ts">
import { icons } from '../icons'
import FlagTag from './strata/FlagTag.vue'

// 设置行右侧的取值来源：沿用上一级时是虚线标签「沿用实例 · 8」；本级覆盖时是「已覆盖」，
// 能改时旁边给「恢复为实例的 8」。level 是上一级的名称，value 是上一级的值（已格式化）
defineProps<{
  source: 'inherited' | 'overridden'
  level: string
  value: string
  editable?: boolean
}>()
const emit = defineEmits<{ restore: [] }>()
</script>

<template>
  <span class="source-tag">
    <FlagTag v-if="source === 'inherited'" class="inherited"
      ><UIcon :name="icons.down" class="source-icon" aria-hidden="true" />沿用{{ level }} ·
      {{ value }}</FlagTag
    >
    <template v-else>
      <FlagTag class="overridden">已覆盖</FlagTag>
      <button v-if="editable" type="button" class="restore" @click="emit('restore')">
        恢复为{{ level }}的 {{ value }}
      </button>
      <span v-else class="parent">{{ level }}为 {{ value }}</span>
    </template>
  </span>
</template>

<style scoped>
.source-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.source-tag .inherited {
  border-style: dashed;
  color: var(--ui-text-muted);
}
.source-tag .overridden {
  border-color: var(--ui-text-highlighted);
  color: var(--ui-text-highlighted);
}
.source-icon {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 3px;
  vertical-align: -2px;
}
.restore {
  font-size: 12px;
  color: var(--ui-text-toned);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.parent {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.restore:hover {
  color: var(--ui-text-highlighted);
}
</style>
