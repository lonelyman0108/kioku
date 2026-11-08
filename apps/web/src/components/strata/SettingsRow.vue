<script setup lang="ts">
// 设置行：左边名称与一句说明，中间控件，右边取值来源（沿用、已覆盖这类标签）。窄屏时上下排。
// 名称要指向控件时传 for（控件的 id），否则只是文字
defineProps<{ label: string; description?: string; for?: string }>()
</script>

<template>
  <div class="settings-row">
    <div class="row-label">
      <label v-if="$props.for" :for="$props.for" class="row-name">{{ label }}</label>
      <span v-else class="row-name">{{ label }}</span>
      <span v-if="description || $slots.description" class="row-description">
        <slot name="description">{{ description }}</slot>
      </span>
    </div>
    <div class="row-control"><slot /></div>
    <div v-if="$slots.source" class="row-source"><slot name="source" /></div>
  </div>
</template>

<style scoped>
.settings-row {
  display: grid;
  grid-template-columns: minmax(0, 250px) minmax(0, 1fr) auto;
  gap: 8px 24px;
  align-items: center;
  min-height: 56px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border);
}
.row-label {
  min-width: 0;
}
.row-name {
  display: block;
  font-weight: 500;
}
.row-description {
  display: block;
  margin-top: 1px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.row-control {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  min-width: 0;
}
.row-source {
  display: flex;
  align-items: center;
  justify-self: end;
  gap: 8px;
}
@media (max-width: 767.98px) {
  .settings-row {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }
  .row-source {
    justify-self: start;
  }
}
</style>
