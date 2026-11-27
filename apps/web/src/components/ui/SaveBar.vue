<script setup lang="ts">
import { ref, watch } from 'vue'

import { icons } from '../../icons'

export interface SaveBarChange {
  label: string
  before: string
  after: string
}

// 整页或编辑器底部粘性保存条：放在表单内时 submitType='submit'，独立操作时可设为 'button' 并监听 save。
// 传入 changes 时可展开查看改动明细（改前 → 改后）；传入 #extra 可内嵌单行补充输入（例如变更说明）
const props = withDefaults(
  defineProps<{
    count: number
    saving?: boolean
    problem?: string | null
    changes?: readonly SaveBarChange[]
    alwaysShow?: boolean
    submitType?: 'submit' | 'button'
    discardLabel?: string
    saveLabel?: string
    saveShortcut?: string | null
  }>(),
  {
    saving: false,
    problem: null,
    changes: undefined,
    alwaysShow: false,
    submitType: 'submit',
    discardLabel: '放弃',
    saveLabel: '保存',
    saveShortcut: null,
  },
)
const emit = defineEmits<{ discard: []; save: [] }>()
const showDiff = ref(false)
watch(
  () => props.count,
  (count) => {
    if (count === 0) showDiff.value = false
  },
)
</script>

<template>
  <div v-if="props.alwaysShow || props.count > 0 || props.saving" class="save-bar">
    <div v-if="$slots.extra" class="save-extra">
      <slot name="extra" />
    </div>
    <div class="save-main">
      <span class="save-status" role="status">
        <template v-if="props.count > 0">
          <UIcon :name="icons.unsaved" class="save-icon" aria-hidden="true" />
          <span class="save-count tabular-nums">{{ props.count }} 项未保存</span>
        </template>
        <span v-else class="save-idle">暂无未保存改动</span>
      </span>
      <UButton
        v-if="props.changes?.length"
        type="button"
        color="neutral"
        variant="outline"
        size="xs"
        :icon="showDiff ? icons.chevronUp : icons.chevronDown"
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
        :icon="icons.undelete"
        :disabled="props.saving"
        @click="emit('discard')"
        >{{ props.discardLabel }}</UButton
      >
      <UButton
        :type="props.submitType"
        color="primary"
        :icon="icons.save"
        :loading="props.saving"
        :disabled="props.saving || props.count === 0 || Boolean(props.problem)"
        @click="props.submitType === 'button' ? emit('save') : undefined"
      >
        {{ props.saveLabel }}
        <span v-if="props.saveShortcut" class="save-kbd" aria-hidden="true">{{
          props.saveShortcut
        }}</span>
      </UButton>
    </div>
    <div v-if="showDiff && (props.changes?.length || $slots.diff)" class="save-diff-wrap">
      <ul v-if="props.changes?.length" class="save-diff">
        <li v-for="c in props.changes" :key="c.label" class="diff-item">
          <span class="diff-label">{{ c.label }}</span>
          <span class="diff-values tabular-nums"
            ><span class="diff-before">{{ c.before }}</span>
            <UIcon :name="icons.inherits" class="diff-arrow" aria-hidden="true" />
            <span class="diff-after">{{ c.after }}</span></span
          >
        </li>
      </ul>
      <div v-if="$slots.diff" class="save-diff-body">
        <slot name="diff" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  margin-top: 24px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
  font-size: 13px;
}
.save-extra {
  padding: 8px 16px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.save-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
}
.save-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.save-count {
  font-weight: 500;
}
.save-idle {
  color: var(--ui-text-muted);
}
.save-icon {
  display: inline-block;
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
.save-kbd {
  font-family: var(--font-mono);
  font-size: 12px;
}
.save-diff-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.save-diff {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.save-diff-body {
  min-width: 0;
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
  display: inline-block;
  width: 12px;
  height: 12px;
  color: var(--ui-text-dimmed);
}
.diff-after {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
</style>
