<script setup lang="ts">
import {
  DISCLOSURE_MAX,
  ENTRY_TITLE_MAX,
  EntryTitle,
  normalizeSlugList,
  TOPICS_MAX,
  TopicTag,
  type EntryDetailResponse,
  type EntryFacetsSummary,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { hasUnsavedChanges, useUnsavedChangesGuard } from '../composables/unsavedChanges'
import { useDebounced } from '../composables/useDebounced'
import { useNow } from '../composables/useNow'
import { icons } from '../icons'
import { entryKindLabels, envDisplayName } from '../labels'
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
import ConsequenceModal from './ConsequenceModal.vue'
import EntryLinksPanel from './EntryLinksPanel.vue'
import MemoryContent from './MemoryContent.vue'
import MemoryHistoryDrawer from './MemoryHistoryDrawer.vue'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'
import NoteLine from './ui/NoteLine.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
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

const queryKey = computed(() => ['entry', props.shortId] as const)
const detailQuery = useQuery({
  queryKey,
  queryFn: ({ queryKey: [, sid] }) => api.entry(sid),
})

const detail = ref<EntryDetailResponse | null>(null)
const entry = computed(() => detail.value?.entry ?? null)
const mode = ref<'read' | 'edit'>('read')
const preview = ref(false)
const historyOpen = ref(false)
const minValidTo = ref('')

const form = reactive({
  title: '',
  content: '',
  disclosure: '',
  isPinned: false,
  topics: [] as string[],
  validTo: '',
})
const scope = ref<SceneScopeValue>({ envs: [], realms: [], projects: [], runtimes: [] })

const validToInput = (iso: string | null) => (iso ? toLocalInput(iso) : '')

function loadDetail(next: EntryDetailResponse) {
  detail.value = next
  const e = next.entry
  form.title = e.title
  form.content = e.content
  form.disclosure = e.disclosure ?? ''
  form.isPinned = e.isPinned
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

const dirty = computed(() => {
  const e = entry.value
  if (!e || mode.value !== 'edit') return false
  return (
    form.title !== e.title ||
    form.content !== e.content ||
    form.disclosure !== (e.disclosure ?? '') ||
    form.isPinned !== e.isPinned ||
    !sameList(form.topics, e.topics) ||
    !sameList(scope.value.envs, e.envs) ||
    !sameList(scope.value.realms, e.realms) ||
    !sameList(scope.value.projects, e.projects) ||
    !sameList(scope.value.runtimes, e.runtimes) ||
    form.validTo !== validToInput(e.validTo)
  )
})

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

const validationProblem = computed(() => {
  if (mode.value !== 'edit') return null
  const titleCheck = EntryTitle.safeParse(form.title)
  if (!titleCheck.success) return titleCheck.error.issues[0]?.message ?? '标题格式有误'
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
  minValidTo.value = earliestValidTo()
  mode.value = 'edit'
}

function cancelEditing() {
  if (detail.value) loadDetail(detail.value)
  mode.value = 'read'
  preview.value = false
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
      content: form.content,
      disclosure: form.disclosure.trim() || null,
      isPinned: form.isPinned,
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
    preview.value = false
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

// 阅读态快捷切换「启动加载」或将「会话摘要」一键提炼为正式记忆
const quickBusy = ref(false)
async function togglePinnedQuick(nextPinned: boolean) {
  const current = entry.value
  if (!current || quickBusy.value || isDeleted.value || current.kind === 'episode') return
  quickBusy.value = true
  try {
    const updated = await api.updateEntry(current.shortId, {
      expectedVersion: current.version,
      isPinned: nextPinned,
    })
    queryClient.setQueryData(queryKey.value, updated)
    loadDetail(updated)
    emit('changed', updated)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '更新失败', color: 'error' })
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
  restoring.value = true
  try {
    const updated = await api.restoreEntry(current.shortId, {})
    queryClient.setQueryData(queryKey.value, updated)
    loadDetail(updated)
    toast.add({ title: '已恢复', color: 'success' })
    emit('restored', updated)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复失败', color: 'error' })
  } finally {
    restoring.value = false
  }
}

function onHistoryRestored(updated: EntryDetailResponse) {
  queryClient.setQueryData(queryKey.value, updated)
  loadDetail(updated)
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

// 渲染正文的链接目标映射
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

const titleEl = ref<HTMLElement | null>(null)
defineExpose({ focusTitle: () => titleEl.value?.focus() })
</script>

<template>
  <article class="editor-pane">
    <div v-if="detailQuery.isPending.value && !entry" class="p-6 space-y-4">
      <USkeleton class="h-7 w-1/2" />
      <USkeleton class="h-48 w-full" />
    </div>
    <div v-else-if="!entry" class="p-6">
      <ReadFailureNote :query="detailQuery" />
    </div>
    <template v-else>
      <header class="editor-head">
        <div class="head-nav"><slot name="nav" /></div>
        <div class="head-main">
          <div class="head-title-row">
            <h1 ref="titleEl" tabindex="-1">{{ entry.title }}</h1>
            <span v-if="entry.kind === 'episode'" class="pill">会话摘要</span>
            <span v-if="entry.isPinned" class="pill solid">启动加载</span>
            <span v-if="isDeleted" class="pill danger">已在回收站</span>
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
              <UButton
                v-if="!isDeleted && entry.kind === 'entry'"
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.pin"
                :loading="quickBusy"
                @click="togglePinnedQuick(!entry.isPinned)"
              >
                {{ entry.isPinned ? '取消常驻' : '设为常驻' }}
              </UButton>
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.history"
                @click="historyOpen = true"
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
                :loading="saving"
                :disabled="!dirty || Boolean(validationProblem)"
                @click="save"
              >
                保存
              </UButton>
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :disabled="saving"
                @click="cancelEditing"
              >
                取消
              </UButton>
            </template>
          </div>
        </div>
      </header>

      <div class="editor-scroll">
        <ReadFailureNote v-if="detailQuery.isError.value" :query="detailQuery" />

        <NoteLine v-if="expiredNow" tone="warning">
          该记忆已于 {{ formatShort(entry.validTo!) }} 过期，不再参与召回与启动加载。
        </NoteLine>

        <!-- 编辑模式 -->
        <template v-if="mode === 'edit'">
          <div class="space-y-4">
            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField label="标题">
                <UInput v-model="form.title" :maxlength="ENTRY_TITLE_MAX" class="w-full" />
              </UFormField>
              <UFormField label="主题">
                <UInputTags
                  v-model="form.topics"
                  add-on-blur
                  placeholder="输入后回车"
                  class="w-full"
                />
              </UFormField>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-3">
              <USwitch
                v-if="entry.kind === 'entry'"
                v-model="form.isPinned"
                label="启动加载（会话开始时自动注入）"
              />
              <span v-else class="text-xs text-muted">会话摘要不支持设为启动加载</span>
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

              <div class="ml-auto">
                <USwitch v-model="preview" size="sm" label="分栏预览" />
              </div>
            </div>

            <p v-if="validationProblem" class="text-sm text-error" role="alert">
              {{ validationProblem }}
            </p>

            <div class="grid gap-4" :class="preview ? 'xl:grid-cols-2' : ''">
              <UTextarea
                ref="contentRef"
                v-model="form.content"
                :rows="18"
                autoresize
                :maxrows="36"
                class="w-full font-mono"
                aria-label="正文"
              />
              <div v-if="preview" class="preview-box">
                <MemoryContent
                  :content="form.content"
                  :wiki-links="wikiLinks"
                  :credentials="credentialLinks"
                  @open="(sid) => emit('open', sid)"
                  @credential="openCredential"
                />
              </div>
            </div>
          </div>
        </template>

        <!-- 阅读模式 -->
        <template v-else>
          <dl class="meta-strip">
            <div>
              <dt>类型</dt>
              <dd>{{ entryKindLabels[entry.kind] }}</dd>
            </div>
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
            <div>
              <dt>更新</dt>
              <dd :title="formatTime(entry.updatedAt)">
                {{ formatRelative(entry.updatedAt) }} · 版本 {{ entry.version }}
              </dd>
            </div>
          </dl>

          <MemoryContent
            :content="entry.content"
            :wiki-links="wikiLinks"
            :credentials="credentialLinks"
            @open="(sid) => emit('open', sid)"
            @credential="openCredential"
          />

          <EntryLinksPanel
            :outbound-links="detail?.outboundLinks ?? []"
            :backlinks="detail?.backlinks ?? []"
            @open="(sid) => emit('open', sid)"
          />
        </template>
      </div>

      <ShortIdLine :value="entry.shortId" />

      <MemoryHistoryDrawer
        v-model:open="historyOpen"
        :short-id="entry.shortId"
        :current-version="entry.version"
        :is-deleted="isDeleted"
        @restored="onHistoryRestored"
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
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1;
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
.pill {
  padding: 1px 6px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.4;
}
.pill.solid {
  border-color: var(--ui-bg-inverted);
  background: var(--ui-bg-inverted);
  color: var(--ui-text-inverted);
}
.pill.danger {
  border-color: var(--ui-error);
  color: var(--ui-error);
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.editor-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 28px 28px;
}
.meta-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin-bottom: 20px;
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
.edit-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
}
.preview-box {
  padding: 12px 16px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  overflow-y: auto;
}
@media (max-width: 1023.98px) {
  .editor-head {
    padding: 12px 16px;
  }
  .editor-scroll {
    padding: 14px 16px 24px;
  }
}
</style>
