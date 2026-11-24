<script setup lang="ts">
import { SENSITIVITIES, type CircleKind, type Sensitivity, type StrataBand } from '@kioku/contracts'
import { computed, ref } from 'vue'

import { bandLabels, sensitivityLabels } from '../../labels'
import StrataSwatch from './StrataSwatch.vue'
import {
  STACK,
  bandHints,
  bandTotal,
  bandsSensitivityTotal,
  bandsTotal,
  circleBands,
  conversationTotal,
  curatedTotal,
  isConversationBand,
  localBandHint,
  localBandLabel,
  paintCell,
  segments,
  sensitivityHints,
  sensitivityTotal,
  stackBands,
  type StrataCounts,
  type StrataSelection,
} from './strata'

// 地层柱的大图：柱子加引线，每条带对齐一行数字，表头兼作敏感级的图例。柱子和数字都能点
const props = withDefaults(
  defineProps<{
    counts: StrataCounts
    // 单圈视图传入当前记忆圈类型时，只画本圈真实存在的 3 类记忆形态
    circleKind?: CircleKind | null
    // 柱子的高度和宽度；compact 用在窄屏，各列收窄
    height?: number
    width?: number
    compact?: boolean
    selected?: StrataSelection | null
  }>(),
  { circleKind: null, height: undefined, width: 216, compact: false, selected: null },
)
const emit = defineEmits<{
  select: [selection: StrataSelection]
  hover: [selection: StrataSelection | null]
}>()

const activeList = computed(() => (props.circleKind ? circleBands(props.circleKind) : STACK))
const resolvedHeight = computed(() => props.height ?? (props.circleKind ? 280 : 612))
const labelOf = (band: StrataBand) => (props.circleKind ? localBandLabel(band) : bandLabels[band])
const hintOf = (band: StrataBand) => (props.circleKind ? localBandHint(band) : bandHints[band])

const GAP = 28
// 一行放得下标签和数字按钮：14px 字、1.4 倍行高、上下各 1px 内边距，加 1px 分隔线
const MIN_ROW = 24
const bands = computed(() =>
  stackBands(props.counts, resolvedHeight.value, GAP, MIN_ROW, activeList.value),
)
const conversation = computed(() => bands.value.filter((b) => isConversationBand(b.band)))
const curated = computed(() => bands.value.filter((b) => !isConversationBand(b.band)))
const cuts = computed(() =>
  bands.value.map((band) => ({
    band,
    parts: segments(props.counts[band.band], props.width, 2),
  })),
)
const hovered = ref<StrataSelection | null>(null)
const highlight = computed(() => hovered.value ?? props.selected)
const lit = (band: StrataBand, sensitivity: Sensitivity) => {
  const on = highlight.value
  if (!on) return true
  return (!on.band || on.band === band) && (!on.sensitivity || on.sensitivity === sensitivity)
}
const numberOn = (band: StrataBand, sensitivity: Sensitivity) =>
  highlight.value?.band === band && highlight.value.sensitivity === sensitivity

// 带边框的两组：来自对话的用虚线
function frame(list: typeof bands.value) {
  const top = list[0]?.y ?? 0
  const last = list[list.length - 1]
  const bottom = last ? last.y + last.h : 0
  return {
    top: top + 0.5,
    height: Math.max(0, bottom - top - 1),
    lines: list
      .slice(1)
      .map((b) => `M0 ${b.y + 0.5}H${props.width}`)
      .join(''),
  }
}
const dividers = computed(() =>
  cuts.value
    .flatMap(({ band, parts }) =>
      parts.filter((p) => p.x > 0).map((p) => `M${p.x + 0.5} ${band.y}V${band.y + band.h}`),
    )
    .join(''),
)
const subTop = computed(() => {
  const last = conversation.value[conversation.value.length - 1]
  return last ? last.y + last.h : 0
})

function enter(selection: StrataSelection) {
  hovered.value = selection
  emit('hover', selection)
}
function leave() {
  hovered.value = null
  note.value = null
  emit('hover', null)
}

// 悬停柱子时贴着指针的说明，带一条引线
const body = ref<HTMLElement | null>(null)
const NOTE_MAX_WIDTH = 300
const note = ref<{ x: number; y: number; width: number; tip: number; lines: string[] } | null>(null)
function enterSegment(
  event: MouseEvent,
  band: StrataBand,
  sensitivity: Sensitivity,
  count: number,
) {
  enter({ band, sensitivity })
  const rect = body.value?.getBoundingClientRect()
  const figure = body.value?.closest('figure')?.getBoundingClientRect()
  const left = rect?.left ?? 0
  const pointer = event.clientX - left
  // 提示层不伸出整张图：宽度不超过图，中心离图的两边至少半个宽度；引线仍指着指针
  const width = Math.min(NOTE_MAX_WIDTH, figure?.width ?? NOTE_MAX_WIDTH)
  const min = (figure ? figure.left - left : 0) + width / 2
  const max = (figure ? figure.right - left : NOTE_MAX_WIDTH) - width / 2
  const x = Math.min(Math.max(pointer, min), Math.max(min, max))
  note.value = {
    x,
    width,
    tip: pointer - (x - width / 2),
    y: event.clientY - (rect?.top ?? 0),
    lines: [
      `${labelOf(band)} ${sensitivityLabels[sensitivity]} ${count} 条`,
      hintOf(band),
      sensitivityHints[sensitivity],
    ],
  }
}
</script>

<template>
  <figure class="strata-figure" :style="{ '--w': `${width}px` }" :class="{ compact }">
    <div class="fig-head">
      <span />
      <span />
      <button
        v-for="s in SENSITIVITIES"
        :key="s"
        type="button"
        class="fig-key"
        :title="sensitivityHints[s]"
        @mouseenter="enter({ band: null, sensitivity: s })"
        @mouseleave="leave"
        @focus="enter({ band: null, sensitivity: s })"
        @blur="leave"
        @click="emit('select', { band: null, sensitivity: s })"
      >
        <StrataSwatch :sensitivity="s" :width="22" :height="12" />
        <span>{{ sensitivityLabels[s] }}</span>
      </button>
    </div>

    <div ref="body" class="fig-body" :style="{ height: `${resolvedHeight}px` }">
      <svg
        class="fig-col"
        :width="width"
        :height="resolvedHeight"
        :viewBox="`0 0 ${width} ${resolvedHeight}`"
        aria-hidden="true"
      >
        <template v-for="{ band, parts } in cuts" :key="band.band">
          <g
            v-for="part in parts"
            :key="part.sensitivity"
            class="seg"
            :class="{ dim: !lit(band.band, part.sensitivity) }"
            @mouseenter="enterSegment($event, band.band, part.sensitivity, part.count)"
            @mouseleave="leave"
            @click="emit('select', { band: band.band, sensitivity: part.sensitivity })"
          >
            <rect
              v-for="(r, i) in paintCell(
                band.band,
                part.sensitivity,
                { x: part.x, y: band.y, width: part.w, height: band.h },
                'lg',
              )"
              :key="i"
              :x="r.x"
              :y="r.y"
              :width="r.width"
              :height="r.height"
              :style="{ fill: r.fill }"
            />
          </g>
        </template>
        <path
          :d="dividers"
          fill="none"
          style="stroke: var(--strata-band-line)"
          pointer-events="none"
        />
        <template v-for="(group, i) in [frame(conversation), frame(curated)]" :key="i">
          <rect
            x="0.5"
            :y="group.top"
            :width="width - 1"
            :height="group.height"
            fill="none"
            :stroke-dasharray="i === 0 ? '4 3' : undefined"
            style="stroke: var(--strata-rule)"
            pointer-events="none"
          />
          <path
            :d="group.lines"
            fill="none"
            :stroke-dasharray="i === 0 ? '4 3' : undefined"
            style="stroke: var(--strata-band-line)"
            pointer-events="none"
          />
        </template>
      </svg>

      <div
        v-for="band in bands"
        :key="band.band"
        class="fig-row"
        :class="{ conv: isConversationBand(band.band) }"
        :style="{ top: `${band.y}px`, height: `${band.h}px` }"
      >
        <button
          type="button"
          class="fig-name"
          :title="hintOf(band.band)"
          @mouseenter="enter({ band: band.band, sensitivity: null })"
          @mouseleave="leave"
          @focus="enter({ band: band.band, sensitivity: null })"
          @blur="leave"
          @click="emit('select', { band: band.band, sensitivity: null })"
        >
          {{ labelOf(band.band) }}
        </button>
        <button
          v-if="bandTotal(counts, band.band)"
          type="button"
          class="fig-total"
          :class="{ on: highlight?.band === band.band && !highlight.sensitivity }"
          :aria-label="`${labelOf(band.band)} ${bandTotal(counts, band.band)} 条`"
          @mouseenter="enter({ band: band.band, sensitivity: null })"
          @mouseleave="leave"
          @focus="enter({ band: band.band, sensitivity: null })"
          @blur="leave"
          @click="emit('select', { band: band.band, sensitivity: null })"
        >
          {{ bandTotal(counts, band.band) }}
        </button>
        <span v-else class="fig-total" aria-label="0">0</span>
        <template v-for="s in SENSITIVITIES" :key="s">
          <button
            v-if="counts[band.band][s]"
            type="button"
            class="fig-n"
            :class="{ sec: s === 'secret', on: numberOn(band.band, s) }"
            :aria-label="`${labelOf(band.band)} ${sensitivityLabels[s]} ${counts[band.band][s]} 条`"
            @mouseenter="enter({ band: band.band, sensitivity: s })"
            @mouseleave="leave"
            @focus="enter({ band: band.band, sensitivity: s })"
            @blur="leave"
            @click="emit('select', { band: band.band, sensitivity: s })"
          >
            {{ counts[band.band][s] }}
          </button>
          <span v-else class="fig-z" aria-label="0">–</span>
        </template>
      </div>

      <div class="fig-sub" :style="{ top: `${subTop}px`, height: `${GAP}px` }">
        <span>来自对话</span>
        <b>{{ conversationTotal(counts) }}</b>
      </div>

      <div
        v-if="note"
        class="fig-note"
        :class="{ below: note.y < 96 }"
        :style="{
          left: `${note.x}px`,
          top: `${note.y}px`,
          maxWidth: `${note.width}px`,
          '--tip': `${note.tip}px`,
        }"
      >
        <b>{{ note.lines[0] }}</b>
        <span v-for="line in note.lines.slice(1)" :key="line">{{ line }}</span>
      </div>
    </div>

    <div class="fig-foot">
      <span>合计</span>
      <b>{{ circleKind ? bandsTotal(counts, activeList) : curatedTotal(counts) }}</b>
      <span v-for="s in SENSITIVITIES" :key="s" class="fig-sum">{{
        circleKind ? bandsSensitivityTotal(counts, activeList, s) : sensitivityTotal(counts, s)
      }}</span>
    </div>
  </figure>
</template>

<style scoped>
.strata-figure {
  --lead: 16px;
  --cols: 78px 44px repeat(4, minmax(0, 1fr));
  margin: 0;
}
.strata-figure.compact {
  --lead: 9px;
  --cols: 72px 34px repeat(4, minmax(0, 1fr));
}
.fig-head,
.fig-row,
.fig-foot,
.fig-sub {
  display: grid;
  grid-template-columns: var(--cols);
  align-items: center;
}
.fig-head {
  height: 42px;
  margin-left: calc(var(--w) + 1px + var(--lead));
}
.fig-key {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-self: end;
  gap: 3px;
  padding-right: 5px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--ui-text-muted);
}
.fig-key:hover {
  color: var(--ui-text-highlighted);
}
.fig-body {
  position: relative;
}
.fig-col {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
}
.seg {
  cursor: pointer;
}
.seg rect {
  transition: opacity 0.1s linear;
}
.seg.dim rect {
  opacity: 0.22;
}
.fig-row {
  position: absolute;
  left: calc(var(--w) + 1px);
  right: 0;
  padding-left: var(--lead);
  border-top: 1px solid var(--ui-border);
}
.fig-row.conv {
  border-top-style: dashed;
}
/* 引线：从带的右边伸到层名 */
.fig-row::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: calc(var(--lead) - 4px);
  height: 1px;
  background: var(--strata-rule);
}
.fig-name {
  justify-self: start;
  font-size: 14px;
  line-height: 1.4;
  text-align: left;
  white-space: nowrap;
}
.fig-name:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.fig-total,
.fig-n,
.fig-z {
  justify-self: end;
  padding: 1px 5px;
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  line-height: 1.4;
  text-align: right;
}
.fig-total {
  font-weight: 600;
  padding-inline: 4px;
}
.fig-z {
  color: var(--ui-text-muted);
}
/* 机密靠位置和字重，不用红：红色只留给告警 */
.fig-n.sec {
  font-weight: 600;
}
.fig-n:hover,
button.fig-total:hover,
.fig-n.on,
.fig-total.on {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.fig-sub {
  position: absolute;
  left: 0;
  right: 0;
  padding-left: calc(var(--w) + 1px + var(--lead));
  font-size: 12px;
  line-height: 1.3;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
.fig-sub b {
  justify-self: end;
  padding: 1px 4px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.fig-foot {
  height: 30px;
  margin-top: -1px;
  padding-left: calc(var(--w) + 1px + var(--lead));
  border-top: 1px solid var(--strata-rule);
  font-size: 13px;
  color: var(--ui-text-muted);
}
.fig-foot b,
.fig-sum {
  justify-self: end;
  padding: 0 5px;
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  line-height: 1;
}
.fig-foot b {
  padding-inline: 4px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
/* 提示层：一圈墨线，一条引线指回指针的位置 */
.fig-note {
  position: absolute;
  z-index: 2;
  width: max-content;
  max-width: 300px;
  padding: 6px 10px 7px;
  background: var(--ui-bg);
  border: 1px solid var(--strata-rule);
  font-size: 14px;
  line-height: 1.6;
  pointer-events: none;
  transform: translate(-50%, calc(-100% - 14px));
}
.fig-note.below {
  transform: translate(-50%, 14px);
}
.fig-note b {
  display: block;
  font-weight: 600;
}
.fig-note span {
  display: block;
  color: var(--ui-text-muted);
}
.fig-note::after {
  content: '';
  position: absolute;
  left: var(--tip, 50%);
  top: 100%;
  width: 1px;
  height: 9px;
  background: var(--strata-rule);
}
.fig-note.below::after {
  top: auto;
  bottom: 100%;
}
.compact .fig-name,
.compact .fig-total,
.compact .fig-n,
.compact .fig-z,
.compact .fig-sum,
.compact .fig-foot b {
  font-size: 13px;
  padding-inline: 3px;
}
.compact .fig-key {
  padding-right: 3px;
}
</style>
