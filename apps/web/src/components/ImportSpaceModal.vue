<script setup lang="ts">
import { ref } from 'vue'

import SpaceImport from './SpaceImport.vue'

// 导入记忆圈的弹窗：外壳里一份，切换器与首页打开它。检查、导入期间不能关
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const busy = ref(false)
</script>

<template>
  <UModal
    :open="open"
    title="导入记忆圈"
    :dismissible="!busy"
    :close="!busy"
    @update:open="(v) => !v && !busy && emit('close')"
  >
    <template #body>
      <SpaceImport v-if="open" v-model:busy="busy" bare @imported="emit('close')" />
    </template>
  </UModal>
</template>
