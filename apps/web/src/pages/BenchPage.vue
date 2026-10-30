<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import BenchAbandoned from '../components/BenchAbandoned.vue'
import BenchAgent from '../components/BenchAgent.vue'
import BenchCalls from '../components/BenchCalls.vue'
import BenchScenarios from '../components/BenchScenarios.vue'
import BenchToolbar from '../components/BenchToolbar.vue'
import { provideBench } from '../composables/useBench'
import { icons } from '../icons'

// 这一页只放分页，内容在各分页的组件里，共享的状态在 useBench
const { ready, real } = provideBench()

const route = useRoute()
const router = useRouter()
// 分页记在地址里，刷新、分享都还在。分页组件都留着（v-show）：切回来时草稿与结果还在
const tabs = [
  { label: '调用台', value: 'calls', icon: icons.benchCalls },
  { label: '场景', value: 'scenarios', icon: icons.benchScenarios },
  { label: '模型对话', value: 'agent', icon: icons.bot },
]
const tab = computed<string>({
  get: () => (tabs.some((t) => t.value === route.query.tab) ? String(route.query.tab) : 'calls'),
  set: (value) =>
    void router.replace({ query: { ...route.query, tab: value === 'calls' ? undefined : value } }),
})

// 换应用时 Key 要重新读，这段时间不算就绪。第一次就绪之后分页组件就不再卸载：卸载会丢掉草稿与文本框里的场景
const mounted = ref(false)
watchEffect(() => {
  if (ready.value) mounted.value = true
})
</script>

<template>
  <UDashboardPanel id="bench">
    <template #header>
      <UDashboardNavbar title="测试台" />
      <!-- 放在页头里：内容滚动时一直看得到 -->
      <div
        v-if="real"
        role="status"
        class="flex items-center gap-2 bg-error px-4 py-2 text-sm font-medium text-inverted sm:px-6"
      >
        <UIcon :name="icons.warning" class="size-4 shrink-0" />
        真实模式：写入是真的，不会回滚
      </div>
    </template>
    <template #body>
      <div class="max-w-6xl space-y-4">
        <BenchToolbar />
        <BenchAbandoned />
        <div v-if="mounted" v-show="ready" class="space-y-4">
          <UTabs v-model="tab" :items="tabs" :content="false" class="w-full" />
          <BenchCalls v-show="tab === 'calls'" />
          <BenchScenarios v-show="tab === 'scenarios'" />
          <BenchAgent v-show="tab === 'agent'" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
