<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ReviewLayer } from '@kioku/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import DreamSuggestions from '../components/DreamSuggestions.vue'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { originScopeText } from '../labels'
import { formatRelative } from '../time'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const canAct = computed(() => space.value?.role === 'owner' || space.value?.role === 'editor')

// 两部分：不可信来源写下的待审内容，与 Dream 的建议。看的是哪一部分记在地址里，刷新、分享都还在
type Section = 'pending' | 'dream'
const section = computed<Section>({
  get: () => (route.query.tab === 'dream' ? 'dream' : 'pending'),
  set: (value) =>
    void router.replace({
      query: { ...route.query, tab: value === 'dream' ? 'dream' : undefined },
    }),
})
// 标签上的建议条数：第一页带着总数
const dreamCount = useQuery({
  queryKey: computed(() => ['dream-suggestions', spaceId.value, 'count']),
  queryFn: async () => (await api.dreamSuggestions(spaceId.value)).total ?? 0,
})
const sections = computed(() => [
  { label: '待确认内容', value: 'pending' },
  {
    label: '整理建议',
    value: 'dream',
    ...(dreamCount.data.value ? { badge: dreamCount.data.value } : {}),
  },
])
function refreshAll() {
  void queue.refetch()
  for (const key of ['dream-suggestions', 'dream-runs']) {
    void queryClient.invalidateQueries({ queryKey: [key, spaceId.value] })
  }
}

const layer = ref<'all' | ReviewLayer>('all')
const tabs = [
  { label: '全部', value: 'all' },
  { label: '联系人事实', value: 'subject' },
  { label: '会话摘要', value: 'episode' },
]

const queue = useInfiniteQuery({
  queryKey: computed(() => ['review', spaceId.value, layer.value]),
  queryFn: ({ pageParam }) =>
    api.reviewQueue(spaceId.value, {
      layer: layer.value === 'all' ? undefined : layer.value,
      cursor: pageParam,
    }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})
const items = computed(() => queue.data.value?.pages.flatMap((page) => page.items) ?? [])
const total = computed(() => queue.data.value?.pages[0]?.total ?? 0)

// 选中的条目与勾选时看到的版本：换了空间或筛选就清空。版本在勾选时记下，
// 之后刷新拿到的新版本不算，服务端按它跳过看过之后被改过的
type Seen = { id: string; version: number }
const selected = ref(new Map<string, number>())
watch([spaceId, layer], () => (selected.value = new Map()))
const allSelected = computed(
  () => items.value.length > 0 && items.value.every((i) => selected.value.has(i.id)),
)
function toggle(item: Seen, on: boolean) {
  const next = new Map(selected.value)
  if (on) next.set(item.id, item.version)
  else next.delete(item.id)
  selected.value = next
}
function toggleAll(on: boolean) {
  selected.value = on ? new Map(items.value.map((i) => [i.id, i.version])) : new Map()
}
const chosen = (): Seen[] => [...selected.value].map(([id, version]) => ({ id, version }))

const busy = ref(false)
const deleting = ref<Seen[] | null>(null)
// 一次最多提交这么多条（接口的上限），选得多就分几批
const BATCH = 100

async function act(action: 'confirm' | 'delete', items: Seen[]) {
  const sid = spaceId.value
  const verb = action === 'confirm' ? '确认' : '删除'
  busy.value = true
  let done = 0
  let skipped = 0
  const submitted: string[] = []
  try {
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH)
      const result = await api.review(sid, { action, items: batch })
      done += result.done
      skipped += result.skipped
      submitted.push(...batch.map((b) => b.id))
    }
    toast.add({
      title: skipped ? `已${verb} ${done} 条，${skipped} 条已被处理或修改` : `已${verb} ${done} 条`,
      color: 'success',
    })
  } catch (err) {
    const message = err instanceof ApiError ? err.message : '处理失败'
    // 分批时前面几批已经提交了，告诉用户；没提交的留在选择里，可以再试
    toast.add({
      title: submitted.length ? `${message}（此前已${verb} ${done} 条）` : message,
      color: 'error',
    })
  } finally {
    const next = new Map(selected.value)
    for (const id of submitted) next.delete(id)
    selected.value = next
    // 处理过的会出现在对象页、记忆列表、已删除、活动与概览里；涉及它们的 Dream 建议随之作废
    for (const key of [
      'review',
      'dream-suggestions',
      'subjects',
      'subject',
      'memory-list',
      'memory-deleted',
      'activity',
      'overview',
    ]) {
      void queryClient.invalidateQueries({ queryKey: [key, sid] })
    }
    busy.value = false
    deleting.value = null
  }
}
</script>

<template>
  <UDashboardPanel id="review">
    <template #header>
      <UDashboardNavbar title="待处理">
        <template #right>
          <UButton
            :icon="icons.refresh"
            color="neutral"
            variant="ghost"
            aria-label="刷新"
            :loading="queue.isRefetching.value"
            @click="refreshAll"
          />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="mb-4 flex">
        <UTabs v-model="section" :items="sections" :content="false" class="w-auto" />
      </div>
      <div v-if="section === 'dream'">
        <DreamSuggestions :space-id="spaceId" :can-act="canAct" />
      </div>
      <div v-else>
        <p class="mb-4 text-sm text-muted">
          这些内容来自群聊与陌生人私聊，来源未确认。确认后记为本人来源，有误的内容可删除。
        </p>
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <UTabs v-model="layer" :items="tabs" :content="false" size="sm" class="w-auto" />
          <span v-if="queue.isSuccess.value" class="text-sm text-muted">{{ total }} 条待确认</span>
        </div>
        <UAlert
          v-if="queue.isError.value"
          color="error"
          variant="subtle"
          :title="queue.error.value instanceof ApiError ? queue.error.value.message : '读取失败'"
        />
        <div v-else-if="queue.isPending.value" class="space-y-3">
          <USkeleton v-for="n in 6" :key="n" class="h-12 w-full" />
        </div>
        <template v-else>
          <div
            v-if="canAct && items.length"
            class="mb-2 flex flex-wrap items-center gap-2 border-b border-default pb-2"
          >
            <UCheckbox
              :model-value="allSelected"
              label="全选已加载项"
              @update:model-value="(v) => toggleAll(v === true)"
            />
            <span class="text-xs text-muted">已选 {{ selected.size }} 条</span>
            <div class="ml-auto flex gap-2">
              <UButton
                size="sm"
                variant="subtle"
                :icon="icons.confirmed"
                :disabled="!selected.size"
                :loading="busy"
                @click="act('confirm', chosen())"
                >确认</UButton
              >
              <UButton
                size="sm"
                color="error"
                variant="subtle"
                :icon="icons.remove"
                :disabled="!selected.size || busy"
                @click="deleting = chosen()"
                >删除</UButton
              >
            </div>
          </div>
          <ul class="divide-y divide-default">
            <li v-for="item in items" :key="item.id" class="flex gap-3 py-2.5">
              <UCheckbox
                v-if="canAct"
                :model-value="selected.has(item.id)"
                :aria-label="`选择：${item.content}`"
                class="pt-0.5"
                @update:model-value="(v) => toggle(item, v === true)"
              />
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-sm whitespace-pre-wrap">{{ item.content }}</p>
                <p class="flex flex-wrap gap-x-2 text-xs text-muted">
                  <RouterLink
                    v-if="item.subject"
                    :to="{ name: 'subject', params: { spaceId, subjectId: item.subject.id } }"
                    class="text-primary hover:underline"
                    >关于「{{ item.subject.displayName }}」</RouterLink
                  >
                  <span v-else-if="item.layer === 'episode'">会话摘要</span>
                  <code v-if="item.uri">{{ item.uri }}</code>
                  <span>{{ originScopeText(item.scope) }}</span>
                  <span>{{ formatRelative(item.createdAt) }}</span>
                </p>
              </div>
            </li>
          </ul>
          <p v-if="!items.length" class="text-sm text-muted">暂无待确认内容</p>
          <div v-if="queue.hasNextPage.value" class="mt-4 flex justify-center">
            <UButton
              color="neutral"
              variant="subtle"
              :loading="queue.isFetchingNextPage.value"
              @click="queue.fetchNextPage()"
            >
              加载更多
            </UButton>
          </div>
        </template>
      </div>

      <UModal
        :open="deleting !== null"
        title="删除选中的内容？"
        @update:open="(v) => !v && (deleting = null)"
      >
        <template #body>
          <p class="text-sm">
            将删除
            {{ deleting?.length ?? 0 }}
            条内容，删除后不再注入对话。从对话中抽取的内容删除后，无法在管理界面恢复。
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="deleting = null">取消</UButton>
            <UButton color="error" :loading="busy" @click="deleting && act('delete', deleting)"
              >删除</UButton
            >
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
