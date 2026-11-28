<script lang="ts">
import type { DreamSuggestionView } from '@kioku/contracts'

export type SingleOrganizeMode = 'tidy' | 'cross_check'

// 将单条查重与关联结果按是否直接涉及当前记忆拆分，便于把连带发现的关联记忆修订单独分组呈现
export function partitionCrossSuggestions(
  suggestions: readonly DreamSuggestionView[],
  anchorShortId: string,
): {
  direct: DreamSuggestionView[]
  related: DreamSuggestionView[]
} {
  const direct: DreamSuggestionView[] = []
  const related: DreamSuggestionView[] = []
  for (const item of suggestions) {
    if (item.entries.some((e) => e.shortId === anchorShortId)) {
      direct.push(item)
    } else {
      related.push(item)
    }
  }
  return { direct, related }
}
</script>

<script setup lang="ts">
import {
  normalizeSlugList,
  type ApplySuggestionRequest,
  type EntryDetailResponse,
  type SingleCrossCheckResponse,
  type SingleTidyPreviewResponse,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { hygieneFixIcons, hygieneFixLabels } from '../labels'
import { formatShort } from '../time'
import DreamSuggestionCard from './DreamSuggestionCard.vue'
import DiffViewer from './ui/DiffViewer.vue'
import EmptyState from './ui/EmptyState.vue'
import NoteLine from './ui/NoteLine.vue'
import SectionHeading from './ui/SectionHeading.vue'

const props = defineProps<{
  shortId: string
  entryTitle: string
  mode: SingleOrganizeMode
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  applied: [detail: EntryDetailResponse]
  staged: []
  edit: []
}>()

function openEditorForSecrets() {
  open.value = false
  emit('edit')
}

const toast = useToast()
const queryClient = useQueryClient()

const loading = ref(false)
const stageMessage = ref('')
const error = ref<string | null>(null)
const tidyResult = ref<SingleTidyPreviewResponse | null>(null)
const crossResult = ref<SingleCrossCheckResponse | null>(null)
const applying = ref(false)
const staging = ref(false)
const cardBusyId = ref<string | null>(null)

const parts = reactive({
  title: true,
  summary: true,
  topics: true,
  disclosure: true,
  content: true,
  archivedNotes: true,
})

let controller: AbortController | null = null

function abortInFlight() {
  if (controller) {
    controller.abort()
    controller = null
  }
}

function resetState() {
  error.value = null
  tidyResult.value = null
  crossResult.value = null
  stageMessage.value = ''
  parts.title = true
  parts.summary = true
  parts.topics = true
  parts.disclosure = true
  parts.content = true
  parts.archivedNotes = true
}

async function runAction() {
  abortInFlight()
  resetState()
  loading.value = true
  controller = new AbortController()
  const signal = controller.signal

  try {
    if (props.mode === 'tidy') {
      stageMessage.value = '正在准备规范整理…'
      const res = await api.previewSingleTidy(props.shortId, {
        signal,
        onStage: (_stage, msg) => {
          stageMessage.value = msg
        },
      })
      if (!signal.aborted) {
        tidyResult.value = res
        if (!res.needed) {
          void queryClient.invalidateQueries({ queryKey: ['inbox'] })
        }
      }
    } else {
      stageMessage.value = '正在检索相似记忆、双链邻居与断链并交由模型核查…'
      const res = await api.crossCheckEntry(props.shortId, signal)
      if (!signal.aborted) {
        crossResult.value = res
        const touchedShortIds = new Set<string>([
          props.shortId,
          ...res.suggestions.flatMap((s) => s.entries.map((e) => e.shortId)),
        ])
        void queryClient.invalidateQueries({ queryKey: ['inbox'] })
        for (const sid of touchedShortIds) {
          void queryClient.invalidateQueries({ queryKey: ['entry', sid] })
        }
      }
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return
    error.value = err instanceof ApiError ? err.message : '执行整理失败，请稍后重试'
  } finally {
    if (controller?.signal === signal) {
      controller = null
      loading.value = false
    }
  }
}

watch(
  [open, () => props.shortId, () => props.mode],
  ([isOpen]) => {
    if (isOpen) {
      void runAction()
    } else {
      abortInFlight()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => abortInFlight())

function cancelRun() {
  abortInFlight()
  loading.value = false
  open.value = false
}

const hasTitleChange = computed(
  () =>
    Boolean(tidyResult.value) &&
    tidyResult.value!.proposed.title !== tidyResult.value!.before.title,
)
const hasSummaryChange = computed(
  () =>
    Boolean(tidyResult.value) &&
    (tidyResult.value!.proposed.summary ?? '') !== (tidyResult.value!.before.summary ?? ''),
)
const hasTopicsChange = computed(() => {
  if (!tidyResult.value) return false
  const before = normalizeSlugList(tidyResult.value.before.topics)
  const proposed = normalizeSlugList(tidyResult.value.proposed.topics)
  return before.length !== proposed.length || before.some((v, i) => v !== proposed[i])
})
const hasDisclosureChange = computed(
  () =>
    Boolean(tidyResult.value) &&
    (tidyResult.value!.proposed.disclosure?.trim() ?? '') !==
      (tidyResult.value!.before.disclosure?.trim() ?? ''),
)
const hasContentChange = computed(
  () =>
    Boolean(tidyResult.value) &&
    tidyResult.value!.proposed.content !== tidyResult.value!.before.content,
)
const hasArchivedNotes = computed(() => Boolean(tidyResult.value?.proposed.archivedNotes.length))

const anySelected = computed(
  () =>
    (hasTitleChange.value && parts.title) ||
    (hasSummaryChange.value && parts.summary) ||
    (hasTopicsChange.value && parts.topics) ||
    (hasDisclosureChange.value && parts.disclosure) ||
    (hasContentChange.value && parts.content) ||
    (hasArchivedNotes.value && parts.content && parts.archivedNotes),
)

const lengthDelta = computed(() => {
  const res = tidyResult.value
  if (!res) return null
  const before = res.before.content.length
  const after = parts.content ? res.proposed.content.length : before
  const diff = after - before
  const pct = before > 0 ? Math.round((diff / before) * 100) : 0
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
  return { before, after, text: `${sign}${Math.abs(pct)}%` }
})

const hasMissingRefs = computed(() =>
  Boolean(
    tidyResult.value &&
    (tidyResult.value.integrity.missingLinks.length > 0 ||
      tidyResult.value.integrity.missingCreds.length > 0),
  ),
)

const isGuardNormal = computed(() =>
  Boolean(
    tidyResult.value &&
    tidyResult.value.integrity.intact &&
    !tidyResult.value.integrity.severeShrink &&
    !hasMissingRefs.value,
  ),
)

const showLinksMeta = computed(() =>
  Boolean(
    tidyResult.value &&
    (!isGuardNormal.value ||
      tidyResult.value.integrity.linksBefore > 0 ||
      tidyResult.value.integrity.linksAfter > 0),
  ),
)

const showCredsMeta = computed(() =>
  Boolean(
    tidyResult.value &&
    (!isGuardNormal.value ||
      tidyResult.value.integrity.credsBefore > 0 ||
      tidyResult.value.integrity.credsAfter > 0),
  ),
)

async function submitSingleTidy(stageToInbox: boolean) {
  const res = tidyResult.value
  if (!res || applying.value || staging.value || !anySelected.value) return
  if (stageToInbox) staging.value = true
  else applying.value = true
  error.value = null
  try {
    const applyTitle = hasTitleChange.value && parts.title
    const applySummary = hasSummaryChange.value && parts.summary
    const applyTopics = hasTopicsChange.value && parts.topics
    const applyDisclosure = hasDisclosureChange.value && parts.disclosure
    const applyContent = hasContentChange.value && parts.content
    const nextTitle = applyTitle ? res.proposed.title : res.before.title
    const nextSummary = applySummary ? res.proposed.summary : res.before.summary
    const nextContent = applyContent ? res.proposed.content : res.before.content
    const applyArchived = parts.content && parts.archivedNotes && hasArchivedNotes.value
    const effectiveChangeSummary = applyContent
      ? res.proposed.changeSummary || '主动规范标题与结构'
      : [
          applyTitle ? '规范标题' : '',
          applySummary ? '更新现行概要' : '',
          applyTopics ? '收敛主题' : '',
          applyDisclosure ? '更新召回时机' : '',
        ]
          .filter(Boolean)
          .join('并') || '主动规范记忆'
    const out = await api.applySingleTidy(props.shortId, {
      expectedVersion: res.baseVersion,
      title: nextTitle,
      summary: nextSummary,
      content: nextContent,
      ...(applyTopics ? { topics: res.proposed.topics } : {}),
      ...(applyDisclosure ? { disclosure: res.proposed.disclosure } : {}),
      changeSummary: effectiveChangeSummary,
      archivedNotes: applyArchived ? res.proposed.archivedNotes : [],
      applyArchivedNotes: applyArchived,
      stageToInbox,
      reason: res.reason,
      ...(res.secretWarnings?.length ? { secretWarnings: res.secretWarnings } : {}),
    })
    if (stageToInbox) {
      toast.add({ title: '已暂存至整理，可稍后统一确认', color: 'success' })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox'] }),
        queryClient.invalidateQueries({ queryKey: ['entry', props.shortId] }),
      ])
      emit('staged')
      open.value = false
    } else if (out.entry) {
      toast.add({ title: '已应用规范整理', color: 'success' })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['entries'] }),
        queryClient.invalidateQueries({ queryKey: ['entry-history', props.shortId] }),
        queryClient.invalidateQueries({ queryKey: ['inbox'] }),
        queryClient.invalidateQueries({ queryKey: ['boot-preview'] }),
      ])
      emit('applied', out.entry)
      open.value = false
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '应用失败，请重试'
  } finally {
    applying.value = false
    staging.value = false
  }
}

async function onApplyCrossSuggestion(id: string, body: ApplySuggestionRequest) {
  if (cardBusyId.value) return
  const suggestion = crossResult.value?.suggestions.find((s) => s.id === id)
  cardBusyId.value = id
  try {
    const res = await api.applySuggestion(id, body)
    const redirectSuffix = res.redirectedBacklinkCount
      ? `，并自动重定向 ${res.redirectedBacklinkCount} 条反链`
      : ''
    toast.add({
      title: res.entry
        ? `已应用到「${res.entry.title}」${redirectSuffix}`
        : `已应用建议${redirectSuffix}`,
      color: 'success',
    })
    if (crossResult.value) {
      crossResult.value = {
        ...crossResult.value,
        suggestions: crossResult.value.suggestions.filter((s) => s.id !== id),
      }
    }
    const affectedShortIds = new Set<string>([
      props.shortId,
      ...(res.entry ? [res.entry.shortId] : []),
      ...(suggestion?.entries.map((e) => e.shortId) ?? []),
      ...(suggestion?.proposedLinks?.map((l) => l.targetShortId) ?? []),
    ])
    const redirectedAny = (res.redirectedBacklinkCount ?? 0) > 0
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      queryClient.invalidateQueries({ queryKey: ['boot-preview'] }),
      ...(redirectedAny
        ? [
            queryClient.invalidateQueries({ queryKey: ['entry'] }),
            queryClient.invalidateQueries({ queryKey: ['entry-history'] }),
          ]
        : [...affectedShortIds].flatMap((sid) => [
            queryClient.invalidateQueries({ queryKey: ['entry', sid] }),
            queryClient.invalidateQueries({ queryKey: ['entry-history', sid] }),
          ])),
    ])
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '应用失败', color: 'error' })
  } finally {
    cardBusyId.value = null
  }
}

const crossSuggestionGroups = computed(() =>
  partitionCrossSuggestions(crossResult.value?.suggestions ?? [], props.shortId),
)
const directCrossSuggestions = computed(() => crossSuggestionGroups.value.direct)
const relatedCrossSuggestions = computed(() => crossSuggestionGroups.value.related)

async function onDismissCrossSuggestion(id: string) {
  if (cardBusyId.value) return
  const suggestion = crossResult.value?.suggestions.find((s) => s.id === id)
  cardBusyId.value = id
  try {
    await api.dismissSuggestion(id)
    toast.add({ title: '已忽略建议', color: 'neutral' })
    if (crossResult.value) {
      crossResult.value = {
        ...crossResult.value,
        suggestions: crossResult.value.suggestions.filter((s) => s.id !== id),
      }
    }
    const affectedShortIds = new Set<string>([
      props.shortId,
      ...(suggestion?.entries.map((e) => e.shortId) ?? []),
    ])
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      queryClient.invalidateQueries({ queryKey: ['boot-preview'] }),
      ...[...affectedShortIds].flatMap((sid) => [
        queryClient.invalidateQueries({ queryKey: ['entry', sid] }),
        queryClient.invalidateQueries({ queryKey: ['entry-history', sid] }),
      ]),
    ])
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '忽略失败', color: 'error' })
  } finally {
    cardBusyId.value = null
  }
}

const drawerTitle = computed(() => (props.mode === 'tidy' ? '规范此条记忆' : '查重与关联'))
const drawerDescription = computed(() =>
  props.mode === 'tidy'
    ? `对「${props.entryTitle}」执行结构检查与单条规范重构，确认后才写入记忆`
    : `以「${props.entryTitle}」为锚点检视相似重复、事实冲突与缺失双链`,
)
</script>

<template>
  <USlideover
    :open="open"
    side="right"
    :title="drawerTitle"
    :description="drawerDescription"
    :dismissible="!applying && !staging"
    :close="!applying && !staging"
    :ui="{ content: 'w-[min(94vw,960px)] max-w-[960px] sm:max-w-[960px] ring-2 ring-rule' }"
    @update:open="(v) => !applying && !staging && (open = v)"
  >
    <template #body>
      <div class="drawer-body">
        <div v-if="loading" class="progress-panel" role="status" aria-live="polite">
          <div class="progress-head">
            <span class="progress-title">
              <UIcon
                :name="mode === 'tidy' ? icons.tidy : icons.links"
                class="progress-icon"
                aria-hidden="true"
              />
              <span>{{ stageMessage || '正在执行整理…' }}</span>
            </span>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.cancel"
              @click="cancelRun"
            >
              取消
            </UButton>
          </div>
          <USkeleton class="h-10 w-full" />
          <USkeleton class="h-44 w-full" />
        </div>

        <NoteLine v-else-if="error" tone="error">
          {{ error }}
          <template #actions>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.refresh"
              @click="runAction"
            >
              重试
            </UButton>
          </template>
        </NoteLine>

        <!-- 模式 1：单条快速规范 -->
        <template v-else-if="mode === 'tidy' && tidyResult">
          <NoteLine
            v-if="tidyResult.secretWarnings?.length"
            tone="warning"
            flush
            :icon="icons.shieldAlert"
          >
            检测到
            {{ tidyResult.secretWarnings.length }} 处疑似明文凭据，建议改存托管凭据并用占位符替换。
            <template #detail>
              <span class="secret-warn-list">
                <span
                  v-for="(w, idx) in tidyResult.secretWarnings"
                  :key="idx"
                  class="secret-warn-item"
                >
                  <span class="secret-warn-label">{{ w.label }}</span>
                  <span v-if="w.location" class="secret-warn-loc">{{ w.location }}</span>
                  <code v-if="w.maskedSnippet" class="secret-warn-code font-mono">
                    {{ w.maskedSnippet }}
                  </code>
                </span>
              </span>
            </template>
            <template #actions>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.edit"
                @click="openEditorForSecrets"
              >
                前往编辑并转存
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="icons.credentials"
                :to="{ name: 'credentials', query: { new: '1' } }"
                @click="open = false"
              >
                新建凭据
              </UButton>
            </template>
          </NoteLine>

          <EmptyState
            v-if="!tidyResult.needed"
            :icon="icons.shieldCheck"
            tone="success"
            title="当前记忆结构良好"
            :description="tidyResult.reason"
          />

          <template v-else>
            <p class="reason-line">{{ tidyResult.reason }}</p>

            <div v-if="tidyResult.preCleanedFixes.length" class="fix-strip">
              <span class="strip-label">
                <UIcon :name="icons.shieldCheck" class="strip-label-icon" aria-hidden="true" />
                <span>已同步自动修复</span>
              </span>
              <span v-for="fix in tidyResult.preCleanedFixes" :key="fix" class="fix-pill">
                <UIcon :name="hygieneFixIcons[fix]" class="fix-pill-icon" aria-hidden="true" />
                <span>{{ hygieneFixLabels[fix] }}</span>
              </span>
            </div>

            <div class="partial-bar" role="group" aria-label="选择要应用的规范改动">
              <span class="strip-label">
                <UIcon :name="icons.listChecks" class="strip-label-icon" aria-hidden="true" />
                <span>勾选需要应用的改动</span>
              </span>
              <div class="partial-checks">
                <label v-if="hasTitleChange" class="part-check">
                  <input v-model="parts.title" type="checkbox" :disabled="applying || staging" />
                  <span>规范标题</span>
                </label>
                <label v-if="hasSummaryChange" class="part-check">
                  <input v-model="parts.summary" type="checkbox" :disabled="applying || staging" />
                  <span>更新现行概要</span>
                </label>
                <label v-if="hasTopicsChange" class="part-check">
                  <input v-model="parts.topics" type="checkbox" :disabled="applying || staging" />
                  <span>收敛主题</span>
                </label>
                <label v-if="hasDisclosureChange" class="part-check">
                  <input
                    v-model="parts.disclosure"
                    type="checkbox"
                    :disabled="applying || staging"
                  />
                  <span>更新召回时机</span>
                </label>
                <label v-if="hasContentChange" class="part-check">
                  <input v-model="parts.content" type="checkbox" :disabled="applying || staging" />
                  <span>规范正文</span>
                </label>
                <label v-if="hasArchivedNotes && parts.content" class="part-check">
                  <input
                    v-model="parts.archivedNotes"
                    type="checkbox"
                    :disabled="applying || staging"
                  />
                  <span
                    >将剥离的
                    {{ tidyResult.proposed.archivedNotes.length }} 条历史说明记入版本历史</span
                  >
                </label>
              </div>
            </div>

            <div v-if="hasTitleChange && parts.title" class="title-compare">
              <span class="strip-label">标题调整</span>
              <span class="compare-old">{{ tidyResult.before.title }}</span>
              <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
              <span class="compare-new">{{ tidyResult.proposed.title }}</span>
            </div>

            <div
              v-if="hasSummaryChange && parts.summary && tidyResult.proposed.summary"
              class="summary-box"
            >
              <span class="strip-label">
                <UIcon :name="icons.summary" class="strip-label-icon" aria-hidden="true" />
                <span>建议现行概要</span>
              </span>
              <p class="summary-text">{{ tidyResult.proposed.summary }}</p>
            </div>

            <div v-if="hasTopicsChange && parts.topics" class="title-compare">
              <span class="strip-label">
                <UIcon :name="icons.topic" class="strip-label-icon" aria-hidden="true" />
                <span>主题收敛</span>
              </span>
              <span class="compare-old">
                {{
                  tidyResult.before.topics.length ? tidyResult.before.topics.join('、') : '未设主题'
                }}
              </span>
              <UIcon :name="icons.inherits" class="compare-arrow" aria-hidden="true" />
              <span class="compare-new">
                {{
                  tidyResult.proposed.topics.length
                    ? tidyResult.proposed.topics.join('、')
                    : '清空主题'
                }}
              </span>
            </div>

            <div
              v-if="hasDisclosureChange && parts.disclosure && tidyResult.proposed.disclosure"
              class="summary-box"
            >
              <span class="strip-label">
                <UIcon :name="icons.trigger" class="strip-label-icon" aria-hidden="true" />
                <span>建议召回时机</span>
              </span>
              <p class="summary-text">{{ tidyResult.proposed.disclosure }}</p>
            </div>

            <div
              class="guard-strip tabular-nums"
              :class="{
                'is-alert': hasMissingRefs,
                'is-warn': !hasMissingRefs && tidyResult.integrity.severeShrink,
              }"
            >
              <span class="guard-status">
                <UIcon
                  :name="
                    hasMissingRefs
                      ? icons.shieldAlert
                      : tidyResult.integrity.severeShrink
                        ? icons.warning
                        : icons.check
                  "
                  class="guard-icon"
                  aria-hidden="true"
                />
                {{
                  hasMissingRefs
                    ? '检测到双链或凭据引用缺失，请核对下方对比'
                    : tidyResult.integrity.severeShrink
                      ? '正文篇幅缩减较大，请核对已归档历史说明与下方对比'
                      : '双链与凭据占位符完整'
                }}
              </span>
              <span v-if="showLinksMeta" class="guard-meta">
                双链 {{ tidyResult.integrity.linksBefore }} → {{ tidyResult.integrity.linksAfter }}
              </span>
              <span v-if="showCredsMeta" class="guard-meta">
                凭据 {{ tidyResult.integrity.credsBefore }} → {{ tidyResult.integrity.credsAfter }}
              </span>
              <span v-if="lengthDelta" class="guard-meta">
                篇幅 {{ lengthDelta.before.toLocaleString() }} →
                {{ lengthDelta.after.toLocaleString() }} 字（{{ lengthDelta.text }}）
              </span>
            </div>

            <DiffViewer
              v-if="hasContentChange && parts.content"
              :before="tidyResult.before.content"
              :after="tidyResult.proposed.content"
              :context="3"
              :expand-step="10"
              max-height="26rem"
            />

            <details
              v-if="hasArchivedNotes && parts.content && parts.archivedNotes"
              class="archived-box"
            >
              <summary class="archived-head">
                <UIcon :name="icons.chevronRight" class="archived-chevron" aria-hidden="true" />
                <UIcon :name="icons.history" class="archived-icon" aria-hidden="true" />
                <span>
                  将写入版本历史的归档说明（{{ tidyResult.proposed.archivedNotes.length }} 条）
                </span>
              </summary>
              <ul class="archived-list">
                <li v-for="(item, idx) in tidyResult.proposed.archivedNotes" :key="idx">
                  <span v-if="item.occurredAt" class="archived-date font-mono">
                    {{ formatShort(item.occurredAt) }}
                  </span>
                  <span>{{ item.note }}</span>
                </li>
              </ul>
            </details>
          </template>
        </template>

        <!-- 模式 2：单条深度查重与关联 -->
        <template v-else-if="mode === 'cross_check' && crossResult">
          <div class="cross-meta tabular-nums">
            <span class="cross-meta-summary">
              <UIcon :name="icons.links" class="cross-meta-icon" aria-hidden="true" />
              <span>
                已比对 {{ crossResult.consideredNeighbors }} 条相邻记忆，本次新发现
                {{ crossResult.createdCount }} 条建议
              </span>
              <span v-if="relatedCrossSuggestions.length > 0" class="cross-meta-related">
                <UIcon :name="icons.updateDoc" class="cross-meta-related-icon" aria-hidden="true" />
                <span>含 {{ relatedCrossSuggestions.length }} 条关联记忆修订建议</span>
              </span>
            </span>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="icons.refresh"
              @click="runAction"
            >
              重新扫描
            </UButton>
          </div>

          <NoteLine v-if="crossResult.warnings?.length" tone="warning" flush>
            部分关联检查未完成，结果可能不完整。
            <template #detail>
              {{ crossResult.warnings.join('；') }}
            </template>
          </NoteLine>

          <EmptyState
            v-if="!crossResult.suggestions.length"
            :icon="crossResult.warnings?.length ? icons.warning : icons.shieldCheck"
            :tone="crossResult.warnings?.length ? 'neutral' : 'success'"
            :title="
              crossResult.warnings?.length
                ? '部分关联检查未完成，暂未发现可处理建议'
                : '未发现需要处理的重复或缺失关联'
            "
            :description="
              crossResult.warnings?.length
                ? '已完成的检查未发现重复或缺失双链，可稍后点击重新扫描补查未完成项。'
                : '该记忆与相邻记忆界限清晰，暂无需合并、更新或补全双链。'
            "
          />

          <div v-else class="cross-groups">
            <section v-if="directCrossSuggestions.length" class="cross-group">
              <div v-if="relatedCrossSuggestions.length" class="cross-group-head">
                <SectionHeading title="当前记忆建议" :icon="icons.links" :level="3">
                  <template #hint>
                    <span class="cross-group-count tabular-nums">
                      （{{ directCrossSuggestions.length }} 条）
                    </span>
                  </template>
                </SectionHeading>
              </div>
              <div class="space-y-4">
                <DreamSuggestionCard
                  v-for="item in directCrossSuggestions"
                  :key="item.id"
                  :suggestion="item"
                  :busy="cardBusyId === item.id"
                  :disabled="cardBusyId !== null && cardBusyId !== item.id"
                  @apply="onApplyCrossSuggestion"
                  @dismiss="onDismissCrossSuggestion"
                />
              </div>
            </section>

            <section v-if="relatedCrossSuggestions.length" class="cross-group">
              <div class="cross-group-head">
                <SectionHeading title="关联记忆修订建议" :icon="icons.updateDoc" :level="3">
                  <template #hint>
                    <span class="cross-group-count tabular-nums">
                      （{{ relatedCrossSuggestions.length }} 条）
                    </span>
                  </template>
                </SectionHeading>
                <p class="cross-group-desc">
                  由当前记忆比对发现，确认后将作用于对应关联记忆，不会修改当前记忆。
                </p>
              </div>
              <div class="space-y-4">
                <DreamSuggestionCard
                  v-for="item in relatedCrossSuggestions"
                  :key="item.id"
                  :suggestion="item"
                  :busy="cardBusyId === item.id"
                  :disabled="cardBusyId !== null && cardBusyId !== item.id"
                  @apply="onApplyCrossSuggestion"
                  @dismiss="onDismissCrossSuggestion"
                />
              </div>
            </section>
          </div>
        </template>
      </div>
    </template>

    <template v-if="mode === 'tidy' && tidyResult?.needed && !loading" #footer>
      <div class="drawer-foot">
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :icon="icons.refresh"
          :disabled="applying || staging"
          @click="runAction"
        >
          重新生成
        </UButton>
        <div class="foot-actions">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.listChecks"
            :loading="staging"
            :disabled="applying || !anySelected"
            @click="submitSingleTidy(true)"
          >
            暂存至整理
          </UButton>
          <UButton
            size="sm"
            :icon="icons.check"
            :loading="applying"
            :disabled="staging || !anySelected"
            @click="submitSingleTidy(false)"
          >
            应用改动
          </UButton>
        </div>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
.drawer-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.progress-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
}
.progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.progress-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.progress-icon {
  display: inline-block;
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--ui-text-muted);
}
.reason-line {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ui-text);
}
.fix-strip,
.partial-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 13px;
}
.strip-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.strip-label-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.fix-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
  color: var(--ui-text-toned);
}
.fix-pill-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-muted);
}
.partial-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}
.part-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.part-check input[type='checkbox'] {
  accent-color: var(--ui-primary);
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
}
.compare-old {
  color: var(--ui-text-muted);
  text-decoration: line-through;
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
}
.summary-box {
  padding: 8px 12px;
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.summary-text {
  margin-top: 2px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-highlighted);
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
.archived-box {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 13px;
}
.archived-head {
  display: flex;
  align-items: center;
  gap: 5px;
  list-style: none;
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.archived-head::-webkit-details-marker {
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
.archived-box[open] .archived-chevron {
  transform: rotate(90deg);
}
.archived-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 10px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.archived-date {
  margin-right: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.cross-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 13px;
  color: var(--ui-text-toned);
}
.cross-meta-summary {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.cross-meta-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.cross-meta-related {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
  color: var(--ui-text-toned);
}
.cross-meta-related-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-muted);
}
.cross-groups {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.cross-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cross-group-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cross-group-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.cross-group-desc {
  font-size: 13px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
.drawer-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}
.foot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.secret-warn-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}
.secret-warn-item {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.secret-warn-label {
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.secret-warn-loc {
  color: var(--ui-text-muted);
}
.secret-warn-code {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  color: var(--ui-text-toned);
}
</style>
