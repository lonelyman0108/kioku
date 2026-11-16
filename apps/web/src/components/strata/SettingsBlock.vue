<script setup lang="ts">
import FlagTag from './FlagTag.vue'
import SectionHeading from './SectionHeading.vue'

// 设置里的一块：双阶纸面标题头、一句说明，下面是表单或状态。
// 表单太宽不好读，默认限宽；要放长列表或对照表的用 wide。小节的标题是 h2，块是 h3；
// 一块里还能再分块（例如导入的各个来源），里面那块用 level 4
withDefaults(
  defineProps<{
    title: string
    wide?: boolean
    level?: 3 | 4
    badge?: string
    tone?: 'instant' | 'form' | 'readonly' | 'neutral'
  }>(),
  {
    wide: false,
    level: 3,
    badge: undefined,
    tone: 'neutral',
  },
)
</script>

<template>
  <section class="settings-block" :class="{ wide }">
    <div class="block-head">
      <SectionHeading :title="title" :level="level">
        <template v-if="badge || $slots.actions" #actions>
          <span class="head-actions">
            <FlagTag v-if="badge" class="scope-badge" :data-tone="tone">{{ badge }}</FlagTag>
            <slot name="actions" />
          </span>
        </template>
      </SectionHeading>
      <p v-if="$slots.note" class="block-note"><slot name="note" /></p>
    </div>
    <div class="block-body" :class="{ 'under-heading': !$slots.note }"><slot /></div>
  </section>
</template>

<style scoped>
.settings-block {
  max-width: 44rem;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
/* 里面那块放宽时外面跟着放宽，不然被外面的限宽挡住 */
.settings-block.wide,
.settings-block:has(.settings-block.wide) {
  max-width: 64rem;
}
.settings-block + .settings-block {
  margin-top: 24px;
}
.block-head {
  padding: 12px 18px 10px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
/* 块头里已经有底线框，SectionHeading 自己的底线去掉避免双线 */
.block-head :deep(.heading) {
  padding-bottom: 0;
  border-bottom: 0;
}
.head-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.scope-badge[data-tone='instant'] {
  border-color: var(--ui-success);
  color: var(--ui-success);
}
.scope-badge[data-tone='form'] {
  border-color: var(--ui-info);
  color: var(--ui-info);
}
.scope-badge[data-tone='readonly'] {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.block-note {
  padding-top: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.block-body {
  padding: 12px 18px 16px;
}
/* 没有说明时，开头的状态行直接贴着标题头底线，不再多画一条 */
.under-heading > :deep(.note-line:first-child) {
  margin-top: -12px;
  border-top: 0;
}
@media (max-width: 767.98px) {
  .block-head {
    padding: 10px 14px 8px;
  }
  .block-body {
    padding: 10px 14px 14px;
  }
  .under-heading > :deep(.note-line:first-child) {
    margin-top: -10px;
  }
}
</style>
