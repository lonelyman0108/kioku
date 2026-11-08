<script setup lang="ts">
import { reactive, watch } from 'vue'

import BackupSettings from './BackupSettings.vue'
import RetentionSettings from './RetentionSettings.vue'

// 实例 › 数据与保留：两种保留天数一张表、共用一个保存条，下面是备份（有自己的测试与保存）
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const dirty = reactive({ retention: false, backup: false })
watch(
  () => dirty.retention || dirty.backup,
  (changed) => (dirtyModel.value = changed),
  { immediate: true },
)
</script>

<template>
  <div class="space-y-8">
    <RetentionSettings v-model:dirty="dirty.retention" />
    <BackupSettings v-model:dirty="dirty.backup" />
  </div>
</template>
