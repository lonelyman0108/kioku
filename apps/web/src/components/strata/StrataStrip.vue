<script setup lang="ts">
import type { Layer, Sensitivity } from '@kioku/contracts'
import { computed } from 'vue'

import { paintCell } from './strata'

// 详情顶上的一条地层：一眼看出这条记忆在哪一层、什么敏感级。文字在下面的标签里，这里不读屏
const props = defineProps<{ layer: Layer; sensitivity: Sensitivity }>()
const rects = computed(() =>
  paintCell(props.layer, props.sensitivity, { x: 0, y: 0, width: '100%', height: '100%' }),
)
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
