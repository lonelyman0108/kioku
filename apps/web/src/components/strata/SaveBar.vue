<script setup lang="ts">
import { icons } from '../../icons'

// 整页保存条：同一页的几项数值设置共用它，贴在滚动区底部。放在表单里：保存是提交按钮，回车也能保存。
// 没有改动时不显示；保存中两个按钮都不能点，失败由页面用 toast 说明，改动留着
const props = defineProps<{ count: number; saving?: boolean }>()
const emit = defineEmits<{ discard: [] }>()
</script>

<template>
  <div v-if="props.count > 0 || props.saving" class="save-bar" role="status">
    <UIcon :name="icons.unsaved" class="save-icon" />
    <span>{{ props.count }} 项未保存</span>
    <span class="save-gap" />
    <UButton color="neutral" variant="ghost" :disabled="props.saving" @click="emit('discard')"
      >放弃</UButton
    >
    <UButton type="submit" color="primary" :loading="props.saving" :disabled="props.saving"
      >保存</UButton
    >
  </div>
</template>

<style scoped>
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 28px;
  padding: 10px 16px;
  border: 1px solid var(--strata-rule);
  background: var(--ui-bg);
  font-size: 13px;
}
.save-icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--ui-warning);
}
.save-gap {
  flex: 1;
}
</style>
