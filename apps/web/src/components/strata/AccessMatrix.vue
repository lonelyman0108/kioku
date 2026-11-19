<script setup lang="ts">
import {
  SENSITIVITIES,
  sensitivityAllowed,
  type AccessCell,
  type CircleAccessMatrix,
  type Sensitivity,
  type StrataBand,
} from '@kioku/contracts'
import { computed } from 'vue'

import {
  bandLabels,
  circleKindLabels,
  credentialCapabilityLabels,
  entryKindLabels,
  sensitivityLabels,
} from '../../labels'
import AccessLegend from './AccessLegend.vue'
import StrataSwatch from './StrataSwatch.vue'
import {
  ACCESS_BAR_PERCENT,
  accessCellText,
  accessFill,
  accessKind,
  accessKindLabels,
  bandHints,
  bandSensitivityAllowed,
  deepestColumn,
  entryKindHints,
  isConversationBand,
  kindAccessCellText,
  kindAccessKind,
  kindBandForCircle,
  orderKindRows,
  orderRows,
  paintAccess,
  presentKinds,
  sensitivityHints,
  type AccessKind,
  type BandAccessRow,
} from './strata'

// 权限范围矩阵：支持多圈明细（circles：每个记忆圈 3 物种 × 4 敏感级）与单表 6 色带视图（rows）。
const props = withDefaults(
  defineProps<{
    circles?: readonly CircleAccessMatrix[] | null
    rows?: readonly BandAccessRow[] | null
    legend?: boolean
  }>(),
  { circles: null, rows: null, legend: true },
)

interface DisplayRow {
  key: string
  band: StrataBand
  label: string
  hint: string
  conv: boolean
  convEnd: boolean
  cells: CircleAccessMatrix['rows'][number]['cells']
  kindOf: (cell: AccessCell) => AccessKind
  allowed: (sensitivity: Sensitivity) => boolean
  titleOf: (sensitivity: Sensitivity, kind: AccessKind) => string
}

interface DisplaySection {
  key: string
  title?: string
  badges?: string[]
  rows: DisplayRow[]
  deepest: number
}

const sections = computed<DisplaySection[]>(() => {
  if (props.circles?.length) {
    return props.circles.map((circle) => {
      const ordered = orderKindRows(circle.rows)
      return {
        key: circle.circleId,
        title: circle.circleName,
        badges: [
          circle.isPrimary ? '主场' : '客场',
          circleKindLabels[circle.circleKind],
          ...(circle.credentials !== 'none'
            ? [`凭据${credentialCapabilityLabels[circle.credentials]}`]
            : []),
        ],
        deepest: deepestColumn(ordered),
        rows: ordered.map((row) => {
          const band = kindBandForCircle(row.kind, circle)
          const label = entryKindLabels[row.kind]
          return {
            key: `${circle.circleId}-${row.kind}`,
            band,
            label,
            hint: entryKindHints[row.kind],
            conv: isConversationBand(band),
            convEnd: row.kind === 'fact',
            cells: row.cells,
            kindOf: (cell) => kindAccessKind(row.kind, cell),
            allowed: (s) => sensitivityAllowed(circle.circleKind, row.kind, s),
            titleOf: (s, k) => kindAccessCellText(row.kind, circle.circleKind, s, k, label),
          }
        }),
      }
    })
  }
  const ordered = orderRows(props.rows ?? [])
  return [
    {
      key: 'bands',
      deepest: deepestColumn(ordered),
      rows: ordered.map((row) => ({
        key: row.band,
        band: row.band,
        label: bandLabels[row.band],
        hint: bandHints[row.band],
        conv: isConversationBand(row.band),
        convEnd: row.band === 'fact',
        cells: row.cells,
        kindOf: (cell) => accessKind(row.band, cell),
        allowed: (s) => bandSensitivityAllowed(row.band, s),
        titleOf: (s, k) => accessCellText(row.band, s, k),
      })),
    },
  ]
})

const cellOf = (row: DisplayRow, sensitivity: Sensitivity): AccessKind => {
  const cell = row.cells.find((c) => c.sensitivity === sensitivity)
  return cell ? row.kindOf(cell) : 'none'
}

const FULL = { x: 0, y: 0, width: '100%', height: '100%' }
const legendKinds = computed(() =>
  props.circles?.length ? presentKinds(props.circles) : presentKinds(props.rows ?? []),
)
</script>

<template>
  <div class="strata-matrix">
    <div class="mx-scroll">
      <div v-for="section in sections" :key="section.key" class="mx-section">
        <div v-if="section.title" class="mx-circle-head">
          <span class="mx-circle-name">{{ section.title }}</span>
          <span v-for="badge in section.badges" :key="badge" class="mx-circle-badge">{{
            badge
          }}</span>
        </div>
        <table class="mx">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">范围</span></th>
              <th
                v-for="(s, i) in SENSITIVITIES"
                :key="s"
                scope="col"
                :class="{ edge: i === section.deepest }"
                :title="sensitivityHints[s]"
              >
                <span class="mx-key">
                  <StrataSwatch :sensitivity="s" :width="22" :height="12" />
                  <span>{{ sensitivityLabels[s] }}</span>
                </span>
                <span v-if="i === section.deepest && section.deepest < 3" class="mx-limit"
                  >最高</span
                >
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in section.rows"
              :key="row.key"
              :class="{ conv: row.conv, 'conv-end': row.convEnd }"
            >
              <th scope="row" :title="row.hint">{{ row.label }}</th>
              <td
                v-for="(s, i) in SENSITIVITIES"
                :key="s"
                class="c"
                :class="[cellOf(row, s), { edge: i === section.deepest, na: !row.allowed(s) }]"
                :style="{ '--c': accessFill(row.band) }"
                :title="row.titleOf(s, cellOf(row, s))"
              >
                <span v-if="!row.allowed(s)" class="c-na">不适用</span>
                <template v-else-if="cellOf(row, s) !== 'none'">
                  <svg width="100%" height="100%" aria-hidden="true">
                    <rect
                      v-for="(r, k) in paintAccess(
                        row.band,
                        s,
                        cellOf(row, s),
                        FULL,
                        ACCESS_BAR_PERCENT,
                        'lg',
                      )"
                      :key="k"
                      :x="r.x"
                      :y="r.y"
                      :width="r.width"
                      :height="r.height"
                      :opacity="r.opacity"
                      :style="{ fill: r.fill }"
                    />
                  </svg>
                  <span class="c-label">{{ accessKindLabels[cellOf(row, s)] }}</span>
                </template>
                <span v-else class="sr-only">{{ accessKindLabels.none }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <AccessLegend v-if="legend" class="mx-legend" :kinds="legendKinds" />
  </div>
</template>

<style scoped>
.strata-matrix {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px 20px;
}
.mx-scroll {
  flex: 1 1 28rem;
  min-width: 0;
  /* 边界线和合并的边框压出去 1px，不留这一点放得下时也会出滚动条 */
  padding-right: 1px;
  overflow-x: auto;
}
.mx-section + .mx-section {
  margin-top: 16px;
}
.mx-circle-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.mx-circle-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.mx-circle-badge {
  padding: 1px 6px;
  border: 1px solid var(--ui-border);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-muted);
}
/* 自动布局加百分比列：放得下时四列等宽，放不下时文字不折行，表格撑开，由外层横向滚动 */
.mx {
  width: 100%;
  table-layout: auto;
  border-collapse: collapse;
}
.mx thead th {
  position: relative;
  width: 23%;
  height: 40px;
  padding: 0 0 5px 8px;
  font-weight: 400;
  text-align: left;
  vertical-align: bottom;
  white-space: nowrap;
}
.mx thead th:first-child {
  width: 8%;
  min-width: 78px;
  padding-left: 0;
}
.mx-key {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--ui-text-muted);
}
.mx-limit {
  float: right;
  margin: 0 8px 0 10px;
  font-size: 12px;
  line-height: 1.3;
  font-weight: 500;
}
.mx tbody th {
  padding: 0 10px 0 0;
  border-top: 1px solid var(--ui-border);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  text-align: left;
  white-space: nowrap;
}
.c {
  position: relative;
  height: 36px;
  /* 下沿的条占两成高，文字留在它上面 */
  padding: 0 8px;
  border: 1px solid var(--ui-border);
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
}
.c svg {
  position: absolute;
  inset: 0;
}
.c-label {
  position: relative;
  display: inline-block;
  margin-left: -3px;
  padding: 3px 5px;
  line-height: 1.2;
  color: var(--ui-text-highlighted);
  background: color-mix(in srgb, var(--c) var(--strata-tint), var(--ui-bg));
}
.c.read-write .c-label {
  background: var(--c);
  color: var(--strata-on-layer);
  font-weight: 500;
}
.c.explicit .c-label,
.c.explicit-write .c-label,
.c.explicit-extract .c-label {
  background: none;
  color: var(--strata-on-solid);
}
.c.extract .c-label,
.c.write .c-label {
  background: none;
}
.c-na {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.c.edge::after,
.mx thead th.edge::after {
  content: '';
  position: absolute;
  top: -1px;
  bottom: -1px;
  right: -1px;
  z-index: 1;
  width: 2px;
  background: var(--strata-rule);
}
.mx .conv-end th,
.mx .conv-end td {
  border-bottom: 1px dashed var(--strata-rule);
}
.mx .conv th {
  color: var(--ui-text-muted);
}
.strata-matrix .mx-legend {
  flex: none;
  flex-direction: column;
  flex-wrap: nowrap;
  padding-top: 44px;
}
@media (max-width: 900px) {
  .mx thead th {
    height: 46px;
    padding-left: 4px;
  }
  .mx thead th:first-child {
    min-width: 50px;
  }
  .mx-key {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .mx-limit {
    display: none;
  }
  .mx tbody th {
    padding-right: 4px;
    font-size: 12px;
  }
  .c {
    padding: 0 4px;
    font-size: 12px;
  }
  .c-label {
    margin-left: 0;
    padding: 2px;
  }
  .strata-matrix .mx-legend {
    flex: 1 1 100%;
    flex-direction: row;
    flex-wrap: wrap;
    padding-top: 0;
  }
}
</style>
