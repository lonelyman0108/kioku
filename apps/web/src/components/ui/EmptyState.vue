<script setup lang="ts">
import KiokuMark from '../KiokuMark.vue'

// 列表读到空时的样子：图标或淡色的品牌标记、名词短语的标题、可选的一句说明与下一步的操作。
// 只在真的读到空时用，读取失败照常是 ReadFailureNote
withDefaults(
  defineProps<{
    title: string
    description?: string | null
    icon?: string
    tone?: 'neutral' | 'success'
  }>(),
  {
    description: undefined,
    icon: undefined,
    tone: 'neutral',
  },
)
</script>

<template>
  <div class="empty-state">
    <UIcon v-if="icon" :name="icon" class="empty-icon" :class="tone" aria-hidden="true" />
    <KiokuMark v-else class="empty-mark" :height="22" aria-hidden="true" />
    <p class="empty-title">
      {{ title }}
      <slot name="hint" />
    </p>
    <p v-if="description || $slots.description" class="empty-description">
      <slot name="description">{{ description }}</slot>
    </p>
    <div v-if="$slots.actions" class="empty-actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.empty-state {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 32px 16px;
  text-align: center;
}
.empty-icon {
  display: inline-block;
  flex: none;
  width: 28px;
  height: 28px;
  color: var(--ui-text-muted);
}
.empty-icon.success {
  color: var(--ui-success);
}
.empty-mark {
  color: var(--ui-border-accented);
}
.empty-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--ui-text-highlighted);
}
.empty-description {
  max-width: 32em;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}
</style>
