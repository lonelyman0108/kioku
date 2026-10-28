<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ExtractionTestResult } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'

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

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await api.saveExtractionSettings({
      baseUrl: form.baseUrl,
      model: form.model,
      ...(form.clearKey ? { apiKey: null } : form.apiKey ? { apiKey: form.apiKey } : {}),
    })
    form.apiKey = ''
    form.clearKey = false
    result.value = null
    await queryClient.invalidateQueries({ queryKey })
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const testing = ref(false)
const result = ref<ExtractionTestResult | null>(null)
// 「测试连通」测的是已保存的设置：表单有没保存的改动时先保存再测，改动之后旧的测试结果也不再显示
const dirty = computed(() => {
  const saved = settings.data.value
  return (
    form.baseUrl !== (saved?.baseUrl ?? '') ||
    form.model !== (saved?.model ?? '') ||
    form.apiKey !== '' ||
    form.clearKey
  )
})
watch(dirty, (changed) => {
  if (changed) result.value = null
})
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
    form.baseUrl = ''
    form.model = ''
    form.apiKey = ''
    form.clearKey = false
    result.value = null
    confirmingClear.value = false
    await queryClient.invalidateQueries({ queryKey })
    toast.add({ title: '已清除，抽取停止', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '清除失败', color: 'error' })
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-medium">抽取模型</h2>
      <p class="mt-1 text-sm text-muted">
        OpenAI 兼容的 /chat/completions 接口（例如
        new-api），用来从群聊与私聊里抽取关于对方的事实、写会话摘要。
        整个实例共用一个模型；没配时不抽取，对话缓冲到期后直接丢弃。
      </p>
    </template>
    <UAlert
      v-if="settings.isError.value && !settings.data.value"
      color="error"
      variant="subtle"
      :title="settings.error.value instanceof ApiError ? settings.error.value.message : '读取失败'"
    />
    <form v-else class="space-y-4" @submit.prevent="save">
      <UFormField label="接口地址" help="例如 https://api.example.com/v1">
        <UInput v-model="form.baseUrl" class="w-full font-mono" required />
      </UFormField>
      <UFormField label="模型" help="模型名，例如 deepseek-chat">
        <UInput v-model="form.model" class="w-full font-mono" required />
      </UFormField>
      <UFormField
        label="API Key"
        :help="
          settings.data.value?.hasApiKey
            ? '已保存（加密存储）。留空表示不修改；更换了接口主机时必须重新填写'
            : '用实例主密钥加密后存库'
        "
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
        <UButton type="submit" :icon="icons.save" :loading="saving">保存</UButton>
        <UButton
          :icon="icons.test"
          color="neutral"
          variant="subtle"
          :loading="testing"
          :disabled="!settings.data.value?.configured || dirty"
          @click="test"
        >
          测试连通
        </UButton>
        <UButton
          v-if="settings.data.value?.configured"
          color="error"
          variant="ghost"
          @click="confirmingClear = true"
        >
          清除设置
        </UButton>
        <span v-if="dirty && settings.data.value?.configured" class="text-sm text-muted"
          >改动保存之后才能测试</span
        >
        <span v-if="result" class="text-sm" :class="result.ok ? 'text-success' : 'text-error'">
          {{ result.ok ? `正常，耗时 ${result.latencyMs} ms` : result.error }}
        </span>
      </div>
    </form>
  </UCard>

  <UModal
    :open="confirmingClear"
    title="清除抽取模型的设置？"
    :dismissible="!clearing"
    @update:open="(v) => !v && !clearing && (confirmingClear = false)"
  >
    <template #body>
      <p class="text-sm">
        清除之后不再从对话里抽取事实、也不写会话摘要，对话缓冲到期后直接丢弃。已经抽取出的记忆不受影响。
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
