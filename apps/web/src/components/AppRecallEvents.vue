<script setup lang="ts">
import { useInfiniteQuery } from '@tanstack/vue-query'
import { computed } from 'vue'

import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { recallSourceLabels } from '../labels'
import { memoryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'

// 这个应用的召回记录：服务端只给事件发生时的应用所有者，所以列的是当前账号作为所有者期间的那些
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
  <section class="recall-events">
    <SectionHeading title="召回记录">
      <template #hint>
        <Hint>
          此应用每次召回的命中结果。仅列出当前账号作为应用所有者期间的记录。明细按实例设置的天数保留。应用转移后，新所有者无法查看此前的记录。
        </Hint>
      </template>
    </SectionHeading>
    <NoteLine
      v-if="events.isError.value && !events.isFetchNextPageError.value"
      class="events-note"
      tone="error"
    >
      {{ readFailure(events.error.value) }}
    </NoteLine>
    <USkeleton v-if="events.isPending.value" class="mt-3 h-24 w-full" />
    <p v-else-if="events.data.value && !items.length" class="events-empty">暂无召回记录</p>
    <ol v-else-if="events.data.value">
      <li v-for="event in items" :key="event.id" class="event">
        <p class="event-head">
          <b>{{ recallSourceLabels[event.source] }}</b>
          <span v-if="event.keyName">{{ event.keyName }}</span>
          <time :datetime="event.createdAt" :title="formatTime(event.createdAt)">
            {{ formatRelative(event.createdAt) }}
          </time>
        </p>
        <p v-if="event.query" class="event-query">{{ event.query }}</p>
        <p v-if="!event.hits.length" class="event-miss">未命中</p>
        <ul v-else class="event-hits">
          <li v-for="hit in event.hits" :key="hit.rank">
            <span class="hit-score">{{ hit.score.toFixed(2) }}</span>
            <RouterLink v-if="hit.uri" :to="memoryLink(hit.uri)" class="hit-uri">
              {{ hit.uri }}
            </RouterLink>
            <span v-else class="event-miss">（当前不可见）</span>
          </li>
        </ul>
      </li>
    </ol>
    <NoteLine v-if="events.isFetchNextPageError.value" class="events-note" tone="error">
      {{ readFailure(events.error.value) }}
    </NoteLine>
    <UButton
      v-if="events.hasNextPage.value"
      class="mt-3"
      size="sm"
      color="neutral"
      variant="outline"
      :loading="events.isFetchingNextPage.value"
      @click="events.fetchNextPage()"
    >
      加载更早的记录
    </UButton>
  </section>
</template>

<style scoped>
.note-line.events-note {
  margin: 8px 0 0;
  border-top: 0;
}
.events-empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.event {
  padding: 8px 0 7px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.6;
}
.event-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  color: var(--ui-text-muted);
}
.event-head b {
  font-weight: 500;
  color: var(--ui-text);
}
.event-head time {
  margin-left: auto;
  font-size: 13px;
}
.event-query {
  overflow-wrap: anywhere;
}
.event-miss {
  color: var(--ui-text-muted);
}
.event-hits {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
}
.event-hits li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.hit-score {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text-muted);
}
.hit-uri {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.hit-uri:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
