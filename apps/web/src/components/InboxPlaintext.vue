<script setup lang="ts">
import {
  CONVERT_SCOPE_TEXT,
  SENSITIVE_KIND_NAMES,
  placeholderAllowed,
  type MemoryListItem,
  type RedactMode,
  type SensitiveCategory,
} from '@kioku/contracts'
import { useInfiniteQuery } from '@tanstack/vue-query'
import { computed, ref, toRef, watch } from 'vue'

import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { usePlaintextActions } from '../composables/usePlaintextActions'
import { memoryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import ConvertCredentialModal from './ConvertCredentialModal.vue'
import EmptyState from './strata/EmptyState.vue'
import Hint from './Hint.vue'
import MemoryFlags from './strata/MemoryFlags.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import MemoryName from './strata/MemoryName.vue'

// 疑似敏感内容：明文凭据与个人信息。凭据支持转存为凭据或忽略，个人信息支持一键打码或忽略
const props = defineProps<{ spaceId: string }>()
const spaceId = toRef(props, 'spaceId')
const permissions = useMemoryPermissions(spaceId)
const actions = usePlaintextActions(spaceId)

type Filter = 'true' | 'ignored'
type CategoryFilter = 'all' | SensitiveCategory
const filter = ref<Filter>('true')
const category = ref<CategoryFilter>('all')
const redactMode = ref<RedactMode>('stars')

const filters = [
  { label: '待处理', value: 'true' },
  { label: '已忽略', value: 'ignored' },
]
const categories = [
  { label: '全部类别', value: 'all' },
  { label: '明文凭据', value: 'credential' },
  { label: '个人信息', value: 'pii' },
]
const redactModes = [
  { label: '替换为 ***', value: 'stars' },
  { label: '替换为类别标签', value: 'tag' },
]
watch(spaceId, () => {
  filter.value = 'true'
  category.value = 'all'
})

const active = useActivated()
const list = useInfiniteQuery({
  queryKey: computed(
    () =>
      [
        'memory-list',
        props.spaceId,
        { plaintext: filter.value, category: category.value },
      ] as const,
  ),
  // 参数从键里取：换了筛选之后，旧键剩下的页还在重新拉取时，不会用上新的筛选条件
  queryFn: ({ pageParam, queryKey: [, sid, f] }) =>
    api.memoryList(sid, {
      plaintext: f.plaintext,
      ...(f.category !== 'all' ? { sensitiveCategory: f.category } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: active,
})
const items = computed(() => list.data.value?.pages.flatMap((page) => page.items) ?? [])

function findingLabels(item: MemoryListItem): string[] {
  const seen = new Set<string>()
  for (const f of item.sensitiveFindings ?? []) {
    const name = SENSITIVE_KIND_NAMES[f.kind] ?? f.label ?? f.kind
    seen.add(name)
  }
  return [...seen]
}

const converting = ref<string | null>(null)
const convertOpen = ref(false)
function openConvert(item: MemoryListItem) {
  converting.value = item.uri
  convertOpen.value = true
}
// 占位符放不进这条记忆时，转存一定失败：这一行的操作换成去调整它
const convertible = (item: MemoryListItem) => placeholderAllowed(item.layer, item.sensitivity)
</script>

<template>
  <div>
    <SectionHeading title="疑似敏感内容">
      <template #hint>
        <Hint>
          正文疑似包含明文凭据或个人信息。明文凭据建议转存为凭据并以占位符引用；个人信息可一键打码脱敏。检测规则可能误判，确认无需处理时可忽略；正文修改后会重新提示。
        </Hint>
      </template>
    </SectionHeading>
    <div class="plain-bar">
      <UTabs v-model="filter" :items="filters" :content="false" size="sm" class="w-auto" />
      <UTabs
        v-if="filter === 'true'"
        v-model="category"
        :items="categories"
        :content="false"
        size="sm"
        class="w-auto"
      />
      <div v-if="filter === 'true'" class="plain-mode">
        <span class="plain-mode-label">打码方式</span>
        <USelect
          v-model="redactMode"
          :items="redactModes"
          value-key="value"
          size="sm"
          class="w-36"
        />
      </div>
    </div>
    <ReadFailureNote
      v-if="list.isError.value && !list.isFetchNextPageError.value"
      class="plain-note"
      :query="list"
    />
    <div v-if="list.isPending.value" class="mt-3 space-y-3">
      <USkeleton v-for="n in 3" :key="n" class="h-12 w-full" />
    </div>
    <template v-else-if="list.data.value">
      <EmptyState
        v-if="!items.length"
        :title="filter === 'true' ? '暂无疑似敏感内容' : '暂无已忽略的提示'"
      />
      <ul v-else>
        <li v-for="item in items" :key="item.id" class="plain-row">
          <div class="plain-uri">
            <StrataSwatch :layer="item.layer" :sensitivity="item.sensitivity" />
            <RouterLink :to="memoryRoute(spaceId, item.uri)" class="min-w-0"
              ><MemoryName :uri="item.uri" :title="item.title"
            /></RouterLink>
            <MemoryFlags :layer="item.layer" :sensitivity="item.sensitivity" />
          </div>
          <p class="plain-sub">
            <span v-for="tag in findingLabels(item)" :key="tag" class="finding-tag">{{ tag }}</span>
            <span v-if="item.disclosure">{{ item.disclosure }}</span>
            <time :datetime="item.updatedAt" :title="formatTime(item.updatedAt)">
              更新于 {{ formatRelative(item.updatedAt) }}
            </time>
            <span
              v-if="
                filter === 'true' &&
                !permissions.readOnlyReason(item) &&
                item.sensitiveCredential &&
                !convertible(item)
              "
              class="plain-blocked"
            >
              需先调整才能转存<Hint>{{ CONVERT_SCOPE_TEXT }}</Hint>
            </span>
          </p>
          <div v-if="!permissions.readOnlyReason(item)" class="plain-actions">
            <template v-if="filter === 'true'">
              <template v-if="item.sensitiveCredential">
                <UButton
                  v-if="convertible(item)"
                  color="neutral"
                  variant="outline"
                  @click="openConvert(item)"
                >
                  转存为凭据
                </UButton>
                <UButton
                  v-else
                  color="neutral"
                  variant="outline"
                  :to="memoryRoute(spaceId, item.uri)"
                >
                  查看记忆
                </UButton>
              </template>
              <UButton
                color="neutral"
                variant="outline"
                :loading="actions.busy.value === item.id"
                :disabled="actions.busy.value !== null"
                @click="actions.redact(item, redactMode)"
              >
                一键打码
              </UButton>
              <UButton
                color="neutral"
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
              color="neutral"
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
      <div v-if="list.isFetchNextPageError.value" class="mt-3">
        <NoteLine tone="error">{{ readFailure(list.error.value) }}</NoteLine>
      </div>
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
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  min-height: 50px;
  padding: 9px 0;
  border-bottom: 1px solid var(--ui-border);
}
.plain-mode {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.plain-mode-label {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.finding-tag {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border: 1px solid var(--ui-border);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text);
}
.note-line.plain-note {
  margin: 10px 0 0;
  border-top: 0;
}
.plain-row {
  display: grid;
  /* 操作列留够最宽的一组按钮，各行的中间一列才对得齐 */
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(140px, auto);
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
.plain-blocked {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.plain-actions {
  display: flex;
  justify-content: flex-end;
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
