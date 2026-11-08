<script setup lang="ts">
import type { ActivityFacets, Layer } from '@kioku/contracts'
import { computed } from 'vue'

import type { FacetOption, FilterGroup } from '../activity'
import {
  activityActorIcons,
  activityActorKind,
  activityActorName,
  changeLabels,
  eventLabel,
  layerLabels,
} from '../labels'
import StrataSwatch from './strata/StrataSwatch.vue'

// 变更记录的筛选：操作者、操作、归属、改动的字段，每项带条数，勾选的才列出。
// 条数在除了这一组以外的全部筛选下算（服务端的筛选计数），取消勾选一项不影响同一组别的条数
const props = defineProps<{
  options: Record<FilterGroup, FacetOption[]>
  facets: ActivityFacets | undefined
  off: Record<FilterGroup, string[]>
}>()
const emit = defineEmits<{
  toggle: [group: FilterGroup, key: string, on: boolean]
  reset: [group: FilterGroup]
}>()

const titles: Record<FilterGroup, string> = {
  actor: '操作者',
  type: '操作',
  layer: '归属',
  field: '改动的字段',
}
// 取消勾选的操作者这次不在计数里时，名字从上次的计数里也找不到，退回按类别的说法
const actorNames = computed(
  () => new Map(props.facets?.actors.map((a) => [a.key, a.name] as const) ?? []),
)
function labelOf(group: FilterGroup, key: string): string {
  switch (group) {
    case 'actor':
      return activityActorName(activityActorKind(key), actorNames.value.get(key) ?? null)
    case 'type':
      return eventLabel(key).label
    case 'layer':
      return layerLabels[key as Layer]
    default:
      return changeLabels[key] ?? key
  }
}
function iconOf(group: FilterGroup, key: string): string | null {
  if (group === 'actor') return activityActorIcons[activityActorKind(key)]
  if (group === 'type') return eventLabel(key).icon
  return null
}
const groups = computed(() =>
  (Object.keys(titles) as FilterGroup[]).map((group) => ({
    group,
    title: titles[group],
    items: props.options[group].map((o) => ({
      ...o,
      label: labelOf(group, o.key),
      icon: iconOf(group, o.key),
      on: !props.off[group].includes(o.key),
    })),
  })),
)
</script>

<template>
  <div class="filters">
    <fieldset v-for="g in groups" :key="g.group" class="filter-group">
      <legend class="filter-title">
        <span>{{ g.title }}</span>
        <button
          v-if="off[g.group].length"
          type="button"
          class="reset"
          @click="emit('reset', g.group)"
        >
          全选
        </button>
      </legend>
      <p v-if="!g.items.length" class="none">暂无</p>
      <label
        v-for="item in g.items"
        :key="item.key"
        class="option"
        :class="{ zero: !item.count }"
        :title="`${item.label}，${item.count} 条`"
      >
        <input
          type="checkbox"
          :checked="item.on"
          @change="(e) => emit('toggle', g.group, item.key, (e.target as HTMLInputElement).checked)"
        />
        <span class="option-label">
          <StrataSwatch
            v-if="g.group === 'layer'"
            :layer="item.key as Layer"
            plain
            decorative
            :width="14"
            :height="10"
          />
          <UIcon v-else-if="item.icon" :name="item.icon" class="option-icon" />
          <span class="truncate">{{ item.label }}</span>
        </span>
        <span class="count">{{ item.count }}</span>
      </label>
    </fieldset>
  </div>
</template>

<style scoped>
.filter-group {
  margin: 20px 0 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.filter-title {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-bottom: 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 12px;
  font-weight: 600;
}
.reset {
  margin-left: auto;
  font-weight: 400;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.reset:hover {
  color: var(--ui-text);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.none {
  padding: 4px 0;
  font-size: 13px;
  color: var(--ui-text-dimmed);
}
.option {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  font-size: 13px;
  cursor: pointer;
}
.option input {
  margin: 0;
  accent-color: var(--ui-text);
}
.option-label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.option-icon {
  flex-shrink: 0;
  color: var(--ui-text-dimmed);
}
.count {
  margin-left: auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-dimmed);
}
.option.zero {
  color: var(--ui-text-dimmed);
}
</style>
