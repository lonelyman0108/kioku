<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  CREDENTIAL_PROVIDER_KINDS,
  CreateCredentialProviderRequest,
  UpdateCredentialProviderRequest,
  type CredentialProvider,
  type CredentialProviderKind,
} from '@kioku/contracts'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { providerKindLabels } from '../labels'

const props = defineProps<{ spaceId: string; provider: CredentialProvider | null }>()
const open = defineModel<boolean>('open', { required: true })
// 事件带上提交时的空间：保存期间切换了空间，页面刷新的是保存到的那个空间
const emit = defineEmits<{ saved: [spaceId: string] }>()
const toast = useToast()

const kindHelp: Record<CredentialProviderKind, string> = {
  bitwarden: '官方服务或兼容的自建服务端都选这个',
  '1password': '1Password 与它的 CLI（op）',
  env: '值放在运行 agent 的机器的环境变量里',
  other: '别的密码管理器或取值方式，取法写在使用说明里',
}
const kindItems = CREDENTIAL_PROVIDER_KINDS.map((k) => ({
  label: providerKindLabels[k],
  description: kindHelp[k],
  value: k,
}))

const form = reactive({ kind: 'bitwarden' as CredentialProviderKind, name: '', instructions: '' })
// 打开时记下要改的是哪一个：期间列表刷新换了对象也不会改错
const editingId = ref<string | null>(null)
watch(open, (isOpen) => {
  if (!isOpen) return
  editingId.value = props.provider?.id ?? null
  Object.assign(form, {
    kind: props.provider?.kind ?? 'bitwarden',
    name: props.provider?.name ?? '',
    instructions: props.provider?.instructions ?? '',
  })
})

const saving = ref(false)
const body = () => ({ kind: form.kind, name: form.name.trim(), instructions: form.instructions })
// 按接口的定义检查（名称与使用说明的长度等），提示与服务端一致
const problem = computed<string | null>(() => {
  const result = editingId.value
    ? UpdateCredentialProviderRequest.safeParse(body())
    : CreateCredentialProviderRequest.safeParse(body())
  return result.success ? null : (result.error.issues[0]?.message ?? '填写的内容不对')
})
async function submit() {
  if (saving.value || problem.value) return
  saving.value = true
  const spaceId = props.spaceId
  try {
    if (editingId.value) await api.updateCredentialProvider(spaceId, editingId.value, body())
    else await api.createCredentialProvider(spaceId, body())
    open.value = false
    toast.add({ title: editingId.value ? '已保存' : '已添加凭据源', color: 'success' })
    emit('saved', spaceId)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="editingId ? '修改凭据源' : '添加凭据源'">
    <template #body>
      <form id="provider-form" class="space-y-4" @submit.prevent="submit">
        <UFormField label="类型">
          <URadioGroup v-model="form.kind" :items="kindItems" />
        </UFormField>
        <UFormField label="名称" help="在凭据的来源里显示，例如「家里的密码库」">
          <UInput v-model="form.name" class="w-full" />
        </UFormField>
        <UFormField
          label="使用说明"
          help="会原样给 agent 看：写清在哪台机器上、用什么工具取值、怎么解锁。不要写主密码、会话令牌这类东西本身"
        >
          <UTextarea
            v-model="form.instructions"
            :rows="4"
            autoresize
            class="w-full"
            placeholder="例如：在工作站上用 bw CLI；会话令牌在环境变量 BW_SESSION 里，过期了让主人重新解锁"
          />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <span v-if="problem" class="mr-auto text-xs text-muted">{{ problem }}</span>
        <UButton color="neutral" variant="ghost" @click="open = false">取消</UButton>
        <UButton type="submit" form="provider-form" :loading="saving" :disabled="!!problem">
          {{ editingId ? '保存' : '添加' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
