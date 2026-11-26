<script setup lang="ts">
import {
  BUILTIN_ENVS,
  KEY_NAME_MAX,
  KeyName,
  normalizeSlugList,
  SceneSlug,
  type ApiKeyView,
  type IssuedApiKeyResponse,
  type RuntimeFamily,
} from '@kioku/contracts'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useCopy } from '../composables/useCopy'
import { icons } from '../icons'
import { envDisplayName } from '../labels'
import { RUNTIME_OPTIONS } from '../runtimes'
import NoteLine from './ui/NoteLine.vue'

const props = defineProps<{
  editing: ApiKeyView | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [item: ApiKeyView] }>()

const copy = useCopy()

const form = reactive({
  name: '',
  runtimeFamily: 'claudecode' as RuntimeFamily,
  envs: [] as string[],
  restrictRealms: false,
  allowedRealms: [] as string[],
  canWrite: true,
  canResolveCredentials: false,
})
const customEnv = ref('')
const customRealm = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const issued = ref<IssuedApiKeyResponse | null>(null)

watch(open, (visible) => {
  if (!visible) return
  issued.value = null
  error.value = null
  customEnv.value = ''
  customRealm.value = ''
  if (props.editing) {
    form.name = props.editing.name
    form.runtimeFamily = props.editing.runtimeFamily
    form.envs = [...props.editing.envs]
    form.restrictRealms = props.editing.allowedRealms !== null
    form.allowedRealms = [...(props.editing.allowedRealms ?? [])]
    form.canWrite = props.editing.canWrite
    form.canResolveCredentials = props.editing.canResolveCredentials
  } else {
    form.name = ''
    form.runtimeFamily = 'claudecode'
    form.envs = []
    form.restrictRealms = false
    form.allowedRealms = []
    form.canWrite = true
    form.canResolveCredentials = false
  }
})

function toggleEnv(slug: string) {
  form.envs = form.envs.includes(slug)
    ? form.envs.filter((v) => v !== slug)
    : normalizeSlugList([...form.envs, slug])
}

function addEnv() {
  const parsed = SceneSlug.safeParse(customEnv.value)
  if (!parsed.success) return
  if (!form.envs.includes(parsed.data)) form.envs = normalizeSlugList([...form.envs, parsed.data])
  customEnv.value = ''
}

function toggleRealm(slug: string) {
  form.allowedRealms = form.allowedRealms.includes(slug)
    ? form.allowedRealms.filter((v) => v !== slug)
    : normalizeSlugList([...form.allowedRealms, slug])
}

function addRealm() {
  const parsed = SceneSlug.safeParse(customRealm.value)
  if (!parsed.success) return
  if (!form.allowedRealms.includes(parsed.data)) {
    form.allowedRealms = normalizeSlugList([...form.allowedRealms, parsed.data])
  }
  customRealm.value = ''
}

const validationProblem = computed(() => {
  const parsed = KeyName.safeParse(form.name)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? '请填写名称')
})

async function submit() {
  if (saving.value || validationProblem.value) return
  saving.value = true
  error.value = null
  try {
    const allowedRealms = form.restrictRealms ? form.allowedRealms : null
    if (props.editing) {
      const updated = await api.updateKey(props.editing.id, {
        name: form.name.trim(),
        runtimeFamily: form.runtimeFamily,
        envs: form.envs,
        allowedRealms,
        canWrite: form.canWrite,
        canResolveCredentials: form.canResolveCredentials,
      })
      open.value = false
      emit('saved', updated)
    } else {
      const res = await api.createKey({
        name: form.name.trim(),
        runtimeFamily: form.runtimeFamily,
        envs: form.envs,
        allowedRealms,
        canWrite: form.canWrite,
        canResolveCredentials: form.canResolveCredentials,
      })
      issued.value = res
      emit('saved', res.item)
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存失败，请重试'
  } finally {
    saving.value = false
  }
}

function closeOnce() {
  issued.value = null
  open.value = false
}
</script>

<template>
  <!-- 一次性明文访问密钥展示期间禁止遮罩、Esc 或右上角关闭，只能点确认 -->
  <UModal
    :open="open"
    :title="issued ? '访问密钥已签发' : editing ? '编辑访问密钥' : '签发访问密钥'"
    :dismissible="!saving && !issued"
    :close="!issued"
    :ui="{ content: 'max-w-lg sm:max-w-lg' }"
    @update:open="(v) => !v && !saving && !issued && (open = false)"
  >
    <template #body>
      <div v-if="issued" class="space-y-4">
        <NoteLine tone="warning">
          明文访问密钥仅显示这一次，关闭后无法再次查看，请立即复制保存。
        </NoteLine>
        <div class="secret-row">
          <code class="secret-code">{{ issued.key }}</code>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.copy"
            @click="copy(issued.key, '已复制访问密钥')"
          >
            复制
          </UButton>
        </div>
      </div>

      <div v-else class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="名称">
            <UInput
              v-model="form.name"
              placeholder="例如 MacBook Claude Code"
              class="w-full"
              :maxlength="KEY_NAME_MAX"
            />
          </UFormField>
          <UFormField label="客户端类型">
            <USelect
              v-model="form.runtimeFamily"
              :items="RUNTIME_OPTIONS"
              value-key="value"
              class="w-full"
            />
          </UFormField>
        </div>

        <div class="space-y-1.5">
          <p class="text-xs font-medium text-muted">终端环境（用于自动匹配当前系统）</p>
          <div class="flex flex-wrap items-center gap-1.5">
            <UButton
              v-for="slug in normalizeSlugList([...BUILTIN_ENVS, ...form.envs])"
              :key="slug"
              type="button"
              size="xs"
              :color="form.envs.includes(slug) ? 'primary' : 'neutral'"
              :variant="form.envs.includes(slug) ? 'solid' : 'outline'"
              @click="toggleEnv(slug)"
            >
              {{ envDisplayName(slug) }}
            </UButton>
            <UInput
              v-model="customEnv"
              size="xs"
              placeholder="自定义环境"
              class="w-24"
              @keydown.enter.prevent="addEnv"
              @blur="addEnv"
            />
          </div>
        </div>

        <div class="space-y-2">
          <USwitch v-model="form.restrictRealms" label="限定允许访问的场域" />
          <div v-if="form.restrictRealms" class="space-y-1.5 pt-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <UButton
                v-for="slug in normalizeSlugList(['work', 'personal', ...form.allowedRealms])"
                :key="slug"
                type="button"
                size="xs"
                :color="form.allowedRealms.includes(slug) ? 'primary' : 'neutral'"
                :variant="form.allowedRealms.includes(slug) ? 'solid' : 'outline'"
                @click="toggleRealm(slug)"
              >
                {{ slug }}
              </UButton>
              <UInput
                v-model="customRealm"
                size="xs"
                placeholder="新增场域"
                class="w-24"
                @keydown.enter.prevent="addRealm"
                @blur="addRealm"
              />
            </div>
            <p class="text-xs text-muted">留空表示仅可访问未限定场域的通用记忆。</p>
          </div>
        </div>

        <div class="flex flex-wrap gap-6 pt-1">
          <USwitch v-model="form.canWrite" label="允许写入记忆" />
          <USwitch v-model="form.canResolveCredentials" label="允许解析凭据值" />
        </div>

        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-muted">
          {{ !issued && !error && validationProblem ? validationProblem : '' }}
        </span>
        <div class="flex items-center gap-2">
          <UButton v-if="issued" :icon="icons.check" @click="closeOnce">我已保存</UButton>
          <template v-else>
            <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
              取消
            </UButton>
            <UButton
              :icon="icons.check"
              :loading="saving"
              :disabled="Boolean(validationProblem)"
              @click="submit"
            >
              {{ editing ? '保存' : '签发' }}
            </UButton>
          </template>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.secret-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.secret-code {
  min-width: 0;
  flex: 1;
  font-family: var(--font-mono);
  font-size: 13px;
  word-break: break-all;
}
</style>
