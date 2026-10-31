<script setup lang="ts">
// 贴在正文上方的一行状态：一条墨线，左边说什么情况，右边是操作。不铺色块，只有文字带语气
withDefaults(defineProps<{ tone?: 'neutral' | 'warning' | 'error' }>(), { tone: 'neutral' })
</script>

<template>
  <div class="note-line">
    <div class="note-text">
      <p class="note-title" :class="tone">
        <slot />
      </p>
      <p v-if="$slots.detail" class="note-detail"><slot name="detail" /></p>
    </div>
    <div v-if="$slots.actions" class="note-actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.note-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 16px;
  min-height: 44px;
  padding: 6px 0;
  margin-bottom: 16px;
  border-top: 1px solid var(--strata-rule);
  border-bottom: 1px solid var(--ui-border);
}
.note-line + .note-line {
  margin-top: -16px;
  border-top: 0;
}
.note-text {
  flex: 1 1 14em;
  min-width: 0;
  overflow-wrap: anywhere;
}
.note-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.55;
}
.note-title.warning {
  color: var(--ui-warning);
}
.note-title.error {
  color: var(--ui-error);
}
.note-detail {
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
.note-actions {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
