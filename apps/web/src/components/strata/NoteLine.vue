<script setup lang="ts">
// 贴在正文上方的一行状态：一条墨线，左边说什么情况，右边是操作。不铺色块，只有文字带语气。
// flush：上面已经有一条线了，不再画墨线
withDefaults(defineProps<{ tone?: 'neutral' | 'warning' | 'error'; flush?: boolean }>(), {
  tone: 'neutral',
})
</script>

<template>
  <div class="note-line" :class="{ flush }">
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
.note-line.flush {
  min-height: 0;
  border-top: 0;
}
.note-line.flush:first-child {
  padding-top: 0;
}
.note-text {
  flex: 1 1 14em;
  min-width: 0;
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
/* 放不下时按钮换行；一个按钮比一行还长时，按钮里的文字截断，不把外层撑出横向滚动条 */
.note-actions {
  flex: none;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.note-actions :slotted(*) {
  min-width: 0;
  max-width: 100%;
}
</style>
