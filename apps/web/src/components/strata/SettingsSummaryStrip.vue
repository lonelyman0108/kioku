<script setup lang="ts">
export interface SummaryStripItem {
  label: string
  value: string
  sub?: string
  tone?: 'neutral' | 'warn' | 'ok'
}

// 紧凑的摘要带：并排展示 2–4 个关键现状或配比数字，放在长表单顶部帮助快速扫读
defineProps<{ items: readonly SummaryStripItem[] }>()
</script>

<template>
  <div class="summary-strip">
    <div v-for="item in items" :key="item.label" class="summary-cell" :data-tone="item.tone">
      <span class="summary-label">{{ item.label }}</span>
      <span class="summary-value tabular-nums">{{ item.value }}</span>
      <span v-if="item.sub" class="summary-sub">{{ item.sub }}</span>
    </div>
  </div>
</template>

<style scoped>
.summary-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: 1px;
  border: 1px solid var(--strata-rule);
  background: var(--ui-border);
}
.summary-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 14px;
  background: var(--ui-bg-muted);
}
.summary-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.summary-value {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--ui-text-highlighted);
}
.summary-cell[data-tone='warn'] .summary-value {
  color: var(--ui-warning);
}
.summary-cell[data-tone='ok'] .summary-value {
  color: var(--ui-success);
}
.summary-sub {
  font-size: 12px;
  color: var(--ui-text-muted);
}
@media (max-width: 767.98px) {
  .summary-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
