<script setup lang="ts">
// 不可逆操作的确认：标题写结果，正文逐条写影响，按钮写动作。不用 <form>：只有点按钮才执行。
// 执行中不能关；失败的原因由调用方传 error，留在弹窗里
import { icons } from '../icons'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    consequences: readonly string[]
    action: string
    actionIcon?: string
    busy?: boolean
    error?: string | null
    // 还缺什么时不能点（例如没选转让给谁）
    disabled?: boolean
  }>(),
  { actionIcon: icons.warning, busy: false, error: null, disabled: false },
)
const emit = defineEmits<{ confirm: []; close: [] }>()
</script>

<template>
  <UModal
    :open="open"
    :title="title"
    :dismissible="!busy"
    @update:open="(v) => !v && !busy && emit('close')"
  >
    <template #title>
      <span class="modal-title">
        <UIcon :name="icons.warning" class="modal-warn-icon" aria-hidden="true" />
        <span>{{ title }}</span>
      </span>
    </template>
    <template #body>
      <ul class="consequences">
        <li v-for="line in consequences" :key="line">{{ line }}</li>
      </ul>
      <div v-if="$slots.default" class="pt-3"><slot /></div>
      <p v-if="error" class="pt-3 text-sm text-error" role="alert">{{ error }}</p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="busy" @click="emit('close')"
          >取消</UButton
        >
        <UButton
          color="error"
          :icon="actionIcon"
          :loading="busy"
          :disabled="disabled || busy"
          @click="emit('confirm')"
          >{{ action }}</UButton
        >
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.modal-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.modal-warn-icon {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--ui-error);
}
.consequences {
  display: grid;
  gap: 4px;
  padding-left: 1.2em;
  list-style: disc;
  font-size: 14px;
  line-height: 1.6;
}
</style>
