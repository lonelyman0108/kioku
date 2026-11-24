<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { SENSITIVITIES, type EntrySnapshot, type HistoryEvent } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { invalidateActivity } from '../activity'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { diffVariantSnapshots, type VariantDiffItem } from '../diff'
import { invalidateInboxCounts } from '../inbox'
import { eventLabel, memoryViaLabels, provenanceLabels, sensitivityLabels } from '../labels'
import { whenLabel } from '../memoryDetail'
import { formatRelative, formatTime, isExpired } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import Hint from './Hint.vue'
import ActorName from './strata/ActorName.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'

const props = defineProps<{
  circleId: string
  entryId: string
  canRestore: boolean
  // 过期了时能不能让它重新生效；重新生效由打开历史的地方去做（已过期列表）
  canReactivate?: boolean
  reactivating?: boolean
}>()
// 带上历史里看到的版本：在这里恢复过旧版本之后，列表里的版本就旧了
const emit = defineEmits<{ reactivate: [version: number] }>()
const toast = useToast()
const queryClient = useQueryClient()

const history = useQuery({
  queryKey: computed(() => ['entry-history', props.circleId, props.entryId] as const),
  queryFn: ({ queryKey: [, cid, id] }) => api.entryHistory(cid, id),
})
const facets = useQuery({
  queryKey: computed(() => ['facets', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
})

// 服务端按时间倒序返回，最近的在最前面
const events = computed(() => history.data.value?.events ?? [])
const current = computed(() => history.data.value?.entry)
// 这条记忆现在过期了：删掉之后才到期的不算（它走撤销删除，见已删除）
const expiredNow = computed(() => {
  const e = current.value
  return !!e && isExpired(e.validTo) && !e.deletedAt
})
const validToText = (validTo: string | null) => (validTo ? formatTime(validTo) : '长期有效')

// 一次改动里变了的属性；变体切片正文另外按行对比
function changes(before: EntrySnapshot | null, after: EntrySnapshot | null): string[] {
  if (!before || !after) return []
  const list: string[] = []
  if (before.title !== after.title && before.title && after.title) {
    list.push(`标题：${before.title} → ${after.title}`)
  }
  if (before.sensitivity !== after.sensitivity) {
    list.push(
      `敏感级：${sensitivityLabels[before.sensitivity]} → ${sensitivityLabels[after.sensitivity]}`,
    )
  }
  if (before.priority !== after.priority) {
    list.push(`优先级：P${before.priority} → P${after.priority}`)
  }
  if (before.disclosure !== after.disclosure) {
    list.push(`召回说明：${before.disclosure ?? '（无）'} → ${after.disclosure ?? '（无）'}`)
  }
  const topicsAdded = after.topics.filter((t) => !before.topics.includes(t))
  const topicsRemoved = before.topics.filter((t) => !after.topics.includes(t))
  if (topicsAdded.length) list.push(`添加主题：${topicsAdded.join('、')}`)
  if (topicsRemoved.length) list.push(`移除主题：${topicsRemoved.join('、')}`)
  const added = after.glossary.filter((k) => !before.glossary.includes(k))
  const removed = before.glossary.filter((k) => !after.glossary.includes(k))
  if (added.length) list.push(`添加关键词：${added.join('、')}`)
  if (removed.length) list.push(`移除关键词：${removed.join('、')}`)
  if (before.validTo !== after.validTo) {
    list.push(`有效期：${validToText(before.validTo)} → ${validToText(after.validTo)}`)
  }
  return list
}

const variantDiffStatusLabels: Record<VariantDiffItem['status'], string> = {
  added: '新增变体',
  removed: '移除变体',
  modified: '修改',
  unchanged: '未变',
}

function variantDiffs(event: HistoryEvent): VariantDiffItem[] {
  if (event.left || !event.after) return []
  return diffVariantSnapshots(event.before?.variants ?? null, event.after.variants)
}

function contentChange(event: HistoryEvent): 'none' | 'secret' | 'changed' {
  const { after } = event
  if (!after || event.left) return 'none'
  const diffs = variantDiffs(event)
  const touched = diffs.filter(
    (d) => d.status === 'added' || d.status === 'removed' || d.status === 'modified',
  )
  if (!touched.length) return 'none'
  if (touched.some((d) => !d.secret || d.rows.length > 0)) return 'changed'
  return 'secret'
}

const open = ref<number | null>(null)
const openDiffs = computed<VariantDiffItem[]>(() => {
  const event = events.value.find((e) => e.id === open.value)
  if (!event) return []
  return variantDiffs(event).filter((d) => d.status !== 'unchanged')
})

// 改动之后的那一版就是现在的样子
const currentEventId = computed(
  () =>
    events.value.find((e) => !!e.after && !e.left && e.after.version === current.value?.version)
      ?.id ?? null,
)
const isCurrent = (event: HistoryEvent) => event.id === currentEventId.value

// 服务端只恢复同形态、当前与目标版本均非机密、且敏感级不高于当前的版本
function sameScope(snapshot: EntrySnapshot): boolean {
  const now = current.value
  return (
    !!now &&
    snapshot.kind === now.kind &&
    snapshot.sensitivity !== 'secret' &&
    now.sensitivity !== 'secret' &&
    SENSITIVITIES.indexOf(snapshot.sensitivity) <= SENSITIVITIES.indexOf(now.sensitivity)
  )
}
const restorable = (event: HistoryEvent) =>
  props.canRestore &&
  !current.value?.deletedAt &&
  !!event.after &&
  !event.left &&
  !event.after.deleted &&
  !isCurrent(event) &&
  sameScope(event.after)

const confirming = ref<{ event: HistoryEvent; entryId: string; version: number } | null>(null)
const restoreError = ref<string | null>(null)
function askRestore(event: HistoryEvent) {
  const version = current.value?.version
  if (version !== undefined) {
    restoreError.value = null
    confirming.value = { event, entryId: props.entryId, version }
  }
}
const restoring = ref(false)
async function restore() {
  const target = confirming.value
  if (!target || restoring.value) return
  restoring.value = true
  restoreError.value = null
  try {
    const restored = await api.restoreEntry(props.circleId, {
      entryId: target.entryId,
      eventId: target.event.id,
      expectedVersion: target.version,
    })
    confirming.value = null
    toast.add({ title: '已恢复此版本', color: 'success' })
    if (!isExpired(restored.validTo)) {
      const key = ['entry', props.circleId, restored.shortId]
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      queryClient.setQueryData(key, restored)
    }
    for (const prefix of [
      'entry-expired',
      'entry-browse',
      'entry-list',
      'overview',
      'entry-glossary',
    ]) {
      void queryClient.invalidateQueries({ queryKey: [prefix, props.circleId] })
    }
    void invalidateInboxCounts(queryClient, props.circleId)
    invalidateActivity(queryClient, props.circleId)
    await history.refetch()
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : '恢复失败'
    restoreError.value = msg
    if (err instanceof ApiError && err.status === 409) {
      confirming.value = null
      toast.add({ title: msg, color: 'error' })
    }
    void history.refetch()
  } finally {
    restoring.value = false
  }
}

const versionOf = (event: HistoryEvent) => event.after?.version ?? event.before?.version ?? null
</script>

<template>
  <div class="memory-history">
    <ReadFailureNote v-if="history.isError.value" :query="history" fallback="历史记录读取失败" />
    <div v-else-if="history.isPending.value" class="space-y-3">
      <USkeleton v-for="n in 4" :key="n" class="h-14 w-full" />
    </div>
    <template v-else>
      <NoteLine v-if="expiredNow && current?.validTo" tone="warning">
        这条记忆已于 {{ formatTime(current.validTo) }} 过期，不再召回，也不进启动加载
        <template v-if="canReactivate" #actions>
          <UButton
            size="sm"
            color="primary"
            variant="outline"
            :loading="reactivating"
            @click="current && emit('reactivate', current.version)"
          >
            恢复生效
          </UButton>
        </template>
      </NoteLine>
      <SectionHeading title="历史">
        <template #hint>
          <Hint>
            恢复此版本会将正文与变体、标题、主题、召回说明、敏感级、优先级、关键词与有效期一并恢复为该版本内容；所在记忆圈不变。机密记忆与敏感级高于当前的记录不可直接恢复。
          </Hint>
        </template>
        <template v-if="history.data.value?.truncated" #actions>
          仅列出最近 500 次改动与 100 次查看
        </template>
      </SectionHeading>
      <ol>
        <li v-for="event in events" :key="event.id" class="history-row">
          <span class="history-version" :class="{ current: isCurrent(event) }">
            <template v-if="versionOf(event) !== null">#{{ versionOf(event) }}</template>
          </span>
          <div class="min-w-0">
            <p class="history-title">
              <b>{{ eventLabel(event.type).label }}</b>
              <span v-if="event.before && contentChange(event) === 'changed'"> 正文</span>
              <span v-if="isCurrent(event)" class="history-current">当前版本</span>
            </p>
            <p class="history-meta">
              <ActorName :actor="event.actor" />
              <span class="ms-3">来源 {{ provenanceLabels[event.provenance] }}</span>
              <span v-if="event.via" class="ms-3">
                {{ memoryViaLabels[event.via] ?? event.via }}
              </span>
            </p>
            <p v-if="event.left" class="history-meta">
              此次改动后，这条记忆超出当前账号的可见范围，无法查看改后内容，也无法恢复此版本。
            </p>
            <ul v-else class="history-meta">
              <li v-for="change in changes(event.before, event.after)" :key="change">
                {{ change }}
              </li>
            </ul>
            <p v-if="!event.left && contentChange(event) === 'secret'" class="history-meta">
              机密内容的历史不含正文
            </p>
            <div v-if="open === event.id && openDiffs.length" class="variant-diffs">
              <div v-for="item in openDiffs" :key="item.sig" class="variant-diff-item">
                <p class="variant-diff-head">
                  <span>{{ whenLabel(item.when, facets.data.value) }}</span>
                  <span class="variant-diff-status">{{
                    variantDiffStatusLabels[item.status]
                  }}</span>
                  <span v-if="item.secret" class="variant-diff-status">机密</span>
                </p>
                <p v-if="item.secret && !item.rows.length" class="history-meta">
                  机密变体历史不含正文
                </p>
                <pre v-else-if="item.rows.length" class="history-diff"><template
                  v-for="(row, index) in item.rows"
                  :key="index"
                ><span v-if="row.kind === 'skip'" class="diff-skip"
                  >… 省略未改动的 {{ row.count }} 行</span
                ><span v-else class="diff-line" :class="row.kind">{{ row.text }}</span></template></pre>
              </div>
            </div>
          </div>
          <div class="history-side">
            <time :datetime="event.createdAt" :title="formatTime(event.createdAt)">
              {{ formatRelative(event.createdAt) }}
            </time>
            <div v-if="!event.left" class="history-actions">
              <UButton
                v-if="contentChange(event) === 'changed'"
                size="xs"
                color="neutral"
                variant="outline"
                :aria-expanded="open === event.id"
                @click="open = open === event.id ? null : event.id"
              >
                {{ open === event.id ? '收起改动' : '查看改动' }}
              </UButton>
              <UButton
                v-if="restorable(event)"
                size="xs"
                color="neutral"
                variant="outline"
                @click="askRestore(event)"
              >
                恢复此版本
              </UButton>
            </div>
          </div>
        </li>
      </ol>
      <p v-if="!events.length" class="py-3 text-sm text-muted">暂无可查看的变更记录</p>
    </template>

    <ConsequenceModal
      :open="confirming !== null"
      title="恢复此版本？"
      :consequences="[
        '正文与变体、标题、主题、召回说明、敏感级、优先级、关键词与有效期均会恢复为此版本时的内容，并生成一次新的改动记录。',
        '若该版本包含已失效或未转存的明文敏感内容，恢复时将按当前记忆圈规则重新校验。',
      ]"
      action="恢复此版本"
      :busy="restoring"
      :error="restoreError"
      @close="confirming = null"
      @confirm="restore"
    />
  </div>
</template>

<style scoped>
.history-row {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) auto;
  column-gap: 10px;
  padding: 11px 0 12px;
  border-bottom: 1px solid var(--ui-border);
}
.history-version {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.7;
  color: var(--ui-text-muted);
}
.history-version.current {
  font-weight: 700;
  color: var(--ui-text-highlighted);
}
.history-title {
  font-size: 14px;
  line-height: 1.7;
}
.history-title b {
  font-weight: 600;
}
.history-current {
  display: inline-flex;
  align-items: center;
  height: 20px;
  margin-left: 6px;
  padding: 0 6px;
  border: 1px solid var(--strata-rule);
  font-size: 12px;
  line-height: 1;
  vertical-align: 1px;
}
.history-meta {
  font-size: 14px;
  line-height: 1.65;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.history-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ui-text-muted);
}
.history-actions {
  display: flex;
  gap: 5px;
}
.variant-diffs {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}
.variant-diff-item {
  border-left: 2px solid var(--ui-border-accented);
  padding-left: 10px;
}
.variant-diff-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.variant-diff-status {
  padding: 0 5px;
  border: 1px solid var(--ui-border);
}
.history-diff {
  max-height: 24rem;
  margin-top: 5px;
  overflow: auto;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.diff-skip {
  display: block;
  padding-left: 18px;
  color: var(--ui-text-muted);
}
.diff-line {
  position: relative;
  display: block;
  min-height: 1.8em;
  padding-left: 18px;
}
.diff-line::before {
  content: '';
  position: absolute;
  left: 3px;
}
.diff-line.add {
  font-weight: 600;
}
.diff-line.add::before {
  content: '+';
}
.diff-line.remove {
  color: var(--ui-error);
  text-decoration: line-through;
}
.diff-line.remove::before {
  content: '−';
}
@media (max-width: 1023.98px) {
  .history-row {
    grid-template-columns: 34px minmax(0, 1fr);
  }
  .history-side {
    grid-column: 2;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }
}
</style>
