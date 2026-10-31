<script setup lang="ts">
import { accessBar, accessKindLabels, paintAccess, type AccessKind } from './strata'

// 权限的图例：每种一个色块，和格子同一种画法、同一个比例。岩芯没有文字，靠它读懂
defineProps<{ kinds: readonly AccessKind[] }>()

const WIDTH = 28
const HEIGHT = 18
</script>

<template>
  <ul class="access-legend">
    <li v-for="kind in kinds" :key="kind">
      <svg :width="WIDTH" :height="HEIGHT" :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" aria-hidden="true">
        <rect
          v-for="(r, k) in paintAccess(
            'private',
            'public',
            kind,
            { x: 0, y: 0, width: WIDTH, height: HEIGHT },
            accessBar(0, HEIGHT),
            'sm',
          )"
          :key="k"
          :x="r.x"
          :y="r.y"
          :width="r.width"
          :height="r.height"
          :style="{ fill: r.fill }"
        />
        <rect
          x="0.5"
          y="0.5"
          :width="WIDTH - 1"
          :height="HEIGHT - 1"
          fill="none"
          style="stroke: var(--strata-frame)"
        />
      </svg>
      <span>{{ accessKindLabels[kind] }}</span>
    </li>
  </ul>
</template>

<style scoped>
.access-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}
.access-legend li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.access-legend svg {
  flex: none;
}
</style>
