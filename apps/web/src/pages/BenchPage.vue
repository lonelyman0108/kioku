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
  { label: '调用台', value: 'calls' },
  { label: '场景', value: 'scenarios' },
  { label: '模型对话', value: 'agent' },
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
  <div class="bench">
    <!-- 放在滚动区外面：内容滚动时一直看得到 -->
    <div v-if="real" role="status" class="real-band">
      <UIcon :name="icons.warning" class="real-icon" />
      真实模式：写入立即生效，不会回滚
    </div>
    <div class="bench-scroll">
      <BenchToolbar />
      <BenchAbandoned />
      <div v-if="mounted" v-show="ready" class="bench-tabs">
        <UTabs
          v-model="tab"
          :items="tabs"
          :content="false"
          class="tab-bar"
          :ui="{ root: 'min-w-0', list: 'border-0', trigger: 'px-2 py-0 h-11 text-sm/5' }"
        />
        <BenchCalls v-show="tab === 'calls'" />
        <BenchScenarios v-show="tab === 'scenarios'" />
        <BenchAgent v-show="tab === 'agent'" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.bench {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.real-band {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 32px;
  background: var(--ui-error);
  color: var(--ui-text-inverted);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
}
.real-icon {
  flex: none;
  display: inline-block;
  width: 16px;
  height: 16px;
}
/* 宽屏时页头一直在，分页占满下面的高度，各栏自己滚动；放不下三栏时整页滚动 */
.bench-scroll {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.bench-tabs {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 26rem;
}
.tab-bar {
  flex: none;
  padding: 0 24px;
  border-top: 1px solid var(--strata-rule);
  border-bottom: 1px solid var(--ui-border-accented);
}
@media (max-width: 1240px) {
  .bench-tabs {
    flex: 1 0 auto;
    min-height: 0;
  }
}
@media (max-width: 1023.98px) {
  .real-band {
    padding: 6px 16px;
  }
  .tab-bar {
    padding: 0 8px;
  }
}
</style>
