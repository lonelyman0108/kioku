<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ReviewLayer } from '@kioku/contracts'
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { originScopeText } from '../labels'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import UriPath from './strata/UriPath.vue'

// 待确认内容：未确认来源写下的内容，确认后记为本人来源，有误的可以删除
const props = defineProps<{ spaceId: string; canAct: boolean }>()
const toast = useToast()
const queryClient = useQueryClient()

const layer = ref<'all' | ReviewLayer>('all')
const tabs = [
  { label: '全部', value: 'all' },
  { label: '联系人事实', value: 'subject' },
  { label: '会话摘要', value: 'episode' },
]
const kindLabels: Record<ReviewLayer, string> = { subject: '事实', episode: '会话摘要' }

const active = useActivated()
const queue = useInfiniteQuery({
  queryKey: computed(() => ['review', props.spaceId, layer.value] as const),
  // 参数从键里取：换了筛选或空间之后，旧键剩下的页还在重新拉取时，不会用上新的参数
  queryFn: ({ pageParam, queryKey: [, sid, filter] }) =>
    api.reviewQueue(sid, {
      layer: filter === 'all' ? undefined : filter,
      cursor: pageParam,
    }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: active,
})
const items = computed(() => queue.data.value?.pages.flatMap((page) => page.items) ?? [])
const total = computed(() => queue.data.value?.pages[0]?.total ?? 0)

// 选中的条目与勾选时看到的版本：换了空间或筛选就清空。版本在勾选时记下，
// 之后刷新拿到的新版本不算，服务端按它跳过看过之后被改过的
type Seen = { id: string; version: number }
const selected = ref(new Map<string, number>())
watch([() => props.spaceId, layer], () => (selected.value = new Map()))
const allSelected = computed(
  () => items.value.length > 0 && items.value.every((i) => selected.value.has(i.id)),
)
function toggle(item: Seen, on: boolean) {
  const next = new Map(selected.value)
  if (on) next.set(item.id, item.version)
  else next.delete(item.id)
  selected.value = next
}
function toggleAll(on: boolean) {
  selected.value = on ? new Map(items.value.map((i) => [i.id, i.version])) : new Map()
}
const chosen = (): Seen[] => [...selected.value].map(([id, version]) => ({ id, version }))

const busy = ref(false)
const deleting = ref<Seen[] | null>(null)
// 一次最多提交这么多条（接口的上限），选得多就分几批
const BATCH = 100

async function act(action: 'confirm' | 'delete', items: Seen[]) {
  const sid = props.spaceId
  const verb = action === 'confirm' ? '确认' : '删除'
  busy.value = true
  let done = 0
  let skipped = 0
  const submitted: string[] = []
  try {
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH)
      const result = await api.review(sid, { action, items: batch })
      done += result.done
      skipped += result.skipped
      submitted.push(...batch.map((b) => b.id))
    }
    toast.add({
      title: skipped ? `已${verb} ${done} 条，${skipped} 条已被处理或修改` : `已${verb} ${done} 条`,
      color: 'success',
    })
  } catch (err) {
    const message = err instanceof ApiError ? err.message : '处理失败'
    // 分批时前面几批已经提交了，告诉用户；没提交的留在选择里，可以再试
    toast.add({
      title: submitted.length ? `${message}（此前已${verb} ${done} 条）` : message,
      color: 'error',
    })
  } finally {
    const next = new Map(selected.value)
    for (const id of submitted) next.delete(id)
    selected.value = next
    // 处理过的会出现在联系人页、记忆列表、已删除、变更记录与概览里；涉及它们的 Dream 建议随之作废；条数跟着变
    for (const key of [
      'review',
      'dream-suggestions',
      'subjects',
      'subject',
      'memory-list',
      'memory-deleted',
      'activity',
      'overview',
      'inbox-counts',
    ]) {
      void queryClient.invalidateQueries({ queryKey: [key, sid] })
    }
    busy.value = false
    deleting.value = null
  }
}
</script>

<template>
  <div>
    <SectionHeading title="待确认内容">
      <template #hint>
        <Hint
          >这些内容来自群聊与陌生人私聊，来源未确认。确认后记为本人来源，有误的内容可删除。</Hint
        >
      </template>
    </SectionHeading>
    <div class="review-bar">
      <UCheckbox
        v-if="canAct && items.length"
        :model-value="allSelected"
        label="全选已加载项"
        @update:model-value="(v) => toggleAll(v === true)"
      />
      <span v-if="canAct && selected.size" class="review-count">已选 {{ selected.size }} 条</span>
      <span v-else-if="queue.data.value" class="review-count">{{ total }} 条待确认</span>
      <UTabs v-model="layer" :items="tabs" :content="false" size="sm" class="w-auto" />
      <div v-if="canAct && items.length" class="review-bulk">
        <UButton
          color="neutral"
          variant="outline"
          :disabled="!selected.size"
          :loading="busy"
          @click="act('confirm', chosen())"
        >
          确认所选
        </UButton>
        <UButton
          color="error"
          variant="outline"
          :disabled="!selected.size || busy"
          @click="deleting = chosen()"
        >
          删除所选
        </UButton>
      </div>
    </div>
    <NoteLine
      v-if="queue.isError.value && !queue.isFetchNextPageError.value"
      class="review-note"
      tone="error"
    >
      {{ readFailure(queue.error.value) }}
    </NoteLine>
    <div v-if="queue.isPending.value" class="mt-3 space-y-3">
      <USkeleton v-for="n in 6" :key="n" class="h-12 w-full" />
    </div>
    <template v-else-if="queue.data.value">
      <p v-if="!items.length" class="review-empty">暂无待确认内容</p>
      <ul v-else>
        <li
          v-for="item in items"
          :key="item.id"
          class="review-row"
          :class="{ picked: selected.has(item.id), viewer: !canAct }"
        >
          <UCheckbox
            v-if="canAct"
            class="row-check"
            :model-value="selected.has(item.id)"
            :aria-label="`选择：${item.content}`"
            @update:model-value="(v) => toggle(item, v === true)"
          />
          <span class="row-kind">
            <StrataSwatch :layer="item.layer" plain decorative />
            {{ kindLabels[item.layer] }}
          </span>
          <span class="row-about">
            <RouterLink
              v-if="item.subject"
              :to="{ name: 'subject', params: { spaceId, subjectId: item.subject.id } }"
              >{{ item.subject.displayName }}</RouterLink
            >
          </span>
          <div class="row-content">
            <p>{{ item.content }}</p>
            <UriPath v-if="item.uri" class="row-uri" :uri="item.uri" />
          </div>
          <span class="row-source">{{ originScopeText(item.scope) }}</span>
          <time class="row-time" :datetime="item.createdAt" :title="formatTime(item.createdAt)">
            {{ formatRelative(item.createdAt) }}
          </time>
          <span v-if="canAct" class="row-actions">
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :disabled="busy"
              @click="act('confirm', [item])"
            >
              确认
            </UButton>
            <UButton
              size="sm"
              color="error"
              variant="outline"
              :disabled="busy"
              @click="deleting = [item]"
            >
              删除
            </UButton>
          </span>
        </li>
      </ul>
      <div v-if="queue.isFetchNextPageError.value" class="mt-3">
        <NoteLine tone="error">{{ readFailure(queue.error.value) }}</NoteLine>
      </div>
      <div v-if="queue.hasNextPage.value" class="mt-4 flex justify-center">
        <UButton
          color="neutral"
          variant="outline"
          :loading="queue.isFetchingNextPage.value"
          @click="queue.fetchNextPage()"
        >
          加载更多
        </UButton>
      </div>
    </template>

    <UModal
      :open="deleting !== null"
      title="删除选中的内容？"
      @update:open="(v) => !v && (deleting = null)"
    >
      <template #body>
        <p class="text-sm">
          将删除
          {{ deleting?.length ?? 0 }}
          条内容，删除后不再注入对话。从对话中抽取的内容删除后，无法在管理界面恢复。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="deleting = null">取消</UButton>
          <UButton color="error" :loading="busy" @click="deleting && act('delete', deleting)"
            >删除</UButton
          >
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.review-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  min-height: 50px;
  padding: 9px 0;
  border-bottom: 1px solid var(--ui-border);
}
.review-count {
  font-size: 14px;
  color: var(--ui-text-muted);
}
.review-bulk {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.note-line.review-note {
  margin: 10px 0 0;
  border-top: 0;
}
.review-empty {
  padding: 22px 0;
  color: var(--ui-text-muted);
}
.review-row {
  display: grid;
  grid-template-columns: 22px 108px 78px minmax(0, 1fr) 178px 86px auto;
  column-gap: 8px;
  align-items: baseline;
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.6;
}
.review-row.viewer {
  grid-template-columns: 108px 78px minmax(0, 1fr) 178px 86px;
}
.review-row.picked {
  background: var(--ui-bg-muted);
}
.row-check {
  align-self: start;
  padding-top: 3px;
}
.row-kind {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.row-about {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-about a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.row-content {
  min-width: 0;
}
.row-content p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.row-uri {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.row-source,
.row-time {
  min-width: 0;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.row-actions {
  display: flex;
  gap: 4px;
  white-space: nowrap;
}
@media (max-width: 1240px) {
  .review-row {
    grid-template-columns: 22px 108px 78px minmax(0, 1fr) auto;
    row-gap: 2px;
  }
  .review-row.viewer {
    grid-template-columns: 108px 78px minmax(0, 1fr);
  }
  .row-source {
    grid-column: 4;
    grid-row: 2;
  }
  .row-time {
    grid-column: 4;
    grid-row: 3;
  }
  .review-row.viewer .row-source,
  .review-row.viewer .row-time {
    grid-column: 3;
  }
  .row-actions {
    grid-column: 5;
    grid-row: 1;
  }
}
@media (max-width: 1023.98px) {
  .review-row,
  .review-row.viewer {
    grid-template-columns: 28px auto minmax(0, 1fr);
    row-gap: 3px;
    column-gap: 2px;
  }
  .review-row.viewer {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .row-check {
    grid-row: 1;
  }
  .row-about {
    padding-left: 10px;
  }
  .row-content,
  .row-source,
  .row-time,
  .row-actions {
    grid-column: 2 / -1;
    grid-row: auto;
  }
  .review-row.viewer .row-content,
  .review-row.viewer .row-source,
  .review-row.viewer .row-time {
    grid-column: 1 / -1;
  }
  .row-actions {
    margin-top: 7px;
  }
  .review-bulk {
    width: 100%;
    margin-left: 0;
  }
  .review-bulk > * {
    flex: 1;
    justify-content: center;
  }
}
</style>
