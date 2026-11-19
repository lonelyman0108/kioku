<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  CONVERT_SCOPE_TEXT,
  ENTRY_TITLE_MAX,
  EntryTitle,
  PLAINTEXT_CREDENTIAL,
  TOPICS_MAX,
  TopicTag,
  VARIANTS_MAX,
  hasHomogeneousRealms,
  isProtectedPersonalEntry,
  needsSensitiveInboxAlert,
  normalizeWhen,
  placeholderAllowed,
  sensitivityAllowed,
  whenSignature,
  type CircleKind,
  type ConsoleEntryView,
  type EntryListItem,
  type EntryMatch,
  type ProtectTarget,
  type RedactMode,
  type Sensitivity,
  type StrataBand,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { hasUnsavedChanges, useUnsavedChangesGuard } from '../composables/unsavedChanges'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { useNow } from '../composables/useNow'
import { usePlaintextActions } from '../composables/usePlaintextActions'
import type { PlaintextSaveRequest, PlaintextSaveResult } from '../composables/usePlaintextSave'
import { icons } from '../icons'
import { buildKeywordIndex } from '../keywords'
import { entryKindLabels, provenanceLabels, sensitivityLabels } from '../labels'
import type { CredentialLinks, WikiLinkTargets } from '../markdown'
import {
  BOOT_HINT,
  entryText,
  expiryState,
  isBootNode,
  looksPlaintext,
  missingDisclosure,
  originScopeLabel,
  plaintextValues,
  recallText,
  variantPlaintextValues,
  whenLabel,
} from '../memoryDetail'
import { placeholderOf } from '../placeholders'
import {
  addedVariantSpots,
  afterGate,
  joinVariantContents,
  plaintextRejection,
  replaceVariantsValues,
  spotsAfterRejection,
  type PlaintextSpot,
  type SaveFlags,
} from '../plaintextSave'
import { entryRoute } from '../routes'
import {
  hiddenAgain,
  revealedAfterWrite,
  revealedFromEntry,
  stillRevealed,
  withRevealed,
  type RevealedContent,
} from '../secretContent'
import {
  earliestValidTo,
  formatRelative,
  formatShort,
  formatTime,
  fromLocalInput,
  isExpired,
  toLocalInput,
  validToTooSoon,
} from '../time'
import { canManageCredentials } from '../vault'
import ConvertCredentialModal from './ConvertCredentialModal.vue'
import EntryLinksPanel from './EntryLinksPanel.vue'
import FacetWhenPicker from './FacetWhenPicker.vue'
import Hint from './Hint.vue'
import MemoryContent from './MemoryContent.vue'
import MemoryHistory from './MemoryHistory.vue'
import MoveMemoryModal from './MoveMemoryModal.vue'
import PlaintextSaveModal from './PlaintextSaveModal.vue'
import RedactConfirmModal from './RedactConfirmModal.vue'
import FlagTag from './strata/FlagTag.vue'
import NoteLine from './strata/NoteLine.vue'
import PropertyList, { type Property } from './strata/PropertyList.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import ShortIdLine from './strata/ShortIdLine.vue'
import StrataBandTag from './strata/StrataTag.vue'
import StrataStrip from './strata/StrataStrip.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import SwatchOptions from './strata/SwatchOptions.vue'
import { entryBand } from './strata/strata'

interface EditVariant {
  key: number
  when: Record<string, string[]>
  content: string
  contentHidden: boolean
}

const props = withDefaults(
  defineProps<{
    circleId: string
    shortId: string
    circleSlug?: string | null
  }>(),
  { circleSlug: null },
)

const emit = defineEmits<{
  deleted: [shortId: string]
  moved: [entry: ConsoleEntryView, toCircleId: string]
  changed: [entry: ConsoleEntryView, before: ConsoleEntryView]
  open: [shortId: string, targetCircleId?: string]
  band: [band: StrataBand]
}>()

const toast = useToast()
const queryClient = useQueryClient()
const router = useRouter()

const queryKey = computed(() => ['entry', props.circleId, props.shortId] as const)
const entry = useQuery({
  queryKey,
  queryFn: ({ queryKey: [, cid, id] }) =>
    api.entry(cid, id, {
      allVariants: true,
      ...(props.circleSlug ? { circle: props.circleSlug } : {}),
    }),
})

const permissions = useMemoryPermissions(computed(() => props.circleId))
const facets = useQuery({
  queryKey: computed(() => ['facets', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
})

const form = reactive({
  title: '',
  topics: [] as string[],
  disclosure: '',
  priority: 2,
  sensitivity: 'private' as Sensitivity,
  glossary: [] as string[],
  // 有效到，datetime-local 输入框的本地时间；空表示一直有效
  validTo: '',
})

let nextVarKey = 0
const editVariants = ref<EditVariant[]>([])
const editSliceIdx = ref(0)
const readSliceIdx = ref(0)
const compareMode = ref(false)

// 表单是从哪一版载入的：改动与保存时的版本号都以它为准，而不是缓存里最新的那份
const base = ref<ConsoleEntryView | null>(null)

// 显式查看拿到的机密正文，只放在这里，不写进查询的缓存（见 secretContent.ts）。这个组件按短 ID 重建，切走就丢
const revealed = ref<RevealedContent | null>(null)
const revealing = ref(false)

const validToInput = (m: ConsoleEntryView) => (m.validTo ? toLocalInput(m.validTo) : '')

function setEditVariantsFromEntry(m: ConsoleEntryView) {
  editVariants.value = m.variants.map((v) => ({
    key: nextVarKey++,
    when: normalizeWhen(v.when),
    content: v.content ?? '',
    contentHidden: v.contentHidden,
  }))
  if (editSliceIdx.value >= editVariants.value.length) editSliceIdx.value = 0
}

function load(next: ConsoleEntryView) {
  // 换了一条或有了新版本，查看过的就不算了，要再查看一次
  if (!stillRevealed(next, revealed.value)) revealed.value = null
  const m = withRevealed(next, revealed.value)
  base.value = m
  form.title = m.title
  form.topics = [...m.topics]
  form.disclosure = m.disclosure ?? ''
  form.priority = m.priority
  form.sensitivity = m.sensitivity
  form.glossary = [...m.glossary]
  form.validTo = validToInput(m)
  setEditVariantsFromEntry(m)
  if (readSliceIdx.value >= m.variants.length) readSliceIdx.value = 0
}

const normalizedTopics = (items: readonly string[]) => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const clean = raw.trim().toLowerCase()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

const variantsChanged = computed(() => {
  const m = base.value
  if (!m) return false
  if (editVariants.value.length !== m.variants.length) return true
  return editVariants.value.some((v, i) => {
    const orig = m.variants[i]
    if (!orig) return true
    return whenSignature(v.when) !== orig.whenSignature || v.content !== (orig.content ?? '')
  })
})

const dirty = computed(() => {
  const m = base.value
  if (!m) return false
  return (
    form.title !== m.title ||
    normalizedTopics(form.topics).join('\n') !== m.topics.join('\n') ||
    variantsChanged.value ||
    form.disclosure !== (m.disclosure ?? '') ||
    form.priority !== m.priority ||
    form.sensitivity !== m.sensitivity ||
    form.glossary.join('\n') !== m.glossary.join('\n') ||
    form.validTo !== validToInput(m)
  )
})

const now = useNow(30_000)
const expiredNow = computed(() => !!base.value && isExpired(base.value.validTo, now.value))

watch(
  () => entry.data.value,
  (m) => {
    if (!m) return
    if (!base.value) return load(m)
    if (dirty.value) return
    if (m.id !== base.value.id || m.version >= base.value.version) adopt(m)
  },
  { immediate: true },
)

function adopt(m: ConsoleEntryView) {
  const b = base.value
  const newer = !!b && (m.id !== b.id || m.version > b.version)
  load(m)
  if (newer) emit('changed', m, b)
}

function latest(): ConsoleEntryView | null {
  const [m, b] = [entry.data.value, base.value]
  if (!m || !b) return m ?? b
  return m.id !== b.id || m.version >= b.version ? m : b
}

// 有未保存的修改时，切到别的记忆、别的页面、退出登录或关掉标签页之前先确认。换视图或筛选条件时编辑器还在，不用确认
const { leaving } = useUnsavedChangesGuard(dirty, {
  leavesOn: (to, from) =>
    to.query.id !== from.query.id || to.params.circleId !== from.params.circleId,
})
const changedElsewhere = computed(() => {
  const [m, b] = [entry.data.value, base.value]
  return !!m && !!b && (m.id !== b.id || m.version !== b.version)
})

const readVariants = computed(() => base.value?.variants ?? [])
const activeReadVariant = computed(
  () => readVariants.value[readSliceIdx.value] ?? readVariants.value[0] ?? null,
)
const activeEditVariant = computed(
  () => editVariants.value[editSliceIdx.value] ?? editVariants.value[0] ?? null,
)

const entryCircleKind = computed<CircleKind>(() => {
  const m = base.value
  if (!m) return permissions.circleKind.value
  return permissions.kindForCircle(m.circleId, m.circleSlug)
})

const entryStrataBand = computed<StrataBand | null>(() => {
  const m = base.value
  if (!m) return null
  return entryBand(
    { kind: m.kind, circleId: m.circleId, circleKind: entryCircleKind.value },
    { id: props.circleId, kind: permissions.circleKind.value },
  )
})

watch(
  entryStrataBand,
  (band) => {
    if (band) emit('band', band)
  },
  { immediate: true },
)

const recallable = computed(() => !!base.value && base.value.sensitivity !== 'secret')
const recallStat = useQuery({
  queryKey: computed(() => ['entry-recall', props.circleId, base.value?.id] as const),
  queryFn: ({ queryKey: [, cid, id] }) => api.entryRecallStat(cid, id!),
  enabled: recallable,
})
const readOnly = computed(() => (base.value ? permissions.readOnlyReason(base.value) : null))

const mode = ref<'read' | 'edit'>('read')
const preview = ref(false)
watch(
  () => base.value?.contentHidden,
  (hidden) => {
    if (hidden) mode.value = 'read'
  },
)

// 查看机密的正文：服务端记一次访问。结果只放在这个组件里，不写进查询缓存
async function revealContent() {
  const m = base.value
  if (!m || revealing.value) return
  revealing.value = true
  try {
    const view = await api.revealEntry(props.circleId, m.id)
    const current = base.value
    if (!current || view.id !== current.id || view.version < current.version) return
    revealed.value = revealedFromEntry(view)
    adopt(view)
  } catch (err) {
    failed(err, '查看失败')
  } finally {
    revealing.value = false
  }
}

function hideContent() {
  const m = base.value
  if (!m) return
  revealed.value = null
  load(hiddenAgain(m))
}

const minValidTo = ref('')
function startEditing() {
  const m = latest()
  if (m) adopt(m)
  if (base.value?.contentHidden) return
  minValidTo.value = earliestValidTo()
  historyOpen.value = false
  editSliceIdx.value = Math.min(readSliceIdx.value, Math.max(editVariants.value.length - 1, 0))
  mode.value = 'edit'
}

const disclosureInput = ref<{ inputRef: HTMLInputElement | null } | null>(null)
function fillDisclosure() {
  startEditing()
  void nextTick(() => disclosureInput.value?.inputRef?.focus())
}
function cancelEditing() {
  if (dirty.value && !window.confirm('放弃未保存的改动？')) return
  const m = latest()
  if (m) adopt(m)
  mode.value = 'read'
}

// 机密词条的所有切片须保持相同场域
const primaryRealms = computed(() => normalizeWhen(editVariants.value[0]?.when).realm ?? [])
function syncSecretRealms() {
  if (form.sensitivity !== 'secret' || editVariants.value.length <= 1) return
  const baseRealms = primaryRealms.value
  for (let i = 1; i < editVariants.value.length; i++) {
    const slice = editVariants.value[i]!
    const nextWhen = { ...normalizeWhen(slice.when) }
    if (baseRealms.length) nextWhen.realm = [...baseRealms]
    else delete nextWhen.realm
    slice.when = normalizeWhen(nextWhen)
  }
}
watch(
  () => form.sensitivity,
  (s) => s === 'secret' && syncSecretRealms(),
)
watch(primaryRealms, () => syncSecretRealms())

function addEditVariant() {
  if (editVariants.value.length >= VARIANTS_MAX) return
  const when: Record<string, string[]> =
    form.sensitivity === 'secret' && primaryRealms.value.length
      ? { realm: primaryRealms.value }
      : {}
  editVariants.value.push({
    key: nextVarKey++,
    when: normalizeWhen(when),
    content: '',
    contentHidden: false,
  })
  editSliceIdx.value = editVariants.value.length - 1
}

function removeEditVariant(idx: number) {
  if (editVariants.value.length <= 1) return
  editVariants.value.splice(idx, 1)
  if (editSliceIdx.value >= editVariants.value.length) {
    editSliceIdx.value = editVariants.value.length - 1
  }
}

function updateActiveEditWhen(next: Record<string, string[]>) {
  const slice = activeEditVariant.value
  if (!slice) return
  slice.when = normalizeWhen(next)
  if (editVariants.value[0]?.key === slice.key) syncSecretRealms()
}

// 正文里出现别的记忆的关键词时标出来
const glossary = useQuery({
  queryKey: computed(() => ['entry-glossary', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.glossaryIndex(cid),
  staleTime: 60_000,
})
const keywordIndex = computed(() =>
  glossary.data.value ? buildKeywordIndex(glossary.data.value.entries) : null,
)

// 双链跳转解析
const wikiLinks = computed<WikiLinkTargets | null>(() => {
  const m = base.value
  if (!m) return null
  return {
    byShortId: new Map(m.links.map((l) => [l.shortId, { circleId: l.circleId, title: l.title }])),
    href: (sid, targetCircleId) =>
      router.resolve(entryRoute(targetCircleId ?? props.circleId, sid)).href,
  }
})

// 凭据占位符按记忆圈与所有者解析
const ownsCredentials = computed(() => entryCircleKind.value === 'personal')
const credentials = useQuery({
  queryKey: computed(() => ['credentials', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.credentials(cid),
  enabled: ownsCredentials,
  staleTime: 60_000,
})
const credentialLinks = computed<CredentialLinks | null>(() => {
  const items = credentials.data.value?.items
  if (!ownsCredentials.value || !items) return null
  return {
    href: (id) =>
      router.resolve({ name: 'credentials', params: { circleId: props.circleId }, query: { id } })
        .href,
    byIdentifier: new Map(
      items.map((c) => [
        c.identifier,
        { id: c.id, name: c.name, fields: c.fields.map((f) => f.name) },
      ]),
    ),
  }
})
function openCredential(id: string) {
  void router.push({ name: 'credentials', params: { circleId: props.circleId }, query: { id } })
}

const canReference = computed(
  () =>
    !!base.value && placeholderAllowed(entryCircleKind.value, base.value.kind, form.sensitivity),
)
const contentInput = ref<{ textareaRef: HTMLTextAreaElement | null } | null>(null)
const picking = ref(false)
const linkPicking = ref(false)
const linkQuery = ref('')
const caret = ref<{ start: number; end: number; content: string; key: number } | null>(null)
const WHOLE = '*'
const pick = reactive({ credentialId: undefined as string | undefined, field: WHOLE })
const pickItems = computed(() =>
  (credentials.data.value?.items ?? []).map((c) => ({
    label: `${c.name}（${c.identifier}）`,
    value: c.id,
  })),
)
const picked = computed(() => credentials.data.value?.items.find((c) => c.id === pick.credentialId))
const fieldItems = computed(() => [
  { label: '整条凭据', value: WHOLE },
  ...(picked.value?.fields ?? []).map((f) => ({ label: f.name, value: f.name })),
])
const pickedPlaceholder = computed(() =>
  picked.value
    ? placeholderOf(picked.value.identifier, pick.field === WHOLE ? null : pick.field)
    : '',
)
watch(
  () => pick.credentialId,
  () => (pick.field = WHOLE),
)

const linkSearch = useQuery({
  queryKey: computed(() => ['entry-link-search', props.circleId, linkQuery.value.trim()] as const),
  queryFn: async ({ queryKey: [, cid, q] }): Promise<(EntryMatch | EntryListItem)[]> => {
    if (!q) {
      const res = await api.entryList(cid, { limit: 12 })
      return res.items
    }
    const res = await api.searchEntries(cid, q, 12)
    return res.matches
  },
  enabled: linkPicking,
})
const linkCandidates = computed(() =>
  (linkSearch.data.value ?? []).filter((item) => item.shortId !== props.shortId),
)

function captureCaret() {
  const slice = activeEditVariant.value
  const el = contentInput.value?.textareaRef
  caret.value =
    slice && el
      ? { start: el.selectionStart, end: el.selectionEnd, content: slice.content, key: slice.key }
      : slice
        ? {
            start: slice.content.length,
            end: slice.content.length,
            content: slice.content,
            key: slice.key,
          }
        : null
}
function insertAtCaret(text: string) {
  const slice = activeEditVariant.value
  if (!slice || !text) return
  const at = caret.value
  const [start, end] =
    at && at.key === slice.key && at.content === slice.content
      ? [at.start, at.end]
      : [slice.content.length, slice.content.length]
  slice.content = slice.content.slice(0, start) + text + slice.content.slice(end)
  afterPick = start + text.length
}

function startPicking() {
  captureCaret()
  pick.credentialId = undefined
  pick.field = WHOLE
  picking.value = true
}
function insertPlaceholder() {
  const text = pickedPlaceholder.value
  if (!text) return
  insertAtCaret(text)
  picking.value = false
}

function startLinkPicking() {
  captureCaret()
  linkQuery.value = ''
  linkPicking.value = true
}
function insertWikiLink(shortId: string, title: string) {
  const safeTitle = title.replace(/[|\]]/g, ' ').trim()
  const syntax =
    safeTitle && safeTitle !== shortId ? `[[${shortId}|${safeTitle}]]` : `[[${shortId}]]`
  insertAtCaret(syntax)
  linkPicking.value = false
}

let afterPick: number | null = null
function restoreCaret() {
  const at = afterPick
  afterPick = null
  if (at === null) return
  setTimeout(() => {
    const el = contentInput.value?.textareaRef
    el?.focus()
    el?.setSelectionRange(at, at)
  }, 50)
}

const historyOpen = ref(false)
const moveOpen = ref(false)

async function onMoved(next: ConsoleEntryView, targetCircleId: string) {
  const key = ['entry', props.circleId, next.shortId]
  if (revealed.value?.id === next.id) revealed.value = { ...revealed.value, version: next.version }
  if (next.circleId === props.circleId) {
    await queryClient.cancelQueries({ queryKey: key, exact: true })
    queryClient.setQueryData(key, next)
    load(next)
  } else {
    void queryClient.invalidateQueries({ queryKey: ['entry', next.circleId, next.shortId] })
  }
  void queryClient.invalidateQueries({ queryKey: ['entry-history', props.circleId, next.id] })
  void queryClient.invalidateQueries({ queryKey: ['activity-event', props.circleId] })
  emit('moved', next, targetCircleId)
}

// 个人圈不设公开：选项里也不给
const sensitivityOptions = computed(() =>
  permissions.sensitivities.value
    .filter(
      (value) => !base.value || sensitivityAllowed(entryCircleKind.value, base.value.kind, value),
    )
    .map((value) => ({
      value,
      label: sensitivityLabels[value],
      band: entryStrataBand.value ?? ('primary' as const),
      sensitivity: value,
    })),
)
const saving = ref(false)
const deleting = ref<ConsoleEntryView | null>(null)

function failed(err: unknown, fallback: string) {
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })
}

const downgradeWarning = ref(false)
const PLAINTEXT_DOWNGRADE_TEXT =
  '降级后，正文将写入历史、全文索引和向量，无法撤回。请先将凭据转存，并确认正文不含密码或令牌。'
const plaintextGate = ref<PlaintextSaveRequest | null>(null)
const canConvert = computed(() => canManageCredentials(permissions.role.value))
const canSaveAnyway = computed(() => !readOnly.value)

const hasDuplicateWhen = computed(() => {
  const seen = new Set<string>()
  for (const v of editVariants.value) {
    const sig = whenSignature(v.when)
    if (seen.has(sig)) return true
    seen.add(sig)
  }
  return false
})
const hasEmptySlice = computed(() => editVariants.value.some((v) => !v.content.trim()))

function formProblem(
  values: { title: string; validTo: string; topics?: readonly string[] },
  m: ConsoleEntryView,
) {
  const title = EntryTitle.safeParse(values.title)
  if (values.title !== m.title && !title.success) {
    return title.error.issues[0]?.message ?? '标题格式错误'
  }
  if (values.topics) {
    for (const raw of values.topics) {
      const parsed = TopicTag.safeParse(raw)
      if (!parsed.success) return parsed.error.issues[0]?.message ?? '主题标签格式错误'
    }
    if (normalizedTopics(values.topics).length > TOPICS_MAX) {
      return `主题标签最多 ${TOPICS_MAX} 个`
    }
  }
  if (hasEmptySlice.value) return '每个变体切片的正文不能为空'
  if (hasDuplicateWhen.value) return '同一条记忆下不能存在适用切面相同的变体切片'
  if (form.sensitivity === 'secret' && !hasHomogeneousRealms(editVariants.value)) {
    return '机密记忆的所有变体切片须保持相同的场域'
  }
  if (values.validTo === validToInput(m) || !values.validTo) return null
  if (!fromLocalInput(values.validTo)) return '有效期的日期和时间不完整'
  if (validToTooSoon(values.validTo)) {
    minValidTo.value = earliestValidTo()
    return '有效期须晚于当前时间至少一分钟'
  }
  return null
}

function gateFor(
  m: ConsoleEntryView,
  content: string,
  spots: PlaintextSpot[],
  rejected: boolean,
): PlaintextSaveRequest {
  return {
    content,
    shortId: m.shortId,
    title: form.title,
    circleKind: entryCircleKind.value,
    kind: m.kind,
    sensitivity: form.sensitivity,
    spots,
    rejected,
  }
}

function requestSave() {
  const m = base.value
  if (!m || saving.value) return
  const problem = formProblem(form, m)
  if (problem) {
    toast.add({ title: problem, color: 'error' })
    return
  }
  const downgrade = m.sensitivity === 'secret' && form.sensitivity !== 'secret'
  if (downgrade) {
    const joined = joinVariantContents(editVariants.value) ?? ''
    if (PLAINTEXT_CREDENTIAL.test(joined)) {
      downgradeWarning.value = true
      return
    }
  } else if (form.sensitivity !== 'secret' && variantsChanged.value) {
    const { content, spots } = addedVariantSpots(m.variants, editVariants.value)
    if (spots.length) {
      plaintextGate.value = gateFor(m, content, spots, false)
      return
    }
  }
  void save()
}

function confirmDowngrade() {
  if (!downgradeWarning.value || saving.value) return
  downgradeWarning.value = false
  void save({ allowPlaintext: true })
}

function onGateProceed(result: PlaintextSaveResult) {
  const m = base.value
  if (!m) return
  const beforeJoined = joinVariantContents(m.variants)
  const currentJoined = joinVariantContents(editVariants.value) ?? ''
  const next = afterGate(beforeJoined, currentJoined, result)
  if (result.replacements.length) {
    editVariants.value = replaceVariantsValues(editVariants.value, result.replacements)
  }
  if (next.kind === 'reopen') {
    plaintextGate.value = { ...gateFor(m, next.content, next.spots, false), ignored: next.ignored }
    return
  }
  void save(next.flags)
}

async function save(flags: SaveFlags = {}) {
  const m = base.value
  if (!m || saving.value) return
  const sent = {
    title: form.title,
    topics: normalizedTopics(form.topics),
    disclosure: form.disclosure,
    priority: form.priority,
    sensitivity: form.sensitivity,
    glossary: [...form.glossary],
    validTo: form.validTo,
    variants: editVariants.value.map((v, sortOrder) => ({
      when: normalizeWhen(v.when),
      content: v.content,
      sortOrder,
    })),
    variantsDirty: variantsChanged.value,
  }
  const problem = formProblem(sent, m)
  if (problem) {
    toast.add({ title: problem, color: 'error' })
    return
  }
  const title = EntryTitle.safeParse(sent.title)
  const topicsChanged = sent.topics.join('\n') !== m.topics.join('\n')
  const validToChanged = sent.validTo !== validToInput(m)
  const validTo = sent.validTo ? fromLocalInput(sent.validTo) : null
  const beforeJoined = joinVariantContents(m.variants)
  const sentJoined = joinVariantContents(sent.variants) ?? ''
  saving.value = true
  try {
    const next = await api.updateEntry(props.circleId, {
      id: m.shortId,
      expectedVersion: m.version,
      ...(title.success && title.data !== m.title ? { title: title.data } : {}),
      ...(sent.variantsDirty ? { variants: sent.variants } : {}),
      ...(topicsChanged ? { topics: sent.topics } : {}),
      ...((sent.disclosure.trim() || null) !== (m.disclosure ?? null)
        ? { disclosure: sent.disclosure.trim() || null }
        : {}),
      priority: sent.priority,
      sensitivity: sent.sensitivity,
      glossaryAdd: sent.glossary.filter((k) => !m.glossary.includes(k)),
      glossaryRemove: m.glossary.filter((k) => !sent.glossary.includes(k)),
      ...(validToChanged ? { validTo } : {}),
      ...flags,
    })
    await queryClient.cancelQueries({ queryKey: queryKey.value })
    queryClient.setQueryData(queryKey.value, next)
    revealed.value = revealedAfterWrite(next, sent.variants, revealed.value)
    const saved = withRevealed(next, revealed.value)
    base.value = saved
    if (form.title === sent.title) form.title = saved.title
    if (normalizedTopics(form.topics).join('\n') === sent.topics.join('\n')) {
      form.topics = [...saved.topics]
    }
    if (!editVariants.value.some((v, i) => v.content !== sent.variants[i]?.content)) {
      setEditVariantsFromEntry(saved)
    }
    if (form.disclosure === sent.disclosure) form.disclosure = next.disclosure ?? ''
    if (form.priority === sent.priority) form.priority = next.priority
    if (form.sensitivity === sent.sensitivity) form.sensitivity = next.sensitivity
    if (form.glossary.join('\n') === sent.glossary.join('\n')) form.glossary = [...next.glossary]
    if (form.validTo === sent.validTo) form.validTo = validToInput(next)
    toast.add({ title: '已保存', color: 'success' })
    if (!dirty.value) mode.value = 'read'
    void queryClient.invalidateQueries({ queryKey: ['entry-history', props.circleId, next.id] })
    void queryClient.invalidateQueries({ queryKey: ['activity-event', props.circleId] })
    emit('changed', next, m)
  } catch (err) {
    const findings = plaintextRejection(err)
    const currentJoined = joinVariantContents(editVariants.value) ?? ''
    const gate = findings && spotsAfterRejection(beforeJoined, sentJoined, currentJoined, findings)
    if (gate) {
      plaintextGate.value = gateFor(m, gate.content, gate.spots, true)
      return
    }
    failed(err, '保存失败')
    if (err instanceof ApiError && err.status === 409) void entry.refetch()
  } finally {
    saving.value = false
  }
}

async function remove() {
  const m = deleting.value
  if (!m) return
  try {
    await api.deleteEntry(props.circleId, m.shortId, m.version)
    deleting.value = null
    toast.add({ title: '已删除', color: 'success' })
    leaving.value = true
    hasUnsavedChanges.value = false
    emit('deleted', m.shortId)
  } catch (err) {
    failed(err, '删除失败')
    if (err instanceof ApiError && err.status === 409) {
      deleting.value = null
      void entry.refetch()
    }
  }
}

const titleEl = ref<HTMLElement | null>(null)
defineExpose({ focusTitle: () => titleEl.value?.focus() })

const shownSensitivity = computed(() =>
  mode.value === 'edit' ? form.sensitivity : (base.value?.sensitivity ?? 'private'),
)
const shownPriority = computed(() =>
  mode.value === 'edit' ? form.priority : (base.value?.priority ?? 0),
)

const expiry = computed(() => expiryState(base.value?.validTo ?? null, now.value))
const bootNode = computed(() => !!base.value && isBootNode(base.value, now.value))
const missingNote = computed(() => (base.value ? missingDisclosure(base.value, now.value) : null))
const plaintext = computed(() => {
  const m = base.value
  return m && looksPlaintext(m) ? plaintextValues(m) : null
})
const hasPiiFinding = (m: ConsoleEntryView | null | undefined) =>
  !!m?.variants.some((v) => v.sensitiveFindings?.some((f) => f.category === 'pii'))

const unprotectedPii = computed(() => {
  const m = base.value
  const hasPii = hasPiiFinding(m)
  return (
    !!m &&
    !plaintext.value &&
    !m.plaintextIgnored &&
    hasPii &&
    needsSensitiveInboxAlert({
      circleKind: entryCircleKind.value,
      sensitivity: m.sensitivity,
      provenance: m.provenance,
      sensitiveCredential: false,
      sensitivePii: hasPii,
      plaintextIgnored: m.plaintextIgnored,
    })
  )
})
const protectedPii = computed(() => {
  const m = base.value
  return (
    !!m &&
    !plaintext.value &&
    !m.plaintextIgnored &&
    m.sensitivity !== 'secret' &&
    hasPiiFinding(m) &&
    isProtectedPersonalEntry(entryCircleKind.value, m.sensitivity, m.provenance)
  )
})

const convertOpen = ref(false)
const redactOpen = ref(false)
const convertible = computed(
  () =>
    !!base.value &&
    placeholderAllowed(entryCircleKind.value, base.value.kind, base.value.sensitivity),
)
const plaintextActions = usePlaintextActions(computed(() => props.circleId))
async function setPlaintextIgnored(ignored: boolean) {
  const m = base.value
  if (!m) return
  const view = await (ignored ? plaintextActions.ignore(m) : plaintextActions.unignore(m))
  if (view && view.id === base.value?.id) adopt(view)
}
async function protectCurrent(target: ProtectTarget) {
  const m = base.value
  if (!m) return
  const view = await plaintextActions.protect(
    { id: m.id, version: m.version, inPersonal: entryCircleKind.value === 'personal' },
    target,
  )
  if (!view || view.id !== base.value?.id) return
  if (view.circleId !== m.circleId) await onMoved(view, view.circleId)
  else adopt(view)
}
async function redactCurrent(redactMode: RedactMode) {
  const m = base.value
  if (!m) return
  try {
    const view = await plaintextActions.redact(m, redactMode)
    if (view && view.id === base.value?.id) adopt(view)
  } finally {
    redactOpen.value = false
  }
}
function onConverted(changed: ConsoleEntryView) {
  if (changed.id === base.value?.id) adopt(changed)
}

const clientName = (id: string) => permissions.clients.data.value?.find((a) => a.id === id)?.name
const properties = computed<Property[][]>(() => {
  const m = base.value
  if (!m) return []
  return [
    [
      { key: 'band', label: '地层' },
      { key: 'kind', label: '类型', value: entryKindLabels[m.kind] },
      { key: 'sensitivity', label: '敏感级' },
      { key: 'priority', label: '优先级' },
    ],
    [
      { key: 'topics', label: '主题', stacked: true },
      { key: 'disclosure', label: '触发场景', stacked: true },
      { key: 'glossary', label: '关键词', stacked: true },
      { key: 'validity', label: '有效期' },
    ],
    [
      { key: 'provenance', label: '来源', value: provenanceLabels[m.provenance] },
      { key: 'origin', label: '作用域', value: originScopeLabel(m.originScope, clientName) },
      { key: 'version', label: '版本', value: m.version },
      { key: 'created', label: '创建' },
      { key: 'updated', label: '更新' },
      {
        key: 'recall',
        label: '召回',
        value: recallText(
          recallable.value ? recallStat.data.value : undefined,
          { secret: !recallable.value, boot: bootNode.value },
          now.value,
        ),
      },
    ],
  ]
})

function variantPlaintext(content: string | null, ignored: boolean): string[] | null {
  if (!base.value) return null
  const values = variantPlaintextValues(content, base.value.sensitivity, ignored)
  return values.length ? values : null
}

function previewVariantContent(): string {
  return activeEditVariant.value?.content ?? entryText(base.value ?? {})
}
</script>

<template>
  <article class="memory-detail">
    <StrataStrip
      v-if="base && entryStrataBand"
      :band="entryStrataBand"
      :sensitivity="shownSensitivity"
    />
    <header class="detail-head">
      <div class="detail-nav"><slot name="nav" /></div>
      <div class="detail-title">
        <h1 ref="titleEl" tabindex="-1">{{ base?.title ?? shortId }}</h1>
      </div>
      <template v-if="base && entryStrataBand">
        <div class="detail-tag">
          <StrataBandTag :band="entryStrataBand" :sensitivity="shownSensitivity" />
          <span class="tag-priority">P{{ shownPriority }}</span>
          <span v-if="readVariants.length > 1" class="tag-variants">
            <UIcon :name="icons.variants" class="size-3.5" />
            <span>{{ readVariants.length }} 切片</span>
          </span>
          <span v-if="bootNode" class="inline-flex items-center gap-1.5">
            <span class="boot-flag">启动加载</span>
            <Hint>{{ BOOT_HINT }}</Hint>
          </span>
          <span
            v-if="base.validTo"
            :class="{ 'text-warning': expiry === 'soon' || expiry === 'expired' }"
            :title="`有效期至 ${formatTime(base.validTo)}`"
          >
            {{ expiredNow ? '已过期' : `${formatShort(base.validTo)} 到期` }}
          </span>
        </div>
        <div class="detail-actions">
          <template v-if="mode === 'read'">
            <UTooltip
              v-if="!readOnly"
              :text="base.contentHidden ? '先查看正文' : undefined"
              :disabled="!base.contentHidden"
            >
              <UButton size="sm" :disabled="base.contentHidden" @click="startEditing">编辑</UButton>
            </UTooltip>
            <UButton
              size="sm"
              color="primary"
              variant="outline"
              :class="{ 'bg-elevated': historyOpen }"
              :aria-pressed="historyOpen"
              @click="historyOpen = !historyOpen"
            >
              历史
            </UButton>
            <UButton
              v-if="!readOnly"
              size="sm"
              color="primary"
              variant="outline"
              @click="moveOpen = true"
            >
              迁移
            </UButton>
            <UButton
              v-if="!readOnly"
              size="sm"
              color="error"
              variant="outline"
              @click="deleting = base"
            >
              删除
            </UButton>
          </template>
          <template v-else>
            <FlagTag v-if="dirty" class="dirty-flag" status="unsaved" />
            <UButton
              size="sm"
              :loading="saving"
              :disabled="!dirty || hasEmptySlice || hasDuplicateWhen"
              @click="requestSave"
            >
              保存
            </UButton>
            <UButton size="sm" color="primary" variant="outline" @click="cancelEditing">
              取消
            </UButton>
          </template>
        </div>
      </template>
    </header>

    <div v-if="entry.isPending.value" class="detail-read space-y-3">
      <USkeleton class="h-6 w-1/2" />
      <USkeleton class="h-40 w-full" />
    </div>
    <div v-else-if="!base" class="detail-read">
      <ReadFailureNote :query="entry" />
    </div>
    <div v-else class="detail-main">
      <div class="detail-read">
        <ReadFailureNote v-if="entry.isError.value" :query="entry" />
        <NoteLine v-else-if="changedElsewhere && dirty" tone="warning">
          这条记忆已在别处修改，或已删除并重新创建。保存将提示冲突，可先复制当前改动，再载入新版本。
          <template #actions>
            <UButton
              size="sm"
              color="primary"
              variant="outline"
              @click="entry.data.value && adopt(entry.data.value)"
            >
              载入新版本
            </UButton>
          </template>
        </NoteLine>
        <NoteLine v-if="readOnly">{{ readOnly }}</NoteLine>
        <NoteLine v-if="expiredNow" tone="warning">
          这条记忆已过期，不再召回，也不进启动加载。可在「已过期」中恢复生效。
        </NoteLine>
        <NoteLine v-else-if="expiry === 'soon' && mode === 'read'" tone="warning">
          这条记忆将于 {{ formatTime(base.validTo!) }} 到期，到期后不再召回，也不进启动加载。
        </NoteLine>

        <!-- 编辑：就地改多切面原文，可以并排预览与插双链 -->
        <template v-if="mode === 'edit'">
          <div class="grid gap-3 pb-3 sm:grid-cols-2">
            <UFormField label="标题" class="edit-title">
              <template #hint><Hint>目录、列表与搜索显示标题；改标题不影响短 ID</Hint></template>
              <UInput v-model="form.title" :maxlength="ENTRY_TITLE_MAX" class="w-full" />
            </UFormField>
            <UFormField label="主题">
              <template #hint><Hint>用于分组归类与筛选</Hint></template>
              <UInputTags v-model="form.topics" class="w-full" placeholder="输入后回车添加" />
            </UFormField>
          </div>

          <div class="edit-head">
            <div class="slice-bar" role="tablist" aria-label="内容切片">
              <button
                v-for="(slice, idx) in editVariants"
                :key="slice.key"
                type="button"
                role="tab"
                :aria-selected="idx === editSliceIdx"
                class="slice-tab"
                :class="{ active: idx === editSliceIdx }"
                @click="editSliceIdx = idx"
              >
                <span>{{ whenLabel(slice.when, facets.data.value) }}</span>
                <UButton
                  v-if="editVariants.length > 1"
                  type="button"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.cancel"
                  aria-label="删除此切片"
                  @click.stop="removeEditVariant(idx)"
                />
              </button>
              <UButton
                v-if="editVariants.length < VARIANTS_MAX"
                type="button"
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.add"
                @click="addEditVariant"
              >
                添加切片
              </UButton>
            </div>
            <div class="edit-tools">
              <UButton
                type="button"
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.links"
                @click="startLinkPicking"
              >
                插入双链
              </UButton>
              <UTooltip
                :text="canReference ? undefined : '仅个人圈中敏感级不低于私密的正式词条可引用凭据'"
                :disabled="canReference"
              >
                <UButton
                  type="button"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :disabled="!canReference"
                  @click="startPicking"
                >
                  插入凭据引用
                </UButton>
              </UTooltip>
              <USwitch v-model="preview" size="sm" label="预览" />
            </div>
          </div>

          <div v-if="activeEditVariant" class="space-y-3">
            <FacetWhenPicker
              :model-value="activeEditVariant.when"
              :circle-id="circleId"
              :vocabulary="facets.data.value"
              :locked-realms="
                form.sensitivity === 'secret' && editSliceIdx > 0 ? primaryRealms : undefined
              "
              @update:model-value="updateActiveEditWhen"
            />
            <NoteLine v-if="hasDuplicateWhen" tone="warning">
              存在适用切面相同的变体切片，请调整条件后再保存。
            </NoteLine>
            <div class="grid gap-3" :class="preview ? 'xl:grid-cols-2' : ''">
              <UTextarea
                ref="contentInput"
                v-model="activeEditVariant.content"
                :rows="18"
                autoresize
                :maxrows="40"
                class="w-full font-mono"
                aria-label="正文"
              />
              <div v-if="preview" class="edit-preview">
                <MemoryContent
                  :content="previewVariantContent()"
                  :wiki-links="wikiLinks"
                  :credentials="credentialLinks"
                  @credential="openCredential"
                  @open="(sid, cid) => emit('open', sid, cid)"
                />
              </div>
            </div>
          </div>
        </template>

        <MemoryHistory
          v-else-if="historyOpen"
          :circle-id="circleId"
          :entry-id="base.id"
          :can-restore="!readOnly && mode === 'read'"
        />

        <!-- 阅读：状态提示和渲染后的正文 -->
        <template v-else>
          <NoteLine v-if="plaintext" tone="error">
            正文疑似包含明文凭据<Hint>建议转存为凭据，正文改用占位符。</Hint>
            <template v-if="!readOnly && !convertible" #detail>{{ CONVERT_SCOPE_TEXT }}</template>
            <template v-if="!readOnly" #actions>
              <UButton
                v-if="convertible"
                size="sm"
                color="primary"
                variant="outline"
                @click="convertOpen = true"
              >
                转存为凭据
              </UButton>
              <UButton
                size="sm"
                color="primary"
                variant="outline"
                :loading="plaintextActions.busy.value === base.id"
                @click="setPlaintextIgnored(true)"
              >
                忽略
              </UButton>
              <UButton
                size="sm"
                color="primary"
                variant="outline"
                :to="{ name: 'credentials', params: { circleId } }"
              >
                查看凭据
              </UButton>
            </template>
          </NoteLine>
          <NoteLine v-else-if="unprotectedPii" tone="warning">
            正文疑似包含个人信息，当前记忆圈或可见范围较宽
            <Hint>
              建议保留原值并移入个人圈私密或设为机密，外发至模型与嵌入前会自动脱敏；误粘贴的冗余文本可抹除敏感段。
            </Hint>
            <template v-if="!readOnly" #actions>
              <UButton
                size="sm"
                color="primary"
                variant="outline"
                :loading="plaintextActions.busy.value === base.id"
                @click="protectCurrent('personal_private')"
              >
                {{ entryCircleKind === 'personal' ? '设为私密' : '移入个人圈私密' }}
              </UButton>
              <UButton
                v-if="permissions.sensitivities.value.includes('secret')"
                size="sm"
                color="neutral"
                variant="outline"
                :loading="plaintextActions.busy.value === base.id"
                @click="protectCurrent('secret')"
              >
                设为机密
              </UButton>
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                :loading="plaintextActions.busy.value === base.id"
                @click="redactOpen = true"
              >
                抹除敏感段
              </UButton>
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                :loading="plaintextActions.busy.value === base.id"
                @click="setPlaintextIgnored(true)"
              >
                忽略
              </UButton>
            </template>
          </NoteLine>
          <NoteLine v-else-if="protectedPii">
            已处于个人圈私密边界，外发脱敏与权限控制已生效。
          </NoteLine>
          <NoteLine v-else-if="base.plaintextIgnored && base.sensitivity !== 'secret'">
            已忽略明文提醒
            <template v-if="!readOnly" #actions>
              <UButton
                size="sm"
                color="primary"
                variant="outline"
                :loading="plaintextActions.busy.value === base.id"
                @click="setPlaintextIgnored(false)"
              >
                撤销忽略
              </UButton>
            </template>
          </NoteLine>
          <NoteLine
            v-if="missingNote"
            :tone="missingNote.tone === 'warning' ? 'warning' : 'neutral'"
          >
            {{ missingNote.text }}<Hint>{{ missingNote.hint }}</Hint>
            <template v-if="!readOnly && !base.contentHidden" #actions>
              <UButton size="sm" color="primary" variant="outline" @click="fillDisclosure">
                去补全
              </UButton>
            </template>
          </NoteLine>
          <NoteLine v-if="base.otherVariants.length">
            另有 {{ base.otherVariants.length }} 个未展开的切面切片：{{
              base.otherVariants.map((o) => whenLabel(o.when, facets.data.value)).join('、')
            }}
          </NoteLine>

          <template v-if="base.contentHidden">
            <div class="secret-mask" role="img" aria-label="机密内容已加密存储">
              <i style="width: 94%" />
              <i style="width: 82%" />
              <i style="width: 88%" />
              <i style="width: 46%" />
            </div>
            <NoteLine>
              机密内容已加密存储
              <template #actions>
                <UButton
                  size="sm"
                  color="primary"
                  variant="outline"
                  :loading="revealing"
                  @click="revealContent"
                >
                  查看正文
                </UButton>
                <Hint>查看会记录一次访问。</Hint>
              </template>
            </NoteLine>
          </template>
          <template v-else>
            <NoteLine v-if="base.sensitivity === 'secret'">
              查看会记录一次访问。
              <template #actions>
                <UButton size="sm" color="primary" variant="outline" @click="hideContent">
                  隐藏正文
                </UButton>
              </template>
            </NoteLine>

            <div v-if="readVariants.length >= 2" class="read-variant-bar">
              <div class="slice-bar" role="tablist" aria-label="切面切片">
                <button
                  v-for="(v, idx) in readVariants"
                  :key="v.id"
                  type="button"
                  role="tab"
                  :aria-selected="!compareMode && idx === readSliceIdx"
                  class="slice-tab"
                  :class="{ active: !compareMode && idx === readSliceIdx }"
                  @click="((compareMode = false), (readSliceIdx = idx))"
                >
                  {{ whenLabel(v.when, facets.data.value) }}
                </button>
              </div>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.splitView"
                :aria-pressed="compareMode"
                @click="compareMode = !compareMode"
              >
                并排对比
              </UButton>
            </div>
            <p
              v-else-if="readVariants.length === 1 && Object.keys(readVariants[0]!.when).length > 0"
              class="single-when-note"
            >
              <UIcon :name="icons.facets" class="size-3.5" />
              <span>适用切面：{{ whenLabel(readVariants[0]!.when, facets.data.value) }}</span>
            </p>

            <div v-if="compareMode && readVariants.length >= 2" class="compare-grid">
              <section v-for="v in readVariants" :key="v.id" class="compare-card">
                <header class="compare-head">
                  {{ whenLabel(v.when, facets.data.value) }}
                </header>
                <div class="compare-body">
                  <MemoryContent
                    :content="v.content ?? ''"
                    :keywords="keywordIndex"
                    :self="base.shortId"
                    :wiki-links="wikiLinks"
                    :credentials="credentialLinks"
                    :plaintext="variantPlaintext(v.content, v.plaintextIgnored)"
                    @open="(sid, cid) => emit('open', sid, cid)"
                    @credential="openCredential"
                  />
                </div>
              </section>
            </div>
            <MemoryContent
              v-else-if="activeReadVariant"
              :content="activeReadVariant.content ?? ''"
              :keywords="keywordIndex"
              :self="base.shortId"
              :wiki-links="wikiLinks"
              :credentials="credentialLinks"
              :plaintext="
                variantPlaintext(activeReadVariant.content, activeReadVariant.plaintextIgnored)
              "
              @open="(sid, cid) => emit('open', sid, cid)"
              @credential="openCredential"
            />
          </template>

          <EntryLinksPanel
            v-if="base.links.length"
            :circle-id="circleId"
            :circle-kind="entryCircleKind"
            :links="base.links"
            @open="(sid, cid) => emit('open', sid, cid)"
          />
        </template>
      </div>

      <aside class="detail-side">
        <div v-if="mode === 'edit'" class="edit-fields">
          <div class="edit-layer">
            <span>地层</span>
            <StrataSwatch v-if="entryStrataBand" :band="entryStrataBand" plain label="band" />
          </div>
          <UFormField label="优先级" help="0 最重要">
            <UInputNumber v-model="form.priority" :min="0" :max="99" class="w-full" />
          </UFormField>
          <div>
            <p class="edit-label">敏感级</p>
            <SwatchOptions
              v-model="form.sensitivity"
              label="敏感级"
              :options="sensitivityOptions"
            />
          </div>
          <UFormField label="触发场景">
            <template #hint><Hint>什么场景下应该想起这条记忆</Hint></template>
            <UInput ref="disclosureInput" v-model="form.disclosure" class="w-full" />
          </UFormField>
          <UFormField label="关键词">
            <template #hint><Hint>召回时按关键词命中，至少两个字</Hint></template>
            <UInputTags v-model="form.glossary" class="w-full" />
          </UFormField>
          <UFormField label="有效期">
            <template #hint>
              <Hint>
                仅对阶段性内容设置；到期后不再召回，也不进启动加载，历史中仍可查看，之后可在「已过期」中恢复生效。留空表示长期有效。
              </Hint>
            </template>
            <UInput
              v-model="form.validTo"
              type="datetime-local"
              :min="minValidTo"
              aria-label="有效期"
              class="w-full"
              @focus="minValidTo = earliestValidTo()"
            />
            <UButton
              v-if="form.validTo"
              class="mt-1"
              size="sm"
              color="neutral"
              variant="ghost"
              @click="form.validTo = ''"
            >
              改为长期有效
            </UButton>
          </UFormField>
          <PropertyList
            :groups="[
              [
                { key: 'version', label: '版本', value: base.version },
                { key: 'updated', label: '更新' },
              ],
            ]"
          >
            <template #version
              ><span class="font-mono">{{ base.version }}</span></template
            >
            <template #updated>
              <time :datetime="base.updatedAt" :title="formatTime(base.updatedAt)">
                {{ formatRelative(base.updatedAt) }}
              </time>
            </template>
          </PropertyList>
        </div>
        <PropertyList v-else :groups="properties">
          <template #band>
            <StrataSwatch v-if="entryStrataBand" :band="entryStrataBand" plain label="band" />
          </template>
          <template #sensitivity>
            <StrataSwatch
              v-if="entryStrataBand"
              :band="entryStrataBand"
              :sensitivity="base.sensitivity"
              label="sensitivity"
            />
          </template>
          <template #priority>
            <span class="me-1.5 font-mono">P{{ base.priority }}</span>
            <span v-if="bootNode" class="boot-flag" :title="BOOT_HINT"> 启动加载 </span>
          </template>
          <template #topics>
            <span v-if="base.topics.length" class="keywords">
              <span v-for="topic in base.topics" :key="topic">{{ topic }}</span>
            </span>
            <span v-else class="text-muted">–</span>
          </template>
          <template #disclosure>
            <template v-if="!missingNote">{{ base.disclosure }}</template>
            <span v-else :class="missingNote.tone === 'warning' ? 'text-warning' : 'text-muted'">
              {{ missingNote.short }}
            </span>
          </template>
          <template #glossary>
            <span v-if="base.glossary.length" class="keywords">
              <span v-for="keyword in base.glossary" :key="keyword">{{ keyword }}</span>
            </span>
            <span v-else class="text-muted">–</span>
          </template>
          <template #validity>
            <span
              :class="{ 'text-warning': expiry === 'soon' || expiry === 'expired' }"
              :title="base.validTo ? formatTime(base.validTo) : undefined"
            >
              {{ base.validTo ? formatShort(base.validTo) : '长期有效' }}
            </span>
          </template>
          <template #version
            ><span class="font-mono">{{ base.version }}</span></template
          >
          <template #created>
            <time :datetime="base.createdAt" :title="formatTime(base.createdAt)">
              {{ formatRelative(base.createdAt) }}
            </time>
          </template>
          <template #updated>
            <time :datetime="base.updatedAt" :title="formatTime(base.updatedAt)">
              {{ formatRelative(base.updatedAt) }}
            </time>
          </template>
        </PropertyList>
      </aside>
    </div>

    <ShortIdLine
      v-if="base"
      :value="base.shortId"
      :circle-slug="base.circleId !== circleId ? base.circleSlug : null"
    />

    <template v-if="base">
      <MoveMemoryModal
        v-model:open="moveOpen"
        :circle-id="circleId"
        :entry="base"
        @done="onMoved"
      />

      <ConvertCredentialModal
        v-model:open="convertOpen"
        :circle-id="circleId"
        :short-id="base.shortId"
        @converted="onConverted"
      />

      <UModal v-model:open="linkPicking" title="插入双链" @after:leave="restoreCaret">
        <template #body>
          <div class="space-y-3">
            <UInput
              v-model="linkQuery"
              placeholder="搜索标题或短 ID"
              aria-label="搜索要关联的记忆"
              class="w-full"
              autofocus
            />
            <div v-if="linkSearch.isPending.value" class="space-y-2">
              <USkeleton v-for="n in 3" :key="n" class="h-9 w-full" />
            </div>
            <ul v-else-if="linkCandidates.length" class="link-pick-list">
              <li v-for="item in linkCandidates" :key="item.shortId">
                <button
                  type="button"
                  class="link-pick-item"
                  @click="insertWikiLink(item.shortId, item.title)"
                >
                  <span class="truncate">{{ item.title }}</span>
                  <code class="link-pick-id">{{ item.shortId }}</code>
                </button>
              </li>
            </ul>
            <p v-else class="text-sm text-muted">没有匹配的记忆</p>
          </div>
        </template>
      </UModal>

      <UModal v-model:open="picking" title="插入凭据引用" @after:leave="restoreCaret">
        <template #body>
          <div class="space-y-4">
            <p v-if="!pickItems.length" class="text-sm text-muted">
              暂无凭据。请先在「凭据」页新建。
            </p>
            <template v-else>
              <UFormField label="凭据">
                <USelect v-model="pick.credentialId" :items="pickItems" class="w-full" />
              </UFormField>
              <UFormField label="字段" help="引用整条时，Agent 获取全部字段">
                <USelect v-model="pick.field" :items="fieldItems" class="w-full" />
              </UFormField>
              <p v-if="pickedPlaceholder" class="text-sm">
                将插入 <code>{{ pickedPlaceholder }}</code>
              </p>
            </template>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="picking = false">取消</UButton>
            <UButton :disabled="!pickedPlaceholder" @click="insertPlaceholder">插入</UButton>
          </div>
        </template>
      </UModal>

      <UModal
        :open="downgradeWarning"
        title="正文疑似包含明文凭据，仍要降级？"
        @update:open="(v) => !v && (downgradeWarning = false)"
      >
        <template #body>
          <p class="text-sm">
            {{ PLAINTEXT_DOWNGRADE_TEXT
            }}<Hint>检测规则可能误判。确认正文不含明文后，可继续降级。</Hint>
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="downgradeWarning = false"
              >取消</UButton
            >
            <UButton color="error" @click="confirmDowngrade">确认不含明文并降级</UButton>
          </div>
        </template>
      </UModal>

      <PlaintextSaveModal
        v-model:request="plaintextGate"
        :circle-id="circleId"
        :can-convert="canConvert"
        :can-save-anyway="canSaveAnyway"
        @proceed="onGateProceed"
      />

      <RedactConfirmModal
        :open="redactOpen"
        :title="base.title"
        :busy="plaintextActions.busy.value === base.id"
        @close="redactOpen = false"
        @confirm="redactCurrent"
      />

      <UModal
        :open="deleting !== null"
        title="删除这条记忆？"
        @update:open="(v) => !v && (deleting = null)"
      >
        <template #body>
          <p class="text-sm">
            删除「{{ deleting?.title }}」。历史事件将保留，可在「已删除」中恢复。
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="deleting = null">取消</UButton>
            <UButton color="error" @click="remove">删除</UButton>
          </div>
        </template>
      </UModal>
    </template>
  </article>
</template>

<style scoped>
.memory-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.memory-detail > * {
  flex: none;
}
.detail-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 24px;
  padding: 14px 32px 15px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.detail-nav {
  grid-column: 1;
  min-width: 0;
}
.detail-title {
  grid-column: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 1px;
  min-width: 0;
}
.detail-title h1 {
  min-width: 0;
  font-size: 21px;
  font-weight: 500;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.detail-tag {
  grid-column: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  margin-top: 9px;
  font-size: 13px;
  line-height: 1.5;
}
.tag-priority {
  font-family: var(--font-mono);
  font-weight: 500;
}
.tag-variants {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-text-muted);
}
.boot-flag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--strata-rule);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.detail-actions {
  grid-column: 2;
  grid-row: 1 / span 3;
  align-self: start;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dirty-flag {
  margin-right: 4px;
}
.memory-detail > .detail-main {
  flex: 1 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 290px;
  align-items: stretch;
}
.detail-read {
  min-width: 0;
  padding: 20px 40px 56px 32px;
}
.detail-side {
  min-width: 0;
  padding: 12px 32px 40px 20px;
  border-left: 1px solid var(--ui-border);
}
.keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.keywords span {
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  font-size: 13px;
  line-height: 1.55;
}
.secret-mask {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 6px 0 26px;
}
.secret-mask i {
  display: block;
  height: 14px;
  background: var(--strata-solid);
}
.edit-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  margin-bottom: 10px;
}
.edit-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.slice-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.slice-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  background: var(--ui-bg);
  color: var(--ui-text-muted);
  cursor: pointer;
}
.slice-tab:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
}
.slice-tab.active {
  background: var(--strata-selected);
  border-color: var(--strata-selected-frame);
  color: var(--strata-on-selected);
}
.read-variant-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ui-border);
}
.single-when-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.compare-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.compare-card {
  min-width: 0;
  border: 1px solid var(--ui-border);
}
.compare-head {
  padding: 6px 12px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 12px;
  font-weight: 500;
  background: var(--ui-bg-elevated);
}
.compare-body {
  padding: 12px;
}
.edit-preview {
  min-width: 0;
  padding: 12px 16px;
  border: 1px solid var(--ui-border);
  overflow: auto;
}
.edit-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}
.edit-layer {
  display: grid;
  grid-template-columns: 3.75rem minmax(0, 1fr);
  column-gap: 10px;
  align-items: baseline;
  font-size: 14px;
}
.edit-layer > span:first-child {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.edit-label {
  margin-bottom: 4px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25rem;
}
.link-pick-list {
  border-top: 1px solid var(--ui-border);
}
.link-pick-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 8px 4px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.link-pick-item:hover {
  background: var(--ui-bg-elevated);
}
.link-pick-id {
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}

@media (max-width: 1240px) {
  .detail-head {
    grid-template-columns: minmax(0, 1fr);
  }
  .detail-actions {
    grid-column: 1;
    grid-row: auto;
    flex-wrap: wrap;
    margin-top: 11px;
  }
  .memory-detail > .detail-main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto 1fr;
  }
  .detail-side {
    padding: 6px 32px 40px;
    border-left: 0;
    border-top: 1px solid var(--ui-border-accented);
  }
  .compare-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 1023.98px) {
  .detail-head {
    padding: 12px 16px 14px;
  }
  .detail-title h1 {
    font-size: 18px;
  }
  .detail-read {
    padding: 16px 16px 28px;
  }
  .detail-side {
    padding: 6px 16px 32px;
  }
}
</style>
