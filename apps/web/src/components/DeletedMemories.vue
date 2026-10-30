<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { DeletedMemory } from '@kioku/contracts'
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { icons } from '../icons'
import { layerLabels, sensitivityColors, sensitivityLabels } from '../labels'
import { daysUntilPurge, deletionNotice, purgeAt, purgeNote } from '../retention'
import { formatRelative, formatTime, isExpired } from '../time'

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
// 保留期是整个实例的设置，每一页都带着，用第一页的
const retention = computed(() => deleted.data.value?.pages[0]?.retention ?? null)
// 还剩这么几天就要永久清除的标出来
const SOON_DAYS = 3

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
        title: '已撤销删除；这条已经过期，在「已过期」里可以让它重新生效',
        color: 'success',
        actions: [
          {
            label: '去已过期',
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
      toast.add({ title: `已撤销删除 ${memory.uri}`, color: 'success' })
      if (props.spaceId === spaceId) emit('restored', memory.uri)
    }
    // 等列表重新拉取完、这一行消失之后按钮才恢复，免得再点一次。页面收到通知时已经发出了重新拉取，接着等它
    await queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '撤销删除失败', color: 'error' })
  } finally {
    restoring.value = null
  }
}
</script>

<template>
  <div class="space-y-3">
    <p class="text-xs text-muted">
      删除的记忆可以撤销删除，原样回来；同一个 URI
      上已经有别的记忆时不能撤销。撤销删除不动有效期：标着「已过期」的，撤销之后回到「已过期」里，在那里可以让它重新生效。
    </p>
    <p v-if="retention" class="flex items-start gap-1.5 text-xs text-warning">
      <UIcon :name="icons.expired" class="mt-px size-3.5 shrink-0" />
      <span>{{ deletionNotice(retention) }}</span>
    </p>
    <UAlert
      v-if="deleted.isError.value"
      color="error"
      variant="subtle"
      :title="deleted.error.value instanceof ApiError ? deleted.error.value.message : '读取失败'"
    />
    <div v-else-if="deleted.isPending.value" class="space-y-2">
      <USkeleton v-for="n in 4" :key="n" class="h-12 w-full" />
    </div>
    <template v-else>
      <ul class="divide-y divide-default">
        <li v-for="item in items" :key="item.id" class="flex items-center gap-2 py-2">
          <div class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <code class="truncate text-xs">{{ item.uri }}</code>
              <UBadge size="sm" variant="subtle" color="neutral" class="shrink-0">
                {{ layerLabels[item.layer] }}
              </UBadge>
              <UBadge
                size="sm"
                variant="subtle"
                :color="sensitivityColors[item.sensitivity]"
                class="shrink-0"
              >
                {{ sensitivityLabels[item.sensitivity] }}
              </UBadge>
              <UBadge
                v-if="isExpired(item.validTo)"
                size="sm"
                variant="outline"
                color="warning"
                class="shrink-0"
                :title="`删掉之后在 ${formatTime(item.validTo!)} 过期了，撤销删除之后回到「已过期」`"
              >
                已过期
              </UBadge>
            </span>
            <span class="text-xs text-muted">
              删除于
              <time :datetime="item.deletedAt" :title="formatTime(item.deletedAt)">
                {{ formatRelative(item.deletedAt) }}
              </time>
              <template v-if="retention">
                ·
                <span
                  :class="{
                    'text-warning': daysUntilPurge(item.deletedAt, retention) <= SOON_DAYS,
                  }"
                  :title="`最早在 ${formatTime(purgeAt(item.deletedAt, retention).toISOString())} 之后清除`"
                >
                  {{ purgeNote(item.deletedAt, retention) }}
                </span>
              </template>
            </span>
          </div>
          <UButton
            v-if="canWriteUri(item.uri)"
            :icon="icons.undelete"
            size="xs"
            color="neutral"
            variant="subtle"
            :loading="restoring === item.id"
            @click="undelete(item)"
          >
            撤销删除
          </UButton>
        </li>
      </ul>
      <p v-if="!items.length" class="text-sm text-muted">没有删除的记忆。</p>
      <div v-if="deleted.hasNextPage.value" class="flex justify-center">
        <UButton
          color="neutral"
          variant="subtle"
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
