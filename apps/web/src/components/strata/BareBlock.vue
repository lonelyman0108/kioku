<script setup lang="ts">
// 和 SettingsBlock 同样的插槽，但不画标题：放进弹窗里时标题由弹窗写
defineProps<{ title?: string }>()
</script>

<template>
  <div>
    <p v-if="$slots.note" class="bare-note"><slot name="note" /></p>
    <div class="bare-body"><slot /></div>
  </div>
</template>

<style scoped>
.bare-note {
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.bare-body {
  padding-top: 14px;
}
</style>
