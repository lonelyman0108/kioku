<script setup lang="ts">
import {
  LAYERS,
  MEMORY_LIST_SORTS,
  SENSITIVITIES,
  type MemoryListSort,
  type SpaceOverview,
} from '@kioku/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { icons } from '../icons'
import { sensitivityLabels } from '../labels'
import { missingDisclosureTone } from '../memoryDetail'
import { formatRelative, formatShort, formatTime, isExpired } from '../time'
import Hint from './Hint.vue'
import { DOMAINS_QUERY_OPTIONS } from './memoryTree'
import MemoryRow from './strata/MemoryRow.vue'
import NoteLine from './strata/NoteLine.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import {
  filteredTotal,
  isConversationLayer,
  sensitivityHints,
  swatchText,
  tallyCounts,
} from './strata/strata'

const props = defineProps<{
  spaceId: string
  selectedUri: string | null
  // 概览的统计：能算出总数时写在列表上方
  overview?: SpaceOverview | undefined
}>()
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
  updated: '按最近更新',
  priority: '按优先级',
  uri: '按 URI',
}
const filters = computed(() => ({
  domain: text('domain'),
  layer: oneOf('layer', LAYERS),
  sensitivity: oneOf('sensitivity', SENSITIVITIES),
  missingDisclosure: text('missingDisclosure') === 'true',
  plaintext: text('plaintext') === 'true',
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

// 切到树或已删除时这个视图留在 KeepAlive 里，查询跟着停用
const active = useActivated()
const domains = useQuery({
  queryKey: computed(() => ['memory-domains', props.spaceId]),
  queryFn: () => api.memoryDomains(props.spaceId),
  enabled: active,
  ...DOMAINS_QUERY_OPTIONS,
})
const domainItems = computed(() => [
  { label: '全部 domain', value: null },
  ...(domains.data.value ?? []).map((d) => ({ label: `${d.domain}://`, value: d.domain })),
])
const sortItems = MEMORY_LIST_SORTS.map((s) => ({ label: sortLabels[s], value: s }))

const list = useInfiniteQuery({
  queryKey: computed(() => ['memory-list', props.spaceId, filters.value] as const),
  // 参数从键里取：换了筛选之后，旧键剩下的页还在重新拉取时，不会用上新的筛选条件
  queryFn: ({ pageParam, queryKey: [, spaceId, f] }) => {
    return api.memoryList(spaceId, {
      ...(f.domain ? { domain: f.domain } : {}),
      ...(f.layer ? { layer: f.layer } : {}),
      ...(f.sensitivity ? { sensitivity: f.sensitivity } : {}),
      ...(f.missingDisclosure ? { missingDisclosure: 'true' } : {}),
      ...(f.plaintext ? { plaintext: 'true' } : {}),
      ...(f.q ? { q: f.q } : {}),
      sort: f.sort,
      ...(pageParam ? { cursor: pageParam } : {}),
    })
  },
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: active,
})
const items = computed(() => list.data.value?.pages.flatMap((page) => page.items) ?? [])

// 再点一次取消这个敏感级
function toggleSensitivity(value: string) {
  setFilter('sensitivity', filters.value.sensitivity === value ? null : value)
}
// 窄柱上的层和这里的敏感级一起清掉
function clearStrata() {
  const query = { ...route.query }
  delete query.layer
  delete query.sensitivity
  void router.replace({ query })
}
// 列表只列 URI 树上的记忆，来自对话的两层筛出来是空的：说清楚去哪里看
const conversationLayer = computed(
  () => !!filters.value.layer && isConversationLayer(filters.value.layer),
)
const strataTag = computed(() =>
  filters.value.layer || filters.value.sensitivity
    ? swatchText(filters.value.layer, filters.value.sensitivity)
    : null,
)

// 列表上方的总数：统计里有的才说。列表只列记忆，来自对话的两层不算，所以不用合并的条数。
// 关键字、domain 或两个开关合用时算不出来，说已经载入了多少
const total = computed(() => {
  const data = props.overview
  const f = filters.value
  if (!data || f.q || f.domain) return null
  const strata = f.layer || f.sensitivity
  if (f.missingDisclosure && f.plaintext) return null
  if (f.missingDisclosure) return strata ? null : data.missingDisclosure
  if (f.plaintext) return strata ? null : data.plaintextCredentials
  return filteredTotal(tallyCounts(data.counts), f.layer, f.sensitivity)
})
</script>

<template>
  <div>
    <div class="list-filters">
      <UInput
        v-model="keyword"
        name="q"
        placeholder="搜索 URI 与触发场景"
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
          :model-value="filters.sort"
          :items="sortItems"
          aria-label="排序"
          @update:model-value="(v) => setFilter('sort', v === 'updated' ? null : (v as string))"
        />
      </div>
      <div class="sensitivity-filter" role="group" aria-label="敏感级">
        <button
          v-for="s in SENSITIVITIES"
          :key="s"
          type="button"
          :class="{ on: filters.sensitivity === s }"
          :aria-pressed="filters.sensitivity === s"
          :title="sensitivityHints[s]"
          @click="toggleSensitivity(s)"
        >
          <StrataSwatch
            :layer="filters.layer"
            :sensitivity="s"
            :width="16"
            :height="11"
            decorative
          />
          <span>{{ sensitivityLabels[s] }}</span>
        </button>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        <USwitch
          :model-value="filters.missingDisclosure"
          size="sm"
          label="未设触发场景"
          @update:model-value="(v) => setFilter('missingDisclosure', v ? 'true' : null)"
        />
        <USwitch
          :model-value="filters.plaintext"
          size="sm"
          label="疑似明文凭据"
          @update:model-value="(v) => setFilter('plaintext', v ? 'true' : null)"
        />
      </div>
    </div>

    <p class="list-count">
      <span v-if="strataTag" class="list-tag">
        <StrataSwatch :layer="filters.layer" :sensitivity="filters.sensitivity" decorative />
        {{ strataTag }}
        <button type="button" aria-label="清除筛选" @click="clearStrata">
          <UIcon :name="icons.cancel" class="size-3.5" />
        </button>
      </span>
      <span v-if="total !== null"
        ><b>{{ total }}</b> 条</span
      >
      <span v-else-if="items.length">
        已载入 <b>{{ items.length }}</b> 条
      </span>
    </p>

    <div v-if="conversationLayer" class="list-note">
      <NoteLine>
        来自对话的内容不在记忆列表中<Hint>
          联系人层的事实和情节层的会话摘要在联系人详情中查看。
        </Hint>
        <template #actions>
          <UButton
            size="sm"
            color="primary"
            variant="outline"
            :to="{ name: 'subjects', params: { spaceId } }"
          >
            查看联系人
          </UButton>
        </template>
      </NoteLine>
    </div>

    <!-- 读取失败时已经读到的行留着：翻页失败的错误放在「加载更多」上面，其余放在最上面 -->
    <div v-if="list.isError.value && !list.isFetchNextPageError.value" class="list-note">
      <NoteLine tone="error">{{ readFailure(list.error.value) }}</NoteLine>
    </div>
    <div v-if="list.isPending.value" class="space-y-2 p-3.5">
      <USkeleton v-for="n in 5" :key="n" class="h-12 w-full" />
    </div>
    <template v-else-if="list.data.value">
      <ul>
        <li v-for="item in items" :key="item.id">
          <MemoryRow
            as="button"
            type="button"
            :uri="item.uri"
            :layer="item.layer"
            :sensitivity="item.sensitivity"
            :priority="item.priority"
            :selected="item.uri === selectedUri"
            :aria-current="item.uri === selectedUri ? 'true' : undefined"
            @click="emit('select', item.uri)"
          >
            <span class="flex items-baseline gap-2">
              <span class="min-w-0 flex-1 truncate">
                <span
                  v-if="missingDisclosureTone(item)"
                  :class="{
                    'text-warning':
                      missingDisclosureTone(item) === 'warning' && item.uri !== selectedUri,
                  }"
                >
                  未设触发场景
                </span>
                <template v-else>{{ item.disclosure }}</template>
              </span>
              <!-- 列表只列有效的；载入之后才到期的在这里显示已过期 -->
              <span
                v-if="item.validTo"
                class="shrink-0 text-xs"
                :class="{ 'text-warning': isExpired(item.validTo) && item.uri !== selectedUri }"
                :title="`有效期至 ${formatTime(item.validTo)}`"
              >
                {{ isExpired(item.validTo) ? '已过期' : `${formatShort(item.validTo)} 到期` }}
              </span>
              <time
                :datetime="item.updatedAt"
                :title="formatTime(item.updatedAt)"
                class="shrink-0 text-xs"
              >
                {{ formatRelative(item.updatedAt) }}
              </time>
            </span>
          </MemoryRow>
        </li>
      </ul>
      <p v-if="!items.length && !conversationLayer" class="list-empty">没有符合条件的记忆</p>
      <div v-if="list.isFetchNextPageError.value" class="list-note">
        <NoteLine tone="error">{{ readFailure(list.error.value) }}</NoteLine>
      </div>
      <div v-if="list.hasNextPage.value" class="flex justify-center py-3">
        <UButton
          color="neutral"
          variant="outline"
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

<style scoped>
.list-filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 11px;
  border-bottom: 1px solid var(--ui-border);
}
.sensitivity-filter {
  display: flex;
  border: 1px solid var(--ui-border-accented);
}
.sensitivity-filter button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  font-size: 13px;
  line-height: 1;
  color: var(--ui-text-muted);
}
.sensitivity-filter button + button {
  border-left: 1px solid var(--ui-border-accented);
}
.sensitivity-filter button:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.sensitivity-filter button:focus-visible {
  outline-offset: -2px;
}
.sensitivity-filter button.on {
  --strata-frame: var(--strata-selected-frame);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.list-count {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  min-height: 37px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.55;
}
.list-count:empty {
  display: none;
}
.list-count b {
  font-family: var(--font-mono);
  font-weight: 600;
}
.list-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.list-tag button {
  display: inline-flex;
  padding: 2px;
  margin-left: -2px;
  color: var(--ui-text-muted);
}
.list-tag button:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.list-note {
  padding: 14px 14px 0;
}
.list-empty {
  padding: 18px 14px;
  color: var(--ui-text-muted);
}
</style>
