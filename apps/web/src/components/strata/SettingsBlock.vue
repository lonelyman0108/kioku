<script setup lang="ts">
import SectionHeading from './SectionHeading.vue'

// 设置里的一块：标题、一句说明，下面是表单或状态。块之间靠标题的墨线和留白分开。
// 表单太宽不好读，默认限宽；要放长列表的用 wide
withDefaults(defineProps<{ title: string; wide?: boolean }>(), { wide: false })
</script>

<template>
  <section class="settings-block" :class="{ wide }">
    <SectionHeading :title="title">
      <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    </SectionHeading>
    <p v-if="$slots.note" class="block-note"><slot name="note" /></p>
    <div class="block-body" :class="{ 'under-heading': !$slots.note }"><slot /></div>
  </section>
</template>

<style scoped>
.settings-block {
  max-width: 40rem;
}
.settings-block.wide {
  max-width: 60rem;
}
.settings-block + .settings-block {
  margin-top: 32px;
}
.block-note {
  padding-top: 8px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.block-body {
  padding-top: 14px;
}
/* 没有说明时，开头的状态行直接贴着标题的墨线，不再多画一条 */
.under-heading > :deep(.note-line:first-child) {
  margin-top: -14px;
  border-top: 0;
}
</style>
