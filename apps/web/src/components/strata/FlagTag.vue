<script setup lang="ts">
// 带细框的小标记：凭据的快到期、已到期、需要轮换，测试台写下的记录。只有文字和一圈线，不用彩色徽章
</script>

<template>
  <span class="flag-tag"><slot /></span>
</template>

<style scoped>
.flag-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  white-space: nowrap;
  color: var(--ui-text-toned);
}
</style>
