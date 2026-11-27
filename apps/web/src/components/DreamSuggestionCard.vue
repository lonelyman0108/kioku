<script setup lang="ts">
import {
  BOOT_MODES,
  CHANGE_SUMMARY_MAX,
  ChangeSummary,
  checkCaptureIntegrity,
  DISCLOSURE_MAX,
  Disclosure,
  effectiveBootMode,
  ENTRY_SUMMARY_MAX,
  ENTRY_TITLE_MAX,
  EntrySummary,
  EntryTitle,
  extractCredentialPlaceholders,
  extractTargetShortIds,
  mergeFallbackTopics,
  normalizeSlugList,
  REVISABLE_DREAM_KINDS,
  REVISE_INSTRUCTION_MAX,
  type ApplySuggestionRequest,
  type BootMode,
  type CaptureIntegrity,
  type DreamSuggestionView,
  type ReviseSuggestionRequest,
} from '@kioku/contracts'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import {
  bootModeDescriptions,
  bootModeIcons,
  bootModeLabels,
  dreamKindIcons,
  dreamKindLabels,
  entryKindLabels,
  envDisplayName,
} from '../labels'
import { entryRoute } from '../routes'
import { runtimeName } from '../runtimes'
import { detectSecretPrefixes } from '../secretHint'
import { formatRelative, formatShort, formatShortRange, formatTime } from '../time'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import DiffViewer from './ui/DiffViewer.vue'
import NoteLine from './ui/NoteLine.vue'
import WikiText from './ui/WikiText.vue'

const props = withDefaults(
  defineProps<{
    suggestion: DreamSuggestionView
    busy: boolean
    disabled?: boolean
    layout?: 'card' | 'inspector'
  }>(),
  { disabled: false, layout: 'card' },
)

const emit = defineEmits<{
  apply: [id: string, body: ApplySuggestionRequest]
  dismiss: [id: string]
}>()

const editing = ref(false)
const isInspector = computed(() => props.layout === 'inspector')

const { me } = useSession()
const hasChatModel = computed(() => Boolean(me.data.value?.hasChatModel))
const isRevisableKind = computed(() =>
  (REVISABLE_DREAM_KINDS as readonly string[]).includes(props.suggestion.kind),
)
const showReviseBar = computed(() => isRevisableKind.value && hasChatModel.value)

const reviseInstruction = ref('')
const reviseBusy = ref(false)
const reviseError = ref<string | null>(null)
const revisedReason = ref<string | null>(null)
const showRevisedDiff = ref(true)
let reviseController: AbortController | null = null

function abortRevise() {
  if (reviseController) {
    reviseController.abort()
    reviseController = null
  }
}

onBeforeUnmount(abortRevise)

const baseEntry = computed(() => {
  if (props.suggestion.keepId) {
    return (
      props.suggestion.entries.find((e) => e.id === props.suggestion.keepId) ??
      props.suggestion.entries[0] ??
      null
    )
  }
  return props.suggestion.entries[0] ?? null
})

const mergedSourceEntries = computed(() => {
  if (props.suggestion.kind !== 'merge_duplicates' || !baseEntry.value) return []
  return props.suggestion.entries.filter((e) => e.id !== baseEntry.value!.id)
})

const displayTitle = computed(() => {
  if (props.suggestion.kind === 'distill_episode') {
    return props.suggestion.proposedTitle?.trim() || baseEntry.value?.title || '未命名记忆'
  }
  return baseEntry.value?.title || props.suggestion.proposedTitle?.trim() || '未命名记忆'
})

const knownTitles = computed<ReadonlyMap<string, { title: string }> | null>(() => {
  const map = new Map<string, { title: string }>()
  for (const entry of props.suggestion.entries) {
    if (entry.title) map.set(entry.shortId, { title: entry.title })
  }
  for (const link of props.suggestion.proposedLinks ?? []) {
    if (link.targetTitle) map.set(link.targetShortId, { title: link.targetTitle })
  }
  return map.size > 0 ? map : null
})

// 规范与精简建议的分项勾选状态
const parts = reactive({
  title: true,
  summary: true,
  topics: true,
  disclosure: true,
  content: true,
})

// 补全双链建议的逐条勾选列表
const selectedLinkShortIds = ref<string[]>([])

watch(
  () => props.suggestion.id,
  () => {
    abortRevise()
    parts.title = true
    parts.summary = true
    parts.topics = true
    parts.disclosure = true
    parts.content = true
    selectedLinkShortIds.value = (props.suggestion.proposedLinks ?? []).map((l) => l.targetShortId)
    editing.value = false
    reviseInstruction.value = ''
    reviseBusy.value = false
    reviseError.value = null
    revisedReason.value = null
    showRevisedDiff.value = true
  },
  { immediate: true },
)

const isTidy = computed(() => props.suggestion.kind === 'tidy')
const isLinkEntries = computed(() => props.suggestion.kind === 'link_entries')
const isAdjustBootMode = computed(() => props.suggestion.kind === 'adjust_boot_mode')
const isMergeDuplicates = computed(() => props.suggestion.kind === 'merge_duplicates')
const isMarkStale = computed(() => props.suggestion.kind === 'mark_stale')
const isDistillEpisode = computed(() => props.suggestion.kind === 'distill_episode')
const isUpdate = computed(() => props.suggestion.kind === 'update')

// 计算直接应用时实际落库的适用场景，与服务端应用时的继承回退口径一致（显式 [] 表示主动放宽该维度）
const effectiveScope = computed<SceneScopeValue>(() => {
  const s = props.suggestion
  const base = baseEntry.value
  if (s.kind === 'distill_episode') {
    const fallbackRealms = base?.realms.length
      ? base.realms
      : normalizeSlugList(s.entries.flatMap((e) => e.realms))
    return {
      envs: s.proposedEnvs !== null ? [...s.proposedEnvs] : [...(base?.envs ?? [])],
      realms: s.proposedRealms?.length ? [...s.proposedRealms] : [...fallbackRealms],
      projects: s.proposedProjects !== null ? [...s.proposedProjects] : [...(base?.projects ?? [])],
      runtimes: s.proposedRuntimes !== null ? [...s.proposedRuntimes] : [],
    }
  }
  if (s.kind === 'merge_duplicates') {
    return {
      envs:
        s.proposedEnvs !== null
          ? [...s.proposedEnvs]
          : normalizeSlugList(s.entries.flatMap((e) => e.envs)),
      realms: [...(base?.realms ?? [])],
      projects:
        s.proposedProjects !== null
          ? [...s.proposedProjects]
          : normalizeSlugList(s.entries.flatMap((e) => e.projects)),
      runtimes:
        s.proposedRuntimes !== null
          ? [...s.proposedRuntimes]
          : normalizeSlugList(s.entries.flatMap((e) => e.runtimes)),
    }
  }
  if (s.kind === 'update' || s.kind === 'tidy') {
    return {
      envs: s.proposedEnvs !== null ? [...s.proposedEnvs] : [...(base?.envs ?? [])],
      realms: s.proposedRealms?.length ? [...s.proposedRealms] : [...(base?.realms ?? [])],
      projects: s.proposedProjects !== null ? [...s.proposedProjects] : [...(base?.projects ?? [])],
      runtimes: s.proposedRuntimes !== null ? [...s.proposedRuntimes] : [...(base?.runtimes ?? [])],
    }
  }
  return {
    envs: [...(base?.envs ?? [])],
    realms: [...(base?.realms ?? [])],
    projects: [...(base?.projects ?? [])],
    runtimes: [...(base?.runtimes ?? [])],
  }
})

const effectiveTopics = computed<string[]>(() => {
  const s = props.suggestion
  const base = baseEntry.value
  if (s.proposedTopics !== null) return [...s.proposedTopics]
  if (s.kind === 'distill_episode') return []
  if (s.kind === 'merge_duplicates') {
    return mergeFallbackTopics(
      base?.topics ?? [],
      s.entries.map((e) => e.topics),
    )
  }
  return [...(base?.topics ?? [])]
})

const hasTopicsChange = computed(() => {
  const s = props.suggestion
  if (s.kind === 'distill_episode' || s.proposedTopics === null || !baseEntry.value) return false
  const before = normalizeSlugList(baseEntry.value.topics)
  const proposed = normalizeSlugList(s.proposedTopics)
  return before.length !== proposed.length || before.some((v, i) => v !== proposed[i])
})

const widenedScopeLabels = computed<string[]>(() => {
  const s = props.suggestion
  const base = baseEntry.value
  if (!base || isMarkStale.value || isLinkEntries.value || isAdjustBootMode.value) return []
  const labels: string[] = []
  const baseProjects = isMergeDuplicates.value
    ? normalizeSlugList(s.entries.flatMap((e) => e.projects))
    : base.projects
  const baseEnvs = isMergeDuplicates.value
    ? normalizeSlugList(s.entries.flatMap((e) => e.envs))
    : base.envs
  const baseRuntimes = isMergeDuplicates.value
    ? normalizeSlugList(s.entries.flatMap((e) => e.runtimes))
    : base.runtimes
  if (s.proposedProjects !== null && s.proposedProjects.length === 0 && baseProjects.length > 0) {
    labels.push('已放宽：不限项目')
  }
  if (s.proposedEnvs !== null && s.proposedEnvs.length === 0 && baseEnvs.length > 0) {
    labels.push('已放宽：不限环境')
  }
  if (s.proposedRuntimes !== null && s.proposedRuntimes.length === 0 && baseRuntimes.length > 0) {
    labels.push('已放宽：不限客户端')
  }
  return labels
})

const distillBootMode = computed<BootMode | null>(() => {
  if (!isDistillEpisode.value) return null
  const mode = props.suggestion.proposedBootMode
  return mode && mode !== 'none' ? mode : null
})

const effectiveDisclosure = computed<string | null>(() => {
  if (isMarkStale.value || isLinkEntries.value || isAdjustBootMode.value) {
    return baseEntry.value?.disclosure?.trim() || null
  }
  const proposed = props.suggestion.proposedDisclosure?.trim()
  if (proposed) return proposed
  if (isDistillEpisode.value) return null
  return baseEntry.value?.disclosure?.trim() || null
})

const isProposedDisclosureNew = computed(() => {
  const proposed = props.suggestion.proposedDisclosure?.trim()
  if (!proposed) return false
  if (isDistillEpisode.value) return true
  return proposed !== (baseEntry.value?.disclosure?.trim() ?? '')
})

const sourceDeviceKeys = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const entry of props.suggestion.entries) {
    const key = entry.deviceKey?.trim()
    if (key && !seen.has(key)) {
      seen.add(key)
      list.push(key)
    }
  }
  return list
})

const sourceEpisodeProvenance = computed(() => {
  const episodes = props.suggestion.entries.filter((e) => e.kind === 'episode')
  if (episodes.length < 2) return null
  const projects = normalizeSlugList(episodes.flatMap((e) => e.projects))
  const dateRange = formatShortRange(episodes.map((e) => e.updatedAt))
  return {
    episodeCount: episodes.length,
    projects,
    dateRange,
  }
})

interface ScopeTagGroup {
  key: 'envs' | 'projects' | 'realms' | 'runtimes'
  label: string
  icon: string
  items: string[]
}

const scopeTagGroups = computed<ScopeTagGroup[]>(() => {
  const groups: ScopeTagGroup[] = []
  if (effectiveScope.value.envs.length) {
    groups.push({
      key: 'envs',
      label: '环境',
      icon: icons.env,
      items: effectiveScope.value.envs.map((slug) => envDisplayName(slug)),
    })
  }
  if (effectiveScope.value.projects.length) {
    groups.push({
      key: 'projects',
      label: '项目',
      icon: icons.project,
      items: effectiveScope.value.projects,
    })
  }
  if (effectiveScope.value.realms.length) {
    groups.push({
      key: 'realms',
      label: '场域',
      icon: icons.realm,
      items: effectiveScope.value.realms,
    })
  }
  if (effectiveScope.value.runtimes.length) {
    groups.push({
      key: 'runtimes',
      label: '客户端',
      icon: icons.terminal,
      items: effectiveScope.value.runtimes.map((slug) => runtimeName(slug)),
    })
  }
  return groups
})

const hasProposedMeta = computed(() =>
  Boolean(
    props.suggestion.proposedEnvs !== null ||
    props.suggestion.proposedRealms?.length ||
    props.suggestion.proposedProjects !== null ||
    props.suggestion.proposedRuntimes !== null ||
    (isDistillEpisode.value && props.suggestion.proposedTopics?.length) ||
    (props.suggestion.proposedDisclosure?.trim() && (!isTidy.value || parts.disclosure)) ||
    distillBootMode.value,
  ),
)

const showScopeReview = computed(() => {
  if (isMarkStale.value || isLinkEntries.value || isAdjustBootMode.value) return false
  return (
    isDistillEpisode.value ||
    isUpdate.value ||
    isMergeDuplicates.value ||
    hasProposedMeta.value ||
    sourceDeviceKeys.value.length > 0
  )
})
const bootModeChoices = BOOT_MODES.map((value) => ({
  value,
  label: bootModeLabels[value],
  icon: bootModeIcons[value],
}))

const selectedProposedLinks = computed(() =>
  (props.suggestion.proposedLinks ?? []).filter((l) =>
    selectedLinkShortIds.value.includes(l.targetShortId),
  ),
)

function toggleProposedLink(shortId: string) {
  if (selectedLinkShortIds.value.includes(shortId)) {
    selectedLinkShortIds.value = selectedLinkShortIds.value.filter((s) => s !== shortId)
  } else {
    selectedLinkShortIds.value = [...selectedLinkShortIds.value, shortId]
  }
}

const hasTitleChange = computed(() => {
  if (isDistillEpisode.value) return false
  const proposed = props.suggestion.proposedTitle?.trim() ?? ''
  return Boolean(proposed && baseEntry.value && proposed !== baseEntry.value.title)
})

const hasSummaryChange = computed(() => {
  const proposed = props.suggestion.proposedSummary
  if (proposed === undefined || proposed === null) return false
  return proposed.trim() !== (baseEntry.value?.summary?.trim() ?? '')
})

const hasContentChange = computed(() =>
  Boolean(
    props.suggestion.proposedContent &&
    baseEntry.value &&
    props.suggestion.proposedContent !== baseEntry.value.content,
  ),
)

const hasArchivedNotes = computed(() => Boolean(props.suggestion.archivedNotes?.length))

const showPartialChecks = computed(
  () =>
    isTidy.value &&
    Boolean(baseEntry.value) &&
    (hasTitleChange.value ||
      hasSummaryChange.value ||
      hasTopicsChange.value ||
      isProposedDisclosureNew.value ||
      hasContentChange.value ||
      hasArchivedNotes.value),
)

const anyPartSelected = computed(() => {
  if (isLinkEntries.value) return selectedLinkShortIds.value.length > 0
  if (!showPartialChecks.value) return true
  return (
    (hasTitleChange.value && parts.title) ||
    (hasSummaryChange.value && parts.summary) ||
    (hasTopicsChange.value && parts.topics) ||
    (isProposedDisclosureNew.value && parts.disclosure) ||
    ((hasContentChange.value || hasArchivedNotes.value) && parts.content)
  )
})

const draft = reactive({
  title: '',
  summary: '',
  content: '',
  disclosure: '',
  changeSummary: '',
  applyArchivedNotes: true,
  topics: [] as string[],
  bootMode: 'none' as BootMode,
})
const draftScope = ref<SceneScopeValue>({ envs: [], realms: [], projects: [], runtimes: [] })

function openEditor() {
  const s = props.suggestion
  const base = baseEntry.value
  draft.title = s.proposedTitle ?? base?.title ?? ''
  draft.summary = s.proposedSummary ?? base?.summary ?? ''
  draft.content = s.proposedContent ?? base?.content ?? ''
  draft.disclosure = effectiveDisclosure.value ?? ''
  draft.changeSummary = s.proposedChangeSummary ?? ''
  draft.applyArchivedNotes = Boolean(s.archivedNotes?.length)
  draft.topics = [...effectiveTopics.value]
  draft.bootMode = s.proposedBootMode ?? (base ? effectiveBootMode(base) : 'none')
  draftScope.value = {
    envs: [...effectiveScope.value.envs],
    realms: [...effectiveScope.value.realms],
    projects: [...effectiveScope.value.projects],
    runtimes: [...effectiveScope.value.runtimes],
  }
  editing.value = true
}

function closeEditor() {
  editing.value = false
  revisedReason.value = null
  reviseError.value = null
}

async function submitRevise() {
  const instruction = reviseInstruction.value.trim()
  if (!instruction || reviseBusy.value || props.busy || props.disabled || !showReviseBar.value) {
    return
  }
  abortRevise()
  const controller = new AbortController()
  reviseController = controller
  reviseBusy.value = true
  reviseError.value = null

  const body: ReviseSuggestionRequest = {
    instruction,
    ...(editing.value
      ? {
          ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
          summary: draft.summary.replace(/[\r\n]+/g, ' ').trim() || null,
          ...(draft.content.trim() ? { content: draft.content } : {}),
          disclosure: draft.disclosure.trim() || null,
          ...(draft.changeSummary.trim() ? { changeSummary: draft.changeSummary.trim() } : {}),
          topics: draft.topics,
          envs: draftScope.value.envs,
          realms: draftScope.value.realms,
          projects: draftScope.value.projects,
          runtimes: draftScope.value.runtimes,
          bootMode: draft.bootMode,
        }
      : {}),
  }

  try {
    const res = await api.reviseInboxSuggestion(props.suggestion.id, body, controller.signal)
    if (reviseController !== controller) return
    reviseController = null
    if (!editing.value) openEditor()
    if (res.proposedTitle !== null) draft.title = res.proposedTitle
    draft.summary = res.proposedSummary ?? ''
    draft.content = res.proposedContent
    draft.disclosure = res.proposedDisclosure ?? ''
    if (res.proposedChangeSummary !== null) draft.changeSummary = res.proposedChangeSummary
    if (res.proposedTopics !== null) draft.topics = [...res.proposedTopics]
    if (res.proposedBootMode !== null) draft.bootMode = res.proposedBootMode
    draftScope.value = {
      envs: res.proposedEnvs !== null ? [...res.proposedEnvs] : [...draftScope.value.envs],
      realms: res.proposedRealms !== null ? [...res.proposedRealms] : [...draftScope.value.realms],
      projects:
        res.proposedProjects !== null ? [...res.proposedProjects] : [...draftScope.value.projects],
      runtimes:
        res.proposedRuntimes !== null ? [...res.proposedRuntimes] : [...draftScope.value.runtimes],
    }
    revisedReason.value = res.reason
    showRevisedDiff.value = true
    reviseInstruction.value = ''
  } catch (err) {
    if (reviseController !== controller) return
    reviseController = null
    if (err instanceof Error && err.name === 'AbortError') return
    reviseError.value = err instanceof ApiError ? err.message : '按说明修订失败，请重试'
  } finally {
    if (reviseController === null) reviseBusy.value = false
  }
}

function onReviseKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.key !== 'Enter') return
  event.preventDefault()
  void submitRevise()
}

const reviseDiffBefore = computed(() => {
  if (isDistillEpisode.value) {
    return props.suggestion.proposedContent ?? baseEntry.value?.content ?? ''
  }
  return baseEntry.value?.content ?? ''
})

const effectiveProposedContent = computed<string | null>(() => {
  const s = props.suggestion
  if (s.kind === 'mark_stale' || s.kind === 'link_entries' || s.kind === 'adjust_boot_mode') {
    return null
  }
  if (s.kind === 'distill_episode') {
    return editing.value && revisedReason.value !== null ? draft.content : null
  }
  if (editing.value) return draft.content
  if (isTidy.value && !parts.content) return null
  return s.proposedContent
})

const integrity = computed<CaptureIntegrity | null>(() => {
  const base = baseEntry.value
  const next = effectiveProposedContent.value
  if (!base || next === null) return null
  if (props.suggestion.kind === 'distill_episode') {
    return checkCaptureIntegrity(reviseDiffBefore.value, next)
  }
  if (props.suggestion.kind === 'merge_duplicates' && props.suggestion.entries.length > 1) {
    // 合并场景汇总全部待合并记忆的引用集合（排除被合并记忆自身短 ID）
    const mergedSelfIds = new Set(props.suggestion.entries.map((e) => e.shortId))
    const linksBeforeSet = new Set<string>()
    const credsBeforeSet = new Set<string>()
    const credKey = (p: { slug: string; field: string | null }) =>
      p.field ? `${p.slug}#${p.field}` : p.slug
    for (const item of props.suggestion.entries) {
      for (const sid of extractTargetShortIds(item.content)) {
        if (!mergedSelfIds.has(sid)) linksBeforeSet.add(sid)
      }
      for (const cred of extractCredentialPlaceholders(item.content)) {
        credsBeforeSet.add(credKey(cred))
      }
    }
    const linksAfterSet = new Set(extractTargetShortIds(next))
    const credsAfterSet = new Set(extractCredentialPlaceholders(next).map(credKey))
    const missingLinks = [...linksBeforeSet].filter((id) => !linksAfterSet.has(id))
    const missingCreds = [...credsBeforeSet].filter((k) => !credsAfterSet.has(k))
    const severeShrink =
      base.content.length >= 200 && next.length < Math.floor(base.content.length * 0.5)
    return {
      intact: missingLinks.length === 0 && missingCreds.length === 0 && !severeShrink,
      linksBefore: linksBeforeSet.size,
      linksAfter: linksAfterSet.size,
      missingLinks,
      credsBefore: credsBeforeSet.size,
      credsAfter: credsAfterSet.size,
      missingCreds,
      severeShrink,
    }
  }
  return checkCaptureIntegrity(base.content, next)
})

const editSecretWarnings = computed(() =>
  editing.value ? detectSecretPrefixes(draft.content) : [],
)

const editValidationProblem = computed(() => {
  if (!editing.value) return null
  if (draft.title.trim()) {
    const check = EntryTitle.safeParse(draft.title)
    if (!check.success) return check.error.issues[0]?.message ?? '标题格式有误'
  }
  if (draft.summary.trim()) {
    const check = EntrySummary.safeParse(draft.summary)
    if (!check.success) return check.error.issues[0]?.message ?? '现行概要格式有误'
  }
  if (draft.disclosure.trim()) {
    const check = Disclosure.safeParse(draft.disclosure)
    if (!check.success) return check.error.issues[0]?.message ?? '召回时机格式有误'
  }
  if (draft.changeSummary.trim()) {
    const check = ChangeSummary.safeParse(draft.changeSummary)
    if (!check.success) return check.error.issues[0]?.message ?? '变更说明格式有误'
  }
  if (!draft.content.trim()) return '正文不能为空'
  return null
})

const hasLostRefs = computed(() =>
  Boolean(
    integrity.value &&
    (integrity.value.missingLinks.length > 0 || integrity.value.missingCreds.length > 0),
  ),
)

const isGuardNormal = computed(() =>
  Boolean(integrity.value && integrity.value.intact && !integrity.value.severeShrink),
)

const lengthDelta = computed(() => {
  const base = baseEntry.value
  const next = effectiveProposedContent.value
  if (!base || next === null) return null
  const before = base.content.length
  const after = next.length
  const delta = after - before
  const pct = before > 0 ? Math.round((delta / before) * 100) : 0
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : ''
  return {
    before,
    after,
    delta,
    pct,
    deltaText: `${sign}${Math.abs(pct)}%`,
  }
})

// 正常态隐藏 0 → 0 无信息量护栏项，只在有引用或存在异常时展示
const showLinksMetric = computed(() =>
  Boolean(
    integrity.value &&
    (!isGuardNormal.value || integrity.value.linksBefore > 0 || integrity.value.linksAfter > 0),
  ),
)

const showCredsMetric = computed(() =>
  Boolean(
    integrity.value &&
    (!isGuardNormal.value || integrity.value.credsBefore > 0 || integrity.value.credsAfter > 0),
  ),
)

const hasNotableLengthChange = computed(() =>
  Boolean(
    lengthDelta.value &&
    (Math.abs(lengthDelta.value.pct) >= 10 || Math.abs(lengthDelta.value.delta) >= 80),
  ),
)

const showCompactGuardOnly = computed(
  () =>
    isGuardNormal.value &&
    !showLinksMetric.value &&
    !showCredsMetric.value &&
    !hasNotableLengthChange.value,
)

const integrityMessage = computed(() => {
  const check = integrity.value
  if (!check) return null
  const missing: string[] = []
  if (check.missingLinks.length) missing.push(`缺失双链 ${check.missingLinks.join('、')}`)
  if (check.missingCreds.length) missing.push(`缺失凭据占位符 ${check.missingCreds.join('、')}`)
  if (missing.length) return missing.join('；')
  if (check.severeShrink) {
    return isTidy.value
      ? '正文篇幅缩减较大，请核对已归档历史说明与对比内容'
      : '正文篇幅显著缩减，请核对变更对比'
  }
  return '双链与凭据引用完整'
})

const hasDiffChanges = computed(() => {
  const next = effectiveProposedContent.value
  if (next === null) return false
  const before = baseEntry.value?.content ?? ''
  return before.replace(/\r\n/g, '\n') !== next.replace(/\r\n/g, '\n')
})

const currentBootMode = computed<BootMode>(() =>
  baseEntry.value ? effectiveBootMode(baseEntry.value) : 'none',
)

const indexPreviewSummary = computed(
  () => props.suggestion.proposedSummary?.trim() || baseEntry.value?.summary?.trim() || '',
)

const primaryApplyLabel = computed(() => {
  if (isMarkStale.value) return '确认移入回收站'
  if (isMergeDuplicates.value) return '确认合并'
  if (isLinkEntries.value) return `应用所选（${selectedLinkShortIds.value.length} 条）`
  return isInspector.value ? '应用改动' : '应用'
})

const primaryApplyIcon = computed(() =>
  isMarkStale.value ? icons.remove : isMergeDuplicates.value ? icons.merge : icons.check,
)

const deltaSectionTitle = computed(() => {
  if (editing.value) return '编辑后应用'
  if (isAdjustBootMode.value) return '启动加载变更'
  if (isLinkEntries.value) return '建议追加的双链'
  if (isMergeDuplicates.value) return '合并结构与正文变更对比'
  if (isTidy.value) return '规范精简变更对比'
  if (isDistillEpisode.value) return '提炼为正式记忆'
  if (isMarkStale.value) return '移入回收站核对'
  return '正文更新对比'
})

const nonContentImpactNote = computed<string | null>(() => {
  if (integrity.value) return null
  if (isAdjustBootMode.value && baseEntry.value && props.suggestion.proposedBootMode) {
    const chars = baseEntry.value.content.length.toLocaleString()
    if (currentBootMode.value === 'full' && props.suggestion.proposedBootMode === 'index') {
      return `正文完整保留，启动加载由全文（${chars} 字）降为目录索引`
    }
    return '正文完整保留，仅调整启动加载方式'
  }
  if (isLinkEntries.value) {
    return `追加已选的 ${selectedLinkShortIds.value.length} 条双链，不改写其余正文`
  }
  if (isMarkStale.value) {
    return '移入回收站后不再参与召回，可随时从回收站恢复'
  }
  if (isDistillEpisode.value) {
    if (distillBootMode.value) {
      return `新建 1 条${bootModeLabels[distillBootMode.value]}正式记忆，原会话摘要将移入回收站（可随时恢复）`
    }
    return '新建 1 条正式记忆，原会话摘要将移入回收站（可随时恢复）'
  }
  return null
})

function applyDirect() {
  const s = props.suggestion
  const base = baseEntry.value
  if (isLinkEntries.value) {
    emit('apply', s.id, { proposedLinks: selectedProposedLinks.value })
    return
  }
  if (showPartialChecks.value && base) {
    const allChecked =
      (!hasTitleChange.value || parts.title) &&
      (!hasSummaryChange.value || parts.summary) &&
      (!hasTopicsChange.value || parts.topics) &&
      (!isProposedDisclosureNew.value || parts.disclosure) &&
      (!(hasContentChange.value || hasArchivedNotes.value) || parts.content)
    if (!allChecked) {
      const applyTitle = hasTitleChange.value && parts.title && Boolean(s.proposedTitle?.trim())
      const applySummary = hasSummaryChange.value && parts.summary
      const applyTopics = hasTopicsChange.value && parts.topics
      const applyDisclosure = isProposedDisclosureNew.value && parts.disclosure
      const applyContent = (hasContentChange.value || hasArchivedNotes.value) && parts.content
      let changeSummary: string | undefined
      if (applyContent && s.proposedChangeSummary?.trim()) {
        changeSummary = s.proposedChangeSummary.trim()
      } else {
        const appliedLabels: string[] = []
        if (applyTitle) appliedLabels.push('规范标题')
        if (applySummary) appliedLabels.push('更新现行概要')
        if (applyTopics) appliedLabels.push('收敛主题')
        if (applyDisclosure) appliedLabels.push('更新召回时机')
        if (appliedLabels.length) changeSummary = appliedLabels.join('并')
      }
      const body: ApplySuggestionRequest = {
        title: applyTitle ? s.proposedTitle!.trim() : base.title,
        summary: applySummary ? s.proposedSummary?.trim() || null : (base.summary ?? null),
        ...(hasTopicsChange.value
          ? { topics: applyTopics ? [...(s.proposedTopics ?? base.topics)] : [...base.topics] }
          : {}),
        ...(isProposedDisclosureNew.value
          ? {
              disclosure: applyDisclosure
                ? s.proposedDisclosure?.trim() || null
                : (base.disclosure ?? null),
            }
          : {}),
        content: applyContent && s.proposedContent ? s.proposedContent : base.content,
        applyArchivedNotes: applyContent && hasArchivedNotes.value,
        ...(changeSummary ? { changeSummary } : {}),
      }
      emit('apply', s.id, body)
      return
    }
  }
  emit('apply', s.id, {})
}

function applyEdited() {
  if (editValidationProblem.value) return
  const normalizedSummary = draft.summary.replace(/[\r\n]+/g, ' ').trim()
  const body: ApplySuggestionRequest = {
    ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
    summary: normalizedSummary || null,
    ...(draft.content.trim() ? { content: draft.content } : {}),
    disclosure: draft.disclosure.trim() || null,
    ...(draft.changeSummary.trim() ? { changeSummary: draft.changeSummary.trim() } : {}),
    ...(hasArchivedNotes.value ? { applyArchivedNotes: draft.applyArchivedNotes } : {}),
    topics: draft.topics,
    envs: draftScope.value.envs,
    realms: draftScope.value.realms,
    projects: draftScope.value.projects,
    runtimes: draftScope.value.runtimes,
    bootMode: draft.bootMode,
    isPinned: draft.bootMode !== 'none',
  }
  emit('apply', props.suggestion.id, body)
}
</script>

<template>
  <!-- 展开态：65% 纯亮纸变更区 + 35% 整理依据与护栏 -->
  <div v-if="isInspector" class="inspector-grid">
    <section class="inspector-main" aria-label="建议改动详情">
      <div class="section-eyebrow">
        <span class="eyebrow-lead">
          <UIcon
            :name="editing ? icons.edit : dreamKindIcons[suggestion.kind]"
            class="eyebrow-icon"
            aria-hidden="true"
          />
          <span>{{ deltaSectionTitle }}</span>
        </span>
        <span v-if="editing" class="eyebrow-sub">修改仅对本次写入生效</span>
        <span v-else-if="isLinkEntries && suggestion.proposedLinks?.length" class="tabular-nums">
          已选 {{ selectedLinkShortIds.length }} / {{ suggestion.proposedLinks.length }} 条
        </span>
      </div>

      <!-- 编辑后应用表单（不用 form 标签防误回车提交） -->
      <div v-if="editing" class="edit-box">
        <div v-if="revisedReason" class="revise-preview-panel">
          <div class="revise-preview-head">
            <span class="revise-preview-lead">
              <UIcon :name="icons.sparkles" class="revise-preview-icon" aria-hidden="true" />
              <span>已按说明修订草稿</span>
            </span>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="showRevisedDiff ? icons.chevronUp : icons.compare"
              @click="showRevisedDiff = !showRevisedDiff"
            >
              {{ showRevisedDiff ? '收起对比' : '查看对比' }}
            </UButton>
          </div>
          <p class="revise-preview-reason">
            <WikiText :text="revisedReason" :titles="knownTitles" :mark-missing="false" compact />
          </p>
          <NoteLine v-if="hasLostRefs || integrity?.severeShrink" tone="warning" flush>
            {{ integrityMessage }}
          </NoteLine>
          <DiffViewer
            v-if="showRevisedDiff"
            :before="reviseDiffBefore"
            :after="draft.content"
            :context="3"
            :expand-step="10"
            max-height="18rem"
            empty-text="正文无变更，已更新草稿属性"
          />
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="标题">
            <template #label>
              <span class="field-label">
                <UIcon :name="icons.heading" class="field-label-icon" aria-hidden="true" />
                <span>标题</span>
              </span>
            </template>
            <UInput v-model="draft.title" :maxlength="ENTRY_TITLE_MAX" class="w-full" />
          </UFormField>
          <UFormField label="主题">
            <template #label>
              <span class="field-label">
                <UIcon :name="icons.topic" class="field-label-icon" aria-hidden="true" />
                <span>主题</span>
              </span>
            </template>
            <UInputTags
              v-model="draft.topics"
              add-on-blur
              placeholder="输入后回车"
              class="w-full"
            />
          </UFormField>
        </div>
        <UFormField label="现行概要（可选）">
          <template #label>
            <span class="field-label">
              <UIcon :name="icons.summary" class="field-label-icon" aria-hidden="true" />
              <span>现行概要（可选）</span>
            </span>
          </template>
          <UTextarea
            v-model="draft.summary"
            :rows="2"
            autoresize
            :maxrows="4"
            :maxlength="ENTRY_SUMMARY_MAX"
            class="w-full"
          />
        </UFormField>
        <NoteLine v-if="editSecretWarnings.length" tone="warning" flush>
          正文疑似包含{{
            editSecretWarnings.map((w) => w.label).join('、')
          }}，建议改存凭据并用占位符引用。
        </NoteLine>
        <UFormField label="正文">
          <template #label>
            <span class="field-label">
              <UIcon :name="icons.file" class="field-label-icon" aria-hidden="true" />
              <span>正文</span>
            </span>
          </template>
          <UTextarea v-model="draft.content" :rows="8" autoresize class="w-full font-mono" />
        </UFormField>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="召回时机（可选）">
            <UInput v-model="draft.disclosure" :maxlength="DISCLOSURE_MAX" class="w-full" />
          </UFormField>
          <UFormField label="变更说明（可选）">
            <UInput v-model="draft.changeSummary" :maxlength="CHANGE_SUMMARY_MAX" class="w-full" />
          </UFormField>
        </div>
        <UFormField label="适用场景">
          <SceneScopePicker v-model="draftScope" />
        </UFormField>
        <div class="flex flex-wrap items-center gap-6">
          <UFormField label="启动加载方式">
            <template #label>
              <span class="field-label">
                <UIcon :name="icons.pin" class="field-label-icon" aria-hidden="true" />
                <span>启动加载方式</span>
              </span>
            </template>
            <SegmentedChoice
              v-model="draft.bootMode"
              :items="bootModeChoices"
              label="选择启动加载方式"
              compact
            />
          </UFormField>
          <USwitch
            v-if="hasArchivedNotes"
            v-model="draft.applyArchivedNotes"
            label="将剥离的历史说明写入版本历史"
          />
        </div>
        <p v-if="editValidationProblem" class="text-xs text-error" role="alert">
          {{ editValidationProblem }}
        </p>
        <div class="edit-actions">
          <UButton
            size="sm"
            :icon="icons.check"
            :loading="busy"
            :disabled="disabled || reviseBusy || Boolean(editValidationProblem)"
            @click="applyEdited"
          >
            保存并应用
          </UButton>
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            :disabled="busy || disabled || reviseBusy"
            @click="closeEditor"
          >
            取消编辑
          </UButton>
        </div>
      </div>

      <!-- 调整启动加载 -->
      <template v-else-if="isAdjustBootMode && baseEntry && suggestion.proposedBootMode">
        <div class="boot-transition">
          <div class="boot-state-col">
            <span class="boot-state-kicker">变更前</span>
            <span class="boot-state-name">
              <UIcon
                :name="bootModeIcons[currentBootMode]"
                class="boot-state-icon"
                aria-hidden="true"
              />
              <span>{{ bootModeLabels[currentBootMode] }}</span>
            </span>
            <span class="boot-state-detail tabular-nums">
              {{
                currentBootMode === 'full'
                  ? `每次会话全量注入 ${baseEntry.content.length.toLocaleString()} 字`
                  : bootModeDescriptions[currentBootMode]
              }}
            </span>
          </div>
          <div class="boot-arrow-mid" aria-hidden="true">
            <UIcon :name="icons.inherits" class="transition-arrow" />
          </div>
          <div class="boot-state-col is-target">
            <span class="boot-state-kicker">变更后</span>
            <span class="boot-state-name">
              <UIcon
                :name="bootModeIcons[suggestion.proposedBootMode]"
                class="boot-state-icon"
                aria-hidden="true"
              />
              <span>{{ bootModeLabels[suggestion.proposedBootMode] }}</span>
            </span>
            <span class="boot-state-detail">
              {{ bootModeDescriptions[suggestion.proposedBootMode] }}
            </span>
          </div>
        </div>

        <div v-if="hasSummaryChange || suggestion.proposedSummary?.trim()" class="summary-change">
          <span class="sub-eyebrow">
            <UIcon :name="icons.summary" class="sub-eyebrow-icon" aria-hidden="true" />
            <span>附带现行概要变更</span>
          </span>
          <div class="summary-diff-grid">
            <div class="summary-row">
              <span class="summary-tag">原概要</span>
              <span class="summary-old">
                <WikiText
                  v-if="baseEntry.summary?.trim()"
                  :text="baseEntry.summary.trim()"
                  :titles="knownTitles"
                  :mark-missing="false"
                  compact
                />
                <template v-else>暂无</template>
              </span>
            </div>
            <div class="summary-row">
              <span class="summary-tag">建议概要</span>
              <span class="summary-new">
                <WikiText
                  :text="suggestion.proposedSummary ?? ''"
                  :titles="knownTitles"
                  :mark-missing="false"
                  compact
                />
              </span>
            </div>
          </div>
        </div>

        <div v-if="suggestion.proposedBootMode === 'index'" class="summary-change">
          <span class="sub-eyebrow">
            <UIcon :name="icons.bookmark" class="sub-eyebrow-icon" aria-hidden="true" />
            <span>启动目录条目预览</span>
          </span>
          <div
            class="index-preview-line tabular-nums"
            :title="`${baseEntry.title}（${baseEntry.shortId}）`"
          >
            <strong class="index-preview-title">{{ baseEntry.title }}</strong>
            <span>（{{ baseEntry.content.length.toLocaleString() }} 字）</span>
            <template v-if="indexPreviewSummary"
              >：<WikiText
                :text="indexPreviewSummary"
                :titles="knownTitles"
                :mark-missing="false"
                compact
            /></template>
          </div>
        </div>
      </template>

      <!-- 补全双链 -->
      <template v-else-if="isLinkEntries && suggestion.proposedLinks?.length">
        <ul class="link-checklist">
          <li
            v-for="link in suggestion.proposedLinks"
            :key="link.targetShortId"
            class="link-check-item"
          >
            <div class="link-check-label">
              <input
                type="checkbox"
                class="square-check"
                :aria-label="`选择关联「${link.targetTitle || link.targetShortId}」`"
                :checked="selectedLinkShortIds.includes(link.targetShortId)"
                :disabled="busy"
                @change="toggleProposedLink(link.targetShortId)"
              />
              <span class="link-check-body">
                <span class="link-check-top">
                  <RouterLink
                    :to="entryRoute(link.targetShortId)"
                    class="text-primary font-medium"
                    :title="
                      link.targetTitle
                        ? `${link.targetTitle}（${link.targetShortId}）`
                        : link.targetShortId
                    "
                  >
                    {{ link.targetTitle || link.targetShortId }}
                  </RouterLink>
                  <span v-if="link.relation" class="link-relation-tag">{{ link.relation }}</span>
                  <span v-if="link.anchorHeading" class="text-xs text-muted">
                    小节：{{ link.anchorHeading }}
                  </span>
                </span>
                <p v-if="link.reason" class="link-reason">
                  <WikiText
                    :text="link.reason"
                    :titles="knownTitles"
                    :mark-missing="false"
                    compact
                  />
                </p>
              </span>
            </div>
          </li>
        </ul>

        <div class="link-write-preview">
          <span class="sub-eyebrow">
            <UIcon :name="icons.code" class="sub-eyebrow-icon" aria-hidden="true" />
            <span>写入预览</span>
          </span>
          <pre v-if="selectedProposedLinks.length" class="link-preview-code">{{
            selectedProposedLinks
              .map((l) => {
                const label = l.relation?.trim() || l.targetTitle?.trim() || ''
                const wiki = label ? `[[${l.targetShortId}|${label}]]` : `[[${l.targetShortId}]]`
                const reason = l.reason?.trim() ? `：${l.reason.trim()}` : ''
                return `+ - ${wiki}${reason}`
              })
              .join('\n')
          }}</pre>
          <p v-else class="skip-content-note">尚未勾选双链项，至少勾选 1 条后可应用。</p>
        </div>
      </template>

      <!-- 合并重复记忆 -->
      <template v-else-if="isMergeDuplicates">
        <div v-if="baseEntry && mergedSourceEntries.length" class="structure-strip">
          <span class="strip-role">保留目标</span>
          <span class="strip-new" :title="`${baseEntry.title}（${baseEntry.shortId}）`">
            {{ baseEntry.title }}
          </span>
          <UIcon :name="icons.back" class="compare-arrow" aria-hidden="true" />
          <span class="strip-role">并入来源</span>
          <template v-for="(src, idx) in mergedSourceEntries" :key="src.id">
            <span v-if="idx > 0" class="text-muted">、</span>
            <span class="strip-old" :title="`${src.title}（${src.shortId}）`">
              {{ src.title }}
            </span>
          </template>
        </div>

        <div v-if="hasTitleChange && baseEntry" class="title-compare">
          <span class="compare-label">合并后标题</span>
          <span class="compare-old">{{ baseEntry.title }}</span>
          <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
          <span class="compare-new">{{ suggestion.proposedTitle }}</span>
        </div>

        <div v-if="hasTopicsChange && baseEntry" class="title-compare">
          <span class="compare-label">主题收敛</span>
          <span class="compare-old">
            {{ baseEntry.topics.length ? baseEntry.topics.join('、') : '未设主题' }}
          </span>
          <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
          <span class="compare-new">
            {{ effectiveTopics.length ? effectiveTopics.join('、') : '清空主题' }}
          </span>
        </div>

        <div v-if="suggestion.proposedSummary?.trim()" class="summary-preview">
          <span class="summary-preview-label">
            <UIcon :name="icons.summary" class="summary-preview-icon" aria-hidden="true" />
            <span>建议现行概要</span>
          </span>
          <p class="summary-preview-text">
            <WikiText
              :text="suggestion.proposedSummary ?? ''"
              :titles="knownTitles"
              :mark-missing="false"
              compact
            />
          </p>
        </div>

        <div v-if="showScopeReview" class="scope-review">
          <div class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.sliders" class="scope-review-icon" aria-hidden="true" />
              <span>将写入场景</span>
            </span>
            <div class="scope-review-chips">
              <template v-if="scopeTagGroups.length">
                <span v-for="group in scopeTagGroups" :key="group.key" class="scope-group">
                  <span class="scope-group-name">
                    <UIcon :name="group.icon" class="scope-chip-icon" aria-hidden="true" />
                    <span>{{ group.label }}</span>
                  </span>
                  <span v-for="val in group.items" :key="`${group.key}:${val}`" class="scope-chip">
                    {{ val }}
                  </span>
                </span>
              </template>
              <span v-else class="scope-chip is-universal">
                <UIcon :name="icons.globe" class="scope-chip-icon" aria-hidden="true" />
                <span>全局通用</span>
              </span>
              <span
                v-for="label in widenedScopeLabels"
                :key="`widen:${label}`"
                class="scope-chip is-widened"
              >
                <UIcon :name="icons.globe" class="scope-chip-icon" aria-hidden="true" />
                <span>{{ label }}</span>
              </span>
              <span
                v-for="dev in sourceDeviceKeys"
                :key="`dev:${dev}`"
                class="scope-chip is-device"
              >
                <UIcon :name="icons.deviceDesktop" class="scope-chip-icon" aria-hidden="true" />
                <span>来源设备</span>
                <span class="font-mono">{{ dev }}</span>
              </span>
            </div>
          </div>
          <div v-if="effectiveDisclosure" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.trigger" class="scope-review-icon" aria-hidden="true" />
              <span>{{ isProposedDisclosureNew ? '建议召回时机' : '召回时机' }}</span>
            </span>
            <span class="scope-disclosure-text">{{ effectiveDisclosure }}</span>
          </div>
        </div>

        <DiffViewer
          v-if="effectiveProposedContent !== null && hasDiffChanges"
          :before="baseEntry?.content ?? ''"
          :after="effectiveProposedContent"
          :context="3"
          :expand-step="10"
          max-height="24rem"
        />
      </template>

      <!-- 提炼会话摘要 -->
      <template v-else-if="isDistillEpisode">
        <div v-if="suggestion.proposedTitle" class="structure-strip">
          <span class="strip-role">新记忆标题</span>
          <span class="strip-new">{{ suggestion.proposedTitle }}</span>
        </div>
        <div v-if="suggestion.proposedSummary?.trim()" class="summary-preview">
          <span class="summary-preview-label">
            <UIcon :name="icons.summary" class="summary-preview-icon" aria-hidden="true" />
            <span>建议现行概要</span>
          </span>
          <p class="summary-preview-text">
            <WikiText
              :text="suggestion.proposedSummary ?? ''"
              :titles="knownTitles"
              :mark-missing="false"
              compact
            />
          </p>
        </div>
        <div v-if="showScopeReview" class="scope-review">
          <div class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.sliders" class="scope-review-icon" aria-hidden="true" />
              <span>将写入场景</span>
            </span>
            <div class="scope-review-chips">
              <template v-if="scopeTagGroups.length">
                <span v-for="group in scopeTagGroups" :key="group.key" class="scope-group">
                  <span class="scope-group-name">
                    <UIcon :name="group.icon" class="scope-chip-icon" aria-hidden="true" />
                    <span>{{ group.label }}</span>
                  </span>
                  <span v-for="val in group.items" :key="`${group.key}:${val}`" class="scope-chip">
                    {{ val }}
                  </span>
                </span>
              </template>
              <span v-else class="scope-chip is-universal">
                <UIcon :name="icons.globe" class="scope-chip-icon" aria-hidden="true" />
                <span>全局通用</span>
              </span>
              <span
                v-for="label in widenedScopeLabels"
                :key="`widen:${label}`"
                class="scope-chip is-widened"
              >
                <UIcon :name="icons.globe" class="scope-chip-icon" aria-hidden="true" />
                <span>{{ label }}</span>
              </span>
              <span
                v-for="dev in sourceDeviceKeys"
                :key="`dev:${dev}`"
                class="scope-chip is-device"
              >
                <UIcon :name="icons.deviceDesktop" class="scope-chip-icon" aria-hidden="true" />
                <span>来源设备</span>
                <span class="font-mono">{{ dev }}</span>
              </span>
            </div>
          </div>
          <div v-if="sourceEpisodeProvenance" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.history" class="scope-review-icon" aria-hidden="true" />
              <span>聚合来源</span>
            </span>
            <div class="scope-review-chips tabular-nums">
              <span class="scope-chip">
                来自 {{ sourceEpisodeProvenance.episodeCount }} 条会话摘要
              </span>
              <span v-if="sourceEpisodeProvenance.projects.length" class="scope-chip">
                涉及项目 {{ sourceEpisodeProvenance.projects.join('、') }}
              </span>
              <span v-if="sourceEpisodeProvenance.dateRange" class="scope-chip">
                {{ sourceEpisodeProvenance.dateRange }}
              </span>
            </div>
          </div>
          <div v-if="distillBootMode" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.pin" class="scope-review-icon" aria-hidden="true" />
              <span>建议启动加载</span>
            </span>
            <span class="scope-chip is-boot">
              <UIcon
                :name="bootModeIcons[distillBootMode]"
                class="scope-chip-icon"
                aria-hidden="true"
              />
              <span>{{ bootModeLabels[distillBootMode] }}</span>
            </span>
          </div>
          <div v-if="isDistillEpisode && effectiveTopics.length" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.topic" class="scope-review-icon" aria-hidden="true" />
              <span>主题</span>
            </span>
            <div class="scope-review-chips">
              <span v-for="tag in effectiveTopics" :key="`topic:${tag}`" class="scope-chip">
                {{ tag }}
              </span>
            </div>
          </div>
          <div v-if="effectiveDisclosure && (!isTidy || parts.disclosure)" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.trigger" class="scope-review-icon" aria-hidden="true" />
              <span>{{ isProposedDisclosureNew ? '建议召回时机' : '召回时机' }}</span>
            </span>
            <span class="scope-disclosure-text">{{ effectiveDisclosure }}</span>
          </div>
        </div>
        <pre v-if="suggestion.proposedContent" class="preview-box">{{
          suggestion.proposedContent
        }}</pre>
      </template>

      <!-- 标记过时记忆 -->
      <template v-else-if="isMarkStale">
        <div v-if="baseEntry" class="structure-strip tabular-nums">
          <span class="strip-role">
            <UIcon :name="icons.remove" class="strip-role-icon is-danger" aria-hidden="true" />
            <span>待移入回收站</span>
          </span>
          <span class="strip-new" :title="`${baseEntry.title}（${baseEntry.shortId}）`">
            {{ baseEntry.title }}
          </span>
          <span class="text-xs text-muted">{{ baseEntry.content.length.toLocaleString() }} 字</span>
          <span v-if="baseEntry.isPinned" class="keep-tag">
            <UIcon
              :name="bootModeIcons[effectiveBootMode(baseEntry)]"
              class="keep-tag-icon"
              aria-hidden="true"
            />
            <span>{{ bootModeLabels[effectiveBootMode(baseEntry)] }}</span>
          </span>
        </div>
        <pre v-if="baseEntry?.content" class="preview-box">{{ baseEntry.content }}</pre>
      </template>

      <!-- 规范与精简 / 更新记忆内容 -->
      <template v-else>
        <div v-if="showPartialChecks" class="partial-row" role="group" aria-label="分项应用选择">
          <span class="partial-label">
            <UIcon :name="icons.listChecks" class="partial-label-icon" aria-hidden="true" />
            <span>分项应用</span>
          </span>
          <label v-if="hasTitleChange" class="part-check">
            <input v-model="parts.title" type="checkbox" class="square-check" :disabled="busy" />
            <span>规范标题</span>
          </label>
          <label v-if="hasSummaryChange" class="part-check">
            <input v-model="parts.summary" type="checkbox" class="square-check" :disabled="busy" />
            <span>更新现行概要</span>
          </label>
          <label v-if="hasTopicsChange" class="part-check">
            <input v-model="parts.topics" type="checkbox" class="square-check" :disabled="busy" />
            <span>收敛主题</span>
          </label>
          <label v-if="isProposedDisclosureNew" class="part-check">
            <input
              v-model="parts.disclosure"
              type="checkbox"
              class="square-check"
              :disabled="busy"
            />
            <span>更新召回时机</span>
          </label>
          <label v-if="hasContentChange || hasArchivedNotes" class="part-check">
            <input v-model="parts.content" type="checkbox" class="square-check" :disabled="busy" />
            <span>{{ hasArchivedNotes ? '精简正文并归档历史说明' : '精简正文' }}</span>
          </label>
        </div>

        <div v-if="hasTitleChange && baseEntry && (!isTidy || parts.title)" class="title-compare">
          <span class="compare-label">标题调整</span>
          <span class="compare-old">{{ baseEntry.title }}</span>
          <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
          <span class="compare-new">{{ suggestion.proposedTitle }}</span>
        </div>

        <div v-if="hasTopicsChange && baseEntry && (!isTidy || parts.topics)" class="title-compare">
          <span class="compare-label">主题收敛</span>
          <span class="compare-old">
            {{ baseEntry.topics.length ? baseEntry.topics.join('、') : '未设主题' }}
          </span>
          <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
          <span class="compare-new">
            {{ effectiveTopics.length ? effectiveTopics.join('、') : '清空主题' }}
          </span>
        </div>

        <div
          v-if="suggestion.proposedSummary?.trim() && (!isTidy || parts.summary)"
          class="summary-preview"
        >
          <span class="summary-preview-label">
            <UIcon :name="icons.summary" class="summary-preview-icon" aria-hidden="true" />
            <span>建议现行概要</span>
          </span>
          <p class="summary-preview-text">
            <WikiText
              :text="suggestion.proposedSummary ?? ''"
              :titles="knownTitles"
              :mark-missing="false"
              compact
            />
          </p>
        </div>

        <div v-if="showScopeReview" class="scope-review">
          <div class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.sliders" class="scope-review-icon" aria-hidden="true" />
              <span>将写入场景</span>
            </span>
            <div class="scope-review-chips">
              <template v-if="scopeTagGroups.length">
                <span v-for="group in scopeTagGroups" :key="group.key" class="scope-group">
                  <span class="scope-group-name">
                    <UIcon :name="group.icon" class="scope-chip-icon" aria-hidden="true" />
                    <span>{{ group.label }}</span>
                  </span>
                  <span v-for="val in group.items" :key="`${group.key}:${val}`" class="scope-chip">
                    {{ val }}
                  </span>
                </span>
              </template>
              <span v-else class="scope-chip is-universal">
                <UIcon :name="icons.globe" class="scope-chip-icon" aria-hidden="true" />
                <span>全局通用</span>
              </span>
              <span
                v-for="label in widenedScopeLabels"
                :key="`widen:${label}`"
                class="scope-chip is-widened"
              >
                <UIcon :name="icons.globe" class="scope-chip-icon" aria-hidden="true" />
                <span>{{ label }}</span>
              </span>
              <span
                v-for="dev in sourceDeviceKeys"
                :key="`dev:${dev}`"
                class="scope-chip is-device"
              >
                <UIcon :name="icons.deviceDesktop" class="scope-chip-icon" aria-hidden="true" />
                <span>来源设备</span>
                <span class="font-mono">{{ dev }}</span>
              </span>
            </div>
          </div>
          <div v-if="effectiveDisclosure && (!isTidy || parts.disclosure)" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.trigger" class="scope-review-icon" aria-hidden="true" />
              <span>{{ isProposedDisclosureNew ? '建议召回时机' : '召回时机' }}</span>
            </span>
            <span class="scope-disclosure-text">{{ effectiveDisclosure }}</span>
          </div>
        </div>

        <p v-if="isTidy && hasContentChange && !parts.content" class="skip-content-note">
          已跳过正文改动
        </p>
        <DiffViewer
          v-else-if="effectiveProposedContent !== null && hasDiffChanges"
          :before="baseEntry?.content ?? ''"
          :after="effectiveProposedContent"
          :context="3"
          :expand-step="10"
          max-height="24rem"
        />
      </template>

      <!-- 归档说明折叠预览 -->
      <details
        v-if="hasArchivedNotes && (editing ? draft.applyArchivedNotes : !isTidy || parts.content)"
        class="archived-notes"
      >
        <summary class="archived-summary">
          <UIcon :name="icons.chevronRight" class="archived-chevron" aria-hidden="true" />
          <UIcon :name="icons.history" class="archived-icon" aria-hidden="true" />
          <span>将写入版本历史的归档说明（{{ suggestion.archivedNotes!.length }} 条）</span>
        </summary>
        <ul class="archived-list">
          <li v-for="(item, idx) in suggestion.archivedNotes" :key="idx">
            <span v-if="item.occurredAt" class="archived-date font-mono">
              {{ formatShort(item.occurredAt) }}
            </span>
            <WikiText :text="item.note" :titles="knownTitles" :mark-missing="false" compact />
          </li>
        </ul>
      </details>

      <!-- 单轮无状态按说明修订指令栏 -->
      <div v-if="showReviseBar" class="revise-bar">
        <div class="revise-bar-row">
          <UInput
            v-model="reviseInstruction"
            size="sm"
            :maxlength="REVISE_INSTRUCTION_MAX"
            :disabled="busy || disabled || reviseBusy"
            placeholder="输入一句修订说明，如：仅限家里 home-24 主机，收紧环境标签"
            aria-label="修订说明"
            class="revise-input"
            @keydown="onReviseKeydown"
          />
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.sparkles"
            :loading="reviseBusy"
            :disabled="busy || disabled || reviseBusy || !reviseInstruction.trim()"
            @click="submitRevise"
          >
            按说明修订
          </UButton>
        </div>
        <p v-if="reviseError" class="text-xs text-error" role="alert">{{ reviseError }}</p>
      </div>
    </section>

    <!-- 右栏 35%：整理依据、涉及记忆、护栏与操作 -->
    <aside class="inspector-side" aria-label="整理依据与护栏">
      <div class="side-block">
        <h3 class="side-heading">
          <UIcon :name="icons.lightbulb" class="side-heading-icon" aria-hidden="true" />
          <span>整理依据</span>
        </h3>
        <p class="side-reason">
          <WikiText :text="suggestion.reason" :titles="knownTitles" :mark-missing="false" compact />
        </p>
      </div>

      <div v-if="suggestion.entries.length" class="side-block">
        <h3 class="side-heading">
          <UIcon :name="icons.file" class="side-heading-icon" aria-hidden="true" />
          <span>涉及记忆</span>
        </h3>
        <ul class="involved-list">
          <li v-for="entry in suggestion.entries" :key="entry.id" class="involved-item">
            <RouterLink
              :to="entryRoute(entry.shortId)"
              class="text-primary font-medium"
              :title="`${entry.title}（${entry.shortId}）`"
            >
              {{ entry.title }}
            </RouterLink>
            <div class="involved-meta">
              <span class="text-xs text-muted">{{ entryKindLabels[entry.kind] }}</span>
              <span v-if="entry.deviceKey" class="keep-tag">
                <UIcon :name="icons.deviceDesktop" class="keep-tag-icon" aria-hidden="true" />
                <span class="font-mono">{{ entry.deviceKey }}</span>
              </span>
              <span v-if="entry.isPinned" class="keep-tag">
                <UIcon
                  :name="bootModeIcons[effectiveBootMode(entry)]"
                  class="keep-tag-icon"
                  aria-hidden="true"
                />
                <span>常驻</span>
              </span>
              <span v-if="entry.id === suggestion.keepId" class="keep-tag">
                <UIcon :name="icons.check" class="keep-tag-icon" aria-hidden="true" />
                <span>保留目标</span>
              </span>
              <span v-else-if="isMergeDuplicates" class="keep-tag">
                <UIcon :name="icons.merge" class="keep-tag-icon" aria-hidden="true" />
                <span>待并入</span>
              </span>
            </div>
          </li>
        </ul>
      </div>

      <!-- 合并重复时的全库反链自动重定向提示 -->
      <div
        v-if="isMergeDuplicates && (suggestion.affectedBacklinkCount ?? 0) > 0"
        class="side-block"
      >
        <NoteLine tone="warning" flush>
          另有
          {{ suggestion.affectedBacklinkCount }}
          条记忆引用了待合并记忆，应用合并时将自动将双链重定向至保留目标。
        </NoteLine>
      </div>

      <!-- 完整性护栏 / 改动影响 -->
      <div v-if="integrity || nonContentImpactNote" class="side-block">
        <h3 class="side-heading">
          <UIcon
            :name="hasLostRefs || integrity?.severeShrink ? icons.shieldAlert : icons.shieldCheck"
            class="side-heading-icon"
            aria-hidden="true"
          />
          <span>{{ integrity ? '完整性护栏' : '改动影响' }}</span>
        </h3>
        <div
          v-if="integrity"
          class="guard-strip is-inspector tabular-nums"
          :class="{
            'is-alert': hasLostRefs || (!isTidy && integrity.severeShrink),
            'is-warn': !hasLostRefs && isTidy && integrity.severeShrink,
          }"
        >
          <span class="guard-status">
            <UIcon
              :name="
                hasLostRefs
                  ? icons.shieldAlert
                  : integrity.severeShrink
                    ? icons.warning
                    : icons.check
              "
              class="guard-icon"
              aria-hidden="true"
            />
            <span>{{ integrityMessage }}</span>
          </span>
          <dl v-if="!showCompactGuardOnly" class="guard-dl">
            <template v-if="showLinksMetric">
              <dt>双链</dt>
              <dd>{{ integrity.linksBefore }} → {{ integrity.linksAfter }}</dd>
            </template>
            <template v-if="showCredsMetric">
              <dt>凭据占位符</dt>
              <dd>{{ integrity.credsBefore }} → {{ integrity.credsAfter }}</dd>
            </template>
            <template v-if="lengthDelta">
              <dt>篇幅</dt>
              <dd>
                {{ lengthDelta.before.toLocaleString() }} →
                {{ lengthDelta.after.toLocaleString() }} 字（{{ lengthDelta.deltaText }}）
              </dd>
            </template>
          </dl>
          <span v-else-if="lengthDelta" class="guard-meta">
            篇幅 {{ lengthDelta.before.toLocaleString() }} →
            {{ lengthDelta.after.toLocaleString() }} 字（{{ lengthDelta.deltaText }}）
          </span>
        </div>
        <p v-else-if="nonContentImpactNote" class="impact-note" :class="{ 'is-warn': isMarkStale }">
          <UIcon
            :name="isMarkStale ? icons.warning : icons.check"
            class="impact-icon"
            aria-hidden="true"
          />
          <span>{{ nonContentImpactNote }}</span>
        </p>
      </div>

      <footer v-if="!editing" class="side-actions">
        <UButton
          size="sm"
          :color="isMarkStale ? 'error' : 'primary'"
          :icon="primaryApplyIcon"
          :loading="busy"
          :disabled="disabled || reviseBusy || !anyPartSelected"
          @click="applyDirect"
        >
          {{ primaryApplyLabel }}
        </UButton>
        <UButton
          v-if="!isMarkStale && !isLinkEntries"
          size="sm"
          color="neutral"
          variant="outline"
          :icon="icons.edit"
          :disabled="busy || disabled || reviseBusy"
          @click="openEditor"
        >
          编辑后应用
        </UButton>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :icon="icons.cancel"
          :disabled="busy || disabled || reviseBusy"
          @click="emit('dismiss', suggestion.id)"
        >
          忽略
        </UButton>
      </footer>
    </aside>
  </div>

  <!-- 独立卡片态（用于单条深度查重抽屉等场景） -->
  <article v-else class="suggestion-card">
    <header class="card-head">
      <div class="card-head-main">
        <span class="kind-tag">
          <UIcon :name="dreamKindIcons[suggestion.kind]" class="kind-tag-icon" aria-hidden="true" />
          <span>{{ dreamKindLabels[suggestion.kind] }}</span>
        </span>
        <span
          class="card-target-title"
          :title="baseEntry ? `${displayTitle}（${baseEntry.shortId}）` : displayTitle"
        >
          {{ displayTitle }}
        </span>
        <span v-if="baseEntry?.isPinned" class="keep-tag">
          <UIcon
            :name="bootModeIcons[effectiveBootMode(baseEntry)]"
            class="keep-tag-icon"
            aria-hidden="true"
          />
          <span>常驻</span>
        </span>
      </div>
      <time
        class="text-xs text-muted"
        :datetime="suggestion.createdAt"
        :title="formatTime(suggestion.createdAt)"
      >
        {{ formatRelative(suggestion.createdAt) }}
      </time>
    </header>

    <!-- 唯一亮纸核心变更区 -->
    <div class="card-delta-surface">
      <div v-if="editing" class="edit-box">
        <div v-if="revisedReason" class="revise-preview-panel">
          <div class="revise-preview-head">
            <span class="revise-preview-lead">
              <UIcon :name="icons.sparkles" class="revise-preview-icon" aria-hidden="true" />
              <span>已按说明修订草稿</span>
            </span>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="showRevisedDiff ? icons.chevronUp : icons.compare"
              @click="showRevisedDiff = !showRevisedDiff"
            >
              {{ showRevisedDiff ? '收起对比' : '查看对比' }}
            </UButton>
          </div>
          <p class="revise-preview-reason">
            <WikiText :text="revisedReason" :titles="knownTitles" :mark-missing="false" compact />
          </p>
          <NoteLine v-if="hasLostRefs || integrity?.severeShrink" tone="warning" flush>
            {{ integrityMessage }}
          </NoteLine>
          <DiffViewer
            v-if="showRevisedDiff"
            :before="reviseDiffBefore"
            :after="draft.content"
            :context="3"
            :expand-step="10"
            max-height="16rem"
            empty-text="正文无变更，已更新草稿属性"
          />
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="标题">
            <template #label>
              <span class="field-label">
                <UIcon :name="icons.heading" class="field-label-icon" aria-hidden="true" />
                <span>标题</span>
              </span>
            </template>
            <UInput v-model="draft.title" :maxlength="ENTRY_TITLE_MAX" class="w-full" />
          </UFormField>
          <UFormField label="主题">
            <template #label>
              <span class="field-label">
                <UIcon :name="icons.topic" class="field-label-icon" aria-hidden="true" />
                <span>主题</span>
              </span>
            </template>
            <UInputTags
              v-model="draft.topics"
              add-on-blur
              placeholder="输入后回车"
              class="w-full"
            />
          </UFormField>
        </div>
        <UFormField label="现行概要（可选）">
          <template #label>
            <span class="field-label">
              <UIcon :name="icons.summary" class="field-label-icon" aria-hidden="true" />
              <span>现行概要（可选）</span>
            </span>
          </template>
          <UTextarea
            v-model="draft.summary"
            :rows="2"
            autoresize
            :maxrows="4"
            :maxlength="ENTRY_SUMMARY_MAX"
            class="w-full"
          />
        </UFormField>
        <NoteLine v-if="editSecretWarnings.length" tone="warning" flush>
          正文疑似包含{{
            editSecretWarnings.map((w) => w.label).join('、')
          }}，建议改存凭据并用占位符引用。
        </NoteLine>
        <UFormField label="正文">
          <template #label>
            <span class="field-label">
              <UIcon :name="icons.file" class="field-label-icon" aria-hidden="true" />
              <span>正文</span>
            </span>
          </template>
          <UTextarea v-model="draft.content" :rows="8" autoresize class="w-full font-mono" />
        </UFormField>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="召回时机（可选）">
            <UInput v-model="draft.disclosure" :maxlength="DISCLOSURE_MAX" class="w-full" />
          </UFormField>
          <UFormField label="变更说明（可选）">
            <UInput v-model="draft.changeSummary" :maxlength="CHANGE_SUMMARY_MAX" class="w-full" />
          </UFormField>
        </div>
        <UFormField label="适用场景">
          <SceneScopePicker v-model="draftScope" />
        </UFormField>
        <div class="flex flex-wrap items-center gap-6">
          <UFormField label="启动加载方式">
            <template #label>
              <span class="field-label">
                <UIcon :name="icons.pin" class="field-label-icon" aria-hidden="true" />
                <span>启动加载方式</span>
              </span>
            </template>
            <SegmentedChoice
              v-model="draft.bootMode"
              :items="bootModeChoices"
              label="选择启动加载方式"
              compact
            />
          </UFormField>
          <USwitch
            v-if="hasArchivedNotes"
            v-model="draft.applyArchivedNotes"
            label="将剥离的历史说明写入版本历史"
          />
        </div>
        <p v-if="editValidationProblem" class="text-xs text-error" role="alert">
          {{ editValidationProblem }}
        </p>
      </div>

      <template v-else>
        <!-- 合并结构 -->
        <div
          v-if="isMergeDuplicates && baseEntry && mergedSourceEntries.length"
          class="structure-strip"
        >
          <span class="strip-role">保留目标</span>
          <span class="strip-new" :title="`${baseEntry.title}（${baseEntry.shortId}）`">
            {{ baseEntry.title }}
          </span>
          <UIcon :name="icons.back" class="compare-arrow" aria-hidden="true" />
          <span class="strip-role">并入来源</span>
          <template v-for="(src, idx) in mergedSourceEntries" :key="src.id">
            <span v-if="idx > 0" class="text-muted">、</span>
            <span class="strip-old" :title="`${src.title}（${src.shortId}）`">
              {{ src.title }}
            </span>
          </template>
        </div>

        <!-- 启动加载前后对照 -->
        <div
          v-if="isAdjustBootMode && baseEntry && suggestion.proposedBootMode"
          class="title-compare"
        >
          <span class="compare-label">启动加载调整</span>
          <span class="compare-old compare-mode">
            <UIcon
              :name="bootModeIcons[currentBootMode]"
              class="compare-mode-icon"
              aria-hidden="true"
            />
            <span>{{ bootModeLabels[currentBootMode] }}</span>
          </span>
          <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
          <span class="compare-new compare-mode">
            <UIcon
              :name="bootModeIcons[suggestion.proposedBootMode]"
              class="compare-mode-icon"
              aria-hidden="true"
            />
            <span>{{ bootModeLabels[suggestion.proposedBootMode] }}</span>
          </span>
        </div>

        <!-- 补全双链清单 -->
        <div v-if="isLinkEntries && suggestion.proposedLinks?.length" class="card-links-wrap">
          <span class="sub-eyebrow">
            <UIcon :name="icons.links" class="sub-eyebrow-icon" aria-hidden="true" />
            <span>建议追加的双链</span>
          </span>
          <ul class="link-checklist">
            <li
              v-for="link in suggestion.proposedLinks"
              :key="link.targetShortId"
              class="link-check-item"
            >
              <div class="link-check-label">
                <input
                  type="checkbox"
                  class="square-check"
                  :aria-label="`选择关联「${link.targetTitle || link.targetShortId}」`"
                  :checked="selectedLinkShortIds.includes(link.targetShortId)"
                  :disabled="busy"
                  @change="toggleProposedLink(link.targetShortId)"
                />
                <span class="link-check-body">
                  <span class="link-check-top">
                    <RouterLink
                      :to="entryRoute(link.targetShortId)"
                      class="text-primary font-medium"
                      :title="
                        link.targetTitle
                          ? `${link.targetTitle}（${link.targetShortId}）`
                          : link.targetShortId
                      "
                    >
                      {{ link.targetTitle || link.targetShortId }}
                    </RouterLink>
                    <span v-if="link.relation" class="link-relation-tag">{{ link.relation }}</span>
                    <span v-if="link.anchorHeading" class="text-xs text-muted">
                      小节：{{ link.anchorHeading }}
                    </span>
                  </span>
                  <p v-if="link.reason" class="link-reason">
                    <WikiText
                      :text="link.reason"
                      :titles="knownTitles"
                      :mark-missing="false"
                      compact
                    />
                  </p>
                </span>
              </div>
            </li>
          </ul>
        </div>

        <!-- 规范与精简分项勾选 -->
        <div v-if="showPartialChecks" class="partial-row" role="group" aria-label="分项应用选择">
          <span class="partial-label">
            <UIcon :name="icons.listChecks" class="partial-label-icon" aria-hidden="true" />
            <span>分项应用</span>
          </span>
          <label v-if="hasTitleChange" class="part-check">
            <input v-model="parts.title" type="checkbox" class="square-check" :disabled="busy" />
            <span>规范标题</span>
          </label>
          <label v-if="hasSummaryChange" class="part-check">
            <input v-model="parts.summary" type="checkbox" class="square-check" :disabled="busy" />
            <span>更新现行概要</span>
          </label>
          <label v-if="hasTopicsChange" class="part-check">
            <input v-model="parts.topics" type="checkbox" class="square-check" :disabled="busy" />
            <span>收敛主题</span>
          </label>
          <label v-if="isProposedDisclosureNew" class="part-check">
            <input
              v-model="parts.disclosure"
              type="checkbox"
              class="square-check"
              :disabled="busy"
            />
            <span>更新召回时机</span>
          </label>
          <label v-if="hasContentChange || hasArchivedNotes" class="part-check">
            <input v-model="parts.content" type="checkbox" class="square-check" :disabled="busy" />
            <span>{{ hasArchivedNotes ? '精简正文并归档历史说明' : '精简正文' }}</span>
          </label>
        </div>

        <!-- 旧标题 → 新标题前后对照 -->
        <div v-if="hasTitleChange && baseEntry && (!isTidy || parts.title)" class="title-compare">
          <span class="compare-label">标题调整</span>
          <span class="compare-old">{{ baseEntry.title }}</span>
          <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
          <span class="compare-new">{{ suggestion.proposedTitle }}</span>
        </div>

        <div v-if="hasTopicsChange && baseEntry && (!isTidy || parts.topics)" class="title-compare">
          <span class="compare-label">主题收敛</span>
          <span class="compare-old">
            {{ baseEntry.topics.length ? baseEntry.topics.join('、') : '未设主题' }}
          </span>
          <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
          <span class="compare-new">
            {{ effectiveTopics.length ? effectiveTopics.join('、') : '清空主题' }}
          </span>
        </div>

        <!-- 建议现行概要预览 -->
        <div
          v-if="suggestion.proposedSummary?.trim() && (!isTidy || parts.summary)"
          class="summary-preview"
        >
          <span class="summary-preview-label">
            <UIcon :name="icons.summary" class="summary-preview-icon" aria-hidden="true" />
            <span>建议现行概要</span>
          </span>
          <p class="summary-preview-text">
            <WikiText
              :text="suggestion.proposedSummary ?? ''"
              :titles="knownTitles"
              :mark-missing="false"
              compact
            />
          </p>
        </div>

        <!-- 非编辑审阅态适用场景、来源设备与触发场景 -->
        <div v-if="showScopeReview" class="scope-review">
          <div class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.sliders" class="scope-review-icon" aria-hidden="true" />
              <span>将写入场景</span>
            </span>
            <div class="scope-review-chips">
              <template v-if="scopeTagGroups.length">
                <span v-for="group in scopeTagGroups" :key="group.key" class="scope-group">
                  <span class="scope-group-name">
                    <UIcon :name="group.icon" class="scope-chip-icon" aria-hidden="true" />
                    <span>{{ group.label }}</span>
                  </span>
                  <span v-for="val in group.items" :key="`${group.key}:${val}`" class="scope-chip">
                    {{ val }}
                  </span>
                </span>
              </template>
              <span v-else class="scope-chip is-universal">
                <UIcon :name="icons.globe" class="scope-chip-icon" aria-hidden="true" />
                <span>全局通用</span>
              </span>
              <span
                v-for="label in widenedScopeLabels"
                :key="`widen:${label}`"
                class="scope-chip is-widened"
              >
                <UIcon :name="icons.globe" class="scope-chip-icon" aria-hidden="true" />
                <span>{{ label }}</span>
              </span>
              <span
                v-for="dev in sourceDeviceKeys"
                :key="`dev:${dev}`"
                class="scope-chip is-device"
              >
                <UIcon :name="icons.deviceDesktop" class="scope-chip-icon" aria-hidden="true" />
                <span>来源设备</span>
                <span class="font-mono">{{ dev }}</span>
              </span>
            </div>
          </div>
          <div v-if="sourceEpisodeProvenance" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.history" class="scope-review-icon" aria-hidden="true" />
              <span>聚合来源</span>
            </span>
            <div class="scope-review-chips tabular-nums">
              <span class="scope-chip">
                来自 {{ sourceEpisodeProvenance.episodeCount }} 条会话摘要
              </span>
              <span v-if="sourceEpisodeProvenance.projects.length" class="scope-chip">
                涉及项目 {{ sourceEpisodeProvenance.projects.join('、') }}
              </span>
              <span v-if="sourceEpisodeProvenance.dateRange" class="scope-chip">
                {{ sourceEpisodeProvenance.dateRange }}
              </span>
            </div>
          </div>
          <div v-if="distillBootMode" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.pin" class="scope-review-icon" aria-hidden="true" />
              <span>建议启动加载</span>
            </span>
            <span class="scope-chip is-boot">
              <UIcon
                :name="bootModeIcons[distillBootMode]"
                class="scope-chip-icon"
                aria-hidden="true"
              />
              <span>{{ bootModeLabels[distillBootMode] }}</span>
            </span>
          </div>
          <div v-if="isDistillEpisode && effectiveTopics.length" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.topic" class="scope-review-icon" aria-hidden="true" />
              <span>主题</span>
            </span>
            <div class="scope-review-chips">
              <span v-for="tag in effectiveTopics" :key="`topic:${tag}`" class="scope-chip">
                {{ tag }}
              </span>
            </div>
          </div>
          <div v-if="effectiveDisclosure && (!isTidy || parts.disclosure)" class="scope-review-row">
            <span class="scope-review-label">
              <UIcon :name="icons.trigger" class="scope-review-icon" aria-hidden="true" />
              <span>{{ isProposedDisclosureNew ? '建议召回时机' : '召回时机' }}</span>
            </span>
            <span class="scope-disclosure-text">{{ effectiveDisclosure }}</span>
          </div>
        </div>

        <!-- 正文对比 / 预览 -->
        <p v-if="isTidy && hasContentChange && !parts.content" class="skip-content-note">
          已跳过正文改动
        </p>
        <DiffViewer
          v-else-if="effectiveProposedContent !== null && hasDiffChanges"
          :before="baseEntry?.content ?? ''"
          :after="effectiveProposedContent"
          :context="3"
          :expand-step="10"
          max-height="22rem"
        />
        <pre v-else-if="isDistillEpisode && suggestion.proposedContent" class="preview-box">{{
          suggestion.proposedContent
        }}</pre>
      </template>

      <details
        v-if="hasArchivedNotes && (editing ? draft.applyArchivedNotes : !isTidy || parts.content)"
        class="archived-notes"
      >
        <summary class="archived-summary">
          <UIcon :name="icons.chevronRight" class="archived-chevron" aria-hidden="true" />
          <UIcon :name="icons.history" class="archived-icon" aria-hidden="true" />
          <span>将写入版本历史的归档说明（{{ suggestion.archivedNotes!.length }} 条）</span>
        </summary>
        <ul class="archived-list">
          <li v-for="(item, idx) in suggestion.archivedNotes" :key="idx">
            <span v-if="item.occurredAt" class="archived-date font-mono">
              {{ formatShort(item.occurredAt) }}
            </span>
            <WikiText :text="item.note" :titles="knownTitles" :mark-missing="false" compact />
          </li>
        </ul>
      </details>

      <!-- 单轮无状态按说明修订指令栏 -->
      <div v-if="showReviseBar" class="revise-bar">
        <div class="revise-bar-row">
          <UInput
            v-model="reviseInstruction"
            size="sm"
            :maxlength="REVISE_INSTRUCTION_MAX"
            :disabled="busy || disabled || reviseBusy"
            placeholder="输入一句修订说明，如：仅限家里 home-24 主机，收紧环境标签"
            aria-label="修订说明"
            class="revise-input"
            @keydown="onReviseKeydown"
          />
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.sparkles"
            :loading="reviseBusy"
            :disabled="busy || disabled || reviseBusy || !reviseInstruction.trim()"
            @click="submitRevise"
          >
            按说明修订
          </UButton>
        </div>
        <p v-if="reviseError" class="text-xs text-error" role="alert">{{ reviseError }}</p>
      </div>
    </div>

    <!-- 弱化整理的 AI 理由行 -->
    <p class="card-reason">
      <span class="card-reason-prefix">
        <UIcon :name="icons.lightbulb" class="card-reason-icon" aria-hidden="true" />
        <span>整理依据：</span>
      </span>
      <WikiText :text="suggestion.reason" :titles="knownTitles" :mark-missing="false" compact />
    </p>

    <div v-if="suggestion.entries.length > 1" class="card-affected">
      <span class="sub-eyebrow">
        <UIcon :name="icons.file" class="sub-eyebrow-icon" aria-hidden="true" />
        <span>涉及记忆</span>
      </span>
      <ul class="card-affected-list">
        <li v-for="entry in suggestion.entries" :key="entry.id">
          <RouterLink
            :to="entryRoute(entry.shortId)"
            class="text-primary"
            :title="`${entry.title}（${entry.shortId}）`"
          >
            {{ entry.title }}
          </RouterLink>
          <span class="text-xs text-muted">{{ entryKindLabels[entry.kind] }}</span>
          <span v-if="entry.deviceKey" class="keep-tag">
            <UIcon :name="icons.deviceDesktop" class="keep-tag-icon" aria-hidden="true" />
            <span class="font-mono">{{ entry.deviceKey }}</span>
          </span>
          <span v-if="entry.isPinned" class="keep-tag">
            <UIcon
              :name="bootModeIcons[effectiveBootMode(entry)]"
              class="keep-tag-icon"
              aria-hidden="true"
            />
            <span>常驻</span>
          </span>
          <span v-if="entry.id === suggestion.keepId" class="keep-tag">
            <UIcon :name="icons.check" class="keep-tag-icon" aria-hidden="true" />
            <span>保留目标</span>
          </span>
          <span v-else-if="isMergeDuplicates" class="keep-tag">
            <UIcon :name="icons.merge" class="keep-tag-icon" aria-hidden="true" />
            <span>待并入</span>
          </span>
        </li>
      </ul>
    </div>

    <!-- 合并重复时的全库反链自动重定向提示 -->
    <NoteLine
      v-if="isMergeDuplicates && (suggestion.affectedBacklinkCount ?? 0) > 0"
      tone="warning"
      flush
    >
      另有
      {{ suggestion.affectedBacklinkCount }}
      条记忆引用了待合并记忆，应用合并时将自动将双链重定向至保留目标。
    </NoteLine>

    <!-- 完整性护栏条 -->
    <div
      v-if="integrity"
      class="guard-strip tabular-nums"
      :class="{
        'is-alert': hasLostRefs || (!isTidy && integrity.severeShrink),
        'is-warn': !hasLostRefs && isTidy && integrity.severeShrink,
      }"
    >
      <span class="guard-status">
        <UIcon
          :name="
            hasLostRefs ? icons.shieldAlert : integrity.severeShrink ? icons.warning : icons.check
          "
          class="guard-icon"
          aria-hidden="true"
        />
        {{ integrityMessage }}
      </span>
      <span v-if="showLinksMetric" class="guard-meta">
        双链 {{ integrity.linksBefore }} → {{ integrity.linksAfter }}
      </span>
      <span v-if="showCredsMetric" class="guard-meta">
        凭据占位符 {{ integrity.credsBefore }} → {{ integrity.credsAfter }}
      </span>
      <span v-if="lengthDelta" class="guard-meta">
        篇幅 {{ lengthDelta.before.toLocaleString() }} →
        {{ lengthDelta.after.toLocaleString() }} 字（{{ lengthDelta.deltaText }}）
      </span>
    </div>

    <footer class="card-actions">
      <template v-if="!editing">
        <UButton
          size="sm"
          :color="isMarkStale ? 'error' : 'primary'"
          :icon="primaryApplyIcon"
          :loading="busy"
          :disabled="disabled || reviseBusy || !anyPartSelected"
          @click="applyDirect"
        >
          {{ primaryApplyLabel }}
        </UButton>
        <UButton
          v-if="!isMarkStale && !isLinkEntries"
          size="sm"
          color="neutral"
          variant="outline"
          :icon="icons.edit"
          :disabled="busy || disabled || reviseBusy"
          @click="openEditor"
        >
          编辑后应用
        </UButton>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :icon="icons.cancel"
          :disabled="busy || disabled || reviseBusy"
          @click="emit('dismiss', suggestion.id)"
        >
          忽略
        </UButton>
      </template>
      <template v-else>
        <UButton
          size="sm"
          :icon="icons.check"
          :loading="busy"
          :disabled="disabled || reviseBusy || Boolean(editValidationProblem)"
          @click="applyEdited"
        >
          保存并应用
        </UButton>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :disabled="busy || disabled || reviseBusy"
          @click="closeEditor"
        >
          取消编辑
        </UButton>
      </template>
    </footer>
  </article>
</template>

<style scoped>
/* ---- 65% / 35% 纸墨审校面板 ---- */
.inspector-grid {
  display: grid;
  grid-template-columns: 65fr 35fr;
  background: var(--ui-bg);
}
.inspector-main {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 18px 22px 20px;
  border-right: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
}
.inspector-side {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 18px 20px 20px;
  background: var(--ui-bg);
}
.section-eyebrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.eyebrow-lead {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.eyebrow-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.eyebrow-sub {
  font-weight: 400;
}
.sub-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.sub-eyebrow-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}

/* 启动加载前后对比 */
.boot-transition {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: stretch;
  gap: 12px;
}
.boot-state-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.boot-state-col.is-target {
  border-color: var(--ui-rule);
  border-left: 3px solid var(--ui-warning);
  background: var(--ui-bg-bright);
}
.boot-state-kicker {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.boot-state-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 16px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.boot-state-icon {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--ui-text-muted);
}
.boot-state-col.is-target .boot-state-icon {
  color: var(--ui-warning);
}
.boot-state-detail {
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-toned);
}
.boot-arrow-mid {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ui-text-muted);
}
.transition-arrow {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
}

/* 概要对照与启动目录预览 */
.summary-change {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
}
.summary-diff-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.summary-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  font-size: 14px;
  line-height: 1.6;
}
.summary-tag {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.summary-old {
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.summary-new {
  padding: 6px 10px;
  border-left: 2px solid var(--ui-success);
  background: var(--ui-diff-add-bg);
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.index-preview-line {
  padding: 9px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  font-size: 14px;
  line-height: 1.6;
  color: var(--ui-text-toned);
  overflow-wrap: anywhere;
}
.index-preview-title {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}

/* 双链清单（铺在亮纸面，以细线分隔） */
.card-links-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.link-checklist {
  border-top: 1px solid var(--ui-border);
}
.link-check-item {
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-border);
}
.link-check-label {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.link-check-label .square-check {
  margin-top: 4px;
  cursor: pointer;
}
.link-check-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.link-check-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 14px;
}
.link-relation-tag {
  padding: 0 6px;
  border: 1px solid var(--ui-info);
  background: color-mix(in srgb, var(--ui-info) 8%, var(--ui-bg-bright));
  font-size: 12px;
  color: var(--ui-info);
}
.link-reason {
  font-size: 13px;
  line-height: 1.55;
  color: var(--ui-text-toned);
}
.link-write-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.link-preview-code {
  padding: 8px 10px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-diff-add-bg);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ui-text-highlighted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 合并与标题对照 */
.structure-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.55;
}
.strip-role {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.strip-role-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.strip-role-icon.is-danger {
  color: var(--ui-error);
}
.strip-old {
  color: var(--ui-text-muted);
  text-decoration: line-through;
  overflow-wrap: anywhere;
}
.strip-new {
  font-weight: 600;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}

.title-compare {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding: 8px 12px;
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
  font-size: 14px;
  line-height: 1.5;
}
.compare-label {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.compare-old {
  color: var(--ui-text-muted);
  text-decoration: line-through;
  overflow-wrap: anywhere;
}
.compare-mode {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.compare-mode-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.compare-arrow {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-dimmed);
}
.compare-new {
  font-weight: 600;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}

/* 规范与精简分项勾选 */
.partial-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 6px 0 10px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
}
.partial-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.partial-label-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.part-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-highlighted);
  cursor: pointer;
}
.square-check {
  flex: none;
  accent-color: var(--ui-primary);
  cursor: pointer;
}

.summary-preview {
  padding: 8px 12px;
  border-left: 2px solid var(--ui-success);
  background: var(--ui-diff-add-bg);
}
.summary-preview-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.summary-preview-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.summary-preview-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}

.scope-review {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.scope-review-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
  font-size: 13px;
  line-height: 1.55;
}
.scope-review-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.scope-review-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.scope-review-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
  flex: 1;
}
.scope-group {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.scope-group-name {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.scope-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-highlighted);
}
.scope-chip.is-universal {
  border-style: dashed;
  color: var(--ui-text-muted);
}
.scope-chip.is-device {
  border-color: var(--ui-info);
  background: color-mix(in srgb, var(--ui-info) 8%, var(--ui-bg-bright));
  color: var(--ui-info);
}
.scope-chip.is-widened {
  border-color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 10%, var(--ui-bg-bright));
  color: var(--ui-warning);
}
.scope-chip.is-boot {
  border-color: var(--ui-success);
  background: color-mix(in srgb, var(--ui-success) 10%, var(--ui-bg-bright));
  color: var(--ui-success);
}
.scope-chip-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.scope-disclosure-text {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  color: var(--ui-text);
  overflow-wrap: anywhere;
}

.skip-content-note {
  padding: 8px 12px;
  border: 1px dashed var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.preview-box {
  max-height: 22rem;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.edit-box {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.revise-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--ui-border);
}
.revise-bar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.revise-input {
  flex: 1 1 14rem;
  min-width: 0;
}
.revise-preview-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-accented);
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg);
}
.revise-preview-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.revise-preview-lead {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.revise-preview-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.revise-preview-reason {
  font-size: 13px;
  line-height: 1.55;
  color: var(--ui-text);
  overflow-wrap: anywhere;
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
.edit-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}

.archived-notes {
  border-top: 1px solid var(--ui-border);
  padding-top: 10px;
  font-size: 13px;
}
.archived-summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  list-style: none;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.archived-summary::-webkit-details-marker {
  display: none;
}
.archived-chevron,
.archived-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.archived-chevron {
  transition: transform 150ms ease;
}
.archived-notes[open] .archived-chevron {
  transform: rotate(90deg);
}
.archived-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.archived-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding-left: 10px;
  border-left: 2px solid var(--ui-border-accented);
  line-height: 1.55;
}
.archived-date {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted);
}

/* 右栏：依据、涉及记忆、护栏与动作 */
.side-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.side-block + .side-block {
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
}
.side-heading {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.side-heading-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.side-reason {
  font-size: 14px;
  line-height: 1.65;
  color: var(--ui-text);
  overflow-wrap: anywhere;
}
.involved-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.involved-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 14px;
}
.involved-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.keep-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-muted);
}
.keep-tag-icon {
  display: inline-block;
  flex: none;
  width: 11px;
  height: 11px;
}

/* 完整性护栏 */
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
.guard-strip.is-inspector {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 8px 10px;
  background: var(--ui-bg-bright);
}
.guard-status {
  display: inline-flex;
  align-items: flex-start;
  gap: 5px;
  font-weight: 500;
  color: var(--ui-success);
}
.guard-meta {
  color: var(--ui-text-muted);
}
.guard-dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  font-size: 12px;
}
.guard-dl dt {
  color: var(--ui-text-muted);
}
.guard-dl dd {
  text-align: right;
  color: var(--ui-text-highlighted);
}
.guard-strip.is-warn {
  border-color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 6%, var(--ui-bg));
}
.guard-strip.is-warn .guard-status {
  color: var(--ui-warning);
}
.guard-strip.is-alert {
  border-color: var(--ui-error);
  background: color-mix(in srgb, var(--ui-error) 6%, var(--ui-bg));
}
.guard-strip.is-alert .guard-status,
.guard-strip.is-alert .guard-meta,
.guard-strip.is-alert .guard-dl dd {
  color: var(--ui-error);
}
.guard-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}
.impact-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ui-text-toned);
}
.impact-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 3px;
  color: var(--ui-success);
}
.impact-note.is-warn .impact-icon {
  color: var(--ui-warning);
}

.side-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border-accented);
}

/* ---- 独立卡片态 ---- */
.suggestion-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 18px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.card-head-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.kind-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 6px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.kind-tag-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.card-target-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.card-delta-surface {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-bright);
}
.card-reason {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-toned);
  overflow-wrap: anywhere;
}
.card-reason-prefix {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  vertical-align: text-bottom;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.card-reason-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.card-affected {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
}
.card-affected-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.card-affected-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}

@media (max-width: 960px) {
  .inspector-grid {
    grid-template-columns: 1fr;
  }
  .inspector-main {
    padding: 14px 16px;
    border-right: 0;
    border-bottom: 1px solid var(--ui-border-accented);
  }
  .inspector-side {
    padding: 14px 16px;
  }
  .boot-transition {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .boot-arrow-mid {
    justify-content: flex-start;
    transform: rotate(90deg);
    width: 20px;
    height: 20px;
  }
  .summary-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
