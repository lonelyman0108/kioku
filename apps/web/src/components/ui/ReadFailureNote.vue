<script setup lang="ts">
import { computed } from 'vue'

import { readFailure, retryable } from '../../api/client'
import type { ReadState } from '../../query'
import NoteLine from './NoteLine.vue'

// 读取失败的一行：文字一律经 readFailure，再读有用时（retryable）右边给「重试」，重读期间转圈。
// 读到过内容、这次刷新失败（还能再读）时内容照常显示，这一行用提醒的语气写「刷新失败：…」；
// 没读到过，或者是确定的结果（不存在、无权访问），才是错误的语气。size 跟着所在区块的按钮大小
const props = withDefaults(
  defineProps<{ query: ReadState; fallback?: string; size?: 'xs' | 'sm' }>(),
  { fallback: undefined, size: 'sm' },
)

const again = computed(() => retryable(props.query.error.value))
const stale = computed(() => props.query.data.value != null && again.value)
</script>

<template>
  <NoteLine :tone="stale ? 'warning' : 'error'">
    {{ stale ? '刷新失败：' : '' }}{{ readFailure(query.error.value, fallback) }}
    <template v-if="again" #actions>
      <UButton
        :size="size"
        color="neutral"
        variant="outline"
        :loading="query.isFetching.value"
        @click="query.refetch()"
        >重试</UButton
      >
    </template>
  </NoteLine>
</template>
