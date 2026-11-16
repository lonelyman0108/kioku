<script setup lang="ts">
import { runtimeName } from '../runtimes'
import RuntimeIcon from './RuntimeIcon.vue'

withDefaults(defineProps<{ family: string; size?: number }>(), { size: 15 })
</script>

<template>
  <span class="runtime-label">
    <RuntimeIcon :family="family" :size="size" />
    <span class="runtime-text">{{ runtimeName(family) }}</span>
  </span>
</template>

<style scoped>
.runtime-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
}
.runtime-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
</style>
