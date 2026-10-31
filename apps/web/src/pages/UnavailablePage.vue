<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import EntryFrame from '../components/strata/EntryFrame.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { formatTime } from '../time'
import { retryNavigation, retryTarget } from '../unavailable'

const route = useRoute()
const router = useRouter()
const target = computed(() => retryTarget(route.query.next))

const retrying = ref(false)
// 上一次重试还是连不上的时间：守卫转回这一页时地址不变，不说一声看起来像没反应
const failedAt = ref<string | null>(null)
// 接口通了、页面文件加载不到（多半是刚升级，这个页面记着的文件名已经不在了）：再重试也一样，要整页重新载入
const assetsFailed = ref(false)

async function retry() {
  retrying.value = true
  const result = await retryNavigation(router, target.value)
  retrying.value = false
  if (result === 'assets') assetsFailed.value = true
  if (result === 'unreachable') failedAt.value = new Date().toISOString()
}
const reload = () => window.location.assign(target.value)
</script>

<template>
  <EntryFrame>
    <template v-if="assetsFailed">
      <SectionHeading title="页面文件已更新" :level="1" />
      <div class="mt-3 space-y-2">
        <p>服务可能已升级，当前页面的文件已失效。重新载入后回到之前的页面。</p>
        <p class="text-muted">重新载入后仍然失败时，请检查服务进程与反向代理的状态。</p>
      </div>
      <UButton class="mt-5" size="lg" block @click="reload">重新载入</UButton>
    </template>
    <template v-else>
      <SectionHeading title="无法连接到服务" :level="1" />
      <div class="mt-3 space-y-2">
        <p>服务可能正在重启或升级，请稍后重试。连接恢复后回到之前的页面。</p>
        <p class="text-muted">持续无法连接时，请检查服务进程、数据库与反向代理的状态。</p>
      </div>
      <UButton class="mt-5" size="lg" block :loading="retrying" @click="retry">重试</UButton>
      <p v-if="failedAt" class="mt-2 text-muted" role="status">
        仍无法连接（{{ formatTime(failedAt) }}）
      </p>
    </template>
  </EntryFrame>
</template>
