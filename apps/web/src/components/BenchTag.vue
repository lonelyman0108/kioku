<script setup lang="ts">
// 一行里的小标记：只有文字，靠语气区分，不用彩色徽章。放在反白的选中行里时颜色由行给
defineProps<{ tone?: 'muted' | 'warning' }>()
</script>

<template>
  <span class="tag" :class="tone ?? 'muted'"><slot /></span>
</template>

<style scoped>
.tag {
  flex: none;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  white-space: nowrap;
}
.muted {
  color: var(--tag-muted, var(--ui-text-muted));
}
.warning {
  color: var(--tag-warning, var(--ui-warning));
}
</style>
