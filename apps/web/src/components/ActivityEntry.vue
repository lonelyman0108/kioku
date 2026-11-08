<script setup lang="ts">
import type { ActivityItem } from '@kioku/contracts'
import { computed } from 'vue'

import { changeSummary } from '../activity'
import { icons } from '../icons'
import { activityActor, activityActorIcons, changeLabels, eventLabel } from '../labels'
import { formatClock, formatTime } from '../time'
import ActivityFlags from './ActivityFlags.vue'
import MemoryName from './strata/MemoryName.vue'
import StrataSwatch from './strata/StrataSwatch.vue'

// 变更记录表格的一行：时间、操作者、操作、记忆、改动、状态。按天分组，所以时间只写时和分；
// 记忆写标题，坐标在悬停里。详情打开时表格变窄（compact），状态并进记忆那一列；窄屏（narrow）只有
// 时间与记忆两列，谁、做了什么、改了什么写在标题下面一行。
// 同一个操作者接着改同一条记忆的几次折叠在第一行，folded 是折起来的次数，sub 是展开后的那几行
export type EntryLayout = 'full' | 'compact' | 'narrow'
const props = withDefaults(
  defineProps<{
    item: ActivityItem
    layout?: EntryLayout
    selected?: boolean
    folded?: number
    expanded?: boolean
    sub?: boolean
  }>(),
  { layout: 'full', selected: false, folded: 0, expanded: false, sub: false },
)
const emit = defineEmits<{ select: []; toggle: [] }>()

const actor = computed(() => activityActor(props.item))
const op = computed(() => eventLabel(props.item.type))
const secret = computed(() => props.item.sensitivity === 'secret')
const changes = computed(() =>
  props.item.fieldChanges.map((c) => ({
    field: c.field,
    label: changeLabels[c.field] ?? c.field,
    detail: changeSummary(c),
  })),
)
const changeText = computed(() =>
  changes.value.map((c) => [c.label, c.detail].filter(Boolean).join(' ')).join('、'),
)
</script>

<template>
  <tr
    class="entry"
    :class="[layout, { selected, sub }]"
    tabindex="0"
    :aria-selected="selected"
    @click="emit('select')"
    @keydown.enter.self="emit('select')"
  >
    <td>
      <time :datetime="item.createdAt" :title="formatTime(item.createdAt)">
        {{ formatClock(item.createdAt) }}
      </time>
    </td>
    <template v-if="layout !== 'narrow'">
      <td>
        <span class="cell-flex" :title="actor.hint">
          <UIcon :name="activityActorIcons[actor.kind]" class="cell-icon" />
          <span class="truncate">{{ actor.name }}</span>
        </span>
      </td>
      <td>
        <span class="cell-flex">
          <UIcon :name="op.icon" class="cell-icon" />
          <span class="truncate">{{ op.label }}</span>
        </span>
      </td>
    </template>
    <td>
      <span class="cell-flex">
        <StrataSwatch
          :layer="item.layer"
          :sensitivity="item.sensitivity"
          :width="14"
          :height="10"
        />
        <MemoryName class="memory-title" :uri="item.uri" :title="item.title" />
        <UIcon v-if="secret" :name="icons.secret" class="cell-icon" aria-label="机密" />
        <button
          v-if="folded"
          type="button"
          class="fold"
          :aria-expanded="expanded"
          :aria-label="`${expanded ? '收起' : '展开'} ${folded + 1} 次修改`"
          @click.stop="emit('toggle')"
        >
          ×{{ folded + 1 }}
        </button>
        <ActivityFlags v-if="layout === 'compact'" :item="item" />
      </span>
      <span v-if="layout === 'narrow'" class="cell-flex narrow-meta">
        <span class="cell-flex" :title="actor.hint">
          <UIcon :name="activityActorIcons[actor.kind]" class="cell-icon" />
          <span class="truncate">{{ actor.name }}</span>
        </span>
        <span class="cell-flex shrink-0">
          <UIcon :name="op.icon" class="cell-icon" />{{ op.label }}
        </span>
        <span v-if="changeText" class="truncate">{{ changeText }}</span>
        <ActivityFlags :item="item" />
      </span>
    </td>
    <template v-if="layout !== 'narrow'">
      <td>
        <span class="changes" :title="changeText">
          <span v-for="c in changes" :key="c.field" class="change">
            {{ c.label }}<em v-if="c.detail">{{ c.detail }}</em>
          </span>
        </span>
      </td>
      <td v-if="layout === 'full'"><ActivityFlags :item="item" /></td>
    </template>
  </tr>
</template>

<style scoped>
.entry {
  cursor: pointer;
}
.entry td {
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--ui-border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.entry td:first-child {
  padding-left: 24px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-muted);
}
.entry:hover td {
  background: var(--ui-bg-muted);
}
.entry.selected td {
  background: var(--ui-bg-accented);
}
.entry.selected td:first-child {
  box-shadow: inset 3px 0 var(--ui-text);
}
.entry:focus-visible {
  outline: 2px solid var(--ui-text);
  outline-offset: -2px;
}
.entry.sub td {
  height: 32px;
  color: var(--ui-text-muted);
}
.entry.sub:not(.narrow) td:nth-child(4),
.entry.sub.narrow td:nth-child(2) {
  padding-left: 30px;
}
.entry.narrow td {
  height: auto;
  padding-top: 7px;
  padding-bottom: 7px;
  vertical-align: top;
}
.entry.narrow td:first-child {
  padding-left: 16px;
}
.narrow-meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.narrow-meta > :first-child {
  flex-shrink: 0;
  max-width: 45%;
}
.cell-flex {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.cell-icon {
  flex-shrink: 0;
  color: var(--ui-text-dimmed);
}
.memory-title {
  min-width: 0;
}
.fold {
  flex-shrink: 0;
  min-width: 26px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.fold:hover {
  color: var(--ui-text);
  border-color: var(--ui-text);
}
.changes {
  display: flex;
  gap: 4px;
  overflow: hidden;
}
.change {
  flex-shrink: 0;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  font-size: 12px;
  line-height: 18px;
  color: var(--ui-text-toned);
}
.change em {
  margin-left: 4px;
  font-style: normal;
  color: var(--ui-text-dimmed);
}
</style>
