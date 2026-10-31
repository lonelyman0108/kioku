<script setup lang="ts">
import type { Layer, Sensitivity } from '@kioku/contracts'
import { computed } from 'vue'

import { layerLabels, sensitivityLabels } from '../../labels'
import { layerHints, paintCell, sensitivityHints } from './strata'

// 记忆的标签：层是实色块加全名，后面接一块敏感级的纹理和它的名字
const props = defineProps<{ layer: Layer; sensitivity: Sensitivity }>()

const WIDTH = 38
const HEIGHT = 24
const rects = computed(() =>
  paintCell(props.layer, props.sensitivity, { x: 0, y: 0, width: WIDTH, height: HEIGHT }),
)
</script>

<template>
  <span class="strata-tag">
    <span
      class="tag-layer"
      :style="{ background: `var(--layer-${layer})` }"
      :title="layerHints[layer]"
    >
      {{ layerLabels[layer] }}
    </span>
    <svg :width="WIDTH" :height="HEIGHT" :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" aria-hidden="true">
      <rect
        v-for="(r, i) in rects"
        :key="i"
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
    <span
      class="tag-sensitivity"
      :class="{ secret: sensitivity === 'secret' }"
      :title="sensitivityHints[sensitivity]"
    >
      {{ sensitivityLabels[sensitivity] }}
    </span>
  </span>
</template>

<style scoped>
.strata-tag {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  line-height: 1.5;
}
.tag-layer {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--strata-frame);
  border-right: 0;
  color: var(--strata-on-layer);
  font-weight: 500;
  white-space: nowrap;
}
.tag-sensitivity {
  margin-left: 7px;
  font-weight: 500;
  white-space: nowrap;
}
.tag-sensitivity.secret {
  padding: 0 5px;
  background: var(--strata-solid);
  color: var(--strata-on-solid);
}
</style>
