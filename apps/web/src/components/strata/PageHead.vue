<script setup lang="ts">
// 页面顶上的标题：大字的名词短语，下面一行说明，右边放操作
defineProps<{ title: string }>()
</script>

<template>
  <header class="page-head">
    <div class="min-w-0">
      <h1>{{ title }}</h1>
      <p v-if="$slots.note"><slot name="note" /></p>
    </div>
    <div v-if="$slots.actions" class="page-actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.page-head {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 24px;
  padding: 20px 32px 17px;
}
h1 {
  font-size: 28px;
  font-weight: 500;
  line-height: 1.3;
  letter-spacing: -0.005em;
}
p {
  margin-top: 3px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.page-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
@media (max-width: 1023.98px) {
  .page-head {
    padding: 16px 16px 13px;
  }
  h1 {
    font-size: 23px;
  }
}
</style>
