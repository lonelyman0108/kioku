<script setup lang="ts">
import { SENSITIVITIES, type Layer, type Sensitivity } from '@kioku/contracts'
import { computed, ref } from 'vue'

import { layerLabels, layerShortLabels, sensitivityLabels } from '../../labels'
import StrataSwatch from './StrataSwatch.vue'
import {
  conversationTotal,
  curatedTotal,
  isConversationLayer,
  layerHints,
  layerTotal,
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
    // 柱子的高度和宽度；compact 用在窄屏，层名用简称
    height?: number
    width?: number
    compact?: boolean
    selected?: StrataSelection | null
  }>(),
  { height: 612, width: 216, compact: false, selected: null },
)
const emit = defineEmits<{
  select: [selection: StrataSelection]
  hover: [selection: StrataSelection | null]
}>()

const GAP = 28
const bands = computed(() => stackBands(props.counts, props.height, GAP))
const conversation = computed(() => bands.value.filter((b) => isConversationLayer(b.layer)))
const curated = computed(() => bands.value.filter((b) => !isConversationLayer(b.layer)))
const names = computed(() => (props.compact ? layerShortLabels : layerLabels))
const cuts = computed(() =>
  bands.value.map((band) => ({
    band,
    parts: segments(props.counts[band.layer], props.width, 2),
  })),
)
const hovered = ref<StrataSelection | null>(null)
const highlight = computed(() => hovered.value ?? props.selected)
const lit = (layer: Layer, sensitivity: Sensitivity) => {
  const on = highlight.value
  if (!on) return true
  return (!on.layer || on.layer === layer) && (!on.sensitivity || on.sensitivity === sensitivity)
}
const numberOn = (layer: Layer, sensitivity: Sensitivity) =>
  highlight.value?.layer === layer && highlight.value.sensitivity === sensitivity

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
const note = ref<{ x: number; y: number; lines: string[] } | null>(null)
function enterSegment(event: MouseEvent, layer: Layer, sensitivity: Sensitivity, count: number) {
  enter({ layer, sensitivity })
  const rect = body.value?.getBoundingClientRect()
  note.value = {
    x: event.clientX - (rect?.left ?? 0),
    y: event.clientY - (rect?.top ?? 0),
    lines: [
      `${layerLabels[layer]} ${sensitivityLabels[sensitivity]} ${count} 条`,
      layerHints[layer],
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
        @mouseenter="enter({ layer: null, sensitivity: s })"
        @mouseleave="leave"
        @focus="enter({ layer: null, sensitivity: s })"
        @blur="leave"
        @click="emit('select', { layer: null, sensitivity: s })"
      >
        <StrataSwatch :sensitivity="s" :width="22" :height="12" />
        <span>{{ sensitivityLabels[s] }}</span>
      </button>
    </div>

    <div ref="body" class="fig-body" :style="{ height: `${height}px` }">
      <svg
        class="fig-col"
        :width="width"
        :height="height"
        :viewBox="`0 0 ${width} ${height}`"
        aria-hidden="true"
      >
        <template v-for="{ band, parts } in cuts" :key="band.layer">
          <g
            v-for="part in parts"
            :key="part.sensitivity"
            class="seg"
            :class="{ dim: !lit(band.layer, part.sensitivity) }"
            @mouseenter="enterSegment($event, band.layer, part.sensitivity, part.count)"
            @mouseleave="leave"
            @click="emit('select', { layer: band.layer, sensitivity: part.sensitivity })"
          >
            <rect
              v-for="(r, i) in paintCell(
                band.layer,
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
        :key="band.layer"
        class="fig-row"
        :class="{ conv: isConversationLayer(band.layer) }"
        :style="{ top: `${band.y}px`, height: `${band.h}px` }"
      >
        <button
          type="button"
          class="fig-name"
          :title="layerHints[band.layer]"
          @mouseenter="enter({ layer: band.layer, sensitivity: null })"
          @mouseleave="leave"
          @focus="enter({ layer: band.layer, sensitivity: null })"
          @blur="leave"
          @click="emit('select', { layer: band.layer, sensitivity: null })"
        >
          {{ names[band.layer] }}
        </button>
        <span
          class="fig-total"
          :class="{ on: highlight?.layer === band.layer && !highlight.sensitivity }"
        >
          {{ layerTotal(counts, band.layer) }}
        </span>
        <template v-for="s in SENSITIVITIES" :key="s">
          <button
            v-if="counts[band.layer][s]"
            type="button"
            class="fig-n"
            :class="{ sec: s === 'secret', on: numberOn(band.layer, s) }"
            :aria-label="`${layerLabels[band.layer]} ${sensitivityLabels[s]} ${counts[band.layer][s]} 条`"
            @mouseenter="enter({ layer: band.layer, sensitivity: s })"
            @mouseleave="leave"
            @focus="enter({ layer: band.layer, sensitivity: s })"
            @blur="leave"
            @click="emit('select', { layer: band.layer, sensitivity: s })"
          >
            {{ counts[band.layer][s] }}
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
        :style="{ left: `${note.x}px`, top: `${note.y}px` }"
      >
        <b>{{ note.lines[0] }}</b>
        <span v-for="line in note.lines.slice(1)" :key="line">{{ line }}</span>
      </div>
    </div>

    <div class="fig-foot">
      <span>合计</span>
      <b>{{ curatedTotal(counts) }}</b>
      <span v-for="s in SENSITIVITIES" :key="s" class="fig-sum">{{
        sensitivityTotal(counts, s)
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
  --cols: 40px 34px repeat(4, minmax(0, 1fr));
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
  font-family: var(--font-mono);
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
.fig-n.sec {
  color: var(--ui-error);
  font-weight: 500;
}
.fig-n:hover,
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
  font-family: var(--font-mono);
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
  font-family: var(--font-mono);
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
  left: 50%;
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
