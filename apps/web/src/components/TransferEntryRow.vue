<script setup lang="ts">
// 导入与导出设置页的统一入口卡片：图标、结果说明与右侧触发按钮，操作过程放进各自弹窗
defineProps<{
  icon: string
  title: string
  description: string
  status?: string | null
  statusTone?: 'neutral' | 'warning'
}>()
</script>

<template>
  <div class="transfer-entry">
    <div class="entry-main">
      <div class="entry-icon-box" aria-hidden="true">
        <UIcon :name="icon" class="entry-icon" />
      </div>
      <div class="entry-text">
        <p class="entry-title">{{ title }}</p>
        <p class="entry-desc">{{ description }}</p>
        <p v-if="status" class="entry-status" :data-tone="statusTone ?? 'neutral'">{{ status }}</p>
      </div>
    </div>
    <div class="entry-action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.transfer-entry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 14px 20px;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.entry-main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  flex: 1 1 18rem;
}
.entry-icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.entry-icon {
  display: inline-block;
  width: 17px;
  height: 17px;
}
.entry-text {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.entry-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ui-text-highlighted);
}
.entry-desc {
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.entry-status {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
}
.entry-status[data-tone='warning'] {
  color: var(--ui-warning);
}
.entry-action {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}
@media (max-width: 639.98px) {
  .entry-action {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
