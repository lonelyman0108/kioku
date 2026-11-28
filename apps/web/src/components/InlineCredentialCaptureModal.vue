<script setup lang="ts">
import {
  CREDENTIAL_LABEL_MAX,
  CREDENTIAL_TEMPLATES,
  CredentialFieldName,
  CredentialSlug,
  defaultPrimaryFieldForKind,
  normalizeSlugList,
  SceneSlug,
  type CredentialFieldMeta,
  type CredentialKind,
  type CredentialMeta,
  type SecretMatch,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import {
  collectKnownRealms,
  deriveCredentialSlug,
  formatCredentialPlaceholder,
  suggestCapturePreset,
} from '../credentials'
import { icons } from '../icons'
import {
  CREDENTIAL_KIND_ORDER,
  credentialFieldLabel,
  credentialKindIcons,
  credentialKindLabels,
} from '../labels'
import { placeholderOf } from '../placeholders'
import SegmentedChoice from './SegmentedChoice.vue'
import NoteLine from './ui/NoteLine.vue'

export interface InlineCredentialSavedPayload {
  credential: CredentialMeta
  slug: string
  field: string | null
  placeholder: string
}

const props = withDefaults(
  defineProps<{
    initialValue?: string
    initialSlug?: string
    initialLabel?: string
    initialField?: string | null
    initialKind?: CredentialKind
    initialMatch?: SecretMatch | null
    defaultRealms?: readonly string[]
    initialMode?: 'new' | 'append'
    targetCredentialId?: string | null
    lockTarget?: boolean
    preserveDefaultRef?: boolean
    title?: string
    actionLabel?: string
  }>(),
  {
    initialValue: '',
    initialSlug: '',
    initialLabel: '',
    initialField: null,
    initialKind: undefined,
    initialMatch: null,
    defaultRealms: () => [],
    initialMode: 'new',
    targetCredentialId: null,
    lockTarget: false,
    preserveDefaultRef: false,
    title: '转存为托管凭据',
    actionLabel: '保存并替换',
  },
)

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [result: InlineCredentialSavedPayload] }>()

const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()
const hasMasterKey = computed(() => me.data.value?.hasMasterKey ?? true)

// 仅查询凭据元数据用于重名校验与附加字段选择，绝不缓存明文
const credentialsQuery = useQuery({
  queryKey: ['credentials'] as const,
  queryFn: () => api.credentials(),
  enabled: open,
})
const existingItems = computed(() => credentialsQuery.data.value?.items ?? [])
const existingSlugs = computed(() => existingItems.value.map((item) => item.slug))
const knownRealms = computed(() => collectKnownRealms(existingItems.value, [], props.defaultRealms))

const MODE_OPTIONS: { value: 'new' | 'append'; label: string; icon: string }[] = [
  { value: 'new', label: '新建凭据', icon: icons.add },
  { value: 'append', label: '附加到已有凭据', icon: icons.listPlus },
]

const SCOPE_OPTIONS: { value: 'scoped' | 'unscoped'; label: string }[] = [
  { value: 'scoped', label: '限定场域' },
  { value: 'unscoped', label: '不限场域' },
]

const KIND_OPTIONS = CREDENTIAL_KIND_ORDER.map((kind) => ({
  label: credentialKindLabels[kind],
  value: kind,
  icon: credentialKindIcons[kind],
}))

const form = reactive({
  mode: 'new' as 'new' | 'append',
  kind: 'secret' as CredentialKind,
  label: '',
  slug: '',
  slugTouched: false,
  targetCredentialId: '',
  fieldName: 'value',
  fieldTouched: false,
  value: '',
  secret: true,
  multiline: false,
  showPlain: false,
  scopeMode: 'scoped' as 'scoped' | 'unscoped',
  allowedRealms: [] as string[],
})
const customRealm = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

function clearSensitiveDraft() {
  form.value = ''
  form.showPlain = false
  error.value = null
}

function hydrateDraft() {
  const preset = suggestCapturePreset(props.initialMatch, props.initialValue, existingSlugs.value)
  const resolvedKind = props.initialKind ?? preset.kind
  const resolvedField =
    props.initialField?.trim() ||
    (props.initialKind ? defaultPrimaryFieldForKind(props.initialKind) : preset.field)
  const resolvedSlug = props.initialSlug.trim().toLowerCase() || preset.slug
  const resolvedLabel = props.initialLabel.trim() || preset.label

  const matchingBySlug = resolvedSlug
    ? existingItems.value.find((item) => item.slug === resolvedSlug)
    : null
  const matchingById = props.targetCredentialId
    ? existingItems.value.find((item) => item.id === props.targetCredentialId)
    : null
  const target = matchingById ?? matchingBySlug ?? existingItems.value[0] ?? null

  const wantAppend =
    (props.initialMode === 'append' || Boolean(props.targetCredentialId)) && Boolean(target)
  form.mode = wantAppend ? 'append' : 'new'
  form.kind = resolvedKind
  form.label = resolvedLabel
  form.slug = resolvedSlug
  form.slugTouched = Boolean(resolvedSlug)
  form.targetCredentialId = target?.id ?? ''
  form.fieldName = resolvedField
  form.fieldTouched = Boolean(props.initialField)
  form.value = props.initialValue
  form.secret = true
  form.multiline =
    preset.multiline ||
    resolvedField === 'private_key' ||
    resolvedField === 'recovery_codes' ||
    resolvedField === 'public_key' ||
    props.initialValue.includes('\n')
  form.showPlain = false

  const inheritedRealms = normalizeSlugList(props.defaultRealms)
  if (inheritedRealms.length > 0) {
    form.scopeMode = 'scoped'
    form.allowedRealms = inheritedRealms
  } else {
    form.scopeMode = 'unscoped'
    form.allowedRealms = []
  }
  customRealm.value = ''
  error.value = null
}

watch(
  open,
  (visible) => {
    if (visible) {
      hydrateDraft()
    } else {
      clearSensitiveDraft()
    }
  },
  { immediate: true },
)

// 凭据列表就绪后，若预设为附加模式或目标缺失，补齐目标选择
watch(existingItems, (items) => {
  if (!open.value || !items.length) return
  if (!form.targetCredentialId) {
    const matched =
      (props.targetCredentialId && items.find((i) => i.id === props.targetCredentialId)) ||
      (form.slug && items.find((i) => i.slug === form.slug)) ||
      items[0]
    if (matched) form.targetCredentialId = matched.id
  }
  if (props.initialMode === 'append' && form.mode === 'new' && form.targetCredentialId) {
    form.mode = 'append'
  }
})

onBeforeUnmount(clearSensitiveDraft)

const targetCredential = computed(
  () => existingItems.value.find((item) => item.id === form.targetCredentialId) ?? null,
)

const targetCredentialOptions = computed(() =>
  existingItems.value.map((item) => ({
    label: `${item.label}（${item.slug}）`,
    value: item.id,
  })),
)

const slugCollision = computed(() => {
  if (form.mode !== 'new') return null
  const clean = form.slug.trim().toLowerCase()
  if (!clean) return null
  return existingItems.value.find((item) => item.slug === clean) ?? null
})

const overwriteWarning = computed(() => {
  if (form.mode !== 'append' || !targetCredential.value) return false
  const cleanField = form.fieldName.trim().toLowerCase()
  if (!cleanField) return false
  return targetCredential.value.fieldMeta.some((f) => f.name === cleanField)
})

function onLabelInput(val: string) {
  form.label = val
  if (!form.slugTouched && !props.lockTarget) {
    form.slug = deriveCredentialSlug(val)
  }
}

function onSlugInput(val: string) {
  form.slug = val
  form.slugTouched = val.trim().length > 0
}

function onKindChange(nextKind: CredentialKind) {
  form.kind = nextKind
  if (!form.fieldTouched && !props.lockTarget) {
    const primary = defaultPrimaryFieldForKind(nextKind)
    form.fieldName = primary
    const tplField = CREDENTIAL_TEMPLATES[nextKind].fields.find((f) => f.name === primary)
    if (tplField) {
      form.secret = tplField.secret
      form.multiline = Boolean(tplField.multiline) || form.value.includes('\n')
    }
  }
}

function switchToAppendExisting(cred: CredentialMeta) {
  form.mode = 'append'
  form.targetCredentialId = cred.id
  error.value = null
}

function toggleRealm(realm: string) {
  form.allowedRealms = form.allowedRealms.includes(realm)
    ? form.allowedRealms.filter((r) => r !== realm)
    : normalizeSlugList([...form.allowedRealms, realm])
}

function addCustomRealm() {
  const parsed = SceneSlug.safeParse(customRealm.value)
  if (!parsed.success) return
  if (!form.allowedRealms.includes(parsed.data)) {
    form.allowedRealms = normalizeSlugList([...form.allowedRealms, parsed.data])
  }
  customRealm.value = ''
}

const placeholderPreview = computed(() => {
  const field = form.fieldName.trim().toLowerCase()
  if (form.mode === 'append') {
    const slug = targetCredential.value?.slug ?? 'slug'
    if (targetCredential.value && (!field || field === targetCredential.value.primaryField)) {
      return props.lockTarget && props.initialField
        ? placeholderOf(slug, field)
        : placeholderOf(slug)
    }
    return placeholderOf(slug, field || null)
  }
  const slug = form.slug.trim().toLowerCase() || 'slug'
  if (props.preserveDefaultRef) return placeholderOf(slug)
  if (props.lockTarget && props.initialField) return placeholderOf(slug, field || null)
  return placeholderOf(slug)
})

const validationProblem = computed(() => {
  if (!hasMasterKey.value) return '未配置主密钥 KIOKU_MASTER_KEY，无法创建加密凭据'
  const fieldCheck = CredentialFieldName.safeParse(form.fieldName)
  if (!fieldCheck.success) return fieldCheck.error.issues[0]?.message ?? '字段名格式有误'
  if (!form.value) return '请填写凭据值'

  if (form.mode === 'new') {
    const slugCheck = CredentialSlug.safeParse(form.slug)
    if (!slugCheck.success) return slugCheck.error.issues[0]?.message ?? '标识格式有误'
    if (slugCollision.value) return `凭据标识 ${slugCollision.value.slug} 已存在`
    if (!form.label.trim()) return '请填写凭据名称'
    if (form.scopeMode === 'scoped' && !form.allowedRealms.length) {
      return '请至少选择一个允许场域，或切换为不限场域'
    }
  } else if (!targetCredential.value) {
    return '请选择目标凭据'
  }
  return null
})

async function save() {
  if (saving.value || validationProblem.value) return
  saving.value = true
  error.value = null
  const cleanField = form.fieldName.trim().toLowerCase()
  const isMultiline = form.multiline || form.value.includes('\n')

  try {
    if (form.mode === 'new') {
      const cleanSlug = form.slug.trim().toLowerCase()
      const fieldMeta: CredentialFieldMeta[] = [
        {
          name: cleanField,
          label: credentialFieldLabel(form.kind, cleanField),
          secret: form.secret,
          ...(isMultiline ? { multiline: true } : {}),
        },
      ]
      const saved = await api.createCredential({
        slug: cleanSlug,
        label: form.label.trim(),
        kind: form.kind,
        primaryField: cleanField,
        fieldMeta,
        fields: { [cleanField]: form.value },
        allowedRealms: form.scopeMode === 'scoped' ? [...form.allowedRealms] : null,
      })
      await queryClient.invalidateQueries({ queryKey: ['credentials'] })
      const placeholder =
        props.lockTarget && props.initialField
          ? placeholderOf(saved.slug, cleanField)
          : props.preserveDefaultRef
            ? placeholderOf(saved.slug)
            : formatCredentialPlaceholder(saved, cleanField)
      clearSensitiveDraft()
      open.value = false
      toast.add({ title: `已保存凭据 ${saved.slug}`, color: 'success' })
      emit('saved', {
        credential: saved,
        slug: saved.slug,
        field: placeholder.includes('#') ? cleanField : null,
        placeholder,
      })
      return
    }

    const target = targetCredential.value
    if (!target) return
    const nextMeta: CredentialFieldMeta[] = [...target.fieldMeta]
    const existingIdx = nextMeta.findIndex((f) => f.name === cleanField)
    const entryMeta: CredentialFieldMeta = {
      name: cleanField,
      label: credentialFieldLabel(target.kind, cleanField, nextMeta[existingIdx]?.label),
      secret: form.secret,
      ...(isMultiline ? { multiline: true } : {}),
    }
    if (existingIdx >= 0) nextMeta[existingIdx] = entryMeta
    else nextMeta.push(entryMeta)

    const saved = await api.updateCredential(target.id, {
      fields: { [cleanField]: form.value },
      fieldMeta: nextMeta,
    })
    await queryClient.invalidateQueries({ queryKey: ['credentials'] })
    const placeholder =
      props.lockTarget && props.initialField
        ? placeholderOf(saved.slug, cleanField)
        : formatCredentialPlaceholder(saved, cleanField)
    clearSensitiveDraft()
    open.value = false
    toast.add({ title: `已更新凭据 ${saved.slug}#${cleanField}`, color: 'success' })
    emit('saved', {
      credential: saved,
      slug: saved.slug,
      field: placeholder.includes('#') ? cleanField : null,
      placeholder,
    })
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存凭据失败，请重试'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="title"
    :dismissible="!saving"
    :close="!saving"
    :ui="{ content: 'max-w-xl sm:max-w-xl' }"
    @update:open="(v) => !saving && (open = v)"
  >
    <template #title>
      <span class="modal-title">
        <UIcon :name="icons.shieldCheck" class="modal-title-icon" aria-hidden="true" />
        <span>{{ title }}</span>
      </span>
    </template>

    <template #body>
      <div class="space-y-4">
        <NoteLine v-if="!hasMasterKey" tone="warning" flush>
          未配置主密钥 KIOKU_MASTER_KEY，无法创建或更新加密凭据。
        </NoteLine>

        <SegmentedChoice
          v-if="!lockTarget && existingItems.length > 0"
          v-model="form.mode"
          :items="MODE_OPTIONS"
          label="凭据保存方式"
          compact
        />

        <template v-if="form.mode === 'new'">
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField label="名称" required>
              <UInput
                :model-value="form.label"
                :maxlength="CREDENTIAL_LABEL_MAX"
                placeholder="例如：生产数据库连接"
                class="w-full"
                @update:model-value="(v) => onLabelInput(String(v ?? ''))"
              />
            </UFormField>
            <UFormField label="标识" required>
              <UInput
                :model-value="form.slug"
                :disabled="lockTarget && Boolean(initialSlug)"
                maxlength="64"
                placeholder="例如：prod-db"
                class="w-full font-mono"
                autocomplete="off"
                spellcheck="false"
                @update:model-value="(v) => onSlugInput(String(v ?? ''))"
              />
            </UFormField>
          </div>

          <NoteLine v-if="slugCollision" tone="warning" flush>
            已存在标识为 <code class="font-mono">{{ slugCollision.slug }}</code> 的凭据（{{
              slugCollision.label
            }}），可改换标识或直接作为新字段附加。
            <template #actions>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.listPlus"
                @click="switchToAppendExisting(slugCollision)"
              >
                附加到此凭据
              </UButton>
            </template>
          </NoteLine>

          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField label="凭据类型">
              <USelect
                :model-value="form.kind"
                :items="KIND_OPTIONS"
                value-key="value"
                class="w-full"
                @update:model-value="(v) => onKindChange(String(v) as CredentialKind)"
              />
            </UFormField>
            <UFormField label="字段名" required>
              <UInput
                v-model="form.fieldName"
                :disabled="lockTarget && Boolean(initialField)"
                maxlength="64"
                placeholder="例如：token / password / url / value"
                class="w-full font-mono"
                autocomplete="off"
                spellcheck="false"
                @update:model-value="form.fieldTouched = true"
              />
            </UFormField>
          </div>

          <div class="space-y-2">
            <div class="scope-row">
              <span class="field-caption">允许场域</span>
              <SegmentedChoice
                v-model="form.scopeMode"
                :items="SCOPE_OPTIONS"
                label="允许场域策略"
                compact
              />
            </div>

            <div v-if="form.scopeMode === 'scoped'" class="realm-picker">
              <button
                v-for="realm in knownRealms"
                :key="realm"
                type="button"
                class="realm-chip font-mono"
                :class="{ 'is-active': form.allowedRealms.includes(realm) }"
                :aria-pressed="form.allowedRealms.includes(realm)"
                @click="toggleRealm(realm)"
              >
                <UIcon
                  :name="form.allowedRealms.includes(realm) ? icons.check : icons.realm"
                  class="chip-icon"
                  aria-hidden="true"
                />
                <span>{{ realm }}</span>
              </button>
              <UInput
                v-model="customRealm"
                size="xs"
                placeholder="新增场域"
                class="w-24"
                @keydown.enter.prevent="addCustomRealm"
                @blur="addCustomRealm"
              />
            </div>
            <p class="text-xs text-muted">
              {{
                form.scopeMode === 'scoped'
                  ? '仅允许访问所选场域且开启凭据解析权限的访问密钥可用。'
                  : '仅未限定场域且开启凭据解析权限的访问密钥可用。'
              }}
            </p>
          </div>
        </template>

        <template v-else>
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField label="目标凭据" required>
              <USelect
                v-model="form.targetCredentialId"
                :items="targetCredentialOptions"
                value-key="value"
                :disabled="lockTarget && Boolean(targetCredentialId)"
                class="w-full"
              />
            </UFormField>
            <UFormField label="字段名" required>
              <UInput
                v-model="form.fieldName"
                :disabled="lockTarget && Boolean(initialField)"
                maxlength="64"
                placeholder="例如：password / api_secret"
                class="w-full font-mono"
                autocomplete="off"
                spellcheck="false"
              />
            </UFormField>
          </div>

          <NoteLine v-if="overwriteWarning" tone="warning" flush>
            目标凭据已包含字段 <code class="font-mono">{{ form.fieldName }}</code
            >，保存后将覆盖该字段的当前值。
          </NoteLine>
        </template>

        <div class="space-y-1.5">
          <div class="value-head">
            <label for="inline-capture-value" class="field-caption">凭据值</label>
            <label class="inline-check">
              <input v-model="form.secret" type="checkbox" />
              <span>机密字段（默认隐藏）</span>
            </label>
          </div>
          <UTextarea
            v-if="form.multiline"
            id="inline-capture-value"
            v-model="form.value"
            :rows="4"
            placeholder="输入需加密托管的值"
            class="w-full font-mono"
            autocomplete="off"
            spellcheck="false"
          />
          <div v-else class="value-input-row">
            <UInput
              id="inline-capture-value"
              v-model="form.value"
              :type="form.secret && !form.showPlain ? 'password' : 'text'"
              placeholder="输入需加密托管的值"
              class="flex-1 font-mono"
              autocomplete="off"
              spellcheck="false"
            />
            <UButton
              v-if="form.secret"
              size="xs"
              color="neutral"
              variant="outline"
              :icon="form.showPlain ? icons.hide : icons.reveal"
              class="shrink-0 whitespace-nowrap"
              @click="form.showPlain = !form.showPlain"
            >
              {{ form.showPlain ? '隐藏' : '显示' }}
            </UButton>
          </div>
          <p class="text-xs text-muted">所有字段值均加密存储，关闭弹窗后自动清空输入缓存。</p>
        </div>

        <NoteLine tone="success" flush :icon="icons.checkCircle">
          保存后将使用占位符 <code class="font-mono">{{ placeholderPreview }}</code
          >，当前草稿完整保留。
        </NoteLine>

        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
      </div>
    </template>

    <template #footer>
      <div class="foot-row">
        <span class="text-xs text-muted">{{
          !error && validationProblem ? validationProblem : ''
        }}</span>
        <div class="foot-actions">
          <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
            取消
          </UButton>
          <UButton
            :icon="icons.check"
            :loading="saving"
            :disabled="Boolean(validationProblem)"
            @click="save"
          >
            {{ actionLabel }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.modal-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.modal-title-icon {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--ui-text-muted);
}
.field-caption {
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.scope-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.realm-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.realm-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.realm-chip:hover {
  border-color: var(--ui-rule);
  background: var(--ui-bg-elevated);
}
.realm-chip.is-active {
  border-color: var(--ui-rule);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.chip-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.value-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.inline-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.value-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.foot-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}
.foot-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
