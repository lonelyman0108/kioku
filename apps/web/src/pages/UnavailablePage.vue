<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

// 只回到站内路径
function retry() {
  const next = route.query.next
  const target =
    typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  void router.replace(target)
}
</script>

<template>
  <div class="flex min-h-svh items-center justify-center p-6">
    <UCard class="w-full max-w-sm">
      <div class="space-y-4">
        <h1 class="text-lg font-semibold">暂时连不上 Kioku</h1>
        <p class="text-sm text-muted">服务可能正在重启或升级。稍等片刻再重试。</p>
        <UButton block @click="retry">重试</UButton>
      </div>
    </UCard>
  </div>
</template>
