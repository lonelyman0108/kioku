<script setup lang="ts">
import {
  DREAM_KINDS,
  hasDuplicateLeadingHeading,
  stripDuplicateLeadingHeading,
  type ApplySuggestionRequest,
  type DreamSuggestionKind,
  type DreamSuggestionView,
  type TriggerDreamRequest,
} from '@kioku/contracts'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import DreamSuggestionCard from '../components/DreamSuggestionCard.vue'
import HygieneSweepDrawer from '../components/HygieneSweepDrawer.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import NoteLine from '../components/ui/NoteLine.vue'
import PageHead from '../components/ui/PageHead.vue'
import ReadFailureNote from '../components/ui/ReadFailureNote.vue'
import { useSession } from '../composables/useSession'
import { isTitleOnlyTidy } from '../diff'
import { icons } from '../icons'
import { dreamKindLabels, dreamOutcomeLabels } from '../labels'
import { entryRoute, settingsRoute } from '../routes'
import { formatRelative, formatTime } from '../time'

type KindFilter = 'all' | DreamSuggestionKind

const FILTER_ORDER: readonly DreamSuggestionKind[] = [
  'tidy',
  'distill_episode',
  'merge_duplicates',
  'update',
  'mark_stale',
]

const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()

const inboxQuery = useQuery({
  queryKey: ['inbox'] as const,
  queryFn: () => api.inbox(),
  refetchInterval: (query) => (query.state.data?.dreamState.running ? 3000 : false),
})

const data = computed(() => inboxQuery.data.value ?? null)
const items = computed(() => data.value?.items ?? [])
const tidyPendingCount = computed(() => data.value?.tidyPendingCount ?? 0)
const state = computed(() => data.value?.dreamState ?? null)
const progress = computed(() => state.value?.progress ?? null)
const progressPercent = computed(() =>
  progress.value && progress.value.total > 0
    ? Math.min(100, Math.round((progress.value.processed / progress.value.total) * 100))
    : 0,
)

const kindFilter = ref<KindFilter>('all')
const sweepOpen = ref(false)
const quickTableMode = ref(false)
const selectedTableIds = ref<string[]>([])
const batchBusy = ref(false)
const undoingKeys = new Set<string>()
const undoneKeys = new Set<string>()

const kindCounts = computed(() => {
  const counts: Record<KindFilter, number> = {
    all: items.value.length,
    tidy: 0,
    distill_episode: 0,
    merge_duplicates: 0,
    mark_stale: 0,
    update: 0,
  }
  for (const item of items.value) {
    counts[item.kind]++
  }
  return counts
})

const filterTabs = computed<{ value: KindFilter; label: string; count: number }[]>(() => [
  { value: 'all', label: '全部', count: kindCounts.value.all },
  ...FILTER_ORDER.filter((k) => DREAM_KINDS.includes(k)).map((k) => ({
    value: k as KindFilter,
    label: dreamKindLabels[k],
    count: kindCounts.value[k],
  })),
])

const filteredItems = computed(() =>
  kindFilter.value === 'all'
    ? items.value
    : items.value.filter((item) => item.kind === kindFilter.value),
)

const titleOnlyItems = computed(() => items.value.filter(isTitleOnlyTidy))
const canUseQuickTable = computed(() => titleOnlyItems.value.length >= 3)

watch(canUseQuickTable, (available) => {
  if (!available) quickTableMode.value = false
})

watch(quickTableMode, (enabled) => {
  if (enabled) {
    selectedTableIds.value = titleOnlyItems.value.map((item) => item.id)
  }
})

watch(titleOnlyItems, (list) => {
  if (!quickTableMode.value) return
  const validIds = new Set(list.map((item) => item.id))
  selectedTableIds.value = selectedTableIds.value.filter((id) => validIds.has(id))
})

function onFilterTabKeydown(event: KeyboardEvent, index: number) {
  const tabs = filterTabs.value
  if (!tabs.length) return
  let nextIdx = -1
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIdx = (index + 1) % tabs.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
    nextIdx = (index - 1 + tabs.length) % tabs.length
  else if (event.key === 'Home') nextIdx = 0
  else if (event.key === 'End') nextIdx = tabs.length - 1
  if (nextIdx < 0) return
  event.preventDefault()
  quickTableMode.value = false
  kindFilter.value = tabs[nextIdx]!.value
  const listEl = (event.currentTarget as HTMLElement | null)?.parentElement
  listEl?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIdx]?.focus()
}

const allTableSelected = computed(
  () =>
    titleOnlyItems.value.length > 0 &&
    selectedTableIds.value.length === titleOnlyItems.value.length,
)

function toggleTableAll() {
  if (allTableSelected.value) {
    selectedTableIds.value = []
  } else {
    selectedTableIds.value = titleOnlyItems.value.map((item) => item.id)
  }
}

function toggleTableRow(id: string) {
  if (selectedTableIds.value.includes(id)) {
    selectedTableIds.value = selectedTableIds.value.filter((x) => x !== id)
  } else {
    selectedTableIds.value = [...selectedTableIds.value, id]
  }
}

function baseEntryOf(suggestion: DreamSuggestionView) {
  if (suggestion.keepId) {
    return (
      suggestion.entries.find((e) => e.id === suggestion.keepId) ?? suggestion.entries[0] ?? null
    )
  }
  return suggestion.entries[0] ?? null
}

const triggeringMode = ref<'standard' | 'tidy' | null>(null)
const tidyBusy = computed(
  () =>
    triggeringMode.value === 'tidy' ||
    (Boolean(state.value?.running) && progress.value?.mode === 'tidy'),
)
const standardBusy = computed(
  () =>
    triggeringMode.value === 'standard' ||
    (Boolean(state.value?.running) && progress.value?.mode !== 'tidy'),
)
const tidyDisabled = computed(
  () =>
    !data.value ||
    !me.data.value?.hasChatModel ||
    Boolean(triggeringMode.value) ||
    Boolean(state.value?.running),
)

async function triggerDream(req: Partial<TriggerDreamRequest>) {
  if (triggeringMode.value || state.value?.running) return
  const mode = req.mode === 'tidy' ? 'tidy' : 'standard'
  triggeringMode.value = mode
  try {
    const res = await api.runDream(req)
    if (res.started) {
      const title =
        mode === 'tidy'
          ? req.all
            ? '已发起全部存量规范整理任务'
            : `已发起存量规范整理（本批 ${req.limit ?? 10} 条）`
          : '已发起整理任务'
      toast.add({ title, color: 'success' })
    } else {
      toast.add({ title: res.reason ?? '当前无需重复整理', color: 'neutral' })
    }
    await queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '触发整理失败', color: 'error' })
  } finally {
    triggeringMode.value = null
  }
}

const tidyMenuItems = computed<DropdownMenuItem[][]>(() => {
  const count = tidyPendingCount.value
  if (count <= 0) {
    return [[{ type: 'label', label: '当前暂无待规范存量' }]]
  }
  const actions: DropdownMenuItem[] = []
  if (count > 10) {
    actions.push({
      label: '整理本批 10 条',
      icon: icons.tidy,
      onSelect: () => void triggerDream({ mode: 'tidy', pinnedFirst: true, limit: 10 }),
    })
  }
  if (count > 20) {
    actions.push({
      label: '整理本批 20 条',
      icon: icons.tidy,
      onSelect: () => void triggerDream({ mode: 'tidy', pinnedFirst: true, limit: 20 }),
    })
  }
  actions.push({
    label: `整理全部待规范（${count} 条）`,
    icon: icons.listChecks,
    onSelect: () => void triggerDream({ mode: 'tidy', pinnedFirst: true, all: true }),
  })
  return [[{ type: 'label', label: `待规范存量 ${count} 条 · 常驻优先` }, ...actions]]
})

async function undoAppliedSuggestion(
  shortId: string,
  previousVersion: number,
  appliedVersion: number,
  title: string,
) {
  const key = `${shortId}:${appliedVersion}`
  if (undoingKeys.has(key) || undoneKeys.has(key)) return
  undoingKeys.add(key)
  try {
    const restored = await api.restoreEntry(shortId, {
      version: previousVersion,
      expectedVersion: appliedVersion,
    })
    undoneKeys.add(key)
    queryClient.setQueryData(['entry', shortId], restored)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      queryClient.invalidateQueries({ queryKey: ['entry-history', shortId] }),
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
    ])
    toast.add({
      title: `已撤销对「${title}」的应用，恢复至版本 ${previousVersion}`,
      color: 'success',
    })
  } catch (err) {
    toast.add({
      title:
        err instanceof ApiError && err.status === 409
          ? `「${title}」已有其他更新，无法自动撤销，请在版本历史中手动恢复`
          : err instanceof ApiError
            ? err.message
            : '撤销失败，请在版本历史中手动恢复',
      color: err instanceof ApiError && err.status === 409 ? 'warning' : 'error',
    })
  } finally {
    undoingKeys.delete(key)
  }
}

const busyId = ref<string | null>(null)
async function onApply(id: string, body: ApplySuggestionRequest) {
  if (busyId.value || batchBusy.value) return
  const suggestion = items.value.find((item) => item.id === id)
  busyId.value = id
  try {
    const res = await api.applySuggestion(id, body)
    const applied = res.entry
    // 合并重复会同时软删其他重复记忆，不支持单条恢复撤销，避免误导
    const canOfferUndo =
      suggestion?.kind !== 'merge_duplicates' &&
      applied &&
      applied.previousVersion !== undefined &&
      applied.version !== undefined
    if (canOfferUndo) {
      const { shortId, title, previousVersion, version } = applied
      toast.add({
        title: `已应用到「${title}」（版本 ${version}）`,
        color: 'success',
        duration: 8000,
        actions: [
          {
            label: '查看记忆',
            color: 'neutral',
            variant: 'outline',
            onClick: () => void router.push(entryRoute(shortId)),
          },
          {
            label: '撤销',
            color: 'neutral',
            variant: 'outline',
            onClick: () => void undoAppliedSuggestion(shortId, previousVersion!, version!, title),
          },
        ],
      })
    } else {
      toast.add({
        title: applied ? `已应用到「${applied.title}」` : '已应用整理建议',
        color: 'success',
      })
    }
    const affectedShortIds = new Set<string>([
      ...(applied ? [applied.shortId] : []),
      ...(suggestion?.entries.map((e) => e.shortId) ?? []),
    ])
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      ...[...affectedShortIds].flatMap((sid) => [
        queryClient.invalidateQueries({ queryKey: ['entry', sid] }),
        queryClient.invalidateQueries({ queryKey: ['entry-history', sid] }),
      ]),
    ])
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '应用失败', color: 'error' })
    if (err instanceof ApiError && err.status === 409) {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    }
  } finally {
    busyId.value = null
  }
}

async function onDismiss(id: string) {
  if (busyId.value || batchBusy.value) return
  busyId.value = id
  try {
    await api.dismissSuggestion(id)
    toast.add({ title: '已忽略建议', color: 'neutral' })
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '操作失败', color: 'error' })
  } finally {
    busyId.value = null
  }
}

async function applyQuickTableSelected() {
  if (batchBusy.value || busyId.value || !selectedTableIds.value.length) return
  batchBusy.value = true
  const chosen = titleOnlyItems.value.filter((item) => selectedTableIds.value.includes(item.id))
  const touchedShortIds = new Set<string>()
  let okCount = 0
  let failCount = 0
  for (const s of chosen) {
    const base = baseEntryOf(s)
    const nextSummary =
      s.proposedSummary !== undefined &&
      s.proposedSummary !== null &&
      s.proposedSummary.trim() !== (base?.summary?.trim() ?? '')
        ? s.proposedSummary.trim() || null
        : undefined
    const titleChanged = Boolean(
      s.proposedTitle?.trim() && base && s.proposedTitle.trim() !== base.title,
    )
    // 若更换标题或建议剥离了原正文重复首行 H1，同步剥离避免暴露失配旧 H1
    const shouldStripOldH1 =
      base !== null &&
      hasDuplicateLeadingHeading(base.title, base.content) &&
      (titleChanged ||
        (Boolean(s.proposedContent) && s.proposedContent!.trim() !== base.content.trim()))
    const safeContent = shouldStripOldH1
      ? stripDuplicateLeadingHeading(base.title, base.content)
      : base?.content
    const body: ApplySuggestionRequest = {
      ...(s.proposedTitle?.trim() ? { title: s.proposedTitle.trim() } : {}),
      ...(nextSummary !== undefined ? { summary: nextSummary } : {}),
      ...(safeContent !== undefined ? { content: safeContent } : {}),
      applyArchivedNotes: false,
      ...(s.proposedChangeSummary?.trim() ? { changeSummary: s.proposedChangeSummary.trim() } : {}),
    }
    try {
      const res = await api.applySuggestion(s.id, body)
      if (res.entry?.shortId) touchedShortIds.add(res.entry.shortId)
      if (base?.shortId) touchedShortIds.add(base.shortId)
      okCount++
    } catch {
      failCount++
    }
  }
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['inbox'] }),
    queryClient.invalidateQueries({ queryKey: ['entries'] }),
    ...[...touchedShortIds].flatMap((sid) => [
      queryClient.invalidateQueries({ queryKey: ['entry', sid] }),
      queryClient.invalidateQueries({ queryKey: ['entry-history', sid] }),
    ]),
  ])
  if (failCount === 0) {
    toast.add({
      title: `已批量应用 ${okCount} 条标题与概要规范建议`,
      color: 'success',
    })
  } else {
    toast.add({
      title: `批量应用完成：成功 ${okCount} 条，失败 ${failCount} 条`,
      color: okCount > 0 ? 'warning' : 'error',
    })
  }
  batchBusy.value = false
}
</script>

<template>
  <div class="inbox-page">
    <div class="inbox-shell">
      <PageHead title="待处理">
        <template #note>
          整理任务提出的规范与精简、提炼摘要、合并重复、标记过时与更新建议，确认后才会写入记忆。
        </template>
        <template #actions>
          <UButton
            :icon="icons.refresh"
            size="sm"
            color="neutral"
            variant="ghost"
            :loading="inboxQuery.isFetching.value"
            @click="inboxQuery.refetch()"
          >
            刷新
          </UButton>
          <UButton
            :icon="icons.shieldCheck"
            size="sm"
            color="neutral"
            variant="outline"
            @click="sweepOpen = true"
          >
            结构体检与预清洗
          </UButton>
          <UDropdownMenu
            :items="tidyMenuItems"
            :disabled="tidyDisabled"
            :content="{ align: 'end' }"
            :ui="{ content: 'min-w-52' }"
          >
            <UButton
              :icon="icons.tidy"
              :trailing-icon="icons.chevronDown"
              size="sm"
              color="neutral"
              variant="outline"
              :loading="tidyBusy"
              :disabled="tidyDisabled"
            >
              {{ tidyPendingCount > 0 ? `存量规范整理（${tidyPendingCount}）` : '存量规范整理' }}
            </UButton>
          </UDropdownMenu>
          <UButton
            :icon="icons.sparkles"
            size="sm"
            :loading="standardBusy"
            :disabled="
              !me.data.value?.hasChatModel || Boolean(triggeringMode) || Boolean(state?.running)
            "
            @click="triggerDream({ mode: 'standard' })"
          >
            {{ state?.running ? '整理中' : '立即整理' }}
          </UButton>
        </template>
      </PageHead>

      <div class="inbox-body">
        <ReadFailureNote v-if="inboxQuery.isError.value" :query="inboxQuery" />

        <NoteLine v-if="me.data.value && !me.data.value.hasChatModel" tone="warning">
          尚未配置对话与整理模型，自动摘要与智能整理未启用；仍可使用「结构体检与预清洗」执行确定性结构修复。
          <template #actions>
            <UButton size="sm" color="neutral" variant="outline" :to="settingsRoute('models')">
              去配置模型
            </UButton>
          </template>
        </NoteLine>

        <div class="inbox-workspace">
          <!-- 左侧整理状态与分类筛选轨（宽屏固定侧栏，窄屏收敛至主区上方） -->
          <aside class="inbox-rail" aria-label="整理状态与建议筛选">
            <section class="rail-card">
              <div class="rail-card-head">
                <span class="rail-card-title">整理状态</span>
                <span
                  v-if="state"
                  class="rail-state-tag"
                  :class="{ 'is-active': state.running || state.enabled }"
                >
                  {{ state.running ? '整理中' : state.enabled ? '定时开启' : '定时关闭' }}
                </span>
              </div>

              <dl class="rail-stats">
                <div class="rail-stat-row">
                  <dt>待处理建议</dt>
                  <dd class="tabular-nums" :class="{ 'is-count-hot': items.length > 0 }">
                    {{ items.length }} 条
                  </dd>
                </div>
                <div v-if="data" class="rail-stat-row">
                  <dt>待规范存量</dt>
                  <dd class="tabular-nums">{{ tidyPendingCount }} 条</dd>
                </div>
                <div v-if="state" class="rail-stat-row">
                  <dt>定时整理</dt>
                  <dd>{{ state.enabled ? `每 ${state.intervalHours} 小时` : '已关闭' }}</dd>
                </div>
                <div v-if="state" class="rail-stat-row">
                  <dt>上次整理</dt>
                  <dd>
                    <span v-if="state.running" class="text-highlighted font-medium">正在整理…</span>
                    <template v-else-if="state.lastRunAt">
                      <time :datetime="state.lastRunAt" :title="formatTime(state.lastRunAt)">
                        {{ formatRelative(state.lastRunAt) }}
                      </time>
                      <span v-if="state.lastOutcome" class="rail-outcome">
                        （{{ dreamOutcomeLabels[state.lastOutcome] }}）
                      </span>
                    </template>
                    <span v-else>尚未执行过</span>
                  </dd>
                </div>
                <div v-if="me.data.value" class="rail-stat-row">
                  <dt>对话模型</dt>
                  <dd>
                    <span v-if="me.data.value.hasChatModel">已启用</span>
                    <RouterLink v-else :to="settingsRoute('models')" class="text-primary">
                      未配置
                    </RouterLink>
                  </dd>
                </div>
              </dl>

              <div v-if="state?.running" class="rail-progress" role="status" aria-live="polite">
                <div class="rail-progress-head">
                  <span>{{ progress?.mode === 'tidy' ? '存量规范整理中' : '后台整理中' }}</span>
                  <span v-if="progress && progress.total > 0" class="tabular-nums">
                    {{ progress.processed }} / {{ progress.total }} 条
                  </span>
                </div>
                <div
                  v-if="progress && progress.total > 0"
                  class="rail-progress-track"
                  role="progressbar"
                  aria-label="整理进度"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  :aria-valuenow="progressPercent"
                >
                  <div class="rail-progress-fill" :style="{ width: `${progressPercent}%` }" />
                </div>
                <p v-if="progress" class="rail-progress-meta tabular-nums">
                  已生成 {{ progress.suggested }} 条建议<template v-if="progress.failed > 0"
                    >，失败 {{ progress.failed }} 条</template
                  >
                </p>
                <p v-else class="rail-progress-meta">任务已入队，正在准备候选记忆…</p>
              </div>

              <p
                v-if="!state?.running && state?.lastError"
                class="rail-error"
                :class="{ 'is-partial': state.lastOutcome === 'partial' }"
              >
                {{ state.lastOutcome === 'partial' ? state.lastError : `错误：${state.lastError}` }}
              </p>
            </section>

            <!-- 建议类型分段筛选与纯标题速审表切换 -->
            <section v-if="items.length" class="rail-filter-card">
              <div class="rail-card-head">
                <span class="rail-card-title">建议分类</span>
              </div>
              <div class="kind-tabs" role="tablist" aria-label="按建议类型筛选">
                <button
                  v-for="(tab, idx) in filterTabs"
                  :key="tab.value"
                  type="button"
                  role="tab"
                  class="kind-tab"
                  :class="{ active: !quickTableMode && kindFilter === tab.value }"
                  :aria-selected="!quickTableMode && kindFilter === tab.value"
                  :tabindex="
                    (!quickTableMode && kindFilter === tab.value) || (quickTableMode && idx === 0)
                      ? 0
                      : -1
                  "
                  @click="((quickTableMode = false), (kindFilter = tab.value))"
                  @keydown="onFilterTabKeydown($event, idx)"
                >
                  <span>{{ tab.label }}</span>
                  <span class="kind-tab-num tabular-nums">{{ tab.count }}</span>
                </button>
              </div>

              <div v-if="canUseQuickTable" class="rail-quick-switch">
                <UButton
                  size="xs"
                  :color="quickTableMode ? 'primary' : 'neutral'"
                  :variant="quickTableMode ? 'solid' : 'outline'"
                  :icon="icons.table"
                  block
                  @click="quickTableMode = !quickTableMode"
                >
                  {{
                    quickTableMode ? '返回卡片视图' : `纯标题速审表（${titleOnlyItems.length} 条）`
                  }}
                </UButton>
              </div>
            </section>
          </aside>

          <!-- 右侧主审阅流 -->
          <div class="inbox-main">
            <div v-if="inboxQuery.isPending.value" class="space-y-4">
              <USkeleton v-for="n in 3" :key="n" class="h-36 w-full" />
            </div>

            <!-- 纯标题速审表 -->
            <section v-else-if="quickTableMode && canUseQuickTable" class="quick-table-panel">
              <div class="quick-table-head">
                <span class="text-xs text-muted">
                  以下建议仅调整标题或现行概要，不改动正文主体；原有内容保留在版本历史中，可随时恢复。
                </span>
                <div class="quick-table-actions">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :disabled="batchBusy"
                    @click="toggleTableAll"
                  >
                    {{ allTableSelected ? '取消全选' : '全选' }}
                  </UButton>
                  <UButton
                    size="xs"
                    :icon="icons.listChecks"
                    :loading="batchBusy"
                    :disabled="!selectedTableIds.length || busyId !== null"
                    @click="applyQuickTableSelected"
                  >
                    批量应用所选（{{ selectedTableIds.length }} 条）
                  </UButton>
                </div>
              </div>

              <div class="quick-table-scroll">
                <table class="quick-table">
                  <thead>
                    <tr>
                      <th class="col-check">
                        <input
                          type="checkbox"
                          aria-label="全选纯标题规范建议"
                          :checked="allTableSelected"
                          :disabled="batchBusy"
                          @change="toggleTableAll"
                        />
                      </th>
                      <th>记忆</th>
                      <th>旧标题 → 新短标题与现行概要</th>
                      <th class="col-ops">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="s in titleOnlyItems" :key="s.id">
                      <td class="col-check">
                        <input
                          type="checkbox"
                          :aria-label="`选择 ${baseEntryOf(s)?.title ?? s.id}`"
                          :checked="selectedTableIds.includes(s.id)"
                          :disabled="batchBusy"
                          @change="toggleTableRow(s.id)"
                        />
                      </td>
                      <td class="col-entry">
                        <RouterLink
                          v-if="baseEntryOf(s)"
                          :to="entryRoute(baseEntryOf(s)!.shortId)"
                          class="text-primary font-mono text-xs"
                        >
                          {{ baseEntryOf(s)!.shortId }}
                        </RouterLink>
                        <span v-if="baseEntryOf(s)?.isPinned" class="mini-pill">常驻</span>
                      </td>
                      <td class="col-diff">
                        <div class="table-title-diff">
                          <span class="table-old">{{ baseEntryOf(s)?.title }}</span>
                          <UIcon :name="icons.inherits" class="table-arrow" aria-hidden="true" />
                          <span class="table-new">{{
                            s.proposedTitle ?? baseEntryOf(s)?.title
                          }}</span>
                        </div>
                        <p v-if="s.proposedSummary?.trim()" class="table-summary">
                          概要：{{ s.proposedSummary }}
                        </p>
                      </td>
                      <td class="col-ops">
                        <UButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          :disabled="batchBusy || busyId !== null"
                          @click="onDismiss(s.id)"
                        >
                          忽略
                        </UButton>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <!-- 常规卡片列表 -->
            <div v-else-if="filteredItems.length" class="card-list">
              <DreamSuggestionCard
                v-for="item in filteredItems"
                :key="item.id"
                :suggestion="item"
                :busy="busyId === item.id"
                :disabled="batchBusy || (busyId !== null && busyId !== item.id)"
                @apply="onApply"
                @dismiss="onDismiss"
              />
            </div>

            <div v-else-if="items.length && !filteredItems.length" class="empty-frame">
              <EmptyState
                title="该分类暂无待处理建议"
                description="可切换其他建议分类，或查看全部待处理建议。"
              >
                <template #actions>
                  <UButton size="sm" color="neutral" variant="outline" @click="kindFilter = 'all'">
                    查看全部
                  </UButton>
                </template>
              </EmptyState>
            </div>

            <div v-else-if="!inboxQuery.isError.value" class="empty-frame">
              <EmptyState
                title="暂无待处理建议"
                description="会话摘要与记忆库变动累积后，定时整理或手动触发会在此生成建议。"
              >
                <template #actions>
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="outline"
                    :icon="icons.shieldCheck"
                    @click="sweepOpen = true"
                  >
                    结构体检与预清洗
                  </UButton>
                  <UDropdownMenu
                    v-if="me.data.value?.hasChatModel"
                    :items="tidyMenuItems"
                    :disabled="tidyDisabled"
                    :content="{ align: 'center' }"
                    :ui="{ content: 'min-w-52' }"
                  >
                    <UButton
                      size="sm"
                      color="neutral"
                      variant="outline"
                      :icon="icons.tidy"
                      :trailing-icon="icons.chevronDown"
                      :loading="tidyBusy"
                      :disabled="tidyDisabled"
                    >
                      {{
                        tidyPendingCount > 0
                          ? `存量规范整理（${tidyPendingCount}）`
                          : '存量规范整理'
                      }}
                    </UButton>
                  </UDropdownMenu>
                  <UButton
                    v-if="me.data.value?.hasChatModel"
                    size="sm"
                    variant="outline"
                    :icon="icons.sparkles"
                    :loading="standardBusy"
                    :disabled="Boolean(triggeringMode) || Boolean(state?.running)"
                    @click="triggerDream({ mode: 'standard' })"
                  >
                    {{ state?.running ? '整理中' : '立即整理' }}
                  </UButton>
                </template>
              </EmptyState>
            </div>
          </div>
        </div>
      </div>
    </div>

    <HygieneSweepDrawer v-model:open="sweepOpen" />
  </div>
</template>

<style scoped>
.inbox-page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.inbox-shell {
  width: 100%;
  max-width: 80rem;
  margin-inline: auto;
}
.inbox-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 32px 48px;
}
.inbox-workspace {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  gap: 28px;
  align-items: start;
}
.inbox-rail {
  position: sticky;
  top: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rail-card,
.rail-filter-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
}
.rail-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-rule);
}
.rail-card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.rail-state-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
}
.rail-state-tag.is-active {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.rail-stats {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
}
.rail-stat-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.rail-stat-row dt {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.rail-stat-row dd {
  min-width: 0;
  text-align: right;
  color: var(--ui-text);
  overflow-wrap: anywhere;
}
.rail-stat-row dd.is-count-hot {
  font-weight: 600;
  color: var(--ui-error);
}
.rail-outcome {
  color: var(--ui-text-muted);
}
.rail-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg);
}
.rail-progress-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.rail-progress-track {
  height: 4px;
  background: var(--ui-border);
  overflow: hidden;
}
.rail-progress-fill {
  height: 100%;
  background: var(--ui-rule);
  transition: width 180ms ease;
}
.rail-progress-meta {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
}
.rail-error {
  padding: 6px 8px;
  border: 1px solid var(--ui-error);
  background: var(--ui-bg);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-error);
  overflow-wrap: anywhere;
}
.rail-error.is-partial {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.rail-quick-switch {
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
}
.inbox-main {
  min-width: 0;
}
.empty-frame {
  border: 1px dashed var(--ui-border-accented);
  background: var(--ui-bg-bright);
  padding: 12px 16px;
}
.kind-tabs {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kind-tab {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-left: 2px solid transparent;
  font-size: 13px;
  color: var(--ui-text-muted);
  white-space: nowrap;
  cursor: pointer;
}
.kind-tab:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.kind-tab:hover .kind-tab-num {
  color: var(--ui-text-muted);
}
.kind-tab.active {
  border-left-color: var(--ui-rule);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
  font-weight: 500;
}
.kind-tab-num {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.kind-tab.active .kind-tab-num,
.kind-tab.active:hover .kind-tab-num {
  color: var(--ui-on-selected-muted);
}
.quick-table-panel {
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg);
}
.quick-table-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.quick-table-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.quick-table-scroll {
  overflow-x: auto;
}
.quick-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.quick-table th,
.quick-table td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
  vertical-align: top;
}
.quick-table th {
  border-bottom-color: var(--ui-rule);
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.quick-table tr:last-child td {
  border-bottom: 0;
}
.col-check {
  width: 34px;
}
.col-check input[type='checkbox'] {
  accent-color: var(--ui-primary);
}
.col-entry {
  white-space: nowrap;
}
.col-ops {
  width: 64px;
  white-space: nowrap;
}
.mini-pill {
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  line-height: 1.35;
}
.table-title-diff {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 6px;
  line-height: 1.5;
}
.table-old {
  color: var(--ui-text-muted);
  text-decoration: line-through;
  overflow-wrap: anywhere;
}
.table-arrow {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-dimmed);
}
.table-new {
  font-weight: 600;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.table-summary {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.card-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
@media (max-width: 1023.98px) {
  .inbox-body {
    padding: 0 16px 36px;
  }
  .inbox-workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .inbox-rail {
    position: static;
  }
  .kind-tabs {
    flex-direction: row;
    overflow-x: auto;
    gap: 0;
    border: 1px solid var(--ui-border-accented);
  }
  .kind-tab {
    width: auto;
    height: 28px;
    padding: 0 10px;
    border-left: 0;
    border-right: 1px solid var(--ui-border);
  }
  .kind-tab:last-child {
    border-right: 0;
  }
}
</style>
