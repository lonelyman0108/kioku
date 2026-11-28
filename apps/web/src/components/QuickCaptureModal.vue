<script setup lang="ts">
import {
  applyMarkdownAppend,
  CAPTURE_TEXT_MAX,
  CHANGE_SUMMARY_MAX,
  ChangeSummary,
  checkCaptureIntegrity,
  Disclosure,
  DISCLOSURE_MAX,
  ENTRY_CONTENT_MAX,
  ENTRY_SUMMARY_MAX,
  ENTRY_TITLE_MAX,
  ENTRY_TITLE_NEW_MAX,
  EntrySummary,
  EntryTitle,
  extractMarkdownHeadings,
  NewEntryTitle,
  normalizeSlugList,
  TOPICS_MAX,
  TopicTag,
  type CaptureCandidate,
  type CaptureIntegrity,
  type CapturePatchKind,
  type CapturePlanResponse,
  type EntryDetailResponse,
  type UpdateEntryRequest,
} from '@kioku/contracts'
import { useKbd, useToast } from '@nuxt/ui/composables'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { maskSecretSnippet, replaceMatchAtRange } from '../credentials'
import { icons } from '../icons'
import { envDisplayName } from '../labels'
import { runtimeName } from '../runtimes'
import { findSecretMatches, type SecretMatch } from '../secretHint'
import ConsequenceModal from './ConsequenceModal.vue'
import InlineCredentialCaptureModal, {
  type InlineCredentialSavedPayload,
} from './InlineCredentialCaptureModal.vue'
import MemoryContent from './MemoryContent.vue'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'
import DiffViewer from './ui/DiffViewer.vue'
import NoteLine from './ui/NoteLine.vue'

const END_SECTION = '__end__'

const PATCH_KIND_LABELS: Record<CapturePatchKind, string> = {
  insert_under_heading: '小节插入',
  append: '文末追加',
  replace: '局部替换',
  create: '新建记忆',
  noop: '无需重复',
}

const PATCH_KIND_ICONS: Record<CapturePatchKind, string> = {
  insert_under_heading: icons.listPlus,
  append: icons.listEnd,
  replace: icons.updateDoc,
  create: icons.add,
  noop: icons.check,
}

const props = withDefaults(
  defineProps<{
    initialText?: string
    targetEntry?: { shortId: string; title: string } | null
  }>(),
  { initialText: '', targetEntry: null },
)

const isRefineMode = computed(() => Boolean(props.targetEntry))

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  applied: [detail: EntryDetailResponse]
  created: [detail: EntryDetailResponse]
  openEntry: [shortId: string]
}>()

const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()
const { getKbdKey } = useKbd()

const hasChatModel = computed(() => Boolean(me.data.value?.hasChatModel))
const submitShortcut = computed(() => {
  const mod = getKbdKey('meta')?.trim() || 'Ctrl'
  const enter = getKbdKey('enter') ?? '↵'
  return mod === '⌘' ? `${mod}${enter}` : `${mod}+${enter}`
})

const step = ref<'input' | 'loading' | 'preview'>('input')
const rawText = ref('')
const plan = ref<CapturePlanResponse | null>(null)
const error = ref<string | null>(null)
const versionConflict = ref(false)
const loadingHint = ref('')

// 预览态的本地视图状态：支持切换候选、选择追加小节、逃生舱切换与正文微调
const viewAction = ref<'update' | 'create' | 'noop'>('update')
const patchKind = ref<CapturePatchKind>('append')
const patchHeading = ref<string | null>(null)
const reason = ref('')
const targetShortId = ref<string | null>(null)
const targetVersion = ref<number | null>(null)
const beforeContent = ref('')
const draftContent = ref('')
const baselineDraft = ref('')
const manualAppendActive = ref(false)
const selectedSection = ref(END_SECTION)
const editingDiff = ref(false)
const applyBusy = ref(false)

// 可选元信息修订草稿与基线（用于单条按说明微调预览与采纳控制）
const adoptMeta = ref(true)
const editingMeta = ref(false)
const planProposedChangeSummary = ref<string | null>(null)
const metaBaseline = reactive({
  title: '',
  summary: '',
  disclosure: '',
  envs: [] as string[],
  realms: [] as string[],
  projects: [] as string[],
  runtimes: [] as string[],
})
const metaDraft = reactive({
  title: '',
  summary: '',
  disclosure: '',
  changeSummary: '',
})
const metaScope = ref<SceneScopeValue>({ envs: [], realms: [], projects: [], runtimes: [] })

const createForm = reactive({
  title: '',
  content: '',
  disclosure: '',
  topics: [] as string[],
  envs: [] as string[],
  realms: [] as string[],
  projects: [] as string[],
  runtimes: [] as string[],
  isPinned: false,
})

const inputRef = ref<{ textareaRef?: HTMLTextAreaElement } | null>(null)
const plainConfirmOpen = ref(false)
const captureModalOpen = ref(false)
const captureTarget = ref<{ source: 'input' | 'create' | 'draft'; match: SecretMatch } | null>(null)
const undoingIds = new Set<string>()
let controller: AbortController | null = null
let loadingReturnStep: 'input' | 'preview' = 'input'

function abortPending() {
  if (controller) {
    controller.abort()
    controller = null
  }
}

function resetState(prefill: string) {
  abortPending()
  step.value = 'input'
  rawText.value = prefill
  plan.value = null
  error.value = null
  versionConflict.value = false
  loadingHint.value = ''
  viewAction.value = 'update'
  patchKind.value = 'append'
  patchHeading.value = null
  reason.value = ''
  targetShortId.value = null
  targetVersion.value = null
  beforeContent.value = ''
  draftContent.value = ''
  baselineDraft.value = ''
  manualAppendActive.value = false
  selectedSection.value = END_SECTION
  editingDiff.value = false
  applyBusy.value = false
  adoptMeta.value = true
  editingMeta.value = false
  planProposedChangeSummary.value = null
  metaBaseline.title = props.targetEntry?.title ?? ''
  metaBaseline.summary = ''
  metaBaseline.disclosure = ''
  metaBaseline.envs = []
  metaBaseline.realms = []
  metaBaseline.projects = []
  metaBaseline.runtimes = []
  metaDraft.title = props.targetEntry?.title ?? ''
  metaDraft.summary = ''
  metaDraft.disclosure = ''
  metaDraft.changeSummary = ''
  metaScope.value = { envs: [], realms: [], projects: [], runtimes: [] }
  plainConfirmOpen.value = false
  captureModalOpen.value = false
  captureTarget.value = null
}

async function focusInput() {
  await nextTick()
  const el = inputRef.value?.textareaRef
  if (el) {
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }
}

watch(
  open,
  async (visible) => {
    if (!visible) {
      abortPending()
      plainConfirmOpen.value = false
      captureModalOpen.value = false
      captureTarget.value = null
      return
    }
    resetState(props.initialText)
    await focusInput()
  },
  { immediate: true },
)

watch(captureModalOpen, (visible) => {
  if (!visible) captureTarget.value = null
})

watch(
  () => props.initialText,
  (next) => {
    if (!open.value || step.value !== 'input') return
    if (next && next !== rawText.value) rawText.value = next
  },
)

const candidates = computed(() => plan.value?.candidates ?? [])

const activeCandidate = computed<CaptureCandidate | null>(
  () => plan.value?.candidates.find((c) => c.shortId === targetShortId.value) ?? null,
)

const targetTitle = computed(
  () => activeCandidate.value?.title ?? props.targetEntry?.title ?? targetShortId.value ?? '',
)

const targetHeadings = computed(() => {
  if (activeCandidate.value) return activeCandidate.value.headings
  return beforeContent.value ? extractMarkdownHeadings(beforeContent.value) : []
})

const sectionOptions = computed(() => [
  ...targetHeadings.value.map((h) => ({ label: `## ${h}（小节末）`, value: h })),
  { label: '文档末尾', value: END_SECTION },
])

const showSectionPicker = computed(
  () =>
    viewAction.value === 'update' &&
    (plan.value?.mode === 'manual' || manualAppendActive.value) &&
    targetHeadings.value.length > 0,
)

const patchBadgeText = computed(() => {
  const base = PATCH_KIND_LABELS[patchKind.value]
  if (patchKind.value === 'insert_under_heading' && patchHeading.value) {
    return `${base} · ${patchHeading.value}`
  }
  return base
})

const hasCustomDraft = computed(
  () => viewAction.value === 'update' && draftContent.value !== baselineDraft.value,
)

const inputSecretMatches = computed(() => findSecretMatches(rawText.value))
const editSecretMatches = computed(() => {
  if (step.value !== 'preview') return []
  if (viewAction.value === 'create') return findSecretMatches(createForm.content)
  if (viewAction.value === 'update') {
    return findSecretMatches(draftContent.value)
  }
  return []
})

function openInlineCapture(source: 'input' | 'create' | 'draft', match: SecretMatch) {
  captureTarget.value = { source, match }
  captureModalOpen.value = true
}

function onInlineCredentialSaved(payload: InlineCredentialSavedPayload) {
  const target = captureTarget.value
  captureTarget.value = null
  if (!target) return
  if (target.source === 'input') {
    rawText.value = replaceMatchAtRange(rawText.value, target.match, payload.placeholder)
  } else if (target.source === 'create') {
    createForm.content = replaceMatchAtRange(createForm.content, target.match, payload.placeholder)
  } else {
    draftContent.value = replaceMatchAtRange(draftContent.value, target.match, payload.placeholder)
  }
  toast.add({ title: `已转存并替换为 ${payload.placeholder}`, color: 'success' })
}

function requestRunCapturePlan() {
  if (!rawText.value.trim()) return
  if (inputSecretMatches.value.length > 0) {
    plainConfirmOpen.value = true
    return
  }
  void runCapturePlan()
}

function confirmSendPlaintext() {
  plainConfirmOpen.value = false
  void runCapturePlan()
}

const integrity = computed<CaptureIntegrity | null>(() => {
  if (step.value !== 'preview' || viewAction.value !== 'update' || !targetShortId.value) {
    return null
  }
  return checkCaptureIntegrity(beforeContent.value, draftContent.value)
})

const integrityWarning = computed(() => {
  const check = integrity.value
  if (!check || (check.intact && !check.severeShrink)) return null
  const parts: string[] = []
  if (check.missingLinks.length) parts.push(`缺失双链 ${check.missingLinks.join('、')}`)
  if (check.missingCreds.length) parts.push(`缺失凭据占位符 ${check.missingCreds.join('、')}`)
  if (check.severeShrink) parts.push('正文篇幅显著缩减')
  return parts.join('；') || '检测到引用完整性异常，建议核对或改为文末追加'
})

const showGuardStrip = computed(() => {
  const check = integrity.value
  if (!check) return false
  return Boolean(
    integrityWarning.value ||
    check.linksBefore > 0 ||
    check.linksAfter > 0 ||
    check.credsBefore > 0 ||
    check.credsAfter > 0,
  )
})

const sameList = (a: readonly string[], b: readonly string[]) =>
  normalizeSlugList(a).join('\n') === normalizeSlugList(b).join('\n')

interface MetaDiffRow {
  key: string
  label: string
  before: string
  after: string
}

const metaChanges = computed<MetaDiffRow[]>(() => {
  if (step.value !== 'preview' || viewAction.value !== 'update') return []
  const list: MetaDiffRow[] = []
  const normTitle = metaDraft.title.trim()
  if (normTitle && normTitle !== metaBaseline.title) {
    list.push({
      key: 'title',
      label: '标题',
      before: metaBaseline.title || '（无）',
      after: normTitle,
    })
  }
  const normSummary = metaDraft.summary.replace(/[\r\n]+/g, ' ').trim()
  if (normSummary !== metaBaseline.summary.trim()) {
    list.push({
      key: 'summary',
      label: '现行概要',
      before: metaBaseline.summary.trim() || '（无）',
      after: normSummary || '（清空）',
    })
  }
  const normDisclosure = metaDraft.disclosure.trim()
  if (normDisclosure !== metaBaseline.disclosure.trim()) {
    list.push({
      key: 'disclosure',
      label: '召回时机',
      before: metaBaseline.disclosure.trim() || '（无）',
      after: normDisclosure || '（清空）',
    })
  }
  if (!sameList(metaScope.value.envs, metaBaseline.envs)) {
    list.push({
      key: 'envs',
      label: '环境',
      before: metaBaseline.envs.map(envDisplayName).join('、') || '不限',
      after: normalizeSlugList(metaScope.value.envs).map(envDisplayName).join('、') || '不限',
    })
  }
  if (!sameList(metaScope.value.realms, metaBaseline.realms)) {
    list.push({
      key: 'realms',
      label: '场域',
      before: metaBaseline.realms.join('、') || '不限',
      after: normalizeSlugList(metaScope.value.realms).join('、') || '不限',
    })
  }
  if (!sameList(metaScope.value.projects, metaBaseline.projects)) {
    list.push({
      key: 'projects',
      label: '项目',
      before: metaBaseline.projects.join('、') || '不限',
      after: normalizeSlugList(metaScope.value.projects).join('、') || '不限',
    })
  }
  if (!sameList(metaScope.value.runtimes, metaBaseline.runtimes)) {
    list.push({
      key: 'runtimes',
      label: '客户端',
      before: metaBaseline.runtimes.map(runtimeName).join('、') || '不限',
      after: normalizeSlugList(metaScope.value.runtimes).map(runtimeName).join('、') || '不限',
    })
  }
  return list
})

const hasMetaChanges = computed(() => metaChanges.value.length > 0)
const hasEffectiveMetaAdoption = computed(() => hasMetaChanges.value && adoptMeta.value)

const hasDiffChanges = computed(
  () =>
    step.value === 'preview' &&
    viewAction.value === 'update' &&
    beforeContent.value.replace(/\r\n/g, '\n') !== draftContent.value.replace(/\r\n/g, '\n'),
)

const hasAnyUpdateChanges = computed(() => hasDiffChanges.value || hasEffectiveMetaAdoption.value)

const mergeValidationProblem = computed(() => {
  if (viewAction.value !== 'update') return null
  if (!draftContent.value.trim()) return '正文不能为空'
  if (draftContent.value.length > ENTRY_CONTENT_MAX) {
    return `正文最多 ${ENTRY_CONTENT_MAX} 个字符`
  }
  if (hasEffectiveMetaAdoption.value || editingMeta.value) {
    if (metaDraft.title.trim()) {
      const parsed = EntryTitle.safeParse(metaDraft.title)
      if (!parsed.success) return parsed.error.issues[0]?.message ?? '标题格式有误'
    }
    if (metaDraft.summary.trim()) {
      const parsed = EntrySummary.safeParse(metaDraft.summary)
      if (!parsed.success) return parsed.error.issues[0]?.message ?? '现行概要格式有误'
    }
    if (metaDraft.disclosure.trim()) {
      const parsed = Disclosure.safeParse(metaDraft.disclosure)
      if (!parsed.success) return parsed.error.issues[0]?.message ?? '召回时机格式有误'
    }
  }
  if (metaDraft.changeSummary.trim()) {
    const parsed = ChangeSummary.safeParse(metaDraft.changeSummary)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '变更说明格式有误'
  }
  return null
})

const createValidationProblem = computed(() => {
  if (viewAction.value !== 'create') return null
  if (createForm.title.trim()) {
    const parsed = NewEntryTitle.safeParse(createForm.title)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '标题格式有误'
  }
  if (createForm.disclosure.trim()) {
    const parsed = Disclosure.safeParse(createForm.disclosure)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '召回时机格式有误'
  }
  if (!createForm.content.trim()) return '正文不能为空'
  if (createForm.content.length > ENTRY_CONTENT_MAX) {
    return `正文最多 ${ENTRY_CONTENT_MAX} 个字符`
  }
  if (createForm.topics.length > TOPICS_MAX) return `主题标签最多 ${TOPICS_MAX} 个`
  for (const tag of createForm.topics) {
    const parsed = TopicTag.safeParse(tag)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '主题标签格式有误'
  }
  return null
})

const canConfirmMerge = computed(
  () =>
    viewAction.value === 'update' &&
    Boolean(targetShortId.value) &&
    targetVersion.value !== null &&
    hasAnyUpdateChanges.value &&
    !mergeValidationProblem.value &&
    !versionConflict.value &&
    !applyBusy.value,
)

const canConfirmCreate = computed(
  () =>
    viewAction.value === 'create' &&
    createForm.content.trim().length > 0 &&
    !createValidationProblem.value &&
    !applyBusy.value,
)

function restorePlanTargetState(res: CapturePlanResponse) {
  viewAction.value = res.action
  patchKind.value = res.patchKind
  patchHeading.value = res.patchHeading
  reason.value = res.reason
  targetShortId.value = res.targetShortId
  targetVersion.value = res.targetVersion
  beforeContent.value = res.beforeContent ?? ''
  const nextDraft = res.proposedContent ?? res.beforeContent ?? ''
  draftContent.value = nextDraft
  baselineDraft.value = nextDraft
  manualAppendActive.value = res.mode === 'manual'
  selectedSection.value = res.patchHeading ?? END_SECTION
  editingDiff.value = false
  error.value = null
  versionConflict.value = false

  const targetCand = res.candidates.find((c) => c.shortId === res.targetShortId) ?? null
  metaBaseline.title = targetCand?.title ?? props.targetEntry?.title ?? ''
  metaBaseline.summary = targetCand?.summary ?? ''
  metaBaseline.disclosure = targetCand?.disclosure ?? ''
  metaBaseline.envs = normalizeSlugList(targetCand?.envs)
  metaBaseline.realms = normalizeSlugList(targetCand?.realms)
  metaBaseline.projects = normalizeSlugList(targetCand?.projects)
  metaBaseline.runtimes = normalizeSlugList(targetCand?.runtimes)

  metaDraft.title = res.proposedTitle ?? metaBaseline.title
  metaDraft.summary =
    res.proposedSummary !== undefined && res.proposedSummary !== null
      ? res.proposedSummary
      : metaBaseline.summary
  metaDraft.disclosure =
    res.proposedDisclosure !== undefined && res.proposedDisclosure !== null
      ? res.proposedDisclosure
      : metaBaseline.disclosure
  planProposedChangeSummary.value = res.proposedChangeSummary ?? null
  metaDraft.changeSummary = res.proposedChangeSummary ?? ''
  metaScope.value = {
    envs:
      res.proposedEnvs !== undefined && res.proposedEnvs !== null
        ? [...res.proposedEnvs]
        : [...metaBaseline.envs],
    realms:
      res.proposedRealms !== undefined && res.proposedRealms !== null
        ? [...res.proposedRealms]
        : [...metaBaseline.realms],
    projects:
      res.proposedProjects !== undefined && res.proposedProjects !== null
        ? [...res.proposedProjects]
        : [...metaBaseline.projects],
    runtimes:
      res.proposedRuntimes !== undefined && res.proposedRuntimes !== null
        ? [...res.proposedRuntimes]
        : [...metaBaseline.runtimes],
  }
  adoptMeta.value = true
  editingMeta.value = false
}

function applyPlanResponse(res: CapturePlanResponse) {
  plan.value = res
  restorePlanTargetState(res)

  createForm.title = res.proposedNew.title
  createForm.content = res.proposedNew.content
  createForm.disclosure = res.proposedNew.disclosure ?? ''
  createForm.topics = [...res.proposedNew.topics]
  createForm.envs = [...res.proposedNew.envs]
  createForm.realms = [...res.proposedNew.realms]
  createForm.projects = [...res.proposedNew.projects]
  createForm.runtimes = [...res.proposedNew.runtimes]
  createForm.isPinned = res.proposedNew.isPinned
}

function confirmDiscardCustomDraft(): boolean {
  if (!hasCustomDraft.value) return true
  return window.confirm('已手动修改正文内容，切换后将放弃当前改动。确定继续？')
}

async function runCapturePlan(targetId?: string) {
  const text = rawText.value.trim()
  if (!text) return
  abortPending()
  const nextController = new AbortController()
  controller = nextController
  const effectiveTargetId = targetId ?? props.targetEntry?.shortId
  loadingReturnStep = step.value === 'preview' ? 'preview' : 'input'
  loadingHint.value = isRefineMode.value
    ? '正在按说明生成修订方案'
    : targetId
      ? '正在按所选目标重新生成修改方案'
      : hasChatModel.value
        ? '正在检索相关记忆并生成归并方案'
        : '正在检索候选目标记忆'
  error.value = null
  versionConflict.value = false
  step.value = 'loading'
  try {
    const res = await api.capturePlan(
      {
        text,
        ...(effectiveTargetId ? { targetShortId: effectiveTargetId } : {}),
        ...(isRefineMode.value ? { mode: 'refine' as const } : {}),
      },
      nextController.signal,
    )
    if (controller !== nextController) return
    controller = null
    applyPlanResponse(res)
    step.value = 'preview'
  } catch (err) {
    if (controller !== nextController) return
    if (err instanceof Error && err.name === 'AbortError') return
    controller = null
    error.value =
      err instanceof ApiError
        ? err.message
        : isRefineMode.value
          ? '生成修订方案失败，请重试'
          : '匹配失败，请重试'
    step.value = loadingReturnStep
  }
}

function cancelLoading() {
  abortPending()
  step.value = loadingReturnStep
}

function onModalOpenChange(next: boolean) {
  if (!next) {
    if (applyBusy.value || captureModalOpen.value || plainConfirmOpen.value) return
    if (step.value === 'loading') {
      cancelLoading()
      return
    }
  }
  open.value = next
}

function onClosePrevent() {
  if (step.value === 'loading') cancelLoading()
}

function backToInput() {
  if (!confirmDiscardCustomDraft()) return
  error.value = null
  versionConflict.value = false
  editingDiff.value = false
  step.value = 'input'
}

function applyLocalAppend(content: string, heading: string | null) {
  const res = applyMarkdownAppend(content, rawText.value, heading)
  draftContent.value = res.content
  baselineDraft.value = res.content
  patchKind.value = res.matchedHeading ? 'insert_under_heading' : 'append'
  patchHeading.value = res.matchedHeading
  selectedSection.value = res.matchedHeading ?? END_SECTION
}

function selectCandidate(cand: CaptureCandidate) {
  if (applyBusy.value) return
  if (viewAction.value !== 'create' && targetShortId.value === cand.shortId) return
  if (!confirmDiscardCustomDraft()) return

  if (plan.value && plan.value.targetShortId === cand.shortId && plan.value.action !== 'create') {
    restorePlanTargetState(plan.value)
    return
  }
  if (plan.value?.mode === 'llm') {
    void runCapturePlan(cand.shortId)
    return
  }
  targetShortId.value = cand.shortId
  targetVersion.value = cand.version
  beforeContent.value = cand.content
  viewAction.value = 'update'
  manualAppendActive.value = true
  editingDiff.value = false
  error.value = null
  versionConflict.value = false
  applyLocalAppend(cand.content, null)
  reason.value = `已切换目标「${cand.title}」，将在文档末尾直接追加。`
}

function onSectionChange(value: string) {
  if (applyBusy.value || editingDiff.value || !beforeContent.value) return
  if (!confirmDiscardCustomDraft()) return
  const heading = value === END_SECTION ? null : value
  applyLocalAppend(beforeContent.value, heading)
  reason.value = heading
    ? `将在「${heading}」小节末尾直接追加，不改动其他段落。`
    : '将在文档末尾直接追加，不改动其他段落。'
}

function switchToAppend() {
  if (applyBusy.value || !targetShortId.value) return
  if (!confirmDiscardCustomDraft()) return
  viewAction.value = 'update'
  manualAppendActive.value = true
  editingDiff.value = false
  error.value = null
  versionConflict.value = false
  applyLocalAppend(beforeContent.value, null)
  reason.value = `已切换为文末安全追加至「${targetTitle.value}」，原有正文保持不变。`
}

function switchToCreate() {
  if (applyBusy.value) return
  if (!confirmDiscardCustomDraft()) return
  viewAction.value = 'create'
  patchKind.value = 'create'
  patchHeading.value = null
  editingDiff.value = false
  error.value = null
  versionConflict.value = false
  reason.value = '已切换为新建独立记忆，确认下方预填信息后即可保存。'
}

async function undoMerge(
  shortId: string,
  prevVersion: number,
  mergedVersion: number,
  title: string,
) {
  if (undoingIds.has(shortId)) return
  undoingIds.add(shortId)
  try {
    const restored = await api.restoreEntry(shortId, {
      version: prevVersion,
      expectedVersion: mergedVersion,
    })
    queryClient.setQueryData(['entry', shortId], restored)
    void queryClient.invalidateQueries({ queryKey: ['entries'] })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', shortId] })
    void queryClient.invalidateQueries({ queryKey: ['boot-preview'] })
    toast.add({
      title: `已撤销对「${title}」的修改，恢复至版本 ${prevVersion}`,
      color: 'success',
    })
  } catch (err) {
    toast.add({
      title:
        err instanceof ApiError && err.status === 409
          ? `「${title}」已被其他修改更新，无法自动撤销，请在版本历史中手动恢复`
          : err instanceof ApiError
            ? err.message
            : '撤销失败，请在版本历史中手动恢复',
      color: err instanceof ApiError && err.status === 409 ? 'warning' : 'error',
    })
  } finally {
    undoingIds.delete(shortId)
  }
}

async function confirmMerge() {
  if (!canConfirmMerge.value || !targetShortId.value || targetVersion.value === null) return
  applyBusy.value = true
  error.value = null
  versionConflict.value = false
  const sid = targetShortId.value
  const prevVersion = targetVersion.value
  const refining = isRefineMode.value

  const payload: UpdateEntryRequest = {
    expectedVersion: prevVersion,
  }
  if (hasDiffChanges.value) {
    payload.content = draftContent.value
  }
  const changeSummaryText =
    metaDraft.changeSummary.trim() ||
    planProposedChangeSummary.value?.trim() ||
    (refining ? '按说明修订记忆' : '')
  if (changeSummaryText) {
    payload.changeSummary = changeSummaryText
  }
  if (hasEffectiveMetaAdoption.value) {
    const normTitle = metaDraft.title.trim()
    if (normTitle && normTitle !== metaBaseline.title) payload.title = normTitle
    const normSummary = metaDraft.summary.replace(/[\r\n]+/g, ' ').trim()
    if (normSummary !== metaBaseline.summary.trim()) payload.summary = normSummary || null
    const normDisclosure = metaDraft.disclosure.trim()
    if (normDisclosure !== metaBaseline.disclosure.trim()) {
      payload.disclosure = normDisclosure || null
    }
    if (!sameList(metaScope.value.envs, metaBaseline.envs)) payload.envs = metaScope.value.envs
    if (!sameList(metaScope.value.realms, metaBaseline.realms)) {
      payload.realms = metaScope.value.realms
    }
    if (!sameList(metaScope.value.projects, metaBaseline.projects)) {
      payload.projects = metaScope.value.projects
    }
    if (!sameList(metaScope.value.runtimes, metaBaseline.runtimes)) {
      payload.runtimes = metaScope.value.runtimes
    }
  }

  try {
    const updated = await api.updateEntry(sid, payload)
    const mergedVersion = updated.entry.version
    queryClient.setQueryData(['entry', sid], updated)
    void queryClient.invalidateQueries({ queryKey: ['entries'] })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', sid] })
    void queryClient.invalidateQueries({ queryKey: ['boot-preview'] })
    open.value = false
    emit('applied', updated)
    toast.add({
      title: refining
        ? `已修订「${updated.entry.title}」（版本 ${mergedVersion}）`
        : `已归并至「${updated.entry.title}」（版本 ${mergedVersion}）`,
      color: 'success',
      duration: 8000,
      actions: [
        ...(!refining
          ? [
              {
                label: '查看记忆',
                icon: icons.promote,
                color: 'neutral' as const,
                variant: 'outline' as const,
                onClick: () => emit('openEntry', sid),
              },
            ]
          : []),
        {
          label: '撤销',
          icon: icons.undelete,
          color: 'neutral',
          variant: 'outline',
          onClick: () => void undoMerge(sid, prevVersion, mergedVersion, updated.entry.title),
        },
      ],
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      versionConflict.value = true
      error.value = '目标记忆已更新，当前预览版本已过期。'
    } else {
      error.value =
        err instanceof ApiError
          ? err.message
          : refining
            ? '应用修订失败，请重试'
            : '归并失败，请重试'
    }
  } finally {
    applyBusy.value = false
  }
}

async function confirmCreate() {
  if (!canConfirmCreate.value) return
  applyBusy.value = true
  error.value = null
  try {
    const detail = await api.createEntry({
      ...(createForm.title.trim() ? { title: createForm.title.trim() } : {}),
      content: createForm.content,
      disclosure: createForm.disclosure.trim() || null,
      isPinned: createForm.isPinned,
      topics: createForm.topics,
      envs: createForm.envs,
      realms: createForm.realms,
      projects: createForm.projects,
      runtimes: createForm.runtimes,
    })
    queryClient.setQueryData(['entry', detail.entry.shortId], detail)
    void queryClient.invalidateQueries({ queryKey: ['entries'] })
    open.value = false
    emit('created', detail)
    toast.add({
      title: `已新建正式记忆「${detail.entry.title}」`,
      color: 'success',
      duration: 6000,
      actions: [
        {
          label: '查看记忆',
          icon: icons.promote,
          color: 'neutral',
          variant: 'outline',
          onClick: () => emit('openEntry', detail.entry.shortId),
        },
      ],
    })
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '新建失败，请重试'
  } finally {
    applyBusy.value = false
  }
}

function openOriginalEntry() {
  if (!targetShortId.value) return
  const sid = targetShortId.value
  open.value = false
  emit('openEntry', sid)
}

function onModalKeydown(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    !open.value ||
    captureModalOpen.value ||
    plainConfirmOpen.value ||
    !(event.metaKey || event.ctrlKey) ||
    event.shiftKey ||
    event.altKey ||
    event.key !== 'Enter'
  ) {
    return
  }
  if (step.value === 'input') {
    if (!rawText.value.trim()) return
    event.preventDefault()
    requestRunCapturePlan()
    return
  }
  if (step.value === 'preview') {
    if (viewAction.value === 'update' && canConfirmMerge.value && !integrityWarning.value) {
      event.preventDefault()
      void confirmMerge()
    } else if (viewAction.value === 'create' && canConfirmCreate.value) {
      event.preventDefault()
      void confirmCreate()
    }
  }
}

onMounted(() => window.addEventListener('keydown', onModalKeydown))
onBeforeUnmount(() => {
  abortPending()
  captureTarget.value = null
  window.removeEventListener('keydown', onModalKeydown)
})
</script>

<template>
  <UModal
    :open="open"
    :title="isRefineMode ? '按说明修订' : '随手记'"
    :description="
      isRefineMode && targetEntry
        ? `针对「${targetEntry.title}」生成单轮修订方案`
        : '自动匹配并归并至既有记忆'
    "
    :dismissible="!applyBusy && step !== 'loading' && !captureModalOpen && !plainConfirmOpen"
    :close="!applyBusy"
    :ui="{
      content: step === 'preview' ? 'w-[92vw] max-w-5xl sm:max-w-5xl' : 'max-w-2xl sm:max-w-2xl',
    }"
    @update:open="onModalOpenChange"
    @close:prevent="onClosePrevent"
  >
    <template #body>
      <!-- 输入阶段 -->
      <div v-if="step === 'input'" class="space-y-3.5">
        <div
          v-if="isRefineMode && targetEntry"
          class="refine-target-bar"
          :title="`${targetEntry.title}（${targetEntry.shortId}）`"
        >
          <span class="refine-target-lead">
            <UIcon :name="icons.file" class="refine-target-icon" aria-hidden="true" />
            <strong class="refine-target-title">{{ targetEntry.title }}</strong>
          </span>
        </div>

        <UFormField
          :label="isRefineMode ? '修订说明' : '记录内容'"
          name="text"
          :help="
            isRefineMode
              ? '用一句话说明要补充的适用前提、修改的内容或要调整的场景标签，预览确认后再写入'
              : '无需先填标题或分类，可直接输入习惯、约定或事实更新'
          "
        >
          <UTextarea
            id="capture-input"
            ref="inputRef"
            v-model="rawText"
            name="text"
            :rows="5"
            autoresize
            :maxrows="12"
            :maxlength="CAPTURE_TEXT_MAX"
            :placeholder="
              isRefineMode
                ? '例如：补充说明仅适用于家里 home-24 主机，收紧环境标签为 home-24，并更新现行概要……'
                : '例如：方案对比结论优先用 Markdown 表格呈现，列清取舍与代价……'
            "
            class="w-full"
          />
        </UFormField>

        <div v-if="inputSecretMatches.length" class="secret-alert-box is-danger" role="status">
          <p class="secret-alert-head">
            <UIcon :name="icons.shieldAlert" class="secret-alert-icon" aria-hidden="true" />
            <span>
              检测到
              {{ inputSecretMatches.length }} 处疑似明文凭据，建议先转存为托管凭据并用占位符替换
            </span>
          </p>
          <ul class="secret-match-list">
            <li
              v-for="(m, idx) in inputSecretMatches"
              :key="`${m.start}-${idx}`"
              class="secret-match-row"
            >
              <span class="secret-match-info">
                <span class="secret-match-label">{{ m.label }}</span>
                <code class="secret-match-snippet font-mono">{{ maskSecretSnippet(m.match) }}</code>
              </span>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.credentials"
                @click="openInlineCapture('input', m)"
              >
                转存为凭据
              </UButton>
            </li>
          </ul>
        </div>

        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
      </div>

      <!-- 检索与分析加载态 -->
      <div v-else-if="step === 'loading'" class="loading-panel">
        <p class="loading-title">
          <UIcon
            :name="hasChatModel ? icons.sparkles : icons.search"
            class="loading-title-icon"
            aria-hidden="true"
          />
          <span>{{ loadingHint }}</span>
        </p>
        <p class="text-xs text-muted">核对双链与凭据占位符，仅调整命中段落</p>
        <UProgress animation="carousel" size="xs" class="max-w-52" />
      </div>

      <!-- 预览与确认阶段 -->
      <div v-else-if="plan" class="space-y-3.5">
        <NoteLine v-if="plan.mode === 'manual'" tone="warning" flush>
          {{
            plan.fallbackReason ??
            '当前未配置对话模型，已切换为直接追加至小节或文末，原有正文不变。'
          }}
        </NoteLine>

        <!-- 方案横幅 -->
        <div
          class="plan-banner"
          :class="{
            'is-create': viewAction === 'create',
            'is-noop': viewAction === 'noop',
          }"
        >
          <div class="plan-banner-head">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <span class="plan-kind-tag">
                <UIcon
                  :name="PATCH_KIND_ICONS[patchKind]"
                  class="plan-kind-icon"
                  aria-hidden="true"
                />
                <span>{{ patchBadgeText }}</span>
              </span>
              <strong
                v-if="viewAction !== 'create' && targetTitle"
                class="plan-target-title"
                :title="targetShortId ? `${targetTitle}（${targetShortId}）` : targetTitle"
              >
                {{ targetTitle }}
              </strong>
            </div>
            <span
              v-if="viewAction !== 'create' && targetVersion !== null"
              class="plan-meta tabular-nums"
              :title="targetShortId ?? undefined"
            >
              版本 {{ targetVersion }}
            </span>
          </div>
          <p class="plan-reason">{{ reason }}</p>
        </div>

        <!-- 候选目标切换 chips（全局随手记显示，单条微调锁定当前词条） -->
        <div v-if="!isRefineMode && candidates.length" class="candidate-bar">
          <span class="section-label">候选目标（点击可切换归并对象）</span>
          <div class="candidate-chips">
            <button
              v-for="cand in candidates"
              :key="cand.shortId"
              type="button"
              class="cand-btn"
              :class="{ active: viewAction !== 'create' && targetShortId === cand.shortId }"
              :disabled="applyBusy"
              :title="`${cand.title}（${cand.shortId}）`"
              @click="selectCandidate(cand)"
            >
              <span class="cand-title">{{ cand.title }}</span>
              <span class="cand-score">{{ cand.score.toFixed(2) }}</span>
            </button>
            <button
              type="button"
              class="cand-btn"
              :class="{ active: viewAction === 'create' }"
              :disabled="applyBusy"
              @click="switchToCreate"
            >
              <UIcon :name="icons.add" class="cand-icon" />
              存为新记忆
            </button>
          </div>
        </div>

        <!-- 分支：新建记忆 -->
        <template v-if="viewAction === 'create'">
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField label="标题" name="title">
              <UInput
                v-model="createForm.title"
                name="title"
                :maxlength="ENTRY_TITLE_NEW_MAX"
                :disabled="applyBusy"
                class="w-full"
              />
            </UFormField>
            <UFormField label="主题" name="topics">
              <UInputTags
                v-model="createForm.topics"
                add-on-blur
                placeholder="输入后回车"
                :disabled="applyBusy"
                class="w-full"
              />
            </UFormField>
          </div>

          <UFormField label="召回时机（可选）" name="disclosure">
            <UInput
              v-model="createForm.disclosure"
              name="disclosure"
              :maxlength="DISCLOSURE_MAX"
              :disabled="applyBusy"
              class="w-full"
            />
          </UFormField>

          <div v-if="editSecretMatches.length" class="secret-alert-box" role="status">
            <p class="secret-alert-head">
              <UIcon :name="icons.shieldAlert" class="secret-alert-icon" aria-hidden="true" />
              <span>
                正文疑似包含
                {{ editSecretMatches.length }} 处明文凭据，建议改存托管凭据并用占位符替换
              </span>
            </p>
            <ul class="secret-match-list">
              <li
                v-for="(m, idx) in editSecretMatches"
                :key="`${m.start}-${idx}`"
                class="secret-match-row"
              >
                <span class="secret-match-info">
                  <span class="secret-match-label">{{ m.label }}</span>
                  <code class="secret-match-snippet font-mono">{{
                    maskSecretSnippet(m.match)
                  }}</code>
                </span>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.credentials"
                  :disabled="applyBusy"
                  @click="openInlineCapture('create', m)"
                >
                  转存为凭据
                </UButton>
              </li>
            </ul>
          </div>

          <UFormField label="正文（Markdown）" name="content">
            <UTextarea
              v-model="createForm.content"
              name="content"
              :rows="6"
              autoresize
              :maxrows="16"
              :disabled="applyBusy"
              class="w-full font-mono"
            />
          </UFormField>

          <USwitch
            v-model="createForm.isPinned"
            :disabled="applyBusy"
            label="启动加载（会话开始时自动注入）"
          />

          <p v-if="error || createValidationProblem" class="text-sm text-error" role="alert">
            {{ error ?? createValidationProblem }}
          </p>
        </template>

        <!-- 分支：无需重复（noop） -->
        <template v-else-if="viewAction === 'noop'">
          <div class="noop-preview">
            <div
              class="noop-preview-head"
              :title="targetShortId ? `${targetTitle}（${targetShortId}）` : undefined"
            >
              <span class="noop-preview-title">
                <UIcon :name="icons.file" class="noop-preview-icon" aria-hidden="true" />
                <span>原记忆内容</span>
              </span>
              <span v-if="targetTitle" class="truncate text-xs text-muted">{{ targetTitle }}</span>
            </div>
            <div class="noop-preview-scroll">
              <MemoryContent width="full" :content="beforeContent" />
            </div>
          </div>
          <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
        </template>

        <!-- 分支：修改方案 Diff 预览（主路径） -->
        <template v-else>
          <div v-if="showSectionPicker" class="section-picker-row">
            <label for="capture-section" class="section-label section-label-inline">
              <UIcon :name="icons.listPlus" class="section-label-icon" aria-hidden="true" />
              <span>插入位置</span>
            </label>
            <USelect
              id="capture-section"
              name="section"
              aria-label="插入位置"
              :model-value="selectedSection"
              :items="sectionOptions"
              value-key="value"
              size="sm"
              :disabled="applyBusy || editingDiff"
              class="min-w-60"
              @update:model-value="(v) => onSectionChange(String(v ?? END_SECTION))"
            />
          </div>

          <!-- 完整性校验条 -->
          <div
            v-if="integrity && showGuardStrip"
            class="guard-strip"
            :class="{ 'is-alert': Boolean(integrityWarning) }"
          >
            <span class="guard-status">
              <UIcon
                :name="integrityWarning ? icons.warning : icons.check"
                class="guard-icon"
                aria-hidden="true"
              />
              {{ integrityWarning ?? '双链与凭据引用完整' }}
            </span>
            <span
              v-if="integrityWarning || integrity.linksBefore > 0 || integrity.linksAfter > 0"
              class="guard-meta"
            >
              双链 {{ integrity.linksBefore }} → {{ integrity.linksAfter }}
            </span>
            <span
              v-if="integrityWarning || integrity.credsBefore > 0 || integrity.credsAfter > 0"
              class="guard-meta"
            >
              凭据占位符 {{ integrity.credsBefore }} → {{ integrity.credsAfter }}
            </span>
          </div>

          <div v-if="editSecretMatches.length" class="secret-alert-box" role="status">
            <p class="secret-alert-head">
              <UIcon :name="icons.shieldAlert" class="secret-alert-icon" aria-hidden="true" />
              <span>
                正文疑似包含
                {{ editSecretMatches.length }} 处明文凭据，建议改存托管凭据并用占位符替换
              </span>
            </p>
            <ul class="secret-match-list">
              <li
                v-for="(m, idx) in editSecretMatches"
                :key="`${m.start}-${idx}`"
                class="secret-match-row"
              >
                <span class="secret-match-info">
                  <span class="secret-match-label">{{ m.label }}</span>
                  <code class="secret-match-snippet font-mono">{{
                    maskSecretSnippet(m.match)
                  }}</code>
                </span>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.credentials"
                  :disabled="applyBusy"
                  @click="openInlineCapture('draft', m)"
                >
                  转存为凭据
                </UButton>
              </li>
            </ul>
          </div>

          <!-- 可选元信息变更预览与编辑 -->
          <div v-if="hasMetaChanges || editingMeta" class="meta-revision-box">
            <div class="meta-revision-head">
              <label v-if="hasMetaChanges" class="meta-adopt-toggle">
                <input
                  v-model="adoptMeta"
                  type="checkbox"
                  class="square-check"
                  :disabled="applyBusy"
                />
                <span>采纳元信息变更（{{ metaChanges.length }} 项）</span>
              </label>
              <span v-else class="section-label section-label-inline">
                <UIcon :name="icons.sliders" class="section-label-icon" aria-hidden="true" />
                <span>调整元信息</span>
              </span>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="editingMeta ? icons.check : icons.edit"
                :disabled="applyBusy"
                @click="editingMeta = !editingMeta"
              >
                {{ editingMeta ? '完成调整' : '调整元信息' }}
              </UButton>
            </div>

            <div v-if="editingMeta" class="meta-edit-fields">
              <UFormField label="标题" name="metaTitle">
                <UInput
                  v-model="metaDraft.title"
                  name="metaTitle"
                  :maxlength="ENTRY_TITLE_MAX"
                  :disabled="applyBusy"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="现行概要（可选）" name="metaSummary">
                <UTextarea
                  v-model="metaDraft.summary"
                  name="metaSummary"
                  :rows="2"
                  autoresize
                  :maxrows="4"
                  :maxlength="ENTRY_SUMMARY_MAX"
                  :disabled="applyBusy"
                  class="w-full"
                />
              </UFormField>
              <div class="grid gap-3 sm:grid-cols-2">
                <UFormField label="召回时机（可选）" name="metaDisclosure">
                  <UInput
                    v-model="metaDraft.disclosure"
                    name="metaDisclosure"
                    :maxlength="DISCLOSURE_MAX"
                    :disabled="applyBusy"
                    class="w-full"
                  />
                </UFormField>
                <UFormField label="变更说明（可选）" name="metaChangeSummary">
                  <UInput
                    v-model="metaDraft.changeSummary"
                    name="metaChangeSummary"
                    :maxlength="CHANGE_SUMMARY_MAX"
                    :disabled="applyBusy"
                    class="w-full"
                  />
                </UFormField>
              </div>
              <UFormField label="适用场景">
                <SceneScopePicker v-model="metaScope" :disabled="applyBusy" />
              </UFormField>
            </div>

            <dl
              v-else-if="hasMetaChanges"
              class="meta-diff-list"
              :class="{ 'is-muted': !adoptMeta }"
            >
              <div v-for="item in metaChanges" :key="item.key" class="meta-diff-row">
                <dt class="meta-diff-label">{{ item.label }}</dt>
                <dd class="meta-diff-val">
                  <span class="meta-before">{{ item.before }}</span>
                  <UIcon :name="icons.inherits" class="meta-arrow" aria-hidden="true" />
                  <span class="meta-after">{{ item.after }}</span>
                </dd>
              </div>
            </dl>

            <p v-if="!editingMeta && metaDraft.changeSummary.trim()" class="meta-change-note">
              变更说明：{{ metaDraft.changeSummary.trim() }}
            </p>
          </div>

          <div class="space-y-1.5">
            <div class="diff-toolbar">
              <span class="section-label">
                {{ editingDiff ? '手动修改正文' : '变更预览（行级对比）' }}
              </span>
              <div class="diff-toolbar-actions">
                <UButton
                  v-if="isRefineMode && !hasMetaChanges && !editingMeta"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.sliders"
                  :disabled="applyBusy"
                  @click="editingMeta = true"
                >
                  调整元信息
                </UButton>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="editingDiff ? icons.compare : icons.edit"
                  :disabled="applyBusy"
                  @click="editingDiff = !editingDiff"
                >
                  {{ editingDiff ? '返回对比视图' : '手动编辑' }}
                </UButton>
              </div>
            </div>

            <UTextarea
              v-if="editingDiff"
              id="capture-draft-content"
              v-model="draftContent"
              name="draftContent"
              :rows="10"
              autoresize
              :maxrows="20"
              :disabled="applyBusy"
              class="w-full font-mono"
              aria-label="修改后正文"
            />
            <p v-else-if="!hasDiffChanges && hasEffectiveMetaAdoption" class="meta-only-note">
              正文无变更，确认后仅应用上方元信息调整。
            </p>
            <DiffViewer
              v-else
              :before="beforeContent"
              :after="draftContent"
              :context="3"
              :expand-step="10"
              max-height="26rem"
              empty-text="正文无变更"
            />
          </div>

          <div v-if="error || mergeValidationProblem" class="error-row" role="alert">
            <p class="text-sm text-error">{{ error ?? mergeValidationProblem }}</p>
            <UButton
              v-if="versionConflict"
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.refresh"
              @click="runCapturePlan(targetShortId ?? undefined)"
            >
              {{ isRefineMode ? '重新生成' : '重新匹配' }}
            </UButton>
          </div>
        </template>
      </div>
    </template>

    <template #footer>
      <!-- 输入态底部：命中疑似明文时反转安全默认，将主按钮切为转存为凭据 -->
      <div
        v-if="step === 'input'"
        class="modal-foot"
        :class="{ 'is-end': !inputSecretMatches.length }"
      >
        <div v-if="inputSecretMatches.length" class="foot-group">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="!rawText.trim()"
            @click="plainConfirmOpen = true"
          >
            仍以明文发送
          </UButton>
        </div>
        <div class="foot-group">
          <UButton color="neutral" variant="ghost" size="sm" @click="open = false">取消</UButton>
          <UButton
            v-if="inputSecretMatches.length"
            size="sm"
            :icon="icons.credentials"
            @click="openInlineCapture('input', inputSecretMatches[0]!)"
          >
            {{
              inputSecretMatches.length > 1
                ? `转存为凭据（${inputSecretMatches.length} 处）`
                : '转存为凭据'
            }}
          </UButton>
          <UButton
            v-else
            size="sm"
            :icon="isRefineMode ? icons.sparkles : hasChatModel ? icons.capture : icons.search"
            :disabled="!rawText.trim()"
            @click="runCapturePlan()"
          >
            {{ isRefineMode ? '生成修订方案' : hasChatModel ? '匹配归并方案' : '检索候选目标' }}
            <span class="shortcut-hint" aria-hidden="true">{{ submitShortcut }}</span>
          </UButton>
        </div>
      </div>

      <!-- 加载态底部 -->
      <div v-else-if="step === 'loading'" class="modal-foot is-end">
        <div class="foot-group">
          <UButton color="neutral" variant="outline" size="sm" @click="cancelLoading">
            取消并返回
          </UButton>
        </div>
      </div>

      <!-- 预览态底部：新建分支 -->
      <div v-else-if="viewAction === 'create'" class="modal-foot">
        <div class="foot-group">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :icon="icons.back"
            :disabled="applyBusy"
            @click="backToInput"
          >
            返回修改
          </UButton>
        </div>
        <div class="foot-group">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="applyBusy"
            @click="open = false"
          >
            取消
          </UButton>
          <UButton
            size="sm"
            :icon="icons.check"
            :loading="applyBusy"
            :disabled="!canConfirmCreate"
            @click="confirmCreate"
          >
            确认新建记忆
            <span class="shortcut-hint" aria-hidden="true">{{ submitShortcut }}</span>
          </UButton>
        </div>
      </div>

      <!-- 预览态底部：无需重复分支 -->
      <div v-else-if="viewAction === 'noop'" class="modal-foot">
        <div class="foot-group">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :icon="icons.back"
            @click="backToInput"
          >
            返回修改
          </UButton>
          <UButton
            v-if="!isRefineMode"
            color="neutral"
            variant="outline"
            size="sm"
            :icon="icons.listEnd"
            @click="switchToAppend"
          >
            仍要追加至文末
          </UButton>
        </div>
        <div class="foot-group">
          <UButton color="neutral" variant="ghost" size="sm" @click="open = false">关闭</UButton>
          <UButton
            v-if="!isRefineMode && targetShortId"
            size="sm"
            :icon="icons.promote"
            @click="openOriginalEntry"
          >
            查看原记忆
          </UButton>
        </div>
      </div>

      <!-- 预览态底部：归并更新主路径 -->
      <div v-else class="modal-foot">
        <div class="foot-group">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :icon="icons.back"
            :disabled="applyBusy"
            @click="backToInput"
          >
            返回修改
          </UButton>
          <UButton
            v-if="!isRefineMode && (patchKind !== 'append' || !manualAppendActive)"
            color="neutral"
            variant="outline"
            size="sm"
            :icon="icons.listEnd"
            :disabled="applyBusy"
            @click="switchToAppend"
          >
            改为文末追加
          </UButton>
        </div>
        <div class="foot-group">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="applyBusy"
            @click="open = false"
          >
            取消
          </UButton>
          <UButton
            size="sm"
            :icon="icons.check"
            :loading="applyBusy"
            :disabled="!canConfirmMerge"
            @click="confirmMerge"
          >
            {{ isRefineMode ? '确认应用修订' : '确认归并' }}
            <span v-if="!integrityWarning" class="shortcut-hint" aria-hidden="true">{{
              submitShortcut
            }}</span>
          </UButton>
        </div>
      </div>
    </template>
  </UModal>

  <InlineCredentialCaptureModal
    v-model:open="captureModalOpen"
    :initial-value="captureTarget?.match.match ?? ''"
    :initial-match="captureTarget?.match ?? null"
    :default-realms="viewAction === 'create' ? createForm.realms : metaScope.realms"
    silent-success-toast
    title="转存为托管凭据并替换"
    action-label="保存并替换"
    @saved="onInlineCredentialSaved"
  />

  <ConsequenceModal
    :open="plainConfirmOpen"
    :title="hasChatModel ? '仍以明文发送给对话模型？' : '仍以明文继续检索？'"
    :consequences="[
      `当前输入检测到 ${inputSecretMatches.length} 处疑似明文凭据（${inputSecretMatches.map((m) => m.label).join('、')}）。`,
      hasChatModel
        ? '继续发送会将明文提交至已配置的对话模型接口，并可能随草稿写入记忆正文。'
        : '继续操作可能将明文随草稿写入记忆正文，建议先转存为托管凭据。',
    ]"
    action="确认以明文继续"
    :action-icon="icons.warning"
    tone="error"
    @confirm="confirmSendPlaintext"
    @close="plainConfirmOpen = false"
  />
</template>

<style scoped>
.loading-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 28px 16px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  text-align: center;
}
.loading-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.loading-title-icon {
  display: inline-block;
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--ui-text-muted);
}
.plan-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.plan-banner.is-create {
  border-left-color: var(--ui-info);
  background: var(--ui-bg-muted);
}
.plan-banner.is-noop {
  border-left-color: var(--ui-warning);
  background: var(--ui-bg-muted);
}
.plan-banner-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.plan-kind-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--ui-text-highlighted);
}
.plan-kind-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.plan-target-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.plan-meta {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.plan-reason {
  font-size: 13px;
  line-height: 1.55;
  color: var(--ui-text);
}
.section-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
}
.section-label-inline {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.section-label-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.candidate-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.candidate-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cand-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 9px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.cand-btn:hover:not(:disabled) {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.cand-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.cand-btn.active {
  border-color: var(--ui-selected);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.cand-title {
  max-width: 15rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cand-score {
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.cand-btn.active .cand-score {
  color: var(--ui-on-selected-muted);
}
.cand-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.section-picker-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.guard-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  padding: 6px 10px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
}
.guard-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 500;
  color: var(--ui-success);
}
.guard-meta {
  color: var(--ui-text-muted);
}
.guard-strip.is-alert {
  border-color: var(--ui-error);
  background: color-mix(in srgb, var(--ui-error) 6%, var(--ui-bg));
}
.guard-strip.is-alert .guard-status,
.guard-strip.is-alert .guard-meta {
  color: var(--ui-error);
}
.guard-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.diff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.diff-toolbar-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.refine-target-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.refine-target-lead {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.refine-target-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.refine-target-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.meta-revision-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
}
.meta-revision-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.meta-adopt-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  cursor: pointer;
}
.square-check {
  flex: none;
  accent-color: var(--ui-primary);
  cursor: pointer;
}
.meta-diff-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
}
.meta-diff-list.is-muted {
  opacity: 0.55;
}
.meta-diff-row {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
}
.meta-diff-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.meta-diff-val {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.meta-before {
  color: var(--ui-text-muted);
  text-decoration: line-through;
  overflow-wrap: anywhere;
}
.meta-arrow {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-dimmed);
}
.meta-after {
  font-weight: 500;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.meta-change-note {
  padding-top: 6px;
  border-top: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.meta-edit-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.meta-only-note {
  padding: 10px 12px;
  border: 1px dashed var(--ui-border-accented);
  font-size: 13px;
  color: var(--ui-text-muted);
}
.error-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.noop-preview {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.noop-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
}
.noop-preview-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.noop-preview-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.noop-preview-scroll {
  max-height: 18rem;
  overflow-y: auto;
  padding: 12px 14px;
}
.modal-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  width: 100%;
}
.modal-foot.is-end {
  justify-content: flex-end;
}
.foot-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.shortcut-hint {
  font-family: var(--font-mono);
  font-size: 12px;
}
.secret-alert-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ui-warning);
  border-left-width: 3px;
  background: var(--ui-bg-muted);
}
.secret-alert-box.is-danger {
  border-color: var(--ui-error);
  background: color-mix(in srgb, var(--ui-error) 6%, var(--ui-bg));
}
.secret-alert-head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ui-warning);
}
.secret-alert-box.is-danger .secret-alert-head {
  color: var(--ui-error);
}
.secret-alert-icon {
  display: inline-block;
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 2px;
}
.secret-match-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.secret-match-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--ui-border);
}
.secret-match-info {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.secret-match-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.secret-match-snippet {
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  color: var(--ui-text-toned);
  overflow-wrap: anywhere;
}
@media (max-width: 767.98px), (pointer: coarse) {
  .shortcut-hint {
    display: none;
  }
}
</style>
