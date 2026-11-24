<script setup lang="ts">
import type { Sensitivity, StrataBand } from '@kioku/contracts'
import { computed } from 'vue'

import { bandFill, paintCell } from './strata'

// 详情顶上的一条地层：一眼看出这条词条在哪一条色带、什么敏感级。文字在下面的标签里，这里不读屏
const props = defineProps<{ band: StrataBand; sensitivity: Sensitivity }>()
const rects = computed(() => {
  const cells = paintCell(props.band, props.sensitivity, {
    x: 0,
    y: 0,
    width: '100%',
    height: '100%',
  })
  if (props.sensitivity === 'secret') {
    cells.push({ x: 0, y: 0, width: 24, height: '100%', fill: bandFill(props.band) })
  }
  return cells
})
</script>

<template>
  <svg class="strata-strip" width="100%" height="10" aria-hidden="true">
    <rect
      v-for="(r, i) in rects"
      :key="i"
      :x="r.x"
      :y="r.y"
      :width="r.width"
      :height="r.height"
      :style="{ fill: r.fill }"
    />
  </svg>
</template>

<style scoped>
.strata-strip {
  display: block;
  flex: none;
  border-bottom: 1px solid var(--strata-rule);
}
</style>
