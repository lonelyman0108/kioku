<script setup lang="ts">
import { useDirtyParts } from '../composables/useDirtyParts'
import EmbeddingSettings from './EmbeddingSettings.vue'
import ExtractionSettings from './ExtractionSettings.vue'

// 实例 › 模型：嵌入模型与抽取模型，各自带测试与保存按钮
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const dirty = useDirtyParts(dirtyModel, ['embedding', 'extraction'])
</script>

<template>
  <div class="space-y-8">
    <EmbeddingSettings v-model:dirty="dirty.embedding" />
    <ExtractionSettings v-model:dirty="dirty.extraction" />
  </div>
</template>
