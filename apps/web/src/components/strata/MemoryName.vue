<script setup lang="ts">
import { computed } from 'vue'

import { memoryTitle } from '../../coordinates'

// 列表里一条记忆的名字：写标题，坐标放在悬停里。目录、列表与搜索都写标题，坐标只在详情底部出现；
// 没有标题的（快照里的旧版本、已经看不到的）退回坐标的最后一段
const props = defineProps<{ uri: string; title?: string | null }>()
const name = computed(() => memoryTitle(props))
</script>

<template>
  <span class="memory-name" :title="`${name}\n${uri}`">{{ name }}</span>
</template>

<style scoped>
.memory-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
