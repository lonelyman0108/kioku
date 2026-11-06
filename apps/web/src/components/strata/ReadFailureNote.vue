<script setup lang="ts">
import { readFailure, retryable } from '../../api/client'
import type { ReadState } from '../../query'
import NoteLine from './NoteLine.vue'

// 读取失败的一行：文字一律经 readFailure，再读有用时（retryable）右边给「重试」，重读期间转圈。
// stale：已经读到过内容、这次刷新失败。内容照常显示，这一行用提醒的语气放在上面
withDefaults(defineProps<{ query: ReadState; fallback?: string; stale?: boolean }>(), {
  fallback: undefined,
  stale: false,
})
</script>

<template>
  <NoteLine :tone="stale ? 'warning' : 'error'">
    {{ stale ? '刷新失败：' : '' }}{{ readFailure(query.error.value, fallback) }}
    <template v-if="retryable(query.error.value)" #actions>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        :loading="query.isFetching.value"
        @click="query.refetch()"
        >重试</UButton
      >
    </template>
  </NoteLine>
</template>
