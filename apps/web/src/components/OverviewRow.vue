<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

// 概览中间一栏的一行：名字、右上的数字、说明，右下的操作撑满整行可点。
// 说明里放提示层时，提示层的按钮压在整行的点击区上面。
// 好几行的操作都叫「查看」，读屏时要带上这一行的名字
defineProps<{
  title: string
  value: string | number
  note?: string | null
  action?: string | null
  to?: RouteLocationRaw | null
  // 要尽快处理的：数字和操作用强调色
  hot?: boolean
  // 没有要处理的：数字退后一级
  zero?: boolean
  // 操作是展开下面的内容时，展开了没有
  expanded?: boolean
}>()
const emit = defineEmits<{ action: [] }>()
</script>

<template>
  <div class="overview-row" :class="{ hot, zero }">
    <span class="row-title">{{ title }}</span>
    <span class="row-value">{{ value }}</span>
    <span class="row-note">
      <slot name="note">{{ note }}</slot>
    </span>
    <RouterLink v-if="action && to" :to="to" class="row-action" :aria-label="`${title}：${action}`">
      {{ action }}
    </RouterLink>
    <button
      v-else-if="action"
      type="button"
      class="row-action"
      :aria-label="`${title}：${action}`"
      :aria-expanded="expanded"
      @click="emit('action')"
    >
      {{ action }}
    </button>
    <slot />
  </div>
</template>

<style scoped>
.overview-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 14px;
  align-items: baseline;
  padding: 16px 0 14px;
  border-bottom: 1px solid var(--ui-border);
}
.overview-row:has(> .row-action):hover {
  background: var(--ui-bg-muted);
}
.row-title {
  font-size: 15px;
  line-height: 1.5;
  font-weight: 500;
}
.row-value {
  grid-row: 1;
  grid-column: 2;
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 300;
  line-height: 1.1;
  text-align: right;
}
.row-note {
  min-width: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.row-note :deep(button),
.row-note :deep(a) {
  position: relative;
  z-index: 1;
  margin-left: 4px;
}
.row-action {
  justify-self: end;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.row-action::after {
  content: '';
  position: absolute;
  inset: 0;
}
.row-action:focus-visible {
  outline-offset: -2px;
}
.overview-row:hover .row-action {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.hot .row-title {
  font-weight: 600;
}
.hot .row-value {
  font-weight: 400;
  color: var(--ui-error);
}
.hot .row-action {
  color: var(--ui-error);
}
.zero .row-value {
  color: var(--ui-text-muted);
}
</style>
