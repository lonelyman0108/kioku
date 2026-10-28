<script setup lang="ts">
import { useInfiniteQuery } from '@tanstack/vue-query'
import { computed } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { recallSourceLabels } from '../labels'
import { memoryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'

// 这个应用的召回记录：服务端只给事件发生时的应用主人，所以列的是你当主人时的那些
const props = defineProps<{ spaceId: string; appId: string }>()

const events = useInfiniteQuery({
  queryKey: computed(() => ['recall-events', props.spaceId, props.appId] as const),
  queryFn: ({ pageParam, queryKey: [, spaceId, appId] }) =>
    api.recallEvents(spaceId, { appId, ...(pageParam ? { cursor: pageParam } : {}) }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})
const items = computed(() => events.data.value?.pages.flatMap((p) => p.items) ?? [])
const memoryLink = (uri: string) => memoryRoute(props.spaceId, uri)
</script>

<template>
  <section class="space-y-3 text-sm">
    <div>
      <h2 class="font-medium">召回记录</h2>
      <p class="mt-1 text-xs text-muted">
        你当这个应用的主人时，它每次召回命中了什么。明细按实例设置的天数保留；转给别人之后，新主人看不到这些。
      </p>
    </div>
    <UAlert
      v-if="events.isError.value && !events.data.value"
      color="error"
      variant="subtle"
      :title="events.error.value instanceof ApiError ? events.error.value.message : '读取失败'"
    />
    <USkeleton v-else-if="events.isPending.value" class="h-24 w-full" />
    <p v-else-if="!items.length" class="text-muted">还没有召回记录。</p>
    <ol v-else class="divide-y divide-default">
      <li v-for="event in items" :key="event.id" class="space-y-1 py-2">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <UBadge size="sm" variant="subtle" color="neutral">{{
            recallSourceLabels[event.source]
          }}</UBadge>
          <span v-if="event.keyName" class="text-xs text-muted">{{ event.keyName }}</span>
          <time
            class="ml-auto text-xs text-muted"
            :datetime="event.createdAt"
            :title="formatTime(event.createdAt)"
            >{{ formatRelative(event.createdAt) }}</time
          >
        </div>
        <p v-if="event.query" class="text-xs break-words">{{ event.query }}</p>
        <p v-if="!event.hits.length" class="text-xs text-muted">没有命中。</p>
        <ul v-else class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <li v-for="hit in event.hits" :key="hit.rank">
            <span class="tabular-nums text-muted">{{ hit.score.toFixed(2) }}</span>
            <RouterLink
              v-if="hit.uri"
              :to="memoryLink(hit.uri)"
              class="ml-1 font-mono hover:underline"
              >{{ hit.uri }}</RouterLink
            >
            <span v-else class="ml-1 text-muted">（现在看不到这条）</span>
          </li>
        </ul>
      </li>
    </ol>
    <UButton
      v-if="events.hasNextPage.value"
      size="xs"
      color="neutral"
      variant="subtle"
      :loading="events.isFetchingNextPage.value"
      @click="events.fetchNextPage()"
    >
      更早的记录
    </UButton>
  </section>
</template>
