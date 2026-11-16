<script setup lang="ts">
import { ref, watch } from 'vue'

import { icons } from '../../icons'

export interface SaveBarChange {
  label: string
  before: string
  after: string
}

// 整页保存条：同一页的几项数值设置共用它，贴在滚动区底部。放在表单里：保存是提交按钮，回车也能保存。
// 没有改动时不显示；保存中两个按钮都不能点，失败由页面用 toast 说明，改动留着。
// 传入 changes 时可展开查看改动明细（改前 → 改后）；有填得不对的项时传 problem
const props = defineProps<{
  count: number
  saving?: boolean
  problem?: string | null
  changes?: readonly SaveBarChange[]
}>()
const emit = defineEmits<{ discard: [] }>()
const showDiff = ref(false)
watch(
  () => props.count,
  (count) => {
    if (count === 0) showDiff.value = false
  },
)
</script>

<template>
  <div v-if="props.count > 0 || props.saving" class="save-bar" role="status">
    <div class="save-main">
      <UIcon :name="icons.unsaved" class="save-icon" />
      <span class="save-count tabular-nums">{{ props.count }} 项未保存</span>
      <UButton
        v-if="props.changes?.length"
        type="button"
        color="neutral"
        variant="outline"
        size="xs"
        :icon="showDiff ? icons.up : icons.down"
        :aria-expanded="showDiff"
        @click="showDiff = !showDiff"
        >{{ showDiff ? '收起变更' : '查看变更' }}</UButton
      >
      <span v-if="props.problem" class="save-problem">{{ props.problem }}</span>
      <span class="save-gap" />
      <UButton
        type="button"
        color="neutral"
        variant="ghost"
        :disabled="props.saving"
        @click="emit('discard')"
        >放弃</UButton
      >
      <UButton
        type="submit"
        color="primary"
        :loading="props.saving"
        :disabled="props.saving || Boolean(props.problem)"
        >保存</UButton
      >
    </div>
    <ul v-if="showDiff && props.changes?.length" class="save-diff">
      <li v-for="c in props.changes" :key="c.label" class="diff-item">
        <span class="diff-label">{{ c.label }}</span>
        <span class="diff-values tabular-nums"
          ><span class="diff-before">{{ c.before }}</span>
          <UIcon :name="icons.inherits" class="diff-arrow" aria-hidden="true" />
          <span class="diff-after">{{ c.after }}</span></span
        >
      </li>
    </ul>
  </div>
</template>

<style scoped>
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  margin-top: 28px;
  border: 1px solid var(--strata-rule);
  background: var(--ui-bg-muted);
  font-size: 13px;
}
.save-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
}
.save-count {
  font-weight: 500;
}
.save-icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--ui-warning);
}
.save-problem {
  color: var(--ui-error);
}
.save-gap {
  flex: 1;
}
.save-diff {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 16px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
  font-size: 12px;
}
.diff-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.diff-label {
  color: var(--ui-text-muted);
}
.diff-values {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.diff-before {
  color: var(--ui-text-muted);
  text-decoration: line-through;
}
.diff-arrow {
  width: 12px;
  height: 12px;
  color: var(--ui-text-dimmed);
}
.diff-after {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
</style>
