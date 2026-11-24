<script setup lang="ts">
import type { CircleKind, Sensitivity, StrataBand } from '@kioku/contracts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { bandLabels } from '../../labels'
import {
  STACK,
  bandHints,
  bandTotal,
  circleBands,
  isConversationBand,
  localBandHint,
  localBandLabel,
  paintCell,
  segments,
  stackBands,
  type Band,
  type StrataCounts,
} from './strata'

// 地层柱的窄版，兼作色带筛选器：点带筛选，再点取消由使用方决定。默认竖排，窄屏放倒横排。
const props = withDefaults(
  defineProps<{
    // 条数还没读到或读取失败时为 null：带等高、不写数字，筛选照样能点
    counts: StrataCounts | null
    // 单圈记忆页传入当前圈类型时，只展示本圈真实存在的 3 类记忆形态
    circleKind?: CircleKind | null
    orientation?: 'vertical' | 'horizontal'
    // 竖排的总高，横排的总宽
    length?: number
    selected?: StrataBand | null
    // 筛选到某个敏感级时，带里只留这一段
    sensitivity?: Sensitivity | null
    // 在已删除 / 已过期视图时「全部」不高亮
    allActive?: boolean
    // 当前打开的记忆在哪条色带：带左边一个小三角
    current?: StrataBand | null
    // 外面悬停着的列表行属于哪条色带
    near?: StrataBand | null
  }>(),
  {
    circleKind: null,
    orientation: 'vertical',
    length: undefined,
    selected: null,
    sensitivity: null,
    allActive: true,
    current: null,
    near: null,
  },
)
const emit = defineEmits<{
  select: [band: StrataBand]
  clear: []
  hover: [band: StrataBand | null]
}>()

const activeList = computed(() => (props.circleKind ? circleBands(props.circleKind) : STACK))
const labelOf = (band: StrataBand) => (props.circleKind ? localBandLabel(band) : bandLabels[band])
const hintText = (band: StrataBand) => (props.circleKind ? localBandHint(band) : bandHints[band])

const root = ref<HTMLElement | null>(null)
const measured = ref(0)
let observer: ResizeObserver | null = null
onMounted(() => {
  if (props.length || !root.value) return
  observer = new ResizeObserver(([entry]) => {
    if (!entry) return
    measured.value =
      props.orientation === 'vertical' ? entry.contentRect.height : entry.contentRect.width
  })
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

const ALL_HEIGHT = 44
const THICKNESS = 26
const FLAT_THICKNESS = 22
// 竖排的带放得下两行标签（12px 字、1.35 倍行高），横排的带放得下四个字的简称
const MIN_BAND = 34
const FLAT_MIN_BAND = 68
const vertical = computed(() => props.orientation === 'vertical')
const size = computed(() => {
  const total = props.length ?? measured.value
  return vertical.value ? total - ALL_HEIGHT : total
})
const bands = computed(() =>
  size.value > 0
    ? stackBands(
        props.counts,
        size.value,
        vertical.value ? 12 : 6,
        vertical.value ? MIN_BAND : FLAT_MIN_BAND,
        activeList.value,
      )
    : [],
)
const lit = computed(() => Boolean(props.selected))

// 竖排时带的高度是 h、宽度固定；横排反过来。段都沿宽度方向切
const bandSize = (band: Band) =>
  vertical.value ? { w: THICKNESS, h: band.h } : { w: band.h, h: FLAT_THICKNESS }
const parts = (band: Band) =>
  props.counts ? segments(props.counts[band.band], bandSize(band).w, 1) : []
const countText = (band: StrataBand) =>
  props.counts ? `${labelOf(band)} ${bandTotal(props.counts, band)} 条` : labelOf(band)
const dividers = (band: Band) =>
  parts(band)
    .filter((p) => p.x > 0)
    .map((p) => `M${p.x + 0.5} 0V${bandSize(band).h}`)
    .join('')
const hint = (band: Band) => `${countText(band.band)}\n${hintText(band.band)}`
const faded = (band: Band, sensitivity: Sensitivity) =>
  Boolean(props.sensitivity) &&
  sensitivity !== props.sensitivity &&
  (!props.selected || props.selected === band.band)
</script>

<template>
  <div
    ref="root"
    class="strata-ribbon"
    :class="[orientation, { lit }]"
    aria-label="按色带筛选"
    role="group"
  >
    <button
      v-if="vertical"
      type="button"
      class="rb-all"
      :class="{ on: allActive && !selected && !sensitivity }"
      :aria-pressed="allActive && !selected && !sensitivity"
      @click="emit('clear')"
    >
      <span>全部</span>
    </button>
    <div class="rb-stack">
      <button
        v-for="band in bands"
        :key="band.band"
        type="button"
        class="rb-band"
        :class="{ on: selected === band.band, near: near === band.band }"
        :style="
          vertical
            ? { top: `${band.y}px`, height: `${band.h}px` }
            : { left: `${band.y}px`, width: `${band.h}px` }
        "
        :aria-pressed="selected === band.band"
        :aria-label="countText(band.band)"
        :title="hint(band)"
        @click="emit('select', band.band)"
        @mouseenter="emit('hover', band.band)"
        @mouseleave="emit('hover', null)"
      >
        <span v-if="vertical && current === band.band" class="rb-here" aria-hidden="true" />
        <svg
          :width="bandSize(band).w"
          :height="bandSize(band).h"
          :viewBox="`0 0 ${bandSize(band).w} ${bandSize(band).h}`"
          aria-hidden="true"
        >
          <g
            v-for="part in parts(band)"
            :key="part.sensitivity"
            :class="{ off: faded(band, part.sensitivity) }"
          >
            <rect
              v-for="(r, i) in paintCell(
                band.band,
                part.sensitivity,
                { x: part.x, y: 0, width: part.w, height: bandSize(band).h },
                'sm',
              )"
              :key="i"
              :x="r.x"
              :y="r.y"
              :width="r.width"
              :height="r.height"
              :style="{ fill: r.fill }"
            />
          </g>
          <path :d="dividers(band)" fill="none" style="stroke: var(--strata-band-line)" />
          <rect
            x="0.5"
            y="0.5"
            :width="Math.max(0, bandSize(band).w - 1)"
            :height="Math.max(0, bandSize(band).h - 1)"
            fill="none"
            :stroke-dasharray="isConversationBand(band.band) ? '3 2' : undefined"
            style="stroke: var(--strata-rule)"
          />
        </svg>
        <i v-if="vertical" class="rb-tick" />
        <span class="rb-label">
          {{ labelOf(band.band) }}<b v-if="counts">{{ bandTotal(counts, band.band) }}</b>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.strata-ribbon {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
}
.strata-ribbon.horizontal {
  height: 56px;
}
.rb-all {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  height: 44px;
  padding-left: 6px;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 12px;
  line-height: 1.3;
  color: var(--ui-text-muted);
}
.rb-all:hover,
.rb-band:hover,
.rb-band.on,
.rb-band.near {
  background: var(--ui-bg-elevated);
}
.rb-all.on {
  color: var(--ui-text-highlighted);
}
.rb-stack {
  position: relative;
  flex: 1;
  min-height: 0;
}
.rb-band {
  position: absolute;
  display: flex;
  text-align: left;
}
.vertical .rb-band {
  left: 0;
  right: 0;
  align-items: center;
  padding-left: 6px;
}
.horizontal .rb-band {
  top: 0;
  flex-direction: column;
  align-items: flex-start;
}
.rb-band:focus-visible {
  outline-offset: -2px;
}
.rb-band svg {
  transition: opacity 0.1s linear;
}
.lit .rb-band:not(.on) svg {
  opacity: 0.28;
}
.rb-band.on svg {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -1px;
}
.off {
  opacity: 0.2;
}
.rb-tick {
  flex: none;
  width: 4px;
  height: 1px;
  background: var(--strata-rule);
}
.rb-label {
  display: flex;
  flex-direction: column;
  max-height: 100%;
  overflow: hidden;
  padding-left: 3px;
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
}
.horizontal .rb-label {
  max-width: 100%;
  max-height: none;
  padding: 3px 0 0;
}
.rb-label b {
  font-variant-numeric: tabular-nums;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.rb-band.on .rb-label,
.rb-band.near .rb-label {
  font-weight: 600;
}
.rb-here {
  position: absolute;
  left: 0;
  top: 50%;
  margin-top: -4px;
  border-block: 4px solid transparent;
  border-left: 5px solid var(--ui-text-highlighted);
}
</style>
