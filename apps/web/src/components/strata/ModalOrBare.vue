<script setup lang="ts">
import TransferEntryRow from '../TransferEntryRow.vue'
import BareBlock from './BareBlock.vue'
import SettingsBlock from './SettingsBlock.vue'

// 在单独弹窗（bare）和设置页弹窗入口之间共用同一份表单，避免表单逻辑重复
const props = withDefaults(
  defineProps<{
    bare?: boolean
    open?: boolean
    title: string
    entryTitle: string
    entryDescription: string
    actionLabel: string
    icon: string
    busy?: boolean
    disabled?: boolean
    status?: string | null
    statusTone?: 'neutral' | 'warning'
  }>(),
  {
    bare: false,
    open: false,
    busy: false,
    disabled: false,
    status: null,
    statusTone: 'neutral',
  },
)
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
</script>

<template>
  <BareBlock v-if="props.bare" :title="props.title">
    <template v-if="$slots.note" #note><slot name="note" /></template>
    <div class="space-y-4">
      <slot name="alerts" />
      <slot />
    </div>
  </BareBlock>

  <SettingsBlock v-else :title="props.title">
    <template v-if="$slots.note" #note><slot name="note" /></template>
    <div v-if="!props.open && $slots.alerts"><slot name="alerts" /></div>
    <TransferEntryRow
      :icon="props.icon"
      :title="props.entryTitle"
      :description="props.entryDescription"
      :status="props.status"
      :status-tone="props.statusTone"
    >
      <template #action>
        <UButton
          color="neutral"
          variant="outline"
          :icon="props.icon"
          :disabled="props.disabled"
          @click="emit('update:open', true)"
        >
          {{ props.actionLabel }}
        </UButton>
      </template>
    </TransferEntryRow>

    <UModal
      :open="props.open"
      :title="props.title"
      :dismissible="!props.busy"
      :close="!props.busy"
      @update:open="(value: boolean) => !props.busy && emit('update:open', value)"
    >
      <template #body>
        <div class="space-y-4">
          <div v-if="$slots.alerts"><slot name="alerts" /></div>
          <slot />
        </div>
      </template>
    </UModal>
  </SettingsBlock>
</template>
