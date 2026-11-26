<script setup lang="ts">
import {
  applyMarkdownAppend,
  CAPTURE_TEXT_MAX,
  checkCaptureIntegrity,
  Disclosure,
  DISCLOSURE_MAX,
  ENTRY_CONTENT_MAX,
  ENTRY_TITLE_NEW_MAX,
  extractMarkdownHeadings,
  NewEntryTitle,
  TOPICS_MAX,
  TopicTag,
  type CaptureCandidate,
  type CaptureIntegrity,
  type CapturePatchKind,
  type CapturePlanResponse,
  type EntryDetailResponse,
} from '@kioku/contracts'
import { useKbd, useToast } from '@nuxt/ui/composables'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { collapseUnchanged, diffLines, type DiffRow } from '../diff'
import { icons } from '../icons'
import { detectSecretPrefixes } from '../secretHint'
import MemoryContent from './MemoryContent.vue'
import NoteLine from './ui/NoteLine.vue'

const END_SECTION = '__end__'

const PATCH_KIND_LABELS: Record<CapturePatchKind, string> = {
  insert_under_heading: '小节插入',
  append: '文末追加',
  replace: '局部替换',
  create: '新建记忆',
  noop: '无需重复',
}

const props = withDefaults(
  defineProps<{
    initialText?: string
  }>(),
  { initialText: '' },
)

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
      return
    }
    resetState(props.initialText)
    await focusInput()
  },
  { immediate: true },
)

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

const targetTitle = computed(() => activeCandidate.value?.title ?? targetShortId.value ?? '')

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

const inputSecretWarnings = computed(() => detectSecretPrefixes(rawText.value))
const editSecretWarnings = computed(() => {
  if (step.value !== 'preview') return []
  if (viewAction.value === 'create') return detectSecretPrefixes(createForm.content)
  if (viewAction.value === 'update' && editingDiff.value) {
    return detectSecretPrefixes(draftContent.value)
  }
  return []
})

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

const diffRows = computed<DiffRow[]>(() => {
  if (step.value !== 'preview' || viewAction.value !== 'update') return []
  return collapseUnchanged(diffLines(beforeContent.value, draftContent.value))
})

const hasDiffChanges = computed(() =>
  diffRows.value.some((row) => row.kind === 'add' || row.kind === 'remove'),
)

const mergeValidationProblem = computed(() => {
  if (viewAction.value !== 'update') return null
  if (!draftContent.value.trim()) return '正文不能为空'
  if (draftContent.value.length > ENTRY_CONTENT_MAX) {
    return `正文最多 ${ENTRY_CONTENT_MAX} 个字符`
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
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '触发场景格式有误'
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
    hasDiffChanges.value &&
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
  return window.confirm('已微调正文内容，切换后将放弃当前微调。确定继续？')
}

async function runCapturePlan(targetId?: string) {
  const text = rawText.value.trim()
  if (!text) return
  abortPending()
  const nextController = new AbortController()
  controller = nextController
  loadingReturnStep = targetId && plan.value ? 'preview' : 'input'
  loadingHint.value = targetId
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
        ...(targetId ? { targetShortId: targetId } : {}),
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
    error.value = err instanceof ApiError ? err.message : '匹配失败，请重试'
    step.value = loadingReturnStep
  }
}

function cancelLoading() {
  abortPending()
  step.value = loadingReturnStep
}

function onModalOpenChange(next: boolean) {
  if (!next) {
    if (applyBusy.value) return
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
    toast.add({
      title: `已撤销对「${title}」的归并，恢复至版本 ${prevVersion}`,
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
  try {
    const updated = await api.updateEntry(sid, {
      expectedVersion: prevVersion,
      content: draftContent.value,
    })
    const mergedVersion = updated.entry.version
    queryClient.setQueryData(['entry', sid], updated)
    void queryClient.invalidateQueries({ queryKey: ['entries'] })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', sid] })
    open.value = false
    emit('applied', updated)
    toast.add({
      title: `已归并至「${updated.entry.title}」（版本 ${mergedVersion}）`,
      color: 'success',
      duration: 8000,
      actions: [
        {
          label: '查看记忆',
          color: 'neutral',
          variant: 'outline',
          onClick: () => emit('openEntry', sid),
        },
        {
          label: '撤销',
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
      error.value = err instanceof ApiError ? err.message : '归并失败，请重试'
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
    event.isComposing ||
    !open.value ||
    !(event.metaKey || event.ctrlKey) ||
    event.key !== 'Enter'
  ) {
    return
  }
  if (step.value === 'input') {
    if (!rawText.value.trim()) return
    event.preventDefault()
    void runCapturePlan()
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
  window.removeEventListener('keydown', onModalKeydown)
})
</script>

<template>
  <UModal
    :open="open"
    title="随手记"
    description="自动匹配并归并至既有记忆"
    :dismissible="!applyBusy && step !== 'loading'"
    :close="!applyBusy"
    :ui="{ content: 'max-w-3xl sm:max-w-3xl' }"
    @update:open="onModalOpenChange"
    @close:prevent="onClosePrevent"
  >
    <template #body>
      <!-- 输入阶段 -->
      <div v-if="step === 'input'" class="space-y-3.5">
        <UFormField
          label="记录内容"
          name="text"
          help="无需先填标题或分类，可直接输入习惯、约定或事实更新"
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
            placeholder="例如：方案对比结论优先用 Markdown 表格呈现，列清取舍与代价……"
            class="w-full"
          />
        </UFormField>

        <NoteLine v-if="inputSecretWarnings.length" tone="warning" flush>
          内容疑似包含{{
            inputSecretWarnings.map((w) => w.label).join('、')
          }}，建议改存凭据并用占位符引用。
          <template #actions>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :to="{ name: 'credentials' }"
              @click="open = false"
            >
              前往凭据
            </UButton>
          </template>
        </NoteLine>

        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
      </div>

      <!-- 检索与分析加载态 -->
      <div v-else-if="step === 'loading'" class="loading-panel">
        <p class="loading-title">{{ loadingHint }}</p>
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
              <span class="plan-kind-tag">{{ patchBadgeText }}</span>
              <strong v-if="viewAction !== 'create' && targetTitle" class="plan-target-title">
                {{ targetTitle }}
              </strong>
            </div>
            <span v-if="viewAction !== 'create' && targetShortId" class="plan-meta">
              {{ targetShortId
              }}<template v-if="targetVersion !== null"> · 版本 {{ targetVersion }}</template>
            </span>
          </div>
          <p class="plan-reason">{{ reason }}</p>
        </div>

        <!-- 候选目标切换 chips -->
        <div v-if="candidates.length" class="candidate-bar">
          <span class="section-label">候选目标（点击可切换归并对象）</span>
          <div class="candidate-chips">
            <button
              v-for="cand in candidates"
              :key="cand.shortId"
              type="button"
              class="cand-btn"
              :class="{ active: viewAction !== 'create' && targetShortId === cand.shortId }"
              :disabled="applyBusy"
              :title="cand.title"
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

          <UFormField label="触发场景（可选）" name="disclosure">
            <UInput
              v-model="createForm.disclosure"
              name="disclosure"
              :maxlength="DISCLOSURE_MAX"
              :disabled="applyBusy"
              class="w-full"
            />
          </UFormField>

          <NoteLine v-if="editSecretWarnings.length" tone="warning" flush>
            正文疑似包含{{
              editSecretWarnings.map((w) => w.label).join('、')
            }}，建议改存凭据并用占位符引用。
          </NoteLine>

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
            <div class="noop-preview-head">
              <span class="font-medium">原记忆内容</span>
              <span v-if="targetShortId" class="font-mono text-xs text-muted">{{
                targetShortId
              }}</span>
            </div>
            <div class="noop-preview-scroll">
              <MemoryContent :content="beforeContent" />
            </div>
          </div>
          <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
        </template>

        <!-- 分支：修改方案 Diff 预览（主路径） -->
        <template v-else>
          <div v-if="showSectionPicker" class="section-picker-row">
            <label for="capture-section" class="section-label">插入位置</label>
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
            v-if="integrity"
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
            <span class="guard-meta">
              双链 {{ integrity.linksBefore }} → {{ integrity.linksAfter }}
            </span>
            <span class="guard-meta">
              凭据占位符 {{ integrity.credsBefore }} → {{ integrity.credsAfter }}
            </span>
            <span v-if="targetVersion !== null" class="guard-meta">
              基于版本 {{ targetVersion }}
            </span>
          </div>

          <NoteLine v-if="editSecretWarnings.length" tone="warning" flush>
            正文疑似包含{{
              editSecretWarnings.map((w) => w.label).join('、')
            }}，建议改存凭据并用占位符引用。
          </NoteLine>

          <div class="space-y-1.5">
            <div class="diff-toolbar">
              <span class="section-label">
                {{ editingDiff ? '微调归并后正文' : '变更预览（行级对比）' }}
              </span>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="editingDiff ? icons.file : icons.edit"
                :disabled="applyBusy"
                @click="editingDiff = !editingDiff"
              >
                {{ editingDiff ? '返回对比视图' : '微调内容' }}
              </UButton>
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
              aria-label="归并后正文"
            />
            <pre v-else class="diff-box"><template v-if="hasDiffChanges"><template
              v-for="(row, idx) in diffRows"
              :key="idx"
            ><span v-if="row.kind === 'skip'" class="diff-skip">… 省略未改动的 {{ row.count }} 行</span><span v-else class="diff-line" :class="row.kind">{{ row.text }}</span></template></template><span v-else class="diff-skip">正文无变更</span></pre>
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
              重新匹配
            </UButton>
          </div>
        </template>
      </div>
    </template>

    <template #footer>
      <!-- 输入态底部 -->
      <div v-if="step === 'input'" class="modal-foot">
        <span class="text-xs text-muted">
          {{
            hasChatModel ? '检索相关记忆并生成归并方案预览' : '未配置对话模型，将按候选目标直接追加'
          }}
        </span>
        <div class="foot-group">
          <UButton color="neutral" variant="ghost" size="sm" @click="open = false">取消</UButton>
          <UButton
            size="sm"
            :icon="icons.capture"
            :disabled="!rawText.trim()"
            @click="runCapturePlan()"
          >
            {{ hasChatModel ? '匹配归并方案' : '检索候选目标' }}
            <span class="shortcut-hint" aria-hidden="true">{{ submitShortcut }}</span>
          </UButton>
        </div>
      </div>

      <!-- 加载态底部 -->
      <div v-else-if="step === 'loading'" class="modal-foot">
        <span class="text-xs text-muted">仅调整命中段落，不重写无关正文</span>
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
          <UButton color="neutral" variant="outline" size="sm" @click="switchToAppend">
            仍要追加至文末
          </UButton>
          <UButton color="neutral" variant="outline" size="sm" @click="switchToCreate">
            存为新记忆
          </UButton>
        </div>
        <div class="foot-group">
          <UButton color="neutral" variant="ghost" size="sm" @click="open = false">关闭</UButton>
          <UButton v-if="targetShortId" size="sm" @click="openOriginalEntry">查看原记忆</UButton>
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
            v-if="patchKind !== 'append' || !manualAppendActive"
            color="neutral"
            variant="outline"
            size="sm"
            :disabled="applyBusy"
            @click="switchToAppend"
          >
            改为文末追加
          </UButton>
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :disabled="applyBusy"
            @click="switchToCreate"
          >
            存为新记忆
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
            确认归并
            <span v-if="!integrityWarning" class="shortcut-hint" aria-hidden="true">{{
              submitShortcut
            }}</span>
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
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
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
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
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--ui-text-highlighted);
}
.plan-target-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.plan-meta {
  flex: none;
  font-family: var(--font-mono);
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
.diff-box {
  max-height: 18rem;
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
.diff-skip {
  display: block;
  margin: 4px 0;
  padding: 2px 0 2px 18px;
  border-top: 1px dashed var(--ui-border);
  border-bottom: 1px dashed var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.diff-line {
  position: relative;
  display: block;
  min-height: 1.65em;
  padding: 0 6px 0 18px;
  border-left: 2px solid transparent;
}
.diff-line::before {
  content: '';
  position: absolute;
  left: 4px;
}
.diff-line.add {
  border-left-color: var(--ui-success);
  background: color-mix(in srgb, var(--ui-success) 6%, transparent);
  color: var(--ui-text-highlighted);
  font-weight: 600;
}
.diff-line.add::before {
  content: '+';
  color: var(--ui-success);
}
.diff-line.remove {
  border-left-color: var(--ui-error);
  background: color-mix(in srgb, var(--ui-error) 6%, transparent);
  color: var(--ui-error);
  text-decoration: line-through;
}
.diff-line.remove::before {
  content: '−';
  color: var(--ui-error);
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
</style>
