<script setup lang="ts">
// 区块标题：名词短语加一条墨线。标题旁的提示放 hint，右边的操作放 actions
withDefaults(defineProps<{ title?: string; level?: 1 | 2 | 3 | 4; icon?: string }>(), {
  title: undefined,
  level: 2,
  icon: undefined,
})
</script>

<template>
  <div class="flex items-baseline justify-between gap-3 border-b border-rule pb-1.5">
    <component :is="`h${level}`" class="flex items-center gap-1.5 text-sm/6 font-semibold">
      <UIcon
        v-if="icon"
        :name="icon"
        class="inline-block size-4 shrink-0 text-muted"
        aria-hidden="true"
      />
      <slot>{{ title }}</slot>
      <slot name="hint" />
    </component>
    <div v-if="$slots.actions" class="flex shrink-0 items-center gap-1.5 text-[13px] text-muted">
      <slot name="actions" />
    </div>
  </div>
</template>
