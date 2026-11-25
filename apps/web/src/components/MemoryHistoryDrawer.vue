<script setup lang="ts">
import type { EntryDetailResponse, EntryHistoryItem } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { collapseUnchanged, diffLines, type DiffRow } from '../diff'
import { eventTypeLabels } from '../labels'
import { formatRelative, formatTime } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import EmptyState from './ui/EmptyState.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'

const props = defineProps<{
  shortId: string
  currentVersion: number
  isDeleted: boolean
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ restored: [detail: EntryDetailResponse] }>()

const toast = useToast()
const queryClient = useQueryClient()

const history = useQuery({
  queryKey: computed(() => ['entry-history', props.shortId] as const),
  queryFn: ({ queryKey: [, sid] }) => api.entryHistory(sid),
  enabled: open,
})

const items = computed(() => history.data.value?.items ?? [])
const expandedId = ref<number | null>(null)
const restoringItem = ref<EntryHistoryItem | null>(null)
const restoring = ref(false)
const restoreError = ref<string | null>(null)

function diffFor(index: number): DiffRow[] {
  const current = items.value[index]
  if (!current) return []
  const previous = items.value[index + 1]
  const before = previous?.snapshot.content ?? ''
  return collapseUnchanged(diffLines(before, current.snapshot.content))
}

async function confirmRestore() {
  const target = restoringItem.value
  if (!target || restoring.value) return
  restoring.value = true
  restoreError.value = null
  try {
    const detail = await api.restoreEntry(props.shortId, { version: target.snapshot.version })
    restoringItem.value = null
    toast.add({ title: `已恢复到版本 ${target.snapshot.version}`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['entry-history', props.shortId] })
    emit('restored', detail)
    open.value = false
  } catch (err) {
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
    :ui="{ content: 'max-w-xl sm:max-w-xl' }"
  >
    <template #body>
      <ReadFailureNote v-if="history.isError.value" :query="history" />
      <div v-else-if="history.isPending.value" class="space-y-3">
        <USkeleton v-for="n in 4" :key="n" class="h-16 w-full" />
      </div>
      <EmptyState v-else-if="!items.length" title="暂无历史记录" />
      <ol v-else class="history-list">
        <li v-for="(item, index) in items" :key="item.id" class="history-row">
          <div class="history-head">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-xs font-semibold">
                版本 {{ item.snapshot.version }}
              </span>
              <span class="text-sm font-medium">{{ eventTypeLabels[item.eventType] }}</span>
              <span
                v-if="item.snapshot.version === currentVersion && !isDeleted"
                class="current-tag"
              >
                当前
              </span>
            </div>
            <time
              class="text-xs text-muted"
              :datetime="item.createdAt"
              :title="formatTime(item.createdAt)"
            >
              {{ formatRelative(item.createdAt) }}
            </time>
          </div>
          <p class="text-xs text-muted">{{ item.actor }} · {{ item.snapshot.title }}</p>
          <div class="history-actions">
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              @click="expandedId = expandedId === item.id ? null : item.id"
            >
              {{ expandedId === item.id ? '收起对比' : '查看改动' }}
            </UButton>
            <UButton
              v-if="!isDeleted && item.snapshot.version !== currentVersion"
              size="xs"
              color="neutral"
              variant="outline"
              @click="((restoringItem = item), (restoreError = null))"
            >
              恢复此版本
            </UButton>
          </div>
          <pre v-if="expandedId === item.id" class="history-diff"><template
            v-for="(row, rowIdx) in diffFor(index)"
            :key="rowIdx"
          ><span v-if="row.kind === 'skip'" class="diff-skip">… 省略未改动的 {{ row.count }} 行</span><span v-else class="diff-line" :class="row.kind">{{ row.text }}</span></template></pre>
        </li>
      </ol>
    </template>
  </USlideover>

  <ConsequenceModal
    :open="restoringItem !== null"
    title="恢复此历史版本？"
    :consequences="[
      `将以版本 ${restoringItem?.snapshot.version ?? ''} 的标题、正文与场景覆盖当前内容。`,
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
.history-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.current-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  line-height: 1.4;
}
.history-actions {
  display: flex;
  gap: 6px;
  padding-top: 2px;
}
.history-diff {
  max-height: 20rem;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.diff-skip {
  display: block;
  padding-left: 16px;
  color: var(--ui-text-muted);
}
.diff-line {
  position: relative;
  display: block;
  min-height: 1.6em;
  padding-left: 16px;
}
.diff-line::before {
  content: '';
  position: absolute;
  left: 2px;
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
</style>
