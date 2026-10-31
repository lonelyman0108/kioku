<script setup lang="ts">
import type { ActivityItem } from '@kioku/contracts'
import { computed } from 'vue'

import {
  activityLinkable,
  actorLabel,
  benchAccountLabel,
  changeLabels,
  eventLabel,
} from '../labels'
import { memoryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import UriPath from './strata/UriPath.vue'

// 概览里最近变更的一行：URI 一行，谁改了什么一行。完整的版本是变更记录页的 ActivityEntry
const props = defineProps<{ item: ActivityItem; spaceId: string }>()

const summary = computed(() => {
  const fields = props.item.changes.map((c) => changeLabels[c] ?? c).join('、')
  return [actorLabel(props.item.actor).name, eventLabel(props.item.type).label, fields]
    .filter(Boolean)
    .join(' ')
})
</script>

<template>
  <li class="recent-change">
    <RouterLink
      v-if="activityLinkable(item)"
      :to="memoryRoute(spaceId, item.uri)"
      class="change-uri change-link"
    >
      <UriPath :uri="item.uri" />
    </RouterLink>
    <UriPath v-else class="change-uri" :uri="item.uri" />
    <span class="change-meta" :title="summary">
      <span class="truncate">{{ summary }}</span>
      <span v-if="item.expired && !item.deleted" class="shrink-0">已过期</span>
      <span
        v-if="item.bench"
        class="shrink-0"
        :title="`运行标记 ${item.bench.run}，操作账号：${benchAccountLabel(item.bench)}`"
      >
        测试台
      </span>
      <span v-if="item.left" class="inline-flex shrink-0 items-center gap-1">
        超出可见范围
        <Hint>
          此次改动后，这条记忆超出当前账号的可见范围（例如改入其他成员的私人层，或改为机密）。
        </Hint>
      </span>
    </span>
    <time class="change-time" :datetime="item.createdAt" :title="formatTime(item.createdAt)">
      {{ formatRelative(item.createdAt) }}
    </time>
  </li>
</template>

<style scoped>
.recent-change {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 9px;
  align-items: baseline;
  padding: 7px 0 6px;
  border-bottom: 1px solid var(--ui-border);
}
.change-uri {
  grid-column: 1 / -1;
  font-size: 14px;
  line-height: 1.5;
}
.change-link {
  min-width: 0;
}
.change-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.change-meta {
  display: flex;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.change-time {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
</style>
