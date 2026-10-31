<script setup lang="ts">
// 一段原文：放在 <pre> 里原样显示，不渲染、不去空白。模型的输出与记忆里的内容都不可信。
// 带标题时可以折叠；quiet 的标题退后一级，用在不常看的内容上
defineProps<{ text: string; title?: string; open?: boolean; quiet?: boolean }>()
</script>

<template>
  <details v-if="title" :open="open" class="fold" :class="{ quiet }">
    <summary>{{ title }}</summary>
    <pre>{{ text }}</pre>
  </details>
  <pre v-else>{{ text }}</pre>
</template>

<style scoped>
pre {
  max-height: 24rem;
  margin-top: 6px;
  padding: 8px 12px;
  overflow: auto;
  background: var(--ui-bg-elevated);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.fold > summary {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.6;
  cursor: pointer;
}
.fold > summary::marker {
  font-size: 0.8em;
  color: var(--ui-text-muted);
}
.fold.quiet > summary {
  font-weight: 400;
  color: var(--ui-text-muted);
}
</style>
