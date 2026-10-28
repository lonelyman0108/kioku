<script setup lang="ts">
import type { AppRecallVolume } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { layerShortLabels, recallSourceLabels, sensitivityLabels } from '../labels'
import { memoryRoute } from '../routes'
import { formatTime } from '../time'

const route = useRoute()
const spaceId = computed(() => String(route.params.spaceId))

const stats = useQuery({
  queryKey: computed(() => ['recall-stats', spaceId.value]),
  queryFn: () => api.recallStats(spaceId.value),
})

const sourceSummary = (volume: AppRecallVolume) =>
  volume.sources.map((entry) => `${recallSourceLabels[entry.source]} ${entry.count}`).join(' · ')

const memoryLink = (uri: string) => memoryRoute(spaceId.value, uri)
</script>

<template>
  <UDashboardPanel id="recall">
    <template #header>
      <UDashboardNavbar title="召回分析" />
    </template>
    <template #body>
      <UAlert
        v-if="stats.isError.value && !stats.data.value"
        color="error"
        variant="subtle"
        :title="stats.error.value instanceof ApiError ? stats.error.value.message : '读取失败'"
      />
      <USkeleton v-else-if="!stats.data.value" class="h-60 w-full" />
      <div v-else class="max-w-4xl space-y-6 text-sm">
        <p class="text-muted">
          召回事件<template v-if="stats.data.value.recordingSince"
            >从 {{ formatTime(stats.data.value.recordingSince) }} 开始记录，</template
          >明细保留 {{ stats.data.value.retentionDays }} 天，更早的只留下每条记忆的累计次数。
          次数只算你在管理界面里看得到的记忆；各应用的调用量只列你能管它 Key 的应用。
        </p>

        <UCard>
          <template #header><h2 class="font-medium">各应用的调用量</h2></template>
          <ul v-if="stats.data.value.apps.length" class="divide-y divide-default">
            <li
              v-for="volume in stats.data.value.apps"
              :key="volume.appId"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <RouterLink
                v-if="volume.name"
                :to="{ name: 'app', params: { spaceId, appId: volume.appId } }"
                class="font-medium text-primary hover:underline"
                >{{ volume.name }}</RouterLink
              >
              <span v-else class="text-muted">已删除的应用</span>
              <span class="tabular-nums">{{ volume.total }} 次</span>
              <span class="text-xs text-muted">{{ sourceSummary(volume) }}</span>
            </li>
          </ul>
          <p v-else class="text-muted">保留期内还没有召回。</p>
        </UCard>

        <UCard>
          <template #header><h2 class="font-medium">常被召回的</h2></template>
          <ul v-if="stats.data.value.top.length" class="divide-y divide-default">
            <li
              v-for="memory in stats.data.value.top"
              :key="memory.id"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <span class="w-14 shrink-0 text-right tabular-nums">{{ memory.total }} 次</span>
              <RouterLink :to="memoryLink(memory.uri)" class="font-mono text-xs hover:underline">{{
                memory.uri
              }}</RouterLink>
              <UBadge size="sm" variant="subtle" color="neutral">{{
                `${layerShortLabels[memory.layer]} · ${sensitivityLabels[memory.sensitivity]}`
              }}</UBadge>
              <span v-if="memory.lastRecalledAt" class="ml-auto text-xs text-muted"
                >最后一次 {{ formatTime(memory.lastRecalledAt) }}</span
              >
            </li>
          </ul>
          <p v-else class="text-muted">还没有记忆被召回过。</p>
        </UCard>

        <UCard>
          <template #header>
            <h2 class="font-medium">从没被召回的（{{ stats.data.value.neverTotal }}）</h2>
            <p class="mt-1 text-xs text-muted">
              最早建的在前。建了、以及开始记录召回事件都满 {{ stats.data.value.retentionDays }}
              天才算；secret
              不进召回，会进启动上下文的节点每次会话开始都注入，都不在这里。长期没被召回的，看看是缺关键词与
              disclosure、写得太笼统，还是已经没用了。
            </p>
          </template>
          <ul v-if="stats.data.value.never.length" class="divide-y divide-default">
            <li
              v-for="memory in stats.data.value.never"
              :key="memory.id"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <RouterLink :to="memoryLink(memory.uri)" class="font-mono text-xs hover:underline">{{
                memory.uri
              }}</RouterLink>
              <UBadge size="sm" variant="subtle" color="neutral">{{
                `${layerShortLabels[memory.layer]} · ${sensitivityLabels[memory.sensitivity]}`
              }}</UBadge>
              <span class="ml-auto text-xs text-muted"
                >建于 {{ formatTime(memory.createdAt) }}</span
              >
            </li>
          </ul>
          <p v-else class="text-muted">都被召回过。</p>
          <p
            v-if="stats.data.value.neverTotal > stats.data.value.never.length"
            class="mt-2 text-xs text-muted"
          >
            只列出了最早的 {{ stats.data.value.never.length }} 条。
          </p>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
