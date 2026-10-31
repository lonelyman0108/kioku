<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { SPACE_EXPORT_PASSPHRASE_MIN } from '@kioku/contracts'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { saveFile } from '../download'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

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
  if (confirm.value && confirm.value !== passphrase.value) return '两次输入的口令不一致'
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
      description: '请另行保存口令。Kioku 不保存口令，丢失后无法打开此文件。',
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
  <SettingsBlock title="导出空间">
    <template #note>
      导出为口令加密的文件，含机密记忆与托管的凭据值，由实例管理员在其他实例或当前实例导入为新空间。
      <Hint>
        <p>
          包含共享的记忆、人格、应用配置与联系人，以及当前账号的个人画像层与私人层（含是否允许 Dream
          整理的设置）、凭据与凭据源。机密记忆与托管的凭据值一并加密导出。
        </p>
        <p class="mt-1">
          已过期的记忆与已被取代的事实也会导出，有效期不变，导入后可恢复生效（已被取代的事实不再保留取代它的记录）。已删除的内容不导出。
        </p>
        <p class="mt-1">
          不包含其他成员的私人内容、会话、召回记录、对话缓冲、抽取记录、历史、向量与
          Key。导入后需为应用重新签发 Key，向量按目标实例的设置重新生成。
        </p>
      </Hint>
    </template>
    <p v-if="!editable" class="text-muted">仅空间所有者可导出</p>
    <form v-else class="space-y-4" @submit.prevent="exportSpace">
      <UFormField
        label="口令"
        :help="`至少 ${SPACE_EXPORT_PASSPHRASE_MIN} 位，导入时需要输入；Kioku 不保存口令，丢失后无法打开文件。`"
      >
        <UInput
          v-model="passphrase"
          type="password"
          autocomplete="new-password"
          class="w-full"
          :disabled="exporting"
        />
      </UFormField>
      <UFormField label="确认口令">
        <UInput
          v-model="confirm"
          type="password"
          autocomplete="new-password"
          class="w-full"
          :disabled="exporting"
        />
      </UFormField>
      <NoteLine v-if="problem" tone="warning">{{ problem }}</NoteLine>
      <UButton
        type="submit"
        color="primary"
        variant="outline"
        :loading="exporting"
        :disabled="!ready"
      >
        导出
      </UButton>
    </form>
  </SettingsBlock>
</template>
