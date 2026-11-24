<script setup lang="ts">
import type { Sensitivity, StrataBand } from '@kioku/contracts'
import { computed } from 'vue'

import { bandLabels, sensitivityLabels } from '../../labels'
import {
  bandHints,
  localBandHint,
  localBandLabel,
  paintSwatch,
  sensitivityHints,
  swatchText,
} from './strata'

const props = withDefaults(
  defineProps<{
    band?: StrataBand | null
    sensitivity?: Sensitivity | null
    // 旁边带什么文字。颜色不单独承担信息：放得下就带上，放不下至少有 title 和 aria-label
    label?: 'none' | 'band' | 'sensitivity' | 'both'
    local?: boolean
    width?: number
    height?: number
    // 只标色带。不传时没有敏感级画虚线框，表示敏感级不确定
    plain?: boolean
    // 旁边的文字已经说全了：只是配图，不读屏、不弹说明
    decorative?: boolean
  }>(),
  {
    band: null,
    sensitivity: null,
    label: 'none',
    local: false,
    width: 18,
    height: 12,
    plain: false,
    decorative: false,
  },
)

const rects = computed(() => paintSwatch(props.band, props.sensitivity, props.width, props.height))
const name = computed(() => swatchText(props.band, props.sensitivity, props.local))
const title = computed(() =>
  [
    name.value,
    props.band && (props.local ? localBandHint(props.band) : bandHints[props.band]),
    props.sensitivity && sensitivityHints[props.sensitivity],
  ]
    .filter(Boolean)
    .join('\n'),
)
const text = computed(() => {
  if (props.label === 'band') {
    return props.band ? (props.local ? localBandLabel(props.band) : bandLabels[props.band]) : ''
  }
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
    :title="decorative ? undefined : title"
    :aria-hidden="decorative ? true : undefined"
  >
    <svg
      :width="width"
      :height="height"
      :viewBox="`0 0 ${width} ${height}`"
      class="shrink-0"
      :role="decorative || text ? undefined : 'img'"
      :aria-label="decorative || text ? undefined : name"
      :aria-hidden="decorative || text ? true : undefined"
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
