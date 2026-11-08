<script setup lang="ts">
import { computed } from 'vue'

import { monthGrid, monthOf, shiftMonth } from '../activity'
import { icons } from '../icons'

// 变更记录左栏的月历：每格印条数，条数越多底色越深（墨色的淡色），今天描边，选中的范围反白，
// 今天以后的不能选。点一天只看那天，按住 Shift 再点选一段
const props = defineProps<{
  today: string
  counts: ReadonlyMap<string, number>
  selected: { from: string; to: string } | null
}>()
const month = defineModel<string>('month', { required: true })
const emit = defineEmits<{ pick: [day: string, extend: boolean] }>()

const cells = computed(() => monthGrid(month.value, props.today, props.counts, props.selected))
const title = computed(() => {
  const [y, m] = month.value.split('-')
  return `${y} 年 ${Number(m)} 月`
})
const atLatest = computed(() => month.value >= monthOf(props.today))
const label = (cell: { key: string; count: number }) => {
  const [, m, d] = cell.key.split('-')
  return `${Number(m)} 月 ${Number(d)} 日，${cell.count} 条`
}
</script>

<template>
  <div class="calendar">
    <div class="calendar-head">
      <UButton
        :icon="icons.previous"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="上个月"
        @click="month = shiftMonth(month, -1)"
      />
      <b aria-live="polite">{{ title }}</b>
      <UButton
        :icon="icons.next"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="下个月"
        :disabled="atLatest"
        @click="month = shiftMonth(month, 1)"
      />
    </div>
    <div class="calendar-grid" role="group" :aria-label="title">
      <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w" class="weekday">
        {{ w }}
      </span>
      <button
        v-for="cell in cells"
        :key="cell.key"
        type="button"
        class="day"
        :class="[
          `heat-${cell.heat}`,
          {
            out: !cell.inMonth,
            future: cell.future,
            today: cell.today,
            selected: cell.selected,
          },
        ]"
        :disabled="cell.future"
        :aria-label="label(cell)"
        :aria-pressed="cell.selected"
        :title="label(cell)"
        @click="(e: MouseEvent) => emit('pick', cell.key, e.shiftKey)"
      >
        <span>{{ cell.date }}</span>
        <span class="count">{{ cell.count || '' }}</span>
      </button>
    </div>
    <div class="legend" aria-hidden="true">
      少<i class="heat-0" /><i class="heat-1" /><i class="heat-2" /><i class="heat-3" /><i
        class="heat-4"
      />多<span class="grow" />格子里是条数
    </div>
  </div>
</template>

<style scoped>
.calendar-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
}
.calendar-head b {
  flex: 1;
  text-align: center;
  font-weight: 600;
  font-size: 14px;
}
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 2px;
}
.weekday {
  font-size: 12px;
  color: var(--ui-text-muted);
  text-align: center;
}
.day {
  aspect-ratio: 1 / 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 0;
  border: 1px solid transparent;
  font-size: 12px;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.day .count {
  min-height: 14px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.heat-1 {
  background: color-mix(in srgb, var(--ui-text) 7%, var(--ui-bg));
}
.heat-2 {
  background: color-mix(in srgb, var(--ui-text) 14%, var(--ui-bg));
}
.heat-3 {
  background: color-mix(in srgb, var(--ui-text) 24%, var(--ui-bg));
}
.heat-4 {
  background: color-mix(in srgb, var(--ui-text) 36%, var(--ui-bg));
}
.day.heat-3 .count,
.day.heat-4 .count {
  color: var(--ui-text);
}
.day.out {
  color: var(--ui-text-dimmed);
  opacity: 0.5;
}
.day.future {
  color: var(--ui-text-dimmed);
  cursor: default;
}
.day.today {
  border-color: var(--ui-text);
}
.day.selected {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.day.selected .count {
  color: var(--strata-on-selected);
  font-weight: 600;
}
/* 选中范围里上个月、下个月的那几格不再调淡：反白底上调淡之后条数看不清 */
.day.out.selected {
  opacity: 0.8;
}
.day.today.selected {
  border-color: var(--strata-selected-frame);
  outline: 1px solid var(--strata-selected);
}
.day:focus-visible {
  outline: 2px solid var(--ui-text);
  outline-offset: 1px;
}
.day:not(:disabled):not(.selected):hover {
  border-color: var(--ui-border-accented);
}
.legend {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.legend i {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1px solid var(--ui-border);
}
.legend .heat-0 {
  background: var(--ui-bg);
}
.grow {
  flex: 1;
}
</style>
