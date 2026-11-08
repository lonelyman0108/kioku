<script setup lang="ts">
import type { CreatedSpace } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'

// 新建空间：名称，实例管理员另外选所有者（默认当前账号，停用的账号不列）。建好后由调用方决定去哪
const props = withDefaults(
  defineProps<{ open: boolean; currentAccountId: string; chooseOwner?: boolean }>(),
  { chooseOwner: false },
)
const emit = defineEmits<{ close: []; created: [space: CreatedSpace] }>()

const accounts = useQuery({
  queryKey: ['instance-accounts'],
  queryFn: api.instanceAccounts,
  enabled: computed(() => props.open && props.chooseOwner),
})
const ownerItems = computed(() =>
  (accounts.data.value?.accounts ?? [])
    .filter((a) => !a.disabledAt)
    .map((a) => ({ label: `${a.displayName}（${a.username}）`, value: a.id })),
)

const name = ref('')
const owner = ref(props.currentAccountId)
const busy = ref(false)
const error = ref<string | null>(null)
watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = ''
    owner.value = props.currentAccountId
    error.value = null
  },
)
const trimmed = computed(() => name.value.trim())
const tooLong = computed(() => trimmed.value.length > 64)
const ready = computed(() => trimmed.value.length > 0 && !tooLong.value && !busy.value)

async function create() {
  if (!ready.value) return
  busy.value = true
  error.value = null
  try {
    const space = await api.createSpace({
      name: trimmed.value,
      ...(props.chooseOwner && owner.value !== props.currentAccountId
        ? { ownerAccountId: owner.value }
        : {}),
    })
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
        <UFormField label="名称" :error="tooLong ? '空间名不超过 64 个字符' : undefined">
          <UInput
            v-model="name"
            class="w-full"
            autocomplete="off"
            :disabled="busy"
            @keydown.enter.prevent="create"
          />
        </UFormField>
        <UFormField v-if="chooseOwner" label="所有者" help="新空间的唯一成员">
          <USelect
            v-model="owner"
            :items="ownerItems"
            :loading="accounts.isPending.value"
            class="w-full"
            :disabled="busy"
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
