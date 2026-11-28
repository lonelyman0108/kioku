<script setup lang="ts">
import {
  CREDENTIAL_DESCRIPTION_MAX,
  CREDENTIAL_FIELDS_MAX,
  CREDENTIAL_LABEL_MAX,
  CredentialFieldName,
  CredentialSlug,
  defaultFieldMetaForKind,
  defaultPrimaryFieldForKind,
  normalizeSlugList,
  SceneSlug,
  type ApiKeyView,
  type CredentialFieldMeta,
  type CredentialKind,
  type CredentialMeta,
  type CredentialReferenceItem,
  type UpdateCredentialRequest,
} from '@kioku/contracts'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { confirmDiscard, hasUnsavedChanges } from '../composables/unsavedChanges'
import { useCopy } from '../composables/useCopy'
import {
  applyRevealedValuesToEditRows,
  buildCredentialUpdateFields,
  canKeyAccessCredential,
  deriveCredentialSlug,
  formatCredentialPlaceholder,
  validateCredentialEditRows,
  type EditableCredentialFieldRow,
} from '../credentials'
import { icons } from '../icons'
import {
  CREDENTIAL_KIND_ORDER,
  credentialFieldLabel,
  credentialKindIcons,
  credentialKindLabels,
} from '../labels'
import { placeholderOf } from '../placeholders'
import { formatRelative, formatTime } from '../time'
import CredentialReadRail from './CredentialReadRail.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import NoteLine from './ui/NoteLine.vue'
import SaveBar, { type SaveBarChange } from './ui/SaveBar.vue'
import SectionHeading from './ui/SectionHeading.vue'

interface FormFieldRow extends EditableCredentialFieldRow {
  uid: string
  showPlain: boolean
}

const props = withDefaults(
  defineProps<{
    mode: 'read' | 'edit' | 'new'
    credential: CredentialMeta | null
    initialKind?: CredentialKind
    hasMasterKey: boolean
    knownRealms: readonly string[]
    apiKeys: readonly ApiKeyView[]
    references: readonly CredentialReferenceItem[]
    referencesLoading?: boolean
    referencesError?: boolean
    showBack?: boolean
  }>(),
  {
    initialKind: 'secret',
    referencesLoading: false,
    referencesError: false,
    showBack: false,
  },
)

const emit = defineEmits<{
  enterEdit: []
  cancelForm: []
  saved: [credential: CredentialMeta, isNew: boolean]
  updated: [credential: CredentialMeta]
  requestDelete: []
  back: []
  dirtyChange: [dirty: boolean]
}>()

const toast = useToast()
const copy = useCopy()

// 明文与已显露机密严格只放组件局部 ref，切换凭据或卸载立即清空，绝不进查询缓存
const plainValues = ref<Record<string, string>>({})
const revealedSecrets = ref<Record<string, string>>({})
const plainLoading = ref(false)
const plainLoadFailed = ref(false)
const formLoadingSecrets = ref(false)
const revealingFields = ref<Record<string, boolean>>({})
const revealingAll = ref(false)
const copyingField = ref<string | null>(null)
const revealError = ref<string | null>(null)
let revealSeq = 0
let secretRevealSeq = 0
let copySeq = 0

function clearLocalSecrets() {
  revealSeq++
  secretRevealSeq++
  copySeq++
  plainValues.value = {}
  revealedSecrets.value = {}
  plainLoading.value = false
  plainLoadFailed.value = false
  revealingFields.value = {}
  revealingAll.value = false
  copyingField.value = null
  formLoadingSecrets.value = false
  revealError.value = null
}

// 点选复制 slug 反馈
const slugCopied = ref(false)
let slugCopyTimer: ReturnType<typeof setTimeout> | null = null
async function copySlug() {
  if (!props.credential) return
  const ok = await copy(props.credential.slug)
  if (!ok) return
  slugCopied.value = true
  if (slugCopyTimer) clearTimeout(slugCopyTimer)
  slugCopyTimer = setTimeout(() => {
    slugCopied.value = false
    slugCopyTimer = null
  }, 1600)
}

// 阅读态展示的字段元数据
const displayFields = computed<readonly CredentialFieldMeta[]>(() => {
  const cred = props.credential
  if (!cred) return []
  if (cred.fieldMeta.length) return cred.fieldMeta
  return [{ name: cred.primaryField || 'value', secret: true }]
})

const secretFieldList = computed(() => displayFields.value.filter((f) => f.secret))
const hasPlainFields = computed(() => displayFields.value.some((f) => !f.secret))
const allSecretsShown = computed(
  () =>
    secretFieldList.value.length > 0 &&
    secretFieldList.value.every((f) => Object.hasOwn(revealedSecrets.value, f.name)),
)

async function loadPlainFieldsFor(cred: CredentialMeta) {
  if (!props.hasMasterKey) return
  const hasPlain = cred.fieldMeta.some((f) => !f.secret)
  if (!hasPlain) return
  const seq = ++revealSeq
  plainLoading.value = true
  revealError.value = null
  try {
    const res = await api.revealCredential(cred.id, { scope: 'plain' })
    if (seq !== revealSeq) return
    plainValues.value = { ...(res.fields ?? {}) }
  } catch (err) {
    if (seq !== revealSeq) return
    revealError.value = err instanceof ApiError ? err.message : '读取非敏感字段失败'
  } finally {
    if (seq === revealSeq) plainLoading.value = false
  }
}

async function toggleSecretField(fieldName: string) {
  const cred = props.credential
  if (!cred || !props.hasMasterKey) return
  if (Object.hasOwn(revealedSecrets.value, fieldName)) {
    secretRevealSeq++
    const next = { ...revealedSecrets.value }
    delete next[fieldName]
    revealedSecrets.value = next
    if (revealingFields.value[fieldName]) {
      const nextLoading = { ...revealingFields.value }
      delete nextLoading[fieldName]
      revealingFields.value = nextLoading
    }
    return
  }
  if (revealingFields.value[fieldName]) return
  const rSeq = revealSeq
  const sSeq = secretRevealSeq
  revealingFields.value = { ...revealingFields.value, [fieldName]: true }
  revealError.value = null
  try {
    const res = await api.revealCredential(cred.id, { field: fieldName })
    if (rSeq !== revealSeq || sSeq !== secretRevealSeq) return
    if (res.value !== undefined) {
      revealedSecrets.value = { ...revealedSecrets.value, [fieldName]: res.value }
    }
  } catch (err) {
    if (rSeq !== revealSeq || sSeq !== secretRevealSeq) return
    revealError.value = err instanceof ApiError ? err.message : '读取机密字段失败'
  } finally {
    if (rSeq === revealSeq && sSeq === secretRevealSeq && revealingFields.value[fieldName]) {
      const nextLoading = { ...revealingFields.value }
      delete nextLoading[fieldName]
      revealingFields.value = nextLoading
    }
  }
}

async function toggleAllSecrets() {
  const cred = props.credential
  if (!cred || !props.hasMasterKey) return
  if (allSecretsShown.value) {
    secretRevealSeq++
    revealedSecrets.value = {}
    revealingFields.value = {}
    revealingAll.value = false
    return
  }
  if (revealingAll.value) return
  const rSeq = revealSeq
  const sSeq = secretRevealSeq
  revealingAll.value = true
  revealError.value = null
  try {
    const res = await api.revealCredential(cred.id, { scope: 'all' })
    if (rSeq !== revealSeq || sSeq !== secretRevealSeq) return
    const next: Record<string, string> = {}
    const all = res.fields ?? {}
    for (const f of secretFieldList.value) {
      if (Object.hasOwn(all, f.name)) next[f.name] = all[f.name]!
    }
    revealedSecrets.value = next
  } catch (err) {
    if (rSeq !== revealSeq || sSeq !== secretRevealSeq) return
    revealError.value = err instanceof ApiError ? err.message : '读取机密字段失败'
  } finally {
    if (rSeq === revealSeq && sSeq === secretRevealSeq) revealingAll.value = false
  }
}

// 盲复制：未展开的机密字段直接按需取值并写入剪贴板，绝不把明文写进组件响应状态
async function copyFieldValue(field: CredentialFieldMeta) {
  const cred = props.credential
  if (!cred || !props.hasMasterKey) return
  const rSeq = revealSeq
  const cSeq = ++copySeq
  if (!field.secret && Object.hasOwn(plainValues.value, field.name)) {
    copyingField.value = null
    await copy(plainValues.value[field.name]!)
    return
  }
  if (field.secret && Object.hasOwn(revealedSecrets.value, field.name)) {
    copyingField.value = null
    await copy(revealedSecrets.value[field.name]!)
    return
  }
  copyingField.value = field.name
  revealError.value = null
  try {
    const res = await api.revealCredential(cred.id, { field: field.name })
    if (rSeq !== revealSeq || cSeq !== copySeq) return
    if (res.value !== undefined) {
      await copy(res.value)
    }
  } catch (err) {
    if (rSeq !== revealSeq || cSeq !== copySeq) return
    revealError.value = err instanceof ApiError ? err.message : '复制字段值失败'
  } finally {
    if (cSeq === copySeq) copyingField.value = null
  }
}

function copyFieldRef(fieldName: string) {
  if (!props.credential) return
  void copy(formatCredentialPlaceholder(props.credential, fieldName))
}

// 阅读态行内允许场域直改 Popover
const scopePopoverOpen = ref(false)
const scopeSaving = ref(false)
const scopeDraft = reactive({
  scoped: false,
  allowedRealms: [] as string[],
})
const scopeCustomRealm = ref('')

watch(scopePopoverOpen, (visible) => {
  const cred = props.credential
  if (!visible || !cred) return
  scopeDraft.scoped = cred.allowedRealms !== null
  scopeDraft.allowedRealms = [...(cred.allowedRealms ?? [])]
  scopeCustomRealm.value = ''
})

function sameRealms(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return normalizeSlugList(a).join('\n') === normalizeSlugList(b).join('\n')
}

const inlineScopeLabel = computed(() => {
  const cred = props.credential
  if (!cred) return '不限场域'
  if (cred.allowedRealms === null) return '不限场域'
  if (!cred.allowedRealms.length) return '仅无场域'
  return `限定场域：${cred.allowedRealms.join('、')}`
})

const scopeDraftPreviewRealms = computed(() =>
  scopeDraft.scoped ? normalizeSlugList(scopeDraft.allowedRealms) : null,
)
const scopeDraftDirty = computed(() => {
  if (!props.credential) return false
  return !sameRealms(scopeDraftPreviewRealms.value, props.credential.allowedRealms)
})
const scopeDraftInvalid = computed(() => scopeDraft.scoped && scopeDraft.allowedRealms.length === 0)
const scopeDraftMatchedKeyCount = computed(
  () =>
    props.apiKeys.filter((k) =>
      canKeyAccessCredential(k, { allowedRealms: scopeDraftPreviewRealms.value }),
    ).length,
)

function toggleScopeDraftRealm(realm: string) {
  scopeDraft.allowedRealms = scopeDraft.allowedRealms.includes(realm)
    ? scopeDraft.allowedRealms.filter((r) => r !== realm)
    : normalizeSlugList([...scopeDraft.allowedRealms, realm])
}

function addScopeDraftRealm() {
  const parsed = SceneSlug.safeParse(scopeCustomRealm.value)
  if (!parsed.success) return
  if (!scopeDraft.allowedRealms.includes(parsed.data)) {
    scopeDraft.allowedRealms = normalizeSlugList([...scopeDraft.allowedRealms, parsed.data])
  }
  scopeCustomRealm.value = ''
}

async function applyScopeDraft() {
  const cred = props.credential
  if (!cred || scopeSaving.value || !scopeDraftDirty.value || scopeDraftInvalid.value) return
  scopeSaving.value = true
  try {
    const updated = await api.updateCredential(cred.id, {
      allowedRealms: scopeDraftPreviewRealms.value,
    })
    scopePopoverOpen.value = false
    toast.add({ title: '已更新允许场域', color: 'success' })
    emit('updated', updated)
  } catch (err) {
    toast.add({
      title: err instanceof ApiError ? err.message : '更新允许场域失败',
      color: 'error',
    })
  } finally {
    scopeSaving.value = false
  }
}

// ---- 新建 / 编辑复合凭据表单 ----

const TEMPLATE_OPTIONS = CREDENTIAL_KIND_ORDER.map((kind) => ({
  value: kind,
  label: credentialKindLabels[kind],
  icon: credentialKindIcons[kind],
}))

const FORM_SCOPE_OPTIONS: { value: 'scoped' | 'unscoped'; label: string }[] = [
  { value: 'scoped', label: '限定场域' },
  { value: 'unscoped', label: '不限场域' },
]

let nextRowUid = 1
const makeRowUid = () => `f-${nextRowUid++}`

const form = reactive({
  kind: 'secret' as CredentialKind,
  label: '',
  slug: '',
  slugTouched: false,
  description: '',
  primaryField: 'value',
  passkeyManualOnly: false,
  scopeMode: 'scoped' as 'scoped' | 'unscoped',
  allowedRealms: [] as string[],
})
const formFields = ref<FormFieldRow[]>([])
const formCustomRealm = ref('')
const formSaving = ref(false)
const formError = ref<string | null>(null)

function clearFormSensitiveValues(dropRows = false) {
  for (const row of formFields.value) {
    row.value = ''
    row.originalPlainValue = null
    row.showPlain = false
  }
  if (dropRows) {
    formFields.value = []
  }
}

function buildRowsForTemplate(
  kind: CredentialKind,
  preservedValues: ReadonlyMap<string, string> = new Map(),
  customRows: readonly FormFieldRow[] = [],
): FormFieldRow[] {
  const metaList = defaultFieldMetaForKind(kind)
  const presetRows: FormFieldRow[] = metaList.map((meta) => ({
    uid: makeRowUid(),
    name: meta.name,
    label: meta.label ?? credentialFieldLabel(kind, meta.name),
    secret: meta.secret,
    multiline: Boolean(meta.multiline),
    preset: true,
    existingKey: null,
    existingUnloaded: false,
    originalPlainValue: null,
    value: preservedValues.get(meta.name) ?? '',
    showPlain: false,
  }))
  const presetNames = new Set(presetRows.map((r) => r.name))
  const keptCustom = customRows
    .filter((r) => !presetNames.has(r.name))
    .map((r) => ({ ...r, uid: makeRowUid() }))
  return [...presetRows, ...keptCustom]
}

function initNewForm(kind: CredentialKind) {
  clearFormSensitiveValues(true)
  clearLocalSecrets()
  form.kind = kind
  form.label = ''
  form.slug = ''
  form.slugTouched = false
  form.description = ''
  form.primaryField = defaultPrimaryFieldForKind(kind)
  form.passkeyManualOnly = false
  form.scopeMode = 'unscoped'
  form.allowedRealms = []
  formFields.value = buildRowsForTemplate(kind)
  formCustomRealm.value = ''
  formError.value = null
}

async function loadPlainFieldsForEdit(cred: CredentialMeta) {
  if (!props.hasMasterKey) return
  const seq = ++revealSeq
  plainLoading.value = true
  plainLoadFailed.value = false
  formError.value = null
  try {
    const res = await api.revealCredential(cred.id, { scope: 'plain' })
    if (seq !== revealSeq) return
    applyRevealedValuesToEditRows(formFields.value, res.fields ?? {})
  } catch (err) {
    if (seq !== revealSeq) return
    plainLoadFailed.value = true
    formError.value = err instanceof ApiError ? err.message : '读取非敏感字段失败'
  } finally {
    if (seq === revealSeq) plainLoading.value = false
  }
}

async function initEditForm(cred: CredentialMeta) {
  clearFormSensitiveValues(true)
  clearLocalSecrets()
  scopePopoverOpen.value = false
  form.kind = cred.kind
  form.label = cred.label
  form.slug = cred.slug
  form.slugTouched = true
  form.description = cred.description ?? ''
  form.primaryField = cred.primaryField
  form.passkeyManualOnly = cred.passkeyManualOnly
  form.scopeMode = cred.allowedRealms !== null ? 'scoped' : 'unscoped'
  form.allowedRealms = [...(cred.allowedRealms ?? [])]
  formCustomRealm.value = ''
  formError.value = null

  const metaList = cred.fieldMeta.length
    ? cred.fieldMeta
    : [{ name: cred.primaryField || 'value', secret: true }]

  // 所有已有字段统一以未回填态初始化，仅在受控读取回填后才标记为已加载，杜绝加载中或失败保存时误删
  formFields.value = metaList.map((meta) => ({
    uid: makeRowUid(),
    name: meta.name,
    label: credentialFieldLabel(cred.kind, meta.name, meta.label),
    secret: meta.secret,
    multiline: Boolean(meta.multiline),
    preset: true,
    existingKey: meta.name,
    existingUnloaded: true,
    originalPlainValue: null,
    value: '',
    showPlain: false,
  }))

  // 进入编辑态仅加载非机密字段回填，机密字段默认保持留空不覆盖
  if (props.hasMasterKey && metaList.some((m) => !m.secret)) {
    await loadPlainFieldsForEdit(cred)
  }
}

const hasUnloadedSecretRows = computed(() =>
  formFields.value.some(
    (row) => row.existingKey && row.existingUnloaded && row.secret && !row.value,
  ),
)

async function loadAllSecretsForEdit() {
  const cred = props.credential
  if (!cred || !props.hasMasterKey || formLoadingSecrets.value) return
  const seq = revealSeq
  formLoadingSecrets.value = true
  formError.value = null
  try {
    const res = await api.revealCredential(cred.id, { scope: 'all' })
    if (seq !== revealSeq) return
    applyRevealedValuesToEditRows(formFields.value, res.fields ?? {})
    plainLoadFailed.value = false
  } catch (err) {
    if (seq !== revealSeq) return
    formError.value = err instanceof ApiError ? err.message : '加载机密字段失败'
  } finally {
    if (seq === revealSeq) formLoadingSecrets.value = false
  }
}

function switchTemplateKind(nextKind: CredentialKind) {
  if (props.mode !== 'new' || nextKind === form.kind) return
  const preserved = new Map<string, string>()
  const customRows: FormFieldRow[] = []
  for (const row of formFields.value) {
    if (row.value) preserved.set(row.name, row.value)
    if (!row.preset && (row.name.trim() || row.value)) customRows.push(row)
  }
  form.kind = nextKind
  form.primaryField = defaultPrimaryFieldForKind(nextKind)
  if (nextKind !== 'login') form.passkeyManualOnly = false
  formFields.value = buildRowsForTemplate(nextKind, preserved, customRows)
}

function onFormLabelInput(val: string) {
  form.label = val
  if (props.mode === 'new' && !form.slugTouched) {
    form.slug = deriveCredentialSlug(val)
  }
}

function onFormSlugInput(val: string) {
  form.slug = val
  form.slugTouched = val.trim().length > 0
}

function addCustomField() {
  if (formFields.value.length >= CREDENTIAL_FIELDS_MAX) return
  formFields.value.push({
    uid: makeRowUid(),
    name: '',
    label: '',
    secret: true,
    multiline: false,
    preset: false,
    existingKey: null,
    existingUnloaded: false,
    originalPlainValue: null,
    value: '',
    showPlain: false,
  })
}

function removeFormField(uid: string) {
  if (formFields.value.length <= 1) return
  const target = formFields.value.find((r) => r.uid === uid)
  formFields.value = formFields.value.filter((r) => r.uid !== uid)
  if (target && target.name.trim().toLowerCase() === form.primaryField.trim().toLowerCase()) {
    const firstValid = formFields.value.find((r) => r.name.trim()) ?? formFields.value[0]
    if (firstValid) form.primaryField = firstValid.name.trim().toLowerCase()
  }
}

function fieldMenuItems(row: FormFieldRow): DropdownMenuItem[][] {
  const cleanName = row.name.trim().toLowerCase()
  const isPrimary = Boolean(cleanName && cleanName === form.primaryField)
  const mainGroup: DropdownMenuItem[] = [
    {
      label: isPrimary ? '当前为默认引用' : '设为默认引用',
      icon: icons.check,
      disabled: !cleanName || isPrimary,
      onSelect: () => {
        if (cleanName) form.primaryField = cleanName
      },
    },
    {
      label: row.secret ? '改为默认展示' : '改为默认隐藏',
      icon: row.secret ? icons.reveal : icons.lock,
      onSelect: () => {
        row.secret = !row.secret
        if (!row.secret) row.showPlain = true
      },
    },
    {
      label: row.multiline ? '改为单行输入' : '改为多行输入',
      icon: icons.file,
      onSelect: () => {
        row.multiline = !row.multiline
      },
    },
  ]
  if (formFields.value.length <= 1) return [mainGroup]
  return [
    mainGroup,
    [
      {
        label: '移除字段',
        icon: icons.remove,
        color: 'error',
        onSelect: () => removeFormField(row.uid),
      },
    ],
  ]
}

function toggleFormRealm(realm: string) {
  form.allowedRealms = form.allowedRealms.includes(realm)
    ? form.allowedRealms.filter((r) => r !== realm)
    : normalizeSlugList([...form.allowedRealms, realm])
}

function addFormCustomRealm() {
  const parsed = SceneSlug.safeParse(formCustomRealm.value)
  if (!parsed.success) return
  if (!form.allowedRealms.includes(parsed.data)) {
    form.allowedRealms = normalizeSlugList([...form.allowedRealms, parsed.data])
  }
  formCustomRealm.value = ''
}

const formRealmsValue = computed(() =>
  form.scopeMode === 'scoped' ? normalizeSlugList(form.allowedRealms) : null,
)

const formMatchedKeyCount = computed(
  () =>
    props.apiKeys.filter((k) => canKeyAccessCredential(k, { allowedRealms: formRealmsValue.value }))
      .length,
)

const editUpdatePlan = computed(() =>
  props.mode === 'edit' && props.credential
    ? buildCredentialUpdateFields(
        props.credential,
        formFields.value,
        form.primaryField,
        credentialFieldLabel,
      )
    : null,
)

// 核对编辑态变动项，接入 SaveBar 变更预览与离开确认
const editDirtyChanges = computed<SaveBarChange[]>(() => {
  if (props.mode !== 'edit' || !props.credential || !editUpdatePlan.value) return []
  const cred = props.credential
  const plan = editUpdatePlan.value
  const list: SaveBarChange[] = []

  if (form.label.trim() !== cred.label) {
    list.push({ label: '名称', before: cred.label, after: form.label.trim() || '（空）' })
  }
  const nextDesc = form.description.trim()
  const prevDesc = cred.description?.trim() ?? ''
  if (nextDesc !== prevDesc) {
    list.push({ label: '用途说明', before: prevDesc || '（空）', after: nextDesc || '（空）' })
  }
  if (!sameRealms(formRealmsValue.value, cred.allowedRealms)) {
    list.push({
      label: '允许场域',
      before:
        cred.allowedRealms === null
          ? '不限场域'
          : cred.allowedRealms.length
            ? cred.allowedRealms.join('、')
            : '仅无场域',
      after:
        formRealmsValue.value === null
          ? '不限场域'
          : formRealmsValue.value.length
            ? formRealmsValue.value.join('、')
            : '仅无场域',
    })
  }
  if (cred.kind === 'login' && form.passkeyManualOnly !== cred.passkeyManualOnly) {
    list.push({
      label: '人工登录标记',
      before: cred.passkeyManualOnly ? '开启' : '关闭',
      after: form.passkeyManualOnly ? '开启' : '关闭',
    })
  }
  if (plan.primaryField !== cred.primaryField) {
    list.push({ label: '默认引用字段', before: cred.primaryField, after: plan.primaryField })
  }
  if (plan.touchedFieldCount > 0) {
    list.push({
      label: '凭据字段',
      before: `${cred.fieldMeta.length} 个字段`,
      after: `变动 ${plan.touchedFieldCount} 项`,
    })
  }

  return list
})

const newHasInput = computed(() => {
  if (props.mode !== 'new') return false
  return Boolean(
    form.label.trim() ||
    form.slug.trim() ||
    form.description.trim() ||
    formFields.value.some((r) => r.value.length > 0 || (!r.preset && r.name.trim())),
  )
})

const isFormDirty = computed(() =>
  props.mode === 'edit'
    ? editDirtyChanges.value.length > 0
    : props.mode === 'new' && newHasInput.value,
)

watch(
  isFormDirty,
  (dirty) => {
    emit('dirtyChange', dirty)
  },
  { immediate: true },
)

const formValidationProblem = computed(() => {
  if (props.mode === 'read') return null
  if (!props.hasMasterKey) return '未配置主密钥 KIOKU_MASTER_KEY，无法保存加密凭据'
  if (!form.label.trim()) return '请填写凭据名称'
  if (props.mode === 'new') {
    const slugCheck = CredentialSlug.safeParse(form.slug)
    if (!slugCheck.success) return slugCheck.error.issues[0]?.message ?? '标识格式有误'
  }
  if (form.scopeMode === 'scoped' && !form.allowedRealms.length) {
    return '请至少选择一个允许场域，或切换为不限场域'
  }

  if (props.mode === 'edit') {
    return validateCredentialEditRows(formFields.value, { plainLoading: plainLoading.value })
  }

  const seenNames = new Set<string>()
  let effectiveFieldCount = 0

  for (const row of formFields.value) {
    const cleanName = row.name.trim().toLowerCase()
    const hasVal = row.value.length > 0
    if (!hasVal && row.preset) continue
    if (!hasVal && !cleanName) continue
    const nameCheck = CredentialFieldName.safeParse(cleanName)
    if (!nameCheck.success) return nameCheck.error.issues[0]?.message ?? '字段键名格式有误'
    if (!hasVal) return `请填写自定义字段 ${cleanName} 的值`
    if (seenNames.has(cleanName)) return `字段键名 ${cleanName} 重复`
    seenNames.add(cleanName)
    effectiveFieldCount++
  }

  if (effectiveFieldCount === 0) return '请至少保留一个非空凭据字段'
  if (effectiveFieldCount > CREDENTIAL_FIELDS_MAX) return `字段最多 ${CREDENTIAL_FIELDS_MAX} 个`
  return null
})

const saveBarCount = computed(() => {
  if (props.mode === 'edit') return editDirtyChanges.value.length
  if (props.mode === 'new') return formValidationProblem.value ? (newHasInput.value ? 1 : 0) : 1
  return 0
})

async function submitForm() {
  if (formSaving.value || plainLoading.value || formValidationProblem.value) return
  if (props.mode === 'edit' && editDirtyChanges.value.length === 0) return
  formSaving.value = true
  formError.value = null

  try {
    if (props.mode === 'new') {
      const fieldsPayload: Record<string, string> = {}
      const fieldMeta: CredentialFieldMeta[] = []
      for (const row of formFields.value) {
        const cleanName = row.name.trim().toLowerCase()
        if (!cleanName || !row.value) continue
        fieldsPayload[cleanName] = row.value
        fieldMeta.push({
          name: cleanName,
          label: row.label.trim() || credentialFieldLabel(form.kind, cleanName),
          secret: row.secret,
          ...(row.multiline || row.value.includes('\n') ? { multiline: true } : {}),
        })
      }
      const normalizedPrimary = form.primaryField.trim().toLowerCase()
      const primaryField = Object.hasOwn(fieldsPayload, normalizedPrimary)
        ? normalizedPrimary
        : fieldMeta[0]!.name
      const created = await api.createCredential({
        slug: form.slug.trim().toLowerCase(),
        label: form.label.trim(),
        description: form.description.trim() || null,
        kind: form.kind,
        primaryField,
        fieldMeta,
        fields: fieldsPayload,
        passkeyManualOnly: form.kind === 'login' ? form.passkeyManualOnly : false,
        allowedRealms: formRealmsValue.value,
      })
      clearFormSensitiveValues(true)
      hasUnsavedChanges.value = false
      toast.add({ title: `已保存凭据 ${created.slug}`, color: 'success' })
      emit('saved', created, true)
      return
    }

    const cred = props.credential
    const plan = editUpdatePlan.value
    if (!cred || !plan) return

    const payload: UpdateCredentialRequest = {
      label: form.label.trim(),
      description: form.description.trim() || null,
      primaryField: plan.primaryField,
      fieldMeta: plan.fieldMeta,
      allowedRealms: formRealmsValue.value,
      ...(cred.kind === 'login' ? { passkeyManualOnly: form.passkeyManualOnly } : {}),
      ...(Object.keys(plan.fieldsToSet).length ? { fields: plan.fieldsToSet } : {}),
      ...(plan.removeFields.length ? { removeFields: plan.removeFields } : {}),
    }

    const updated = await api.updateCredential(cred.id, payload)
    clearFormSensitiveValues(true)
    hasUnsavedChanges.value = false
    toast.add({ title: `已更新凭据 ${updated.slug}`, color: 'success' })
    emit('saved', updated, false)
  } catch (err) {
    formError.value = err instanceof ApiError ? err.message : '保存凭据失败，请重试'
  } finally {
    formSaving.value = false
  }
}

function requestCancelForm() {
  if (isFormDirty.value && !confirmDiscard()) return
  clearFormSensitiveValues(true)
  clearLocalSecrets()
  emit('cancelForm')
}

watch(
  () => [props.mode, props.credential?.id, props.credential?.updatedAt, props.initialKind] as const,
  ([nextMode, , , nextInitKind]) => {
    scopePopoverOpen.value = false
    if (nextMode === 'new') {
      initNewForm(nextInitKind)
    } else if (nextMode === 'edit' && props.credential) {
      void initEditForm(props.credential)
    } else if (nextMode === 'read' && props.credential) {
      clearFormSensitiveValues(true)
      clearLocalSecrets()
      void loadPlainFieldsFor(props.credential)
    } else {
      clearFormSensitiveValues(true)
      clearLocalSecrets()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  clearLocalSecrets()
  clearFormSensitiveValues(true)
  if (slugCopyTimer) {
    clearTimeout(slugCopyTimer)
    slugCopyTimer = null
  }
})

defineExpose({
  isDirty: () => isFormDirty.value,
  requestCancelForm,
})
</script>

<template>
  <article
    class="editor-pane"
    :class="{
      'is-single-col': mode !== 'read',
      'is-editing': mode !== 'read',
    }"
  >
    <!-- 手机端返回栏 -->
    <div v-if="showBack" class="mobile-back-bar">
      <UButton
        v-if="mode !== 'read'"
        size="sm"
        color="neutral"
        variant="ghost"
        :icon="icons.cancel"
        :disabled="formSaving"
        class="shrink-0 whitespace-nowrap"
        @click="requestCancelForm"
      >
        {{ mode === 'new' ? '返回列表' : '退出编辑' }}
      </UButton>
      <UButton
        v-else
        size="sm"
        color="neutral"
        variant="ghost"
        :icon="icons.back"
        class="shrink-0 whitespace-nowrap"
        @click="emit('back')"
      >
        返回列表
      </UButton>

      <div v-if="mode === 'read' && credential" class="mobile-bar-actions">
        <UButton
          size="xs"
          :icon="icons.edit"
          :disabled="!hasMasterKey"
          class="shrink-0 whitespace-nowrap"
          @click="emit('enterEdit')"
        >
          编辑
        </UButton>
        <UButton
          size="xs"
          color="error"
          variant="outline"
          :icon="icons.remove"
          class="shrink-0 whitespace-nowrap"
          @click="emit('requestDelete')"
        >
          删除
        </UButton>
      </div>
    </div>

    <!-- 阅读态 -->
    <template v-if="mode === 'read' && credential">
      <header class="editor-head">
        <div class="head-main">
          <div class="head-identity">
            <div class="head-title-row">
              <h1>{{ credential.label }}</h1>
            </div>

            <div class="head-status-line">
              <span class="inline-badge">
                <UIcon
                  :name="credentialKindIcons[credential.kind]"
                  class="inline-badge-icon"
                  aria-hidden="true"
                />
                <span>{{ credentialKindLabels[credential.kind] }}</span>
              </span>

              <UPopover
                v-model:open="scopePopoverOpen"
                :dismissible="!scopeSaving"
                :content="{ align: 'start', sideOffset: 6 }"
              >
                <button
                  type="button"
                  class="inline-chip"
                  :class="{ 'is-scoped': credential.allowedRealms !== null }"
                  :disabled="scopeSaving"
                  :aria-expanded="scopePopoverOpen"
                  title="点击直接调整允许场域"
                >
                  <UIcon
                    :name="credential.allowedRealms !== null ? icons.sliders : icons.globe"
                    class="inline-chip-icon"
                    aria-hidden="true"
                  />
                  <span class="inline-chip-text">{{ inlineScopeLabel }}</span>
                  <UIcon :name="icons.chevronDown" class="inline-chip-caret" aria-hidden="true" />
                </button>
                <template #content>
                  <div class="pin-popover">
                    <div class="pin-popover-head">
                      <span class="pin-popover-title">
                        <UIcon :name="icons.sliders" class="pin-title-icon" aria-hidden="true" />
                        <span>允许场域</span>
                      </span>
                      <span class="text-xs text-muted">
                        {{ scopeDraft.scoped ? '已限定场域' : '不限场域' }}
                      </span>
                    </div>

                    <div class="pin-popover-body">
                      <div class="pin-mode-list" role="radiogroup" aria-label="选择允许场域策略">
                        <button
                          type="button"
                          role="radio"
                          class="pin-mode-card"
                          :class="{ active: scopeDraft.scoped }"
                          :aria-checked="scopeDraft.scoped"
                          :disabled="scopeSaving"
                          @click="scopeDraft.scoped = true"
                        >
                          <span class="pin-mode-head">
                            <span class="pin-mode-name">
                              <UIcon
                                :name="icons.sliders"
                                class="pin-mode-icon"
                                aria-hidden="true"
                              />
                              <span>限定场域</span>
                            </span>
                            <UIcon
                              v-if="scopeDraft.scoped"
                              :name="icons.check"
                              class="pin-mode-check"
                              aria-hidden="true"
                            />
                          </span>
                          <span class="pin-mode-desc">
                            仅与所选场域有交集且开启凭据解析权限的访问密钥可用。
                          </span>
                        </button>

                        <button
                          type="button"
                          role="radio"
                          class="pin-mode-card"
                          :class="{ active: !scopeDraft.scoped }"
                          :aria-checked="!scopeDraft.scoped"
                          :disabled="scopeSaving"
                          @click="scopeDraft.scoped = false"
                        >
                          <span class="pin-mode-head">
                            <span class="pin-mode-name">
                              <UIcon :name="icons.globe" class="pin-mode-icon" aria-hidden="true" />
                              <span>不限场域</span>
                            </span>
                            <UIcon
                              v-if="!scopeDraft.scoped"
                              :name="icons.check"
                              class="pin-mode-check"
                              aria-hidden="true"
                            />
                          </span>
                          <span class="pin-mode-desc">
                            仅未限定场域且开启凭据解析权限的访问密钥可用。
                          </span>
                        </button>
                      </div>

                      <div v-if="scopeDraft.scoped" class="pin-scope-box">
                        <span class="pin-scope-label">选择允许访问的场域</span>
                        <div class="realm-chip-row">
                          <button
                            v-for="r in knownRealms"
                            :key="r"
                            type="button"
                            class="realm-toggle font-mono"
                            :class="{ 'is-checked': scopeDraft.allowedRealms.includes(r) }"
                            :aria-pressed="scopeDraft.allowedRealms.includes(r)"
                            :disabled="scopeSaving"
                            @click="toggleScopeDraftRealm(r)"
                          >
                            <UIcon
                              :name="
                                scopeDraft.allowedRealms.includes(r) ? icons.check : icons.realm
                              "
                              class="realm-toggle-icon"
                              aria-hidden="true"
                            />
                            <span>{{ r }}</span>
                          </button>
                          <UInput
                            v-model="scopeCustomRealm"
                            size="xs"
                            placeholder="新增场域"
                            class="w-24"
                            :disabled="scopeSaving"
                            @keydown.enter.prevent="addScopeDraftRealm"
                            @blur="addScopeDraftRealm"
                          />
                        </div>
                      </div>

                      <p
                        class="text-xs tabular-nums"
                        :class="scopeDraftInvalid ? 'text-error' : 'text-muted'"
                      >
                        {{
                          scopeDraftInvalid
                            ? '请至少选择一个场域，或切换为「不限场域」。'
                            : `当前配置下，共有 ${scopeDraftMatchedKeyCount} 个访问密钥有权解析此凭据。`
                        }}
                      </p>
                    </div>

                    <div class="pin-popover-foot">
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        :disabled="scopeSaving"
                        @click="scopePopoverOpen = false"
                      >
                        取消
                      </UButton>
                      <UButton
                        size="xs"
                        :icon="icons.check"
                        :loading="scopeSaving"
                        :disabled="!scopeDraftDirty || scopeDraftInvalid"
                        @click="applyScopeDraft"
                      >
                        保存场域
                      </UButton>
                    </div>
                  </div>
                </template>
              </UPopover>

              <span class="status-sep" aria-hidden="true">·</span>
              <time :datetime="credential.updatedAt" :title="formatTime(credential.updatedAt)">
                {{ formatRelative(credential.updatedAt) }}更新
              </time>
              <span class="status-sep" aria-hidden="true">·</span>

              <button
                type="button"
                class="status-copy-id"
                :title="`点击复制凭据标识：${credential.slug}`"
                :aria-label="`复制凭据标识 ${credential.slug}`"
                @click="copySlug"
              >
                <span class="status-id-prefix">标识:</span>
                <code class="status-id-code font-mono">{{ credential.slug }}</code>
                <UIcon
                  :name="slugCopied ? icons.check : icons.copy"
                  class="status-inline-icon"
                  :class="{ 'is-copied': slugCopied }"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>

          <div class="head-actions">
            <UButton
              size="sm"
              :icon="icons.edit"
              :disabled="!hasMasterKey"
              @click="emit('enterEdit')"
            >
              编辑
            </UButton>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :icon="icons.copy"
              @click="copy(placeholderOf(credential.slug))"
            >
              复制占位符
            </UButton>
            <UButton
              size="sm"
              color="error"
              variant="outline"
              :icon="icons.remove"
              @click="emit('requestDelete')"
            >
              删除
            </UButton>
          </div>
        </div>
      </header>

      <div class="editor-scroll">
        <div class="read-layout has-rail">
          <div class="read-main">
            <NoteLine v-if="!hasMasterKey" tone="warning">
              未配置主密钥 KIOKU_MASTER_KEY，无法创建或读取加密凭据。
            </NoteLine>

            <NoteLine
              v-if="credential.kind === 'login' && credential.passkeyManualOnly"
              tone="warning"
              :icon="icons.shieldAlert"
            >
              需人工登录（含 Passkey），不自动注入
            </NoteLine>

            <section
              v-if="credential.description?.trim()"
              class="summary-block"
              aria-label="用途说明"
            >
              <span class="summary-label">
                <UIcon :name="icons.file" class="summary-label-icon" aria-hidden="true" />
                <span>用途说明</span>
              </span>
              <p class="summary-text">{{ credential.description }}</p>
            </section>

            <section class="paper-section" aria-label="凭据字段">
              <SectionHeading title="凭据字段" :icon="icons.keys">
                <template #hint>
                  <span class="sec-count tabular-nums">{{ displayFields.length }}</span>
                </template>
                <template v-if="secretFieldList.length > 0 && hasMasterKey" #actions>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :icon="allSecretsShown ? icons.hide : icons.reveal"
                    :loading="revealingAll"
                    @click="toggleAllSecrets"
                  >
                    {{ allSecretsShown ? '全部隐藏' : '显示全部' }}
                  </UButton>
                </template>
              </SectionHeading>

              <NoteLine v-if="revealError" tone="error" flush>
                {{ revealError }}
              </NoteLine>

              <div class="kv-clean-list">
                <div v-for="field in displayFields" :key="field.name" class="kv-clean-row">
                  <div class="kv-label-col">
                    <span class="kv-label-top">
                      <span>{{
                        credentialFieldLabel(credential.kind, field.name, field.label)
                      }}</span>
                      <span
                        v-if="field.name === credential.primaryField && displayFields.length > 1"
                        class="default-pill"
                      >
                        默认
                      </span>
                    </span>
                    <span class="kv-label-key font-mono">{{ field.name }}</span>
                  </div>

                  <div class="kv-val-col">
                    <template v-if="!field.secret">
                      <USkeleton
                        v-if="plainLoading && !(field.name in plainValues)"
                        class="h-4 w-44"
                      />
                      <pre
                        v-else-if="
                          field.multiline || (plainValues[field.name] ?? '').includes('\n')
                        "
                        class="kv-val-pre"
                        >{{ plainValues[field.name] ?? '—' }}</pre>
                      <span
                        v-else
                        class="kv-val-text"
                        :title="plainValues[field.name] ?? undefined"
                      >
                        {{ hasPlainFields ? (plainValues[field.name] ?? '—') : '—' }}
                      </span>
                    </template>

                    <template v-else>
                      <template v-if="field.name in revealedSecrets">
                        <pre
                          v-if="
                            field.multiline || (revealedSecrets[field.name] ?? '').includes('\n')
                          "
                          class="kv-val-pre"
                          >{{ revealedSecrets[field.name] }}</pre>
                        <span
                          v-else
                          class="kv-val-text"
                          :title="revealedSecrets[field.name] ?? undefined"
                        >
                          {{ revealedSecrets[field.name] }}
                        </span>
                      </template>
                      <span v-else class="kv-val-mask" aria-label="已隐藏">••••••••••••</span>
                    </template>
                  </div>

                  <div class="kv-ops">
                    <UButton
                      v-if="field.secret"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :icon="field.name in revealedSecrets ? icons.hide : icons.reveal"
                      :loading="Boolean(revealingFields[field.name])"
                      :disabled="!hasMasterKey"
                      @click="toggleSecretField(field.name)"
                    >
                      {{ field.name in revealedSecrets ? '隐藏' : '显示' }}
                    </UButton>
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :icon="icons.copy"
                      :loading="copyingField === field.name"
                      :disabled="!hasMasterKey"
                      @click="copyFieldValue(field)"
                    >
                      复制
                    </UButton>
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :icon="icons.linkChain"
                      :title="`复制占位符：${formatCredentialPlaceholder(credential, field.name)}`"
                      @click="copyFieldRef(field.name)"
                    >
                      引用
                    </UButton>
                  </div>
                </div>
              </div>
            </section>

            <!-- 窄容器下辅助轨自然下沉 -->
            <div class="read-below-only">
              <CredentialReadRail
                :credential="credential"
                :references="references"
                :references-loading="referencesLoading"
                :references-error="referencesError"
                :api-keys="apiKeys"
                @request-delete="emit('requestDelete')"
              />
            </div>
          </div>

          <!-- 宽屏右侧 296px 辅助轨 -->
          <aside class="read-rail" aria-label="凭据辅助信息">
            <div class="rail-scroll">
              <CredentialReadRail
                :credential="credential"
                :references="references"
                :references-loading="referencesLoading"
                :references-error="referencesError"
                :api-keys="apiKeys"
                @request-delete="emit('requestDelete')"
              />
            </div>
          </aside>
        </div>
      </div>
    </template>

    <!-- 新建 / 编辑复合凭据流 -->
    <template v-else-if="mode === 'new' || (mode === 'edit' && credential)">
      <header class="editor-head">
        <div class="head-main">
          <div class="head-identity">
            <div class="head-title-row">
              <h1>{{ mode === 'new' ? '新建凭据' : `编辑凭据 · ${credential!.slug}` }}</h1>
            </div>
            <div class="head-status-line">
              <template v-if="mode === 'new'">
                <span>选择类型模板并填写字段，所有字段值均加密存储</span>
              </template>
              <template v-else-if="credential">
                <span class="inline-badge">
                  <UIcon
                    :name="credentialKindIcons[credential.kind]"
                    class="inline-badge-icon"
                    aria-hidden="true"
                  />
                  <span>{{ credentialKindLabels[credential.kind] }}</span>
                </span>
                <span class="status-sep" aria-hidden="true">·</span>
                <span>
                  标识 <code class="status-id-code font-mono">{{ credential.slug }}</code>
                  创建后不可修改
                </span>
              </template>
            </div>
          </div>

          <div class="head-actions">
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :icon="mode === 'new' ? icons.back : icons.cancel"
              :disabled="formSaving"
              @click="requestCancelForm"
            >
              {{ mode === 'new' ? '返回' : '退出编辑' }}
            </UButton>
          </div>
        </div>
      </header>

      <div class="editor-scroll is-editing">
        <div class="form-stack">
          <NoteLine v-if="!hasMasterKey" tone="warning">
            未配置主密钥 KIOKU_MASTER_KEY，无法创建或保存加密凭据。
          </NoteLine>

          <div v-if="mode === 'new'" class="template-picker-wrap">
            <SegmentedChoice
              :model-value="form.kind"
              :items="TEMPLATE_OPTIONS"
              label="选择凭据类型模板"
              @update:model-value="switchTemplateKind"
            />
          </div>

          <section class="paper-section" aria-label="基本信息">
            <SectionHeading title="基本信息" :icon="icons.file" />

            <div class="form-row-2">
              <UFormField label="名称" required>
                <UInput
                  :model-value="form.label"
                  :maxlength="CREDENTIAL_LABEL_MAX"
                  placeholder="例如：生产主库连接"
                  class="w-full"
                  @update:model-value="(v) => onFormLabelInput(String(v ?? ''))"
                />
              </UFormField>

              <UFormField
                v-if="mode === 'new'"
                label="标识"
                required
                help="用于 {{cred:标识}} 引用，小写字母、数字和 ._-，创建后不可修改"
              >
                <UInput
                  :model-value="form.slug"
                  maxlength="64"
                  placeholder="例如：prod-pg-main"
                  class="w-full font-mono"
                  autocomplete="off"
                  spellcheck="false"
                  @update:model-value="(v) => onFormSlugInput(String(v ?? ''))"
                />
              </UFormField>

              <UFormField v-else label="标识（只读）">
                <UInput :model-value="form.slug" disabled class="w-full font-mono" />
              </UFormField>
            </div>

            <UFormField label="用途说明（可选）" help="简述用途，便于检索和客户端识别，不含敏感值">
              <UInput
                v-model="form.description"
                :maxlength="CREDENTIAL_DESCRIPTION_MAX"
                placeholder="例如：只读排查与迁移脚本使用"
                class="w-full"
              />
            </UFormField>
          </section>

          <section class="paper-section" aria-label="凭据字段">
            <SectionHeading title="凭据字段" :icon="icons.keys">
              <template #actions>
                <UButton
                  v-if="mode === 'edit' && plainLoadFailed && credential && hasMasterKey"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.refresh"
                  :loading="plainLoading"
                  @click="loadPlainFieldsForEdit(credential)"
                >
                  重试读取非敏感字段
                </UButton>
                <UButton
                  v-if="mode === 'edit' && hasUnloadedSecretRows && hasMasterKey"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.reveal"
                  :loading="formLoadingSecrets"
                  @click="loadAllSecretsForEdit"
                >
                  加载已有密文
                </UButton>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.add"
                  :disabled="formFields.length >= CREDENTIAL_FIELDS_MAX"
                  @click="addCustomField"
                >
                  添加自定义字段
                </UButton>
              </template>
            </SectionHeading>

            <NoteLine v-if="mode === 'edit' && plainLoadFailed && credential" tone="warning" flush>
              未能回填部分非敏感字段，已自动保留原值且不会在保存时清除。
              <template #actions>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.refresh"
                  :loading="plainLoading"
                  @click="loadPlainFieldsForEdit(credential)"
                >
                  重试读取
                </UButton>
              </template>
            </NoteLine>

            <div class="edit-field-list">
              <div v-for="row in formFields" :key="row.uid" class="edit-field-row">
                <div class="edit-field-key-col">
                  <div v-if="row.preset || row.existingKey" class="kv-label-col">
                    <span class="kv-label-top">
                      <span>{{ row.label || credentialFieldLabel(form.kind, row.name) }}</span>
                      <span
                        v-if="
                          row.name.trim().toLowerCase() ===
                            form.primaryField.trim().toLowerCase() && formFields.length > 1
                        "
                        class="default-pill"
                      >
                        默认
                      </span>
                    </span>
                    <span class="kv-label-key font-mono">{{ row.name }}</span>
                  </div>
                  <UInput
                    v-else
                    v-model="row.name"
                    size="sm"
                    maxlength="64"
                    placeholder="字段键名"
                    aria-label="自定义字段键名"
                    class="w-full font-mono"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </div>

                <div class="edit-field-val-col">
                  <UTextarea
                    v-if="row.multiline"
                    v-model="row.value"
                    :rows="3"
                    autoresize
                    :maxrows="10"
                    :placeholder="
                      row.existingUnloaded && !row.secret && plainLoading
                        ? '正在读取字段值…'
                        : row.existingUnloaded
                          ? '留空保持原值'
                          : '输入字段值'
                    "
                    :aria-label="`${row.label || row.name || '字段'}值`"
                    class="w-full font-mono"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <div v-else class="edit-val-inline">
                    <UInput
                      v-model="row.value"
                      size="sm"
                      :type="row.secret && !row.showPlain ? 'password' : 'text'"
                      :placeholder="
                        row.existingUnloaded && !row.secret && plainLoading
                          ? '正在读取字段值…'
                          : row.existingUnloaded
                            ? '留空保持原值'
                            : '输入字段值'
                      "
                      :aria-label="`${row.label || row.name || '字段'}值`"
                      class="flex-1 font-mono"
                      autocomplete="off"
                      spellcheck="false"
                    />
                    <UButton
                      v-if="row.secret"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :icon="row.showPlain ? icons.hide : icons.reveal"
                      class="shrink-0 whitespace-nowrap"
                      @click="row.showPlain = !row.showPlain"
                    >
                      {{ row.showPlain ? '隐藏' : '显示' }}
                    </UButton>
                  </div>
                </div>

                <div class="edit-field-ops-col">
                  <UDropdownMenu
                    :items="fieldMenuItems(row)"
                    :content="{ align: 'end' }"
                    :ui="{ content: 'min-w-40' }"
                  >
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :trailing-icon="icons.chevronDown"
                    >
                      选项
                    </UButton>
                  </UDropdownMenu>
                </div>
              </div>
            </div>

            <p v-if="mode === 'new'" class="text-xs text-muted">
              留空的可选字段保存时自动忽略；所有字段值均加密存储。
            </p>
            <p v-else class="text-xs text-muted">
              未修改的机密字段留空即保持原值不变；点击上方「加载已有密文」可回填后编辑。
            </p>

            <label v-if="form.kind === 'login'" class="passkey-check">
              <input v-model="form.passkeyManualOnly" type="checkbox" />
              <span>需人工登录（含 Passkey），不自动注入</span>
            </label>
          </section>

          <section class="paper-section" aria-label="允许场域">
            <SectionHeading title="允许场域" :icon="icons.sliders" />

            <div class="scope-editor-row">
              <SegmentedChoice
                v-model="form.scopeMode"
                :items="FORM_SCOPE_OPTIONS"
                label="允许场域模式"
              />
              <div v-if="form.scopeMode === 'scoped'" class="realm-chip-row">
                <button
                  v-for="r in knownRealms"
                  :key="r"
                  type="button"
                  class="realm-toggle font-mono"
                  :class="{ 'is-checked': form.allowedRealms.includes(r) }"
                  :aria-pressed="form.allowedRealms.includes(r)"
                  @click="toggleFormRealm(r)"
                >
                  <UIcon
                    :name="form.allowedRealms.includes(r) ? icons.check : icons.realm"
                    class="realm-toggle-icon"
                    aria-hidden="true"
                  />
                  <span>{{ r }}</span>
                </button>
                <UInput
                  v-model="formCustomRealm"
                  size="xs"
                  placeholder="新增场域"
                  class="w-24"
                  @keydown.enter.prevent="addFormCustomRealm"
                  @blur="addFormCustomRealm"
                />
              </div>
            </div>

            <p class="text-xs text-muted tabular-nums">
              {{
                form.scopeMode === 'scoped'
                  ? `保存后，允许访问 ${form.allowedRealms.length ? form.allowedRealms.join('、') : '所选场域'} 的 ${formMatchedKeyCount} 个访问密钥有权解析此凭据。`
                  : `保存后，仅未限定场域且开启凭据解析权限的访问密钥有权解析此凭据（当前 ${formMatchedKeyCount} 个）。`
              }}
            </p>
          </section>

          <NoteLine v-if="formError" tone="error" flush>
            {{ formError }}
          </NoteLine>

          <SaveBar
            :count="saveBarCount"
            :saving="formSaving"
            :problem="formValidationProblem"
            :changes="mode === 'edit' ? editDirtyChanges : undefined"
            always-show
            submit-type="button"
            discard-label="取消"
            :save-label="mode === 'new' ? '保存凭据' : '保存更改'"
            @discard="requestCancelForm"
            @save="submitForm"
          >
            <template #extra>
              <div class="save-encrypt-note">
                <UIcon :name="icons.lock" class="save-encrypt-icon" aria-hidden="true" />
                <span>所有字段值均加密存储，非敏感字段仅在阅读与编辑时受控读取。</span>
              </div>
            </template>
          </SaveBar>
        </div>
      </div>
    </template>
  </article>
</template>

<style scoped>
.editor-pane {
  --canvas-max: 1320px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
.editor-pane.is-single-col {
  --canvas-max: 880px;
}
.mobile-back-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 36px;
  min-height: 36px;
  padding: 0 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.mobile-bar-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.editor-head {
  flex: none;
  padding: 16px 28px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.head-main {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 16px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.head-identity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 20rem;
}
.head-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.head-title-row h1 {
  font-size: 22px;
  font-weight: 500;
  line-height: 1.35;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.head-status-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 7px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.status-sep {
  color: var(--ui-border-accented);
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.inline-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--ui-text-toned);
  white-space: nowrap;
}
.inline-badge-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-muted);
}
.inline-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 16rem;
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.inline-chip:hover:not(:disabled) {
  border-color: var(--ui-rule);
  background: var(--ui-bg-muted);
  color: var(--ui-text-highlighted);
}
.inline-chip.is-scoped {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.inline-chip-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-muted);
}
.inline-chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inline-chip-caret {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-dimmed);
}
.status-copy-id {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 5px;
  border: 1px solid transparent;
  background: transparent;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-dimmed);
  cursor: pointer;
}
.status-copy-id:hover {
  border-color: var(--ui-border-accented);
  background: var(--ui-bg-muted);
  color: var(--ui-text-highlighted);
}
.status-id-prefix {
  color: var(--ui-text-dimmed);
}
.status-id-code {
  font-size: 12px;
  letter-spacing: 0.01em;
}
.status-inline-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.status-inline-icon.is-copied {
  color: var(--ui-success);
}
.pin-popover {
  display: flex;
  flex-direction: column;
  width: min(25rem, calc(100vw - 2rem));
  max-height: min(75vh, calc(var(--reka-popover-content-available-height, 75vh) - 12px));
}
.pin-popover-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px 8px;
  border-bottom: 1px solid var(--ui-border);
}
.pin-popover-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.pin-title-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.pin-popover-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
}
.pin-mode-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pin-mode-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  text-align: left;
  cursor: pointer;
}
.pin-mode-card:hover {
  border-color: var(--ui-rule);
  background: var(--ui-bg-muted);
}
.pin-mode-card.active {
  border-color: var(--ui-rule);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.pin-mode-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pin-mode-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}
.pin-mode-icon,
.pin-mode-check {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.pin-mode-desc {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.pin-mode-card.active .pin-mode-desc {
  color: var(--ui-on-selected-muted);
}
.pin-scope-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.pin-scope-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
}
.pin-popover-foot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding: 8px 16px 12px;
  border-top: 1px solid var(--ui-border);
}
.editor-scroll {
  container-type: inline-size;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 28px 28px;
}
.editor-scroll.is-editing {
  padding-bottom: 0;
}
.read-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 24px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.read-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.read-rail {
  display: none;
}
.read-below-only {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-top: 6px;
}
@container (min-width: 960px) {
  .read-layout.has-rail {
    grid-template-columns: minmax(0, 1fr) 296px;
    gap: 28px;
    align-items: start;
  }
  .read-layout.has-rail .read-rail {
    position: sticky;
    top: 0;
    max-height: calc(100vh - 14rem);
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--ui-border);
  }
  .read-layout.has-rail .read-below-only {
    display: none;
  }
}
.rail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-left: 20px;
  padding-right: 4px;
}
.summary-block {
  padding: 10px 14px;
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.summary-label {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.summary-label-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.summary-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.65;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.paper-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sec-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-dimmed);
}
.kv-clean-list {
  display: flex;
  flex-direction: column;
}
.kv-clean-row {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--ui-border);
}
.kv-clean-row:hover {
  background: color-mix(in srgb, var(--ui-bg-elevated) 55%, transparent);
}
.kv-label-col {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.kv-label-top {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.kv-label-key {
  font-size: 12px;
  color: var(--ui-text-dimmed);
  overflow-wrap: anywhere;
}
.default-pill {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.35;
  color: var(--ui-text-muted);
}
.kv-val-col {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text);
}
.kv-val-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kv-val-mask {
  letter-spacing: 0.16em;
  color: var(--ui-text-dimmed);
  user-select: none;
}
.kv-val-pre {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-bright);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.kv-ops {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  flex: none;
}
.form-stack {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.template-picker-wrap {
  overflow-x: auto;
  padding-bottom: 2px;
}
.form-row-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.edit-field-list {
  display: flex;
  flex-direction: column;
}
.edit-field-row {
  display: grid;
  grid-template-columns: 156px minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--ui-border);
}
.edit-field-row:last-child {
  border-bottom: 0;
}
.edit-field-key-col {
  min-width: 0;
  padding-top: 2px;
}
.edit-field-val-col {
  min-width: 0;
}
.edit-val-inline {
  display: flex;
  align-items: center;
  gap: 6px;
}
.edit-field-ops-col {
  flex: none;
  padding-top: 2px;
}
.passkey-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ui-text);
  cursor: pointer;
}
.scope-editor-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.realm-chip-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.realm-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.realm-toggle:hover {
  border-color: var(--ui-rule);
  background: var(--ui-bg-elevated);
}
.realm-toggle.is-checked {
  border-color: var(--ui-rule);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.realm-toggle-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.save-encrypt-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.save-encrypt-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
@media (max-width: 767.98px) {
  .editor-head {
    padding: 12px 14px 10px;
  }
  .head-title-row h1 {
    font-size: 19px;
  }
  .head-actions {
    display: none;
  }
  .editor-scroll {
    padding: 14px 14px 28px;
  }
  .form-row-2 {
    grid-template-columns: minmax(0, 1fr);
  }
  .kv-clean-row,
  .edit-field-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
}
</style>
