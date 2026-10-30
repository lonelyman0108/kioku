<script setup lang="ts">
import { computed } from 'vue'

import type { FormField } from '../benchForm'

// 表单的一个字段。值一律是字符串，空串表示不填；不在这里校验，校验交给服务端
const props = defineProps<{ field: FormField; value: string; isNull: boolean }>()
const emit = defineEmits<{ 'update:value': [value: string]; 'update:isNull': [isNull: boolean] }>()

const optionItems = computed(() => [
  ...(props.field.required ? [] : [{ label: '不填', value: null as string | null }]),
  ...props.field.options.map((value) => ({ label: value, value: value as string | null })),
])
const update = (value: unknown) => emit('update:value', value === null ? '' : String(value ?? ''))
const placeholder = computed(() => props.field.placeholder ?? undefined)
</script>

<template>
  <UFormField
    :label="field.label"
    :required="field.required"
    :help="field.description ?? undefined"
  >
    <div class="flex items-start gap-2">
      <USelect
        v-if="field.options.length"
        :model-value="value || null"
        :items="optionItems"
        :disabled="isNull"
        placeholder="不填"
        class="w-full"
        @update:model-value="update"
      />
      <UTextarea
        v-else-if="field.kind === 'json' || field.multiline"
        :model-value="value"
        :rows="field.kind === 'json' ? 3 : 2"
        autoresize
        :disabled="isNull"
        :placeholder="placeholder"
        class="w-full"
        :class="{ 'font-mono': field.kind === 'json' }"
        @update:model-value="update"
      />
      <UInput
        v-else
        :model-value="value"
        :type="field.kind === 'number' ? 'number' : 'text'"
        :disabled="isNull"
        :placeholder="placeholder"
        class="w-full"
        @update:model-value="update"
      />
      <UCheckbox
        v-if="field.nullable"
        :model-value="isNull"
        label="传 null"
        class="shrink-0 pt-1.5"
        @update:model-value="(v) => emit('update:isNull', v === true)"
      />
    </div>
  </UFormField>
</template>
