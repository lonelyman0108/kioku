<script setup lang="ts">
// 带细框的小标记：凭据的快到期、已到期、需要轮换，测试台写下的记录，已过期、已吊销这类状态。
// 只有文字和一圈线，不用彩色徽章。icon 取 icons.ts 里的名字（状态的对应见 flags.ts），只作辅助，文字照样写全
defineProps<{ icon?: string | undefined }>()
</script>

<template>
  <span class="flag-tag"
    ><UIcon v-if="icon" :name="icon" class="flag-icon" aria-hidden="true" /><slot
  /></span>
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
.flag-icon {
  width: 12px;
  height: 12px;
  margin-right: 3px;
  vertical-align: -2px;
}
</style>
