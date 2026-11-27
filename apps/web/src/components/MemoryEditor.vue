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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import {
  confirmDiscard,
  hasUnsavedChanges,
  useUnsavedChangesGuard,
} from '../composables/unsavedChanges'
import { useDebounced } from '../composables/useDebounced'
import { useMarkdownSyncScroll } from '../composables/useMarkdownSyncScroll'
import { useNow } from '../composables/useNow'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import {
  bootModeDescriptions,
  bootModeLabels,
  envDisplayName,
  eventTypeLabels,
  formatActorLabel,
} from '../labels'
import type { CredentialLinks, WikiLinkTargets } from '../markdown'
import { placeholderOf } from '../placeholders'
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
import ConsequenceModal from './ConsequenceModal.vue'
import EntryLinksPanel from './EntryLinksPanel.vue'
import MemoryContent from './MemoryContent.vue'
import MemoryHistoryDrawer from './MemoryHistoryDrawer.vue'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import SingleTidyDrawer, { type SingleOrganizeMode } from './SingleTidyDrawer.vue'
import DiffViewer from './ui/DiffViewer.vue'
import NoteLine from './ui/NoteLine.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import SaveBar, { type SaveBarChange } from './ui/SaveBar.vue'
import ShortIdLine from './ui/ShortIdLine.vue'

const props = withDefaults(
  defineProps<{
    shortId: string
    facets?: EntryFacetsSummary | null
  }>(),
  { facets: null },
)

const emit = defineEmits<{
  changed: [detail: EntryDetailResponse]
  deleted: [shortId: string, permanent: boolean]
  restored: [detail: EntryDetailResponse]
  open: [shortId: string]
}>()

const router = useRouter()
const toast = useToast()
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

const BOOT_MODE_OPTIONS: { value: BootMode; label: string }[] = BOOT_MODES.map((value) => ({
  value,
  label: bootModeLabels[value],
}))

const detail = ref<EntryDetailResponse | null>(null)
const entry = computed(() => detail.value?.entry ?? null)
const entryBootMode = computed<BootMode>(() =>
  entry.value ? effectiveBootMode(entry.value) : 'none',
)
const mode = ref<'read' | 'edit'>('read')
const editView = ref<EditViewMode>('edit')
const syncScroll = ref(true)
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
      label: '触发场景',
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
    knownProjects: props.facets?.projects,
    knownRuntimes: props.facets?.runtimes,
  }).filter(
    (w) =>
      w.code === 'pinned_oversized' ||
      w.code === 'pinned_scope_hint' ||
      w.code === 'pinned_missing_summary',
  )
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
  if (!entry.value || isDeleted.value) return
  pinPopoverOpen.value = false
  organizeOpen.value = false
  minValidTo.value = earliestValidTo()
  attrsOpen.value = false
  form.changeSummary = ''
  mode.value = 'edit'
}

function cancelEditing() {
  if (detail.value) loadDetail(detail.value)
  mode.value = 'read'
  editView.value = 'edit'
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
    editView.value = 'edit'
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
  const hints = lintEntryHygiene({
    title: current.title,
    content: current.content,
    summary: current.summary,
    bootMode: 'full',
    envs: current.envs,
    realms: current.realms,
    projects: current.projects,
    runtimes: current.runtimes,
    knownProjects: props.facets?.projects,
    knownRuntimes: props.facets?.runtimes,
  })
  pinDraft.scopeExpanded =
    current.envs.length > 0 ||
    current.realms.length > 0 ||
    current.projects.length > 0 ||
    current.runtimes.length > 0 ||
    hints.some((w) => w.code === 'pinned_scope_hint')
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
    knownProjects: props.facets?.projects,
    knownRuntimes: props.facets?.runtimes,
  }).filter(
    (w) =>
      w.code === 'pinned_oversized' ||
      w.code === 'pinned_scope_hint' ||
      w.code === 'pinned_missing_summary',
  )
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
      expectedVersion: current.version,
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
    toast.add({ title: `已设为${bootModeLabels[pinDraft.bootMode]}`, color: 'success' })
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
  editView.value = 'edit'
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
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .trim()
}

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

const { me } = useSession()
const hasChatModel = computed(() => Boolean(me.data.value?.hasChatModel))
const pendingSuggestionCount = computed(() => detail.value?.pendingSuggestionCount ?? 0)
const organizeOpen = ref(false)
const organizeMode = ref<SingleOrganizeMode>('tidy')

watch(isDeleted, (deleted) => {
  if (deleted) organizeOpen.value = false
})

function openOrganize(targetMode: SingleOrganizeMode) {
  if (!hasChatModel.value || !entry.value || isDeleted.value || entry.value.kind !== 'entry') return
  organizeMode.value = targetMode
  organizeOpen.value = true
}

const organizeMenuItems = computed<DropdownMenuItem[][]>(() => {
  if (!hasChatModel.value) {
    return [[{ type: 'label', label: '请先在设置中配置对话模型' }]]
  }
  return [
    [
      {
        label: '规范此条',
        icon: icons.tidy,
        onSelect: () => openOrganize('tidy'),
      },
      {
        label: '查找重复与关联',
        icon: icons.links,
        onSelect: () => openOrganize('cross_check'),
      },
    ],
  ]
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

const wikiLinks = computed<WikiLinkTargets>(() => {
  const byShortId = new Map<string, { title: string }>()
  for (const link of detail.value?.outboundLinks ?? []) {
    byShortId.set(link.shortId, { title: link.title })
  }
  return {
    byShortId,
    href: (sid) => router.resolve(entryRoute(sid)).href,
  }
})

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
  parts.push(scopeCount > 0 ? `${scopeCount} 项场景限定` : '所有环境')
  if (form.disclosure.trim()) parts.push('已设触发场景')
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
onBeforeUnmount(() => window.removeEventListener('keydown', onEditorKeydown))

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
    }"
  >
    <div v-if="$slots.nav" class="drawer-nav">
      <div class="drawer-nav-inner">
        <slot name="nav" />
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
              <span v-if="entryBootMode === 'full'" class="pill status-pinned">
                <span class="rail-swatch solid" aria-hidden="true" />
                全文常驻
              </span>
              <span v-else-if="entryBootMode === 'index'" class="pill status-pinned-index">
                <span class="rail-swatch index" aria-hidden="true" />
                目录常驻
              </span>
              <span v-if="entry.kind === 'episode'" class="pill status-episode">
                <span class="rail-swatch dashed" aria-hidden="true" />
                会话摘要
              </span>
              <span v-if="isDeleted" class="pill danger">已在回收站</span>
            </div>

            <!-- 轻量动态状态行：版本、相对更新时间、来源、常驻字数与最新变更摘要 -->
            <div class="head-status-line">
              <span class="tabular-nums">版本 {{ entry.version }}</span>
              <span class="status-sep" aria-hidden="true">·</span>
              <time :datetime="entry.updatedAt" :title="formatTime(entry.updatedAt)">
                {{ formatRelative(entry.updatedAt) }}更新<template v-if="latestActorLabel"
                  >（{{ latestActorLabel }}）</template
                >
              </time>
              <template v-if="entry.isPinned">
                <span class="status-sep" aria-hidden="true">·</span>
                <span class="tabular-nums">约 {{ entry.content.length.toLocaleString() }} 字</span>
              </template>
              <template v-if="latestChangeText">
                <span class="status-sep" aria-hidden="true">·</span>
                <span class="status-change" :title="latestChangeText">
                  近改：{{ latestChangeText }}
                </span>
              </template>
              <template v-if="mode === 'read' && pendingSuggestionCount > 0">
                <span class="status-sep" aria-hidden="true">·</span>
                <RouterLink :to="{ name: 'inbox' }" class="text-primary status-history-link">
                  待处理建议（{{ pendingSuggestionCount }}）
                </RouterLink>
              </template>
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
                @click="startEditing"
              >
                编辑
              </UButton>
              <UPopover
                v-if="!isDeleted && entry.kind === 'entry'"
                v-model:open="pinPopoverOpen"
                :content="{ align: 'end', sideOffset: 6 }"
              >
                <UButton
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :icon="icons.pin"
                  :loading="quickBusy"
                  :aria-expanded="pinPopoverOpen"
                >
                  {{ entryBootMode === 'none' ? '设为常驻' : bootModeLabels[entryBootMode] }}
                </UButton>
                <template #content>
                  <div class="pin-popover">
                    <div class="pin-popover-head">
                      <span class="pin-popover-title">启动加载方式</span>
                      <span class="text-xs text-muted tabular-nums">
                        约 {{ entry.content.length.toLocaleString() }} 字
                      </span>
                    </div>

                    <div class="pin-mode-list" role="radiogroup" aria-label="选择启动加载方式">
                      <button
                        v-for="modeOpt in BOOT_MODES"
                        :key="modeOpt"
                        type="button"
                        role="radio"
                        class="pin-mode-card"
                        :class="{ active: pinDraft.bootMode === modeOpt }"
                        :aria-checked="pinDraft.bootMode === modeOpt"
                        @click="pinDraft.bootMode = modeOpt"
                      >
                        <span class="pin-mode-head">
                          <span class="pin-mode-name">{{ bootModeLabels[modeOpt] }}</span>
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
                        现行概要（用于启动目录行）
                      </label>
                      <UTextarea
                        id="pin-summary-input"
                        v-model="pinDraft.summary"
                        :rows="2"
                        autoresize
                        :maxrows="3"
                        :maxlength="ENTRY_SUMMARY_MAX"
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
                        <span>确认适用场景</span>
                        <UIcon
                          :name="pinDraft.scopeExpanded ? icons.chevronDown : icons.chevronRight"
                          class="attrs-chevron"
                          aria-hidden="true"
                        />
                      </button>
                      <div v-if="pinDraft.scopeExpanded" class="pin-scope-body">
                        <SceneScopePicker v-model="pinDraft.scope" :facets="facets" />
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
                  :disabled="!hasChatModel"
                  :title="
                    hasChatModel ? '主动规范此条或查找重复与关联记忆' : '请先在设置中配置对话模型'
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
                @click="((deleteModal = isDeleted ? 'permanent' : 'soft'), (deleteError = null))"
              >
                {{ isDeleted ? '彻底删除' : '删除' }}
              </UButton>
            </template>
            <template v-else>
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

      <div class="editor-scroll" :class="{ 'is-editing': mode === 'edit' }">
        <ReadFailureNote v-if="detailQuery.isError.value" :query="detailQuery" />

        <NoteLine v-if="expiredNow" tone="warning">
          该记忆已于 {{ formatShort(entry.validTo!) }} 过期，不再参与召回与启动加载。
        </NoteLine>

        <!-- 编辑模式 -->
        <template v-if="mode === 'edit'">
          <div class="edit-stack">
            <div class="edit-meta-grid">
              <UFormField label="标题">
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
                <UTextarea
                  v-model="form.summary"
                  :rows="1"
                  autoresize
                  :maxrows="3"
                  :maxlength="ENTRY_SUMMARY_MAX"
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
                    <UInputTags
                      v-model="form.topics"
                      add-on-blur
                      placeholder="输入后回车"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="启动加载方式">
                    <SegmentedChoice
                      v-if="entry.kind === 'entry'"
                      v-model="form.bootMode"
                      :items="BOOT_MODE_OPTIONS"
                      label="启动加载方式"
                      compact
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
                  <UFormField label="触发场景（可选）">
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
              <template
                v-if="
                  editBootWarnings.some(
                    (w) => w.code === 'pinned_oversized' || w.code === 'pinned_scope_hint',
                  )
                "
                #actions
              >
                <UButton
                  v-if="editBootWarnings.some((w) => w.code === 'pinned_oversized')"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  @click="form.bootMode = 'index'"
                >
                  改为目录常驻
                </UButton>
                <UButton
                  v-if="editBootWarnings.some((w) => w.code === 'pinned_scope_hint')"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  @click="attrsOpen = true"
                >
                  限定场景
                </UButton>
              </template>
            </NoteLine>

            <NoteLine v-if="secretWarnings.length" tone="warning">
              正文疑似包含{{
                secretWarnings.map((w) => w.label).join('、')
              }}，建议改存凭据并用占位符引用。
              <template #actions>
                <UButton size="xs" color="neutral" variant="outline" :to="{ name: 'credentials' }">
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
                          class="flex w-full items-baseline justify-between gap-2 px-1.5 py-1.5 text-left hover:bg-elevated"
                          @click="insertWikiLink(item.shortId)"
                        >
                          <span class="truncate">{{ item.title }}</span>
                          <span class="shrink-0 font-mono text-xs text-muted">
                            {{ item.shortId }}
                          </span>
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
                  :items="EDIT_VIEW_OPTIONS"
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
              <template #extra>
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
          <div class="read-layout" :class="{ 'has-rail': hasSideRail }">
            <div class="read-main">
              <dl class="meta-strip">
                <div>
                  <dt>场景</dt>
                  <dd>
                    <span v-if="!scopeTags.length" class="text-muted">所有环境</span>
                    <span v-else class="tag-row">
                      <span v-for="tag in scopeTags" :key="tag" class="meta-pill">{{ tag }}</span>
                    </span>
                  </dd>
                </div>
                <div v-if="entry.topics.length">
                  <dt>主题</dt>
                  <dd class="tag-row">
                    <span v-for="topic in entry.topics" :key="topic" class="meta-pill">{{
                      topic
                    }}</span>
                  </dd>
                </div>
                <div v-if="entry.disclosure">
                  <dt>触发场景</dt>
                  <dd>{{ entry.disclosure }}</dd>
                </div>
                <div v-if="entry.validTo">
                  <dt>有效期</dt>
                  <dd :class="{ 'text-warning': expiredNow }">{{ formatTime(entry.validTo) }}</dd>
                </div>
                <div v-if="entry.verifiedAt">
                  <dt>已核实</dt>
                  <dd :title="formatTime(entry.verifiedAt)">
                    {{ formatRelative(entry.verifiedAt) }}
                  </dd>
                </div>
              </dl>

              <section v-if="entry.summary?.trim()" class="summary-block" aria-label="现行概要">
                <span class="summary-label">现行概要</span>
                <p class="summary-text">{{ entry.summary }}</p>
              </section>

              <MemoryContent
                ref="readContentRef"
                :content="displayContent"
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
                      近期演进（近 {{ recentHistory.length }} 条）
                    </span>
                    <span class="evolution-hint">点击定位历史版本</span>
                  </summary>
                  <ol class="evolution-list">
                    <li v-for="ev in recentHistory" :key="ev.id">
                      <button type="button" class="evolution-row" @click="openHistory(ev.id)">
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
                        <span class="evolution-text">
                          {{ ev.changeSummary?.trim() || eventTypeLabels[ev.eventType] }}
                        </span>
                      </button>
                    </li>
                  </ol>
                </details>

                <EntryLinksPanel
                  :outbound-links="detail?.outboundLinks ?? []"
                  :backlinks="detail?.backlinks ?? []"
                  @open="(sid) => emit('open', sid)"
                />
              </div>
            </div>

            <!-- 宽屏右侧 240px 静态辅助轨（@container >= 960px 显示） -->
            <aside v-if="hasSideRail" class="read-rail" aria-label="文档辅助导航">
              <section v-if="outline.length" class="rail-section">
                <h2 class="rail-heading">小节目录</h2>
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

              <section v-if="railHistory.length" class="rail-section">
                <div class="rail-heading-row">
                  <h2 class="rail-heading">近期演进</h2>
                  <button type="button" class="text-primary rail-more-link" @click="openHistory()">
                    全部历史
                  </button>
                </div>
                <ol class="rail-history-list">
                  <li v-for="ev in railHistory" :key="ev.id">
                    <button type="button" class="rail-history-btn" @click="openHistory(ev.id)">
                      <span class="rail-history-meta">
                        <span v-if="ev.version !== null" class="font-mono"
                          >版本 {{ ev.version }}</span
                        >
                        <span v-else>{{ eventTypeLabels[ev.eventType] }}</span>
                        <time :datetime="ev.occurredAt ?? ev.createdAt">
                          {{ formatRelative(ev.occurredAt ?? ev.createdAt) }}
                        </time>
                      </span>
                      <span class="rail-history-text">
                        {{ ev.changeSummary?.trim() || eventTypeLabels[ev.eventType] }}
                      </span>
                    </button>
                  </li>
                </ol>
              </section>

              <EntryLinksPanel
                v-if="hasLinks"
                compact
                :outbound-links="detail?.outboundLinks ?? []"
                :backlinks="detail?.backlinks ?? []"
                @open="(sid) => emit('open', sid)"
              />
            </aside>
          </div>
        </template>
      </div>

      <ShortIdLine :value="entry.shortId" />

      <MemoryHistoryDrawer
        v-model:open="historyOpen"
        :short-id="entry.shortId"
        :current-version="entry.version"
        :is-deleted="isDeleted"
        :focus-event-id="focusedHistoryEventId"
        @restored="onHistoryRestored"
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

      <ConsequenceModal
        :open="deleteModal !== null"
        :title="deleteModal === 'permanent' ? '彻底删除这条记忆？' : '移入回收站？'"
        :consequences="
          deleteModal === 'permanent'
            ? ['正文、历史记录与关联链接将被永久清除，无法恢复。']
            : ['移入回收站后不再参与召回与启动加载。', '可随时在回收站中恢复。']
        "
        :action="deleteModal === 'permanent' ? '彻底删除' : '移入回收站'"
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
.editor-pane.is-editing {
  --canvas-max: 1120px;
}
.editor-pane.is-editing.is-split {
  --canvas-max: 1560px;
}
.drawer-nav {
  flex: none;
  display: flex;
  align-items: center;
  height: 36px;
  min-height: 36px;
  padding: 0 28px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.drawer-nav-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
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
  align-items: baseline;
  gap: 4px 7px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.status-sep {
  color: var(--ui-border-accented);
}
.status-change {
  max-width: 34rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-toned);
}
.status-history-link {
  font-size: 12px;
  cursor: pointer;
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
.pill.status-pinned {
  color: var(--ui-text-highlighted);
}
.pill.status-pinned-index {
  color: var(--ui-text-toned);
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
  gap: 10px;
  width: min(26rem, calc(100vw - 2rem));
  max-height: 75vh;
  overflow-y: auto;
  padding: 14px 16px;
}
.pin-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-border);
}
.pin-popover-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
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
  padding: 8px 10px 8px 12px;
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
.pin-mode-card.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--ui-on-selected);
}
.pin-mode-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pin-mode-name {
  font-size: 13px;
  font-weight: 500;
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
  display: block;
  font-size: 12px;
  font-weight: 500;
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
.pin-scope-body {
  padding: 10px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.pin-popover-foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 8px;
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
/* 阅读态主栏与宽屏右侧 248px 静态辅助轨，整体居中收束在画布宽度内 */
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
}
.read-rail {
  display: none;
}
@container (min-width: 960px) {
  .read-layout.has-rail {
    grid-template-columns: minmax(0, 1fr) 248px;
    gap: 36px;
    align-items: start;
  }
  .read-layout.has-rail .read-rail {
    position: sticky;
    top: 0;
    max-height: calc(100vh - 14rem);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding-left: 18px;
    border-left: 1px solid var(--ui-border);
  }
  .read-layout.has-rail .read-below-only {
    display: none;
  }
}
.rail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rail-heading-row {
  display: flex;
  align-items: baseline;
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
  padding-bottom: 4px;
  border-bottom: 1px solid var(--ui-rule);
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.rail-more-link {
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
  align-items: baseline;
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
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.rail-history-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.45;
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
  align-items: baseline;
  gap: 8px;
}
.meta-strip dt {
  font-size: 12px;
  color: var(--ui-text-muted);
  white-space: nowrap;
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
  max-width: 58em;
  margin-bottom: 18px;
  padding: 10px 14px;
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.summary-label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
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
.evolution-chevron {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
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
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.evolution-text {
  font-size: 13px;
  line-height: 1.55;
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
  .drawer-nav {
    padding: 0 16px;
  }
  .editor-head {
    padding: 12px 16px;
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
</style>
