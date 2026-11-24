<script setup lang="ts">
import { CONVERSATION_KINDS, type ConversationKind } from '@kioku/contracts'
import type { TabsItem } from '@nuxt/ui'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import ContactList from '../components/ContactList.vue'
import ConversationDetail from '../components/ConversationDetail.vue'
import Hint from '../components/Hint.vue'
import { focusAfterSelect } from '../components/memoryTree'
import EmptyState from '../components/strata/EmptyState.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import { useViewport } from '../composables/useViewport'
import { conversationKindLabels, conversationSubline, conversationTitle } from '../conversations'
import { icons } from '../icons'
import { formatShort, formatTime } from '../time'

// 对话：会话与联系人两个分页。联系人回答「关于谁」，会话回答「在哪聊的、聊了什么」。
const route = useRoute()
const router = useRouter()
const circleId = computed(() => String(route.params.circleId))

type Tab = 'sessions' | 'contacts'
const tab = computed<Tab>(() => (route.query.tab === 'contacts' ? 'contacts' : 'sessions'))
const tabItems: TabsItem[] = [
  { label: '会话', value: 'sessions' },
  { label: '联系人', value: 'contacts' },
]
// 换分页时选中的会话与筛选不带过去
function setTab(value: string | number) {
  void router.replace({ query: value === 'contacts' ? { tab: 'contacts' } : {} })
}

// 选中的会话、按客户端与类型的筛选记在地址里：从客户端或联系人详情点过来时直接打开
const text = (key: string) => {
  const value = route.query[key]
  return typeof value === 'string' && value ? value : null
}
const selectedId = computed(() => (tab.value === 'sessions' ? text('id') : null))
const clientId = computed(() => text('client'))
const selectedKind = computed<ConversationKind | 'all'>(() => {
  const raw = text('kind')
  return raw && (CONVERSATION_KINDS as readonly string[]).includes(raw)
    ? (raw as ConversationKind)
    : 'all'
})

function withQuery(changes: Record<string, string | null>) {
  const query = { ...route.query }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete query[key]
    else query[key] = value
  }
  return { query }
}
const select = (id: string | null) => router.replace(withQuery({ id }))
const clearClient = () => router.replace(withQuery({ client: null }))
const setKind = (kind: string) =>
  router.replace(withQuery({ kind: kind === 'all' ? null : kind, id: null }))

const kindItems = [
  { label: '全部类型', value: 'all' },
  ...CONVERSATION_KINDS.map((kind) => ({ label: conversationKindLabels[kind], value: kind })),
]

// 重新读取（刷新、失效）从第一页读起，后面几页的游标按新读到的算：服务端按最近活动翻页
const list = useInfiniteQuery({
  queryKey: computed(
    () => ['conversations', circleId.value, clientId.value, selectedKind.value] as const,
  ),
  queryFn: ({ pageParam, queryKey: [, cid, client, kind] }) =>
    api.conversations(cid, {
      clientId: client ?? undefined,
      kind: kind === 'all' ? undefined : kind,
      cursor: pageParam,
    }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: computed(() => tab.value === 'sessions'),
})
const items = computed(() => list.data.value?.pages.flatMap((page) => page.items) ?? [])

// 筛选条上写客户端的名字：列表里有就用列表里的，没有再去列表里找
const clients = useQuery({
  queryKey: computed(() => ['clients', circleId.value] as const),
  queryFn: () => api.clients(circleId.value),
  enabled: computed(() => clientId.value !== null),
})
const clientName = computed(
  () =>
    items.value.find((c) => c.client.id === clientId.value)?.client.name ??
    clients.data.value?.find((a) => a.id === clientId.value)?.name ??
    '…',
)

function refresh() {
  void list.refetch()
}

// 窄屏上列表和详情只显示一个，切换之后原来有焦点的那一行藏起来了：打开时放到详情的标题，
// 返回时放回原来那一行，那一行没了就放到列表这一栏
const viewport = useViewport()
const narrow = computed(() => viewport.value.width < 1024)
const listColumn = ref<HTMLElement | null>(null)
const detailRef = ref<InstanceType<typeof ConversationDetail> | null>(null)
const rowOf = (id: string) =>
  listColumn.value?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
watch(selectedId, async (id, previous) => {
  const target = focusAfterSelect(narrow.value, id, previous)
  if (!target) return
  await nextTick()
  if (target.to === 'title') return detailRef.value?.focusTitle()
  ;(rowOf(target.shortId) ?? listColumn.value)?.focus()
})
</script>

<template>
  <div v-if="tab === 'sessions'" class="sessions" :class="{ 'has-selection': selectedId !== null }">
    <section ref="listColumn" class="list-column" aria-label="会话列表" tabindex="-1">
      <div class="list-head">
        <UTabs
          :model-value="tab"
          :items="tabItems"
          :content="false"
          variant="link"
          size="md"
          :ui="{ root: 'min-w-0', list: 'border-0', trigger: 'px-2 py-0 h-11 text-sm/5' }"
          @update:model-value="setTab"
        />
        <div class="list-actions">
          <USelect
            :model-value="selectedKind"
            :items="kindItems"
            value-key="value"
            size="xs"
            aria-label="筛选会话类型"
            class="w-28"
            @update:model-value="setKind"
          />
          <UButton
            :icon="icons.refresh"
            size="sm"
            color="neutral"
            variant="ghost"
            aria-label="刷新"
            :loading="list.isRefetching.value"
            @click="refresh"
          />
        </div>
      </div>
      <p v-if="clientId" class="list-filter">
        <span class="min-w-0 truncate">客户端「{{ clientName }}」的会话</span>
        <button type="button" aria-label="清除筛选" @click="clearClient">
          <UIcon :name="icons.cancel" class="size-3.5" />
        </button>
      </p>
      <div class="list-scroll">
        <!-- 读取失败时已经读到的行留着：翻页失败的错误放在「加载更多」上面，其余放在最上面 -->
        <div v-if="list.isError.value && !list.isFetchNextPageError.value" class="list-failed">
          <ReadFailureNote :query="list" />
        </div>
        <div v-if="list.isPending.value" class="space-y-2 p-3.5">
          <USkeleton v-for="n in 5" :key="n" class="h-16 w-full" />
        </div>
        <template v-else-if="list.data.value">
          <ul v-if="items.length">
            <li v-for="c in items" :key="c.id">
              <button
                type="button"
                class="conv-row"
                :class="{ selected: c.id === selectedId }"
                :aria-current="c.id === selectedId ? 'true' : undefined"
                :data-id="c.id"
                @click="select(c.id)"
              >
                <span class="conv-top">
                  <span class="conv-title">{{ conversationTitle(c) }}</span>
                  <time :datetime="c.lastActiveAt" :title="formatTime(c.lastActiveAt)">
                    {{ formatShort(c.lastActiveAt) }}
                  </time>
                </span>
                <span class="conv-sub">{{ conversationSubline(c) }}</span>
                <span v-if="c.projectSlug || c.deviceKey" class="conv-env">
                  <template v-if="c.projectSlug">项目 {{ c.projectSlug }}</template>
                  <template v-if="c.projectSlug && c.deviceKey"> · </template>
                  <template v-if="c.deviceKey">设备 {{ c.deviceKey }}</template>
                </span>
                <span v-if="c.latestSummary" class="conv-snippet">
                  {{ c.latestSummary.excerpt }}
                </span>
              </button>
            </li>
          </ul>
          <EmptyState v-else title="暂无会话">
            <template #hint>
              <Hint>
                群聊机器人与本机 Agent
                的对话按群、频道、私聊或本地会话分隔，抽取后在这里列出会话摘要。
              </Hint>
            </template>
          </EmptyState>
          <div v-if="list.isFetchNextPageError.value" class="list-failed">
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
    </section>

    <section class="detail-column" aria-label="会话详情">
      <ConversationDetail
        v-if="selectedId"
        :id="selectedId"
        :key="`${circleId}|${selectedId}`"
        ref="detailRef"
        :circle-id="circleId"
      >
        <template #nav>
          <button type="button" class="back" @click="select(null)">
            <UIcon :name="icons.back" class="size-4" />
            返回
          </button>
        </template>
      </ConversationDetail>
      <p v-else class="detail-empty">选择一个会话</p>
    </section>
  </div>

  <div v-else class="contacts">
    <div class="contacts-tabs">
      <UTabs
        :model-value="tab"
        :items="tabItems"
        :content="false"
        variant="link"
        size="md"
        :ui="{ root: 'min-w-0', list: 'border-0', trigger: 'px-2 py-0 h-11 text-sm/5' }"
        @update:model-value="setTab"
      />
    </div>
    <ContactList :circle-id="circleId" />
  </div>
</template>

<style scoped>
.sessions {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 344px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.list-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--strata-rule);
}
.list-column:focus {
  outline: 0;
}
.list-head,
.contacts-tabs {
  flex: none;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 4px;
  height: 44px;
  padding: 0 10px 0 6px;
  border-bottom: 1px solid var(--strata-rule);
}
.list-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.list-filter {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.55;
}
.list-filter button {
  display: inline-flex;
  padding: 2px;
  color: var(--ui-text-muted);
}
.list-filter button:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.list-failed {
  padding: 14px 14px 0;
}
/* 会话的颜色压在行首一条细带上：和地层柱的会话摘要同一种颜色 */
.conv-row {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 8px 14px 8px 19px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
}
.conv-row::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--layer-episode);
}
.conv-row:hover {
  background: var(--ui-bg-elevated);
}
.conv-row:focus-visible {
  outline-offset: -2px;
}
.conv-row.selected,
.conv-row.selected:hover {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.conv-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.conv-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-top time {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.conv-sub,
.conv-env,
.conv-snippet {
  overflow: hidden;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ui-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-env {
  font-family: var(--font-mono);
  font-size: 12px;
}
.conv-snippet {
  font-size: 14px;
  color: var(--ui-text-toned);
}
.selected .conv-top time,
.selected .conv-sub,
.selected .conv-env,
.selected .conv-snippet {
  color: var(--strata-on-selected-muted);
}
.detail-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.detail-empty {
  padding: 32px;
  color: var(--ui-text-muted);
}
/* 返回只在窄屏有：宽屏上列表一直在旁边 */
.back {
  display: none;
  align-items: center;
  gap: 3px;
  height: 32px;
  margin: -4px 0 4px -3px;
  font-size: 14px;
  color: var(--ui-text-muted);
}
.contacts {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

@media (max-width: 1240px) {
  .sessions {
    grid-template-columns: 324px minmax(0, 1fr);
  }
}
@media (max-width: 1023.98px) {
  .sessions {
    grid-template-columns: minmax(0, 1fr);
  }
  .list-column {
    border-right: 0;
  }
  .has-selection .list-column,
  .sessions:not(.has-selection) .detail-column {
    display: none;
  }
  .list-head,
  .contacts-tabs {
    padding: 0 16px 0 7px;
  }
  .list-filter {
    padding-left: 16px;
    padding-right: 16px;
  }
  .back {
    display: inline-flex;
  }
  .detail-empty {
    padding: 16px;
  }
}
</style>
