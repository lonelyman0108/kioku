<script setup lang="ts">
import { computed } from 'vue'

// 列表里一条词条的显示名：写标题，短 ID 放在悬停里；没有标题时退回短 ID
const props = defineProps<{ shortId: string; title?: string | null }>()
const name = computed(() => props.title?.trim() || props.shortId)
</script>

<template>
  <span class="memory-name" :title="`${name}\n${shortId}`">{{ name }}</span>
</template>

<style scoped>
.memory-name {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
