<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ExpiredMemory } from '@kioku/contracts'
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { useNow } from '../composables/useNow'
import { purgeAt, purgeNote, releasedNotice } from '../retention'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import MemoryHistory from './MemoryHistory.vue'
import MemoryRow from './strata/MemoryRow.vue'
import NoteLine from './strata/NoteLine.vue'

const props = defineProps<{ spaceId: string }>()
const emit = defineEmits<{ reactivated: [uri: string] }>()
const toast = useToast()
const queryClient = useQueryClient()
// 和别处一样按条判断：editor 改不了别人的应用的应用层记忆
const { canWriteUri } = useMemoryPermissions(computed(() => props.spaceId))

const queryKey = computed(() => ['memory-expired', props.spaceId] as const)
const expired = useInfiniteQuery({
  queryKey,
  // 参数从键里取：换了空间之后，旧键剩下的页还在重新拉取时，不会去请求新的空间
  queryFn: ({ pageParam, queryKey: [, spaceId] }) => api.expiredMemories(spaceId, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: useActivated(),
})
const items = computed(() => expired.data.value?.pages.flatMap((page) => page.items) ?? [])
// 让出了 URI 的和已删除的一样按保留期永久清除：保留期每一页都带着，用第一页的
const retention = computed(() => expired.data.value?.pages[0]?.retention ?? null)
const anyReleased = computed(() => items.value.some((item) => item.deletedAt !== null))
// 还剩几天按它算：页面一直开着也每分钟跟着变，切到别的视图时停下
const now = useNow()
// 让出的那几条后面的说法与要不要标警示色；没让出的不清除，没有
const notes = computed(() => {
  const r = retention.value
  return new Map(
    r
      ? items.value.flatMap((item) =>
          item.deletedAt ? [[item.id, purgeNote(item.deletedAt, r, now.value)] as const] : [],
        )
      : [],
  )
})

// 正在看历史的那一条
const viewing = ref<ExpiredMemory | null>(null)

const reactivating = ref<string | null>(null)
// version 是看到的版本：在历史里恢复过旧版本之后，用历史里的版本
async function reactivate(item: ExpiredMemory, version = item.version) {
  if (reactivating.value) return
  // 请求期间可能换了空间（页面会被复用）：缓存按发出请求时的空间写，换了空间就不通知页面
  const spaceId = props.spaceId
  const key = queryKey.value
  reactivating.value = item.id
  try {
    const memory = await api.reactivateMemory(spaceId, {
      memoryId: item.id,
      expectedVersion: version,
    })
    // 写进这条记忆的缓存：这个 URI 上之前缓存的可能是别的记录、或者过期之前的版本
    queryClient.setQueryData(['memory', spaceId, memory.uri], memory)
    void queryClient.invalidateQueries({ queryKey: ['memory-history', spaceId, memory.id] })
    toast.add({ title: `已恢复生效 ${memory.uri}`, color: 'success' })
    if (viewing.value?.id === item.id) viewing.value = null
    if (props.spaceId === spaceId) emit('reactivated', memory.uri)
    // 等列表重新拉取完、这一行消失之后按钮才恢复，免得再点一次。页面收到通知时已经发出了重新拉取，接着等它
    await queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复生效失败', color: 'error' })
    // 版本对不上、已经被别人重新生效了：刷新列表
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
        已过期的记忆不再召回，也不进启动加载。<Hint>
          恢复生效后长期有效，可再设置新的有效期。标记为「URI 已释放」的，过期后同一 URI
          上已写入新记忆；那条记忆仍在时，需先移走或删除。
        </Hint>
      </p>
      <p v-if="retention && anyReleased" class="text-warning">{{ releasedNotice(retention) }}</p>
    </div>
    <div v-if="expired.isError.value" class="list-note">
      <NoteLine tone="error">
        {{ expired.error.value instanceof ApiError ? expired.error.value.message : '读取失败' }}
      </NoteLine>
    </div>
    <div v-else-if="expired.isPending.value" class="space-y-2 p-3.5">
      <USkeleton v-for="n in 4" :key="n" class="h-12 w-full" />
    </div>
    <template v-else>
      <ul>
        <li v-for="item in items" :key="item.id">
          <MemoryRow
            :uri="item.uri"
            :layer="item.layer"
            :sensitivity="item.sensitivity"
            :priority="item.priority"
          >
            <span>
              过期于
              <time :datetime="item.expiredAt" :title="formatTime(item.expiredAt)">
                {{ formatRelative(item.expiredAt, now) }}
              </time>
              <template v-if="retention && item.deletedAt && notes.get(item.id)">
                ·
                <span
                  :class="{ 'text-warning': notes.get(item.id)!.soon }"
                  :title="`URI 释放于 ${formatTime(item.deletedAt)}，最早于 ${formatTime(purgeAt(item.deletedAt, retention).toISOString())} 后清除`"
                >
                  {{ notes.get(item.id)!.text }}
                </span>
              </template>
            </span>
            <span
              v-if="item.released"
              class="block text-warning"
              title="过期后同一 URI 上已写入新记忆，URI 已释放"
            >
              URI 已释放
            </span>
            <template #actions>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :aria-label="`${item.uri} 的历史`"
                @click="viewing = item"
              >
                历史
              </UButton>
              <UButton
                v-if="canWriteUri(item.uri)"
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
      :title="viewing ? `历史：${viewing.uri}` : '历史'"
      :ui="{ content: 'max-w-2xl' }"
      @update:open="(v) => !v && (viewing = null)"
    >
      <template #body>
        <MemoryHistory
          v-if="viewing"
          :space-id="spaceId"
          :memory-id="viewing.id"
          :can-restore="canWriteUri(viewing.uri)"
          :can-reactivate="canWriteUri(viewing.uri)"
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
