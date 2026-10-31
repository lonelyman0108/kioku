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
import { formatClock, formatTime } from '../time'
import Hint from './Hint.vue'
import UriPath from './strata/UriPath.vue'

// 变更记录页的一行：谁、做了什么、URI、改了哪些字段、几点。按天分组，所以时间只写时和分。
// 概览里放不下这么多列的版本是 RecentChange
const props = defineProps<{ item: ActivityItem; spaceId: string }>()

const actor = computed(() => actorLabel(props.item.actor))
const fields = computed(() => props.item.changes.map((c) => changeLabels[c] ?? c).join('、'))
</script>

<template>
  <li class="activity-entry">
    <span class="entry-actor" :title="actor.name">{{ actor.name }}</span>
    <span class="entry-action">{{ eventLabel(item.type).label }}</span>
    <RouterLink
      v-if="activityLinkable(item)"
      :to="memoryRoute(spaceId, item.uri)"
      class="entry-uri"
    >
      <UriPath :uri="item.uri" />
    </RouterLink>
    <UriPath v-else class="entry-uri" :uri="item.uri" />
    <span class="entry-notes">
      <span v-if="fields">{{ fields }}</span>
      <span v-if="item.expired && !item.deleted" class="text-warning">已过期</span>
      <template v-if="item.bench">
        <span class="bench-flag" :title="`运行标记 ${item.bench.run}`">测试台</span>
        <span>操作账号：{{ benchAccountLabel(item.bench) }}</span>
      </template>
      <span v-if="item.left" class="inline-flex items-center gap-1">
        超出可见范围
        <Hint>
          此次改动后，这条记忆超出当前账号的可见范围（例如改入其他成员的私人层，或改为机密）。
        </Hint>
      </span>
    </span>
    <time class="entry-time" :datetime="item.createdAt" :title="formatTime(item.createdAt)">
      {{ formatClock(item.createdAt) }}
    </time>
  </li>
</template>

<style scoped>
.activity-entry {
  display: grid;
  grid-template-columns: 18.5rem 6.5rem minmax(0, 1fr) minmax(0, 20rem) 3rem;
  column-gap: 14px;
  align-items: baseline;
  padding: 7px 0 6px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.5;
}
.entry-actor {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-action {
  color: var(--ui-text-muted);
}
.entry-uri {
  min-width: 0;
}
a.entry-uri:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.entry-notes {
  display: flex;
  flex-wrap: wrap;
  gap: 0 8px;
  min-width: 0;
  color: var(--ui-text-muted);
}
.bench-flag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 18px;
  align-self: center;
}
.entry-time {
  font-size: 13px;
  color: var(--ui-text-muted);
  text-align: right;
  white-space: nowrap;
}

/* 列放不下时，URI 占第一行，下面一行是谁做了什么，时间靠右 */
@media (max-width: 1240px) {
  .activity-entry {
    display: flex;
    flex-wrap: wrap;
    column-gap: 8px;
  }
  .entry-uri {
    order: -1;
    flex: 0 0 100%;
  }
  .entry-actor {
    max-width: 62%;
  }
  .entry-time {
    margin-left: auto;
  }
}
/* 窄屏再放不下改了哪些字段时，它们另起一行，不把谁做的挤成一列 */
@media (max-width: 1023.98px) {
  .entry-notes {
    order: 1;
    flex: 0 0 100%;
  }
}
</style>
