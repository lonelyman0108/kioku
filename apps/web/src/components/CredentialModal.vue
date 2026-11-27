<script setup lang="ts">
import {
  CREDENTIAL_DESCRIPTION_MAX,
  CREDENTIAL_LABEL_MAX,
  CredentialSlug,
  normalizeSlugList,
  SceneSlug,
  type CredentialMeta,
} from '@kioku/contracts'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'

const props = defineProps<{
  editing: CredentialMeta | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [credential: CredentialMeta] }>()

const form = reactive({
  slug: '',
  label: '',
  description: '',
  value: '',
})
const restrictRealms = ref(false)
const allowedRealms = ref<string[]>([])
const customRealm = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

watch(open, (visible) => {
  if (!visible) return
  if (props.editing) {
    form.slug = props.editing.slug
    form.label = props.editing.label
    form.description = props.editing.description ?? ''
    form.value = ''
    restrictRealms.value = props.editing.allowedRealms !== null
    allowedRealms.value = [...(props.editing.allowedRealms ?? [])]
  } else {
    form.slug = ''
    form.label = ''
    form.description = ''
    form.value = ''
    restrictRealms.value = false
    allowedRealms.value = []
  }
  customRealm.value = ''
  error.value = null
})

function addRealm() {
  const parsed = SceneSlug.safeParse(customRealm.value)
  if (!parsed.success) return
  if (!allowedRealms.value.includes(parsed.data)) {
    allowedRealms.value = normalizeSlugList([...allowedRealms.value, parsed.data])
  }
  customRealm.value = ''
}

function toggleRealm(slug: string) {
  allowedRealms.value = allowedRealms.value.includes(slug)
    ? allowedRealms.value.filter((v) => v !== slug)
    : normalizeSlugList([...allowedRealms.value, slug])
}

const validationProblem = computed(() => {
  if (!props.editing) {
    const slugCheck = CredentialSlug.safeParse(form.slug)
    if (!slugCheck.success) return slugCheck.error.issues[0]?.message ?? '标识格式有误'
  }
  if (!form.label.trim()) return '请填写名称'
  if (!props.editing && !form.value) return '请填写凭据值'
  return null
})

async function save() {
  if (saving.value || validationProblem.value) return
  saving.value = true
  error.value = null
  try {
    const realms = restrictRealms.value ? allowedRealms.value : null
    const saved = props.editing
      ? await api.updateCredential(props.editing.id, {
          label: form.label.trim(),
          description: form.description.trim() || null,
          ...(form.value ? { value: form.value } : {}),
          allowedRealms: realms,
        })
      : await api.createCredential({
          slug: form.slug.trim().toLowerCase(),
          label: form.label.trim(),
          description: form.description.trim() || null,
          value: form.value,
          allowedRealms: realms,
        })
    open.value = false
    emit('saved', saved)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存失败，请重试'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="editing ? `编辑凭据 ${editing.slug}` : '新建凭据'"
    :dismissible="!saving"
    :close="!saving"
    :ui="{ content: 'max-w-lg sm:max-w-lg' }"
    @update:open="(v) => !saving && (open = v)"
  >
    <template #body>
      <div class="space-y-4">
        <UFormField
          v-if="!editing"
          label="标识"
          help="正文里写成 {{cred:标识}}；创建后不可更改，小写字母、数字和 ._-"
        >
          <UInput
            v-model="form.slug"
            placeholder="例如 prod-db-url"
            class="w-full font-mono"
            autocomplete="off"
            spellcheck="false"
            maxlength="64"
          />
        </UFormField>

        <UFormField label="名称">
          <UInput
            v-model="form.label"
            placeholder="例如 生产数据库连接串"
            class="w-full"
            :maxlength="CREDENTIAL_LABEL_MAX"
          />
        </UFormField>

        <UFormField label="说明（可选）" help="便于 Agent 判断何时引用，不含敏感值">
          <UTextarea
            v-model="form.description"
            :rows="2"
            :maxlength="CREDENTIAL_DESCRIPTION_MAX"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="editing ? '新的凭据值（留空则保持不变）' : '凭据值'">
          <UTextarea
            v-model="form.value"
            :rows="3"
            class="w-full font-mono"
            autocomplete="off"
            spellcheck="false"
          />
        </UFormField>

        <div class="space-y-2">
          <USwitch v-model="restrictRealms" label="限定允许取值的场域" />
          <div v-if="restrictRealms" class="space-y-2 pt-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <UButton
                v-for="r in normalizeSlugList(['work', 'personal', ...allowedRealms])"
                :key="r"
                type="button"
                size="xs"
                :color="allowedRealms.includes(r) ? 'primary' : 'neutral'"
                :variant="allowedRealms.includes(r) ? 'solid' : 'outline'"
                @click="toggleRealm(r)"
              >
                {{ r }}
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
            <p class="text-xs text-muted">
              只有允许场域包含至少一项重叠的访问密钥才可通过命令行解析此凭据。
            </p>
          </div>
        </div>

        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-muted">{{
          !error && validationProblem ? validationProblem : ''
        }}</span>
        <div class="flex items-center gap-2">
          <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
            取消
          </UButton>
          <UButton
            :icon="icons.check"
            :loading="saving"
            :disabled="Boolean(validationProblem)"
            @click="save"
          >
            {{ editing ? '保存' : '创建' }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
