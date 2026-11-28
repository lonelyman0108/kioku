<script setup lang="ts">
import { CREDENTIAL_KINDS, type CredentialKind, type CredentialMeta } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import ConsequenceModal from '../components/ConsequenceModal.vue'
import CredentialIndexRail from '../components/CredentialIndexRail.vue'
import CredentialWorkbench from '../components/CredentialWorkbench.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import NoteLine from '../components/ui/NoteLine.vue'
import ReadFailureNote from '../components/ui/ReadFailureNote.vue'
import {
  confirmDiscard,
  hasUnsavedChanges,
  useUnsavedChangesGuard,
} from '../composables/unsavedChanges'
import { useSession } from '../composables/useSession'
import { useViewport } from '../composables/useViewport'
import {
  collectKnownRealms,
  CREDENTIAL_REALM_ALL,
  CREDENTIAL_REALM_EMPTY,
  CREDENTIAL_REALM_UNSCOPED,
} from '../credentials'
import { icons } from '../icons'
import { credentialKindIcons, credentialKindLabels } from '../labels'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()
const viewport = useViewport()

const hasMasterKey = computed(() => me.data.value?.hasMasterKey ?? true)
const isPhone = computed(() => viewport.value.width < 768)
const compactRail = computed(() => viewport.value.width < 1280)

// 凭据列表与访问密钥列表仅查询元数据，绝不含明文
const credentialsQuery = useQuery({
  queryKey: ['credentials'] as const,
  queryFn: () => api.credentials(),
})
const items = computed(() => credentialsQuery.data.value?.items ?? [])

const apiKeysQuery = useQuery({
  queryKey: ['api-keys'] as const,
  queryFn: () => api.keys(),
  staleTime: 30_000,
})
const apiKeys = computed(() => apiKeysQuery.data.value?.items ?? [])

const knownRealms = computed(() => collectKnownRealms(items.value, apiKeys.value))

// 左侧筛选与中间清单搜索
const kindFilter = ref<'all' | CredentialKind>('all')
const realmFilter = ref<string>(CREDENTIAL_REALM_ALL)
const searchInput = ref('')
const railOpen = ref(false)
const newFormInitialKind = ref<CredentialKind>('secret')

function textQuery(key: string): string | null {
  const v = route.query[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function withQuery(changes: Record<string, string | null>) {
  const query = { ...route.query }
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete query[k]
    else query[k] = v
  }
  return { query }
}

const routeSlug = computed(() => textQuery('id'))
const routeNewFlag = computed(() => {
  const raw = textQuery('new')
  return raw === '1' || raw === 'true'
})
const routeNewKind = computed<CredentialKind>(() => {
  const raw = textQuery('kind')
  return raw && (CREDENTIAL_KINDS as readonly string[]).includes(raw)
    ? (raw as CredentialKind)
    : 'secret'
})

const mode = ref<'read' | 'edit' | 'new'>('read')
const formDirty = ref(false)
const workbenchRef = ref<InstanceType<typeof CredentialWorkbench> | null>(null)

const { leaving } = useUnsavedChangesGuard(formDirty, {
  leavesOn: (to, from) => to.query.id !== from.query.id || to.name !== from.name,
})

const filteredItems = computed(() => {
  const q = searchInput.value.trim().toLowerCase()
  return items.value.filter((item) => {
    if (kindFilter.value !== 'all' && item.kind !== kindFilter.value) return false
    if (realmFilter.value === CREDENTIAL_REALM_UNSCOPED && item.allowedRealms !== null) return false
    if (
      realmFilter.value === CREDENTIAL_REALM_EMPTY &&
      !(item.allowedRealms !== null && item.allowedRealms.length === 0)
    ) {
      return false
    }
    if (
      realmFilter.value !== CREDENTIAL_REALM_ALL &&
      realmFilter.value !== CREDENTIAL_REALM_UNSCOPED &&
      realmFilter.value !== CREDENTIAL_REALM_EMPTY
    ) {
      if (!item.allowedRealms?.includes(realmFilter.value)) return false
    }
    if (q) {
      const hay = [
        item.label,
        item.slug,
        item.description ?? '',
        ...(item.allowedRealms ?? []),
        ...item.fieldMeta.map((f) => `${f.name} ${f.label ?? ''}`),
      ]
        .join(' ')
        .toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
})

const isFiltered = computed(
  () =>
    kindFilter.value !== 'all' ||
    realmFilter.value !== CREDENTIAL_REALM_ALL ||
    searchInput.value.trim() !== '',
)

const filterSummary = computed(() => {
  const parts: string[] = [
    kindFilter.value === 'all' ? '全部凭据' : credentialKindLabels[kindFilter.value],
  ]
  if (realmFilter.value === CREDENTIAL_REALM_UNSCOPED) parts.push('不限场域')
  else if (realmFilter.value === CREDENTIAL_REALM_EMPTY) parts.push('仅无场域')
  else if (realmFilter.value !== CREDENTIAL_REALM_ALL) parts.push(realmFilter.value)
  return parts.join(' · ')
})

const selectedCred = computed<CredentialMeta | null>(() => {
  if (!routeSlug.value) return null
  return items.value.find((item) => item.slug === routeSlug.value) ?? null
})

// URL ?new=1 触发新建态（受 hasMasterKey 守卫）并立即清理查询参数，防止刷新重复触发
watch(
  [() => route.query.new, () => me.data.value],
  ([rawNew, meData]) => {
    const newFlag = typeof rawNew === 'string' ? rawNew.trim() : ''
    if ((newFlag !== '1' && newFlag !== 'true') || !meData) return
    if (meData.hasMasterKey) {
      formDirty.value = false
      newFormInitialKind.value = routeNewKind.value
      mode.value = 'new'
    }
    void router.replace(withQuery({ new: null, kind: null }))
  },
  { immediate: true },
)

// 桌面和平板下列表就绪后若无选中项且非新建态，默认定位首条
watch(
  [filteredItems, routeSlug, routeNewFlag, mode, isPhone, () => credentialsQuery.isPending.value],
  ([list, slug, isNew, currentMode, phone, pending]) => {
    if (phone || pending || isNew || currentMode === 'new' || slug || list.length === 0) return
    const first = list[0]
    if (first) void router.replace(withQuery({ id: first.slug, new: null }))
  },
  { immediate: true },
)

// 被引用记忆查询（仅返回活跃记忆标题与短 ID，不含凭据明文）
const referencesQuery = useQuery({
  queryKey: computed(() => ['credential-references', selectedCred.value?.id ?? null] as const),
  queryFn: ({ queryKey: [, credId] }) => api.credentialReferences(credId!),
  enabled: computed(() => mode.value === 'read' && Boolean(selectedCred.value?.id)),
})
const references = computed(() => referencesQuery.data.value?.items ?? [])

const hasSelection = computed(() => mode.value === 'new' || Boolean(selectedCred.value))

function resetFilters() {
  kindFilter.value = 'all'
  realmFilter.value = CREDENTIAL_REALM_ALL
  searchInput.value = ''
}

function onKindFilterChange(next: 'all' | CredentialKind) {
  kindFilter.value = next
  railOpen.value = false
}

function onRealmFilterChange(next: string) {
  realmFilter.value = next
  railOpen.value = false
}

function selectCredential(slug: string | null) {
  if (formDirty.value && !confirmDiscard()) return
  formDirty.value = false
  mode.value = 'read'
  void router.replace(withQuery({ id: slug, new: null, kind: null }))
}

function openCreate() {
  if (!hasMasterKey.value) return
  if (formDirty.value && !confirmDiscard()) return
  formDirty.value = false
  newFormInitialKind.value = 'secret'
  mode.value = 'new'
}

function enterEdit() {
  if (!selectedCred.value || !hasMasterKey.value) return
  mode.value = 'edit'
}

function onCancelForm() {
  const wasNew = mode.value === 'new'
  formDirty.value = false
  mode.value = 'read'
  if (wasNew || routeNewFlag.value) {
    const fallbackSlug =
      selectedCred.value?.slug ?? (!isPhone.value ? (items.value[0]?.slug ?? null) : null)
    void router.replace(withQuery({ new: null, kind: null, id: fallbackSlug }))
  }
}

async function onSaved(saved: CredentialMeta, isNew: boolean) {
  formDirty.value = false
  if (isNew) {
    kindFilter.value = 'all'
    realmFilter.value = CREDENTIAL_REALM_ALL
    searchInput.value = ''
  }
  await queryClient.invalidateQueries({ queryKey: ['credentials'] })
  void queryClient.invalidateQueries({ queryKey: ['credential-references', saved.id] })
  mode.value = 'read'
  await router.replace(withQuery({ id: saved.slug, new: null, kind: null }))
}

function onUpdated(updated: CredentialMeta) {
  void queryClient.invalidateQueries({ queryKey: ['credentials'] })
  void queryClient.invalidateQueries({ queryKey: ['credential-references', updated.id] })
}

// 删除确认
const deleting = ref<CredentialMeta | null>(null)
const deleteBusy = ref(false)
const deleteError = ref<string | null>(null)

function openDeleteModal() {
  if (!selectedCred.value) return
  deleting.value = selectedCred.value
  deleteError.value = null
}

const deleteConsequences = computed(() => {
  const target = deleting.value
  if (!target) return []
  const list = [`加密保存的凭据 ${target.slug} 及其全部字段将被永久删除，无法恢复。`]
  if (references.value.length > 0 && target.id === selectedCred.value?.id) {
    const refIds = references.value
      .slice(0, 5)
      .map((r) => r.shortId)
      .join('、')
    const more = references.value.length > 5 ? ' 等' : ''
    list.push(
      `当前有 ${references.value.length} 条记忆引用了此凭据（${refIds}${more}），删除后这些引用将失效。`,
    )
  } else {
    list.push('引用该占位符的记忆与命令行调用将无法再解析到值。')
  }
  return list
})

async function confirmDelete() {
  const target = deleting.value
  if (!target || deleteBusy.value) return
  deleteBusy.value = true
  deleteError.value = null
  try {
    const currentList = filteredItems.value
    const idx = currentList.findIndex((item) => item.id === target.id)
    const remaining = currentList.filter((item) => item.id !== target.id)
    const nextItem =
      !isPhone.value && remaining.length > 0
        ? remaining[Math.min(Math.max(0, idx), remaining.length - 1)]
        : null
    await api.deleteCredential(target.id)
    deleting.value = null
    leaving.value = true
    formDirty.value = false
    hasUnsavedChanges.value = false
    mode.value = 'read'
    toast.add({ title: `已删除凭据 ${target.slug}`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['credentials'] })
    void queryClient.removeQueries({ queryKey: ['credential-references', target.id], exact: true })
    await router.replace(withQuery({ id: nextItem ? nextItem.slug : null, new: null }))
    leaving.value = false
  } catch (err) {
    deleteError.value = err instanceof ApiError ? err.message : '删除失败'
  } finally {
    deleteBusy.value = false
  }
}

// ---- 可拖动分隔栏（严格对齐 MemoriesPage.vue） ----
const INDEX_RAIL_WIDTH = 216
const LIST_WIDTH_STORAGE_KEY = 'kioku:credentials-list-width'
const LIST_WIDTH_DEFAULT = 336
const LIST_WIDTH_MIN = 280
const LIST_WIDTH_MIN_COMPACT = 256
const LIST_WIDTH_MAX = 520
const DETAIL_MIN_WIDTH = 520
const DETAIL_MIN_WIDTH_COMPACT = 480

function readStoredListWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(LIST_WIDTH_STORAGE_KEY))
    if (Number.isFinite(raw) && raw >= LIST_WIDTH_MIN_COMPACT && raw <= LIST_WIDTH_MAX) {
      return Math.round(raw)
    }
  } catch {
    // 存储受限时退回默认宽度
  }
  return LIST_WIDTH_DEFAULT
}

function saveListWidth(width: number) {
  try {
    window.localStorage.setItem(LIST_WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // 忽略存储写入异常
  }
}

const layoutRef = ref<HTMLElement | null>(null)
const storedListWidth = ref<number>(readStoredListWidth())
const containerWidth = ref<number>(0)
const resizing = ref(false)
let layoutObserver: ResizeObserver | null = null

const activeRailWidth = computed(() => (compactRail.value ? 0 : INDEX_RAIL_WIDTH))
const listMinWidth = computed(() =>
  viewport.value.width < 1024 ? LIST_WIDTH_MIN_COMPACT : LIST_WIDTH_MIN,
)
const detailMinWidth = computed(() =>
  viewport.value.width < 1024 ? DETAIL_MIN_WIDTH_COMPACT : DETAIL_MIN_WIDTH,
)
const maxAllowedWidth = computed(() => {
  const viewportFallback = Math.min(viewport.value.width, 1840)
  const effectiveContainer = containerWidth.value > 0 ? containerWidth.value : viewportFallback
  return Math.max(
    listMinWidth.value,
    Math.min(LIST_WIDTH_MAX, effectiveContainer - activeRailWidth.value - detailMinWidth.value),
  )
})
const effectiveListWidth = computed(() =>
  Math.max(listMinWidth.value, Math.min(storedListWidth.value, maxAllowedWidth.value)),
)

let dragStartX = 0
let dragStartWidth = LIST_WIDTH_DEFAULT

function onPointerMove(event: PointerEvent) {
  if (!resizing.value) return
  storedListWidth.value = Math.round(
    Math.max(
      listMinWidth.value,
      Math.min(maxAllowedWidth.value, dragStartWidth + (event.clientX - dragStartX)),
    ),
  )
}

function stopResize() {
  if (!resizing.value) return
  resizing.value = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stopResize)
  window.removeEventListener('pointercancel', stopResize)
  window.removeEventListener('blur', stopResize)
  saveListWidth(storedListWidth.value)
}

function startResize(event: PointerEvent) {
  if (isPhone.value || event.button !== 0) return
  event.preventDefault()
  dragStartX = event.clientX
  dragStartWidth = effectiveListWidth.value
  resizing.value = true
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopResize)
  window.addEventListener('pointercancel', stopResize)
  window.addEventListener('blur', stopResize)
}

function resetListWidth() {
  storedListWidth.value = LIST_WIDTH_DEFAULT
  saveListWidth(LIST_WIDTH_DEFAULT)
}

function onSplitterKeydown(event: KeyboardEvent) {
  if (isPhone.value) return
  const step = event.shiftKey ? 40 : 16
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    storedListWidth.value = Math.max(listMinWidth.value, effectiveListWidth.value - step)
    saveListWidth(storedListWidth.value)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    storedListWidth.value = Math.min(maxAllowedWidth.value, effectiveListWidth.value + step)
    saveListWidth(storedListWidth.value)
  } else if (event.key === 'Home') {
    event.preventDefault()
    resetListWidth()
  }
}

watch(isPhone, (phone) => {
  if (phone) stopResize()
})
watch(compactRail, (compact) => {
  if (!compact) railOpen.value = false
})

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || railOpen.value || deleting.value !== null) return
  if (document.querySelector('[role="dialog"], [data-reka-popper-content-wrapper]')) return

  if (event.key === 'Escape') {
    if (mode.value !== 'read') {
      event.preventDefault()
      workbenchRef.value?.requestCancelForm()
      return
    }
    if (isEditableElement(event.target)) return
    if (isPhone.value && selectedCred.value) {
      event.preventDefault()
      selectCredential(null)
    }
    return
  }

  if (mode.value !== 'read' || isEditableElement(event.target)) return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (
    event.key === 'ArrowDown' ||
    event.key === 'j' ||
    event.key === 'ArrowUp' ||
    event.key === 'k'
  ) {
    const list = filteredItems.value
    if (!list.length) return
    event.preventDefault()
    const currentIndex = list.findIndex((item) => item.slug === selectedCred.value?.slug)
    const nextIndex =
      event.key === 'ArrowDown' || event.key === 'j'
        ? currentIndex < 0
          ? 0
          : Math.min(list.length - 1, currentIndex + 1)
        : currentIndex <= 0
          ? 0
          : currentIndex - 1
    const target = list[nextIndex]
    if (target) selectCredential(target.slug)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (layoutRef.value && typeof ResizeObserver !== 'undefined') {
    containerWidth.value = layoutRef.value.clientWidth
    layoutObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) containerWidth.value = Math.round(w)
    })
    layoutObserver.observe(layoutRef.value)
  }
})

onBeforeUnmount(() => {
  stopResize()
  layoutObserver?.disconnect()
  layoutObserver = null
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    ref="layoutRef"
    class="credentials-shell"
    :class="{
      'has-selection': hasSelection,
      'is-resizing': resizing,
    }"
    :style="!isPhone ? { '--list-width': `${effectiveListWidth}px` } : undefined"
  >
    <!-- 左目录轨 -->
    <div class="rail-col">
      <CredentialIndexRail
        :kind-filter="kindFilter"
        :realm-filter="realmFilter"
        :items="items"
        :known-realms="knownRealms"
        @update:kind-filter="onKindFilterChange"
        @update:realm-filter="onRealmFilterChange"
      />
    </div>

    <!-- 中间清单 -->
    <section class="list-col" aria-label="凭据清单">
      <header class="list-head">
        <UButton
          v-if="compactRail"
          size="sm"
          color="neutral"
          variant="outline"
          :icon="icons.panelLeft"
          class="shrink-0 whitespace-nowrap"
          @click="railOpen = true"
        >
          筛选
        </UButton>

        <div class="search-wrap">
          <UInput
            id="credentials-search"
            v-model="searchInput"
            name="q"
            type="text"
            size="sm"
            :icon="icons.search"
            placeholder="搜索名称、标识或说明…"
            aria-label="搜索凭据"
            :ui="{ base: searchInput ? 'text-[13px]/5 pe-8' : 'text-[13px]/5' }"
            class="w-full"
          >
            <template v-if="searchInput" #trailing>
              <UButton
                :icon="icons.cancel"
                size="xs"
                color="neutral"
                variant="link"
                aria-label="清除搜索"
                @click="searchInput = ''"
              />
            </template>
          </UInput>
        </div>

        <UButton
          size="sm"
          :icon="icons.add"
          :disabled="!hasMasterKey"
          class="shrink-0 whitespace-nowrap"
          @click="openCreate"
        >
          新建
        </UButton>
      </header>

      <div class="list-subbar">
        <span class="subbar-summary tabular-nums">
          {{ filterSummary }} · <strong>{{ filteredItems.length }}</strong>
        </span>
        <button v-if="isFiltered" type="button" class="subbar-reset" @click="resetFilters">
          清除筛选
        </button>
      </div>

      <div class="list-scroll">
        <div v-if="!hasMasterKey" class="px-3 pt-2">
          <NoteLine tone="warning" flush>
            未配置主密钥 KIOKU_MASTER_KEY，无法创建或读取加密凭据。
          </NoteLine>
        </div>

        <div v-if="credentialsQuery.isError.value" class="p-3">
          <ReadFailureNote :query="credentialsQuery" />
        </div>

        <div v-else-if="credentialsQuery.isPending.value" class="space-y-2 p-3">
          <USkeleton v-for="n in 5" :key="n" class="h-14 w-full" />
        </div>

        <div v-else-if="filteredItems.length" class="cred-list" role="list">
          <button
            v-for="item in filteredItems"
            :key="item.id"
            type="button"
            class="cred-row"
            :class="{
              'is-scoped': item.allowedRealms !== null,
              'is-unscoped': item.allowedRealms === null,
              'is-selected': mode !== 'new' && selectedCred?.id === item.id,
            }"
            :aria-current="mode !== 'new' && selectedCred?.id === item.id ? 'true' : undefined"
            @click="selectCredential(item.slug)"
          >
            <span class="row-line-1">
              <UIcon
                :name="credentialKindIcons[item.kind]"
                class="row-kind-icon"
                aria-hidden="true"
              />
              <span class="row-name">{{ item.label }}</span>
            </span>
            <span class="row-line-2">
              <span class="row-slug font-mono">{{ item.slug }}</span>
              <span aria-hidden="true">·</span>
              <span :class="{ 'font-mono': Boolean(item.allowedRealms?.length) }">
                {{
                  item.allowedRealms === null
                    ? '不限场域'
                    : item.allowedRealms.length
                      ? item.allowedRealms.join(' · ')
                      : '仅无场域'
                }}
              </span>
            </span>
          </button>
        </div>

        <div v-else class="list-empty">
          <EmptyState
            :icon="icons.credentials"
            :title="isFiltered ? '暂无匹配的凭据' : '暂无凭据'"
            :description="
              isFiltered
                ? '可调整左侧筛选条件或搜索词。'
                : '新建凭据后，可在记忆正文里插入占位符，避免明文密码进入上下文。'
            "
          >
            <template #actions>
              <UButton
                v-if="isFiltered"
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.restore"
                @click="resetFilters"
              >
                清除筛选
              </UButton>
              <UButton v-else-if="hasMasterKey" size="sm" :icon="icons.add" @click="openCreate">
                新建凭据
              </UButton>
            </template>
          </EmptyState>
        </div>
      </div>
    </section>

    <!-- 右工作台 -->
    <section class="detail-col" aria-label="凭据详情">
      <div
        v-if="!isPhone"
        class="pane-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调节列表与详情宽度"
        :aria-valuenow="effectiveListWidth"
        :aria-valuemin="listMinWidth"
        :aria-valuemax="maxAllowedWidth"
        tabindex="0"
        title="拖动调节宽度，双击恢复默认"
        @pointerdown="startResize"
        @dblclick="resetListWidth"
        @keydown="onSplitterKeydown"
      />

      <CredentialWorkbench
        v-if="mode === 'new' || selectedCred"
        ref="workbenchRef"
        :mode="mode"
        :credential="selectedCred"
        :initial-kind="newFormInitialKind"
        :has-master-key="hasMasterKey"
        :known-realms="knownRealms"
        :api-keys="apiKeys"
        :references="references"
        :references-loading="referencesQuery.isPending.value"
        :references-error="referencesQuery.isError.value"
        :show-back="isPhone"
        @enter-edit="enterEdit"
        @cancel-form="onCancelForm"
        @saved="onSaved"
        @updated="onUpdated"
        @request-delete="openDeleteModal"
        @back="selectCredential(null)"
        @dirty-change="(d) => (formDirty = d)"
      />

      <div v-else class="detail-empty">
        <EmptyState
          :icon="icons.credentials"
          title="选择或新建一条凭据"
          description="从左侧目录与清单切换凭据，密码与令牌加密托管在 Kioku，记忆正文只写占位符。"
        >
          <template v-if="hasMasterKey" #actions>
            <UButton size="sm" :icon="icons.add" @click="openCreate">新建凭据</UButton>
          </template>
        </EmptyState>
      </div>
    </section>

    <!-- 窄屏左抽屉 -->
    <USlideover
      v-model:open="railOpen"
      side="left"
      title="凭据筛选"
      :ui="{
        content: 'max-w-72 sm:max-w-72',
        body: 'p-0 sm:p-0 flex flex-col min-h-0 overflow-hidden',
      }"
    >
      <template #body>
        <CredentialIndexRail
          :kind-filter="kindFilter"
          :realm-filter="realmFilter"
          :items="items"
          :known-realms="knownRealms"
          @update:kind-filter="onKindFilterChange"
          @update:realm-filter="onRealmFilterChange"
        />
      </template>
    </USlideover>

    <ConsequenceModal
      :open="deleting !== null"
      :title="`删除凭据 ${deleting?.slug ?? ''}？`"
      :consequences="deleteConsequences"
      action="确认删除"
      :action-icon="icons.remove"
      :busy="deleteBusy"
      :error="deleteError"
      @confirm="confirmDelete"
      @close="deleting = null"
    />
  </div>
</template>

<style scoped>
.credentials-shell {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: 216px var(--list-width, 336px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  width: 100%;
  max-width: 1840px;
  margin-inline: auto;
  min-width: 0;
  min-height: 0;
}
.credentials-shell.is-resizing {
  user-select: none;
  cursor: col-resize;
}
@media (min-width: 1841px) {
  .credentials-shell {
    border-inline: 1px solid var(--ui-border-muted);
  }
}
.rail-col {
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--ui-border-accented);
}
.list-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.list-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 46px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.search-wrap {
  flex: 1 1 0%;
  min-width: 0;
}
.list-subbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 30px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.subbar-summary strong {
  color: var(--ui-text-highlighted);
}
.subbar-reset {
  font-size: 12px;
  color: var(--ui-text);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.cred-list {
  display: flex;
  flex-direction: column;
}
.cred-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 11px 12px 11px 13px;
  border-bottom: 1px solid var(--ui-border);
  border-left: 3px solid transparent;
  text-align: left;
  cursor: pointer;
}
.cred-row:hover {
  background: var(--ui-bg-elevated);
}
.cred-row.is-scoped {
  border-left-color: var(--ui-info);
}
.cred-row.is-unscoped {
  border-left-color: var(--ui-warning);
}
.cred-row.is-selected {
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.cred-row.is-selected .row-kind-icon {
  color: var(--ui-on-selected);
}
.cred-row.is-selected .row-line-2 {
  color: var(--ui-on-selected-muted);
}
.row-line-1 {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.row-kind-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.row-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
.row-line-2 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-left: 21px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-muted);
}
.row-slug {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.list-empty {
  padding: 24px 16px;
}
.detail-col {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg);
}
.detail-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.pane-splitter {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -5px;
  z-index: 15;
  width: 9px;
  cursor: col-resize;
  touch-action: none;
}
.pane-splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: var(--ui-rule);
  opacity: 0;
  transition: opacity 140ms ease;
}
.pane-splitter:hover::after,
.pane-splitter:focus-visible::after,
.credentials-shell.is-resizing .pane-splitter::after {
  opacity: 1;
}
.pane-splitter:focus-visible {
  outline: 0;
}
@media (max-width: 1279.98px) {
  .credentials-shell {
    grid-template-columns: var(--list-width, 288px) minmax(0, 1fr);
    max-width: none;
  }
  .rail-col {
    display: none;
  }
}
@media (max-width: 767.98px) {
  .credentials-shell {
    grid-template-columns: minmax(0, 1fr);
  }
  .pane-splitter {
    display: none;
  }
  .list-col {
    border-right: 0;
  }
  .credentials-shell.has-selection .list-col {
    display: none;
  }
  .credentials-shell:not(.has-selection) .detail-col {
    display: none;
  }
}
</style>
