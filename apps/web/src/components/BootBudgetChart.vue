<script setup lang="ts">
import { computed } from 'vue'

// 启动加载字数预算配比条：根据当前表单里的总预算与三块附带内容估算各块占比，数值一改图条跟着重绘。
// 这里展示的是大致分配比例，真实加载以服务端字数预算和客户端上限为准
const props = defineProps<{
  charBudget: number
  summariesEnabled: boolean
  summariesCount: number
  recentEnabled: boolean
  recentCount: number
  relatedEnabled: boolean
  relatedCount: number
}>()

const nonNeg = (n: number) => (Number.isFinite(n) ? Math.max(n, 0) : 0)

const budget = computed(() => Math.max(nonNeg(Number(props.charBudget)), 1000))

const allocation = computed(() => {
  const b = budget.value
  const sCount = props.summariesEnabled ? nonNeg(Number(props.summariesCount)) : 0
  const rCount = props.recentEnabled ? nonNeg(Number(props.recentCount)) : 0
  const relCount = props.relatedEnabled ? nonNeg(Number(props.relatedCount)) : 0
  const extras = sCount * 160 + rCount * 120 + relCount * 180
  const core = Math.min(Math.round(b * 0.3), 2400)
  const personaApp = Math.min(Math.round(b * 0.25), 2000)
  const clampedExtras = Math.min(extras, Math.max(b - core - personaApp, 0))
  const headroom = Math.max(b - core - personaApp - clampedExtras, 0)
  const total = Math.max(core + personaApp + clampedExtras + headroom, 1)
  return [
    {
      key: 'persona',
      label: '独立人格设定',
      chars: personaApp,
      pct: (personaApp / total) * 100,
      color: 'var(--layer-persona)',
    },
    {
      key: 'core',
      label: '正式记忆展开',
      chars: core,
      pct: (core / total) * 100,
      color: 'var(--layer-primary)',
    },
    {
      key: 'extras',
      label: '附带摘要与线索',
      chars: clampedExtras,
      pct: (clampedExtras / total) * 100,
      color: 'var(--strata-neutral)',
    },
    {
      key: 'headroom',
      label: '可展开余量',
      chars: headroom,
      pct: (headroom / total) * 100,
      color: 'var(--ui-bg-elevated)',
    },
  ]
})

const barSegments = computed(() => allocation.value.filter((seg) => seg.chars > 0))

const enabledExtrasCount = computed(
  () => Number(props.summariesEnabled) + Number(props.recentEnabled) + Number(props.relatedEnabled),
)
</script>

<template>
  <section class="viz-card" aria-label="启动加载字数预算配比">
    <header class="viz-head">
      <span class="viz-title">启动加载字数配比</span>
      <span class="viz-sub tabular-nums"
        >上限 {{ budget.toLocaleString('en-US') }} 字 · {{ enabledExtrasCount }} 项附带开启</span
      >
    </header>
    <div class="viz-body">
      <div class="stack-bar" role="img" aria-label="启动加载字数分配比例">
        <div
          v-for="seg in barSegments"
          :key="seg.key"
          class="stack-seg"
          :style="{ width: `${seg.pct}%`, background: seg.color }"
          :title="`${seg.label}：约 ${seg.chars.toLocaleString('en-US')} 字`"
        />
      </div>
      <div class="legend-grid">
        <div v-for="seg in allocation" :key="seg.key" class="legend-item">
          <span class="legend-left">
            <span class="swatch" :style="{ background: seg.color }" />
            <span>{{ seg.label }}</span>
          </span>
          <span class="legend-num tabular-nums">{{ seg.chars.toLocaleString('en-US') }} 字</span>
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
.stack-bar {
  display: flex;
  height: 16px;
  overflow: hidden;
  border: 1px solid var(--strata-rule);
  background: var(--ui-bg-muted);
}
.stack-seg {
  height: 100%;
  transition: width 160ms ease;
}
.stack-seg + .stack-seg {
  border-left: 1px solid var(--strata-band-line);
}
.legend-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 14px;
  font-size: 12px;
}
.legend-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.legend-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--ui-text-muted);
}
.swatch {
  flex: none;
  width: 10px;
  height: 10px;
  border: 1px solid var(--strata-frame);
}
.legend-num {
  flex: none;
  font-weight: 500;
}
</style>
