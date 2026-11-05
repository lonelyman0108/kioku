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
  <div class="home">
    <p v-if="me.data.value && !space">当前账号未加入任何空间。请联系空间所有者添加后刷新页面。</p>
    <p v-else>正在打开空间……</p>
  </div>
</template>

<style scoped>
.home {
  flex: 1;
  min-width: 0;
  padding: 24px 32px;
  color: var(--ui-text-muted);
}
@media (max-width: 1023.98px) {
  .home {
    padding: 16px;
  }
}
</style>
