<script setup lang="ts">
import {
  CHANGE_SUMMARY_MAX,
  ChangeSummary,
  checkCaptureIntegrity,
  DISCLOSURE_MAX,
  Disclosure,
  ENTRY_SUMMARY_MAX,
  ENTRY_TITLE_MAX,
  EntrySummary,
  EntryTitle,
  extractCredentialPlaceholders,
  extractTargetShortIds,
  type ApplySuggestionRequest,
  type CaptureIntegrity,
  type DreamSuggestionView,
} from '@kioku/contracts'
import { computed, reactive, ref, watch } from 'vue'

import { icons } from '../icons'
import { dreamKindLabels, entryKindLabels } from '../labels'
import { entryRoute } from '../routes'
import { detectSecretPrefixes } from '../secretHint'
import { formatRelative, formatShort, formatTime } from '../time'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'
import DiffViewer from './ui/DiffViewer.vue'
import NoteLine from './ui/NoteLine.vue'

const props = withDefaults(
  defineProps<{
    suggestion: DreamSuggestionView
    busy: boolean
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{
  apply: [id: string, body: ApplySuggestionRequest]
  dismiss: [id: string]
}>()

const editing = ref(false)

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

// 规范与精简建议的分项勾选状态
const parts = reactive({
  title: true,
  summary: true,
  content: true,
})

watch(
  () => props.suggestion.id,
  () => {
    parts.title = true
    parts.summary = true
    parts.content = true
    editing.value = false
  },
)

const isTidy = computed(() => props.suggestion.kind === 'tidy')

const hasTitleChange = computed(() => {
  if (props.suggestion.kind === 'distill_episode') return false
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
  isPinned: false,
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
  draft.isPinned = base?.isPinned ?? false
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
  if (s.kind === 'distill_episode' || s.kind === 'mark_stale') return null
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
    deltaText: `${sign}${Math.abs(pct)}%`,
  }
})

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

function applyDirect() {
  const s = props.suggestion
  const base = baseEntry.value
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
    isPinned: draft.isPinned,
  }
  emit('apply', props.suggestion.id, body)
}
</script>

<template>
  <article class="card">
    <header class="card-head">
      <div class="flex flex-wrap items-center gap-2">
        <span class="kind-tag">{{ dreamKindLabels[suggestion.kind] }}</span>
        <span v-if="!hasTitleChange && suggestion.proposedTitle" class="text-sm font-semibold">
          {{ suggestion.proposedTitle }}
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

    <!-- 置顶旧标题 → 新短标题前后对照 -->
    <div v-if="hasTitleChange && baseEntry" class="title-compare">
      <span class="compare-label">标题调整</span>
      <span class="compare-old">{{ baseEntry.title }}</span>
      <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
      <span class="compare-new">{{ suggestion.proposedTitle }}</span>
    </div>

    <p class="card-reason">{{ suggestion.reason }}</p>

    <div v-if="suggestion.entries.length" class="affected">
      <span class="affected-label">涉及记忆</span>
      <ul class="affected-list">
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

    <!-- 规范与精简分项勾选应用 -->
    <div
      v-if="!editing && showPartialChecks"
      class="partial-bar"
      role="group"
      aria-label="分项应用选择"
    >
      <span class="partial-label">勾选需要应用的改动</span>
      <div class="partial-checks">
        <label v-if="hasTitleChange" class="part-check">
          <input v-model="parts.title" type="checkbox" :disabled="busy" />
          <span>规范标题</span>
        </label>
        <label v-if="hasSummaryChange" class="part-check">
          <input v-model="parts.summary" type="checkbox" :disabled="busy" />
          <span>更新现行概要</span>
        </label>
        <label v-if="hasContentChange || hasArchivedNotes" class="part-check">
          <input v-model="parts.content" type="checkbox" :disabled="busy" />
          <span>{{ hasArchivedNotes ? '精简正文并归档历史说明' : '精简正文' }}</span>
        </label>
      </div>
    </div>

    <!-- 建议的现行概要预览 -->
    <div
      v-if="!editing && suggestion.proposedSummary?.trim() && (!isTidy || parts.summary)"
      class="summary-preview"
    >
      <span class="summary-preview-label">建议现行概要</span>
      <p class="summary-preview-text">{{ suggestion.proposedSummary }}</p>
    </div>

    <!-- 完整性护栏条：双链、凭据计数与篇幅变化 -->
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
      <span class="guard-meta">
        双链 {{ integrity.linksBefore }} → {{ integrity.linksAfter }}
      </span>
      <span class="guard-meta">
        凭据占位符 {{ integrity.credsBefore }} → {{ integrity.credsAfter }}
      </span>
      <span v-if="lengthDelta" class="guard-meta">
        篇幅 {{ lengthDelta.before.toLocaleString() }} →
        {{ lengthDelta.after.toLocaleString() }} 字（{{ lengthDelta.deltaText }}）
      </span>
    </div>

    <!-- 预览：统一 Git 风格对比器（单双栏、词级高亮、按需展开上下文） -->
    <template v-if="!editing">
      <p v-if="isTidy && hasContentChange && !parts.content" class="skip-content-note">
        已取消勾选正文改动，应用时将保留原正文与历史记录不变。
      </p>
      <DiffViewer
        v-else-if="effectiveProposedContent !== null && hasDiffChanges"
        :before="baseEntry?.content ?? ''"
        :after="effectiveProposedContent"
        :context="3"
        :expand-step="12"
        max-height="24rem"
      />
      <pre
        v-else-if="suggestion.kind === 'distill_episode' && suggestion.proposedContent"
        class="preview-box"
        >{{ suggestion.proposedContent }}</pre>
    </template>

    <!-- 编辑后应用 -->
    <div v-else class="edit-box">
      <div class="grid gap-3 sm:grid-cols-2">
        <UFormField label="标题">
          <UInput v-model="draft.title" :maxlength="ENTRY_TITLE_MAX" class="w-full" />
        </UFormField>
        <UFormField label="主题">
          <UInputTags v-model="draft.topics" add-on-blur placeholder="输入后回车" class="w-full" />
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
        <USwitch v-model="draft.isPinned" label="设为启动加载" />
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

    <!-- 可折叠预览将写入历史的 archivedNotes -->
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

    <p v-if="suggestion.kind !== 'distill_episode'" class="history-safety-note">
      原有完整内容保留在版本历史中，可随时恢复。
    </p>

    <footer class="card-actions">
      <template v-if="!editing">
        <UButton
          size="sm"
          :icon="icons.check"
          :loading="busy"
          :disabled="disabled || !anyPartSelected"
          @click="applyDirect"
        >
          {{ suggestion.kind === 'mark_stale' ? '确认移入回收站' : '应用' }}
        </UButton>
        <UButton
          v-if="suggestion.kind !== 'mark_stale'"
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
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
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
.kind-tag {
  padding: 1px 6px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  font-weight: 500;
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
.card-reason {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ui-text);
}
.affected {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-left: 2px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
}
.affected-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.affected-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.affected-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.keep-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.partial-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 13px;
}
.partial-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.partial-checks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}
.part-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-highlighted);
  cursor: pointer;
}
.part-check input[type='checkbox'] {
  accent-color: var(--ui-primary);
}
.summary-preview {
  padding: 8px 12px;
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.summary-preview-label {
  display: block;
  margin-bottom: 2px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.summary-preview-text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
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
.guard-strip.is-alert .guard-meta {
  color: var(--ui-error);
}
.guard-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
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
  background: var(--ui-bg-muted);
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
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.archived-notes {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 13px;
}
.archived-summary {
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.archived-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 10px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.archived-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  line-height: 1.55;
}
.archived-date {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.history-safety-note {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}
</style>
