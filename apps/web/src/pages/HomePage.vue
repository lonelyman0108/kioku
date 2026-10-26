<script setup lang="ts">
import { watchEffect } from 'vue'
import { useRouter } from 'vue-router'

import { useSession } from '../composables/useSession'

// 根路径跳到第一个空间的记忆页
const router = useRouter()
const { space } = useSession()
watchEffect(() => {
  if (space.value) void router.replace({ name: 'memories', params: { spaceId: space.value.id } })
})
</script>

<template>
  <UDashboardPanel id="home">
    <template #body>
      <p class="text-muted">正在打开空间……</p>
    </template>
  </UDashboardPanel>
</template>
