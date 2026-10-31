<script setup lang="ts">
import type { SubjectInfo, SubjectKind } from '@kioku/contracts'
import { useInfiniteQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import { useDebounced } from '../composables/useDebounced'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { formatRelative } from '../time'

const route = useRoute()
const { me } = useSession()
const spaceId = computed(() => String(route.params.spaceId))

const kind = ref<'all' | SubjectKind>('all')
const tabs = [
  { label: '全部', value: 'all' },
  { label: '人', value: 'person', icon: icons.user },
  { label: '群', value: 'group', icon: icons.group },
]

const search = ref('')
const q = useDebounced(search)

const subjects = useInfiniteQuery({
  queryKey: computed(() => ['subjects', spaceId.value, kind.value, q.value]),
  queryFn: ({ pageParam }) =>
    api.subjects(spaceId.value, {
      kind: kind.value === 'all' ? undefined : kind.value,
      q: q.value || undefined,
      cursor: pageParam,
    }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})
const items = computed(() => subjects.data.value?.pages.flatMap((page) => page.items) ?? [])

function accounts(subject: SubjectInfo) {
  return subject.identities.map((i) => `${i.platform} ${i.externalId}`).join('、')
}
</script>

<template>
  <UDashboardPanel id="subjects">
    <template #header>
      <UDashboardNavbar title="联系人">
        <template #right>
          <UButton
            :icon="icons.refresh"
            color="neutral"
            variant="ghost"
            aria-label="刷新"
            :loading="subjects.isRefetching.value"
            @click="subjects.refetch()"
          />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <p class="mb-4 text-sm text-muted">
        对话中遇到的人和群，以及记下的事实。
        <Hint>
          新遇到的排在前面。将本人在各平台的账号标记为「这是我」后，当前账号的应用会将这些私聊视为本人对话。
        </Hint>
      </p>
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <UTabs v-model="kind" :items="tabs" :content="false" size="sm" class="w-auto" />
        <UInput
          v-model="search"
          name="q"
          :icon="icons.search"
          placeholder="名字或平台账号"
          aria-label="查找联系人"
          class="w-full sm:w-64"
        />
      </div>
      <UAlert
        v-if="subjects.isError.value"
        color="error"
        variant="subtle"
        :title="
          subjects.error.value instanceof ApiError ? subjects.error.value.message : '读取失败'
        "
      />
      <div v-else-if="subjects.isPending.value" class="space-y-3">
        <USkeleton v-for="n in 6" :key="n" class="h-10 w-full" />
      </div>
      <template v-else>
        <ul class="divide-y divide-default">
          <li v-for="subject in items" :key="subject.id" class="flex items-center gap-3 py-2.5">
            <UIcon
              :name="subject.kind === 'group' ? icons.group : icons.user"
              class="size-4 shrink-0 text-muted"
            />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <RouterLink
                  :to="{ name: 'subject', params: { spaceId, subjectId: subject.id } }"
                  class="truncate font-medium hover:underline"
                  >{{ subject.displayName }}</RouterLink
                >
                <UBadge
                  v-if="subject.account"
                  :color="subject.account.id === me.data.value?.id ? 'primary' : 'neutral'"
                  variant="subtle"
                  size="sm"
                  >{{
                    subject.account.id === me.data.value?.id ? '我' : subject.account.displayName
                  }}</UBadge
                >
              </div>
              <p class="truncate text-xs text-muted">{{ accounts(subject) || '无平台账号' }}</p>
            </div>
            <span class="shrink-0 text-xs text-muted">{{ subject.factCount }} 条事实</span>
            <span
              class="hidden w-24 shrink-0 text-right text-xs text-muted sm:inline"
              title="首次遇到"
              >{{ formatRelative(subject.createdAt) }}</span
            >
          </li>
        </ul>
        <p v-if="!items.length" class="text-sm text-muted">
          {{ q ? '没有匹配的结果' : '暂无联系人。接入群聊 Bot 后，对话过的人和群将显示在这里。' }}
        </p>
        <div v-if="subjects.hasNextPage.value" class="mt-4 flex justify-center">
          <UButton
            color="neutral"
            variant="subtle"
            :loading="subjects.isFetchingNextPage.value"
            @click="subjects.fetchNextPage()"
          >
            加载更多
          </UButton>
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
