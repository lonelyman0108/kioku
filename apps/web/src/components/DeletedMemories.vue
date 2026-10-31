<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { DeletedMemory } from '@kioku/contracts'
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { useNow } from '../composables/useNow'
import { deletionNotice, purgeAt, purgeNote } from '../retention'
import { formatRelative, formatTime, isExpired } from '../time'
import Hint from './Hint.vue'
import MemoryRow from './strata/MemoryRow.vue'
import NoteLine from './strata/NoteLine.vue'

const props = defineProps<{ spaceId: string }>()
// restored：撤销删除之后回到了树上；showExpired：撤销之后它是过期的，要去「已过期」里看
const emit = defineEmits<{ restored: [uri: string]; showExpired: [] }>()
const toast = useToast()
const queryClient = useQueryClient()
// 和别处一样按条判断：editor 撤销不了别人的应用的应用层记忆
const { canWriteUri } = useMemoryPermissions(computed(() => props.spaceId))

const queryKey = computed(() => ['memory-deleted', props.spaceId] as const)
const deleted = useInfiniteQuery({
  queryKey,
  // 参数从键里取：换了空间之后，旧键剩下的页还在重新拉取时，不会去请求新的空间
  queryFn: ({ pageParam, queryKey: [, spaceId] }) => api.deletedMemories(spaceId, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: useActivated(),
})
const items = computed(() => deleted.data.value?.pages.flatMap((page) => page.items) ?? [])
const failure = computed(() =>
  deleted.error.value instanceof ApiError ? deleted.error.value.message : '读取失败',
)
// 保留期是整个实例的设置，每一页都带着，用第一页的
const retention = computed(() => deleted.data.value?.pages[0]?.retention ?? null)
// 还剩几天、警示色与「已过期」都按它算：页面一直开着也每分钟跟着变，切到别的视图时停下
const now = useNow()
// 每一条后面的说法与要不要标警示色
const notes = computed(() => {
  const r = retention.value
  return new Map(
    r ? items.value.map((item) => [item.id, purgeNote(item.deletedAt, r, now.value)]) : [],
  )
})

const restoring = ref<string | null>(null)
async function undelete(item: DeletedMemory) {
  // 请求期间可能换了空间（页面会被复用）：缓存按发出请求时的空间写，换了空间就不通知页面
  const spaceId = props.spaceId
  const key = queryKey.value
  restoring.value = item.id
  try {
    const memory = await api.undeleteMemory(spaceId, item.id)
    if (isExpired(memory.validTo)) {
      // 撤销删除不动有效期：删掉之后才到期的，撤销之后还是过期的，按 URI 读不到，不写那个 URI 的缓存，也不跳过去
      toast.add({
        title: '已恢复；这条记忆已过期，可在「已过期」中恢复生效',
        color: 'success',
        actions: [
          {
            label: '查看已过期',
            color: 'neutral',
            variant: 'subtle',
            onClick: () => {
              if (props.spaceId === spaceId) emit('showExpired')
            },
          },
        ],
      })
      void queryClient.invalidateQueries({ queryKey: ['memory-expired', spaceId] })
    } else {
      // 写进这条记忆的缓存：删除前留下的缓存版本号对不上，打开后第一次保存会冲突
      queryClient.setQueryData(['memory', spaceId, memory.uri], memory)
      toast.add({ title: `已恢复 ${memory.uri}`, color: 'success' })
      if (props.spaceId === spaceId) emit('restored', memory.uri)
    }
    // 等列表重新拉取完、这一行消失之后按钮才恢复，免得再点一次。页面收到通知时已经发出了重新拉取，接着等它
    await queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复失败', color: 'error' })
    // URI 刚被别的记忆占上、这条已经被别人撤销或永久清除、权限变了：列表已经过时，重新读，标记跟着变
    if (err instanceof ApiError && props.spaceId === spaceId) {
      void deleted.refetch()
    }
  } finally {
    restoring.value = null
  }
}

// URI 被别的记忆占着时撤销删除会冲突：说清楚为什么、该怎么办。按钮照样能点：标记是列表读出时的，
// 占着的那条可能已经过期、被移走或删掉，点了还冲突时会重新读列表
const TAKEN_HINT =
  'URI 已被占用。移走或删除占用它的记忆后可恢复。标记按列表读取时计算，可直接重试。'
</script>

<template>
  <div>
    <div class="list-head">
      <p>
        已删除的记忆在保留期内可以恢复。<Hint>
          恢复后内容不变。同一 URI 已有其他记忆时会冲突（标记为「URI
          已被占用」），需先移走或删除那条记忆。恢复不改变有效期：标记为「已过期」的记忆恢复后回到「已过期」，可在其中恢复生效。
        </Hint>
      </p>
      <p v-if="retention" class="text-warning">{{ deletionNotice(retention) }}</p>
    </div>
    <div v-if="deleted.isError.value && !deleted.data.value" class="list-note">
      <NoteLine tone="error">{{ failure }}</NoteLine>
    </div>
    <div v-else-if="deleted.isPending.value" class="space-y-2 p-3.5">
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
              删除于
              <time :datetime="item.deletedAt" :title="formatTime(item.deletedAt)">
                {{ formatRelative(item.deletedAt, now) }}
              </time>
              <template v-if="retention && notes.get(item.id)">
                ·
                <span
                  :class="{ 'text-warning': notes.get(item.id)!.soon }"
                  :title="`最早于 ${formatTime(purgeAt(item.deletedAt, retention).toISOString())} 后清除`"
                >
                  {{ notes.get(item.id)!.text }}
                </span>
              </template>
            </span>
            <span v-if="isExpired(item.validTo, now) || item.uriTaken" class="row-marks">
              <span
                v-if="isExpired(item.validTo, now)"
                class="text-warning"
                :title="`删除后已于 ${formatTime(item.validTo!)} 过期，恢复后回到「已过期」`"
              >
                已过期
              </span>
              <span v-if="item.uriTaken" class="text-error" :title="TAKEN_HINT">URI 已被占用</span>
            </span>
            <template v-if="canWriteUri(item.uri)" #actions>
              <UTooltip :text="TAKEN_HINT" :disabled="!item.uriTaken">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :loading="restoring === item.id"
                  @click="undelete(item)"
                >
                  恢复
                </UButton>
              </UTooltip>
            </template>
          </MemoryRow>
        </li>
      </ul>
      <p v-if="!items.length" class="list-empty">暂无已删除的记忆</p>
      <div v-if="deleted.isError.value" class="list-note">
        <NoteLine tone="error">{{ failure }}</NoteLine>
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
