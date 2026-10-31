<script setup lang="ts">
import type { StepBadge } from '../benchResult'

// 一步的状态：文字加图标，放在一行开头的固定位置，一列扫下来就能对齐。只有出错才用砖红，通过不上色
defineProps<{ badge: StepBadge }>()
</script>

<template>
  <span class="status" :class="badge.color">
    <UIcon :name="badge.icon" class="status-icon" />
    {{ badge.label }}
  </span>
</template>

<style scoped>
.status {
  flex: none;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  min-width: 4.75rem;
  font-size: 13px;
  line-height: 1.5;
  white-space: nowrap;
}
.status-icon {
  flex: none;
  align-self: center;
  display: inline-block;
  width: 14px;
  height: 14px;
}
.status.error {
  font-weight: 500;
  color: var(--status-error, var(--ui-error));
}
.status.warning {
  color: var(--status-warning, var(--ui-warning));
}
.status.neutral {
  color: var(--status-muted, var(--ui-text-muted));
}
</style>
