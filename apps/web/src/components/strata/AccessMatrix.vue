<script setup lang="ts">
import { SENSITIVITIES, type Sensitivity } from '@kioku/contracts'
import { computed } from 'vue'

import { layerLabels, sensitivityLabels } from '../../labels'
import AccessLegend from './AccessLegend.vue'
import StrataSwatch from './StrataSwatch.vue'
import {
  ACCESS_BAR_PERCENT,
  accessFill,
  accessKind,
  accessKindLabels,
  deepestColumn,
  isConversationLayer,
  layerHints,
  orderRows,
  paintAccess,
  presentKinds,
  sensitivityHints,
  type AccessRow,
} from './strata'

// 权限范围矩阵：7 层乘 4 个敏感级。行序和地层柱一样，格子用同一套编码，文字压在色带上时挖掉纹理保证可读。
// 这份权限碰得到的最高敏感级画一条边界线。切换会话上下文由使用方传不同的 rows
const props = withDefaults(defineProps<{ rows: readonly AccessRow[]; legend?: boolean }>(), {
  legend: true,
})

const ordered = computed(() => orderRows(props.rows))
const deepest = computed(() => deepestColumn(props.rows))
const cellOf = (row: AccessRow, sensitivity: Sensitivity) => {
  const cell = row.cells.find((c) => c.sensitivity === sensitivity)
  return cell ? accessKind(row.layer, cell) : 'none'
}
const FULL = { x: 0, y: 0, width: '100%', height: '100%' }
const legendKinds = computed(() => presentKinds(props.rows))
</script>

<template>
  <div class="strata-matrix">
    <div class="mx-scroll">
      <table class="mx">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">层</span></th>
            <th
              v-for="(s, i) in SENSITIVITIES"
              :key="s"
              scope="col"
              :class="{ edge: i === deepest }"
              :title="sensitivityHints[s]"
            >
              <span class="mx-key">
                <StrataSwatch :sensitivity="s" :width="22" :height="12" />
                <span>{{ sensitivityLabels[s] }}</span>
              </span>
              <span v-if="i === deepest && deepest < 3" class="mx-limit">最高</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in ordered"
            :key="row.layer"
            :class="{ conv: isConversationLayer(row.layer), 'conv-end': row.layer === 'subject' }"
          >
            <th scope="row" :title="layerHints[row.layer]">{{ layerLabels[row.layer] }}</th>
            <td
              v-for="(s, i) in SENSITIVITIES"
              :key="s"
              class="c"
              :class="[cellOf(row, s), { edge: i === deepest }]"
              :style="{ '--c': accessFill(row.layer) }"
              :title="`${layerLabels[row.layer]} ${sensitivityLabels[s]}：${accessKindLabels[cellOf(row, s)]}`"
            >
              <template v-if="cellOf(row, s) !== 'none'">
                <svg width="100%" height="100%" aria-hidden="true">
                  <rect
                    v-for="(r, k) in paintAccess(
                      row.layer,
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
