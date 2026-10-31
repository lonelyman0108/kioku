<script setup lang="ts">
import type { Layer, Sensitivity } from '@kioku/contracts'
import { computed } from 'vue'

import { layerLabels, sensitivityLabels } from '../../labels'
import { layerHints, paintSwatch, sensitivityHints, swatchText } from './strata'

const props = withDefaults(
  defineProps<{
    layer?: Layer | null
    sensitivity?: Sensitivity | null
    // 旁边带什么文字。颜色不单独承担信息：放得下就带上，放不下至少有 title 和 aria-label
    label?: 'none' | 'layer' | 'sensitivity' | 'both'
    width?: number
    height?: number
    // 只标层。不传时没有敏感级画虚线框，表示敏感级不确定
    plain?: boolean
  }>(),
  { layer: null, sensitivity: null, label: 'none', width: 18, height: 12, plain: false },
)

const rects = computed(() => paintSwatch(props.layer, props.sensitivity, props.width, props.height))
const name = computed(() => swatchText(props.layer, props.sensitivity))
const title = computed(() =>
  [
    name.value,
    props.layer && layerHints[props.layer],
    props.sensitivity && sensitivityHints[props.sensitivity],
  ]
    .filter(Boolean)
    .join('\n'),
)
const text = computed(() => {
  if (props.label === 'layer') return props.layer ? layerLabels[props.layer] : ''
  if (props.label === 'sensitivity') {
    return props.sensitivity ? sensitivityLabels[props.sensitivity] : ''
  }
  return props.label === 'both' ? name.value : ''
})
const uncertain = computed(() => !props.plain && !props.sensitivity)
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 align-middle"
    :title="title"
    :aria-label="name"
    role="img"
  >
    <svg
      :width="width"
      :height="height"
      :viewBox="`0 0 ${width} ${height}`"
      class="shrink-0"
      aria-hidden="true"
    >
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
        :width="width - 1"
        :height="height - 1"
        fill="none"
        :stroke-dasharray="uncertain ? '2 2' : undefined"
        style="stroke: var(--strata-frame)"
      />
    </svg>
    <span v-if="text">{{ text }}</span>
  </span>
</template>
