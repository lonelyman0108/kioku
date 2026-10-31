<script setup lang="ts">
import { computed } from 'vue'

import { splitUri } from '../memoryTree'

// URI 是地址：等宽字，上一级路径退一级灰度。一行放不下时先缩上一级路径，名字留到最后；
// wrap：要看全的地方（测试台的结果）不缩，折行显示
const props = defineProps<{ uri: string; wrap?: boolean }>()
const parts = computed(() => splitUri(props.uri))
</script>

<template>
  <span class="uri-path" :class="{ wrap }" :title="uri">
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
.uri-path.wrap {
  display: inline;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
