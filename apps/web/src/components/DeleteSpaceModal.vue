<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { spaceSettingsRoute } from '../settingsSections'
import { confirmsName, DELETE_CONSEQUENCES } from '../spaces'
import ConsequenceModal from './ConsequenceModal.vue'

// 删除空间：输入现在的空间名才能删。当前账号是成员时链到这个空间的「导入与导出」，先导出再删
const props = defineProps<{
  open: boolean
  spaceId: string
  spaceName: string
  // 当前账号是这个空间的成员：能打开它的导出
  canExport: boolean
}>()
const emit = defineEmits<{ close: []; deleted: [] }>()

const typed = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
watch(
  () => props.open,
  (open) => {
    if (open) {
      typed.value = ''
      error.value = null
    }
  },
)
const matches = computed(() => confirmsName(typed.value, props.spaceName))

async function remove() {
  if (!matches.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    await api.deleteSpace(props.spaceId, typed.value)
    emit('deleted')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '删除失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ConsequenceModal
    :open="open"
    :title="`删除空间「${spaceName}」`"
    :consequences="DELETE_CONSEQUENCES"
    action="删除空间"
    :busy="busy"
    :error="error"
    :disabled="!matches"
    @confirm="remove"
    @close="emit('close')"
  >
    <p v-if="canExport" class="text-sm">
      删除前先在
      <RouterLink
        :to="spaceSettingsRoute(spaceId, 'transfer')"
        class="underline"
        @click="emit('close')"
        >导入与导出</RouterLink
      >
      中导出。
    </p>
    <p v-else class="text-sm">删除前先由空间所有者导出。</p>
    <label class="mt-3 block text-sm" for="delete-space-name">
      输入空间名 <code class="font-mono">{{ spaceName }}</code> 以确认
    </label>
    <UInput
      id="delete-space-name"
      v-model="typed"
      class="mt-1.5 w-full"
      autocomplete="off"
      :disabled="busy"
    />
  </ConsequenceModal>
</template>
