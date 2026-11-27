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
  type ApplySuggestionRequest,
  type BootMode,
  type CaptureIntegrity,
  type DreamSuggestionView,
} from '@kioku/contracts'
import { computed, reactive, ref, watch } from 'vue'

import { icons } from '../icons'
import { bootModeDescriptions, bootModeLabels, dreamKindLabels, entryKindLabels } from '../labels'
import { entryRoute } from '../routes'
import { detectSecretPrefixes } from '../secretHint'
import { formatRelative, formatShort, formatTime } from '../time'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import DiffViewer from './ui/DiffViewer.vue'
import NoteLine from './ui/NoteLine.vue'

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

// 规范与精简建议的分项勾选状态
const parts = reactive({
  title: true,
  summary: true,
  content: true,
})

// 补全双链建议的逐条勾选列表
const selectedLinkShortIds = ref<string[]>([])

watch(
  () => props.suggestion.id,
  () => {
    parts.title = true
    parts.summary = true
    parts.content = true
    selectedLinkShortIds.value = (props.suggestion.proposedLinks ?? []).map((l) => l.targetShortId)
    editing.value = false
  },
  { immediate: true },
)

const isTidy = computed(() => props.suggestion.kind === 'tidy')
const isLinkEntries = computed(() => props.suggestion.kind === 'link_entries')
const isAdjustBootMode = computed(() => props.suggestion.kind === 'adjust_boot_mode')
const isMergeDuplicates = computed(() => props.suggestion.kind === 'merge_duplicates')
const isMarkStale = computed(() => props.suggestion.kind === 'mark_stale')
const isDistillEpisode = computed(() => props.suggestion.kind === 'distill_episode')
const bootModeChoices = BOOT_MODES.map((value) => ({ value, label: bootModeLabels[value] }))

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
      hasContentChange.value ||
      hasArchivedNotes.value),
)

const anyPartSelected = computed(() => {
  if (isLinkEntries.value) return selectedLinkShortIds.value.length > 0
  if (!showPartialChecks.value) return true
  return (
    (hasTitleChange.value && parts.title) ||
    (hasSummaryChange.value && parts.summary) ||
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
  draft.disclosure = s.proposedDisclosure ?? base?.disclosure ?? ''
  draft.changeSummary = s.proposedChangeSummary ?? ''
  draft.applyArchivedNotes = Boolean(s.archivedNotes?.length)
  draft.topics = [...(s.proposedTopics ?? base?.topics ?? [])]
  draft.bootMode = s.proposedBootMode ?? (base ? effectiveBootMode(base) : 'none')
  draftScope.value = {
    envs: [...(s.proposedEnvs ?? base?.envs ?? [])],
    realms: [...(s.proposedRealms ?? base?.realms ?? [])],
    projects: [...(s.proposedProjects ?? base?.projects ?? [])],
    runtimes: [...(s.proposedRuntimes ?? base?.runtimes ?? [])],
  }
  editing.value = true
}

const effectiveProposedContent = computed<string | null>(() => {
  const s = props.suggestion
  if (
    s.kind === 'distill_episode' ||
    s.kind === 'mark_stale' ||
    s.kind === 'link_entries' ||
    s.kind === 'adjust_boot_mode'
  ) {
    return null
  }
  if (editing.value) return draft.content
  if (isTidy.value && !parts.content) return null
  return s.proposedContent
})

const integrity = computed<CaptureIntegrity | null>(() => {
  const base = baseEntry.value
  const next = effectiveProposedContent.value
  if (!base || next === null) return null
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
    if (!check.success) return check.error.issues[0]?.message ?? '触发场景格式有误'
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

const deltaSectionTitle = computed(() => {
  if (editing.value) return '编辑后应用'
  if (isAdjustBootMode.value) return '启动加载变更'
  if (isLinkEntries.value) return '建议追加的双链'
  if (isMergeDuplicates.value) return '合并结构与正文变更对比'
  if (isTidy.value) return '规范与精简变更对比'
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
      (!(hasContentChange.value || hasArchivedNotes.value) || parts.content)
    if (!allChecked) {
      const applyTitle = hasTitleChange.value && parts.title && Boolean(s.proposedTitle?.trim())
      const applySummary = hasSummaryChange.value && parts.summary
      const applyContent = (hasContentChange.value || hasArchivedNotes.value) && parts.content
      let changeSummary: string | undefined
      if (applyContent && s.proposedChangeSummary?.trim()) {
        changeSummary = s.proposedChangeSummary.trim()
      } else {
        const appliedLabels: string[] = []
        if (applyTitle) appliedLabels.push('规范标题')
        if (applySummary) appliedLabels.push('更新现行概要')
        if (appliedLabels.length) changeSummary = appliedLabels.join('并')
      }
      const body: ApplySuggestionRequest = {
        title: applyTitle ? s.proposedTitle!.trim() : base.title,
        summary: applySummary ? s.proposedSummary?.trim() || null : (base.summary ?? null),
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
        <span>{{ deltaSectionTitle }}</span>
        <span v-if="editing" class="eyebrow-sub">修改仅对本次写入生效</span>
        <span v-else-if="isLinkEntries && suggestion.proposedLinks?.length" class="tabular-nums">
          已选 {{ selectedLinkShortIds.length }} / {{ suggestion.proposedLinks.length }} 条
        </span>
      </div>

      <!-- 编辑后应用表单（不用 form 标签防误回车提交） -->
      <div v-if="editing" class="edit-box">
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="标题">
            <UInput v-model="draft.title" :maxlength="ENTRY_TITLE_MAX" class="w-full" />
          </UFormField>
          <UFormField label="主题">
            <UInputTags
              v-model="draft.topics"
              add-on-blur
              placeholder="输入后回车"
              class="w-full"
            />
          </UFormField>
        </div>
        <UFormField label="现行概要（可选）">
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
          <UTextarea v-model="draft.content" :rows="8" autoresize class="w-full font-mono" />
        </UFormField>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="触发场景（可选）">
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
            :disabled="disabled || Boolean(editValidationProblem)"
            @click="applyEdited"
          >
            保存并应用
          </UButton>
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            :disabled="busy || disabled"
            @click="editing = false"
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
            <span class="boot-state-name">{{ bootModeLabels[currentBootMode] }}</span>
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
            <span class="boot-state-name">{{ bootModeLabels[suggestion.proposedBootMode] }}</span>
            <span class="boot-state-detail">
              {{ bootModeDescriptions[suggestion.proposedBootMode] }}
            </span>
          </div>
        </div>

        <div v-if="hasSummaryChange || suggestion.proposedSummary?.trim()" class="summary-change">
          <span class="sub-eyebrow">附带现行概要变更</span>
          <div class="summary-diff-grid">
            <div class="summary-row">
              <span class="summary-tag">原概要</span>
              <span class="summary-old">{{ baseEntry.summary?.trim() || '暂无' }}</span>
            </div>
            <div class="summary-row">
              <span class="summary-tag">建议概要</span>
              <span class="summary-new">{{ suggestion.proposedSummary }}</span>
            </div>
          </div>
        </div>

        <div v-if="suggestion.proposedBootMode === 'index'" class="summary-change">
          <span class="sub-eyebrow">启动目录条目预览</span>
          <div class="index-preview-line tabular-nums">
            <span class="font-mono text-xs text-muted">{{ baseEntry.shortId }}</span>
            <strong class="index-preview-title">{{ baseEntry.title }}</strong>
            <span>（{{ baseEntry.content.length.toLocaleString() }} 字）</span>
            <template v-if="indexPreviewSummary">：{{ indexPreviewSummary }}</template>
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
            <label class="link-check-label">
              <input
                type="checkbox"
                class="square-check"
                :checked="selectedLinkShortIds.includes(link.targetShortId)"
                :disabled="busy"
                @change="toggleProposedLink(link.targetShortId)"
              />
              <span class="link-check-body">
                <span class="link-check-top">
                  <RouterLink :to="entryRoute(link.targetShortId)" class="text-primary font-medium">
                    {{ link.targetTitle || link.targetShortId }}
                  </RouterLink>
                  <span class="font-mono text-xs text-muted">{{ link.targetShortId }}</span>
                  <span v-if="link.relation" class="link-relation-tag">{{ link.relation }}</span>
                  <span v-if="link.anchorHeading" class="text-xs text-muted">
                    小节：{{ link.anchorHeading }}
                  </span>
                </span>
                <p v-if="link.reason" class="link-reason">{{ link.reason }}</p>
              </span>
            </label>
          </li>
        </ul>

        <div class="link-write-preview">
          <span class="sub-eyebrow">写入预览</span>
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
          <span class="strip-new">{{ baseEntry.title }}</span>
          <span class="font-mono text-xs text-muted">{{ baseEntry.shortId }}</span>
          <span class="strip-arrow" aria-hidden="true">←</span>
          <span class="strip-role">并入来源</span>
          <template v-for="(src, idx) in mergedSourceEntries" :key="src.id">
            <span v-if="idx > 0" class="text-muted">、</span>
            <span class="strip-old">{{ src.title }}</span>
            <span class="font-mono text-xs text-muted">{{ src.shortId }}</span>
          </template>
        </div>

        <div v-if="hasTitleChange && baseEntry" class="title-compare">
          <span class="compare-label">合并后标题</span>
          <span class="compare-old">{{ baseEntry.title }}</span>
          <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
          <span class="compare-new">{{ suggestion.proposedTitle }}</span>
        </div>

        <div v-if="suggestion.proposedSummary?.trim()" class="summary-preview">
          <span class="summary-preview-label">建议现行概要</span>
          <p class="summary-preview-text">{{ suggestion.proposedSummary }}</p>
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
          <span class="summary-preview-label">建议现行概要</span>
          <p class="summary-preview-text">{{ suggestion.proposedSummary }}</p>
        </div>
        <pre v-if="suggestion.proposedContent" class="preview-box">{{
          suggestion.proposedContent
        }}</pre>
      </template>

      <!-- 标记过时记忆 -->
      <template v-else-if="isMarkStale">
        <div v-if="baseEntry" class="structure-strip tabular-nums">
          <span class="strip-role">待移入回收站</span>
          <span class="strip-new">{{ baseEntry.title }}</span>
          <span class="font-mono text-xs text-muted">{{ baseEntry.shortId }}</span>
          <span class="text-xs text-muted">{{ baseEntry.content.length.toLocaleString() }} 字</span>
          <span v-if="baseEntry.isPinned" class="keep-tag">
            {{ bootModeLabels[effectiveBootMode(baseEntry)] }}
          </span>
        </div>
        <pre v-if="baseEntry?.content" class="preview-box">{{ baseEntry.content }}</pre>
      </template>

      <!-- 规范与精简 / 更新记忆内容 -->
      <template v-else>
        <div v-if="showPartialChecks" class="partial-row" role="group" aria-label="分项应用选择">
          <span class="partial-label">分项应用</span>
          <label v-if="hasTitleChange" class="part-check">
            <input v-model="parts.title" type="checkbox" class="square-check" :disabled="busy" />
            <span>规范标题</span>
          </label>
          <label v-if="hasSummaryChange" class="part-check">
            <input v-model="parts.summary" type="checkbox" class="square-check" :disabled="busy" />
            <span>更新现行概要</span>
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

        <div
          v-if="suggestion.proposedSummary?.trim() && (!isTidy || parts.summary)"
          class="summary-preview"
        >
          <span class="summary-preview-label">建议现行概要</span>
          <p class="summary-preview-text">{{ suggestion.proposedSummary }}</p>
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
          将写入版本历史的归档说明（{{ suggestion.archivedNotes!.length }} 条）
        </summary>
        <ul class="archived-list">
          <li v-for="(item, idx) in suggestion.archivedNotes" :key="idx">
            <span v-if="item.occurredAt" class="archived-date font-mono">
              {{ formatShort(item.occurredAt) }}
            </span>
            <span>{{ item.note }}</span>
          </li>
        </ul>
      </details>
    </section>

    <!-- 右栏 35%：整理依据、涉及记忆、护栏与操作 -->
    <aside class="inspector-side" aria-label="整理依据与护栏">
      <div class="side-block">
        <h3 class="side-heading">整理依据</h3>
        <p class="side-reason">{{ suggestion.reason }}</p>
      </div>

      <div v-if="suggestion.entries.length" class="side-block">
        <h3 class="side-heading">涉及记忆</h3>
        <ul class="involved-list">
          <li v-for="entry in suggestion.entries" :key="entry.id" class="involved-item">
            <RouterLink :to="entryRoute(entry.shortId)" class="text-primary font-medium">
              {{ entry.title }}
            </RouterLink>
            <div class="involved-meta">
              <span class="font-mono text-xs text-muted">{{ entry.shortId }}</span>
              <span class="text-xs text-muted">{{ entryKindLabels[entry.kind] }}</span>
              <span v-if="entry.isPinned" class="keep-tag">常驻</span>
              <span v-if="entry.id === suggestion.keepId" class="keep-tag">保留目标</span>
              <span v-else-if="isMergeDuplicates" class="keep-tag">待并入</span>
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
          条记忆引用了待合并词条，应用合并时将自动将双链重定向至保留目标。
        </NoteLine>
      </div>

      <!-- 完整性护栏 / 改动影响 -->
      <div v-if="integrity || nonContentImpactNote" class="side-block">
        <h3 class="side-heading">{{ integrity ? '完整性护栏' : '改动影响' }}</h3>
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
              :name="hasLostRefs || integrity.severeShrink ? icons.warning : icons.check"
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
        <p v-else-if="nonContentImpactNote" class="impact-note">
          <UIcon :name="icons.check" class="impact-icon" aria-hidden="true" />
          <span>{{ nonContentImpactNote }}</span>
        </p>
      </div>

      <footer v-if="!editing" class="side-actions">
        <UButton
          size="sm"
          :color="isMarkStale ? 'error' : 'primary'"
          :icon="icons.check"
          :loading="busy"
          :disabled="disabled || !anyPartSelected"
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
          :disabled="busy || disabled"
          @click="openEditor"
        >
          编辑后应用
        </UButton>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :disabled="busy || disabled"
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
        <span class="kind-tag">{{ dreamKindLabels[suggestion.kind] }}</span>
        <span class="card-target-title">{{ displayTitle }}</span>
        <span v-if="baseEntry" class="font-mono text-xs text-muted">{{ baseEntry.shortId }}</span>
        <span v-if="baseEntry?.isPinned" class="keep-tag">常驻</span>
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
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="标题">
            <UInput v-model="draft.title" :maxlength="ENTRY_TITLE_MAX" class="w-full" />
          </UFormField>
          <UFormField label="主题">
            <UInputTags
              v-model="draft.topics"
              add-on-blur
              placeholder="输入后回车"
              class="w-full"
            />
          </UFormField>
        </div>
        <UFormField label="现行概要（可选）">
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
          <UTextarea v-model="draft.content" :rows="8" autoresize class="w-full font-mono" />
        </UFormField>
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="触发场景（可选）">
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
          <span class="strip-new">{{ baseEntry.title }}</span>
          <span class="font-mono text-xs text-muted">{{ baseEntry.shortId }}</span>
          <span class="strip-arrow" aria-hidden="true">←</span>
          <span class="strip-role">并入来源</span>
          <template v-for="(src, idx) in mergedSourceEntries" :key="src.id">
            <span v-if="idx > 0" class="text-muted">、</span>
            <span class="strip-old">{{ src.title }}</span>
            <span class="font-mono text-xs text-muted">{{ src.shortId }}</span>
          </template>
        </div>

        <!-- 启动加载前后对照 -->
        <div
          v-if="isAdjustBootMode && baseEntry && suggestion.proposedBootMode"
          class="title-compare"
        >
          <span class="compare-label">启动加载调整</span>
          <span class="compare-old">{{ bootModeLabels[currentBootMode] }}</span>
          <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
          <span class="compare-new">{{ bootModeLabels[suggestion.proposedBootMode] }}</span>
        </div>

        <!-- 补全双链清单 -->
        <div v-if="isLinkEntries && suggestion.proposedLinks?.length" class="card-links-wrap">
          <span class="sub-eyebrow">建议追加的双链</span>
          <ul class="link-checklist">
            <li
              v-for="link in suggestion.proposedLinks"
              :key="link.targetShortId"
              class="link-check-item"
            >
              <label class="link-check-label">
                <input
                  type="checkbox"
                  class="square-check"
                  :checked="selectedLinkShortIds.includes(link.targetShortId)"
                  :disabled="busy"
                  @change="toggleProposedLink(link.targetShortId)"
                />
                <span class="link-check-body">
                  <span class="link-check-top">
                    <RouterLink
                      :to="entryRoute(link.targetShortId)"
                      class="text-primary font-medium"
                    >
                      {{ link.targetTitle || link.targetShortId }}
                    </RouterLink>
                    <span class="font-mono text-xs text-muted">{{ link.targetShortId }}</span>
                    <span v-if="link.relation" class="link-relation-tag">{{ link.relation }}</span>
                    <span v-if="link.anchorHeading" class="text-xs text-muted">
                      小节：{{ link.anchorHeading }}
                    </span>
                  </span>
                  <p v-if="link.reason" class="link-reason">{{ link.reason }}</p>
                </span>
              </label>
            </li>
          </ul>
        </div>

        <!-- 规范与精简分项勾选 -->
        <div v-if="showPartialChecks" class="partial-row" role="group" aria-label="分项应用选择">
          <span class="partial-label">分项应用</span>
          <label v-if="hasTitleChange" class="part-check">
            <input v-model="parts.title" type="checkbox" class="square-check" :disabled="busy" />
            <span>规范标题</span>
          </label>
          <label v-if="hasSummaryChange" class="part-check">
            <input v-model="parts.summary" type="checkbox" class="square-check" :disabled="busy" />
            <span>更新现行概要</span>
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

        <!-- 建议现行概要预览 -->
        <div
          v-if="suggestion.proposedSummary?.trim() && (!isTidy || parts.summary)"
          class="summary-preview"
        >
          <span class="summary-preview-label">建议现行概要</span>
          <p class="summary-preview-text">{{ suggestion.proposedSummary }}</p>
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
          将写入版本历史的归档说明（{{ suggestion.archivedNotes!.length }} 条）
        </summary>
        <ul class="archived-list">
          <li v-for="(item, idx) in suggestion.archivedNotes" :key="idx">
            <span v-if="item.occurredAt" class="archived-date font-mono">
              {{ formatShort(item.occurredAt) }}
            </span>
            <span>{{ item.note }}</span>
          </li>
        </ul>
      </details>
    </div>

    <!-- 弱化整理的 AI 理由行 -->
    <p class="card-reason">
      <span class="card-reason-prefix">整理依据：</span>{{ suggestion.reason }}
    </p>

    <div v-if="suggestion.entries.length > 1" class="card-affected">
      <span class="sub-eyebrow">涉及记忆</span>
      <ul class="card-affected-list">
        <li v-for="entry in suggestion.entries" :key="entry.id">
          <RouterLink :to="entryRoute(entry.shortId)" class="text-primary">
            {{ entry.title }}
          </RouterLink>
          <span class="font-mono text-xs text-muted">{{ entry.shortId }}</span>
          <span class="text-xs text-muted">{{ entryKindLabels[entry.kind] }}</span>
          <span v-if="entry.isPinned" class="keep-tag">常驻</span>
          <span v-if="entry.id === suggestion.keepId" class="keep-tag">保留目标</span>
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
      条记忆引用了待合并词条，应用合并时将自动将双链重定向至保留目标。
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
          :name="hasLostRefs || integrity.severeShrink ? icons.warning : icons.check"
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
          :icon="icons.check"
          :loading="busy"
          :disabled="disabled || !anyPartSelected"
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
          :disabled="busy || disabled"
          @click="openEditor"
        >
          编辑后应用
        </UButton>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :disabled="busy || disabled"
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
          :disabled="disabled || Boolean(editValidationProblem)"
          @click="applyEdited"
        >
          保存并应用
        </UButton>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :disabled="busy || disabled"
          @click="editing = false"
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
.eyebrow-sub {
  font-weight: 400;
}
.sub-eyebrow {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
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
  font-size: 16px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
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
  margin-left: 8px;
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
  cursor: pointer;
}
.link-check-label .square-check {
  margin-top: 4px;
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
  align-items: baseline;
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
  align-items: baseline;
  gap: 6px 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.55;
}
.strip-role {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
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
.strip-arrow {
  color: var(--ui-text-muted);
  user-select: none;
}

.title-compare {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
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
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
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
  display: block;
  margin-bottom: 2px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.summary-preview-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ui-text-highlighted);
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
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-toned);
  cursor: pointer;
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
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
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
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-muted);
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
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.card-head-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.kind-tag {
  padding: 1px 6px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
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
  font-weight: 600;
  color: var(--ui-text-muted);
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
  align-items: baseline;
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
