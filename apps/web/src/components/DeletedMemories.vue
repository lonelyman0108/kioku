<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { DeletedEntry } from '@kioku/contracts'
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { invalidateActivity } from '../activity'
import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { useNow } from '../composables/useNow'
import { invalidateInboxCounts } from '../inbox'
import { deletionNotice, purgeAt, purgeNote } from '../retention'
import { formatRelative, formatTime, isExpired } from '../time'
import Hint from './Hint.vue'
import FlagTag from './strata/FlagTag.vue'
import MemoryRow from './strata/MemoryRow.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import { entryBand } from './strata/strata'

const props = defineProps<{ circleId: string }>()
// restored：撤销删除之后回到了目录上；showExpired：撤销之后它是过期的，要去「已过期」里看
const emit = defineEmits<{ restored: [shortId: string]; showExpired: [] }>()
const toast = useToast()
const queryClient = useQueryClient()
// 和别处一样按条判断：editor 改不了机密记忆
const { circleKind, canWriteEntry } = useMemoryPermissions(computed(() => props.circleId))
const canWriteItem = (item: DeletedEntry) =>
  canWriteEntry({ sensitivity: item.sensitivity, circleId: props.circleId })

const queryKey = computed(() => ['entry-deleted', props.circleId] as const)
const deleted = useInfiniteQuery({
  queryKey,
  // 参数从键里取：换了记忆圈之后，旧键剩下的页还在重新拉取时，不会去请求新的记忆圈
  queryFn: ({ pageParam, queryKey: [, cid] }) => api.deletedEntries(cid, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: useActivated(),
})
const items = computed(() => deleted.data.value?.pages.flatMap((page) => page.items) ?? [])
// 保留期是整个实例的设置，每一页都带着，用第一页的
const retention = computed(() => deleted.data.value?.pages[0]?.retention ?? null)
// 还剩几天与「已过期」都按它算：页面一直开着也每分钟跟着变，切到别的视图时停下
const now = useNow()
const notes = computed(() => {
  const r = retention.value
  return new Map(
    r ? items.value.map((item) => [item.id, purgeNote(item.deletedAt, r, now.value)]) : [],
  )
})

const restoring = ref<string | null>(null)
async function undelete(item: DeletedEntry) {
  const cid = props.circleId
  const key = queryKey.value
  restoring.value = item.id
  try {
    const entry = await api.undeleteEntry(cid, item.id)
    if (isExpired(entry.validTo)) {
      toast.add({
        title: '已恢复；这条记忆已过期，可在「已过期」中恢复生效',
        color: 'success',
        actions: [
          {
            label: '查看已过期',
            color: 'neutral',
            variant: 'subtle',
            onClick: () => {
              if (props.circleId === cid) emit('showExpired')
            },
          },
        ],
      })
      void queryClient.invalidateQueries({ queryKey: ['entry-expired', cid] })
    } else {
      // 写进这条记忆的缓存：删除前留下的缓存版本号对不上，打开后第一次保存会冲突
      queryClient.setQueryData(['entry', cid, entry.shortId], entry)
      toast.add({ title: `已恢复「${entry.title || entry.shortId}」`, color: 'success' })
      if (props.circleId === cid) emit('restored', entry.shortId)
    }
    for (const prefix of ['overview', 'entry-browse', 'entry-list', 'entry-glossary']) {
      void queryClient.invalidateQueries({ queryKey: [prefix, cid] })
    }
    void invalidateInboxCounts(queryClient, cid)
    invalidateActivity(queryClient, cid)
    await queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复失败', color: 'error' })
    if (err instanceof ApiError && props.circleId === cid) {
      void deleted.refetch()
    }
  } finally {
    restoring.value = null
  }
}
</script>

<template>
  <div>
    <div class="list-head">
      <p>
        已删除的记忆在保留期内可以恢复。<Hint>
          恢复后内容与短 ID
          不变。恢复不改变有效期：标记为「已过期」的记忆恢复后回到「已过期」，可在其中恢复生效。
        </Hint>
      </p>
      <p v-if="retention" class="text-warning">{{ deletionNotice(retention) }}</p>
    </div>
    <!-- 读取失败时已经读到的行留着：翻页失败的错误放在「加载更多」上面，其余放在最上面 -->
    <div v-if="deleted.isError.value && !deleted.isFetchNextPageError.value" class="list-note">
      <ReadFailureNote :query="deleted" />
    </div>
    <div v-if="deleted.isPending.value" class="space-y-2 p-3.5">
      <USkeleton v-for="n in 4" :key="n" class="h-12 w-full" />
    </div>
    <template v-else-if="deleted.data.value">
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
              删除于
              <time :datetime="item.deletedAt" :title="formatTime(item.deletedAt)">
                {{ formatRelative(item.deletedAt, now) }}
              </time>
              <template v-if="retention && notes.get(item.id)">
                ·
                <span
                  :class="{ 'text-warning': notes.get(item.id)!.soon }"
                  :title="`最早于 ${formatTime(item.expiresAt ?? purgeAt(item.deletedAt, retention).toISOString())} 后清除`"
                >
                  {{ notes.get(item.id)!.text }}
                </span>
              </template>
            </span>
            <span v-if="isExpired(item.validTo, now)" class="row-marks">
              <FlagTag
                status="expired"
                :title="`删除后已于 ${formatTime(item.validTo!)} 过期，恢复后回到「已过期」`"
              />
            </span>
            <template v-if="canWriteItem(item)" #actions>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :loading="restoring === item.id"
                @click="undelete(item)"
              >
                恢复
              </UButton>
            </template>
          </MemoryRow>
        </li>
      </ul>
      <p v-if="!items.length" class="list-empty">暂无已删除的记忆</p>
      <div v-if="deleted.isFetchNextPageError.value" class="list-note">
        <NoteLine tone="error">{{ readFailure(deleted.error.value) }}</NoteLine>
      </div>
      <div v-if="deleted.hasNextPage.value" class="flex justify-center py-3">
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :loading="deleted.isFetchingNextPage.value"
          @click="deleted.fetchNextPage()"
        >
          加载更多
        </UButton>
      </div>
    </template>
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
.row-marks {
  display: flex;
  flex-wrap: wrap;
  gap: 0 10px;
}
</style>
