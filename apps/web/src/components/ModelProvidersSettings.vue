<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  supportsModelKind,
  type ModelFormat,
  type ModelProfileKind,
  type ModelProfileTestResult,
  type ModelProfileView,
  type ModelProviderView,
  type ThinkingLevel,
  type ThinkingStyle,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { needsNewKey, newKeyHint } from '../endpointKey'
import { icons } from '../icons'
import {
  FORMAT_LABELS,
  FORMAT_OPTIONS,
  THINKING_LABELS,
  THINKING_OPTIONS,
  THINKING_STYLE_OPTIONS,
} from '../models'
import Hint from './Hint.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 服务商编辑弹窗打开且有改动时通知页面
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const registryQuery = useQuery({ queryKey: ['settings', 'models'], queryFn: api.modelRegistry })
const providers = computed(() => registryQuery.data.value?.providers ?? [])

const refreshAll = async () => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['settings', 'models'] }),
    queryClient.invalidateQueries({ queryKey: ['settings', 'embedding'] }),
    queryClient.invalidateQueries({ queryKey: ['instance-system'] }),
  ])
}

// ---- 单个模型条目测试 ----
const testingId = ref<string | null>(null)
const testResults = ref<Record<string, ModelProfileTestResult>>({})

async function testProfile(profileId: string) {
  testingId.value = profileId
  try {
    const res = await api.testModelProfile(profileId)
    testResults.value = { ...testResults.value, [profileId]: res }
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '测试失败', color: 'error' })
  } finally {
    testingId.value = null
  }
}

// ---- 新增 / 编辑服务商弹窗 ----
interface ProfileDraft {
  key: number
  id?: string
  kind: ModelProfileKind
  label: string
  model: string
  thinking: ThinkingLevel
  thinkingStyle: ThinkingStyle
  maxTokens: string | number | undefined
}

let draftSeq = 0
const newProfileDraft = (
  kind: ModelProfileKind = 'chat',
  view?: ModelProfileView,
): ProfileDraft => ({
  key: ++draftSeq,
  ...(view ? { id: view.id } : {}),
  kind: view?.kind ?? kind,
  label: view?.label ?? '',
  model: view?.model ?? '',
  thinking: view?.kind === 'chat' ? view.thinking : 'default',
  thinkingStyle: view?.kind === 'chat' ? view.thinkingStyle : 'auto',
  maxTokens: view?.kind === 'chat' && view.maxTokens != null ? String(view.maxTokens) : '',
})

const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const savedBaseUrl = ref<string | null>(null)
const savedHasKey = ref(false)

const form = reactive<{
  name: string
  format: ModelFormat
  baseUrl: string
  apiKey: string
  clearKey: boolean
  profiles: ProfileDraft[]
}>({
  name: '',
  format: 'openai-chat',
  baseUrl: '',
  apiKey: '',
  clearKey: false,
  profiles: [newProfileDraft('chat')],
})

function openCreate() {
  editingId.value = null
  savedBaseUrl.value = null
  savedHasKey.value = false
  form.name = ''
  form.format = 'openai-chat'
  form.baseUrl = ''
  form.apiKey = ''
  form.clearKey = false
  form.profiles = [newProfileDraft('chat')]
  editorOpen.value = true
}

function openEdit(provider: ModelProviderView) {
  editingId.value = provider.id
  savedBaseUrl.value = provider.baseUrl
  savedHasKey.value = provider.hasApiKey
  form.name = provider.name
  form.format = provider.format
  form.baseUrl = provider.baseUrl
  form.apiKey = ''
  form.clearKey = false
  form.profiles = provider.profiles.map((p) => newProfileDraft(p.kind, p))
  editorOpen.value = true
}

watch(
  () => form.format,
  (fmt) => {
    for (const p of form.profiles) {
      if (!supportsModelKind(fmt, p.kind)) p.kind = 'chat'
    }
  },
)

watch(editorOpen, (open) => {
  dirtyModel.value = open
})

const keyMissing = computed(() =>
  editingId.value
    ? needsNewKey({
        baseUrl: form.baseUrl,
        savedBaseUrl: savedBaseUrl.value,
        hasApiKey: savedHasKey.value,
        apiKey: form.apiKey,
        clearKey: form.clearKey,
      })
    : false,
)

const supportsEmbedding = computed(() => supportsModelKind(form.format, 'embedding'))

function addProfile() {
  form.profiles.push(newProfileDraft('chat'))
}

function removeProfile(index: number) {
  if (form.profiles.length <= 1) return
  form.profiles.splice(index, 1)
}

const saving = ref(false)
async function saveProvider() {
  if (keyMissing.value) return
  saving.value = true
  try {
    const profiles = form.profiles.map((p) => {
      if (p.kind === 'embedding') {
        return {
          ...(p.id ? { id: p.id } : {}),
          kind: 'embedding' as const,
          label: p.label.trim() || null,
          model: p.model.trim(),
        }
      }
      const maxTokensRaw =
        p.maxTokens === null || p.maxTokens === undefined ? '' : String(p.maxTokens).trim()
      const maxTokens = maxTokensRaw === '' ? null : Number(maxTokensRaw)
      return {
        ...(p.id ? { id: p.id } : {}),
        kind: 'chat' as const,
        label: p.label.trim() || null,
        model: p.model.trim(),
        thinking: p.thinking,
        thinkingStyle: form.format === 'openai-chat' ? p.thinkingStyle : ('auto' as const),
        maxTokens,
      }
    })
    const payload = {
      name: form.name.trim(),
      format: form.format,
      baseUrl: form.baseUrl.trim(),
      ...(form.clearKey ? { apiKey: null } : form.apiKey ? { apiKey: form.apiKey } : {}),
      profiles,
    }
    if (editingId.value) {
      await api.updateModelProvider(editingId.value, payload)
    } else {
      await api.createModelProvider(payload)
    }
    editorOpen.value = false
    await refreshAll()
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

// ---- 删除服务商 ----
const deletingTarget = ref<ModelProviderView | null>(null)
const deleting = ref(false)

async function confirmDelete() {
  if (!deletingTarget.value) return
  deleting.value = true
  try {
    await api.deleteModelProvider(deletingTarget.value.id)
    deletingTarget.value = null
    await refreshAll()
    toast.add({ title: '已删除服务商', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '删除失败', color: 'error' })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <SettingsBlock title="模型服务商">
    <template #actions>
      <UButton :icon="icons.add" color="neutral" variant="outline" size="sm" @click="openCreate">
        添加服务商
      </UButton>
    </template>
    <template #note>
      统一管理上游接口地址、API Key 与模型条目，供下方抽取、整理、嵌入与隐私识别选用。
      <Hint>
        API Key
        使用实例主密钥加密保存。同一服务商下可为同一模型添加多条配置，分别设定不同的思考强度。
      </Hint>
    </template>

    <ReadFailureNote v-if="registryQuery.isError.value" :query="registryQuery" />
    <USkeleton v-if="registryQuery.isPending.value" class="h-32 w-full" />

    <div v-else-if="!providers.length" class="border border-default p-4 text-sm text-muted">
      尚未配置模型服务商。点击右上角「添加服务商」开始配置。
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="provider in providers"
        :key="provider.id"
        class="space-y-3 border-t border-default pt-3"
      >
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 space-y-0.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ provider.name }}</span>
              <span class="border border-default px-1.5 py-0.5 text-xs text-muted">{{
                FORMAT_LABELS[provider.format]
              }}</span>
              <span class="text-xs text-muted">{{
                provider.hasApiKey ? '已保存 API Key' : '无 API Key'
              }}</span>
            </div>
            <div class="truncate font-mono text-xs text-muted">{{ provider.baseUrl }}</div>
          </div>
          <div class="flex items-center gap-1">
            <UButton
              :icon="icons.edit"
              color="neutral"
              variant="outline"
              size="xs"
              @click="openEdit(provider)"
            >
              编辑
            </UButton>
            <UButton
              :icon="icons.remove"
              color="neutral"
              variant="outline"
              size="xs"
              @click="deletingTarget = provider"
            >
              删除
            </UButton>
          </div>
        </div>

        <div class="space-y-2 pl-3">
          <div
            v-for="profile in provider.profiles"
            :key="profile.id"
            class="flex flex-wrap items-center justify-between gap-2 border-t border-default pt-2 text-sm"
          >
            <div class="min-w-0 space-y-0.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="border border-default px-1.5 py-0.5 text-xs text-muted">{{
                  profile.kind === 'chat' ? '对话' : '嵌入'
                }}</span>
                <span class="font-mono font-medium">{{ profile.model }}</span>
                <span v-if="profile.label" class="text-muted">{{ profile.label }}</span>
                <span
                  v-if="profile.kind === 'chat' && profile.thinking !== 'default'"
                  class="text-xs text-muted"
                >
                  思考：{{ THINKING_LABELS[profile.thinking] }}
                </span>
                <span
                  v-if="profile.kind === 'chat' && profile.maxTokens"
                  class="text-xs text-muted tabular-nums"
                >
                  上限 {{ profile.maxTokens }}
                </span>
              </div>
              <p
                v-if="testResults[profile.id]"
                class="text-xs"
                :class="testResults[profile.id]!.ok ? 'text-success' : 'text-error'"
              >
                {{
                  testResults[profile.id]!.ok
                    ? `连接正常，耗时 ${testResults[profile.id]!.latencyMs} ms`
                    : testResults[profile.id]!.error
                }}
              </p>
            </div>
            <UButton
              color="neutral"
              variant="outline"
              size="xs"
              :loading="testingId === profile.id"
              @click="testProfile(profile.id)"
            >
              测试连接
            </UButton>
          </div>
        </div>
      </div>
    </div>

    <UModal
      :open="editorOpen"
      :title="editingId ? '编辑模型服务商' : '添加模型服务商'"
      :dismissible="!saving"
      :close="!saving"
      @update:open="(v) => (!v && saving) || (editorOpen = v)"
    >
      <template #body>
        <form id="provider-editor-form" class="space-y-4" @submit.prevent="saveProvider">
          <UFormField label="名称" required>
            <UInput v-model="form.name" placeholder="例如 OpenAI 官方" class="w-full" required />
          </UFormField>
          <UFormField label="接口格式">
            <USelect
              v-model="form.format"
              :items="FORMAT_OPTIONS"
              value-key="value"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="接口地址"
            help="OpenAI 写到 /v1；Anthropic 写到站点或 /v1；Gemini 写到 /v1beta 或站点根；Ollama 写服务根地址。"
            required
          >
            <UInput
              v-model="form.baseUrl"
              placeholder="https://api.example.com/v1"
              class="w-full font-mono"
              required
            />
          </UFormField>
          <UFormField
            label="API Key"
            :help="
              editingId && savedHasKey
                ? '已加密保存；留空表示不修改，更换接口主机时必须重新填写。'
                : '使用实例主密钥加密保存；本地服务不需要时留空。'
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
            v-if="editingId && savedHasKey"
            v-model="form.clearKey"
            label="清除已保存的 API Key（接口不需要时）"
          />

          <div class="space-y-3 border-t border-default pt-3">
            <div class="flex items-center justify-between">
              <span class="font-medium">模型条目</span>
              <UButton
                :icon="icons.add"
                color="neutral"
                variant="outline"
                size="xs"
                @click="addProfile"
              >
                添加模型
              </UButton>
            </div>
            <div
              v-for="(p, idx) in form.profiles"
              :key="p.key"
              class="space-y-2 border-t border-default pt-2"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs text-muted">条目 {{ idx + 1 }}</span>
                <UButton
                  :icon="icons.remove"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="form.profiles.length <= 1"
                  :aria-label="`删除条目 ${idx + 1}`"
                  @click="removeProfile(idx)"
                />
              </div>
              <div class="grid gap-2 sm:grid-cols-2">
                <UFormField label="类型">
                  <USelect
                    v-model="p.kind"
                    :items="[
                      { label: '对话', value: 'chat' },
                      ...(supportsEmbedding ? [{ label: '嵌入', value: 'embedding' }] : []),
                    ]"
                    value-key="value"
                    class="w-full"
                  />
                </UFormField>
                <UFormField label="别名（可选）">
                  <UInput v-model="p.label" placeholder="例如 低思考" class="w-full" />
                </UFormField>
              </div>
              <UFormField label="模型名" required>
                <UInput
                  v-model="p.model"
                  placeholder="例如 gpt-4o-mini"
                  class="w-full font-mono"
                  required
                />
              </UFormField>
              <div v-if="p.kind === 'chat'" class="grid gap-2 sm:grid-cols-2">
                <UFormField label="思考强度">
                  <USelect
                    v-model="p.thinking"
                    :items="THINKING_OPTIONS"
                    value-key="value"
                    class="w-full"
                  />
                </UFormField>
                <UFormField v-if="form.format === 'openai-chat'" label="思考参数风格">
                  <USelect
                    v-model="p.thinkingStyle"
                    :items="THINKING_STYLE_OPTIONS"
                    value-key="value"
                    class="w-full"
                  />
                </UFormField>
                <UFormField label="输出上限（可选）" help="留空则按协议默认">
                  <UInput
                    v-model="p.maxTokens"
                    type="number"
                    min="1"
                    max="1000000"
                    placeholder="默认"
                    class="w-full"
                  />
                </UFormField>
              </div>
            </div>
          </div>
        </form>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" :disabled="saving" @click="editorOpen = false">
          取消
        </UButton>
        <UButton
          type="submit"
          form="provider-editor-form"
          color="primary"
          :loading="saving"
          :disabled="keyMissing"
        >
          保存
        </UButton>
      </template>
    </UModal>

    <UModal
      :open="Boolean(deletingTarget)"
      title="删除模型服务商？"
      :dismissible="!deleting"
      :close="!deleting"
      @update:open="(v) => !v && !deleting && (deletingTarget = null)"
    >
      <template #body>
        <p class="text-sm">
          确定删除「{{
            deletingTarget?.name
          }}」及其全部模型条目？已被嵌入、抽取、整理或隐私识别绑定的服务商无法删除。
        </p>
      </template>
      <template #footer>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="deleting"
          @click="deletingTarget = null"
        >
          取消
        </UButton>
        <UButton color="error" :loading="deleting" @click="confirmDelete">删除</UButton>
      </template>
    </UModal>
  </SettingsBlock>
</template>
