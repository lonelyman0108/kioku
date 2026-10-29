<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ExpiredMemory } from '@kioku/contracts'
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { icons } from '../icons'
import { layerLabels, sensitivityColors, sensitivityLabels } from '../labels'
import { formatRelative, formatTime } from '../time'
import MemoryHistory from './MemoryHistory.vue'

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
    toast.add({ title: `已重新生效 ${memory.uri}`, color: 'success' })
    if (viewing.value?.id === item.id) viewing.value = null
    if (props.spaceId === spaceId) emit('reactivated', memory.uri)
    // 等列表重新拉取完、这一行消失之后按钮才恢复，免得再点一次。页面收到通知时已经发出了重新拉取，接着等它
    await queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '重新生效失败', color: 'error' })
    // 版本对不上、已经被别人重新生效了：刷新列表
    if (err instanceof ApiError && err.status === 409) void expired.refetch()
  } finally {
    reactivating.value = null
  }
}
</script>

<template>
  <div class="space-y-3">
    <p class="text-xs text-muted">
      过了有效期的记忆不再召回、不进
      boot。重新生效之后一直有效，需要的话再设新的有效期。标着「已让出」的，过期之后同一个 URI
      上写了新的记忆，那条还在时要先把它移走或删掉。
    </p>
    <UAlert
      v-if="expired.isError.value"
      color="error"
      variant="subtle"
      :title="expired.error.value instanceof ApiError ? expired.error.value.message : '读取失败'"
    />
    <div v-else-if="expired.isPending.value" class="space-y-2">
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
                v-if="item.released"
                size="sm"
                variant="outline"
                color="warning"
                class="shrink-0"
                title="过期之后同一个 URI 上写了新的记忆，它让出了 URI"
              >
                已让出
              </UBadge>
            </span>
            <span class="text-xs text-muted">
              过期于
              <time :datetime="item.expiredAt" :title="formatTime(item.expiredAt)">
                {{ formatRelative(item.expiredAt) }}
              </time>
            </span>
          </div>
          <UButton
            :icon="icons.activity"
            size="xs"
            color="neutral"
            variant="ghost"
            :aria-label="`${item.uri} 的历史`"
            @click="viewing = item"
          />
          <UButton
            v-if="canWriteUri(item.uri)"
            :icon="icons.reactivate"
            size="xs"
            color="neutral"
            variant="subtle"
            :loading="reactivating === item.id"
            @click="reactivate(item)"
          >
            重新生效
          </UButton>
        </li>
      </ul>
      <p v-if="!items.length" class="text-sm text-muted">没有过期的记忆。</p>
      <div v-if="expired.hasNextPage.value" class="flex justify-center">
        <UButton
          color="neutral"
          variant="subtle"
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
