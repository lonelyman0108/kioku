<script setup lang="ts">
import type { EntryKind, Sensitivity, StrataBand } from '@kioku/contracts'
import { computed } from 'vue'

import { bandLabels, entryKindLabels } from '../../labels'
import { localBandLabel } from './strata'

// 目录和列表一行末尾的标记：机密反白，优先级只标最高的两档，变体数量大于 1 时标注；
// 同圈列表里普通正式记忆不重复打「正式记忆」尾标，只对对话形态或跨圈来源显示类型文字
const props = withDefaults(
  defineProps<{
    band?: StrataBand | null
    kind?: EntryKind | null
    sensitivity?: Sensitivity | null
    priority?: number | null
    variantCount?: number | null
    local?: boolean
  }>(),
  {
    band: null,
    kind: null,
    sensitivity: null,
    priority: null,
    variantCount: null,
    local: false,
  },
)

const typeText = computed(() => {
  if (props.local) {
    if (props.band === 'episode' || props.band === 'fact') return localBandLabel(props.band)
    if (props.kind && props.kind !== 'entry') return entryKindLabels[props.kind]
    if (props.band === 'shared-away') return bandLabels['shared-away']
    return null
  }
  if (props.band) return bandLabels[props.band]
  if (props.kind && props.kind !== 'entry') return entryKindLabels[props.kind]
  return null
})
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
      >{{ variantCount }} 变体</span
    >
    <span v-if="typeText" class="flag-layer">{{ typeText }}</span>
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
