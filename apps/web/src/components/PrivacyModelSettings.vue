<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ModelChainTestResult, PrivacyBindingMode } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { profileIdsChanged } from '../embeddingDrafts'
import { needsNewKey, newKeyHint } from '../endpointKey'
import { flattenProfiles } from '../models'
import Hint from './Hint.vue'
import ModelChainEditor from './ModelChainEditor.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 隐私识别模型（实例级，可选）：在内置规则之外补充识别人名、住址与私有账号
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = ['settings', 'models']
const registry = useQuery({ queryKey, queryFn: api.modelRegistry })

const saved = computed(() => registry.data.value?.bindings.privacy)
const chatOptions = computed(() => flattenProfiles(registry.data.value?.providers ?? [], 'chat'))

const modeItems: { label: string; value: PrivacyBindingMode }[] = [
  { label: '关闭', value: 'off' },
  { label: 'HTTP 识别接口', value: 'http' },
  { label: '已配置对话模型', value: 'model' },
]

const form = reactive<{
  mode: PrivacyBindingMode
  baseUrl: string
  apiKey: string
  clearKey: boolean
  profileIds: string[]
  minScore: number
}>({
  mode: 'off',
  baseUrl: '',
  apiKey: '',
  clearKey: false,
  profileIds: [],
  minScore: 0.6,
})

watch(
  saved,
  (s) => {
    if (!s) return
    form.mode = s.mode
    form.baseUrl = s.baseUrl ?? ''
    form.profileIds = [...s.profileIds]
    form.minScore = s.minScore
  },
  { immediate: true },
)

const keyMissing = computed(
  () =>
    form.mode === 'http' &&
    needsNewKey({
      baseUrl: form.baseUrl,
      savedBaseUrl: saved.value?.baseUrl ?? null,
      hasApiKey: saved.value?.hasApiKey ?? false,
      apiKey: form.apiKey,
      clearKey: form.clearKey,
    }),
)

const dirty = computed(() => {
  if (!saved.value) return false
  return (
    form.mode !== saved.value.mode ||
    form.baseUrl !== (saved.value.baseUrl ?? '') ||
    profileIdsChanged(form.profileIds, saved.value.profileIds) ||
    Math.abs(form.minScore - saved.value.minScore) > 1e-6 ||
    form.apiKey !== '' ||
    form.clearKey
  )
})

const result = ref<ModelChainTestResult | null>(null)
watch(
  dirty,
  (changed) => {
    dirtyModel.value = changed
    if (changed) result.value = null
  },
  { immediate: true },
)

const saving = ref(false)
async function save() {
  if (keyMissing.value) return
  saving.value = true
  try {
    await api.savePrivacyBinding({
      mode: form.mode,
      baseUrl: form.mode === 'http' ? form.baseUrl.trim() || null : null,
      profileIds: form.mode === 'model' ? form.profileIds : [],
      minScore: Number.isFinite(form.minScore)
        ? Math.min(1, Math.max(0, Number(form.minScore)))
        : 0.6,
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
async function test() {
  testing.value = true
  try {
    result.value = await api.testPrivacyBinding()
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
    await api.savePrivacyBinding({ mode: 'off', profileIds: [], minScore: 0.6 })
    form.mode = 'off'
    form.baseUrl = ''
    form.apiKey = ''
    form.clearKey = false
    form.profileIds = []
    form.minScore = 0.6
    result.value = null
    confirmingClear.value = false
    await queryClient.invalidateQueries({ queryKey })
    toast.add({ title: '已清除隐私识别模型', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '清除失败', color: 'error' })
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <SettingsBlock title="隐私识别模型">
    <template #note>
      可选的实体识别模型（本地 HTTP
      服务或已配置对话模型），仅在开启此项的空间中辅助识别人名、住址与私有账号。
      <Hint>
        仅作增量补充：内置的明文凭据与格式明确的个人信息规则始终本地运行；模型识别结果同样支持保护隔离、抹除敏感段与白名单放行。
      </Hint>
    </template>
    <ReadFailureNote v-if="registry.isError.value" :query="registry" />
    <USkeleton v-if="registry.isPending.value" class="h-40 w-full" />
    <form v-else-if="saved" class="space-y-4" @submit.prevent="save">
      <UFormField label="识别方式">
        <USelect v-model="form.mode" :items="modeItems" value-key="value" class="w-full max-w-xs" />
      </UFormField>

      <template v-if="form.mode === 'http'">
        <UFormField label="接口地址" help="兼容 POST /detect，例如 http://127.0.0.1:8080/detect">
          <UInput v-model="form.baseUrl" class="w-full font-mono" required />
        </UFormField>
        <UFormField
          label="API Key"
          :help="
            saved.hasApiKey
              ? '已加密保存；留空表示不修改，更换接口主机时必须重新填写。'
              : '可选，本地服务不需要认证时留空；填写后使用实例主密钥加密保存。'
          "
          :error="keyMissing ? newKeyHint('API Key', true) : undefined"
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
          v-if="saved.hasApiKey"
          v-model="form.clearKey"
          label="清除已保存的 API Key（新接口不需要时）"
        />
      </template>

      <template v-else-if="form.mode === 'model'">
        <UFormField label="对话模型" help="按顺位顺序 Fallback，建议选择响应快的小模型。">
          <ModelChainEditor v-model="form.profileIds" :options="chatOptions" :min="0" />
        </UFormField>
      </template>

      <UFormField
        v-if="form.mode !== 'off'"
        label="最低置信度"
        help="范围 0 到 1，低于该分数的实体结果会被忽略，默认 0.6"
      >
        <UInput
          v-model.number="form.minScore"
          type="number"
          min="0"
          max="1"
          step="0.05"
          class="w-40 font-mono"
        />
      </UFormField>

      <div class="flex flex-wrap items-center gap-2">
        <UButton
          type="submit"
          color="primary"
          variant="outline"
          :loading="saving"
          :disabled="keyMissing"
        >
          保存
        </UButton>
        <UButton
          v-if="form.mode !== 'off' || saved?.configured"
          color="neutral"
          variant="outline"
          :loading="testing"
          :disabled="!saved?.configured || dirty"
          @click="test"
        >
          测试连接
        </UButton>
        <UButton
          v-if="saved?.mode !== 'off' || saved?.configured"
          color="error"
          variant="outline"
          @click="confirmingClear = true"
        >
          清除设置
        </UButton>
        <span v-if="dirty && saved?.configured" class="text-muted">保存改动后才能测试</span>
      </div>

      <ul v-if="result" class="space-y-1 text-sm">
        <li
          v-for="(item, i) in result.results"
          :key="i"
          :class="item.ok ? 'text-success' : 'text-error'"
        >
          <template v-if="item.model">{{ item.model }}：</template>
          {{
            item.ok
              ? `连接正常，耗时 ${item.latencyMs} ms，检出 ${item.findings ?? 0} 处实体`
              : item.error
          }}
        </li>
      </ul>
    </form>
  </SettingsBlock>

  <UModal
    :open="confirmingClear"
    title="清除隐私识别模型设置？"
    :dismissible="!clearing"
    @update:open="(v) => !v && !clearing && (confirmingClear = false)"
  >
    <template #body>
      <p class="text-sm">
        清除后将关闭额外的隐私实体识别，内置的明文凭据与个人信息规则仍继续生效。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="clearing"
          @click="confirmingClear = false"
        >
          取消
        </UButton>
        <UButton color="error" :loading="clearing" @click="clear">清除</UButton>
      </div>
    </template>
  </UModal>
</template>
