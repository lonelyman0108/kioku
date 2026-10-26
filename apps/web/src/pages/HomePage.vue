<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'

import { fetchHealth } from '../api'

const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth })
</script>

<template>
  <UContainer class="py-16">
    <h1 class="text-2xl font-semibold">Kioku</h1>
    <p class="mt-2 text-muted">多账号、多人格、分层授权的长期记忆服务</p>
    <div class="mt-8 flex items-center gap-2">
      <UBadge v-if="health.isPending.value" color="neutral" variant="subtle">连接中</UBadge>
      <UBadge v-else-if="health.isError.value" color="error" variant="subtle">后端不可用</UBadge>
      <UBadge v-else color="success" variant="subtle">
        后端正常 · {{ health.data.value?.version }}
      </UBadge>
    </div>
  </UContainer>
</template>
