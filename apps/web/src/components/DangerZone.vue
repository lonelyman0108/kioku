<script setup lang="ts">
import { icons } from '../icons'

// 危险操作：砖红边框的一块，和普通设置分开。每一行是名称、一句后果与按钮（插槽里的 .danger-row）
</script>

<template>
  <section class="danger-zone" aria-labelledby="danger-zone-title">
    <h3 id="danger-zone-title" class="danger-head">
      <UIcon :name="icons.warning" class="danger-icon" aria-hidden="true" />危险操作
    </h3>
    <slot />
  </section>
</template>

<style scoped>
.danger-zone {
  max-width: 40rem;
  margin-top: 40px;
  border: 1px solid var(--ui-error);
}
.danger-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--ui-error);
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-error);
}
.danger-icon {
  width: 16px;
  height: 16px;
}
.danger-zone :slotted(.danger-row) {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--ui-border);
}
.danger-zone :slotted(.danger-row:last-child) {
  border-bottom: 0;
}
.danger-zone :slotted(.danger-text) {
  flex: 1;
  min-width: 0;
}
.danger-zone :slotted(.danger-name) {
  font-weight: 500;
}
.danger-zone :slotted(.danger-note) {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
@media (max-width: 767.98px) {
  .danger-zone :slotted(.danger-row) {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
