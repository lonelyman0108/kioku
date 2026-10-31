<script setup lang="ts">
import type { KeyScopes, Layer, Sensitivity } from '@kioku/contracts'
import { computed } from 'vue'

import {
  coreCells,
  coreMark,
  coreName,
  isConversationLayer,
  issuedScopeRows,
  paintAccess,
  type AccessRow,
  type StrataCounts,
} from './strata'

// 岩芯：一个 Key 碰得到多深。纵向是层，顺序和地层柱一样；横向是敏感级，越往右越敏感。
// 能碰到的格子上色，一眼看出范围。传 rows 看服务端算出的实际范围，只传 scopes 看签发范围
// （不是实际权限，见 issuedScopeRows）。两个都没有时只留虚线框，不能当成没有权限
const props = withDefaults(
  defineProps<{
    scopes?: KeyScopes | null
    rows?: readonly AccessRow[] | null
    // 带高跟随地层柱时传条数，不传就等高
    counts?: StrataCounts | null
    width?: number
    height?: number
    // 已吊销：只留虚线框，一格都不上色
    revoked?: boolean
    // 这根岩芯是谁的，读屏和悬停时读出来
    label?: string
    // 标出一条记忆的位置；不知道敏感级时标整层
    mark?: { layer: Layer; sensitivity: Sensitivity | null } | null
  }>(),
  {
    scopes: null,
    rows: null,
    counts: null,
    width: 44,
    height: 72,
    revoked: false,
    label: undefined,
    mark: null,
  },
)

const GAP = 3
const model = computed(() =>
  coreCells(
    props.rows ?? (props.scopes ? issuedScopeRows(props.scopes) : []),
    props.width,
    props.height,
    props.counts,
    GAP,
  ),
)
const groups = computed(() =>
  [true, false].map((conversation) => {
    const bands = model.value.bands.filter((b) => isConversationLayer(b.layer) === conversation)
    const first = bands[0]
    const last = bands[bands.length - 1]
    const top = first?.y ?? 0
    const bottom = last ? last.y + last.h : 0
    return { conversation, bands, top, bottom }
  }),
)
const name = computed(() =>
  coreName({ label: props.label, rows: props.rows, scopes: props.scopes, revoked: props.revoked }),
)
const noData = computed(() => !props.rows && !props.scopes)
const markBox = computed(() =>
  props.mark ? coreMark(model.value, props.mark.layer, props.mark.sensitivity) : null,
)
</script>

<template>
  <svg
    class="strata-core block shrink-0"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    role="img"
    :aria-label="name"
  >
    <title>{{ name }}</title>
    <!-- 空白处也是纸色：放在反白的选中行里，没权限的格子同样是空的 -->
    <rect
      v-for="group in groups"
      :key="`bg-${group.conversation}`"
      x="0"
      :y="group.top"
      :width="width"
      :height="group.bottom - group.top"
      style="fill: var(--ui-bg)"
    />
    <path
      v-for="group in groups"
      :key="`grid-${group.conversation}`"
      :d="
        model.columns
          .slice(1, 4)
          .map((x) => `M${x + 0.5} ${group.top}V${group.bottom}`)
          .join('')
      "
      fill="none"
      style="stroke: var(--ui-border)"
    />
    <template v-if="!revoked">
      <template v-for="cell in model.cells" :key="`${cell.layer}-${cell.sensitivity}`">
        <rect
          v-for="(r, i) in paintAccess(
            cell.layer,
            cell.sensitivity,
            cell.kind,
            { x: cell.x, y: cell.y, width: cell.width, height: cell.height },
            { y: cell.barY, height: cell.barHeight },
            'sm',
          )"
          :key="i"
          :x="r.x"
          :y="r.y"
          :width="r.width"
          :height="r.height"
          :opacity="r.opacity"
          :style="{ fill: r.fill }"
        />
      </template>
    </template>
    <template v-for="group in groups" :key="`frame-${group.conversation}`">
      <path
        :d="
          group.bands
            .slice(1)
            .map((b) => `M0 ${b.y + 0.5}H${width}`)
            .join('')
        "
        fill="none"
        stroke-opacity="0.8"
        style="stroke: var(--ui-border-accented)"
      />
      <rect
        x="0.5"
        :y="group.top + 0.5"
        :width="width - 1"
        :height="Math.max(0, group.bottom - group.top - 1)"
        fill="none"
        :stroke-dasharray="group.conversation || revoked || noData ? '3 2' : undefined"
        :style="{
          stroke: revoked || noData ? 'var(--ui-border-accented)' : 'var(--strata-frame)',
        }"
      />
    </template>
    <rect
      v-if="markBox"
      class="core-mark"
      :x="markBox.x"
      :y="markBox.y"
      :width="markBox.width"
      :height="markBox.height"
      fill="none"
      stroke-width="2"
      style="stroke: var(--ui-error)"
    />
  </svg>
</template>
