<script setup lang="ts">
import { ref } from 'vue'

import { icons } from '../../icons'

// 设置页分段标签与「仅看已覆盖」过滤条：把长参数表按阶段分组切换，不卸载底下的表单控件
const props = defineProps<{
  stages: readonly { key: string; label: string }[]
  overriddenCount: number
  ariaLabel?: string
}>()
const stage = defineModel<string>('stage', { required: true })
const onlyOverridden = defineModel<boolean>('onlyOverridden', { required: true })

const tabRefs = ref<(HTMLButtonElement | null)[]>([])

function onTabKeydown(event: KeyboardEvent, index: number) {
  const count = props.stages.length
  if (!count) return
  let next: number
  if (event.key === 'ArrowRight') next = (index + 1) % count
  else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = count - 1
  else return
  event.preventDefault()
  const target = props.stages[next]
  if (!target) return
  stage.value = target.key
  tabRefs.value[next]?.focus()
}
</script>

<template>
  <div class="filter-bar">
    <div class="stage-tabs" role="tablist" :aria-label="ariaLabel ?? '设置分段'">
      <button
        v-for="(s, idx) in stages"
        :key="s.key"
        :ref="
          (el) => {
            tabRefs[idx] = el as HTMLButtonElement | null
          }
        "
        type="button"
        role="tab"
        :aria-selected="stage === s.key"
        :tabindex="stage === s.key ? 0 : -1"
        class="stage-tab"
        :class="{ active: stage === s.key }"
        @click="stage = s.key"
        @keydown="onTabKeydown($event, idx)"
      >
        {{ s.label }}
      </button>
    </div>
    <button
      type="button"
      class="override-filter"
      :aria-pressed="onlyOverridden"
      :class="{ active: onlyOverridden }"
      @click="onlyOverridden = !onlyOverridden"
    >
      <UIcon :name="icons.filter" class="filter-icon" aria-hidden="true" />
      <span>仅看已覆盖（{{ overriddenCount }}）</span>
    </button>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  max-width: 64rem;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--strata-rule);
}
.stage-tabs {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: -1px;
}
.stage-tab {
  padding: 7px 14px;
  border: 1px solid transparent;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 13px;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.stage-tab:hover {
  color: var(--ui-text);
}
.stage-tab:focus-visible {
  position: relative;
  z-index: 1;
  outline-offset: -2px;
}
.stage-tab.active {
  border-color: var(--strata-rule);
  border-bottom-color: var(--ui-bg);
  background: var(--ui-bg);
  font-weight: 600;
  color: var(--ui-text);
}
.override-filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  padding: 4px 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  font-size: 12px;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.override-filter.active {
  border-color: var(--strata-selected);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.filter-icon {
  width: 13px;
  height: 13px;
}
</style>
