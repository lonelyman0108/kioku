<script setup lang="ts">
import type { Layer, Sensitivity } from '@kioku/contracts'

import MemoryFlags from './MemoryFlags.vue'
import StrataSwatch from './StrataSwatch.vue'
import UriPath from './UriPath.vue'

// 列表、已过期、已删除共用的一行：色块、URI、标记，第二行的内容和右下的操作由使用方给。
// data-layer、data-uri 给记忆页：悬停一行时窄柱上对应的层跟着亮，窄屏返回时焦点放回这一行
withDefaults(
  defineProps<{
    uri: string
    layer: Layer
    sensitivity: Sensitivity
    priority?: number | null
    selected?: boolean
    as?: string
  }>(),
  { priority: null, selected: false, as: 'div' },
)
</script>

<template>
  <component :is="as" class="memory-row" :class="{ selected }" :data-layer="layer" :data-uri="uri">
    <StrataSwatch class="row-swatch" :layer="layer" :sensitivity="sensitivity" />
    <UriPath class="row-uri" :uri="uri" />
    <MemoryFlags :layer="layer" :sensitivity="sensitivity" :priority="priority" />
    <!-- 整行可能是按钮，里面只放行内元素 -->
    <span class="row-sub"><slot /></span>
    <span v-if="$slots.actions" class="row-actions"><slot name="actions" /></span>
  </component>
</template>

<style scoped>
.memory-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  column-gap: 9px;
  align-items: center;
  width: 100%;
  padding: 8px 14px 7px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
  /* 列表可以翻到很长，看不见的行不排版 */
  content-visibility: auto;
  contain-intrinsic-size: auto 58px;
}
.memory-row:is(button):hover {
  background: var(--ui-bg-elevated);
}
.memory-row:focus-visible {
  outline-offset: -2px;
}
.memory-row.selected,
.memory-row.selected:hover {
  --strata-frame: var(--strata-selected-frame);
  --uri-parent: var(--strata-on-selected-muted);
  --flag-muted: var(--strata-on-selected-muted);
  --flag-solid: var(--strata-on-selected);
  --flag-on-solid: var(--strata-selected);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.row-uri {
  font-size: 14px;
  line-height: 1.5;
}
.row-sub {
  grid-column: 2 / -1;
  min-width: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.memory-row.selected .row-sub {
  color: var(--strata-on-selected-muted);
}
.row-actions {
  grid-column: 2 / -1;
  display: flex;
  justify-content: flex-end;
  gap: 5px;
  margin-top: 5px;
}
</style>
