<script setup lang="ts">
import { computed } from 'vue'

import { icons } from '../../icons'

// 贴在正文上方的一行状态：一条墨线，左边说什么情况，右边是操作。不铺色块，只有文字带语气。
// flush：放在别的线下面、和别的提示叠在一起时用：不画墨线，也不带下边距，间距由外层管
type NoteTone = 'neutral' | 'warning' | 'error' | 'success'

const TONE_ICONS: Record<NoteTone, string> = {
  neutral: icons.info,
  warning: icons.warning,
  error: icons.error,
  success: icons.checkCircle,
}

const props = withDefaults(
  defineProps<{ tone?: NoteTone; flush?: boolean; icon?: string | false }>(),
  {
    tone: 'neutral',
    icon: undefined,
  },
)

const resolvedIcon = computed(() => {
  if (props.icon === false) return null
  return props.icon ?? TONE_ICONS[props.tone]
})
</script>

<template>
  <div class="note-line" :class="{ flush }">
    <div class="note-text">
      <p class="note-title" :class="tone">
        <UIcon v-if="resolvedIcon" :name="resolvedIcon" class="note-icon" aria-hidden="true" />
        <span class="note-title-body"><slot /></span>
      </p>
      <p v-if="$slots.detail" class="note-detail"><slot name="detail" /></p>
    </div>
    <div v-if="$slots.actions" class="note-actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.note-line {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 16px;
  min-height: 44px;
  padding: 6px 0;
  margin-bottom: 16px;
  border-top: 1px solid var(--ui-rule);
  border-bottom: 1px solid var(--ui-border);
}
.note-line + .note-line {
  margin-top: -16px;
  border-top: 0;
}
.note-line.flush {
  min-height: auto;
  margin-bottom: 0;
  border-top: 0;
}
.note-line.flush + .note-line.flush {
  margin-top: 0;
}
.note-text {
  flex: 1 1 14em;
  min-width: 0;
  overflow-wrap: anywhere;
}
.note-title {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.55;
}
.note-icon {
  display: inline-block;
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 3px;
}
.note-title-body {
  flex: 1;
  min-width: 0;
}
.note-title.warning {
  color: var(--ui-warning);
}
.note-title.error {
  color: var(--ui-error);
}
.note-title.success {
  color: var(--ui-success);
}
.note-detail {
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
/* 放不下时按钮换行；一个按钮比一行还长时，按钮里的文字截断，不把外层撑出横向滚动条 */
.note-actions {
  flex: none;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.note-actions :slotted(*) {
  min-width: 0;
  max-width: 100%;
}
</style>
