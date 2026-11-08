<script setup lang="ts">
// 设置里的表格：表头小字、一条墨线，行之间浅线，数字列加 num 类（等宽、右对齐）。内容放 thead、tbody
</script>

<template>
  <div class="settings-table-wrap">
    <table class="settings-table">
      <slot />
    </table>
  </div>
</template>

<style scoped>
.settings-table-wrap {
  overflow-x: auto;
}
.settings-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.settings-table :deep(th) {
  padding: 6px 10px;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
.settings-table :deep(td) {
  height: 38px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ui-border);
  vertical-align: middle;
}
.settings-table :deep(:is(th, td):first-child) {
  padding-left: 0;
}
.settings-table :deep(:is(th, td):last-child) {
  padding-right: 0;
}
.settings-table :deep(.num) {
  font-family: var(--font-mono);
  text-align: right;
}
</style>
