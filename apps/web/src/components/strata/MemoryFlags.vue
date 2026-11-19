<script setup lang="ts">
import type { EntryKind, Sensitivity, StrataBand } from '@kioku/contracts'

import { bandLabels, entryKindLabels } from '../../labels'

// 目录和列表一行末尾的标记：机密反白，优先级只标最高的两档，变体数量大于 1 时标注，色带或物种写文字
defineProps<{
  band?: StrataBand | null
  kind?: EntryKind | null
  sensitivity?: Sensitivity | null
  priority?: number | null
  variantCount?: number | null
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
    <span v-if="variantCount && variantCount > 1" class="flag-variants"
      >{{ variantCount }} 切片</span
    >
    <span v-if="band" class="flag-layer">{{ bandLabels[band] }}</span>
    <span v-else-if="kind && kind !== 'entry'" class="flag-layer">{{ entryKindLabels[kind] }}</span>
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
.flag-layer,
.flag-variants {
  color: var(--flag-muted, var(--ui-text-muted));
}
.flag-variants {
  font-family: var(--font-mono);
}
</style>
