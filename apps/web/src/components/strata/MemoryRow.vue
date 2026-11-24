<script setup lang="ts">
import type { EntryKind, Sensitivity, StrataBand } from '@kioku/contracts'
import type { RouteLocationRaw } from 'vue-router'

import MemoryFlags from './MemoryFlags.vue'
import StrataSwatch from './StrataSwatch.vue'

// 列表、已过期、已删除共用的一行：色块、标题与短 ID、标记，第二行的内容和右下的操作由使用方给。
// data-band、data-short-id 给记忆页：悬停一行时窄柱上对应的色带跟着亮，窄屏返回时焦点放回这一行。
withDefaults(
  defineProps<{
    shortId: string
    title?: string | null
    band: StrataBand
    kind?: EntryKind | null
    sensitivity: Sensitivity
    priority?: number | null
    variantCount?: number | null
    local?: boolean
    selected?: boolean
    as?: string
    to?: RouteLocationRaw | null
    flush?: boolean
  }>(),
  {
    title: null,
    kind: null,
    priority: null,
    variantCount: null,
    local: false,
    selected: false,
    as: 'div',
    to: null,
    flush: false,
  },
)
</script>

<template>
  <component
    :is="as"
    class="memory-row"
    :class="{ selected, flush, linked: to }"
    :data-band="band"
    :data-short-id="shortId"
  >
    <StrataSwatch class="row-swatch" :band="band" :sensitivity="sensitivity" :local="local" />
    <RouterLink
      v-if="to"
      :to="to"
      class="row-main row-link"
      :title="title ? `${title}\n${shortId}` : shortId"
    >
      <span class="row-title">{{ title || shortId }}</span>
      <code class="row-id">{{ shortId }}</code>
    </RouterLink>
    <span v-else class="row-main" :title="title ? `${title}\n${shortId}` : shortId">
      <span class="row-title">{{ title || shortId }}</span>
      <code class="row-id">{{ shortId }}</code>
    </span>
    <slot name="flags">
      <MemoryFlags
        :band="band"
        :kind="kind"
        :sensitivity="sensitivity"
        :priority="priority"
        :variant-count="variantCount"
        :local="local"
      />
    </slot>
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
.memory-row.flush {
  padding-inline: 0;
}
.memory-row:is(button, .linked):hover {
  background: var(--ui-bg-elevated);
}
.memory-row.linked {
  position: relative;
}
.row-link {
  min-width: 0;
}
.row-link::after {
  content: '';
  position: absolute;
  inset: 0;
}
.row-link:focus-visible {
  outline-offset: -2px;
}
.memory-row.linked .row-actions :deep(a),
.memory-row.linked .row-actions :deep(button),
.memory-row.linked .row-sub :deep(a),
.memory-row.linked .row-sub :deep(button) {
  position: relative;
  z-index: 1;
}
.memory-row:focus-visible {
  outline-offset: -2px;
}
.memory-row.selected,
.memory-row.selected:hover {
  --strata-frame: var(--strata-selected-frame);
  --flag-muted: var(--strata-on-selected-muted);
  --flag-solid: var(--strata-on-selected);
  --flag-on-solid: var(--strata-selected);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.row-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
  line-height: 1.5;
}
.row-title {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-id {
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--flag-muted, var(--ui-text-muted));
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
