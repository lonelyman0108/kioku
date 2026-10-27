<script setup lang="ts">
import { watchEffect } from 'vue'
import { useRouter } from 'vue-router'

import { useSession } from '../composables/useSession'

// 根路径跳到第一个空间的概览
const router = useRouter()
const { me, space } = useSession()
watchEffect(() => {
  if (space.value) void router.replace({ name: 'overview', params: { spaceId: space.value.id } })
})
</script>

<template>
  <UDashboardPanel id="home">
    <template #body>
      <p v-if="me.data.value && !space" class="text-muted">
        你还不在任何空间里：请空间的 owner 把你加入空间后再刷新。
      </p>
      <p v-else class="text-muted">正在打开空间……</p>
    </template>
  </UDashboardPanel>
</template>
