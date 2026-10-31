<script setup lang="ts">
// 设置里的两栏：左边表单，右边状态（最近一次的结果、进度）。放不下时状态排到表单下面
</script>

<template>
  <div class="settings-columns">
    <div class="column"><slot /></div>
    <div class="column"><slot name="side" /></div>
  </div>
</template>

<style scoped>
.settings-columns {
  display: grid;
  grid-template-columns: minmax(0, 40rem) minmax(0, 1fr);
  align-items: start;
  gap: 32px 40px;
}
.column {
  min-width: 0;
}
@media (max-width: 1279.98px) {
  .settings-columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
