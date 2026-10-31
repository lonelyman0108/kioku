<script setup lang="ts">
import { computed } from 'vue'

import { useBench } from '../composables/useBench'
import { icons } from '../icons'

// 模型循环可能持续数分钟，这期间别的分页跑不了：说清楚为什么，给停止的入口
const { agentSending, agentStopping, stopAgent } = useBench()
const actions = computed(() => [
  {
    label: agentStopping.value ? '正在停止' : '停止模型对话',
    icon: icons.stop,
    color: 'neutral' as const,
    variant: 'subtle' as const,
    disabled: agentStopping.value,
    onClick: stopAgent,
  },
])
</script>

<template>
  <UAlert
    v-if="agentSending"
    color="neutral"
    variant="subtle"
    title="模型对话进行中，结束前无法运行。"
    :actions="actions"
  />
</template>
