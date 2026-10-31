<script setup lang="ts">
import { icons } from '../icons'

// 长说明收进这里：页面上只留一句话，原理、规则和例外点开才看
withDefaults(defineProps<{ label?: string }>(), { label: '说明' })
</script>

<template>
  <UPopover :content="{ side: 'top', collisionPadding: 12 }">
    <button
      type="button"
      class="inline-flex size-4 cursor-pointer items-center justify-center align-[-0.15em] text-muted hover:text-default"
      :aria-label="label"
    >
      <UIcon :name="icons.info" class="size-3.5" />
    </button>
    <template #content>
      <div class="max-w-xs p-3 text-sm text-default"><slot /></div>
    </template>
  </UPopover>
</template>
