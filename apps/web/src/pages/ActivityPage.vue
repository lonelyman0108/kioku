<script setup lang="ts">
import { useInfiniteQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { groupByDay } from '../activity'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import ActivityEntry from '../components/ActivityEntry.vue'
import Hint from '../components/Hint.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import PageHead from '../components/strata/PageHead.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { useNow } from '../composables/useNow'
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
// 页面开过零点时「今天」「昨天」跟着变
const now = useNow()
const days = computed(() => groupByDay(items.value, now.value))
</script>

<template>
  <div class="activity">
    <PageHead title="变更记录">
      <template #hint>
        <Hint>通过 Key 写入的改动，操作方显示为应用。</Hint>
      </template>
      <template #actions>
        <UButton
          :icon="icons.refresh"
          color="neutral"
          variant="ghost"
          aria-label="刷新"
          :loading="activity.isRefetching.value"
          @click="activity.refetch()"
        />
      </template>
    </PageHead>
    <div class="activity-body">
      <NoteLine v-if="activity.isError.value" tone="error">
        {{ activity.error.value instanceof ApiError ? activity.error.value.message : '读取失败' }}
      </NoteLine>
      <div v-else-if="activity.isPending.value" class="space-y-3">
        <USkeleton v-for="n in 6" :key="n" class="h-8 w-full" />
      </div>
      <template v-else>
        <section v-for="day in days" :key="day.key" class="activity-day">
          <SectionHeading :title="day.label" />
          <ul>
            <ActivityEntry
              v-for="item in day.items"
              :key="item.id"
              :item="item"
              :space-id="spaceId"
            />
          </ul>
        </section>
        <p v-if="!items.length" class="empty">暂无变更记录</p>
        <div v-if="activity.hasNextPage.value" class="flex justify-center py-4">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :loading="activity.isFetchingNextPage.value"
            @click="activity.fetchNextPage()"
          >
            加载更多
          </UButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.activity {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.activity-body {
  padding: 0 32px 40px;
}
.activity-day + .activity-day {
  margin-top: 22px;
}
.empty {
  padding: 4px 0;
  color: var(--ui-text-muted);
}
@media (max-width: 1023.98px) {
  .activity-body {
    padding: 0 16px 28px;
  }
}
</style>
