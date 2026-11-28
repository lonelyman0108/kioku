<script setup lang="ts">
import {
  BOOT_MODES,
  CHANGE_SUMMARY_MAX,
  ChangeSummary,
  DISCLOSURE_MAX,
  effectiveBootMode,
  ENTRY_SUMMARY_MAX,
  ENTRY_TITLE_MAX,
  EntrySummary,
  EntryTitle,
  extractMarkdownOutline,
  hasDuplicateLeadingHeading,
  lintEntryHygiene,
  normalizeSlugList,
  PINNED_FULL_SOFT_WARN_CHARS,
  stripDuplicateLeadingHeading,
  TOPICS_MAX,
  TopicTag,
  type BootMode,
  type EntryDetailResponse,
  type EntryFacetsSummary,
} from '@kioku/contracts'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useKbd, useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import {
  confirmDiscard,
  hasUnsavedChanges,
  useUnsavedChangesGuard,
} from '../composables/unsavedChanges'
import { useCopy } from '../composables/useCopy'
import { useDebounced } from '../composables/useDebounced'
import { useMarkdownSyncScroll } from '../composables/useMarkdownSyncScroll'
import { useNow } from '../composables/useNow'
import { useSession } from '../composables/useSession'
import { useViewport } from '../composables/useViewport'
import { icons } from '../icons'
import {
  bootModeDescriptions,
  bootModeIcons,
  bootModeLabels,
  envDisplayName,
  eventTypeIcons,
  eventTypeLabels,
  formatActorLabel,
} from '../labels'
import {
  splitWikiLinks,
  stripInlineMarkdown,
  type CredentialLinks,
  type WikiLinkTargets,
} from '../markdown'
import { placeholderOf } from '../placeholders'
import {
  clampRailWidth,
  computeMaxRailWidth,
  estimateElasticRailWidth,
  parseStoredRailWidth,
  RAIL_CONTAINER_MIN,
  RAIL_WIDTH_MIN,
} from '../readRail'
import { credentialRoute, entryRoute } from '../routes'
import { runtimeName } from '../runtimes'
import { detectSecretPrefixes } from '../secretHint'
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
import { analyzeTitleHint, appendExtractedChangeNote } from '../titleHint'
import {
  readStoredBoolean,
  readStoredEnum,
  readStoredString,
  UI_STORAGE_KEYS,
  writeStoredBoolean,
  writeStoredString,
} from '../uiState'
import ConsequenceModal from './ConsequenceModal.vue'
import EntryLinksPanel from './EntryLinksPanel.vue'
import MemoryContent from './MemoryContent.vue'
import MemoryHistoryDrawer from './MemoryHistoryDrawer.vue'
import QuickCaptureModal from './QuickCaptureModal.vue'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import SingleTidyDrawer, { type SingleOrganizeMode } from './SingleTidyDrawer.vue'
import DiffViewer from './ui/DiffViewer.vue'
import NoteLine from './ui/NoteLine.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import SaveBar, { type SaveBarChange } from './ui/SaveBar.vue'
import WikiText from './ui/WikiText.vue'

const props = withDefaults(
  defineProps<{
    shortId: string
    facets?: EntryFacetsSummary | null
    fullscreen?: boolean
    showBack?: boolean
  }>(),
  { facets: null, fullscreen: false, showBack: false },
)

const emit = defineEmits<{
  changed: [detail: EntryDetailResponse]
  deleted: [shortId: string, permanent: boolean]
  restored: [detail: EntryDetailResponse]
  open: [shortId: string]
  toggleFullscreen: []
  back: []
}>()

const router = useRouter()
const toast = useToast()
const copy = useCopy()
const shortIdCopied = ref(false)
let shortIdCopyTimer: ReturnType<typeof setTimeout> | null = null
async function copyShortId() {
  const sid = entry.value?.shortId
  if (!sid) return
  const ok = await copy(sid)
  if (!ok) return
  shortIdCopied.value = true
  if (shortIdCopyTimer) clearTimeout(shortIdCopyTimer)
  shortIdCopyTimer = setTimeout(() => {
    shortIdCopied.value = false
    shortIdCopyTimer = null
  }, 1600)
}
const queryClient = useQueryClient()
const { getKbdKey } = useKbd()

const saveShortcut = computed(() => {
  const mod = getKbdKey('meta')?.trim() || 'Ctrl'
  return mod === '⌘' ? '⌘S' : `${mod}+S`
})

const queryKey = computed(() => ['entry', props.shortId] as const)
const detailQuery = useQuery({
  queryKey,
  queryFn: ({ queryKey: [, sid] }) => api.entry(sid),
})

type EditViewMode = 'edit' | 'split' | 'preview'

const EDIT_VIEW_OPTIONS: { value: EditViewMode; label: string; icon: string; title: string }[] = [
  { value: 'edit', label: '编辑', icon: icons.edit, title: '源码编辑' },
  { value: 'split', label: '分栏', icon: icons.splitPane, title: '源码与预览左右分栏' },
  { value: 'preview', label: '预览', icon: icons.reveal, title: '渲染预览' },
]

const viewport = useViewport()
const isPhone = computed(() => viewport.value.width < 768)
const editorScrollWidth = ref(0)
const canSplitEdit = computed(
  () => !isPhone.value && (editorScrollWidth.value === 0 || editorScrollWidth.value >= 680),
)
const visibleEditViewOptions = computed(() =>
  canSplitEdit.value ? EDIT_VIEW_OPTIONS : EDIT_VIEW_OPTIONS.filter((opt) => opt.value !== 'split'),
)

const BOOT_MODE_OPTIONS: { value: BootMode; label: string; icon: string }[] = BOOT_MODES.map(
  (value) => ({
    value,
    label: bootModeLabels[value],
    icon: bootModeIcons[value],
  }),
)

const detail = ref<EntryDetailResponse | null>(null)
const entry = computed(() => detail.value?.entry ?? null)
const entryBootMode = computed<BootMode>(() =>
  entry.value ? effectiveBootMode(entry.value) : 'none',
)
const PERSISTED_EDIT_VIEWS = ['edit', 'split'] as const
const mode = ref<'read' | 'edit'>('read')
const preferredEditView = ref<EditViewMode>(
  readStoredEnum(UI_STORAGE_KEYS.editorView, PERSISTED_EDIT_VIEWS, 'edit'),
)
const editView = computed<EditViewMode>({
  get: () =>
    preferredEditView.value === 'split' && !canSplitEdit.value ? 'edit' : preferredEditView.value,
  set: (next) => {
    const resolved = next === 'split' && !canSplitEdit.value ? 'edit' : next
    preferredEditView.value = resolved
    if (resolved === 'edit' || resolved === 'split') {
      writeStoredString(UI_STORAGE_KEYS.editorView, resolved)
    }
  },
})
const syncScroll = ref(readStoredBoolean(UI_STORAGE_KEYS.editorSyncScroll, true))
const attrsOpen = ref(false)
const historyOpen = ref(false)
const focusedHistoryEventId = ref<number | null>(null)
const minValidTo = ref('')
const readContentRef = ref<InstanceType<typeof MemoryContent> | null>(null)
const previewScrollRef = ref<HTMLElement | null>(null)
const workbenchRef = ref<HTMLElement | null>(null)

watch(editView, async (next) => {
  if (next === 'split' && mode.value === 'edit') {
    await nextTick()
    workbenchRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
})

watch(syncScroll, (next) => {
  writeStoredBoolean(UI_STORAGE_KEYS.editorSyncScroll, next)
})

const form = reactive({
  title: '',
  summary: '',
  content: '',
  disclosure: '',
  changeSummary: '',
  bootMode: 'none' as BootMode,
  topics: [] as string[],
  validTo: '',
})
const scope = ref<SceneScopeValue>({ envs: [], realms: [], projects: [], runtimes: [] })

const validToInput = (iso: string | null) => (iso ? toLocalInput(iso) : '')

function loadDetail(next: EntryDetailResponse) {
  detail.value = next
  const e = next.entry
  form.title = e.title
  form.summary = e.summary ?? ''
  form.content = e.content
  form.disclosure = e.disclosure ?? ''
  form.changeSummary = ''
  form.bootMode = effectiveBootMode(e)
  form.topics = [...e.topics]
  form.validTo = validToInput(e.validTo)
  scope.value = {
    envs: [...e.envs],
    realms: [...e.realms],
    projects: [...e.projects],
    runtimes: [...e.runtimes],
  }
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  normalizeSlugList(a).join('\n') === normalizeSlugList(b).join('\n')

const dirtyChanges = computed<SaveBarChange[]>(() => {
  const e = entry.value
  if (!e || mode.value !== 'edit') return []
  const list: SaveBarChange[] = []
  const normTitle = form.title.trim()
  if (normTitle !== e.title) {
    list.push({ label: '标题', before: e.title || '（空）', after: normTitle || '（空）' })
  }
  const normSummary = form.summary.replace(/[\r\n]+/g, ' ').trim()
  const baseSummary = e.summary?.trim() ?? ''
  if (normSummary !== baseSummary) {
    list.push({
      label: '现行概要',
      before: baseSummary || '（空）',
      after: normSummary || '（空）',
    })
  }
  if (form.content !== e.content) {
    list.push({
      label: '正文',
      before: `${e.content.length} 字`,
      after: `${form.content.length} 字`,
    })
  }
  const normDisclosure = form.disclosure.trim()
  const baseDisclosure = e.disclosure?.trim() ?? ''
  if (normDisclosure !== baseDisclosure) {
    list.push({
      label: e.kind === 'episode' ? '信号要点' : '召回时机',
      before: baseDisclosure || '（空）',
      after: normDisclosure || '（空）',
    })
  }
  const baseBootMode = effectiveBootMode(e)
  if (form.bootMode !== baseBootMode) {
    list.push({
      label: '启动加载',
      before: bootModeLabels[baseBootMode],
      after: bootModeLabels[form.bootMode],
    })
  }
  if (!sameList(form.topics, e.topics)) {
    list.push({
      label: '主题',
      before: e.topics.join('、') || '（无）',
      after: normalizeSlugList(form.topics).join('、') || '（无）',
    })
  }
  if (!sameList(scope.value.envs, e.envs)) {
    list.push({
      label: '环境',
      before: e.envs.map(envDisplayName).join('、') || '不限',
      after: normalizeSlugList(scope.value.envs).map(envDisplayName).join('、') || '不限',
    })
  }
  if (!sameList(scope.value.realms, e.realms)) {
    list.push({
      label: '场域',
      before: e.realms.join('、') || '不限',
      after: normalizeSlugList(scope.value.realms).join('、') || '不限',
    })
  }
  if (!sameList(scope.value.projects, e.projects)) {
    list.push({
      label: '项目',
      before: e.projects.join('、') || '不限',
      after: normalizeSlugList(scope.value.projects).join('、') || '不限',
    })
  }
  if (!sameList(scope.value.runtimes, e.runtimes)) {
    list.push({
      label: '客户端',
      before: e.runtimes.map(runtimeName).join('、') || '不限',
      after: normalizeSlugList(scope.value.runtimes).map(runtimeName).join('、') || '不限',
    })
  }
  if (form.validTo !== validToInput(e.validTo)) {
    const nextIso = form.validTo ? fromLocalInput(form.validTo) : null
    list.push({
      label: '有效期',
      before: e.validTo ? formatShort(e.validTo) : '长期有效',
      after: nextIso ? formatShort(nextIso) : '长期有效',
    })
  }
  return list
})

const dirtyCount = computed(() => dirtyChanges.value.length)
const dirty = computed(() => dirtyCount.value > 0)

const { leaving } = useUnsavedChangesGuard(dirty, {
  leavesOn: (to, from) => to.query.id !== from.query.id || to.name !== from.name,
})

watch(
  () => detailQuery.data.value,
  (next) => {
    if (!next) return
    if (!detail.value || (!dirty.value && next.entry.version >= detail.value.entry.version)) {
      loadDetail(next)
    }
  },
  { immediate: true },
)

const now = useNow(30_000)
const expiredNow = computed(() => Boolean(entry.value && isExpired(entry.value.validTo, now.value)))
const isDeleted = computed(() => Boolean(entry.value?.deletedAt))
const secretWarnings = computed(() =>
  mode.value === 'edit' ? detectSecretPrefixes(form.content) : [],
)
const editBootWarnings = computed(() => {
  if (mode.value !== 'edit' || entry.value?.kind !== 'entry') return []
  return lintEntryHygiene({
    title: form.title,
    content: form.content,
    summary: form.summary,
    bootMode: form.bootMode,
    envs: scope.value.envs,
    realms: scope.value.realms,
    projects: scope.value.projects,
    runtimes: scope.value.runtimes,
  }).filter((w) => w.code === 'pinned_oversized' || w.code === 'pinned_missing_summary')
})
const titleHint = computed(() =>
  mode.value === 'edit'
    ? analyzeTitleHint(form.title, form.content)
    : { dirty: false, warnings: [], message: null, splittable: null },
)

function splitTitleToChangeSummary() {
  const split = titleHint.value.splittable
  if (!split) return
  form.title = split.cleanTitle
  form.changeSummary = appendExtractedChangeNote(form.changeSummary, split.extractedNote)
}

const validationProblem = computed(() => {
  if (mode.value !== 'edit') return null
  const titleCheck = EntryTitle.safeParse(form.title)
  if (!titleCheck.success) return titleCheck.error.issues[0]?.message ?? '标题格式有误'
  if (form.summary.trim()) {
    const summaryCheck = EntrySummary.safeParse(form.summary)
    if (!summaryCheck.success) return summaryCheck.error.issues[0]?.message ?? '现行概要格式有误'
  }
  if (form.changeSummary.trim()) {
    const changeCheck = ChangeSummary.safeParse(form.changeSummary)
    if (!changeCheck.success) return changeCheck.error.issues[0]?.message ?? '变更说明格式有误'
  }
  if (!form.content.trim()) return '正文不能为空'
  if (form.topics.length > TOPICS_MAX) return `主题标签最多 ${TOPICS_MAX} 个`
  for (const t of form.topics) {
    const parsed = TopicTag.safeParse(t)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '主题标签格式有误'
  }
  if (form.validTo && form.validTo !== validToInput(entry.value?.validTo ?? null)) {
    if (validToTooSoon(form.validTo)) return '有效期须晚于当前时间至少 1 分钟'
  }
  return null
})

function startEditing() {
  if (!entry.value || isDeleted.value || quickBusy.value) return
  pinPopoverOpen.value = false
  scopePopoverOpen.value = false
  organizeOpen.value = false
  minValidTo.value = earliestValidTo()
  attrsOpen.value = false
  form.changeSummary = ''
  if (preferredEditView.value === 'preview') {
    preferredEditView.value = readStoredEnum(
      UI_STORAGE_KEYS.editorView,
      PERSISTED_EDIT_VIEWS,
      'edit',
    )
  }
  mode.value = 'edit'
}

function cancelEditing() {
  if (detail.value) loadDetail(detail.value)
  mode.value = 'read'
  attrsOpen.value = false
}

function requestCancelEditing() {
  if (dirty.value && !confirmDiscard()) return
  cancelEditing()
}

const saving = ref(false)
async function save() {
  const current = entry.value
  if (!current || saving.value || !dirty.value || validationProblem.value) return
  saving.value = true
  try {
    const validTo = form.validTo ? fromLocalInput(form.validTo) : null
    const updated = await api.updateEntry(current.shortId, {
      expectedVersion: current.version,
      title: form.title.trim(),
      summary: form.summary.trim() || null,
      content: form.content,
      disclosure: form.disclosure.trim() || null,
      ...(form.changeSummary.trim() ? { changeSummary: form.changeSummary.trim() } : {}),
      bootMode: form.bootMode,
      isPinned: form.bootMode !== 'none',
      topics: form.topics,
      envs: scope.value.envs,
      realms: scope.value.realms,
      projects: scope.value.projects,
      runtimes: scope.value.runtimes,
      validTo,
    })
    queryClient.setQueryData(queryKey.value, updated)
    loadDetail(updated)
    mode.value = 'read'
    attrsOpen.value = false
    toast.add({ title: '已保存', color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', current.shortId] })
    emit('changed', updated)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
    if (err instanceof ApiError && err.status === 409) void detailQuery.refetch()
  } finally {
    saving.value = false
  }
}

// 阅读态常驻分层 Popover 与将「会话摘要」一键提炼为正式记忆
const quickBusy = ref(false)
const pinPopoverOpen = ref(false)
const pinBaseVersion = ref<number | null>(null)
const pinDraft = reactive({
  bootMode: 'none' as BootMode,
  summary: '',
  scope: { envs: [], realms: [], projects: [], runtimes: [] } as SceneScopeValue,
  scopeExpanded: false,
  recommendedIndex: false,
})

watch(pinPopoverOpen, (visible) => {
  const current = entry.value
  if (!visible || !current) return
  scopePopoverOpen.value = false
  pinBaseVersion.value = current.version
  const currentMode = effectiveBootMode(current)
  const overSoftCap = current.content.length > PINNED_FULL_SOFT_WARN_CHARS
  pinDraft.recommendedIndex = currentMode === 'none' && overSoftCap
  pinDraft.bootMode = pinDraft.recommendedIndex ? 'index' : currentMode
  pinDraft.summary = current.summary ?? ''
  pinDraft.scope = {
    envs: [...current.envs],
    realms: [...current.realms],
    projects: [...current.projects],
    runtimes: [...current.runtimes],
  }
  pinDraft.scopeExpanded =
    current.envs.length > 0 ||
    current.realms.length > 0 ||
    current.projects.length > 0 ||
    current.runtimes.length > 0
})

const pinDraftWarnings = computed(() => {
  const current = entry.value
  if (!pinPopoverOpen.value || !current) return []
  return lintEntryHygiene({
    title: current.title,
    content: current.content,
    summary: pinDraft.summary,
    bootMode: pinDraft.bootMode,
    envs: pinDraft.scope.envs,
    realms: pinDraft.scope.realms,
    projects: pinDraft.scope.projects,
    runtimes: pinDraft.scope.runtimes,
  }).filter((w) => w.code === 'pinned_oversized' || w.code === 'pinned_missing_summary')
})

const pinDraftDirty = computed(() => {
  const current = entry.value
  if (!current) return false
  if (pinDraft.bootMode !== effectiveBootMode(current)) return true
  if (
    pinDraft.bootMode === 'index' &&
    (pinDraft.summary.trim() || '') !== (current.summary?.trim() || '')
  ) {
    return true
  }
  if (pinDraft.bootMode !== 'none') {
    if (!sameList(pinDraft.scope.envs, current.envs)) return true
    if (!sameList(pinDraft.scope.realms, current.realms)) return true
    if (!sameList(pinDraft.scope.projects, current.projects)) return true
    if (!sameList(pinDraft.scope.runtimes, current.runtimes)) return true
  }
  return false
})

async function applyPinDraft() {
  const current = entry.value
  if (!current || quickBusy.value || isDeleted.value || current.kind === 'episode') return
  const editingSummary = pinDraft.bootMode === 'index'
  if (editingSummary && pinDraft.summary.trim()) {
    const parsed = EntrySummary.safeParse(pinDraft.summary)
    if (!parsed.success) {
      toast.add({
        title: parsed.error.issues[0]?.message ?? '现行概要格式有误',
        color: 'error',
      })
      return
    }
  }
  quickBusy.value = true
  try {
    const summaryChanged =
      editingSummary && (pinDraft.summary.trim() || '') !== (current.summary?.trim() || '')
    const includeScope = pinDraft.bootMode !== 'none'
    const updated = await api.updateEntry(current.shortId, {
      expectedVersion: pinBaseVersion.value ?? current.version,
      bootMode: pinDraft.bootMode,
      isPinned: pinDraft.bootMode !== 'none',
      ...(includeScope
        ? {
            envs: pinDraft.scope.envs,
            realms: pinDraft.scope.realms,
            projects: pinDraft.scope.projects,
            runtimes: pinDraft.scope.runtimes,
          }
        : {}),
      ...(summaryChanged ? { summary: pinDraft.summary.trim() || null } : {}),
    })
    queryClient.setQueryData(queryKey.value, updated)
    loadDetail(updated)
    pinPopoverOpen.value = false
    toast.add({
      title: `已设为${bootModeLabels[effectiveBootMode(updated.entry)]}`,
      color: 'success',
    })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', current.shortId] })
    emit('changed', updated)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '更新失败', color: 'error' })
    if (err instanceof ApiError && err.status === 409) {
      pinPopoverOpen.value = false
      void detailQuery.refetch()
    }
  } finally {
    quickBusy.value = false
  }
}

// 阅读态适用场景行内直改 Popover
const scopePopoverOpen = ref(false)
const scopeBaseVersion = ref<number | null>(null)
const scopeDraft = ref<SceneScopeValue>({ envs: [], realms: [], projects: [], runtimes: [] })

watch(scopePopoverOpen, (visible) => {
  const current = entry.value
  if (!visible || !current) return
  pinPopoverOpen.value = false
  scopeBaseVersion.value = current.version
  scopeDraft.value = {
    envs: [...current.envs],
    realms: [...current.realms],
    projects: [...current.projects],
    runtimes: [...current.runtimes],
  }
})

const scopeDraftCount = computed(
  () =>
    scopeDraft.value.envs.length +
    scopeDraft.value.realms.length +
    scopeDraft.value.projects.length +
    scopeDraft.value.runtimes.length,
)

const scopeDraftWarnings = computed(() => {
  const current = entry.value
  if (!scopePopoverOpen.value || !current) return []
  return lintEntryHygiene({
    title: current.title,
    content: current.content,
    summary: current.summary ?? '',
    bootMode: effectiveBootMode(current),
    envs: scopeDraft.value.envs,
    realms: scopeDraft.value.realms,
    projects: scopeDraft.value.projects,
    runtimes: scopeDraft.value.runtimes,
  }).filter((w) => w.code === 'pinned_oversized')
})

const scopeDraftDirty = computed(() => {
  const current = entry.value
  if (!current) return false
  return (
    !sameList(scopeDraft.value.envs, current.envs) ||
    !sameList(scopeDraft.value.realms, current.realms) ||
    !sameList(scopeDraft.value.projects, current.projects) ||
    !sameList(scopeDraft.value.runtimes, current.runtimes)
  )
})

const inlineScopeText = computed(() => {
  const e = entry.value
  if (!e) return '全局通用'
  const parts = [
    ...e.projects,
    ...e.runtimes.map(runtimeName),
    ...e.envs.map(envDisplayName),
    ...e.realms,
  ]
  if (!parts.length) return '全局通用'
  if (parts.length <= 3) return parts.join(' · ')
  return `${parts.slice(0, 3).join(' · ')} +${parts.length - 3}`
})

async function applyScopeDraft() {
  const current = entry.value
  if (!current || quickBusy.value || isDeleted.value || !scopeDraftDirty.value) return
  quickBusy.value = true
  try {
    const updated = await api.updateEntry(current.shortId, {
      expectedVersion: scopeBaseVersion.value ?? current.version,
      envs: scopeDraft.value.envs,
      realms: scopeDraft.value.realms,
      projects: scopeDraft.value.projects,
      runtimes: scopeDraft.value.runtimes,
    })
    queryClient.setQueryData(queryKey.value, updated)
    loadDetail(updated)
    scopePopoverOpen.value = false
    toast.add({ title: '已更新适用场景', color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', current.shortId] })
    emit('changed', updated)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '更新场景失败', color: 'error' })
    if (err instanceof ApiError && err.status === 409) {
      scopePopoverOpen.value = false
      void detailQuery.refetch()
    }
  } finally {
    quickBusy.value = false
  }
}

async function promoteEpisode() {
  const current = entry.value
  if (!current || quickBusy.value || current.kind !== 'episode' || isDeleted.value) return
  quickBusy.value = true
  try {
    const updated = await api.updateEntry(current.shortId, {
      expectedVersion: current.version,
      promoteToEntry: true,
    })
    queryClient.setQueryData(queryKey.value, updated)
    loadDetail(updated)
    toast.add({ title: '已提炼为正式记忆', color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', current.shortId] })
    emit('changed', updated)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '提炼失败', color: 'error' })
  } finally {
    quickBusy.value = false
  }
}

// 软删、恢复与彻底删除
const deleteModal = ref<'soft' | 'permanent' | null>(null)
const deleteBusy = ref(false)
const deleteError = ref<string | null>(null)

async function confirmDelete() {
  const current = entry.value
  const kind = deleteModal.value
  if (!current || !kind || deleteBusy.value) return
  deleteBusy.value = true
  deleteError.value = null
  try {
    await api.deleteEntry(current.shortId, kind === 'permanent')
    deleteModal.value = null
    leaving.value = true
    hasUnsavedChanges.value = false
    toast.add({
      title: kind === 'permanent' ? '已彻底删除' : '已移入回收站',
      color: 'success',
    })
    emit('deleted', current.shortId, kind === 'permanent')
  } catch (err) {
    deleteError.value = err instanceof ApiError ? err.message : '删除失败'
  } finally {
    deleteBusy.value = false
  }
}

const restoring = ref(false)
async function restoreFromTrash() {
  const current = entry.value
  if (!current || restoring.value) return
  organizeOpen.value = false
  restoring.value = true
  try {
    const updated = await api.restoreEntry(current.shortId, {})
    queryClient.setQueryData(queryKey.value, updated)
    loadDetail(updated)
    toast.add({ title: '已恢复', color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', current.shortId] })
    emit('restored', updated)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复失败', color: 'error' })
  } finally {
    restoring.value = false
  }
}

function openHistory(eventId: number | null = null) {
  focusedHistoryEventId.value = eventId
  historyOpen.value = true
}

watch(historyOpen, (visible) => {
  if (!visible) focusedHistoryEventId.value = null
})

function onHistoryRestored(updated: EntryDetailResponse) {
  queryClient.setQueryData(queryKey.value, updated)
  loadDetail(updated)
  mode.value = 'read'
  attrsOpen.value = false
  emit('changed', updated)
}

// 正文插入双链与凭据占位符
const contentRef = ref<{ textareaRef?: HTMLTextAreaElement } | null>(null)
function insertAtCursor(snippet: string) {
  const el = contentRef.value?.textareaRef
  if (!el) {
    form.content = form.content ? `${form.content}\n${snippet}` : snippet
    return
  }
  const start = el.selectionStart ?? form.content.length
  const end = el.selectionEnd ?? start
  form.content = `${form.content.slice(0, start)}${snippet}${form.content.slice(end)}`
  void nextTick(() => {
    el.focus()
    const pos = start + snippet.length
    el.setSelectionRange(pos, pos)
  })
}

const linkPickerOpen = ref(false)
const linkQueryInput = ref('')
const linkQuery = useDebounced(linkQueryInput, 200)
const linkMatches = useQuery({
  queryKey: computed(() => ['entry-link-lookup', linkQuery.value] as const),
  queryFn: ({ queryKey: [, q] }) => api.entries({ q: q || undefined, mode: 'lookup', limit: 10 }),
  enabled: linkPickerOpen,
})

function insertWikiLink(shortId: string) {
  insertAtCursor(`[[${shortId}]]`)
  linkPickerOpen.value = false
  linkQueryInput.value = ''
}

const credPickerOpen = ref(false)
const credentialsList = useQuery({
  queryKey: ['credentials'] as const,
  queryFn: () => api.credentials(),
  enabled: credPickerOpen,
})

function insertCredential(slug: string) {
  insertAtCursor(placeholderOf(slug))
  credPickerOpen.value = false
}

// 渲染正文的链接目标映射与展示归一化
const displayContent = computed(() =>
  entry.value ? stripDuplicateLeadingHeading(entry.value.title, entry.value.content) : '',
)
const previewContent = computed(() => stripDuplicateLeadingHeading(form.title, form.content))
const sourceLineCount = computed(() => form.content.replace(/\r\n/g, '\n').split('\n').length)
const duplicateLeadingHeadingHidden = computed(() =>
  hasDuplicateLeadingHeading(form.title, form.content),
)
const contentChanged = computed(() => Boolean(entry.value && form.content !== entry.value.content))

useMarkdownSyncScroll({
  enabled: syncScroll,
  active: computed(() => mode.value === 'edit' && editView.value === 'split'),
  content: computed(() => form.content),
  title: computed(() => form.title),
  getSourceEl: () => contentRef.value?.textareaRef ?? null,
  getPreviewEl: () => previewScrollRef.value,
})
const outline = computed(() =>
  extractMarkdownOutline(displayContent.value).map((sec) => ({
    ...sec,
    displayHeading: stripInlineMarkdown(sec.heading) || sec.heading,
  })),
)
const recentHistory = computed(() => detail.value?.recentHistory ?? [])
const railHistory = computed(() => recentHistory.value.slice(0, 3))
const latestActorLabel = computed(() => {
  const latest = recentHistory.value[0]
  return latest ? formatActorLabel(latest.actor, latest.actorMeta) : null
})
const latestChangeText = computed(() => {
  const explicit = entry.value?.lastChangeSummary?.trim()
  if (explicit) return explicit
  return recentHistory.value[0]?.changeSummary?.trim() || null
})
const hasLinks = computed(
  () => Boolean(detail.value?.outboundLinks.length) || Boolean(detail.value?.backlinks.length),
)
const hasSideRail = computed(
  () => outline.value.length > 0 || recentHistory.value.length > 0 || hasLinks.value,
)
const isRailActive = computed(
  () => mode.value === 'read' && hasSideRail.value && editorScrollWidth.value >= RAIL_CONTAINER_MIN,
)
const hasReadMetaStrip = computed(() => {
  const e = entry.value
  if (!e) return false
  return Boolean(e.topics.length || e.disclosure || e.validTo || e.verifiedAt)
})
const railHistoryOnly = computed(() => outline.value.length === 0 && !hasLinks.value)
const railHistoryExpanded = ref(false)
const railHistoryListId = useId()

watch(
  () => props.shortId,
  () => {
    railHistoryExpanded.value = false
  },
)

// 右侧辅助轨默认按容器弹性自适应，拖拽后持久化像素宽度，双击分隔线恢复自适应
const editorScrollRef = ref<HTMLElement | null>(null)
const readRailRef = ref<HTMLElement | null>(null)
const editorScrollHeight = ref(0)
const storedRailWidth = ref<number | null>(
  parseStoredRailWidth(readStoredString(UI_STORAGE_KEYS.readRailWidth)),
)
const railResizing = ref(false)
const railDragged = ref(false)
let editorScrollObserver: ResizeObserver | null = null
let railDragStartX = 0
let railDragStartWidth = 320

function measureContentBox(el: HTMLElement): { width: number; height: number } {
  const cs = getComputedStyle(el)
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
  return {
    width: Math.max(0, Math.round(el.clientWidth - padX)),
    height: Math.max(0, Math.round(el.clientHeight - padY)),
  }
}

const maxRailWidth = computed(() => computeMaxRailWidth(editorScrollWidth.value))

const effectiveRailWidth = computed<number | null>(() => {
  if (storedRailWidth.value === null) return null
  return clampRailWidth(storedRailWidth.value, maxRailWidth.value)
})

const ariaRailWidth = computed(
  () => effectiveRailWidth.value ?? estimateElasticRailWidth(editorScrollWidth.value),
)

const readLayoutStyle = computed<Record<string, string> | undefined>(() => {
  const style: Record<string, string> = {}
  if (effectiveRailWidth.value !== null) {
    style['--rail-width'] = `${effectiveRailWidth.value}px`
  }
  if (editorScrollHeight.value > 0) {
    style['--rail-max-height'] = `${editorScrollHeight.value}px`
  }
  return Object.keys(style).length ? style : undefined
})

function currentRailWidthPx(): number {
  if (effectiveRailWidth.value !== null) return effectiveRailWidth.value
  const measured = readRailRef.value?.getBoundingClientRect().width ?? 0
  if (measured > 0) return clampRailWidth(measured, maxRailWidth.value)
  return estimateElasticRailWidth(editorScrollWidth.value)
}

function onRailPointerMove(event: PointerEvent) {
  if (!railResizing.value) return
  const deltaX = event.clientX - railDragStartX
  if (!railDragged.value && Math.abs(deltaX) < 2) return
  railDragged.value = true
  storedRailWidth.value = clampRailWidth(railDragStartWidth - deltaX, maxRailWidth.value)
}

function stopRailResize() {
  if (!railResizing.value) return
  const dragged = railDragged.value
  railResizing.value = false
  railDragged.value = false
  window.removeEventListener('pointermove', onRailPointerMove)
  window.removeEventListener('pointerup', stopRailResize)
  window.removeEventListener('pointercancel', stopRailResize)
  window.removeEventListener('blur', stopRailResize)
  if (dragged && storedRailWidth.value !== null) {
    writeStoredString(UI_STORAGE_KEYS.readRailWidth, String(storedRailWidth.value))
  }
}

function startRailResize(event: PointerEvent) {
  if (
    railResizing.value ||
    event.button !== 0 ||
    mode.value !== 'read' ||
    (editorScrollWidth.value > 0 && editorScrollWidth.value < RAIL_CONTAINER_MIN)
  ) {
    return
  }
  event.preventDefault()
  railDragStartX = event.clientX
  railDragStartWidth = currentRailWidthPx()
  railDragged.value = false
  railResizing.value = true
  window.addEventListener('pointermove', onRailPointerMove)
  window.addEventListener('pointerup', stopRailResize)
  window.addEventListener('pointercancel', stopRailResize)
  window.addEventListener('blur', stopRailResize)
}

function resetRailWidth() {
  stopRailResize()
  storedRailWidth.value = null
  writeStoredString(UI_STORAGE_KEYS.readRailWidth, null)
}

function onRailSplitterKeydown(event: KeyboardEvent) {
  if (
    mode.value !== 'read' ||
    (editorScrollWidth.value > 0 && editorScrollWidth.value < RAIL_CONTAINER_MIN)
  ) {
    return
  }
  const step = event.shiftKey ? 40 : 16
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    const next = clampRailWidth(currentRailWidthPx() + step, maxRailWidth.value)
    storedRailWidth.value = next
    writeStoredString(UI_STORAGE_KEYS.readRailWidth, String(next))
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    const next = clampRailWidth(currentRailWidthPx() - step, maxRailWidth.value)
    storedRailWidth.value = next
    writeStoredString(UI_STORAGE_KEYS.readRailWidth, String(next))
  } else if (event.key === 'Home') {
    event.preventDefault()
    resetRailWidth()
  }
}

watch([mode, hasSideRail], ([nextMode, hasRail]) => {
  if (nextMode !== 'read' || !hasRail) stopRailResize()
})

watch(
  editorScrollRef,
  (el) => {
    editorScrollObserver?.disconnect()
    editorScrollObserver = null
    if (!el) {
      stopRailResize()
      editorScrollWidth.value = 0
      editorScrollHeight.value = 0
      return
    }
    const box = measureContentBox(el)
    editorScrollWidth.value = box.width
    editorScrollHeight.value = box.height
    if (typeof ResizeObserver === 'undefined') return
    editorScrollObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      const w = Math.max(0, Math.round(rect.width))
      const h = Math.max(0, Math.round(rect.height))
      editorScrollWidth.value = w
      editorScrollHeight.value = h
      if (w < RAIL_CONTAINER_MIN) stopRailResize()
    })
    editorScrollObserver.observe(el)
  },
  { flush: 'post' },
)

const { me } = useSession()
const hasChatModel = computed(() => Boolean(me.data.value?.hasChatModel))
const pendingSuggestionCount = computed(() => detail.value?.pendingSuggestionCount ?? 0)
const organizeOpen = ref(false)
const organizeMode = ref<SingleOrganizeMode>('tidy')
const refineOpen = ref(false)

watch(isDeleted, (deleted) => {
  if (deleted) {
    organizeOpen.value = false
    refineOpen.value = false
  }
})

function openOrganize(targetMode: SingleOrganizeMode) {
  if (!hasChatModel.value || !entry.value || isDeleted.value || entry.value.kind !== 'entry') return
  organizeMode.value = targetMode
  organizeOpen.value = true
}

function openRefine() {
  if (!hasChatModel.value || !entry.value || isDeleted.value || entry.value.kind !== 'entry') return
  refineOpen.value = true
}

const organizeMenuItems = computed<DropdownMenuItem[][]>(() => {
  if (!hasChatModel.value) {
    return [[{ type: 'label', label: '请先在设置中配置对话模型' }]]
  }
  return [
    [
      {
        label: '按说明修订',
        icon: icons.sparkles,
        onSelect: () => openRefine(),
      },
      {
        label: '规范此条',
        icon: icons.tidy,
        onSelect: () => openOrganize('tidy'),
      },
      {
        label: '查重与关联',
        icon: icons.links,
        onSelect: () => openOrganize('cross_check'),
      },
    ],
  ]
})

// 手机端阅读态顶栏「更多」菜单，将次级操作收拢释放首屏空间
const mobileMoreMenuItems = computed<DropdownMenuItem[][]>(() => {
  const e = entry.value
  if (!e) return []
  const primaryGroup: DropdownMenuItem[] = []
  if (!isDeleted.value && e.kind === 'episode') {
    primaryGroup.push({
      label: '提炼为正式记忆',
      icon: icons.promote,
      disabled: quickBusy.value,
      onSelect: () => void promoteEpisode(),
    })
  }
  primaryGroup.push({
    label: '历史',
    icon: icons.history,
    onSelect: () => openHistory(),
  })
  if (isDeleted.value) {
    primaryGroup.push({
      label: '恢复',
      icon: icons.undelete,
      disabled: restoring.value,
      onSelect: () => void restoreFromTrash(),
    })
  }
  const dangerGroup: DropdownMenuItem[] = [
    {
      label: isDeleted.value ? '彻底删除' : '删除',
      icon: icons.remove,
      color: 'error',
      disabled: quickBusy.value,
      onSelect: () => {
        deleteModal.value = isDeleted.value ? 'permanent' : 'soft'
        deleteError.value = null
      },
    },
  ]
  return [primaryGroup, dangerGroup]
})

function onSingleTidyApplied(updated: EntryDetailResponse) {
  queryClient.setQueryData(queryKey.value, updated)
  loadDetail(updated)
  emit('changed', updated)
}

function onSingleTidyStaged() {
  void detailQuery.refetch()
}

function jumpToSection(heading: string, index: number) {
  readContentRef.value?.scrollToHeading(heading, index)
}

const resolvedTitles = computed(() => {
  const byShortId = new Map<string, { title: string }>()
  for (const [sid, title] of Object.entries(detail.value?.linkedTitles ?? {})) {
    if (title) byShortId.set(sid, { title })
  }
  for (const link of detail.value?.outboundLinks ?? []) {
    byShortId.set(link.shortId, { title: link.title })
  }
  for (const link of detail.value?.backlinks ?? []) {
    byShortId.set(link.shortId, { title: link.title })
  }
  return byShortId
})

const latestChangePlainText = computed(() => {
  const raw = latestChangeText.value
  if (!raw) return ''
  return splitWikiLinks(raw)
    .map((seg) => {
      if (!seg.link) return seg.text
      const { shortId, alias } = seg.link
      return alias ?? resolvedTitles.value.get(shortId)?.title ?? shortId
    })
    .join('')
})

const wikiLinks = computed<WikiLinkTargets>(() => ({
  byShortId: resolvedTitles.value,
  href: (sid) => router.resolve(entryRoute(sid)).href,
}))

const credentialLinks = computed<CredentialLinks>(() => {
  const bySlug = new Map<string, { slug: string; label: string | null; available: boolean }>()
  for (const refItem of detail.value?.credentialRefs ?? []) {
    bySlug.set(refItem.slug, {
      slug: refItem.slug,
      label: refItem.label,
      available: refItem.available,
    })
  }
  return {
    bySlug,
    href: (slug) => router.resolve(credentialRoute(slug)).href,
  }
})

function openCredential(slug: string) {
  void router.push(credentialRoute(slug))
}

const scopeTags = computed(() => {
  const e = entry.value
  if (!e) return []
  return [
    ...e.envs.map((v) => `环境:${envDisplayName(v)}`),
    ...e.realms.map((v) => `场域:${v}`),
    ...e.projects.map((v) => `项目:${v}`),
    ...e.runtimes.map((v) => `客户端:${runtimeName(v)}`),
  ]
})

const editAttrsSummary = computed(() => {
  const parts: string[] = []
  if (entry.value?.kind === 'entry') {
    parts.push(bootModeLabels[form.bootMode])
  }
  if (form.topics.length) parts.push(`${form.topics.length} 个主题`)
  const scopeCount =
    scope.value.envs.length +
    scope.value.realms.length +
    scope.value.projects.length +
    scope.value.runtimes.length
  parts.push(scopeCount > 0 ? `${scopeCount} 项场景限定` : '全局通用')
  if (form.disclosure.trim()) {
    parts.push(entry.value?.kind === 'episode' ? '已设信号要点' : '已设召回时机')
  }
  if (form.validTo) parts.push('已设有效期')
  return parts.join(' · ')
})

function onEditorKeydown(event: KeyboardEvent) {
  if (mode.value !== 'edit' || event.isComposing) return
  if (
    historyOpen.value ||
    deleteModal.value !== null ||
    document.querySelector('[role="dialog"]')
  ) {
    return
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 's'
  ) {
    event.preventDefault()
    void save()
  }
}

onMounted(() => window.addEventListener('keydown', onEditorKeydown))
onBeforeUnmount(() => {
  stopRailResize()
  editorScrollObserver?.disconnect()
  editorScrollObserver = null
  window.removeEventListener('keydown', onEditorKeydown)
  if (shortIdCopyTimer) {
    clearTimeout(shortIdCopyTimer)
    shortIdCopyTimer = null
  }
})

const titleEl = ref<HTMLElement | null>(null)
defineExpose({
  focusTitle: () => titleEl.value?.focus(),
  isEditing: () => mode.value === 'edit',
  exitEditing: () => {
    if (mode.value !== 'edit') return false
    if (dirty.value && !confirmDiscard()) return false
    cancelEditing()
    return true
  },
})
</script>

<template>
  <article
    class="editor-pane"
    :class="{
      'is-editing': mode === 'edit',
      'is-split': mode === 'edit' && editView === 'split',
      'is-single-col': mode === 'read' && !isRailActive,
    }"
  >
    <div v-if="showBack" class="mobile-back-bar">
      <UButton
        v-if="mode === 'edit' && isPhone"
        size="sm"
        color="neutral"
        variant="ghost"
        :icon="icons.cancel"
        :disabled="saving"
        class="shrink-0 whitespace-nowrap"
        @click="requestCancelEditing"
      >
        退出编辑
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

      <div v-if="entry" class="mobile-bar-actions">
        <template v-if="mode === 'read'">
          <UButton
            v-if="!isDeleted"
            size="xs"
            :variant="entry.kind === 'episode' ? 'outline' : 'solid'"
            :icon="icons.edit"
            :disabled="quickBusy"
            class="shrink-0 whitespace-nowrap"
            @click="startEditing"
          >
            编辑
          </UButton>
          <UDropdownMenu
            v-if="!isDeleted && entry.kind === 'entry'"
            :items="organizeMenuItems"
            :content="{ align: 'end' }"
            :ui="{ content: 'min-w-44' }"
          >
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.tidy"
              :trailing-icon="icons.chevronDown"
              :disabled="!hasChatModel || quickBusy"
              :title="
                hasChatModel ? '按说明修订、规范此条或查重与关联' : '请先在设置中配置对话模型'
              "
              class="shrink-0 whitespace-nowrap"
            >
              整理
            </UButton>
          </UDropdownMenu>
          <UDropdownMenu
            :items="mobileMoreMenuItems"
            :content="{ align: 'end' }"
            :ui="{ content: 'min-w-40' }"
          >
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :trailing-icon="icons.chevronDown"
              aria-label="更多操作"
              class="shrink-0 whitespace-nowrap"
            >
              更多
            </UButton>
          </UDropdownMenu>
        </template>
        <SegmentedChoice
          v-else
          v-model="editView"
          :items="visibleEditViewOptions"
          label="编辑区视图模式"
          compact
        />
      </div>
    </div>
    <div v-if="detailQuery.isPending.value && !entry" class="p-6 space-y-4">
      <USkeleton class="h-7 w-1/2" />
      <USkeleton class="h-48 w-full" />
    </div>
    <div v-else-if="!entry" class="p-6">
      <ReadFailureNote :query="detailQuery" />
    </div>
    <template v-else>
      <header class="editor-head">
        <div class="head-main">
          <div class="head-identity">
            <div class="head-title-row">
              <h1 ref="titleEl" tabindex="-1">{{ entry.title }}</h1>
              <span v-if="entry.kind === 'episode'" class="pill status-episode">
                <span class="rail-swatch dashed" aria-hidden="true" />
                会话摘要
              </span>
              <span v-if="isDeleted" class="pill danger">
                <UIcon :name="icons.remove" class="pill-icon" aria-hidden="true" />
                <span>已在回收站</span>
              </span>
            </div>

            <!-- 行内常驻/场景直改 + 轻量动态元信息与低调短 ID 复制入口 -->
            <div class="head-status-line">
              <template v-if="mode === 'read' && !isDeleted && entry.kind === 'entry'">
                <UPopover
                  v-model:open="pinPopoverOpen"
                  :dismissible="!quickBusy"
                  :content="{ align: 'start', sideOffset: 6 }"
                >
                  <button
                    type="button"
                    class="inline-chip"
                    :class="{
                      'is-pinned': entryBootMode === 'full',
                      'is-index': entryBootMode === 'index',
                    }"
                    :disabled="quickBusy"
                    :aria-expanded="pinPopoverOpen"
                    title="点击直接调整启动加载方式"
                  >
                    <span
                      v-if="entryBootMode === 'full'"
                      class="rail-swatch solid"
                      aria-hidden="true"
                    />
                    <span
                      v-else-if="entryBootMode === 'index'"
                      class="rail-swatch index"
                      aria-hidden="true"
                    />
                    <UIcon
                      v-else
                      :name="icons.bookOpen"
                      class="inline-chip-icon"
                      aria-hidden="true"
                    />
                    <span>{{ bootModeLabels[entryBootMode] }}</span>
                    <UIcon :name="icons.chevronDown" class="inline-chip-caret" aria-hidden="true" />
                  </button>
                  <template #content>
                    <div class="pin-popover">
                      <div class="pin-popover-head">
                        <span class="pin-popover-title">
                          <UIcon :name="icons.pin" class="pin-title-icon" aria-hidden="true" />
                          <span>启动加载方式</span>
                        </span>
                        <span class="text-xs text-muted tabular-nums">
                          约 {{ entry.content.length.toLocaleString() }} 字
                        </span>
                      </div>

                      <div class="pin-popover-body">
                        <div class="pin-mode-list" role="radiogroup" aria-label="选择启动加载方式">
                          <button
                            v-for="modeOpt in BOOT_MODES"
                            :key="modeOpt"
                            type="button"
                            role="radio"
                            class="pin-mode-card"
                            :class="{ active: pinDraft.bootMode === modeOpt }"
                            :aria-checked="pinDraft.bootMode === modeOpt"
                            :disabled="quickBusy"
                            @click="pinDraft.bootMode = modeOpt"
                          >
                            <span class="pin-mode-head">
                              <span class="pin-mode-name">
                                <UIcon
                                  :name="bootModeIcons[modeOpt]"
                                  class="pin-mode-icon"
                                  aria-hidden="true"
                                />
                                <span>{{ bootModeLabels[modeOpt] }}</span>
                              </span>
                              <UIcon
                                v-if="pinDraft.bootMode === modeOpt"
                                :name="icons.check"
                                class="pin-mode-check"
                                aria-hidden="true"
                              />
                            </span>
                            <span class="pin-mode-desc">{{ bootModeDescriptions[modeOpt] }}</span>
                          </button>
                        </div>

                        <p v-if="pinDraft.recommendedIndex" class="text-xs text-muted">
                          正文超过 1,200 字，已默认推荐目录常驻。
                        </p>

                        <NoteLine v-if="pinDraftWarnings.length" tone="warning" flush>
                          {{ pinDraftWarnings.map((w) => w.message).join('；') }}
                        </NoteLine>

                        <div v-if="pinDraft.bootMode === 'index'" class="space-y-1">
                          <label for="pin-summary-input" class="pin-field-label">
                            <UIcon
                              :name="icons.summary"
                              class="field-label-icon"
                              aria-hidden="true"
                            />
                            <span>现行概要（用于启动目录行）</span>
                          </label>
                          <UTextarea
                            id="pin-summary-input"
                            v-model="pinDraft.summary"
                            :rows="2"
                            autoresize
                            :maxrows="3"
                            :maxlength="ENTRY_SUMMARY_MAX"
                            :disabled="quickBusy"
                            placeholder="1–2 句概括当前结论，便于会话启动判断是否展开全文"
                            class="w-full"
                          />
                        </div>

                        <div v-if="pinDraft.bootMode !== 'none'" class="pin-scope-box">
                          <button
                            type="button"
                            class="pin-scope-toggle"
                            :aria-expanded="pinDraft.scopeExpanded"
                            @click="pinDraft.scopeExpanded = !pinDraft.scopeExpanded"
                          >
                            <span class="pin-scope-lead">
                              <UIcon
                                :name="icons.sliders"
                                class="pin-scope-icon"
                                aria-hidden="true"
                              />
                              <span>确认适用场景</span>
                            </span>
                            <UIcon
                              :name="
                                pinDraft.scopeExpanded ? icons.chevronDown : icons.chevronRight
                              "
                              class="attrs-chevron"
                              aria-hidden="true"
                            />
                          </button>
                          <div v-if="pinDraft.scopeExpanded" class="pin-scope-body">
                            <SceneScopePicker
                              v-model="pinDraft.scope"
                              :facets="facets"
                              :disabled="quickBusy"
                            />
                          </div>
                        </div>
                      </div>

                      <div class="pin-popover-foot">
                        <UButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          :disabled="quickBusy"
                          @click="pinPopoverOpen = false"
                        >
                          取消
                        </UButton>
                        <UButton
                          size="xs"
                          :icon="icons.check"
                          :loading="quickBusy"
                          :disabled="!pinDraftDirty"
                          @click="applyPinDraft"
                        >
                          保存设置
                        </UButton>
                      </div>
                    </div>
                  </template>
                </UPopover>

                <UPopover
                  v-model:open="scopePopoverOpen"
                  :dismissible="!quickBusy"
                  :content="{ align: 'start', sideOffset: 6 }"
                >
                  <button
                    type="button"
                    class="inline-chip"
                    :disabled="quickBusy"
                    :aria-expanded="scopePopoverOpen"
                    :title="
                      scopeTags.length
                        ? `适用场景：${scopeTags.join('、')}（点击修改）`
                        : '当前为全局通用（点击限定适用场景）'
                    "
                  >
                    <UIcon
                      :name="scopeTags.length ? icons.sliders : icons.globe"
                      class="inline-chip-icon"
                      aria-hidden="true"
                    />
                    <span class="inline-chip-text">{{ inlineScopeText }}</span>
                    <UIcon :name="icons.chevronDown" class="inline-chip-caret" aria-hidden="true" />
                  </button>
                  <template #content>
                    <div class="pin-popover">
                      <div class="pin-popover-head">
                        <span class="pin-popover-title">
                          <UIcon :name="icons.sliders" class="pin-title-icon" aria-hidden="true" />
                          <span>适用场景</span>
                        </span>
                        <span class="text-xs text-muted">
                          {{ scopeDraftCount ? '已限定场景' : '全局通用' }}
                        </span>
                      </div>
                      <div class="pin-popover-body">
                        <SceneScopePicker
                          v-model="scopeDraft"
                          :facets="facets"
                          :disabled="quickBusy"
                        />
                        <NoteLine v-if="scopeDraftWarnings.length" tone="warning" flush>
                          {{ scopeDraftWarnings.map((w) => w.message).join('；') }}
                        </NoteLine>
                      </div>
                      <div class="pin-popover-foot">
                        <UButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          :disabled="quickBusy"
                          @click="scopePopoverOpen = false"
                        >
                          取消
                        </UButton>
                        <UButton
                          size="xs"
                          :icon="icons.check"
                          :loading="quickBusy"
                          :disabled="!scopeDraftDirty"
                          @click="applyScopeDraft"
                        >
                          保存场景
                        </UButton>
                      </div>
                    </div>
                  </template>
                </UPopover>

                <span class="status-sep" aria-hidden="true">·</span>
              </template>

              <span class="tabular-nums">版本 {{ entry.version }}</span>
              <span class="status-sep" aria-hidden="true">·</span>
              <time :datetime="entry.updatedAt" :title="formatTime(entry.updatedAt)">
                {{ formatRelative(entry.updatedAt) }}更新<template v-if="latestActorLabel"
                  >（{{ latestActorLabel }}）</template
                >
              </time>
              <template v-if="entry.isPinned">
                <span class="status-sep" aria-hidden="true">·</span>
                <span class="tabular-nums">
                  约 {{ (entry.content.length + entry.title.length).toLocaleString() }} 字
                </span>
              </template>
              <template v-if="mode === 'read' && pendingSuggestionCount > 0">
                <span class="status-sep" aria-hidden="true">·</span>
                <RouterLink :to="{ name: 'organize' }" class="text-primary status-history-link">
                  <UIcon :name="icons.listChecks" class="status-inline-icon" aria-hidden="true" />
                  <span>待确认建议（{{ pendingSuggestionCount }}）</span>
                </RouterLink>
              </template>
              <span class="status-sep" aria-hidden="true">·</span>
              <button
                type="button"
                class="status-copy-id"
                :title="`点击复制记忆短 ID：${entry.shortId}`"
                :aria-label="`复制短 ID ${entry.shortId}`"
                @click="copyShortId"
              >
                <span class="status-id-prefix">ID:</span>
                <code class="status-id-code font-mono">{{ entry.shortId }}</code>
                <UIcon
                  :name="shortIdCopied ? icons.check : icons.copy"
                  class="status-inline-icon"
                  :class="{ 'is-copied': shortIdCopied }"
                  aria-hidden="true"
                />
              </button>
            </div>
            <div v-if="latestChangeText" class="head-change-line" :title="latestChangePlainText">
              <span class="status-change-label">近改：</span>
              <WikiText
                :text="latestChangeText"
                :titles="resolvedTitles"
                compact
                @open="emit('open', $event)"
              />
            </div>
          </div>

          <div class="head-actions">
            <template v-if="mode === 'read'">
              <UButton
                v-if="!isDeleted && entry.kind === 'episode'"
                size="sm"
                :icon="icons.promote"
                :loading="quickBusy"
                @click="promoteEpisode"
              >
                提炼为正式记忆
              </UButton>
              <UButton
                v-if="!isDeleted"
                size="sm"
                :variant="entry.kind === 'episode' ? 'outline' : 'solid'"
                :icon="icons.edit"
                :disabled="quickBusy"
                @click="startEditing"
              >
                编辑
              </UButton>
              <UDropdownMenu
                v-if="!isDeleted && entry.kind === 'entry'"
                :items="organizeMenuItems"
                :content="{ align: 'end' }"
                :ui="{ content: 'min-w-44' }"
              >
                <UButton
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :icon="icons.tidy"
                  :trailing-icon="icons.chevronDown"
                  :disabled="!hasChatModel || quickBusy"
                  :title="
                    hasChatModel ? '按说明修订、规范此条或查重与关联' : '请先在设置中配置对话模型'
                  "
                >
                  整理
                </UButton>
              </UDropdownMenu>
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.history"
                @click="openHistory()"
              >
                历史
              </UButton>
              <UButton
                v-if="!showBack"
                size="sm"
                color="neutral"
                variant="outline"
                :icon="fullscreen ? icons.minimize : icons.maximize"
                class="desktop-fullscreen-btn"
                @click="emit('toggleFullscreen')"
              >
                {{ fullscreen ? '退出全屏' : '全屏' }}
              </UButton>
              <UButton
                v-if="isDeleted"
                size="sm"
                :icon="icons.undelete"
                :loading="restoring"
                @click="restoreFromTrash"
              >
                恢复
              </UButton>
              <UButton
                size="sm"
                color="error"
                variant="outline"
                :icon="icons.remove"
                :disabled="quickBusy"
                @click="((deleteModal = isDeleted ? 'permanent' : 'soft'), (deleteError = null))"
              >
                {{ isDeleted ? '彻底删除' : '删除' }}
              </UButton>
            </template>
            <template v-else>
              <UButton
                v-if="!showBack"
                size="sm"
                color="neutral"
                variant="ghost"
                :icon="fullscreen ? icons.minimize : icons.maximize"
                class="desktop-fullscreen-btn"
                @click="emit('toggleFullscreen')"
              >
                {{ fullscreen ? '退出全屏' : '全屏' }}
              </UButton>
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.cancel"
                :disabled="saving"
                @click="requestCancelEditing"
              >
                退出编辑
              </UButton>
            </template>
          </div>
        </div>
      </header>

      <div ref="editorScrollRef" class="editor-scroll" :class="{ 'is-editing': mode === 'edit' }">
        <ReadFailureNote v-if="detailQuery.isError.value" :query="detailQuery" />

        <NoteLine v-if="expiredNow" tone="warning">
          该记忆已于 {{ formatShort(entry.validTo!) }} 过期，不再参与召回与启动加载。
        </NoteLine>

        <!-- 编辑模式 -->
        <template v-if="mode === 'edit'">
          <div class="edit-stack">
            <div class="edit-meta-grid">
              <UFormField label="标题">
                <template #label>
                  <span class="field-label">
                    <UIcon :name="icons.heading" class="field-label-icon" aria-hidden="true" />
                    <span>标题</span>
                  </span>
                </template>
                <UInput v-model="form.title" :maxlength="ENTRY_TITLE_MAX" class="w-full" />
                <template v-if="titleHint.message" #help>
                  <div class="title-hint-row">
                    <span class="title-hint-text">{{ titleHint.message }}</span>
                    <UButton
                      v-if="titleHint.splittable"
                      type="button"
                      size="xs"
                      color="warning"
                      variant="outline"
                      :icon="icons.split"
                      @click="splitTitleToChangeSummary"
                    >
                      拆出至变更说明
                    </UButton>
                  </div>
                </template>
              </UFormField>

              <UFormField label="现行概要（可选）">
                <template #label>
                  <span class="field-label">
                    <UIcon :name="icons.summary" class="field-label-icon" aria-hidden="true" />
                    <span>现行概要（可选）</span>
                  </span>
                </template>
                <UTextarea
                  v-model="form.summary"
                  :rows="1"
                  autoresize
                  :maxrows="3"
                  :maxlength="ENTRY_SUMMARY_MAX"
                  :ui="{ base: 'py-[5px] text-sm/5 resize-none' }"
                  placeholder="1–2 句概括当前结论，用于启动加载与列表预览"
                  class="w-full"
                />
              </UFormField>
            </div>

            <!-- 可折叠属性与场景区：默认收起以释放首屏正文空间 -->
            <div class="attrs-collapse">
              <button
                type="button"
                class="attrs-toggle"
                :aria-expanded="attrsOpen"
                @click="attrsOpen = !attrsOpen"
              >
                <span class="attrs-toggle-lead">
                  <UIcon
                    :name="attrsOpen ? icons.chevronDown : icons.chevronRight"
                    class="attrs-chevron"
                    aria-hidden="true"
                  />
                  <UIcon :name="icons.sliders" class="attrs-icon" aria-hidden="true" />
                  <span>属性与场景</span>
                </span>
                <span class="attrs-summary">{{ editAttrsSummary }}</span>
              </button>

              <div v-if="attrsOpen" class="attrs-body space-y-4">
                <div class="grid gap-3 sm:grid-cols-2">
                  <UFormField label="主题">
                    <template #label>
                      <span class="field-label">
                        <UIcon :name="icons.topic" class="field-label-icon" aria-hidden="true" />
                        <span>主题</span>
                      </span>
                    </template>
                    <UInputTags
                      v-model="form.topics"
                      add-on-blur
                      placeholder="输入后回车"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="启动加载方式">
                    <template #label>
                      <span class="field-label">
                        <UIcon :name="icons.pin" class="field-label-icon" aria-hidden="true" />
                        <span>启动加载方式</span>
                      </span>
                    </template>
                    <SegmentedChoice
                      v-if="entry.kind === 'entry'"
                      v-model="form.bootMode"
                      :items="BOOT_MODE_OPTIONS"
                      label="启动加载方式"
                    />
                    <span v-else class="text-xs text-muted">会话摘要不支持设为启动加载</span>
                    <template v-if="entry.kind === 'entry'" #help>
                      <span>{{ bootModeDescriptions[form.bootMode] }}</span>
                    </template>
                  </UFormField>
                </div>

                <UFormField label="适用场景">
                  <SceneScopePicker v-model="scope" :facets="facets" />
                </UFormField>

                <div class="grid gap-3 sm:grid-cols-2">
                  <UFormField
                    :label="entry.kind === 'episode' ? '信号要点（可选）' : '召回时机（可选）'"
                  >
                    <UInput v-model="form.disclosure" :maxlength="DISCLOSURE_MAX" class="w-full" />
                  </UFormField>
                  <UFormField label="有效期（可选）">
                    <UInput
                      v-model="form.validTo"
                      type="datetime-local"
                      :min="minValidTo"
                      class="w-full"
                      @focus="minValidTo = earliestValidTo()"
                    />
                  </UFormField>
                </div>
              </div>
            </div>

            <NoteLine v-if="editBootWarnings.length" tone="warning">
              {{ editBootWarnings.map((w) => w.message).join('；') }}
              <template v-if="editBootWarnings.some((w) => w.code === 'pinned_oversized')" #actions>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.bookmark"
                  @click="form.bootMode = 'index'"
                >
                  改为目录常驻
                </UButton>
              </template>
            </NoteLine>

            <NoteLine v-if="secretWarnings.length" tone="warning">
              正文疑似包含{{
                secretWarnings.map((w) => w.label).join('、')
              }}，建议改存凭据并用占位符引用。
              <template #actions>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.credentials"
                  :to="{ name: 'credentials' }"
                >
                  前往凭据
                </UButton>
              </template>
            </NoteLine>

            <div class="edit-toolbar">
              <UPopover v-model:open="linkPickerOpen">
                <UButton
                  type="button"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.links"
                >
                  插入双链
                </UButton>
                <template #content>
                  <div class="w-72 space-y-2 p-2.5">
                    <UInput
                      v-model="linkQueryInput"
                      size="xs"
                      :icon="icons.search"
                      placeholder="按标题或短 ID 查找"
                      class="w-full"
                    />
                    <ul class="max-h-52 divide-y divide-default overflow-y-auto text-sm">
                      <li
                        v-for="item in (linkMatches.data.value?.items ?? []).filter(
                          (x) => x.shortId !== entry?.shortId,
                        )"
                        :key="item.shortId"
                      >
                        <button
                          type="button"
                          class="flex w-full items-center gap-2 px-1.5 py-1.5 text-left hover:bg-elevated"
                          :title="`${item.title}（${item.shortId}）`"
                          @click="insertWikiLink(item.shortId)"
                        >
                          <span class="truncate">{{ item.title }}</span>
                        </button>
                      </li>
                      <li
                        v-if="!linkMatches.isPending.value && !linkMatches.data.value?.items.length"
                        class="py-3 text-center text-xs text-muted"
                      >
                        暂无匹配记忆
                      </li>
                    </ul>
                  </div>
                </template>
              </UPopover>

              <UPopover v-model:open="credPickerOpen">
                <UButton
                  type="button"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.credentials"
                >
                  插入凭据
                </UButton>
                <template #content>
                  <div class="w-72 p-2.5">
                    <ul class="max-h-52 divide-y divide-default overflow-y-auto text-sm">
                      <li v-for="cred in credentialsList.data.value?.items ?? []" :key="cred.id">
                        <button
                          type="button"
                          class="flex w-full items-baseline justify-between gap-2 px-1.5 py-1.5 text-left hover:bg-elevated"
                          @click="insertCredential(cred.slug)"
                        >
                          <span class="truncate">{{ cred.label }}</span>
                          <span class="shrink-0 font-mono text-xs text-muted">{{ cred.slug }}</span>
                        </button>
                      </li>
                      <li
                        v-if="
                          !credentialsList.isPending.value &&
                          !credentialsList.data.value?.items.length
                        "
                        class="py-3 text-center text-xs text-muted"
                      >
                        暂无凭据
                      </li>
                    </ul>
                  </div>
                </template>
              </UPopover>

              <div class="toolbar-right">
                <UButton
                  v-if="editView === 'split'"
                  type="button"
                  size="xs"
                  :color="syncScroll ? 'primary' : 'neutral'"
                  :variant="syncScroll ? 'solid' : 'outline'"
                  :icon="syncScroll ? icons.syncScroll : icons.unsyncScroll"
                  :aria-pressed="syncScroll"
                  @click="syncScroll = !syncScroll"
                >
                  同步滚动
                </UButton>
                <SegmentedChoice
                  v-model="editView"
                  :items="visibleEditViewOptions"
                  label="编辑区视图模式"
                  compact
                />
              </div>
            </div>

            <div ref="workbenchRef" class="editor-workbench" :class="`mode-${editView}`">
              <div v-show="editView !== 'preview'" class="workbench-pane pane-source">
                <div class="pane-head">
                  <span class="pane-head-lead">
                    <UIcon :name="icons.code" class="pane-head-icon" aria-hidden="true" />
                    <span>Markdown 源码</span>
                  </span>
                  <span class="pane-head-meta tabular-nums">
                    {{ sourceLineCount }} 行 · {{ form.content.length.toLocaleString() }} 字
                  </span>
                </div>
                <UTextarea
                  ref="contentRef"
                  v-model="form.content"
                  variant="none"
                  :rows="editView === 'split' ? undefined : 18"
                  :autoresize="editView === 'edit'"
                  :maxrows="editView === 'edit' ? 36 : undefined"
                  class="source-input w-full font-mono"
                  aria-label="正文"
                />
              </div>

              <div v-if="editView !== 'edit'" class="workbench-pane pane-preview">
                <div class="pane-head">
                  <span class="pane-head-lead">
                    <UIcon :name="icons.reveal" class="pane-head-icon" aria-hidden="true" />
                    <span>渲染预览</span>
                  </span>
                  <span v-if="duplicateLeadingHeadingHidden" class="pane-h1-hint">
                    已隐藏与标题重复的首行一级标题
                  </span>
                </div>
                <div ref="previewScrollRef" class="preview-scroll">
                  <MemoryContent
                    :content="previewContent"
                    :width="editView === 'split' ? 'full' : 'reading'"
                    :class="{ 'preview-centered': editView === 'preview' }"
                    :wiki-links="wikiLinks"
                    :credentials="credentialLinks"
                    @open="(sid) => emit('open', sid)"
                    @credential="openCredential"
                  />
                </div>
              </div>
            </div>

            <UFormField v-if="isPhone" label="变更说明（可选）" class="mobile-change-note-field">
              <UInput
                id="entry-change-summary"
                v-model="form.changeSummary"
                size="sm"
                :maxlength="CHANGE_SUMMARY_MAX"
                placeholder="简述本次改动原因，留空可直接保存"
                class="w-full"
              />
            </UFormField>

            <SaveBar
              :count="dirtyCount"
              :saving="saving"
              :problem="validationProblem"
              :changes="dirtyChanges"
              always-show
              submit-type="button"
              discard-label="取消"
              :save-shortcut="saveShortcut"
              @discard="requestCancelEditing"
              @save="save"
            >
              <template v-if="!isPhone" #extra>
                <div class="change-note-bar">
                  <label for="entry-change-summary" class="change-note-label">变更说明</label>
                  <UInput
                    id="entry-change-summary"
                    v-model="form.changeSummary"
                    size="sm"
                    :maxlength="CHANGE_SUMMARY_MAX"
                    placeholder="可选：简述本次改动原因，留空可直接保存"
                    class="flex-1"
                  />
                </div>
              </template>
              <template v-if="contentChanged && entry" #diff>
                <DiffViewer
                  :before="entry.content"
                  :after="form.content"
                  :context="2"
                  :expand-step="10"
                  max-height="16rem"
                />
              </template>
            </SaveBar>
          </div>
        </template>

        <!-- 阅读模式 -->
        <template v-else>
          <div
            class="read-layout"
            :class="{ 'has-rail': hasSideRail, 'is-resizing': railResizing }"
            :style="hasSideRail ? readLayoutStyle : undefined"
          >
            <div class="read-main">
              <dl
                v-if="hasReadMetaStrip || entry.kind === 'episode' || isDeleted"
                class="meta-strip"
              >
                <div v-if="entry.kind === 'episode' || isDeleted">
                  <dt>
                    <UIcon :name="icons.sliders" class="meta-dt-icon" aria-hidden="true" />
                    <span>场景</span>
                  </dt>
                  <dd>
                    <span v-if="!scopeTags.length" class="text-muted">全局通用</span>
                    <span v-else class="tag-row">
                      <span v-for="tag in scopeTags" :key="tag" class="meta-pill">{{ tag }}</span>
                    </span>
                  </dd>
                </div>
                <div v-if="entry.topics.length">
                  <dt>
                    <UIcon :name="icons.topic" class="meta-dt-icon" aria-hidden="true" />
                    <span>主题</span>
                  </dt>
                  <dd class="tag-row">
                    <span v-for="topic in entry.topics" :key="topic" class="meta-pill">{{
                      topic
                    }}</span>
                  </dd>
                </div>
                <div v-if="entry.disclosure">
                  <dt>
                    <UIcon :name="icons.trigger" class="meta-dt-icon" aria-hidden="true" />
                    <span>{{ entry.kind === 'episode' ? '信号要点' : '召回时机' }}</span>
                  </dt>
                  <dd>{{ entry.disclosure }}</dd>
                </div>
                <div v-if="entry.validTo">
                  <dt>
                    <UIcon :name="icons.clock" class="meta-dt-icon" aria-hidden="true" />
                    <span>有效期</span>
                  </dt>
                  <dd :class="{ 'text-warning': expiredNow }">{{ formatTime(entry.validTo) }}</dd>
                </div>
                <div v-if="entry.verifiedAt">
                  <dt>
                    <UIcon :name="icons.shieldCheck" class="meta-dt-icon" aria-hidden="true" />
                    <span>已核实</span>
                  </dt>
                  <dd :title="formatTime(entry.verifiedAt)">
                    {{ formatRelative(entry.verifiedAt) }}
                  </dd>
                </div>
              </dl>

              <section v-if="entry.summary?.trim()" class="summary-block" aria-label="现行概要">
                <span class="summary-label">
                  <UIcon :name="icons.summary" class="summary-label-icon" aria-hidden="true" />
                  <span>现行概要</span>
                </span>
                <p class="summary-text">
                  <WikiText
                    :text="entry.summary ?? ''"
                    :titles="resolvedTitles"
                    @open="emit('open', $event)"
                  />
                </p>
              </section>

              <MemoryContent
                ref="readContentRef"
                :content="displayContent"
                width="full"
                :wiki-links="wikiLinks"
                :credentials="credentialLinks"
                @open="(sid) => emit('open', sid)"
                @credential="openCredential"
              />

              <!-- 窄容器下在正文下方纵向呈现近期演进与双链 -->
              <div class="read-below-only">
                <details v-if="recentHistory.length" class="recent-evolution">
                  <summary class="evolution-summary">
                    <span class="evolution-title">
                      <UIcon
                        :name="icons.chevronRight"
                        class="evolution-chevron"
                        aria-hidden="true"
                      />
                      <UIcon :name="icons.history" class="evolution-icon" aria-hidden="true" />
                      <span>近期演进（近 {{ recentHistory.length }} 条）</span>
                    </span>
                    <span class="evolution-hint">点击定位历史版本</span>
                  </summary>
                  <ol class="evolution-list">
                    <li v-for="ev in recentHistory" :key="ev.id">
                      <div
                        role="button"
                        tabindex="0"
                        class="evolution-row"
                        @click="openHistory(ev.id)"
                        @keydown.enter.self="openHistory(ev.id)"
                        @keydown.space.prevent.self="openHistory(ev.id)"
                      >
                        <span class="evolution-meta">
                          <span v-if="ev.version !== null" class="font-mono">
                            版本 {{ ev.version }}
                          </span>
                          <span v-else>{{ eventTypeLabels[ev.eventType] }}</span>
                          <span>{{ formatActorLabel(ev.actor, ev.actorMeta) }}</span>
                          <time
                            :datetime="ev.occurredAt ?? ev.createdAt"
                            :title="formatTime(ev.occurredAt ?? ev.createdAt)"
                          >
                            {{ formatRelative(ev.occurredAt ?? ev.createdAt) }}
                          </time>
                        </span>
                        <span class="evolution-body">
                          <UIcon
                            :name="eventTypeIcons[ev.eventType]"
                            class="evolution-event-icon"
                            aria-hidden="true"
                          />
                          <span class="evolution-text">
                            <WikiText
                              :text="ev.changeSummary?.trim() || eventTypeLabels[ev.eventType]"
                              :titles="resolvedTitles"
                              compact
                              @open="emit('open', $event)"
                            />
                          </span>
                        </span>
                      </div>
                    </li>
                  </ol>
                </details>

                <EntryLinksPanel
                  :outbound-links="detail?.outboundLinks ?? []"
                  :backlinks="detail?.backlinks ?? []"
                  :titles="resolvedTitles"
                  @open="(sid) => emit('open', sid)"
                />
              </div>
            </div>

            <!-- 宽屏右侧弹性可拖拽辅助轨（@container >= 960px 显示） -->
            <aside v-if="hasSideRail" ref="readRailRef" class="read-rail" aria-label="文档辅助导航">
              <div
                class="rail-splitter"
                role="separator"
                aria-orientation="vertical"
                aria-label="拖动调节右侧辅助栏宽度"
                :aria-valuenow="ariaRailWidth"
                :aria-valuemin="RAIL_WIDTH_MIN"
                :aria-valuemax="maxRailWidth"
                tabindex="0"
                title="拖动调节宽度，双击恢复自适应"
                @pointerdown="startRailResize"
                @dblclick="resetRailWidth"
                @keydown="onRailSplitterKeydown"
              />
              <span
                v-if="railResizing && railDragged && effectiveRailWidth !== null"
                class="rail-width-badge tabular-nums"
                aria-hidden="true"
              >
                {{ effectiveRailWidth }}px
              </span>
              <div class="rail-scroll">
                <section v-if="outline.length" class="rail-section">
                  <h2 class="rail-heading">
                    <UIcon :name="icons.bookOpen" class="rail-heading-icon" aria-hidden="true" />
                    <span>小节目录</span>
                    <span class="rail-heading-count tabular-nums">{{ outline.length }}</span>
                  </h2>
                  <ol class="outline-list">
                    <li v-for="(sec, idx) in outline" :key="`${idx}-${sec.heading}`">
                      <button
                        type="button"
                        class="outline-btn"
                        :title="sec.preview || sec.heading"
                        @click="jumpToSection(sec.heading, idx)"
                      >
                        <span class="outline-title">{{ sec.displayHeading }}</span>
                        <span class="outline-chars tabular-nums">{{ sec.charCount }}</span>
                      </button>
                    </li>
                  </ol>
                </section>

                <EntryLinksPanel
                  v-if="hasLinks"
                  compact
                  :outbound-links="detail?.outboundLinks ?? []"
                  :backlinks="detail?.backlinks ?? []"
                  :titles="resolvedTitles"
                  @open="(sid) => emit('open', sid)"
                />

                <section
                  v-if="railHistory.length"
                  :class="railHistoryOnly ? 'rail-section' : 'rail-history-disclosure'"
                >
                  <div v-if="railHistoryOnly" class="rail-heading-row">
                    <h2 class="rail-heading">
                      <UIcon :name="icons.history" class="rail-heading-icon" aria-hidden="true" />
                      <span>近期演进</span>
                      <span class="rail-heading-count tabular-nums">{{ railHistory.length }}</span>
                    </h2>
                    <button
                      type="button"
                      class="text-primary rail-more-link"
                      @click="openHistory()"
                    >
                      全部历史
                    </button>
                  </div>
                  <div v-else class="rail-disclosure-head">
                    <button
                      type="button"
                      class="rail-disclosure-toggle"
                      :aria-expanded="railHistoryExpanded"
                      :aria-controls="railHistoryListId"
                      @click="railHistoryExpanded = !railHistoryExpanded"
                    >
                      <UIcon
                        :name="icons.chevronRight"
                        class="rail-disclosure-chevron"
                        :class="{ 'is-open': railHistoryExpanded }"
                        aria-hidden="true"
                      />
                      <UIcon :name="icons.history" class="rail-heading-icon" aria-hidden="true" />
                      <span>近期演进</span>
                      <span class="rail-heading-count tabular-nums">{{ railHistory.length }}</span>
                    </button>
                    <button
                      type="button"
                      class="text-primary rail-more-link"
                      @click="openHistory()"
                    >
                      全部历史
                    </button>
                  </div>
                  <div
                    v-if="railHistoryOnly || railHistoryExpanded"
                    :class="{ 'rail-disclosure-body': !railHistoryOnly }"
                  >
                    <ol :id="railHistoryListId" class="rail-history-list">
                      <li v-for="ev in railHistory" :key="ev.id">
                        <div
                          role="button"
                          tabindex="0"
                          class="rail-history-btn"
                          @click="openHistory(ev.id)"
                          @keydown.enter.self="openHistory(ev.id)"
                          @keydown.space.prevent.self="openHistory(ev.id)"
                        >
                          <span class="rail-history-meta">
                            <span v-if="ev.version !== null" class="font-mono"
                              >版本 {{ ev.version }}</span
                            >
                            <span v-else>{{ eventTypeLabels[ev.eventType] }}</span>
                            <time :datetime="ev.occurredAt ?? ev.createdAt">
                              {{ formatRelative(ev.occurredAt ?? ev.createdAt) }}
                            </time>
                          </span>
                          <span class="rail-history-body">
                            <UIcon
                              :name="eventTypeIcons[ev.eventType]"
                              class="rail-history-icon"
                              aria-hidden="true"
                            />
                            <span class="rail-history-text">
                              <WikiText
                                :text="ev.changeSummary?.trim() || eventTypeLabels[ev.eventType]"
                                :titles="resolvedTitles"
                                compact
                                @open="emit('open', $event)"
                              />
                            </span>
                          </span>
                        </div>
                      </li>
                    </ol>
                  </div>
                </section>
              </div>
            </aside>
          </div>
        </template>
      </div>

      <MemoryHistoryDrawer
        v-model:open="historyOpen"
        :short-id="entry.shortId"
        :entry-title="entry.title"
        :current-version="entry.version"
        :is-deleted="isDeleted"
        :focus-event-id="focusedHistoryEventId"
        @restored="onHistoryRestored"
        @open="(sid) => emit('open', sid)"
      />

      <SingleTidyDrawer
        v-if="!isDeleted && entry.kind === 'entry'"
        v-model:open="organizeOpen"
        :short-id="entry.shortId"
        :entry-title="entry.title"
        :mode="organizeMode"
        @applied="onSingleTidyApplied"
        @staged="onSingleTidyStaged"
      />

      <QuickCaptureModal
        v-if="!isDeleted && entry.kind === 'entry'"
        v-model:open="refineOpen"
        :target-entry="{ shortId: entry.shortId, title: entry.title }"
        @applied="onSingleTidyApplied"
      />

      <ConsequenceModal
        :open="deleteModal !== null"
        :title="deleteModal === 'permanent' ? '彻底删除这条记忆？' : '移入回收站？'"
        :consequences="
          deleteModal === 'permanent'
            ? ['正文、历史记录与关联链接将被永久清除，无法恢复。']
            : ['移入回收站后不再参与召回与启动加载。', '可随时在回收站中恢复。']
        "
        :action="deleteModal === 'permanent' ? '彻底删除' : '移入回收站'"
        :action-icon="icons.remove"
        :busy="deleteBusy"
        :error="deleteError"
        @confirm="confirmDelete"
        @close="deleteModal = null"
      />
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
.editor-pane.is-editing {
  --canvas-max: 1120px;
}
.editor-pane.is-editing.is-split {
  --canvas-max: 1560px;
}
.mobile-back-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 36px;
  min-height: 36px;
  padding: 0 16px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.mobile-bar-actions {
  display: none;
  align-items: center;
  gap: 6px;
}
.inline-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 15rem;
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
.inline-chip.is-pinned {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.inline-chip.is-index {
  border-color: var(--ui-border-accented);
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
.editor-head {
  flex: none;
  padding: 16px 28px 14px;
  border-bottom: 1px solid var(--ui-border);
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
  overflow-wrap: anywhere;
}
.head-title-row h1:focus {
  outline: 0;
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
.head-change-line {
  font-size: 12px;
  line-height: 1.55;
  color: var(--ui-text-toned);
  overflow-wrap: anywhere;
}
.status-change-label {
  color: var(--ui-text-muted);
}
.status-history-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
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
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 7px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
  white-space: nowrap;
}
.pill.status-episode {
  border-color: var(--ui-info);
  background: var(--ui-bg);
  color: var(--ui-info);
}
.pill.danger {
  border-color: var(--ui-error);
  color: var(--ui-error);
}
.pill-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.rail-swatch {
  display: inline-block;
  flex: none;
  width: 3px;
  height: 10px;
}
.rail-swatch.solid {
  background: var(--ui-rule);
}
.rail-swatch.index {
  background: repeating-linear-gradient(to bottom, var(--ui-rule) 0 3px, transparent 3px 6px);
}
.rail-swatch.dashed {
  background: repeating-linear-gradient(to bottom, var(--ui-info) 0 3px, transparent 3px 6px);
}
.pin-popover {
  display: flex;
  flex-direction: column;
  width: min(26rem, calc(100vw - 2rem));
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
.pin-popover-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
}
.pin-popover-body > * {
  flex-shrink: 0;
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
.pin-mode-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pin-mode-card {
  position: relative;
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
.pin-mode-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
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
.pin-field-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
}
.field-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.field-label-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.pin-scope-box {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.pin-scope-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
  cursor: pointer;
}
.pin-scope-lead {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.pin-scope-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.pin-scope-body {
  padding: 10px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.pin-popover-foot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding: 8px 16px 12px;
  border-top: 1px solid var(--ui-border);
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
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
.edit-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.edit-meta-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}
@container (min-width: 820px) {
  .edit-meta-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
    gap: 14px;
    align-items: start;
  }
}
.title-hint-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.title-hint-text {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-warning);
}
.attrs-collapse {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.attrs-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  font-size: 13px;
  color: var(--ui-text-highlighted);
  cursor: pointer;
}
.attrs-toggle:hover {
  background: var(--ui-bg-elevated);
}
.attrs-toggle-lead {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.attrs-chevron,
.attrs-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.attrs-summary {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.attrs-body {
  padding: 12px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.change-note-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.change-note-label {
  flex: none;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.toolbar-right {
  margin-left: auto;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.editor-workbench {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.workbench-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.pane-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.pane-head-lead {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 500;
  color: var(--ui-text-toned);
}
.pane-head-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.pane-head-meta {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.pane-h1-hint {
  font-size: 12px;
  color: var(--ui-warning);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.source-input {
  display: flex;
  flex: 1;
  align-items: stretch;
  width: 100%;
  min-height: 0;
}
.source-input :deep(textarea) {
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: var(--ui-bg-bright);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.75;
}
.source-input :deep(textarea:focus),
.source-input :deep(textarea:focus-visible) {
  outline: 0;
}
.editor-workbench.mode-split .pane-source {
  height: 280px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.editor-workbench.mode-split .pane-preview {
  height: 300px;
}
.editor-workbench.mode-split .source-input :deep(textarea) {
  height: 100%;
  min-height: 0;
  resize: none;
  overflow-y: auto;
}
.editor-workbench.mode-preview .preview-scroll {
  min-height: 24rem;
}
.preview-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 20px;
  background: var(--ui-bg);
}
.preview-centered {
  margin-inline: auto;
}
@container (min-width: 680px) {
  .editor-workbench.mode-split {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    height: clamp(420px, calc(100vh - 20rem), 760px);
  }
  .editor-workbench.mode-split .pane-source {
    height: 100%;
    border-bottom: 0;
    border-right: 1px solid var(--ui-border-accented);
  }
  .editor-workbench.mode-split .pane-preview {
    height: 100%;
  }
}
/* 阅读态主栏与宽屏右侧弹性可拖拽辅助轨，整体居中收束在画布宽度内 */
.read-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 24px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.read-layout.is-resizing {
  user-select: none;
  cursor: col-resize;
}
.read-main {
  min-width: 0;
}
.read-rail {
  display: none;
}
@container (min-width: 960px) {
  .read-layout.has-rail {
    grid-template-columns: minmax(0, 1fr) var(--rail-width, clamp(296px, 28cqi, 360px));
    gap: 28px;
    align-items: start;
  }
  .read-layout.has-rail .read-rail {
    position: sticky;
    top: 0;
    max-height: var(--rail-max-height, calc(100vh - 16rem));
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--ui-border);
  }
  .read-layout.has-rail .read-below-only {
    display: none;
  }
}
.rail-splitter {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -5px;
  z-index: 15;
  width: 9px;
  cursor: col-resize;
  touch-action: none;
}
.rail-splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 2px;
  background: var(--ui-rule);
  opacity: 0;
  transition: opacity 140ms ease;
}
.rail-splitter:hover::after,
.rail-splitter:focus-visible::after,
.read-layout.is-resizing .rail-splitter::after {
  opacity: 1;
}
.rail-splitter:focus-visible {
  outline: 0;
}
.rail-width-badge {
  position: absolute;
  top: 2px;
  left: 8px;
  z-index: 20;
  padding: 1px 6px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
}
.rail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-left: 20px;
  padding-right: 4px;
}
.rail-scroll > * {
  flex-shrink: 0;
}
.rail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rail-heading-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-dimmed);
}
.rail-history-disclosure {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.rail-disclosure-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
}
.rail-disclosure-toggle {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  text-align: left;
  cursor: pointer;
}
.rail-disclosure-chevron {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
  transition: transform 0.12s ease;
}
.rail-disclosure-chevron.is-open {
  transform: rotate(90deg);
}
.rail-disclosure-body {
  padding: 2px 10px 6px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.rail-heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--ui-rule);
}
.rail-heading-row .rail-heading {
  padding-bottom: 0;
  border-bottom: 0;
}
.rail-heading {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--ui-rule);
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.rail-heading-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.rail-more-link {
  flex: none;
  white-space: nowrap;
  font-size: 12px;
  cursor: pointer;
}
.outline-list,
.rail-history-list {
  display: flex;
  flex-direction: column;
}
.outline-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 4px 2px;
  border-bottom: 1px solid var(--ui-border-muted);
  text-align: left;
  font-size: 13px;
  line-height: 1.45;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.outline-btn:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.outline-btn:hover .outline-chars {
  color: var(--ui-text-muted);
}
.outline-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.outline-chars {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.rail-history-btn {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 6px 2px;
  border-bottom: 1px solid var(--ui-border-muted);
  text-align: left;
  cursor: pointer;
}
.rail-history-btn:hover {
  background: var(--ui-bg-elevated);
}
.rail-history-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.rail-history-body {
  display: flex;
  align-items: flex-start;
  gap: 5px;
}
.rail-history-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  margin-top: 3px;
  color: var(--ui-text-muted);
}
.rail-history-text {
  min-width: 0;
  flex: 1;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ui-text);
}
.meta-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin-bottom: 18px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
}
.meta-strip > div {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.meta-strip dt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 20px;
  font-size: 12px;
  line-height: 20px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.meta-strip dd {
  line-height: 20px;
}
.meta-dt-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.tag-row {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.meta-pill {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.5;
}
.summary-block {
  margin-bottom: 18px;
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
  font-size: 14px;
  line-height: 1.65;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.recent-evolution {
  margin-top: 24px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.evolution-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
  list-style: none;
  cursor: pointer;
}
.evolution-summary::-webkit-details-marker {
  display: none;
}
.evolution-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.evolution-chevron,
.evolution-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.evolution-chevron {
  transition: transform 0.12s ease;
}
.recent-evolution[open] .evolution-chevron {
  transform: rotate(90deg);
}
.evolution-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.evolution-list {
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.evolution-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ui-border-muted);
  text-align: left;
  cursor: pointer;
}
.evolution-row:hover {
  background: var(--ui-bg-elevated);
}
.evolution-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.evolution-body {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.evolution-event-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  margin-top: 3px;
  color: var(--ui-text-muted);
}
.evolution-text {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text);
}
.edit-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
}
@media (max-width: 1023.98px) {
  .editor-head {
    padding: 12px 16px;
  }
  .head-status-line {
    gap: 6px 12px;
  }
  .status-sep {
    display: none;
  }
  .editor-scroll {
    padding: 14px 16px 24px;
  }
  .editor-scroll.is-editing {
    padding-bottom: 0;
  }
  .change-note-bar {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
}
@media (max-width: 767.98px) {
  .desktop-fullscreen-btn {
    display: none;
  }
  /* 手机端由详情面板整体滚动，只吸顶单行操作条，避免大头栏与底栏锁死正文高度 */
  .editor-pane {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .mobile-back-bar {
    position: sticky;
    top: 0;
    z-index: 20;
    height: auto;
    min-height: 44px;
    padding: 6px 12px;
  }
  .mobile-bar-actions {
    display: inline-flex;
  }
  .editor-head .head-actions {
    display: none;
  }
  .editor-pane.is-editing .editor-head {
    display: none;
  }
  .editor-scroll {
    flex: none;
    overflow: visible;
    padding: 12px 14px 20px;
  }
  .editor-scroll.is-editing {
    padding-bottom: 0;
  }
  .edit-toolbar .toolbar-right {
    display: none;
  }
  .source-input :deep(textarea) {
    font-size: 16px;
  }
  .inline-chip {
    height: auto;
    min-height: 32px;
    padding: 4px 9px;
  }
  .status-copy-id,
  .status-history-link {
    min-height: 28px;
  }
}
</style>
