<script setup lang="ts">
import type { SubjectInfo, SubjectKind } from '@kioku/contracts'
import { useInfiniteQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import PageHead from '../components/strata/PageHead.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { useDebounced } from '../composables/useDebounced'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const { me } = useSession()
const spaceId = computed(() => String(route.params.spaceId))

const search = ref('')
const q = useDebounced(search)

// 人和群各翻各的页：混在一起翻的话，加载更多会把人插到群上面
function listOf(kind: SubjectKind) {
  const query = useInfiniteQuery({
    queryKey: computed(() => ['subjects', spaceId.value, kind, q.value]),
    queryFn: ({ pageParam }) =>
      api.subjects(spaceId.value, {
        kind,
        q: q.value || undefined,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const items = computed(() => query.data.value?.pages.flatMap((page) => page.items) ?? [])
  // 还有下一页时读到的不是全部，写成「20+」
  const count = computed(() =>
    query.data.value ? `${items.value.length}${query.hasNextPage.value ? '+' : ''}` : null,
  )
  return { query, items, count }
}
const sections = [
  { kind: 'person' as const, title: '人', ...listOf('person') },
  { kind: 'group' as const, title: '群', ...listOf('group') },
]
const refreshing = computed(() => sections.some((s) => s.query.isRefetching.value))
function refresh() {
  for (const section of sections) void section.query.refetch()
}
// 两边都读完了、都没有内容：整页只说一句
const nothing = computed(() =>
  sections.every(
    (s) => !s.query.isPending.value && !s.query.isError.value && !s.items.value.length,
  ),
)

// 窄屏放不下两栏，人又可能很多：一次只显示一边，两边的查询和翻页都留着
const shown = ref<SubjectKind>('person')

function accounts(subject: SubjectInfo) {
  return subject.identities.map((i) => `${i.platform} ${i.externalId}`).join('、')
}
</script>

<template>
  <div class="subjects">
    <PageHead title="联系人">
      <template #note>
        对话中遇到的人和群，以及记下的事实。<Hint>
          新遇到的排在前面。将本人在各平台的账号标记为「这是我」后，当前账号的应用会将这些私聊视为本人对话。
        </Hint>
      </template>
      <template #actions>
        <UInput
          v-model="search"
          name="q"
          :icon="icons.search"
          placeholder="名字或平台账号"
          aria-label="查找联系人"
          class="w-56 max-sm:flex-1"
        />
        <UButton
          :icon="icons.refresh"
          color="neutral"
          variant="ghost"
          aria-label="刷新"
          :loading="refreshing"
          @click="refresh"
        />
      </template>
    </PageHead>

    <p v-if="nothing" class="nothing">
      {{ q ? '没有匹配的结果' : '暂无联系人。接入群聊 Bot 后，对话过的人和群将显示在这里。' }}
    </p>
    <template v-else>
      <div class="kind-switch" role="group" aria-label="人和群">
        <button
          v-for="section in sections"
          :key="section.kind"
          type="button"
          :class="{ on: shown === section.kind }"
          :aria-pressed="shown === section.kind"
          @click="shown = section.kind"
        >
          {{ section.title }}
          <span v-if="section.count.value !== null" class="kind-count">
            {{ section.count.value }}
          </span>
        </button>
      </div>
      <div class="columns">
        <section
          v-for="section in sections"
          :key="section.kind"
          class="column"
          :class="{ shown: shown === section.kind }"
        >
          <SectionHeading :title="section.title">
            <template #actions>
              <span class="head-count">事实</span>
              <span class="head-time">首次遇到</span>
            </template>
          </SectionHeading>
          <!-- 读取失败时已经读到的行留着：翻页失败的错误放在「加载更多」上面，其余放在最上面 -->
          <div
            v-if="section.query.isError.value && !section.query.isFetchNextPageError.value"
            class="pt-3"
          >
            <NoteLine tone="error">{{ readFailure(section.query.error.value) }}</NoteLine>
          </div>
          <div v-if="section.query.isPending.value" class="space-y-2 pt-3">
            <USkeleton v-for="n in 6" :key="n" class="h-11 w-full" />
          </div>
          <template v-else-if="section.query.data.value">
            <ul v-if="section.items.value.length">
              <li v-for="subject in section.items.value" :key="subject.id">
                <RouterLink
                  :to="{ name: 'subject', params: { spaceId, subjectId: subject.id } }"
                  class="subject-row"
                >
                  <span class="subject-title">
                    <span class="subject-name">{{ subject.displayName }}</span>
                    <span
                      v-if="subject.account"
                      class="subject-mark"
                      :class="{ me: subject.account.id === me.data.value?.id }"
                    >
                      {{
                        subject.account.id === me.data.value?.id
                          ? '我'
                          : subject.account.displayName
                      }}
                    </span>
                  </span>
                  <span class="subject-count" :class="{ zero: !subject.factCount }">
                    {{ subject.factCount }}<span class="sr-only"> 条事实</span>
                  </span>
                  <time
                    class="subject-time"
                    :datetime="subject.createdAt"
                    :title="`首次遇到 ${formatTime(subject.createdAt)}`"
                  >
                    {{ formatRelative(subject.createdAt) }}
                  </time>
                  <span class="subject-accounts" :title="accounts(subject) || undefined">
                    {{ accounts(subject) || '无平台账号' }}
                  </span>
                </RouterLink>
              </li>
            </ul>
            <p v-else class="empty">{{ q ? '没有匹配的结果' : '暂无' }}</p>
            <div v-if="section.query.isFetchNextPageError.value" class="pt-3">
              <NoteLine tone="error">{{ readFailure(section.query.error.value) }}</NoteLine>
            </div>
            <div v-if="section.query.hasNextPage.value" class="flex justify-center py-4">
              <UButton
                color="neutral"
                variant="outline"
                size="sm"
                :loading="section.query.isFetchingNextPage.value"
                @click="section.query.fetchNextPage()"
              >
                加载更多
              </UButton>
            </div>
          </template>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.subjects {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.nothing {
  padding: 4px 32px 32px;
  color: var(--ui-text-muted);
}
.kind-switch {
  display: none;
}
.columns {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  align-items: start;
  gap: 0 40px;
  padding: 0 32px 40px;
}
.head-count {
  width: 3rem;
  text-align: right;
}
.head-time {
  width: 5.5rem;
  margin-left: 2px;
  text-align: right;
}
.subject-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 3rem 5.5rem;
  column-gap: 8px;
  align-items: baseline;
  padding: 8px 0 7px;
  border-bottom: 1px solid var(--ui-border);
}
.subject-row:hover {
  background: var(--ui-bg-muted);
}
.subject-row:focus-visible {
  outline-offset: -2px;
}
.subject-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.subject-name {
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subject-mark {
  flex: none;
  max-width: 10em;
  overflow: hidden;
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 18px;
  color: var(--ui-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subject-mark.me {
  border-color: var(--strata-rule);
  color: var(--ui-text-highlighted);
  font-weight: 500;
}
.subject-count {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 500;
  text-align: right;
}
.subject-count.zero {
  font-weight: 400;
  color: var(--ui-text-muted);
}
.subject-time {
  font-size: 13px;
  color: var(--ui-text-muted);
  text-align: right;
  white-space: nowrap;
}
.subject-accounts {
  grid-column: 1 / -1;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}

/* 手机上查找框占满一行 */
@media (max-width: 639.98px) {
  .subjects :deep(.page-actions) {
    flex: 1 1 100%;
  }
}
/* 窄屏放不下两栏：一次只显示一边，用开关切换 */
@media (max-width: 1023.98px) {
  .nothing {
    padding: 4px 16px 24px;
  }
  .kind-switch {
    display: flex;
    margin: 0 16px 12px;
    border: 1px solid var(--ui-border-accented);
  }
  .kind-switch button {
    flex: 1;
    height: 32px;
    font-size: 14px;
    color: var(--ui-text-muted);
  }
  .kind-switch button + button {
    border-left: 1px solid var(--ui-border-accented);
  }
  .kind-count {
    margin-left: 2px;
    font-size: 13px;
  }
  .kind-switch button:focus-visible {
    outline-offset: -2px;
  }
  .kind-switch button.on {
    background: var(--strata-selected);
    color: var(--strata-on-selected);
  }
  .columns {
    grid-template-columns: minmax(0, 1fr);
    padding: 0 16px 28px;
  }
  .column:not(.shown) {
    display: none;
  }
}
</style>
