<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { SPACE_EXPORT_PASSPHRASE_MIN } from '@kioku/contracts'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { saveFile } from '../download'
import { icons } from '../icons'
import Hint from './Hint.vue'
import TransferEntryRow from './TransferEntryRow.vue'
import NoteLine from './strata/NoteLine.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

const props = defineProps<{ spaceId: string; spaceName: string; editable: boolean }>()

const toast = useToast()
const open = ref(false)
const passphrase = ref('')
const confirm = ref('')
const exporting = ref(false)

// 换了空间或关掉弹窗时清掉口令：口令只属于这一次导出
watch(
  () => props.spaceId,
  () => {
    open.value = false
    passphrase.value = ''
    confirm.value = ''
  },
)
watch(open, (opened) => {
  if (!opened) {
    passphrase.value = ''
    confirm.value = ''
  }
})

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
      open.value = false
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
  <SettingsBlock title="导出">
    <template #note>
      将当前空间导出为口令加密的文件，含机密记忆与托管的凭据值。可在下方「导入空间」将它导入为新空间，其他实例或当前实例均可。
      <Hint>
        <p>
          包含共享的记忆、人格、应用配置与联系人，以及当前账号的本人记忆（含是否允许整理的设置）、凭据与密码库连接。机密记忆与托管的凭据值一并加密导出；密码库连接不含令牌与密钥，导入后需重新登录。
        </p>
        <p class="mt-1">
          已过期的记忆与已被取代的事实也会导出，有效期不变，导入后可恢复生效（已被取代的事实不再保留取代它的记录）。已删除的内容不导出。
        </p>
        <p class="mt-1">
          不包含其他成员的本人记忆、会话、召回记录、对话缓冲、抽取记录、历史、向量与访问密钥。导入后需为应用重新签发访问密钥，向量按目标实例的设置重新生成。
        </p>
      </Hint>
    </template>
    <p v-if="!editable" class="text-muted">仅空间所有者可导出</p>
    <TransferEntryRow
      v-else
      :icon="icons.exportSpace"
      title="加密导出文件（.kioku-space）"
      description="打包共享记忆、人格、应用、联系人与本人记忆及凭据；在弹窗中设置文件口令后下载。"
    >
      <template #action>
        <UButton color="neutral" variant="outline" :icon="icons.exportSpace" @click="open = true">
          导出空间
        </UButton>
      </template>
    </TransferEntryRow>

    <UModal v-model:open="open" title="导出当前空间" :dismissible="!exporting" :close="!exporting">
      <template #body>
        <form class="space-y-4" @submit.prevent="exportSpace">
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
              autofocus
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
          <div class="flex justify-end gap-2 pt-2">
            <UButton color="neutral" variant="ghost" :disabled="exporting" @click="open = false">
              取消
            </UButton>
            <UButton type="submit" color="primary" :loading="exporting" :disabled="!ready">
              导出
            </UButton>
          </div>
        </form>
      </template>
    </UModal>
  </SettingsBlock>
</template>
