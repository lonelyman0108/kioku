<script setup lang="ts">
import { useCopy } from '../../composables/useCopy'
import { icons } from '../../icons'

// 详情底部的一行不可变短 ID，供逐字核对与一键复制
withDefaults(defineProps<{ value: string; label?: string }>(), {
  label: '短 ID',
})
const copy = useCopy()
</script>

<template>
  <footer class="short-id-line">
    <span class="short-id-label">{{ label }}</span>
    <code class="short-id-value">{{ value }}</code>
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
  padding: 10px 28px 12px;
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
@media (max-width: 1023.98px) {
  .short-id-line {
    padding: 10px 16px 12px;
  }
}
</style>
