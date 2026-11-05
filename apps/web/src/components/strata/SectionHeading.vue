<script setup lang="ts">
// 区块标题：名词短语加一条墨线。标题旁的提示放 hint，右边的操作放 actions
withDefaults(defineProps<{ title?: string; level?: 1 | 2 | 3 }>(), { title: undefined, level: 2 })
</script>

<template>
  <div class="flex items-baseline justify-between gap-3 border-b border-rule pb-1.5">
    <component :is="`h${level}`" class="flex items-center gap-1.5 text-sm/6 font-semibold">
      <slot>{{ title }}</slot>
      <slot name="hint" />
    </component>
    <div v-if="$slots.actions" class="flex shrink-0 items-center gap-1.5 text-[13px] text-muted">
      <slot name="actions" />
    </div>
  </div>
</template>
