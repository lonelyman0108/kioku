<script setup lang="ts">
import type { MemoryListItem } from '@kioku/contracts'
import { useInfiniteQuery } from '@tanstack/vue-query'
import { computed, ref, toRef, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { usePlaintextActions } from '../composables/usePlaintextActions'
import { memoryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import ConvertCredentialModal from './ConvertCredentialModal.vue'
import Hint from './Hint.vue'
import MemoryFlags from './strata/MemoryFlags.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import UriPath from './strata/UriPath.vue'

// 疑似明文凭据：逐条转存为凭据或者忽略，忽略过的可以看、可以撤销。列表接口不给正文，这里也不显示值
const props = defineProps<{ spaceId: string }>()
const spaceId = toRef(props, 'spaceId')
const permissions = useMemoryPermissions(spaceId)
const actions = usePlaintextActions(spaceId)

type Filter = 'true' | 'ignored'
const filter = ref<Filter>('true')
const filters = [
  { label: '待处理', value: 'true' },
  { label: '已忽略', value: 'ignored' },
]
watch(spaceId, () => (filter.value = 'true'))

const active = useActivated()
const list = useInfiniteQuery({
  queryKey: computed(() => ['memory-list', props.spaceId, { plaintext: filter.value }] as const),
  // 参数从键里取：换了筛选之后，旧键剩下的页还在重新拉取时，不会用上新的筛选条件
  queryFn: ({ pageParam, queryKey: [, sid, f] }) =>
    api.memoryList(sid, { plaintext: f.plaintext, ...(pageParam ? { cursor: pageParam } : {}) }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: active,
})
const items = computed(() => list.data.value?.pages.flatMap((page) => page.items) ?? [])

const converting = ref<string | null>(null)
const convertOpen = ref(false)
function openConvert(item: MemoryListItem) {
  converting.value = item.uri
  convertOpen.value = true
}
</script>

<template>
  <div>
    <SectionHeading title="疑似明文凭据">
      <template #hint>
        <Hint>
          正文疑似包含密码或
          Token。建议转存为凭据，正文改用占位符。检测规则可能误判，确认不是凭据时可忽略；正文修改后会重新提示。
        </Hint>
      </template>
    </SectionHeading>
    <div class="plain-bar">
      <UTabs v-model="filter" :items="filters" :content="false" size="sm" class="w-auto" />
    </div>
    <NoteLine v-if="list.isError.value && !list.data.value" class="plain-note" tone="error">
      {{ list.error.value instanceof ApiError ? list.error.value.message : '读取失败' }}
    </NoteLine>
    <div v-else-if="list.isPending.value" class="mt-3 space-y-3">
      <USkeleton v-for="n in 3" :key="n" class="h-12 w-full" />
    </div>
    <template v-else>
      <p v-if="!items.length" class="plain-empty">
        {{ filter === 'true' ? '暂无疑似明文凭据' : '暂无已忽略的提示' }}
      </p>
      <ul v-else>
        <li v-for="item in items" :key="item.id" class="plain-row">
          <div class="plain-uri">
            <StrataSwatch :layer="item.layer" :sensitivity="item.sensitivity" />
            <RouterLink :to="memoryRoute(spaceId, item.uri)"
              ><UriPath :uri="item.uri"
            /></RouterLink>
            <MemoryFlags :layer="item.layer" :sensitivity="item.sensitivity" />
          </div>
          <p class="plain-sub">
            <span v-if="item.disclosure">{{ item.disclosure }}</span>
            <time :datetime="item.updatedAt" :title="formatTime(item.updatedAt)">
              更新于 {{ formatRelative(item.updatedAt) }}
            </time>
          </p>
          <div v-if="!permissions.readOnlyReason(item)" class="plain-actions">
            <template v-if="filter === 'true'">
              <UButton @click="openConvert(item)">转存为凭据</UButton>
              <UButton
                color="primary"
                variant="outline"
                :loading="actions.busy.value === item.id"
                :disabled="actions.busy.value !== null"
                @click="actions.ignore(item)"
              >
                忽略
              </UButton>
            </template>
            <UButton
              v-else
              color="primary"
              variant="outline"
              :loading="actions.busy.value === item.id"
              :disabled="actions.busy.value !== null"
              @click="actions.unignore(item)"
            >
              撤销忽略
            </UButton>
          </div>
        </li>
      </ul>
      <div v-if="list.hasNextPage.value" class="mt-4 flex justify-center">
        <UButton
          color="neutral"
          variant="outline"
          :loading="list.isFetchingNextPage.value"
          @click="list.fetchNextPage()"
        >
          加载更多
        </UButton>
      </div>
    </template>

    <ConvertCredentialModal v-model:open="convertOpen" :space-id="spaceId" :uri="converting" />
  </div>
</template>

<style scoped>
.plain-bar {
  display: flex;
  align-items: center;
  min-height: 50px;
  padding: 9px 0;
  border-bottom: 1px solid var(--ui-border);
}
.note-line.plain-note {
  margin: 10px 0 0;
  border-top: 0;
}
.plain-empty {
  padding: 22px 0;
  color: var(--ui-text-muted);
}
.plain-row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 24px;
  min-height: 60px;
  padding: 11px 0;
  border-bottom: 1px solid var(--ui-border);
}
.plain-uri {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-size: 14px;
}
.plain-uri a {
  min-width: 0;
}
.plain-uri a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.plain-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  min-width: 0;
  font-size: 14px;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.plain-actions {
  display: flex;
  gap: 6px;
}
@media (max-width: 1023.98px) {
  .plain-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .plain-actions > * {
    flex: 1;
    justify-content: center;
  }
}
</style>
