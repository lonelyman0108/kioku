<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ExtractionSettingsView, ExtractionTestResult } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { needsNewKey, newKeyHint } from '../endpointKey'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 有没有没保存的修改：切到别的小节之后表单看不见了，交给页面在子导航上标出来
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = ['settings', 'extraction']
const settings = useQuery({ queryKey, queryFn: api.extractionSettings })

// apiKey 留空表示沿用已保存的 Key；勾选「清除」时发 null
const form = reactive({ baseUrl: '', model: '', apiKey: '', clearKey: false })
watch(
  () => settings.data.value,
  (s) => {
    if (!s) return
    form.baseUrl = s.baseUrl ?? ''
    form.model = s.model ?? ''
  },
  { immediate: true },
)

// 换了接口主机又没说 Key 怎么处理：服务端会拒，提交之前就在 Key 旁边说明，保存按钮不可点
const keyMissing = computed(() =>
  needsNewKey({
    baseUrl: form.baseUrl,
    savedBaseUrl: settings.data.value?.baseUrl ?? null,
    hasApiKey: settings.data.value?.hasApiKey ?? false,
    apiKey: form.apiKey,
    clearKey: form.clearKey,
  }),
)

const saving = ref(false)
async function save() {
  if (keyMissing.value) return
  saving.value = true
  try {
    const saved = await api.saveExtractionSettings({
      baseUrl: form.baseUrl,
      model: form.model,
      ...(form.clearKey ? { apiKey: null } : form.apiKey ? { apiKey: form.apiKey } : {}),
    })
    // 先换上保存之后的设置，再清掉填过的 Key：要不要重填 Key 按刚保存的主机与 Key 判断，
    // 不等重新读取（等的时候、读取失败时会按旧的主机误报要重填）
    queryClient.setQueryData(queryKey, saved)
    form.apiKey = ''
    form.clearKey = false
    result.value = null
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const testing = ref(false)
const result = ref<ExtractionTestResult | null>(null)
// 「测试连接」测的是已保存的设置：表单有没保存的改动时先保存再测，改动之后旧的测试结果也不再显示
const dirty = computed(() => {
  const saved = settings.data.value
  return (
    form.baseUrl !== (saved?.baseUrl ?? '') ||
    form.model !== (saved?.model ?? '') ||
    form.apiKey !== '' ||
    form.clearKey
  )
})
watch(
  dirty,
  (changed) => {
    dirtyModel.value = changed
    if (changed) result.value = null
  },
  { immediate: true },
)
async function test() {
  testing.value = true
  try {
    result.value = await api.testExtraction()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '测试失败', color: 'error' })
  } finally {
    testing.value = false
  }
}

const confirmingClear = ref(false)
const clearing = ref(false)
async function clear() {
  clearing.value = true
  try {
    await api.clearExtractionSettings()
    // 先按「没有设置」填好界面，再去刷新：刷新出错时不能停在旧的设置上，那样清空的表单一直算有改动
    queryClient.setQueryData<ExtractionSettingsView>(queryKey, {
      configured: false,
      baseUrl: null,
      model: null,
      hasApiKey: false,
    })
    form.baseUrl = ''
    form.model = ''
    form.apiKey = ''
    form.clearKey = false
    result.value = null
    confirmingClear.value = false
    await queryClient.invalidateQueries({ queryKey })
    toast.add({ title: '已清除，抽取已停止', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '清除失败', color: 'error' })
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <SettingsBlock title="抽取模型">
    <template #note>
      OpenAI 兼容的 /chat/completions 接口（例如 new-api），用于抽取事实、生成会话摘要。
      <Hint>
        从群聊与私聊中抽取关于对方的事实。整个实例共用一个模型；未配置时不抽取，对话缓冲到期后直接丢弃。
      </Hint>
    </template>
    <!-- 后台刷新失败时读到过的设置留着，错误放在上面 -->
    <NoteLine v-if="settings.isError.value" tone="error">
      {{ readFailure(settings.error.value) }}
    </NoteLine>
    <!-- 没读到过设置时不给表单：空表单保存会盖掉读不到的那份。重新读取时错误会被清掉，所以只看有没有数据 -->
    <USkeleton v-if="settings.isPending.value" class="h-40 w-full" />
    <form v-else-if="settings.data.value" class="space-y-4" @submit.prevent="save">
      <UFormField label="接口地址" help="例如 https://api.example.com/v1">
        <UInput v-model="form.baseUrl" class="w-full font-mono" required />
      </UFormField>
      <UFormField label="模型" help="模型名称，例如 deepseek-chat">
        <UInput v-model="form.model" class="w-full font-mono" required />
      </UFormField>
      <UFormField
        label="API Key"
        :help="
          settings.data.value?.hasApiKey
            ? '已加密保存；留空表示不修改，更换接口主机时必须重新填写。'
            : '使用实例主密钥加密保存。'
        "
        :error="keyMissing ? newKeyHint('Key', true) : undefined"
      >
        <UInput
          v-model="form.apiKey"
          type="password"
          autocomplete="off"
          class="w-full"
          :disabled="form.clearKey"
        />
      </UFormField>
      <UCheckbox
        v-if="settings.data.value?.hasApiKey"
        v-model="form.clearKey"
        label="清除已保存的 Key（新接口不需要 Key）"
      />
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          type="submit"
          color="primary"
          variant="outline"
          :loading="saving"
          :disabled="keyMissing"
          >保存</UButton
        >
        <UButton
          color="neutral"
          variant="outline"
          :loading="testing"
          :disabled="!settings.data.value?.configured || dirty"
          @click="test"
        >
          测试连接
        </UButton>
        <UButton
          v-if="settings.data.value?.configured"
          color="error"
          variant="outline"
          @click="confirmingClear = true"
        >
          清除设置
        </UButton>
        <span v-if="dirty && settings.data.value?.configured" class="text-muted"
          >保存改动后才能测试</span
        >
        <span v-if="result" :class="result.ok ? 'text-success' : 'text-error'">
          {{ result.ok ? `连接正常，耗时 ${result.latencyMs} ms` : result.error }}
        </span>
      </div>
    </form>
  </SettingsBlock>

  <UModal
    :open="confirmingClear"
    title="清除抽取模型设置？"
    :dismissible="!clearing"
    @update:open="(v) => !v && !clearing && (confirmingClear = false)"
  >
    <template #body>
      <p class="text-sm">
        清除后不再从对话中抽取事实，也不再生成会话摘要，对话缓冲到期后直接丢弃。已抽取的记忆不受影响。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="clearing"
          @click="confirmingClear = false"
          >取消</UButton
        >
        <UButton color="error" :loading="clearing" @click="clear">清除</UButton>
      </div>
    </template>
  </UModal>
</template>
