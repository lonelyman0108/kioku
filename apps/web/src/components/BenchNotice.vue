<script setup lang="ts">
import { computed } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

import { icons } from '../icons'
import NoteLine from './strata/NoteLine.vue'

export interface NoticeAction {
  label: string
  icon?: string
  color?: 'neutral' | 'warning' | 'error'
  disabled?: boolean
  loading?: boolean
  to?: RouteLocationRaw
  onClick?: () => void
}

// 测试台的提示：一行状态加操作，不铺色块。只有失败与告警带语气色，通过和中性的都是墨色
const props = defineProps<{
  color?: 'success' | 'warning' | 'error' | 'neutral'
  title: string
  description?: string | null
  actions?: readonly NoticeAction[]
  close?: boolean
  flush?: boolean
}>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const tone = computed(() =>
  props.color === 'warning' || props.color === 'error' ? props.color : 'neutral',
)
</script>

<template>
  <NoteLine :tone="tone" :flush="flush" class="wrap-anywhere">
    {{ title }}
    <template v-if="description || $slots.description" #detail>
      <slot name="description">{{ description }}</slot>
    </template>
    <template v-if="actions?.length || close" #actions>
      <UButton
        v-for="action in actions"
        :key="action.label"
        size="sm"
        variant="outline"
        v-bind="action"
      />
      <UButton
        v-if="close"
        :icon="icons.cancel"
        size="sm"
        color="neutral"
        variant="ghost"
        aria-label="关闭"
        @click="emit('update:open', false)"
      />
    </template>
  </NoteLine>
</template>
