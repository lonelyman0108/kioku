<script setup lang="ts">
import { computed } from 'vue'

// 召回权重比重与最低分准入门槛条：把各路打分比重与「低于最低分不注入」的阈值放到一张卡里，直观读清筛选线
const props = defineProps<{
  weights: readonly { key: string; label: string; value: number }[]
  minScore?: number
}>()

// 权重是计算比重，不绑定记忆归属色；用渐次墨色阶区分各路分量
const COLORS = [
  'var(--ui-text-highlighted)',
  'var(--ui-text-toned)',
  'var(--ui-text-muted)',
  'var(--strata-neutral)',
  'var(--ui-border-accented)',
]

const safeWeight = (v: number) => (Number.isFinite(v) ? Math.max(v, 0) : 0)

const rows = computed(() =>
  props.weights.map((w, idx) => ({
    ...w,
    safeValue: safeWeight(Number(w.value)),
    color: COLORS[idx % COLORS.length],
  })),
)

const rawTotal = computed(() => rows.value.reduce((sum, w) => sum + w.safeValue, 0))
const safeDenom = computed(() => Math.max(rawTotal.value, 0.01))

const safeMinScore = computed(() => {
  if (props.minScore === undefined) return undefined
  const n = Number(props.minScore)
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0
})

const thresholdPct = computed(() => (safeMinScore.value ?? 0) * 100)
</script>

<template>
  <section class="viz-card" aria-label="召回权重配比与门槛">
    <header class="viz-head">
      <span class="viz-title">召回得分比重与门槛</span>
      <span class="viz-sub tabular-nums">
        权重合计 {{ rawTotal.toFixed(2) }}
        <template v-if="safeMinScore !== undefined"> · 门槛 {{ safeMinScore.toFixed(2) }}</template>
      </span>
    </header>
    <div class="viz-body">
      <div class="bars">
        <div v-for="w in rows" :key="w.key" class="hbar-row">
          <span class="hbar-label">{{ w.label }}</span>
          <div class="hbar-track" aria-hidden="true">
            <div
              class="hbar-fill"
              :style="{
                width: `${rawTotal > 0 ? (w.safeValue / safeDenom) * 100 : 0}%`,
                background: w.color,
              }"
            />
          </div>
          <span class="hbar-val tabular-nums">{{ w.safeValue.toFixed(2) }}</span>
        </div>
      </div>

      <div v-if="safeMinScore !== undefined" class="gauge-wrap">
        <div class="gauge-head">
          <span>命中门槛线（高于门槛线才注入）</span>
          <span class="gauge-cutoff tabular-nums">≥ {{ safeMinScore.toFixed(2) }}</span>
        </div>
        <div class="gauge-track" role="img" :aria-label="`最低分门槛 ${safeMinScore.toFixed(2)}`">
          <div class="gauge-pass" :style="{ left: `${thresholdPct}%` }" />
        </div>
        <div class="gauge-labels tabular-nums">
          <span>0.00（丢弃）</span>
          <span>0.50</span>
          <span>1.00（高匹配）</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.viz-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.viz-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.viz-title {
  font-size: 13px;
  font-weight: 600;
}
.viz-sub {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.viz-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
}
.bars {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.hbar-row {
  display: grid;
  grid-template-columns: 98px minmax(0, 1fr) 44px;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.hbar-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
.hbar-track {
  height: 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.hbar-fill {
  height: 100%;
  transition: width 160ms ease;
}
.hbar-val {
  text-align: right;
  font-weight: 500;
}
.gauge-wrap {
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
}
.gauge-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}
.gauge-cutoff {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.gauge-track {
  position: relative;
  height: 12px;
  margin-top: 6px;
  border: 1px solid var(--strata-rule);
  background: var(--ui-bg-muted);
}
.gauge-pass {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  border-left: 2px solid var(--ui-text-highlighted);
  background: color-mix(in srgb, var(--ui-text) 16%, transparent);
}
.gauge-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
</style>
