<script setup lang="ts">
import type { KeyScopes } from '@kioku/contracts'
import { computed } from 'vue'

import { scopesSummary } from '../../labels'
import {
  coreCells,
  isConversationLayer,
  issuedScopeRows,
  paintAccess,
  type AccessRow,
  type StrataCounts,
} from './strata'

// 岩芯：一个 Key 碰得到多深。纵向是层，顺序和地层柱一样；横向是敏感级，越往右越敏感。
// 能碰到的格子上色，一眼看出范围。传 scopes 看签发范围（不是实际权限，见 issuedScopeRows），
// 传 rows 看服务端算出的某个会话上下文下的实际范围
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
    label?: string
  }>(),
  {
    scopes: null,
    rows: null,
    counts: null,
    width: 44,
    height: 72,
    revoked: false,
    label: undefined,
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
const name = computed(() => {
  if (props.revoked) return props.label ? `${props.label}，已吊销，没有权限` : '已吊销，没有权限'
  if (props.label) return props.label
  return props.scopes && !props.rows
    ? `签发范围：${scopesSummary(props.scopes)}`
    : '当前会话上下文的权限范围'
})
</script>

<template>
  <svg
    class="strata-core"
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
        :stroke-dasharray="group.conversation || revoked ? '3 2' : undefined"
        :style="{ stroke: revoked ? 'var(--ui-border-accented)' : 'var(--strata-frame)' }"
      />
    </template>
  </svg>
</template>
