<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { circleSettingsRoute } from '../settingsSections'
import { confirmsName, DELETE_CONSEQUENCES } from '../spaces'
import ConsequenceModal from './ConsequenceModal.vue'

// 删除共享记忆圈：输入现在的名称才能删。当前账号是所有者时链到「导入与导出」，先导出再删
const props = defineProps<{
  open: boolean
  circleId: string
  circleName: string
  // 当前账号是这个记忆圈的所有者：能打开它的导出
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
const matches = computed(() => confirmsName(typed.value, props.circleName))

async function remove() {
  if (!matches.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    await api.deleteCircle(props.circleId, typed.value)
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
    :title="`删除共享圈「${circleName}」`"
    :consequences="DELETE_CONSEQUENCES"
    action="删除共享圈"
    :busy="busy"
    :error="error"
    :disabled="!matches"
    @confirm="remove"
    @close="emit('close')"
  >
    <p v-if="canExport" class="text-sm">
      删除前先在
      <RouterLink
        :to="circleSettingsRoute(circleId, 'transfer')"
        class="underline"
        @click="emit('close')"
        >导入与导出</RouterLink
      >
      中导出。
    </p>
    <p v-else class="text-sm">删除前先由记忆圈所有者导出。</p>
    <label class="mt-3 block text-sm" for="delete-circle-name">
      输入记忆圈名称 <code class="font-mono">{{ circleName }}</code> 以确认
    </label>
    <UInput
      id="delete-circle-name"
      v-model="typed"
      class="mt-1.5 w-full"
      autocomplete="off"
      :disabled="busy"
    />
  </ConsequenceModal>
</template>
