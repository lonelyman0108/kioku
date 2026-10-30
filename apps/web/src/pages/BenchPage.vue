<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

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
]
const tab = computed<string>({
  get: () => (tabs.some((t) => t.value === route.query.tab) ? String(route.query.tab) : 'calls'),
  set: (value) =>
    void router.replace({ query: { ...route.query, tab: value === 'calls' ? undefined : value } }),
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
        <template v-if="ready">
          <UTabs v-model="tab" :items="tabs" :content="false" class="w-full" />
          <BenchCalls v-show="tab === 'calls'" />
          <BenchScenarios v-show="tab === 'scenarios'" />
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
