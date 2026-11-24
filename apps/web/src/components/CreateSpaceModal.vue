<script setup lang="ts">
import { FacetTermSlug, type CreatedCircle } from '@kioku/contracts'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { CIRCLE_NAME_RANGE, circleNameIssue } from '../spaces'

// 新建独立圈：填写名称（可选默认场域），所有者是当前账号。建好后由调用方决定去哪
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [circle: CreatedCircle] }>()

const name = ref('')
const defaultRealm = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = ''
    defaultRealm.value = ''
    error.value = null
  },
)
const trimmed = computed(() => name.value.trim())
const trimmedRealm = computed(() => defaultRealm.value.trim().toLowerCase())
// 空着时不提示，只是不能点新建；超出长度时写出范围
const issue = computed(() => circleNameIssue(name.value))
const realmProblem = computed(() => {
  if (!trimmedRealm.value) return null
  return FacetTermSlug.safeParse(trimmedRealm.value).success
    ? null
    : '场域标识须以小写字母或数字开头，仅含小写字母、数字、点、下划线或连字符。'
})
const ready = computed(() => issue.value === null && realmProblem.value === null && !busy.value)

async function create() {
  if (!ready.value) return
  busy.value = true
  error.value = null
  try {
    const circle = trimmedRealm.value
      ? await api.createCircle({
          name: trimmed.value,
          defaultFacets: { realm: [trimmedRealm.value] },
        })
      : await api.createCircle({ name: trimmed.value })
    emit('created', circle)
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
    title="新建独立圈"
    description="可单人隔离工作域或机器人，也可创建后在设置中添加协作账号"
    :dismissible="!busy"
    :close="!busy"
    @update:open="(v) => !v && !busy && emit('close')"
  >
    <template #body>
      <div class="grid gap-4">
        <UFormField label="名称" :error="issue === 'range' ? CIRCLE_NAME_RANGE : undefined">
          <UInput
            v-model="name"
            class="w-full"
            autocomplete="off"
            :disabled="busy"
            @keydown.enter.prevent="create"
          />
        </UFormField>
        <UFormField
          label="默认场域（可选）"
          help="留空时本圈不预设场域；填写后未单独指定场域的记忆将自动归入此场域，创建后可在设置中修改。"
          :error="realmProblem ?? undefined"
        >
          <UInput
            v-model="defaultRealm"
            class="w-full font-mono"
            placeholder="例如 work / studio"
            autocomplete="off"
            spellcheck="false"
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
