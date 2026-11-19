<script setup lang="ts">
import { useCopy } from '../../composables/useCopy'
import { icons } from '../../icons'

// 详情底部的一行短 ID：列表都写标题，短 ID 只在这里作精确核对用，可一键复制
withDefaults(defineProps<{ value: string; label?: string; circleSlug?: string | null }>(), {
  label: '短 ID',
  circleSlug: null,
})
const copy = useCopy()
</script>

<template>
  <footer class="short-id-line">
    <span class="short-id-label">{{ label }}</span>
    <code class="short-id-value">{{ value }}</code>
    <span v-if="circleSlug" class="short-id-circle">{{ circleSlug }}</span>
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
.short-id-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  padding: 10px 32px 12px;
  border-top: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.5;
}
.short-id-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.short-id-value {
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--ui-text-highlighted);
  word-break: break-all;
}
.short-id-circle {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
@media (max-width: 1023.98px) {
  .short-id-line {
    padding: 10px 16px 12px;
  }
}
</style>
