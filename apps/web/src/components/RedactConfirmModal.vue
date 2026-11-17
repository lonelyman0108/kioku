<script setup lang="ts">
import type { RedactMode } from '@kioku/contracts'
import { ref } from 'vue'

import ConsequenceModal from './ConsequenceModal.vue'

withDefaults(
  defineProps<{
    open: boolean
    title?: string
    busy?: boolean
  }>(),
  { title: '', busy: false },
)
const emit = defineEmits<{ confirm: [mode: RedactMode]; close: [] }>()

const mode = ref<RedactMode>('stars')
const modes = [
  { label: '替换为 ***', value: 'stars' },
  { label: '替换为类别标签', value: 'tag' },
]
const consequences = [
  '正文中的敏感片段将被替换为 *** 或类别标签，无法直接还原',
  '仅适用于清理误粘贴的冗余文本；若需保留原值，请改用「移入本人私密」或「设为机密」',
]
</script>

<template>
  <ConsequenceModal
    :open="open"
    :title="title ? `抹除「${title}」中的敏感片段？` : '抹除正文中的敏感片段？'"
    :consequences="consequences"
    action="抹除敏感段"
    :busy="busy"
    @close="emit('close')"
    @confirm="emit('confirm', mode)"
  >
    <UFormField label="替换形式">
      <USelect v-model="mode" :items="modes" value-key="value" size="sm" class="w-44" />
    </UFormField>
  </ConsequenceModal>
</template>
