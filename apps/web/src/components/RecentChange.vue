<script setup lang="ts">
import type { ActivityItem } from '@kioku/contracts'
import { computed } from 'vue'

import {
  activityActor,
  activityActorIcons,
  activityLinkable,
  changeLabels,
  eventLabel,
} from '../labels'
import { memoryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import ActivityFlags from './ActivityFlags.vue'
import MemoryName from './strata/MemoryName.vue'
import StrataSwatch from './strata/StrataSwatch.vue'

// 概览里最近变更的一行：记忆一行，谁做了什么一行，操作者与操作带和变更记录同样的图标。
// 完整的版本是变更记录页的表格（ActivityEntry）
const props = defineProps<{ item: ActivityItem; spaceId: string }>()

const actor = computed(() => activityActor(props.item))
const op = computed(() => eventLabel(props.item.type))
const fields = computed(() => props.item.changes.map((c) => changeLabels[c] ?? c).join('、'))
</script>

<template>
  <li class="recent-change">
    <span class="change-uri">
      <StrataSwatch :layer="item.layer" :sensitivity="item.sensitivity" :width="14" :height="10" />
      <RouterLink
        v-if="activityLinkable(item)"
        :to="memoryRoute(spaceId, item.uri)"
        class="change-link"
      >
        <MemoryName :uri="item.uri" :title="item.title" />
      </RouterLink>
      <MemoryName v-else :uri="item.uri" :title="item.title" />
    </span>
    <span class="change-meta" :title="`${actor.hint} ${op.label} ${fields}`">
      <span class="meta-part truncate">
        <UIcon :name="activityActorIcons[actor.kind]" class="meta-icon" />{{ actor.name }}
      </span>
      <span class="meta-part shrink-0">
        <UIcon :name="op.icon" class="meta-icon" />{{ op.label }}
      </span>
      <span v-if="fields" class="truncate">{{ fields }}</span>
      <ActivityFlags :item="item" />
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
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
  line-height: 1.5;
}
.change-link {
  min-width: 0;
  overflow: hidden;
}
.change-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.change-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.meta-part {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.meta-icon {
  flex-shrink: 0;
  color: var(--ui-text-dimmed);
}
.change-time {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
</style>
