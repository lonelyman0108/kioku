<script setup lang="ts">
import { useCopy } from '../../composables/useCopy'
import { icons } from '../../icons'
import UriPath from './UriPath.vue'

// 详情底部的一行坐标：目录、列表都写标题，坐标只在这里出现，可以复制。
// 人格、应用与根写的是坐标的开头（label 传「坐标开头」）
withDefaults(defineProps<{ value: string; label?: string }>(), { label: '坐标' })
const copy = useCopy()
</script>

<template>
  <footer class="coordinate-line">
    <span class="coordinate-label">{{ label }}</span>
    <UriPath class="coordinate-value" :uri="value" wrap />
    <UButton
      :icon="icons.copy"
      size="xs"
      color="neutral"
      variant="ghost"
      :aria-label="`复制${label}`"
      @click="copy(value)"
    />
  </footer>
</template>

<style scoped>
.coordinate-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  padding: 10px 32px 12px;
  border-top: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.5;
}
.coordinate-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.coordinate-value {
  min-width: 0;
}
@media (max-width: 1023.98px) {
  .coordinate-line {
    padding: 10px 16px 12px;
  }
}
</style>
