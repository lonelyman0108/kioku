<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { EmbeddingTestResult } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'

const toast = useToast()
const queryClient = useQueryClient()
const settings = useQuery({ queryKey: ['settings', 'embedding'], queryFn: api.embeddingSettings })

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
    await api.saveEmbeddingSettings({
      baseUrl: form.baseUrl,
      model: form.model,
      ...(form.clearKey ? { apiKey: null } : form.apiKey ? { apiKey: form.apiKey } : {}),
    })
    form.apiKey = ''
    form.clearKey = false
    await queryClient.invalidateQueries({ queryKey: ['settings', 'embedding'] })
    toast.add({ title: '已保存，后台会为全部记忆重新生成向量', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const testing = ref(false)
const result = ref<EmbeddingTestResult | null>(null)
async function test() {
  testing.value = true
  try {
    result.value = await api.testEmbedding()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '测试失败', color: 'error' })
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="实例设置" />
    </template>
    <template #body>
      <UAlert
        v-if="settings.isError.value"
        color="error"
        variant="subtle"
        class="mb-4 max-w-2xl"
        :title="
          settings.error.value instanceof ApiError ? settings.error.value.message : '读取设置失败'
        "
      />
      <UCard class="max-w-2xl">
        <template #header>
          <h2 class="font-medium">嵌入模型</h2>
          <p class="mt-1 text-sm text-muted">
            OpenAI 兼容的 /embeddings 接口，需要支持 dimensions 参数，向量维度固定为
            {{ settings.data.value?.dimensions ?? 1024 }}。
            整个实例共用一个模型；更换模型后会在后台重新生成全部向量。
          </p>
        </template>
        <form class="space-y-4" @submit.prevent="save">
          <UFormField label="接口地址" help="例如 https://api.example.com/v1">
            <UInput v-model="form.baseUrl" class="w-full font-mono" required />
          </UFormField>
          <UFormField label="模型">
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
              :disabled="!settings.data.value?.configured"
              @click="test"
            >
              测试连通
            </UButton>
            <span v-if="result" class="text-sm" :class="result.ok ? 'text-success' : 'text-error'">
              {{ result.ok ? `正常，耗时 ${result.latencyMs} ms` : result.error }}
            </span>
          </div>
        </form>
      </UCard>
    </template>
  </UDashboardPanel>
</template>
