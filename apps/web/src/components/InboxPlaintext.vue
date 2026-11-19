<script setup lang="ts">
import {
  CONVERT_SCOPE_TEXT,
  SENSITIVE_KIND_NAMES,
  isProtectedPersonalEntry,
  placeholderAllowed,
  type EntryListItem,
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
import { entryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import ConvertCredentialModal from './ConvertCredentialModal.vue'
import EmptyState from './strata/EmptyState.vue'
import Hint from './Hint.vue'
import MemoryFlags from './strata/MemoryFlags.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import RedactConfirmModal from './RedactConfirmModal.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import MemoryName from './strata/MemoryName.vue'
import { entryBand } from './strata/strata'

// 疑似敏感内容：明文凭据建议转存为凭据；个人信息保留原值，建议移入个人圈私密或设为机密，抹除敏感段作为确认后的清理动作
const props = defineProps<{ circleId: string }>()
const circleId = toRef(props, 'circleId')
const permissions = useMemoryPermissions(circleId)
const actions = usePlaintextActions(circleId)

type Filter = 'true' | 'ignored'
type CategoryFilter = 'all' | SensitiveCategory
const filter = ref<Filter>('true')
const category = ref<CategoryFilter>('all')

const filters = [
  { label: '待处理', value: 'true' },
  { label: '已忽略', value: 'ignored' },
]
const categories = [
  { label: '全部类别', value: 'all' },
  { label: '明文凭据', value: 'credential' },
  { label: '个人信息', value: 'pii' },
]
watch(circleId, () => {
  filter.value = 'true'
  category.value = 'all'
})

const active = useActivated()
const list = useInfiniteQuery({
  queryKey: computed(
    () =>
      [
        'entry-list',
        props.circleId,
        { plaintext: filter.value, category: category.value },
      ] as const,
  ),
  // 参数从键里取：换了筛选之后，旧键剩下的页还在重新拉取时，不会用上新的筛选条件
  queryFn: ({ pageParam, queryKey: [, cid, f] }) =>
    api.entryList(cid, {
      plaintext: f.plaintext,
      ...(f.category !== 'all' ? { sensitiveCategory: f.category } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: active,
})
const items = computed(() => list.data.value?.pages.flatMap((page) => page.items) ?? [])

function findingLabels(item: EntryListItem): string[] {
  const seen = new Set<string>()
  for (const f of item.sensitiveFindings ?? []) {
    const name = SENSITIVE_KIND_NAMES[f.kind] ?? f.label ?? f.kind
    seen.add(name)
  }
  return [...seen]
}

const converting = ref<string | null>(null)
const convertOpen = ref(false)
function openConvert(item: EntryListItem) {
  converting.value = item.shortId
  convertOpen.value = true
}
const redactTarget = ref<EntryListItem | null>(null)
async function confirmRedact(mode: RedactMode) {
  const target = redactTarget.value
  if (!target) return
  try {
    await actions.redact(target, mode)
  } finally {
    redactTarget.value = null
  }
}
// 占位符放不进这条记忆时，转存一定失败：这一行的操作换成去调整它
const convertible = (item: EntryListItem) =>
  placeholderAllowed(permissions.circleKind.value, item.kind, item.sensitivity)
const bandOf = (item: EntryListItem) =>
  entryBand(
    { kind: item.kind, circleId: item.circleId, circleKind: permissions.circleKind.value },
    permissions.circle.value,
  )
</script>

<template>
  <div>
    <SectionHeading title="疑似敏感内容">
      <template #hint>
        <Hint>
          共享记忆圈或非私密范围内疑似包含明文凭据或个人信息。明文凭据建议转存为凭据并以占位符引用；个人信息建议保留原值并移入个人圈私密或设为机密，外发至模型与嵌入前会自动脱敏。误粘贴的冗余文本可抹除敏感段；规则误判时可忽略。
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
            <StrataSwatch :band="bandOf(item)" :sensitivity="item.sensitivity" />
            <RouterLink :to="entryRoute(circleId, item.shortId)" class="min-w-0"
              ><MemoryName :short-id="item.shortId" :title="item.title"
            /></RouterLink>
            <MemoryFlags
              :band="bandOf(item)"
              :sensitivity="item.sensitivity"
              :variant-count="item.variantCount"
            />
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
                  :to="entryRoute(circleId, item.shortId)"
                >
                  查看记忆
                </UButton>
              </template>
              <template
                v-if="
                  item.sensitivePii &&
                  !isProtectedPersonalEntry(
                    permissions.circleKind.value,
                    item.sensitivity,
                    item.provenance,
                  )
                "
              >
                <UButton
                  color="primary"
                  variant="outline"
                  :loading="actions.busy.value === item.id"
                  :disabled="actions.busy.value !== null"
                  @click="
                    actions.protect(
                      {
                        id: item.id,
                        version: item.version,
                        inPersonal: permissions.circleKind.value === 'personal',
                      },
                      'personal_private',
                    )
                  "
                >
                  {{ permissions.circleKind.value === 'personal' ? '设为私密' : '移入个人圈私密' }}
                </UButton>
              </template>
              <UButton
                v-if="permissions.sensitivities.value.includes('secret')"
                color="neutral"
                variant="outline"
                :loading="actions.busy.value === item.id"
                :disabled="actions.busy.value !== null"
                @click="actions.protect(item, 'secret')"
              >
                设为机密
              </UButton>
              <UButton
                color="neutral"
                variant="ghost"
                :loading="actions.busy.value === item.id"
                :disabled="actions.busy.value !== null"
                @click="redactTarget = item"
              >
                抹除敏感段
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

    <ConvertCredentialModal
      v-model:open="convertOpen"
      :circle-id="circleId"
      :short-id="converting"
    />
    <RedactConfirmModal
      :open="redactTarget !== null"
      :title="redactTarget?.title"
      :busy="actions.busy.value !== null"
      @close="redactTarget = null"
      @confirm="confirmRedact"
    />
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
  flex-wrap: wrap;
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
