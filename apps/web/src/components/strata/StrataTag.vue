<script setup lang="ts">
import type { Sensitivity, StrataBand } from '@kioku/contracts'
import { computed } from 'vue'

import { bandLabels, sensitivityLabels } from '../../labels'
import { bandHints, localBandHint, localBandLabel, paintCell, sensitivityHints } from './strata'

// 记忆的标签：色带是实色块加全名，后面接一块敏感级的纹理和它的名字
const props = withDefaults(
  defineProps<{
    band: StrataBand
    sensitivity: Sensitivity
    local?: boolean
  }>(),
  { local: false },
)

const WIDTH = 38
const HEIGHT = 24
const rects = computed(() =>
  paintCell(props.band, props.sensitivity, { x: 0, y: 0, width: WIDTH, height: HEIGHT }),
)
const bandName = computed(() => (props.local ? localBandLabel(props.band) : bandLabels[props.band]))
const bandHint = computed(() => (props.local ? localBandHint(props.band) : bandHints[props.band]))
</script>

<template>
  <span class="strata-tag">
    <span class="tag-band" :style="{ background: `var(--layer-${band})` }" :title="bandHint">
      {{ bandName }}
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
.tag-band {
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
