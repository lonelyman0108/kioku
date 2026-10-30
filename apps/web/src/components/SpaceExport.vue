<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { SPACE_EXPORT_PASSPHRASE_MIN } from '@kioku/contracts'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { saveFile } from '../download'
import { icons } from '../icons'

const props = defineProps<{ spaceId: string; spaceName: string; editable: boolean }>()

const toast = useToast()
const passphrase = ref('')
const confirm = ref('')
const exporting = ref(false)

// 换了空间就清掉：口令是给这一次导出设的
watch(
  () => props.spaceId,
  () => {
    passphrase.value = ''
    confirm.value = ''
  },
)

const problem = computed(() => {
  if (!passphrase.value) return null
  if (passphrase.value.length < SPACE_EXPORT_PASSPHRASE_MIN) {
    return `口令至少 ${SPACE_EXPORT_PASSPHRASE_MIN} 位`
  }
  if (confirm.value && confirm.value !== passphrase.value) return '两次填的口令不一样'
  return null
})
const ready = computed(
  () =>
    props.editable &&
    !exporting.value &&
    passphrase.value.length >= SPACE_EXPORT_PASSPHRASE_MIN &&
    confirm.value === passphrase.value,
)

async function exportSpace() {
  if (!ready.value) return
  exporting.value = true
  const forSpace = props.spaceId
  const fallback = `${props.spaceName || 'space'}.kioku-space`
  try {
    const { blob, filename } = await api.exportSpace(forSpace, passphrase.value)
    saveFile(blob, filename ?? fallback)
    if (forSpace === props.spaceId) {
      passphrase.value = ''
      confirm.value = ''
    }
    toast.add({
      title: '已导出',
      description: '口令请另外保存好：Kioku 不保存它，丢了口令，这个文件就打不开。',
      color: 'success',
    })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '导出失败', color: 'error' })
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <UCard class="max-w-2xl shrink-0">
    <template #header>
      <h2 class="font-medium">导出这个空间</h2>
      <p class="mt-1 text-sm text-muted">
        导出成一个用口令加密的文件，由实例管理员在另一个实例（或这个实例）里导入成新的空间。
        带走共享的记忆、人格、应用配置与对象，以及你自己的画像、私人层、凭据与凭据源（连同你让不让
        Dream 整理画像层与私人层）；secret
        记忆与托管的凭据值一起加密带走。别的成员的私人内容不导出；会话、召回记录、对话缓冲、抽取记录、历史与向量都不带，Key
        也不带，导入之后给应用重新签发，向量按那边的设置重新生成。
      </p>
    </template>
    <p v-if="!editable" class="text-sm text-muted">只有空间 owner 能导出。</p>
    <form v-else class="space-y-4" @submit.prevent="exportSpace">
      <UFormField
        label="口令"
        :help="`至少 ${SPACE_EXPORT_PASSPHRASE_MIN} 位。导入时要输入它；Kioku 不保存口令，丢了就打不开文件`"
      >
        <UInput
          v-model="passphrase"
          type="password"
          autocomplete="new-password"
          class="w-full"
          :disabled="exporting"
        />
      </UFormField>
      <UFormField label="再输一遍">
        <UInput
          v-model="confirm"
          type="password"
          autocomplete="new-password"
          class="w-full"
          :disabled="exporting"
        />
      </UFormField>
      <UAlert v-if="problem" color="warning" variant="subtle" :title="problem" />
      <div class="flex justify-end">
        <UButton type="submit" :icon="icons.exportSpace" :loading="exporting" :disabled="!ready">
          导出
        </UButton>
      </div>
    </form>
  </UCard>
</template>
