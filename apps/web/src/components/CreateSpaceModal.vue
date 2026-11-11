<script setup lang="ts">
import type { CreatedSpace } from '@kioku/contracts'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { SPACE_NAME_RANGE, spaceNameIssue } from '../spaces'

// 新建空间：只填名称，所有者是当前账号。建好后由调用方决定去哪
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [space: CreatedSpace] }>()

const name = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = ''
    error.value = null
  },
)
const trimmed = computed(() => name.value.trim())
// 空着时不提示，只是不能点新建；超出长度时写出范围
const issue = computed(() => spaceNameIssue(name.value))
const ready = computed(() => issue.value === null && !busy.value)

async function create() {
  if (!ready.value) return
  busy.value = true
  error.value = null
  try {
    const space = await api.createSpace({ name: trimmed.value })
    emit('created', space)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '新建失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    title="新建空间"
    :dismissible="!busy"
    @update:open="(v) => !v && !busy && emit('close')"
  >
    <template #body>
      <div class="grid gap-4">
        <UFormField label="名称" :error="issue === 'range' ? SPACE_NAME_RANGE : undefined">
          <UInput
            v-model="name"
            class="w-full"
            autocomplete="off"
            :disabled="busy"
            @keydown.enter.prevent="create"
          />
        </UFormField>
        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="busy" @click="emit('close')"
          >取消</UButton
        >
        <UButton :loading="busy" :disabled="!ready" @click="create">新建</UButton>
      </div>
    </template>
  </UModal>
</template>
