<script setup lang="ts">
import {
  BOOT_MODES,
  Disclosure,
  DISCLOSURE_MAX,
  ENTRY_CONTENT_MAX,
  ENTRY_SUMMARY_MAX,
  ENTRY_TITLE_NEW_MAX,
  EntrySummary,
  lintEntryHygiene,
  NewEntryTitle,
  TOPICS_MAX,
  TopicTag,
  type BootMode,
  type EntryDetailResponse,
  type EntryFacetsSummary,
} from '@kioku/contracts'
import { useKbd, useToast } from '@nuxt/ui/composables'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { maskSecretSnippet, replaceMatchAtRange } from '../credentials'
import { icons } from '../icons'
import { bootModeDescriptions, bootModeIcons, bootModeLabels } from '../labels'
import { findSecretMatches, type SecretMatch } from '../secretHint'
import { earliestValidTo, fromLocalInput, validToTooSoon } from '../time'
import { analyzeTitleHint } from '../titleHint'
import InlineCredentialCaptureModal, {
  type InlineCredentialSavedPayload,
} from './InlineCredentialCaptureModal.vue'
import MemoryContent from './MemoryContent.vue'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import NoteLine from './ui/NoteLine.vue'

const props = withDefaults(
  defineProps<{
    facets?: EntryFacetsSummary | null
    initialScope?: Partial<SceneScopeValue> | null
  }>(),
  { facets: null, initialScope: null },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [detail: EntryDetailResponse] }>()

const form = reactive({
  title: '',
  summary: '',
  content: '',
  disclosure: '',
  bootMode: 'none' as BootMode,
  topics: [] as string[],
  validTo: '',
})
const scope = ref<SceneScopeValue>({ envs: [], realms: [], projects: [], runtimes: [] })
const attrsOpen = ref(false)
const contentTab = ref<'edit' | 'preview'>('edit')
const minValidTo = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const toast = useToast()
const contentInputRef = ref<{ textareaRef?: HTMLTextAreaElement } | null>(null)
const captureModalOpen = ref(false)
const captureTarget = ref<SecretMatch | null>(null)
const captureMode = ref<'replace' | 'insert'>('replace')

const CONTENT_TAB_OPTIONS: { value: 'edit' | 'preview'; label: string; icon: string }[] = [
  { value: 'edit', label: '编辑', icon: icons.edit },
  { value: 'preview', label: '预览', icon: icons.reveal },
]

const BOOT_MODE_OPTIONS: { value: BootMode; label: string; icon: string }[] = BOOT_MODES.map(
  (value) => ({
    value,
    label: bootModeLabels[value],
    icon: bootModeIcons[value],
  }),
)

const { getKbdKey } = useKbd()
const submitShortcut = computed(() => {
  const mod = getKbdKey('meta')?.trim() || 'Ctrl'
  return mod === '⌘' ? '⌘↵' : `${mod}+Enter`
})

const attrsSummary = computed(() => {
  const parts: string[] = []
  const scopeCount =
    scope.value.envs.length +
    scope.value.realms.length +
    scope.value.projects.length +
    scope.value.runtimes.length
  parts.push(scopeCount > 0 ? `${scopeCount} 项场景限定` : '全局通用')
  if (form.disclosure.trim()) parts.push('已设召回时机')
  if (form.validTo) parts.push('已设有效期')
  return parts.join(' · ')
})

watch(
  open,
  (visible) => {
    if (!visible) {
      captureModalOpen.value = false
      captureTarget.value = null
      return
    }
    form.title = ''
    form.summary = ''
    form.content = ''
    form.disclosure = ''
    form.bootMode = 'none'
    form.topics = []
    form.validTo = ''
    const nextScope: SceneScopeValue = {
      envs: [...(props.initialScope?.envs ?? [])],
      realms: [...(props.initialScope?.realms ?? [])],
      projects: [...(props.initialScope?.projects ?? [])],
      runtimes: [...(props.initialScope?.runtimes ?? [])],
    }
    scope.value = nextScope
    attrsOpen.value =
      nextScope.envs.length > 0 ||
      nextScope.realms.length > 0 ||
      nextScope.projects.length > 0 ||
      nextScope.runtimes.length > 0
    contentTab.value = 'edit'
    minValidTo.value = earliestValidTo()
    error.value = null
    captureModalOpen.value = false
    captureTarget.value = null
  },
  { immediate: true },
)

const secretMatches = computed(() => findSecretMatches(form.content))

function insertSnippetAtCursor(snippet: string) {
  const el = contentInputRef.value?.textareaRef
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

function openReplaceSecret(match: SecretMatch) {
  captureMode.value = 'replace'
  captureTarget.value = match
  captureModalOpen.value = true
}

function openInsertNewCredential() {
  captureMode.value = 'insert'
  captureTarget.value = null
  captureModalOpen.value = true
}

function onInlineCredentialSaved(payload: InlineCredentialSavedPayload) {
  if (captureMode.value === 'replace' && captureTarget.value) {
    form.content = replaceMatchAtRange(form.content, captureTarget.value, payload.placeholder)
    toast.add({ title: `已转存并替换为 ${payload.placeholder}`, color: 'success' })
  } else {
    insertSnippetAtCursor(payload.placeholder)
    toast.add({ title: `已新建凭据并插入 ${payload.placeholder}`, color: 'success' })
  }
  captureTarget.value = null
}
const bootWarnings = computed(() =>
  lintEntryHygiene({
    title: form.title,
    content: form.content,
    summary: form.summary,
    bootMode: form.bootMode,
    envs: scope.value.envs,
    realms: scope.value.realms,
    projects: scope.value.projects,
    runtimes: scope.value.runtimes,
  }).filter((w) => w.code === 'pinned_oversized' || w.code === 'pinned_missing_summary'),
)
const titleHint = computed(() => analyzeTitleHint(form.title, form.content, 'create'))

function applyCleanTitle() {
  const split = titleHint.value.splittable
  if (!split) return
  form.title = split.cleanTitle
}

const validationProblem = computed(() => {
  if (form.title.trim()) {
    const parsed = NewEntryTitle.safeParse(form.title)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '标题格式有误'
  }
  if (form.summary.trim()) {
    const parsed = EntrySummary.safeParse(form.summary)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '现行概要格式有误'
  }
  if (form.disclosure.trim()) {
    const parsed = Disclosure.safeParse(form.disclosure)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '召回时机格式有误'
  }
  if (form.content.length > ENTRY_CONTENT_MAX) {
    return `正文最多 ${ENTRY_CONTENT_MAX.toLocaleString()} 字`
  }
  if (form.topics.length > TOPICS_MAX) return `主题标签最多 ${TOPICS_MAX} 个`
  for (const tag of form.topics) {
    const parsed = TopicTag.safeParse(tag)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '主题标签格式有误'
  }
  if (form.validTo && validToTooSoon(form.validTo)) return '有效期须晚于当前时间至少 1 分钟'
  return null
})

const canSubmit = computed(
  () => form.content.trim().length > 0 && !validationProblem.value && !saving.value,
)

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  try {
    const validTo = form.validTo ? fromLocalInput(form.validTo) : null
    const detail = await api.createEntry({
      ...(form.title.trim() ? { title: form.title.trim() } : {}),
      summary: form.summary.trim() || null,
      content: form.content,
      disclosure: form.disclosure.trim() || null,
      bootMode: form.bootMode,
      isPinned: form.bootMode !== 'none',
      topics: form.topics,
      envs: scope.value.envs,
      realms: scope.value.realms,
      projects: scope.value.projects,
      runtimes: scope.value.runtimes,
      validTo,
    })
    open.value = false
    emit('created', detail)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '新建失败，请重试'
  } finally {
    saving.value = false
  }
}

function onModalKeydown(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    !open.value ||
    captureModalOpen.value ||
    !(event.metaKey || event.ctrlKey) ||
    event.shiftKey ||
    event.altKey ||
    event.key !== 'Enter'
  ) {
    return
  }
  if (!canSubmit.value) return
  event.preventDefault()
  void submit()
}

watch(captureModalOpen, (visible) => {
  if (!visible) captureTarget.value = null
})

onMounted(() => window.addEventListener('keydown', onModalKeydown))
onBeforeUnmount(() => {
  captureTarget.value = null
  window.removeEventListener('keydown', onModalKeydown)
})
</script>

<template>
  <UModal
    :open="open"
    title="新建记忆"
    :dismissible="!saving && !captureModalOpen"
    :close="!saving"
    :ui="{ content: 'max-w-3xl sm:max-w-3xl' }"
    @update:open="(v) => !saving && !captureModalOpen && (open = v)"
  >
    <template #body>
      <div class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="标题">
            <template #label>
              <span class="field-label">
                <UIcon :name="icons.heading" class="field-label-icon" aria-hidden="true" />
                <span>标题</span>
              </span>
            </template>
            <UInput v-model="form.title" :maxlength="ENTRY_TITLE_NEW_MAX" class="w-full" />
            <template #help>
              <div v-if="titleHint.message" class="title-hint-row">
                <span class="title-hint-text">{{ titleHint.message }}</span>
                <UButton
                  v-if="titleHint.splittable"
                  type="button"
                  size="xs"
                  color="warning"
                  variant="outline"
                  :icon="icons.split"
                  @click="applyCleanTitle"
                >
                  精简为短标题
                </UButton>
              </div>
              <span v-else>留空时自动提取正文首个标题或短 ID</span>
            </template>
          </UFormField>
          <UFormField label="主题">
            <template #label>
              <span class="field-label">
                <UIcon :name="icons.topic" class="field-label-icon" aria-hidden="true" />
                <span>主题</span>
              </span>
            </template>
            <UInputTags v-model="form.topics" add-on-blur placeholder="输入后回车" class="w-full" />
          </UFormField>
        </div>

        <UFormField label="现行概要（可选）" help="1–2 句概括当前结论，用于启动加载与列表预览">
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
            placeholder="例如：生产环境统一使用 Docker Compose 部署，反向代理监听本机回环端口。"
            class="w-full"
          />
        </UFormField>

        <div v-if="secretMatches.length" class="secret-alert-box" role="status">
          <p class="secret-alert-head">
            <UIcon :name="icons.shieldAlert" class="secret-alert-icon" aria-hidden="true" />
            <span>
              正文疑似包含 {{ secretMatches.length }} 处明文凭据，建议改存托管凭据并用占位符替换
            </span>
          </p>
          <ul class="secret-match-list">
            <li
              v-for="(m, idx) in secretMatches"
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
                @click="openReplaceSecret(m)"
              >
                转存为凭据并替换
              </UButton>
            </li>
          </ul>
        </div>

        <div class="space-y-1.5">
          <div class="content-head">
            <span class="content-label">
              <UIcon :name="icons.file" class="field-label-icon" aria-hidden="true" />
              <span>正文（Markdown）</span>
            </span>
            <div class="content-head-actions">
              <UButton
                v-if="contentTab === 'edit'"
                type="button"
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.credentials"
                @click="openInsertNewCredential"
              >
                新建凭据并插入
              </UButton>
              <SegmentedChoice
                v-model="contentTab"
                :items="CONTENT_TAB_OPTIONS"
                label="正文编辑与预览切换"
                compact
              />
            </div>
          </div>
          <UTextarea
            v-if="contentTab === 'edit'"
            ref="contentInputRef"
            v-model="form.content"
            :rows="9"
            autoresize
            :maxrows="18"
            placeholder="支持 Markdown、[[m-xxxxxx]] 双链与 {{cred:slug}} 凭据占位符"
            aria-label="正文（Markdown）"
            class="w-full font-mono"
          />
          <div v-else class="create-preview-box">
            <MemoryContent v-if="form.content.trim()" width="full" :content="form.content" />
            <p v-else class="text-xs text-muted">尚未填写正文内容</p>
          </div>
        </div>

        <div class="space-y-1.5">
          <div class="flex flex-wrap items-center gap-3">
            <span class="content-label">
              <UIcon :name="icons.pin" class="field-label-icon" aria-hidden="true" />
              <span>启动加载</span>
            </span>
            <SegmentedChoice
              v-model="form.bootMode"
              :items="BOOT_MODE_OPTIONS"
              label="启动加载方式"
              compact
            />
          </div>
          <p class="text-xs text-muted">{{ bootModeDescriptions[form.bootMode] }}</p>
        </div>

        <NoteLine v-if="bootWarnings.length" tone="warning">
          {{ bootWarnings.map((w) => w.message).join('；') }}
          <template v-if="bootWarnings.some((w) => w.code === 'pinned_oversized')" #actions>
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

        <!-- 默认折叠的高级属性与场景，首屏直接展示核心编辑与创建按钮 -->
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
                class="attrs-icon"
                aria-hidden="true"
              />
              <UIcon :name="icons.sliders" class="attrs-icon" aria-hidden="true" />
              <span>适用场景与有效期</span>
            </span>
            <span class="attrs-summary">{{ attrsSummary }}</span>
          </button>

          <div v-if="attrsOpen" class="attrs-body space-y-4">
            <UFormField label="适用场景">
              <SceneScopePicker v-model="scope" :facets="facets" />
            </UFormField>

            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField label="召回时机（可选）" help="简述何时需要召回此记忆">
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

        <p v-if="error || validationProblem" class="text-sm text-error" role="alert">
          {{ error ?? validationProblem }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
          取消
        </UButton>
        <UButton :icon="icons.check" :loading="saving" :disabled="!canSubmit" @click="submit">
          创建
          <span class="shortcut-hint" aria-hidden="true">{{ submitShortcut }}</span>
        </UButton>
      </div>
    </template>
  </UModal>

  <InlineCredentialCaptureModal
    v-model:open="captureModalOpen"
    :initial-value="captureTarget?.match ?? ''"
    :initial-match="captureTarget"
    :default-realms="scope.realms"
    silent-success-toast
    :title="captureMode === 'replace' ? '转存为托管凭据并替换' : '新建凭据并插入'"
    :action-label="captureMode === 'replace' ? '保存并替换' : '保存并插入'"
    @saved="onInlineCredentialSaved"
  />
</template>

<style scoped>
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
.content-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.content-head-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
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
.secret-alert-head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ui-warning);
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
.content-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.create-preview-box {
  min-height: 13.5rem;
  max-height: 24rem;
  overflow-y: auto;
  padding: 12px 14px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
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
.shortcut-hint {
  font-family: var(--font-mono);
  font-size: 12px;
}
@media (max-width: 767.98px), (pointer: coarse) {
  .shortcut-hint {
    display: none;
  }
}
</style>
