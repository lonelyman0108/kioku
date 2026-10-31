<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { SENSITIVITIES, type HistoryEvent, type MemorySnapshot } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { collapseUnchanged, diffLines, type DiffRow } from '../diff'
import {
  actorLabel,
  eventLabel,
  layerLabels,
  memoryViaLabels,
  provenanceLabels,
  sensitivityLabels,
} from '../labels'
import { formatRelative, formatTime, isExpired } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'

const props = defineProps<{
  spaceId: string
  memoryId: string
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
  queryKey: computed(() => ['memory-history', props.spaceId, props.memoryId]),
  queryFn: () => api.memoryHistory(props.spaceId, props.memoryId),
})
// 最近的在上面
const events = computed(() => [...(history.data.value?.events ?? [])].reverse())
const current = computed(() => history.data.value?.memory)
// 这条记忆现在过期了：已经让出 URI 的也算；删掉之后才到期的不算（它走撤销删除，见已删除）
const expiredNow = computed(() => {
  const m = current.value
  return !!m && isExpired(m.validTo) && (!m.deletedAt || m.released)
})
const validToText = (validTo: string | null) => (validTo ? formatTime(validTo) : '长期有效')

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
    list.push(`优先级：P${before.priority} → P${after.priority}`)
  if (before.disclosure !== after.disclosure) {
    list.push(`触发场景：${before.disclosure ?? '（无）'} → ${after.disclosure ?? '（无）'}`)
  }
  const added = after.glossary.filter((k) => !before.glossary.includes(k))
  const removed = before.glossary.filter((k) => !after.glossary.includes(k))
  if (added.length) list.push(`添加关键词：${added.join('、')}`)
  if (removed.length) list.push(`移除关键词：${removed.join('、')}`)
  if (before.validTo !== after.validTo) {
    list.push(`有效期：${validToText(before.validTo)} → ${validToText(after.validTo)}`)
  }
  return list
}

// 这次改动里正文的情况。有一边是 secret 时那一边没有正文，对比不出改了什么：
// 改成 secret 或从 secret 改回来时，整段都会算成改动
function contentChange(event: HistoryEvent): 'none' | 'secret' | 'changed' {
  const { before, after } = event
  if (!after) return 'none'
  if (after.content === null || (before && before.content === null)) return 'secret'
  return before && before.content === after.content ? 'none' : 'changed'
}

// 只对展开的那一条做对比：每次渲染都对所有事件按行对比，事件多、正文长时很慢
const open = ref<number | null>(null)
const openRows = computed<DiffRow[]>(() => {
  const event = events.value.find((e) => e.id === open.value)
  if (!event || contentChange(event) !== 'changed') return []
  const after = event.after?.content ?? ''
  // 新建时整段算加上
  if (!event.before) return after.split('\n').map((text) => ({ kind: 'add' as const, text }))
  return collapseUnchanged(diffLines(event.before.content ?? '', after))
})

// 改动之后的那一版就是现在的样子。删除、过期后让出 URI 不改版本号，同一个版本号可能有好几个事件，只标最近的那个
const currentEventId = computed(
  () =>
    events.value.find((e) => !!e.after && !e.left && e.after.version === current.value?.version)
      ?.id ?? null,
)
const isCurrent = (event: HistoryEvent) => event.id === currentEventId.value
// 服务端只恢复和现在同一归属、敏感级不高于现在的版本：改过层、移到别的人格或应用、
// 或者调低过敏感级之后，之前的版本不能直接恢复
const namespaceOf = (uri: string) => /^(?:persona|app):\/\/[^/]+/.exec(uri)?.[0] ?? null
function sameScope(snapshot: MemorySnapshot): boolean {
  const now = current.value
  return (
    !!now &&
    snapshot.layer === now.layer &&
    namespaceOf(snapshot.uri) === namespaceOf(now.uri) &&
    SENSITIVITIES.indexOf(snapshot.sensitivity) <= SENSITIVITIES.indexOf(now.sensitivity)
  )
}
// 能拿来恢复的：看得到改后的那一版，不是删除之后的状态，不是现在这一版，归属与敏感级也允许
const restorable = (event: HistoryEvent) =>
  props.canRestore &&
  !current.value?.deletedAt &&
  !!event.after &&
  !event.left &&
  !event.after.deleted &&
  !isCurrent(event) &&
  sameScope(event.after)

// 点「恢复此版本」时记下这条记忆与它现在的版本：确认期间历史重新拉取到了更新的版本，
// 或编辑器换成了重建的另一条，恢复返回冲突，不会盖掉没看过的改动
const confirming = ref<{ event: HistoryEvent; memoryId: string; version: number } | null>(null)
function askRestore(event: HistoryEvent) {
  const version = current.value?.version
  if (version !== undefined) confirming.value = { event, memoryId: props.memoryId, version }
}
const restoring = ref(false)
async function restore() {
  const target = confirming.value
  if (!target) return
  restoring.value = true
  try {
    const restored = await api.restoreMemory(props.spaceId, {
      memoryId: target.memoryId,
      eventId: target.event.id,
      expectedVersion: target.version,
    })
    confirming.value = null
    toast.add({ title: '已恢复此版本', color: 'success' })
    // 直接写进这条记忆的缓存，编辑器会跟上（并通知页面）。不靠事件：侧栏在请求期间被关掉时，
    // 这个组件已经卸载，发出的事件没人收到。过期的记忆按 URI 读不到，不写进那个 URI 的缓存
    if (!isExpired(restored.validTo)) {
      const key = ['memory', props.spaceId, restored.uri]
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      queryClient.setQueryData(key, restored)
    }
    // 版本变了，已过期列表里记着的版本也要跟上
    void queryClient.invalidateQueries({ queryKey: ['memory-expired', props.spaceId] })
    await history.refetch()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复失败', color: 'error' })
    // 版本冲突等情况下历史可能已经变了；冲突时关掉确认框，看过新的历史再选
    if (err instanceof ApiError && err.status === 409) confirming.value = null
    void history.refetch()
  } finally {
    restoring.value = false
  }
}

// 版本号写在最左边：改动之后的那一版；离开可见范围的只有改前的那一版
const versionOf = (event: HistoryEvent) => event.after?.version ?? event.before?.version ?? null
</script>

<template>
  <div class="memory-history">
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
      <NoteLine v-if="expiredNow && current?.validTo" tone="warning">
        这条记忆已于 {{ formatTime(current.validTo) }} 过期，不再召回，也不进启动加载
        <template v-if="current.released" #detail>
          过期后同一 URI 上已写入新记忆，URI 已释放。那条记忆仍在时，需先移走或删除才能恢复生效。
        </template>
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
            恢复此版本只改正文、触发场景、优先级与关键词。URI、层、敏感级与有效期不变（过期的记忆在「已过期」中恢复生效）。层或归属与当前不同、敏感级高于当前的版本无法恢复。
          </Hint>
        </template>
        <template v-if="history.data.value?.truncated" #actions>
          仅列出最近 500 次改动与 100 次查看
        </template>
      </SectionHeading>
      <ol>
        <li v-for="event in events" :key="event.id" class="history-row">
          <span class="history-version" :class="{ current: isCurrent(event) }">
            <template v-if="versionOf(event) !== null">v{{ versionOf(event) }}</template>
          </span>
          <div class="min-w-0">
            <p class="history-title">
              <b>{{ eventLabel(event.type).label }}</b>
              <span v-if="event.before && contentChange(event) === 'changed'"> 正文</span>
              <span v-if="isCurrent(event)" class="history-current">当前版本</span>
            </p>
            <p class="history-meta">
              {{ actorLabel(event.actor).name }}
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
            <pre
              v-if="open === event.id && contentChange(event) === 'changed'"
              class="history-diff"
            ><template v-for="(row, index) in openRows" :key="index"><span
              v-if="row.kind === 'skip'"
              class="diff-skip"
            >… 省略未改动的 {{ row.count }} 行</span><span
              v-else
              class="diff-line"
              :class="row.kind"
            >{{ row.text }}</span></template></pre>
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

    <UModal
      :open="confirming !== null"
      title="恢复此版本？"
      @update:open="(v) => !v && (confirming = null)"
    >
      <template #body>
        <p class="text-sm">
          正文、触发场景、优先级与关键词恢复为此次改动后的内容，并记录一次新改动；URI、层与敏感级不变。
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
.history-diff {
  max-height: 24rem;
  margin-top: 7px;
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
