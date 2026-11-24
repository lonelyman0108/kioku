<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { CIRCLE_EXPORT_PASSPHRASE_MIN } from '@kioku/contracts'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { saveFile } from '../download'
import { icons } from '../icons'
import Hint from './Hint.vue'
import TransferEntryRow from './TransferEntryRow.vue'
import NoteLine from './strata/NoteLine.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

const props = defineProps<{ circleId: string; circleName: string; editable: boolean }>()

const toast = useToast()
const open = ref(false)
const passphrase = ref('')
const confirm = ref('')
const exporting = ref(false)

// 换了记忆圈或关掉弹窗时清掉口令：口令只属于这一次导出
watch(
  () => props.circleId,
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
  if (passphrase.value.length < CIRCLE_EXPORT_PASSPHRASE_MIN) {
    return `口令至少 ${CIRCLE_EXPORT_PASSPHRASE_MIN} 位`
  }
  if (confirm.value && confirm.value !== passphrase.value) return '两次输入的口令不一致'
  return null
})
const ready = computed(
  () =>
    props.editable &&
    !exporting.value &&
    passphrase.value.length >= CIRCLE_EXPORT_PASSPHRASE_MIN &&
    confirm.value === passphrase.value,
)

async function exportCircle() {
  if (!ready.value) return
  exporting.value = true
  const target = props.circleId
  const fallback = `${props.circleName || 'circle'}.kioku-circle`
  try {
    const { blob, filename } = await api.exportCircle(target, passphrase.value)
    saveFile(blob, filename ?? fallback)
    if (target === props.circleId) {
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
      将当前记忆圈导出为口令加密的文件，含机密记忆与托管的凭据值。可在下方「导入记忆圈」导入。
      <Hint>
        <p>
          包含记忆圈内的记忆与变体、语境词典、独立人格、客户端配置、联系人，以及当前账号在本圈的凭据与密码库连接。机密记忆与托管凭据值一并加密导出；密码库连接不含令牌与密钥，导入后需重新登录。
        </p>
        <p class="mt-1">
          已过期的记忆与已被取代的事实也会导出，有效期不变，导入后可恢复生效。已删除的内容不导出。
        </p>
        <p class="mt-1">
          不包含会话、召回记录、对话缓冲、抽取记录、历史、向量与访问密钥。导入后需为客户端重新签发访问密钥，向量按目标实例设置重新生成。
        </p>
      </Hint>
    </template>
    <p v-if="!editable" class="text-muted">仅记忆圈所有者可导出</p>
    <TransferEntryRow
      v-else
      :icon="icons.exportCircle"
      title="加密导出文件（.kioku-circle）"
      description="打包记忆、语境词典、人格、客户端、联系人及当前账号的凭据；在弹窗中设置文件口令后下载。"
    >
      <template #action>
        <UButton color="neutral" variant="outline" :icon="icons.exportCircle" @click="open = true">
          导出记忆圈
        </UButton>
      </template>
    </TransferEntryRow>

    <UModal
      v-model:open="open"
      title="导出当前记忆圈"
      :dismissible="!exporting"
      :close="!exporting"
    >
      <template #body>
        <form class="space-y-4" @submit.prevent="exportCircle">
          <UFormField
            label="口令"
            :help="`至少 ${CIRCLE_EXPORT_PASSPHRASE_MIN} 位，导入时需要输入；Kioku 不保存口令，丢失后无法打开文件。`"
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
