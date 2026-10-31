<script setup lang="ts">
import { computed } from 'vue'

import { splitUri } from '../memoryTree'

// URI 是地址：等宽字，上一级路径退一级灰度。一行放不下时先缩上一级路径，名字留到最后
const props = defineProps<{ uri: string }>()
const parts = computed(() => splitUri(props.uri))
</script>

<template>
  <span class="uri-path" :title="uri">
    <span class="uri-parent">{{ parts.parent }}</span>
    <span class="uri-leaf">{{ parts.leaf }}</span>
  </span>
</template>

<style scoped>
.uri-path {
  display: flex;
  min-width: 0;
  font-family: var(--font-mono);
  white-space: pre;
}
.uri-parent,
.uri-leaf {
  overflow: hidden;
  text-overflow: ellipsis;
}
.uri-parent {
  flex: 0 1000 auto;
  color: var(--uri-parent, var(--ui-text-muted));
}
.uri-leaf {
  flex: 0 1 auto;
}
</style>
