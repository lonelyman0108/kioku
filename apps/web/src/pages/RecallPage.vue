<script setup lang="ts">
import type { AppRecallVolume } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
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
      <UDashboardNavbar title="召回" />
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
          <template v-if="stats.data.value.recordingSince"
            >{{ formatTime(stats.data.value.recordingSince) }} 开始记录，</template
          >明细保留 {{ stats.data.value.retentionDays }} 天。
          <Hint>
            更早的事件只保留每条记忆的累计次数。次数仅统计当前账号有权查看的记忆；各应用的调用量仅列出当前账号可管理
            Key 的应用。
          </Hint>
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
          <p v-else class="text-muted">保留期内暂无召回</p>
        </UCard>

        <UCard>
          <template #header><h2 class="font-medium">常被召回的记忆</h2></template>
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
                >最近一次 {{ formatTime(memory.lastRecalledAt) }}</span
              >
            </li>
          </ul>
          <p v-else class="text-muted">暂无被召回的记忆</p>
        </UCard>

        <UCard>
          <template #header>
            <h2 class="font-medium">从未召回（{{ stats.data.value.neverTotal }}）</h2>
            <p class="mt-1 text-xs text-muted">
              创建已满 {{ stats.data.value.retentionDays }} 天，未被任何应用召回。
              <Hint>
                最早创建的排在前面。记忆创建和开始记录召回事件都满
                {{ stats.data.value.retentionDays }}
                天才计入。不含机密内容（不参与召回）和启动加载的节点（每次会话开始时注入）。长期未被召回时，可检查是否缺少关键词与触发场景、内容过于笼统或已无用处。
              </Hint>
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
                >创建于 {{ formatTime(memory.createdAt) }}</span
              >
            </li>
          </ul>
          <p v-else class="text-muted">暂无从未召回的记忆</p>
          <p
            v-if="stats.data.value.neverTotal > stats.data.value.never.length"
            class="mt-2 text-xs text-muted"
          >
            仅显示最早的 {{ stats.data.value.never.length }} 条
          </p>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
