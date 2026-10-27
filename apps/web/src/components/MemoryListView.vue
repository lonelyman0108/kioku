<script setup lang="ts">
import { LAYERS, MEMORY_LIST_SORTS, SENSITIVITIES, type MemoryListSort } from '@kioku/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { layerLabels, sensitivityColors, sensitivityLabels } from '../labels'
import { formatRelative, formatTime } from '../time'

const props = defineProps<{ spaceId: string; selectedUri: string | null }>()
const emit = defineEmits<{ select: [uri: string] }>()
const route = useRoute()
const router = useRouter()

// 筛选条件放在地址里：刷新、分享链接、从概览点过来都能还原
const text = (key: string) => {
  const value = route.query[key]
  return typeof value === 'string' && value ? value : null
}
function oneOf<T extends string>(key: string, values: readonly T[]): T | null {
  const value = text(key)
  return value && (values as readonly string[]).includes(value) ? (value as T) : null
}
const sortLabels: Record<MemoryListSort, string> = {
  updated: '最近更新',
  priority: 'priority',
  uri: 'URI',
}
const filters = computed(() => ({
  domain: text('domain'),
  layer: oneOf('layer', LAYERS),
  sensitivity: oneOf('sensitivity', SENSITIVITIES),
  missingDisclosure: text('missingDisclosure') === 'true',
  q: text('q'),
  sort: oneOf('sort', MEMORY_LIST_SORTS) ?? 'updated',
}))
function setFilter(key: string, value: string | null) {
  const query = { ...route.query }
  if (value) query[key] = value
  else delete query[key]
  void router.replace({ query })
}

// 关键字输入停下来之后再写进地址
const keyword = ref(filters.value.q ?? '')
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => setFilter('q', value.trim() || null), 300)
})
watch(
  () => filters.value.q,
  (q) => {
    if ((q ?? '') !== keyword.value.trim()) keyword.value = q ?? ''
  },
)
onBeforeUnmount(() => clearTimeout(timer))

const domains = useQuery({
  queryKey: computed(() => ['memory-domains', props.spaceId]),
  queryFn: () => api.memoryDomains(props.spaceId),
})
const domainItems = computed(() => [
  { label: '全部 domain', value: null },
  ...(domains.data.value ?? []).map((d) => ({ label: `${d.domain}://`, value: d.domain })),
])
const layerItems = [
  { label: '全部层', value: null },
  ...LAYERS.map((l) => ({ label: layerLabels[l], value: l })),
]
const sensitivityItems = [
  { label: '全部敏感级', value: null },
  ...SENSITIVITIES.map((s) => ({ label: sensitivityLabels[s], value: s })),
]
const sortItems = MEMORY_LIST_SORTS.map((s) => ({ label: `按${sortLabels[s]}`, value: s }))

const list = useInfiniteQuery({
  queryKey: computed(() => ['memory-list', props.spaceId, filters.value] as const),
  // 参数从键里取：换了筛选之后，旧键剩下的页还在重新拉取时，不会用上新的筛选条件
  queryFn: ({ pageParam, queryKey: [, spaceId, f] }) => {
    return api.memoryList(spaceId, {
      ...(f.domain ? { domain: f.domain } : {}),
      ...(f.layer ? { layer: f.layer } : {}),
      ...(f.sensitivity ? { sensitivity: f.sensitivity } : {}),
      ...(f.missingDisclosure ? { missingDisclosure: 'true' } : {}),
      ...(f.q ? { q: f.q } : {}),
      sort: f.sort,
      ...(pageParam ? { cursor: pageParam } : {}),
    })
  },
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})
const items = computed(() => list.data.value?.pages.flatMap((page) => page.items) ?? [])
</script>

<template>
  <div class="space-y-3">
    <UInput
      v-model="keyword"
      name="q"
      placeholder="在 URI 与 disclosure 里找"
      aria-label="关键字"
      class="w-full"
    />
    <div class="grid grid-cols-2 gap-2">
      <USelect
        :model-value="filters.domain"
        :items="domainItems"
        aria-label="domain"
        @update:model-value="(v) => setFilter('domain', (v as string | null) ?? null)"
      />
      <USelect
        :model-value="filters.layer"
        :items="layerItems"
        aria-label="层"
        @update:model-value="(v) => setFilter('layer', (v as string | null) ?? null)"
      />
      <USelect
        :model-value="filters.sensitivity"
        :items="sensitivityItems"
        aria-label="敏感级"
        @update:model-value="(v) => setFilter('sensitivity', (v as string | null) ?? null)"
      />
      <USelect
        :model-value="filters.sort"
        :items="sortItems"
        aria-label="排序"
        @update:model-value="(v) => setFilter('sort', v === 'updated' ? null : (v as string))"
      />
    </div>
    <UCheckbox
      :model-value="filters.missingDisclosure"
      label="只看没写 disclosure 的"
      @update:model-value="(v) => setFilter('missingDisclosure', v ? 'true' : null)"
    />

    <UAlert
      v-if="list.isError.value"
      color="error"
      variant="subtle"
      :title="list.error.value instanceof ApiError ? list.error.value.message : '读取失败'"
    />
    <div v-else-if="list.isPending.value" class="space-y-2">
      <USkeleton v-for="n in 5" :key="n" class="h-12 w-full" />
    </div>
    <template v-else>
      <ul class="space-y-1">
        <li v-for="item in items" :key="item.id">
          <button
            type="button"
            class="w-full rounded-md px-2 py-1.5 text-left hover:bg-elevated/60"
            :class="item.uri === selectedUri ? 'bg-elevated' : ''"
            :aria-current="item.uri === selectedUri ? 'true' : undefined"
            @click="emit('select', item.uri)"
          >
            <span class="flex items-center gap-1.5">
              <code class="min-w-0 truncate text-xs">{{ item.uri }}</code>
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
              <span class="ml-auto shrink-0 text-xs text-muted">P{{ item.priority }}</span>
            </span>
            <span class="mt-0.5 flex items-center gap-2 text-xs text-muted">
              <span class="min-w-0 flex-1 truncate">
                {{ item.disclosure?.trim() || '没写 disclosure' }}
              </span>
              <time :datetime="item.updatedAt" :title="formatTime(item.updatedAt)" class="shrink-0">
                {{ formatRelative(item.updatedAt) }}
              </time>
            </span>
          </button>
        </li>
      </ul>
      <p v-if="!items.length" class="text-sm text-muted">没有符合条件的记忆。</p>
      <div v-if="list.hasNextPage.value" class="flex justify-center">
        <UButton
          color="neutral"
          variant="subtle"
          size="sm"
          :loading="list.isFetchingNextPage.value"
          @click="list.fetchNextPage()"
        >
          加载更多
        </UButton>
      </div>
    </template>
  </div>
</template>
