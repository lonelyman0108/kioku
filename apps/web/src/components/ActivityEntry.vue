<script setup lang="ts">
import type { ActivityItem } from '@kioku/contracts'
import { computed } from 'vue'

import { icons } from '../icons'
import { actorLabel, changeLabels, eventLabel } from '../labels'
import { formatRelative, formatTime } from '../time'

const props = defineProps<{ item: ActivityItem; spaceId: string }>()

const kind = computed(() => eventLabel(props.item.type))
const actor = computed(() => actorLabel(props.item.actor))
// 记忆已经删除（包括过期后让出 URI 的），那个 URI 上可能已经是别的记忆了；离开了可见范围的 URI 是改动之前的。
// 这两种不给链接，同一条记忆更早的改动也一样
const linkable = computed(() => !props.item.left && !props.item.deleted)
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
      </div>
      <p v-if="item.left" class="text-xs text-muted">
        这次改动之后，它离开了你的可见范围（例如被改进了别人的私人层，或改成了 secret）。
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
