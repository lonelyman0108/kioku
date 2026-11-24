<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ExpiredEntry } from '@kioku/contracts'
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { invalidateActivity } from '../activity'
import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { useNow } from '../composables/useNow'
import { invalidateInboxCounts } from '../inbox'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import MemoryHistory from './MemoryHistory.vue'
import MemoryRow from './strata/MemoryRow.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import { entryBand } from './strata/strata'

const props = defineProps<{ circleId: string }>()
const emit = defineEmits<{ reactivated: [shortId: string] }>()
const toast = useToast()
const queryClient = useQueryClient()
// 和别处一样按条判断：editor 改不了机密记忆
const { circleKind, canWriteEntry } = useMemoryPermissions(computed(() => props.circleId))
const canWriteItem = (item: ExpiredEntry) =>
  canWriteEntry({ sensitivity: item.sensitivity, circleId: props.circleId })

const queryKey = computed(() => ['entry-expired', props.circleId] as const)
const expired = useInfiniteQuery({
  queryKey,
  // 参数从键里取：换了记忆圈之后，旧键剩下的页还在重新拉取时，不会去请求新的记忆圈
  queryFn: ({ pageParam, queryKey: [, cid] }) => api.expiredEntries(cid, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: useActivated(),
})
const items = computed(() => expired.data.value?.pages.flatMap((page) => page.items) ?? [])
const now = useNow()

// 正在看历史的那一条
const viewing = ref<ExpiredEntry | null>(null)

const reactivating = ref<string | null>(null)
// version 是看到的版本：在历史里恢复过旧版本之后，用历史里的版本
async function reactivate(item: ExpiredEntry, version = item.version) {
  if (reactivating.value) return
  const cid = props.circleId
  const key = queryKey.value
  reactivating.value = item.id
  try {
    const entry = await api.reactivateEntry(cid, {
      entryId: item.id,
      expectedVersion: version,
    })
    queryClient.setQueryData(['entry', cid, entry.shortId], entry)
    void queryClient.invalidateQueries({ queryKey: ['entry-history', cid, entry.id] })
    for (const prefix of ['overview', 'entry-browse', 'entry-list', 'entry-glossary']) {
      void queryClient.invalidateQueries({ queryKey: [prefix, cid] })
    }
    void invalidateInboxCounts(queryClient, cid)
    invalidateActivity(queryClient, cid)
    toast.add({ title: `已恢复生效「${entry.title || entry.shortId}」`, color: 'success' })
    if (viewing.value?.id === item.id) viewing.value = null
    if (props.circleId === cid) emit('reactivated', entry.shortId)
    await queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复生效失败', color: 'error' })
    if (err instanceof ApiError && err.status === 409) void expired.refetch()
  } finally {
    reactivating.value = null
  }
}
</script>

<template>
  <div>
    <div class="list-head">
      <p>
        已过期的记忆不再召回，也不进启动加载。<Hint>恢复生效后长期有效，可再设置新的有效期。</Hint>
      </p>
    </div>
    <!-- 读取失败时已经读到的行留着：翻页失败的错误放在「加载更多」上面，其余放在最上面 -->
    <div v-if="expired.isError.value && !expired.isFetchNextPageError.value" class="list-note">
      <ReadFailureNote :query="expired" />
    </div>
    <div v-if="expired.isPending.value" class="space-y-2 p-3.5">
      <USkeleton v-for="n in 4" :key="n" class="h-12 w-full" />
    </div>
    <template v-else-if="expired.data.value">
      <ul>
        <li v-for="item in items" :key="item.id">
          <MemoryRow
            :short-id="item.shortId"
            :title="item.title"
            :band="entryBand({ kind: item.kind }, { id: circleId, kind: circleKind })"
            :kind="item.kind"
            :sensitivity="item.sensitivity"
            :priority="item.priority"
            local
          >
            <span>
              过期于
              <time :datetime="item.expiredAt" :title="formatTime(item.expiredAt)">
                {{ formatRelative(item.expiredAt, now) }}
              </time>
            </span>
            <template #actions>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :aria-label="`${item.title || item.shortId} 的历史`"
                @click="viewing = item"
              >
                历史
              </UButton>
              <UButton
                v-if="canWriteItem(item)"
                size="xs"
                color="neutral"
                variant="outline"
                :loading="reactivating === item.id"
                @click="reactivate(item)"
              >
                恢复生效
              </UButton>
            </template>
          </MemoryRow>
        </li>
      </ul>
      <p v-if="!items.length" class="list-empty">暂无已过期的记忆</p>
      <div v-if="expired.isFetchNextPageError.value" class="list-note">
        <NoteLine tone="error">{{ readFailure(expired.error.value) }}</NoteLine>
      </div>
      <div v-if="expired.hasNextPage.value" class="flex justify-center py-3">
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :loading="expired.isFetchingNextPage.value"
          @click="expired.fetchNextPage()"
        >
          加载更多
        </UButton>
      </div>
    </template>

    <USlideover
      :open="viewing !== null"
      :title="viewing ? `历史：${viewing.title || viewing.shortId}` : '历史'"
      :ui="{ content: 'max-w-2xl' }"
      @update:open="(v) => !v && (viewing = null)"
    >
      <template #body>
        <MemoryHistory
          v-if="viewing"
          :circle-id="circleId"
          :entry-id="viewing.id"
          :can-restore="canWriteItem(viewing)"
          :can-reactivate="canWriteItem(viewing)"
          :reactivating="reactivating === viewing.id"
          @reactivate="(version) => viewing && reactivate(viewing, version)"
        />
      </template>
    </USlideover>
  </div>
</template>

<style scoped>
.list-head {
  padding: 8px 14px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
.list-note {
  padding: 14px 14px 0;
}
.list-empty {
  padding: 18px 14px;
  color: var(--ui-text-muted);
}
</style>
