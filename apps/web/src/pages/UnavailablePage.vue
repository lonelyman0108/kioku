<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import EntryFrame from '../components/strata/EntryFrame.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { formatTime } from '../time'
import { retryNavigation, retryTarget } from '../unavailable'

const route = useRoute()
const router = useRouter()

const retrying = ref(false)
// 上一次重试没成功的时间：地址不变，不说一声看起来像没反应
const failedAt = ref<string | null>(null)
// 没成功是因为页面文件加载不到：接口是通的，再重试也一样，要刷新页面换成新的文件
const assetsFailed = ref(false)

async function retry() {
  retrying.value = true
  const result = await retryNavigation(router, retryTarget(route.query.next))
  retrying.value = false
  if (result === 'recovered') return
  failedAt.value = new Date().toISOString()
  assetsFailed.value = result === 'assets'
}
</script>

<template>
  <EntryFrame>
    <SectionHeading title="无法连接到服务" :level="1" />
    <div class="mt-3 space-y-2">
      <p>服务可能正在重启或升级，请稍后重试。连接恢复后回到之前的页面。</p>
      <p class="text-muted">持续无法连接时，请检查服务进程、数据库与反向代理的状态。</p>
    </div>
    <UButton class="mt-5" size="lg" block :loading="retrying" @click="retry">重试</UButton>
    <p v-if="failedAt" class="mt-2 text-muted" role="status">
      <template v-if="assetsFailed">
        页面文件加载失败（{{ formatTime(failedAt) }}）。服务可能已升级，请刷新页面。
      </template>
      <template v-else>仍无法连接（{{ formatTime(failedAt) }}）</template>
    </p>
  </EntryFrame>
</template>
