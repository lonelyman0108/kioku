<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { HistoryEvent, MemorySnapshot, MemoryView } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { collapseUnchanged, diffLines, type DiffRow } from '../diff'
import { icons } from '../icons'
import { actorLabel, eventLabel, layerLabels, sensitivityLabels } from '../labels'
import { formatRelative, formatTime } from '../time'

const props = defineProps<{ spaceId: string; memoryId: string; canRestore: boolean }>()
const emit = defineEmits<{ restored: [memory: MemoryView] }>()
const toast = useToast()

const history = useQuery({
  queryKey: computed(() => ['memory-history', props.spaceId, props.memoryId]),
  queryFn: () => api.memoryHistory(props.spaceId, props.memoryId),
})
// 最近的在上面
const events = computed(() => [...(history.data.value?.events ?? [])].reverse())
const current = computed(() => history.data.value?.memory)

// 一次改动里变了的属性；正文另外按行对比
function changes(before: MemorySnapshot | null, after: MemorySnapshot | null): string[] {
  if (!before || !after) return []
  const list: string[] = []
  if (before.uri !== after.uri) list.push(`URI：${before.uri} → ${after.uri}`)
  if (before.layer !== after.layer) {
    list.push(`层：${layerLabels[before.layer]} → ${layerLabels[after.layer]}`)
  }
  if (before.sensitivity !== after.sensitivity) {
    list.push(
      `敏感级：${sensitivityLabels[before.sensitivity]} → ${sensitivityLabels[after.sensitivity]}`,
    )
  }
  if (before.priority !== after.priority)
    list.push(`priority：${before.priority} → ${after.priority}`)
  if (before.disclosure !== after.disclosure) {
    list.push(`disclosure：${before.disclosure ?? '（无）'} → ${after.disclosure ?? '（无）'}`)
  }
  const added = after.glossary.filter((k) => !before.glossary.includes(k))
  const removed = before.glossary.filter((k) => !after.glossary.includes(k))
  if (added.length) list.push(`加关键词：${added.join('、')}`)
  if (removed.length) list.push(`去掉关键词：${removed.join('、')}`)
  return list
}

// 正文的对比：新建时整段算加上；两边都没有正文（secret）时看不出改没改
function contentRows(event: HistoryEvent): DiffRow[] | 'secret' | null {
  const { before, after } = event
  if (!after) return null
  if (!before) {
    if (after.content === null) return 'secret'
    return after.content.split('\n').map((text) => ({ kind: 'add' as const, text }))
  }
  if (before.content === null && after.content === null) return 'secret'
  if (before.content === after.content) return null
  return collapseUnchanged(diffLines(before.content ?? '', after.content ?? ''))
}

// 改动之后的那一版就是现在的样子
const isCurrent = (event: HistoryEvent) =>
  !!event.after && !event.left && event.after.version === current.value?.version
// 能拿来恢复的：看得到改后的那一版，不是删除之后的状态，也不是现在这一版
const restorable = (event: HistoryEvent) =>
  props.canRestore &&
  !current.value?.deletedAt &&
  !!event.after &&
  !event.left &&
  !event.after.deleted &&
  !isCurrent(event)

const open = ref<number | null>(null)
const confirming = ref<HistoryEvent | null>(null)
const restoring = ref(false)
async function restore() {
  const event = confirming.value
  const version = current.value?.version
  if (!event || version === undefined) return
  restoring.value = true
  try {
    const restored = await api.restoreMemory(props.spaceId, {
      memoryId: props.memoryId,
      eventId: event.id,
      expectedVersion: version,
    })
    confirming.value = null
    toast.add({ title: '已恢复到这一版', color: 'success' })
    emit('restored', restored)
    await history.refetch()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复失败', color: 'error' })
    // 版本冲突等情况下历史可能已经变了
    void history.refetch()
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <UAlert
      v-if="history.isError.value"
      color="error"
      variant="subtle"
      :title="history.error.value instanceof ApiError ? history.error.value.message : '读取失败'"
    />
    <div v-else-if="history.isPending.value" class="space-y-3">
      <USkeleton v-for="n in 4" :key="n" class="h-14 w-full" />
    </div>
    <template v-else>
      <p class="text-xs text-muted">
        恢复只改正文、disclosure、priority 与关键词，不改 URI、层、敏感级与有效期。
        <template v-if="history.data.value?.truncated">只列出了最近的 500 次改动。</template>
      </p>
      <ol class="space-y-3">
        <li
          v-for="event in events"
          :key="event.id"
          class="rounded-lg border border-default p-3 text-sm"
        >
          <div class="flex flex-wrap items-center gap-2">
            <UIcon
              :name="event.left ? icons.left : eventLabel(event.type).icon"
              class="size-4 text-muted"
            />
            <span class="font-medium">{{ eventLabel(event.type).label }}</span>
            <span class="text-muted">{{ actorLabel(event.actor).name }}</span>
            <UBadge v-if="isCurrent(event)" size="sm" variant="subtle">现在的版本</UBadge>
            <time
              :datetime="event.createdAt"
              :title="formatTime(event.createdAt)"
              class="ml-auto text-xs text-muted"
            >
              {{ formatRelative(event.createdAt) }}
            </time>
          </div>
          <p v-if="event.left" class="mt-1 text-xs text-muted">
            这次改动之后，它离开了你的可见范围，改后的内容看不到，也不能恢复到这一版。
          </p>
          <ul v-else class="mt-1 space-y-0.5 text-xs text-muted">
            <li v-for="change in changes(event.before, event.after)" :key="change">
              {{ change }}
            </li>
          </ul>
          <div v-if="!event.left" class="mt-2 flex flex-wrap gap-2">
            <UButton
              v-if="contentRows(event) && contentRows(event) !== 'secret'"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="open = open === event.id ? null : event.id"
            >
              {{ open === event.id ? '收起正文的改动' : '看正文的改动' }}
            </UButton>
            <span v-else-if="contentRows(event) === 'secret'" class="text-xs text-muted">
              secret 的历史不含正文
            </span>
            <UButton
              v-if="restorable(event)"
              :icon="icons.restore"
              size="xs"
              color="neutral"
              variant="subtle"
              class="ml-auto"
              @click="confirming = event"
            >
              恢复到这一版
            </UButton>
          </div>
          <pre
            v-if="open === event.id && Array.isArray(contentRows(event))"
            class="mt-2 max-h-96 overflow-auto rounded bg-elevated p-2 font-mono text-xs leading-relaxed"
          ><template v-for="(row, index) in contentRows(event) as DiffRow[]" :key="index"><span
            v-if="row.kind === 'skip'"
            class="block text-dimmed"
          >… 省略没变的 {{ row.count }} 行</span><span
            v-else
            class="block whitespace-pre-wrap"
            :class="row.kind === 'add' ? 'bg-success/15 text-success' : row.kind === 'remove' ? 'bg-error/15 text-error line-through' : ''"
          >{{ row.kind === 'add' ? '+ ' : row.kind === 'remove' ? '- ' : '  ' }}{{ row.text }}</span></template></pre>
        </li>
      </ol>
      <p v-if="!events.length" class="text-sm text-muted">没有你看得到的改动记录。</p>
    </template>

    <UModal
      :open="confirming !== null"
      title="恢复到这一版？"
      @update:open="(v) => !v && (confirming = null)"
    >
      <template #body>
        <p class="text-sm">
          把正文、disclosure、priority
          与关键词恢复成这次改动之后的样子，记一条新的改动；URI、层与敏感级不变。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirming = null">取消</UButton>
          <UButton :loading="restoring" @click="restore">恢复</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
