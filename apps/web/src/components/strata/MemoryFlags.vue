<script setup lang="ts">
import type { Layer, Sensitivity } from '@kioku/contracts'

import { layerShortLabels } from '../../labels'

// 目录和列表一行末尾的标记：机密反白，优先级只标最高的两档，层写简称。
// 色块旁边要有文字，放不下全名时靠这里的简称
defineProps<{
  layer?: Layer | null
  sensitivity?: Sensitivity | null
  priority?: number | null
}>()
</script>

<template>
  <span class="memory-flags">
    <span v-if="sensitivity === 'secret'" class="flag-secret">机密</span>
    <span
      v-if="priority !== null && priority !== undefined && priority <= 1"
      class="flag-priority"
      :class="{ top: priority === 0 }"
      >P{{ priority }}</span
    >
    <span v-if="layer" class="flag-layer">{{ layerShortLabels[layer] }}</span>
  </span>
</template>

<style scoped>
.memory-flags {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}
.flag-secret {
  padding: 0 4px;
  background: var(--flag-solid, var(--strata-solid));
  color: var(--flag-on-solid, var(--strata-on-solid));
  font-weight: 500;
}
.flag-priority {
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--flag-muted, var(--ui-text-muted));
}
.flag-priority.top {
  font-weight: 700;
  color: inherit;
}
.flag-layer {
  color: var(--flag-muted, var(--ui-text-muted));
}
</style>
