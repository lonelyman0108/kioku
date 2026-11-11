<script setup lang="ts">
import { computed } from 'vue'

import { FLAGS, type FlagStatus } from './flags'

// 带细框的小标记：凭据的快到期、已到期、需要轮换，测试台写下的记录，已过期、已吊销这类状态。
// 只有文字和一圈线，不用彩色徽章。传 status 时文字与图标都按状态取（flags.ts），图标只作辅助；
// 不传就只显示插槽里的文字，和以前一样
const props = defineProps<{ status?: FlagStatus | undefined }>()
const flag = computed(() => (props.status ? FLAGS[props.status] : null))
</script>

<template>
  <span class="flag-tag" :class="{ warning: flag?.warning }"
    ><UIcon v-if="flag" :name="flag.icon" class="flag-icon" aria-hidden="true" /><slot>{{
      flag?.label
    }}</slot></span
  >
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
.flag-tag.warning {
  color: var(--ui-warning);
}
.flag-icon {
  /* 预检样式把 svg 设成 block，在标签里会把文字挤到下一行 */
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 3px;
  vertical-align: -2px;
}
</style>
