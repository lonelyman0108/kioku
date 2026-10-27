<script setup lang="ts">
import { useInfiniteQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import ActivityEntry from '../components/ActivityEntry.vue'
import { icons } from '../icons'

const route = useRoute()
const spaceId = computed(() => String(route.params.spaceId))

// 一页一页往后加载；看不到的记忆的改动服务端已经滤掉
const activity = useInfiniteQuery({
  queryKey: computed(() => ['activity', spaceId.value]),
  queryFn: ({ pageParam }) => api.activity(spaceId.value, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})
const items = computed(() => activity.data.value?.pages.flatMap((page) => page.items) ?? [])
</script>

<template>
  <UDashboardPanel id="activity">
    <template #header>
      <UDashboardNavbar title="活动">
        <template #right>
          <UButton
            :icon="icons.refresh"
            color="neutral"
            variant="ghost"
            aria-label="刷新"
            :loading="activity.isRefetching.value"
            @click="activity.refetch()"
          />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <p class="mb-4 text-sm text-muted">
        谁、在什么时候改了哪些记忆。只列你看得到的记忆；通过 Key 写入的显示应用。
      </p>
      <UAlert
        v-if="activity.isError.value"
        color="error"
        variant="subtle"
        :title="
          activity.error.value instanceof ApiError ? activity.error.value.message : '读取失败'
        "
      />
      <div v-else-if="activity.isPending.value" class="space-y-3">
        <USkeleton v-for="n in 6" :key="n" class="h-8 w-full" />
      </div>
      <template v-else>
        <div class="divide-y divide-default">
          <ActivityEntry v-for="item in items" :key="item.id" :item="item" :space-id="spaceId" />
        </div>
        <p v-if="!items.length" class="text-sm text-muted">还没有改动。</p>
        <div v-if="activity.hasNextPage.value" class="mt-4 flex justify-center">
          <UButton
            color="neutral"
            variant="subtle"
            :loading="activity.isFetchingNextPage.value"
            @click="activity.fetchNextPage()"
          >
            加载更多
          </UButton>
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
