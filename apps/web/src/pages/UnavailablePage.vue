<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import EntryFrame from '../components/strata/EntryFrame.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { formatTime } from '../time'

const route = useRoute()
const router = useRouter()

const retrying = ref(false)
// 上一次重试还是连不上的时间：守卫转回这一页时地址不变，不说一声看起来像没反应
const failedAt = ref<string | null>(null)

// 只回到站内路径
async function retry() {
  const next = route.query.next
  const target =
    typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  retrying.value = true
  try {
    await router.replace(target)
    if (route.name === 'unavailable') failedAt.value = new Date().toISOString()
  } finally {
    retrying.value = false
  }
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
      仍无法连接（{{ formatTime(failedAt) }}）
    </p>
  </EntryFrame>
</template>
