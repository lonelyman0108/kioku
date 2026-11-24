<script setup lang="ts">
import {
  ENTRY_KINDS,
  ENTRY_LIST_SORTS,
  SENSITIVITIES,
  STRATA_BANDS,
  TopicTag,
  type CircleKind,
  type CircleOverview,
  type EntryKind,
  type EntryListSort,
  type StrataBand,
} from '@kioku/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { icons } from '../icons'
import { builtinFacetLabels, sensitivityLabels } from '../labels'
import { missingDisclosure } from '../memoryDetail'
import { formatRelative, formatShort, formatTime, isExpired } from '../time'
import Hint from './Hint.vue'
import MemoryRow from './strata/MemoryRow.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import {
  entryBand,
  filteredTotal,
  isConversationBand,
  sensitivityHints,
  swatchText,
  tallyCounts,
} from './strata/strata'

const props = withDefaults(
  defineProps<{
    circleId: string
    circleKind: CircleKind
    canSeeSecret?: boolean
    selectedId: string | null
    // 概览的统计：能算出总数时写在列表上方
    overview?: CircleOverview | undefined
  }>(),
  { canSeeSecret: false, overview: undefined },
)
const emit = defineEmits<{ select: [shortId: string] }>()
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
const sortLabels: Record<EntryListSort, string> = {
  updated: '按最近更新',
  priority: '按优先级',
  shortId: '按短 ID',
}
function validTopicTag(raw: string | null): string | null {
  if (!raw) return null
  const parsed = TopicTag.safeParse(raw)
  return parsed.success ? parsed.data : null
}

const filters = computed(() => {
  const rawTopic = text('topic')
  return {
    band: oneOf('band', STRATA_BANDS),
    kind: oneOf('kind', ENTRY_KINDS),
    sensitivity: oneOf('sensitivity', SENSITIVITIES),
    topic: validTopicTag(rawTopic),
    dimensionKey: text('dimensionKey'),
    termSlug: text('termSlug'),
    missingDisclosure: text('missingDisclosure') === 'true',
    plaintext: text('plaintext') === 'true',
    q: text('q'),
    sort: oneOf('sort', ENTRY_LIST_SORTS) ?? 'updated',
  }
})
const topicInvalid = computed(() => {
  const raw = topicText.value.trim()
  return Boolean(raw) && !TopicTag.safeParse(raw.toLowerCase()).success
})

function setFilter(key: string, value: string | null) {
  const query = { ...route.query }
  if (value) query[key] = value
  else delete query[key]
  void router.replace({ query })
}
function setFacetFilter(encoded: string | null) {
  const query = { ...route.query }
  if (!encoded) {
    delete query.dimensionKey
    delete query.termSlug
  } else {
    const [dim, slug] = encoded.split(':')
    if (dim && slug) {
      query.dimensionKey = dim
      query.termSlug = slug
    }
  }
  void router.replace({ query })
}

// 关键字与主题输入停下来之后再写进地址
const keyword = ref(filters.value.q ?? '')
const topicText = ref(filters.value.topic ?? '')
let qTimer: ReturnType<typeof setTimeout> | undefined
let topicTimer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (value) => {
  clearTimeout(qTimer)
  qTimer = setTimeout(() => setFilter('q', value.trim() || null), 300)
})
watch(
  () => filters.value.q,
  (q) => {
    if ((q ?? '') !== keyword.value.trim()) keyword.value = q ?? ''
  },
)
watch(topicText, (value) => {
  clearTimeout(topicTimer)
  const normalized = value.trim().toLowerCase()
  topicTimer = setTimeout(() => {
    if (!normalized) {
      setFilter('topic', null)
      return
    }
    const parsed = TopicTag.safeParse(normalized)
    if (parsed.success) setFilter('topic', parsed.data)
  }, 300)
})
watch(
  () => filters.value.topic,
  (t) => {
    if ((t ?? '') !== topicText.value.trim().toLowerCase()) topicText.value = t ?? ''
  },
)
onBeforeUnmount(() => {
  clearTimeout(qTimer)
  clearTimeout(topicTimer)
})

const active = useActivated()
const facets = useQuery({
  queryKey: computed(() => ['facets', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
  enabled: active,
})

const facetItems = computed(() => {
  const data = facets.data.value
  const items: { label: string; value: string | null }[] = [{ label: '全部适用条件', value: null }]
  const dimMap = new Map<string, string>()
  for (const d of data?.dimensions ?? []) dimMap.set(d.key, d.name)
  for (const t of data?.terms ?? []) {
    const dimName =
      dimMap.get(t.dimensionKey) ??
      builtinFacetLabels[t.dimensionKey as keyof typeof builtinFacetLabels] ??
      t.dimensionKey
    items.push({ label: `${dimName} › ${t.label}`, value: `${t.dimensionKey}:${t.slug}` })
  }
  const dk = filters.value.dimensionKey
  const ts = filters.value.termSlug
  if (dk && ts) {
    const value = `${dk}:${ts}`
    if (!items.some((item) => item.value === value)) items.push({ label: `${dk}:${ts}`, value })
  }
  return items
})

const selectedFacet = computed(() =>
  filters.value.dimensionKey && filters.value.termSlug
    ? `${filters.value.dimensionKey}:${filters.value.termSlug}`
    : null,
)
const sortItems = ENTRY_LIST_SORTS.map((s) => ({ label: sortLabels[s], value: s }))

const conversationBand = computed(
  () => !!filters.value.band && isConversationBand(filters.value.band),
)
const personaBand = computed(() => filters.value.band === 'persona')
const specialBand = computed(() => personaBand.value)

function effectiveKind(band: StrataBand | null, explicit: EntryKind | null): EntryKind | undefined {
  if (explicit) return explicit
  if (band === 'episode') return 'episode'
  if (band === 'fact') return 'fact'
  if (band === 'primary' || band === 'personal' || band === 'shared-away') return 'entry'
  return undefined
}

const list = useInfiniteQuery({
  queryKey: computed(() => ['entry-list', props.circleId, filters.value] as const),
  queryFn: ({ pageParam, queryKey: [, cid, f] }) => {
    const kind = effectiveKind(f.band, f.kind)
    return api.entryList(cid, {
      ...(kind ? { kind } : {}),
      ...(f.sensitivity ? { sensitivity: f.sensitivity } : {}),
      ...(f.topic ? { topic: f.topic } : {}),
      ...(f.dimensionKey ? { dimensionKey: f.dimensionKey } : {}),
      ...(f.termSlug ? { termSlug: f.termSlug } : {}),
      ...(f.missingDisclosure ? { missingDisclosure: 'true' } : {}),
      ...(f.plaintext ? { plaintext: 'true' } : {}),
      ...(f.q ? { q: f.q } : {}),
      sort: f.sort,
      ...(pageParam ? { cursor: pageParam } : {}),
    })
  },
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: computed(() => active.value && !specialBand.value),
})

const items = computed(() =>
  specialBand.value ? [] : (list.data.value?.pages.flatMap((page) => page.items) ?? []),
)
// 每一行没写触发场景时怎么提示：随列表算一次，渲染时不再每行重复判断
const rows = computed(() => items.value.map((item) => ({ item, missing: missingDisclosure(item) })))

const currentEffectiveKind = computed(() => effectiveKind(filters.value.band, filters.value.kind))
const visibleSensitivities = computed(() =>
  SENSITIVITIES.filter(
    (s) => s !== 'secret' || (props.canSeeSecret && currentEffectiveKind.value !== 'episode'),
  ),
)

function toggleSensitivity(value: string) {
  setFilter('sensitivity', filters.value.sensitivity === value ? null : value)
}
function clearStrata() {
  const query = { ...route.query }
  delete query.band
  delete query.sensitivity
  delete query.kind
  void router.replace({ query })
}
const strataTag = computed(() =>
  filters.value.band || filters.value.sensitivity
    ? swatchText(filters.value.band, filters.value.sensitivity, true)
    : null,
)

// 列表上方的总数：统计里有的才说。带关键字、主题、适用条件筛选或两个开关合用时算不出来，说已经载入了多少
const total = computed(() => {
  const data = props.overview
  const f = filters.value
  if (!data || specialBand.value || f.q || f.topic || f.dimensionKey || f.termSlug || f.kind) {
    return null
  }
  const strata = f.band || f.sensitivity
  if (f.missingDisclosure && f.plaintext) return null
  if (f.missingDisclosure) return strata ? null : data.missingDisclosure
  if (f.plaintext) return strata ? null : data.plaintextCredentials
  return filteredTotal(
    tallyCounts({
      circleKind: props.circleKind,
      counts: data.counts,
      extractedCounts: data.extractedCounts,
    }),
    f.band,
    f.sensitivity,
  )
})
</script>

<template>
  <div>
    <div class="list-filters">
      <UInput
        v-model="keyword"
        name="q"
        :maxlength="200"
        placeholder="搜索标题、短 ID 与召回说明"
        aria-label="关键字"
        class="w-full"
      />
      <div class="grid grid-cols-2 gap-2">
        <USelect
          :model-value="selectedFacet"
          :items="facetItems"
          aria-label="适用条件"
          @update:model-value="(v) => setFacetFilter((v as string | null) ?? null)"
        />
        <USelect
          :model-value="filters.sort"
          :items="sortItems"
          aria-label="排序"
          @update:model-value="(v) => setFilter('sort', v === 'updated' ? null : (v as string))"
        />
      </div>
      <UInput
        v-model="topicText"
        name="topic"
        size="sm"
        :maxlength="64"
        placeholder="按主题标签筛选（例如 deploy）"
        aria-label="主题筛选"
        class="w-full"
      />
      <p v-if="topicInvalid" class="text-xs text-error">
        主题标签仅支持小写字母、数字与连字符（1–64 字符）。
      </p>
      <div class="sensitivity-filter" role="group" aria-label="敏感级">
        <button
          v-for="s in visibleSensitivities"
          :key="s"
          type="button"
          :class="{ on: filters.sensitivity === s }"
          :aria-pressed="filters.sensitivity === s"
          :title="sensitivityHints[s]"
          @click="toggleSensitivity(s)"
        >
          <StrataSwatch :band="filters.band" :sensitivity="s" :width="16" :height="11" decorative />
          <span>{{ sensitivityLabels[s] }}</span>
        </button>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        <USwitch
          :model-value="filters.missingDisclosure"
          size="sm"
          label="未设召回说明"
          @update:model-value="(v) => setFilter('missingDisclosure', v ? 'true' : null)"
        />
        <USwitch
          :model-value="filters.plaintext"
          size="sm"
          label="疑似敏感内容"
          @update:model-value="(v) => setFilter('plaintext', v ? 'true' : null)"
        />
      </div>
    </div>

    <p class="list-count">
      <span v-if="strataTag" class="list-tag">
        <StrataSwatch :band="filters.band" :sensitivity="filters.sensitivity" local decorative />
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

    <div v-if="conversationBand" class="list-note">
      <NoteLine>
        当前列出从对话记录的条目；完整会话与联系人档案可在「对话」中查看。
        <template #actions>
          <UButton
            size="sm"
            color="primary"
            variant="outline"
            :to="{
              name: 'conversations',
              params: { circleId },
              query: filters.band === 'fact' ? { tab: 'contacts' } : {},
            }"
          >
            查看对话
          </UButton>
        </template>
      </NoteLine>
    </div>
    <div v-if="personaBand" class="list-note">
      <NoteLine>
        人格设定独立于记忆列表<Hint> 人格继承树与设定覆盖在「人格」页面查看和编辑。 </Hint>
        <template #actions>
          <UButton
            size="sm"
            color="primary"
            variant="outline"
            :to="{ name: 'personas', params: { circleId } }"
          >
            查看人格
          </UButton>
        </template>
      </NoteLine>
    </div>

    <template v-else>
      <!-- 读取失败时已经读到的行留着：翻页失败的错误放在「加载更多」上面，其余放在最上面 -->
      <div v-if="list.isError.value && !list.isFetchNextPageError.value" class="list-note">
        <ReadFailureNote :query="list" />
      </div>
      <div v-if="list.isPending.value" class="space-y-2 p-3.5">
        <USkeleton v-for="n in 5" :key="n" class="h-12 w-full" />
      </div>
      <template v-else-if="list.data.value">
        <ul>
          <li v-for="{ item, missing } in rows" :key="item.id">
            <MemoryRow
              as="button"
              type="button"
              :short-id="item.shortId"
              :title="item.title"
              :band="
                entryBand(
                  { kind: item.kind, circleId: item.circleId, circleKind },
                  { id: circleId, kind: circleKind },
                )
              "
              :kind="item.kind"
              :sensitivity="item.sensitivity"
              :priority="item.priority"
              :variant-count="item.variantCount"
              local
              :selected="item.shortId === selectedId"
              :aria-current="item.shortId === selectedId ? 'true' : undefined"
              @click="emit('select', item.shortId)"
            >
              <span class="flex items-baseline gap-2">
                <span class="min-w-0 flex-1 truncate">
                  <span
                    v-if="missing"
                    :class="{
                      'text-warning': missing.tone === 'warning' && item.shortId !== selectedId,
                    }"
                  >
                    {{ missing.short }}
                  </span>
                  <template v-else>{{ item.disclosure }}</template>
                </span>
                <!-- 列表只列有效的；载入之后才到期的在这里显示已过期 -->
                <span
                  v-if="item.validTo"
                  class="shrink-0 text-xs"
                  :class="{
                    'text-warning': isExpired(item.validTo) && item.shortId !== selectedId,
                  }"
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
        <p v-if="!items.length" class="list-empty">没有符合条件的记忆</p>
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
  font-variant-numeric: tabular-nums;
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
