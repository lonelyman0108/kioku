<script setup lang="ts">
import { useDirtyParts } from '../composables/useDirtyParts'
import EmbeddingSettings from './EmbeddingSettings.vue'
import ExtractionSettings from './ExtractionSettings.vue'
import ModelProvidersSettings from './ModelProvidersSettings.vue'
import PrivacyModelSettings from './PrivacyModelSettings.vue'

// 实例 › 模型：模型服务商池、嵌入模型、抽取与整理模型、隐私识别模型
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const dirty = useDirtyParts(dirtyModel, ['providers', 'embedding', 'extraction', 'privacy'])
</script>

<template>
  <div class="space-y-8">
    <ModelProvidersSettings v-model:dirty="dirty.providers" />
    <EmbeddingSettings v-model:dirty="dirty.embedding" />
    <ExtractionSettings v-model:dirty="dirty.extraction" />
    <PrivacyModelSettings v-model:dirty="dirty.privacy" />
  </div>
</template>
