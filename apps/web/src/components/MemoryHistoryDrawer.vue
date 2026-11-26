<script setup lang="ts">
import {
  stripDuplicateLeadingHeading,
  type EntryDetailResponse,
  type EntryHistoryItem,
  type EntrySnapshot,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import {
  collapseUnchanged,
  diffEntrySnapshots,
  diffLines,
  type DiffLine,
  type DiffRow,
  type SnapshotFieldChange,
} from '../diff'
import { icons } from '../icons'
import {
  entryFieldLabel,
  eventTypeLabels,
  formatActorLabel,
  resolveActorDisplay,
  type ActorFilterGroup,
} from '../labels'
import { formatRelative, formatShort, formatTime } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import MemoryContent from './MemoryContent.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import EmptyState from './ui/EmptyState.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'

type SourceFilter = 'all' | ActorFilterGroup

const SOURCE_FILTER_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'self', label: '本人' },
  { value: 'agent', label: 'Agent' },
  { value: 'dream', label: '后台整理' },
]

const props = withDefaults(
  defineProps<{
    shortId: string
    currentVersion: number
    isDeleted: boolean
    focusEventId?: number | null
  }>(),
  { focusEventId: null },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ restored: [detail: EntryDetailResponse] }>()

const toast = useToast()
const queryClient = useQueryClient()

const history = useQuery({
  queryKey: computed(() => ['entry-history', props.shortId] as const),
  queryFn: ({ queryKey: [, sid] }) => api.entryHistory(sid, { includeSnapshots: true }),
  enabled: open,
})

const items = computed(() => history.data.value?.items ?? [])
const searchInput = ref('')
const sourceFilter = ref<SourceFilter>('all')
const expandedId = ref<number | null>(null)
const previewId = ref<number | null>(null)
const selectedCompareIds = ref<number[]>([])
const compareOpen = ref(false)
const listRef = ref<HTMLElement | null>(null)

const restoringItem = ref<EntryHistoryItem | null>(null)
const restoring = ref(false)
const restoreError = ref<string | null>(null)

function itemVersion(item: EntryHistoryItem): number | null {
  if (item.eventType === 'archive_note') return null
  return item.version ?? item.snapshot?.version ?? null
}

function itemTimestamp(item: EntryHistoryItem): string {
  return item.occurredAt ?? item.createdAt
}

interface ComputedItemDiff {
  previousSnapshot: EntrySnapshot | null
  fieldChanges: SnapshotFieldChange[]
  rawLines: DiffLine[]
  rows: DiffRow[]
  hasContentDiff: boolean
}

// 预计算每条带快照记录与前一个快照的差异（跳过无快照的归档记录）
const diffMap = computed(() => {
  const map = new Map<number, ComputedItemDiff>()
  const list = items.value
  for (let i = 0; i < list.length; i++) {
    const curr = list[i]!
    if (!curr.snapshot) continue
    let prevSnap: EntrySnapshot | null = null
    for (let j = i + 1; j < list.length; j++) {
      if (list[j]?.snapshot) {
        prevSnap = list[j]!.snapshot!
        break
      }
    }
    const fieldChanges = diffEntrySnapshots(prevSnap, curr.snapshot)
    const rawLines: DiffLine[] = prevSnap
      ? diffLines(prevSnap.content, curr.snapshot.content)
      : curr.snapshot.content
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((text): DiffLine => ({ kind: 'add', text }))
    const hasContentDiff = rawLines.some((line) => line.kind === 'add' || line.kind === 'remove')
    const rows = hasContentDiff ? collapseUnchanged(rawLines) : []
    map.set(curr.id, {
      previousSnapshot: prevSnap,
      fieldChanges,
      rawLines,
      rows,
      hasContentDiff,
    })
  }
  return map
})

function summaryTextOf(item: EntryHistoryItem): string {
  const explicit = item.changeSummary?.trim()
  if (explicit) return explicit
  const fields = item.diffMeta?.changedFields ?? []
  if (fields.length > 0) {
    return `${eventTypeLabels[item.eventType]}：${fields.map(entryFieldLabel).join('、')}`
  }
  return eventTypeLabels[item.eventType]
}

function charDeltaText(item: EntryHistoryItem): string | null {
  const meta = item.diffMeta
  if (!meta) return null
  const delta = meta.contentCharsAfter - meta.contentCharsBefore
  if (delta === 0) return null
  return delta > 0 ? `+${delta} 字` : `−${Math.abs(delta)} 字`
}

const filteredItems = computed(() => {
  const q = searchInput.value.trim().toLowerCase()
  const filter = sourceFilter.value
  return items.value.filter((item) => {
    const actor = resolveActorDisplay(item.actor, item.actorMeta)
    if (filter !== 'all' && actor.group !== filter) return false
    if (!q) return true
    if (item.changeSummary?.toLowerCase().includes(q)) return true
    if (item.snapshot?.title.toLowerCase().includes(q)) return true
    if (actor.label.toLowerCase().includes(q)) return true
    if (eventTypeLabels[item.eventType].toLowerCase().includes(q)) return true
    const computedDiff = diffMap.value.get(item.id)
    if (computedDiff) {
      if (
        computedDiff.fieldChanges.some(
          (fc) =>
            fc.label.toLowerCase().includes(q) ||
            fc.before.toLowerCase().includes(q) ||
            fc.after.toLowerCase().includes(q),
        )
      ) {
        return true
      }
      if (
        computedDiff.rawLines.some(
          (line) => line.kind !== 'same' && line.text.toLowerCase().includes(q),
        )
      ) {
        return true
      }
    }
    return false
  })
})

function toggleCompare(itemId: number) {
  const list = selectedCompareIds.value
  const idx = list.indexOf(itemId)
  if (idx >= 0) {
    selectedCompareIds.value = list.filter((id) => id !== itemId)
    if (selectedCompareIds.value.length < 2) compareOpen.value = false
    return
  }
  if (list.length >= 2) {
    selectedCompareIds.value = [list[1]!, itemId]
  } else {
    selectedCompareIds.value = [...list, itemId]
  }
}

function clearCompare() {
  selectedCompareIds.value = []
  compareOpen.value = false
}

const comparePair = computed<{
  older: EntryHistoryItem & { snapshot: EntrySnapshot }
  newer: EntryHistoryItem & { snapshot: EntrySnapshot }
  fieldChanges: SnapshotFieldChange[]
  rows: DiffRow[]
  hasContentDiff: boolean
} | null>(() => {
  if (selectedCompareIds.value.length !== 2) return null
  const [idA, idB] = selectedCompareIds.value
  const foundA = items.value.find((x) => x.id === idA && x.snapshot)
  const foundB = items.value.find((x) => x.id === idB && x.snapshot)
  if (!foundA?.snapshot || !foundB?.snapshot) return null
  const a = foundA as EntryHistoryItem & { snapshot: EntrySnapshot }
  const b = foundB as EntryHistoryItem & { snapshot: EntrySnapshot }
  const older =
    a.snapshot.version < b.snapshot.version ||
    (a.snapshot.version === b.snapshot.version && a.id < b.id)
      ? a
      : b
  const newer = older === a ? b : a
  const fieldChanges = diffEntrySnapshots(older.snapshot, newer.snapshot)
  const rawLines = diffLines(older.snapshot.content, newer.snapshot.content)
  const hasContentDiff = rawLines.some((line) => line.kind === 'add' || line.kind === 'remove')
  const rows = hasContentDiff ? collapseUnchanged(rawLines) : []
  return { older, newer, fieldChanges, rows, hasContentDiff }
})

const selectedCompareLabels = computed(() =>
  selectedCompareIds.value
    .map((id) => items.value.find((x) => x.id === id))
    .filter((x): x is EntryHistoryItem => Boolean(x))
    .map((x) => {
      const ver = itemVersion(x)
      return ver !== null ? `版本 ${ver}` : eventTypeLabels[x.eventType]
    }),
)

const appliedFocusId = ref<number | null>(null)

watch(
  [open, () => props.focusEventId, items],
  async ([isOpen, targetId, list]) => {
    if (!isOpen) return
    if (!targetId || !list.length || appliedFocusId.value === targetId) return
    const target = list.find((item) => item.id === targetId)
    if (!target) return
    appliedFocusId.value = targetId
    searchInput.value = ''
    sourceFilter.value = 'all'
    if (target.snapshot) expandedId.value = target.id
    await nextTick()
    const rowEl = listRef.value?.querySelector<HTMLElement>(`[data-history-id="${target.id}"]`)
    rowEl?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true },
)

watch(open, (visible) => {
  if (!visible) {
    compareOpen.value = false
    selectedCompareIds.value = []
    previewId.value = null
    expandedId.value = null
    searchInput.value = ''
    sourceFilter.value = 'all'
    appliedFocusId.value = null
  }
})

async function confirmRestore() {
  const target = restoringItem.value
  const version = target ? itemVersion(target) : null
  if (!target || version === null || restoring.value) return
  restoring.value = true
  restoreError.value = null
  try {
    const detail = await api.restoreEntry(props.shortId, {
      version,
      expectedVersion: props.currentVersion,
    })
    restoringItem.value = null
    toast.add({ title: `已恢复到版本 ${version}`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', props.shortId] })
    emit('restored', detail)
    open.value = false
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      void queryClient.invalidateQueries({ queryKey: ['entry', props.shortId] })
      void queryClient.invalidateQueries({ queryKey: ['entry-history', props.shortId] })
    }
    restoreError.value = err instanceof ApiError ? err.message : '恢复失败，请重试'
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    title="版本历史"
    :ui="{ content: 'max-w-2xl sm:max-w-2xl' }"
  >
    <template #body>
      <ReadFailureNote v-if="history.isError.value" :query="history" />
      <div v-else-if="history.isPending.value" class="space-y-3">
        <USkeleton v-for="n in 4" :key="n" class="h-16 w-full" />
      </div>
      <EmptyState v-else-if="!items.length" title="暂无历史记录" />
      <div v-else class="history-shell">
        <!-- 顶部关键词搜索与来源筛选 -->
        <div class="history-controls">
          <div class="history-search">
            <UInput
              v-model="searchInput"
              size="sm"
              :icon="icons.search"
              placeholder="搜索变更说明、标题或改动行"
              aria-label="搜索历史记录"
              class="w-full"
            >
              <template v-if="searchInput" #trailing>
                <UButton
                  :icon="icons.cancel"
                  size="xs"
                  color="neutral"
                  variant="link"
                  aria-label="清除历史搜索"
                  @click="searchInput = ''"
                />
              </template>
            </UInput>
          </div>
          <SegmentedChoice
            v-model="sourceFilter"
            :items="SOURCE_FILTER_OPTIONS"
            label="按操作来源筛选"
          />
        </div>

        <!-- 两版对比操作条 -->
        <div v-if="selectedCompareIds.length" class="compare-bar">
          <span class="compare-status">
            <template v-if="selectedCompareIds.length === 1">
              已选 {{ selectedCompareLabels[0] }}，再勾选 1 个版本即可对比
            </template>
            <template v-else> 已选 {{ selectedCompareLabels.join(' 与 ') }} </template>
          </span>
          <div class="compare-actions">
            <UButton
              v-if="comparePair"
              size="xs"
              :icon="icons.compare"
              :aria-expanded="compareOpen"
              @click="compareOpen = !compareOpen"
            >
              {{ compareOpen ? '收起两版对比' : '对比两版' }}
            </UButton>
            <UButton size="xs" color="neutral" variant="ghost" @click="clearCompare">
              清除选择
            </UButton>
          </div>
        </div>

        <!-- 两版对比详情 -->
        <section v-if="compareOpen && comparePair" class="compare-panel" aria-label="两版对比">
          <header class="compare-panel-head">
            <span class="font-mono text-xs font-semibold">
              版本 {{ comparePair.older.snapshot.version }} → 版本
              {{ comparePair.newer.snapshot.version }}
            </span>
            <UButton size="xs" color="neutral" variant="ghost" @click="compareOpen = false">
              关闭对比
            </UButton>
          </header>

          <div v-if="comparePair.fieldChanges.length" class="attr-diff-wrap">
            <div class="subpanel-label">属性变动</div>
            <table class="attr-table">
              <thead>
                <tr>
                  <th>属性</th>
                  <th>改前</th>
                  <th>改后</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="fc in comparePair.fieldChanges" :key="fc.field">
                  <td class="attr-name">{{ fc.label }}</td>
                  <td class="attr-before">{{ fc.before }}</td>
                  <td class="attr-after">{{ fc.after }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <pre v-if="comparePair.hasContentDiff" class="history-diff"><template
            v-for="(row, rowIdx) in comparePair.rows"
            :key="rowIdx"
          ><span v-if="row.kind === 'skip'" class="diff-skip">… 省略未改动的 {{ row.count }} 行</span><span v-else class="diff-line" :class="row.kind">{{ row.text }}</span></template></pre>
          <p v-else-if="comparePair.fieldChanges.length" class="diff-empty-note">正文未改动</p>
          <p v-else class="diff-empty-note">两版本属性与正文完全一致</p>
        </section>

        <!-- 历史时间线 -->
        <EmptyState
          v-if="!filteredItems.length"
          title="暂无匹配的历史记录"
          description="尝试调整关键词或切换操作来源筛选。"
        >
          <template #actions>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              @click="((searchInput = ''), (sourceFilter = 'all'))"
            >
              重置筛选
            </UButton>
          </template>
        </EmptyState>

        <ol v-else ref="listRef" class="history-list">
          <li
            v-for="item in filteredItems"
            :key="item.id"
            :data-history-id="item.id"
            class="history-row"
            :class="{
              'is-archive': item.eventType === 'archive_note',
              'is-focused': focusEventId === item.id,
            }"
          >
            <div class="history-head">
              <div class="head-badges">
                <span v-if="itemVersion(item) !== null" class="version-tag font-mono">
                  版本 {{ itemVersion(item) }}
                </span>
                <span v-else class="archive-tag">历史归档</span>
                <span v-if="item.eventType !== 'archive_note'" class="event-kind">{{
                  eventTypeLabels[item.eventType]
                }}</span>
                <span v-if="itemVersion(item) === currentVersion && !isDeleted" class="current-tag">
                  当前
                </span>
                <span v-if="charDeltaText(item)" class="char-delta tabular-nums">
                  {{ charDeltaText(item) }}
                </span>
              </div>
              <time
                class="text-xs text-muted"
                :datetime="itemTimestamp(item)"
                :title="formatTime(itemTimestamp(item))"
              >
                {{ formatRelative(itemTimestamp(item)) }}
              </time>
            </div>

            <p class="change-summary">{{ summaryTextOf(item) }}</p>

            <p class="actor-line">
              <span class="actor-badge">{{ formatActorLabel(item.actor, item.actorMeta) }}</span>
              <template v-if="item.snapshot?.title">
                <span class="meta-sep" aria-hidden="true">·</span>
                <span class="snapshot-title">{{ item.snapshot.title }}</span>
              </template>
              <template v-if="item.occurredAt && item.occurredAt !== item.createdAt">
                <span class="meta-sep" aria-hidden="true">·</span>
                <span>原记录时间 {{ formatShort(item.occurredAt) }}</span>
              </template>
            </p>

            <div v-if="item.snapshot" class="history-actions">
              <label class="compare-check">
                <input
                  type="checkbox"
                  :checked="selectedCompareIds.includes(item.id)"
                  @change="toggleCompare(item.id)"
                />
                <span>选入对比</span>
              </label>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :icon="expandedId === item.id ? icons.up : icons.down"
                :aria-expanded="expandedId === item.id"
                @click="
                  ((expandedId = expandedId === item.id ? null : item.id),
                  previewId === item.id && expandedId === item.id ? (previewId = null) : null)
                "
              >
                {{ expandedId === item.id ? '收起对比' : '查看改动' }}
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.bookOpen"
                :aria-expanded="previewId === item.id"
                @click="
                  ((previewId = previewId === item.id ? null : item.id),
                  expandedId === item.id && previewId === item.id ? (expandedId = null) : null)
                "
              >
                {{ previewId === item.id ? '收起快照' : '预览快照' }}
              </UButton>
              <UButton
                v-if="!isDeleted && item.snapshot.version !== currentVersion"
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.restore"
                @click="((restoringItem = item), (restoreError = null))"
              >
                恢复此版本
              </UButton>
            </div>

            <!-- 展开：属性变动表 + 正文行级对比 -->
            <div v-if="item.snapshot && expandedId === item.id" class="diff-section">
              <div v-if="diffMap.get(item.id)?.fieldChanges.length" class="attr-diff-wrap">
                <div class="subpanel-label">属性变动</div>
                <table class="attr-table">
                  <thead>
                    <tr>
                      <th>属性</th>
                      <th>改前</th>
                      <th>改后</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="fc in diffMap.get(item.id)!.fieldChanges" :key="fc.field">
                      <td class="attr-name">{{ fc.label }}</td>
                      <td class="attr-before">{{ fc.before }}</td>
                      <td class="attr-after">{{ fc.after }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <pre v-if="diffMap.get(item.id)?.hasContentDiff" class="history-diff"><template
                v-for="(row, rowIdx) in diffMap.get(item.id)!.rows"
                :key="rowIdx"
              ><span v-if="row.kind === 'skip'" class="diff-skip">… 省略未改动的 {{ row.count }} 行</span><span v-else class="diff-line" :class="row.kind">{{ row.text }}</span></template></pre>
              <p v-else-if="diffMap.get(item.id)?.fieldChanges.length" class="diff-empty-note">
                正文未改动
              </p>
              <p v-else class="diff-empty-note">本次操作未产生属性或正文差异</p>
            </div>

            <!-- 展开：快照 Markdown 预览 -->
            <div v-if="item.snapshot && previewId === item.id" class="snapshot-preview">
              <div class="snapshot-preview-head">
                <span class="font-medium">{{ item.snapshot.title }}</span>
                <span class="font-mono text-xs text-muted">
                  版本 {{ item.snapshot.version }} ·
                  {{ item.snapshot.isPinned ? '常驻' : '按需' }}
                </span>
              </div>
              <div v-if="item.snapshot.summary?.trim()" class="snapshot-summary">
                <span class="snapshot-summary-label">现行概要</span>
                <p>{{ item.snapshot.summary }}</p>
              </div>
              <div class="snapshot-body">
                <MemoryContent
                  :content="
                    stripDuplicateLeadingHeading(item.snapshot.title, item.snapshot.content)
                  "
                />
              </div>
            </div>
          </li>
        </ol>
      </div>
    </template>
  </USlideover>

  <ConsequenceModal
    :open="restoringItem !== null"
    title="恢复此历史版本？"
    :consequences="[
      `将以版本 ${restoringItem ? (itemVersion(restoringItem) ?? '') : ''} 的标题、现行概要、正文与场景覆盖当前内容。`,
      '此次恢复会记为一次新版本，现有内容仍保留在历史记录中。',
    ]"
    action="确认恢复"
    :busy="restoring"
    :error="restoreError"
    @confirm="confirmRestore"
    @close="restoringItem = null"
  />
</template>

<style scoped>
.history-shell {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.history-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ui-border);
}
.history-search {
  flex: 1 1 13rem;
  min-width: 11rem;
}
.compare-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
  font-size: 12px;
}
.compare-status {
  color: var(--ui-text-highlighted);
  font-weight: 500;
}
.compare-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.compare-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.compare-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-border);
}
.history-list {
  display: flex;
  flex-direction: column;
}
.history-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border);
}
.history-row.is-archive {
  padding-left: 10px;
  border-left: 2px solid var(--ui-border-accented);
}
.history-row.is-focused {
  padding-left: 10px;
  border-left: 3px solid var(--ui-rule);
}
.history-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.head-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.version-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.archive-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.event-kind {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.current-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  line-height: 1.4;
}
.char-delta {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.change-summary {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.55;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.actor-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.actor-badge {
  color: var(--ui-text-toned);
}
.meta-sep {
  color: var(--ui-border-accented);
}
.snapshot-title {
  min-width: 0;
  overflow-wrap: anywhere;
}
.history-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding-top: 2px;
}
.compare-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.compare-check input[type='checkbox'] {
  accent-color: var(--ui-primary);
}
.compare-check:hover {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.diff-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.subpanel-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
  margin-bottom: 4px;
}
.attr-diff-wrap {
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.attr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  line-height: 1.5;
}
.attr-table th,
.attr-table td {
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid var(--ui-border-muted);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.attr-table th {
  border-bottom-color: var(--ui-border);
  font-weight: 500;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.attr-table tr:last-child td {
  border-bottom: 0;
}
.attr-name {
  white-space: nowrap;
  color: var(--ui-text-muted);
  width: 5.5rem;
}
.attr-before {
  color: var(--ui-error);
  text-decoration: line-through;
}
.attr-after {
  color: var(--ui-success);
  font-weight: 500;
}
.diff-empty-note {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.history-diff {
  max-height: 22rem;
  overflow: auto;
  padding: 8px 10px;
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
.snapshot-preview {
  margin-top: 4px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.snapshot-preview-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 13px;
}
.snapshot-summary {
  margin: 10px 12px 0;
  padding: 6px 10px;
  border-left: 3px solid var(--ui-rule);
  background: var(--ui-bg-muted);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.snapshot-summary-label {
  display: block;
  font-size: 12px;
  color: var(--ui-text-muted);
  margin-bottom: 2px;
}
.snapshot-body {
  max-height: 24rem;
  overflow-y: auto;
  padding: 12px 14px;
}
</style>
