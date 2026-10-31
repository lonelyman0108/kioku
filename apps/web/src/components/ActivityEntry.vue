<script setup lang="ts">
import type { ActivityItem } from '@kioku/contracts'
import { computed } from 'vue'

import { icons } from '../icons'
import {
  activityLinkable,
  actorLabel,
  benchAccountLabel,
  changeLabels,
  eventLabel,
} from '../labels'
import { formatRelative, formatTime } from '../time'

const props = defineProps<{ item: ActivityItem; spaceId: string }>()

const kind = computed(() => eventLabel(props.item.type))
const actor = computed(() => actorLabel(props.item.actor))
const linkable = computed(() => activityLinkable(props.item))
</script>

<template>
  <div class="flex items-start gap-3 py-2.5">
    <UIcon :name="item.left ? icons.left : kind.icon" class="mt-0.5 size-4 shrink-0 text-muted" />
    <div class="min-w-0 flex-1 space-y-1 text-sm">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="inline-flex items-center gap-1 font-medium">
          <UIcon v-if="actor.viaApp" :name="icons.bot" class="size-3.5 text-muted" />
          {{ actor.name }}
        </span>
        <span class="text-muted">{{ kind.label }}</span>
        <code v-if="!linkable" class="truncate text-xs text-muted">{{ item.uri }}</code>
        <RouterLink
          v-else
          :to="{ name: 'memories', params: { spaceId }, query: { uri: item.uri } }"
          class="truncate font-mono text-xs text-highlighted hover:underline"
        >
          {{ item.uri }}
        </RouterLink>
        <UBadge
          v-for="change in item.changes"
          :key="change"
          size="sm"
          color="neutral"
          variant="subtle"
        >
          {{ changeLabels[change] ?? change }}
        </UBadge>
        <UBadge v-if="item.expired && !item.deleted" size="sm" color="warning" variant="outline">
          已过期
        </UBadge>
        <template v-if="item.bench">
          <UBadge size="sm" color="info" variant="subtle" :title="`运行标记 ${item.bench.run}`">
            测试台
          </UBadge>
          <span class="text-xs text-muted">操作账号：{{ benchAccountLabel(item.bench) }}</span>
        </template>
      </div>
      <p v-if="item.left" class="text-xs text-muted">
        此次改动后，这条记忆超出当前账号的可见范围（例如改入其他成员的私人层，或改为机密）。
      </p>
    </div>
    <time
      :datetime="item.createdAt"
      :title="formatTime(item.createdAt)"
      class="shrink-0 text-xs text-muted"
    >
      {{ formatRelative(item.createdAt) }}
    </time>
  </div>
</template>
