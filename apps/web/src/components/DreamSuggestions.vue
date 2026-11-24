<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  ApplyDreamSuggestion,
  DISCLOSURE_MAX,
  ENTRY_TITLE_MAX,
  EntryTitle,
  PLAINTEXT_CREDENTIAL,
  TOPICS_MAX,
  TopicTag,
  VARIANTS_MAX,
  normalizeWhen,
  whenSignature,
  type ApplyDreamSuggestion as ApplyDreamSuggestionBody,
  type DreamEntryRef,
  type DreamSuggestion,
  type VariantInput,
  type WhenCondition,
} from '@kioku/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { invalidateActivity } from '../activity'
import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { useSession } from '../composables/useSession'
import {
  dreamScopeText,
  dreamSettingsKey,
  lastRunSummary,
  runEntrySummary,
  sharedSummaryText,
  runOutcome,
  suggestionKinds,
  triggerLabels,
} from '../dream'
import { invalidateInboxCounts } from '../inbox'
import { entryKindLabels } from '../labels'
import { whenLabel } from '../memoryDetail'
import { entryRoute } from '../routes'
import { circleSettingsRoute } from '../settingsSections'
import { formatRelative, formatTime } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import FacetWhenPicker from './FacetWhenPicker.vue'
import Hint from './Hint.vue'
import EmptyState from './strata/EmptyState.vue'
import MemoryFlags from './strata/MemoryFlags.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import MemoryName from './strata/MemoryName.vue'
import { entryBand } from './strata/strata'

const props = defineProps<{ circleId: string; canAct: boolean }>()
const toast = useToast()
const queryClient = useQueryClient()
const { circle } = useSession()

const active = useActivated()
const listKey = computed(() => ['dream-suggestions', props.circleId] as const)
const suggestions = useInfiniteQuery({
  queryKey: listKey,
  // 参数从键里取：换了记忆圈之后，旧键剩下的页还在重新拉取时，不会去请求新的记忆圈
  queryFn: ({ pageParam, queryKey: [, cid] }) => api.dreamSuggestions(cid, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: active,
})
const items = computed(() => suggestions.data.value?.pages.flatMap((page) => page.items) ?? [])

const facets = useQuery({
  queryKey: computed(() => ['facets', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
  enabled: active,
  staleTime: 60_000,
})
const vocab = computed(() => facets.data.value ?? undefined)

const runsKey = computed(() => ['dream-runs', props.circleId] as const)
const runs = useQuery({
  queryKey: runsKey,
  queryFn: ({ queryKey: [, cid] }) => api.dreamRuns(cid),
  enabled: active,
})
const lastRun = computed(() => {
  const run = runs.data.value?.runs[0]
  return run ? lastRunSummary(run) : null
})
// 自己的个人内容整理不整理：在记忆圈设置里改，这里说一声
const mine = useQuery({
  queryKey: computed(() => dreamSettingsKey(props.circleId)),
  queryFn: ({ queryKey: [, cid] }) => api.dreamSettings(cid),
  enabled: active,
})

const bandOf = (entry: DreamEntryRef) => entryBand({ kind: entry.kind }, circle.value)
const hasWhen = (when: WhenCondition | null | undefined) =>
  !!when && Object.keys(normalizeWhen(when)).length > 0

interface DraftVariant {
  key: number
  when: Record<string, string[]>
  content: string
}
interface Draft {
  title: string
  content: string
  variants: DraftVariant[]
  useVariants: boolean
  when: Record<string, string[]>
  topicsText: string
  disclosure: string
  priority: number
}
let nextVariantKey = 1
const makeDraftVariant = (when: WhenCondition = {}, content = ''): DraftVariant => ({
  key: nextVariantKey++,
  when: normalizeWhen(when),
  content,
})

const drafts = reactive(new Map<string, Draft>())
watch(
  () => props.circleId,
  () => {
    drafts.clear()
    confirming.value = null
    confirmError.value = null
  },
)
function startEdit(item: DreamSuggestion) {
  const variants = (item.variants ?? []).map((v) => makeDraftVariant(v.when, v.content))
  const useVariants =
    item.kind === 'merge_variants' || item.kind === 'generalize' || variants.length > 0
  drafts.set(item.id, {
    title: item.title ?? '',
    content: item.content ?? '',
    variants: variants.length ? variants : [makeDraftVariant(item.when ?? {}, item.content ?? '')],
    useVariants,
    when: normalizeWhen(item.when ?? {}),
    topicsText: (item.topics ?? []).join(', '),
    disclosure: item.disclosure ?? '',
    priority: item.targetPriority ?? (item.kind === 'promote' ? 1 : 2),
  })
}
function parseDraftTopics(text: string) {
  const raw = text
    .split(/[,，、\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const seen = new Set<string>()
  const list: string[] = []
  for (const tag of raw) {
    const res = TopicTag.safeParse(tag)
    if (!res.success) {
      return { ok: false as const, message: res.error.issues[0]?.message ?? '主题标签格式有误' }
    }
    if (!seen.has(res.data)) {
      seen.add(res.data)
      list.push(res.data)
    }
  }
  if (list.length > TOPICS_MAX) {
    return { ok: false as const, message: `主题标签最多 ${TOPICS_MAX} 个` }
  }
  return { ok: true as const, list }
}
const distillPriorityItems = [
  { label: '0 · 最高（启动加载）', value: 0 },
  { label: '1 · 重要', value: 1 },
  { label: '2 · 普通', value: 2 },
  { label: '3 · 低', value: 3 },
]
function addDraftVariant(id: string) {
  const draft = drafts.get(id)
  if (!draft || draft.variants.length >= VARIANTS_MAX) return
  draft.variants.push(makeDraftVariant())
}
function removeDraftVariant(id: string, idx: number) {
  const draft = drafts.get(id)
  if (!draft || draft.variants.length <= 1) return
  draft.variants.splice(idx, 1)
}
const looksDraftPlaintext = (item: DreamSuggestion): boolean => {
  const draft = drafts.get(item.id)
  if (!draft) return false
  if (item.kind === 'merge') return PLAINTEXT_CREDENTIAL.test(draft.content)
  if (item.kind === 'merge_variants' || item.kind === 'generalize' || draft.useVariants) {
    return draft.variants.some((v) => PLAINTEXT_CREDENTIAL.test(v.content))
  }
  if (item.kind === 'distill' || item.kind === 'distill_episode') {
    return PLAINTEXT_CREDENTIAL.test(draft.content)
  }
  return false
}

// 改过的草稿能不能提交
function draftProblem(item: DreamSuggestion): string | null {
  const draft = drafts.get(item.id)
  if (!draft) return null
  if (item.kind === 'promote' || item.kind === 'facet_tag') return null
  if (item.kind === 'distill' || item.kind === 'distill_episode') {
    if (draft.title.trim()) {
      const titleRes = EntryTitle.safeParse(draft.title.trim())
      if (!titleRes.success) return titleRes.error.issues[0]?.message ?? '标题格式有误'
    }
    const topicsRes = parseDraftTopics(draft.topicsText)
    if (!topicsRes.ok) return topicsRes.message
    if (draft.disclosure.trim().length > DISCLOSURE_MAX) {
      return `召回说明最多 ${DISCLOSURE_MAX} 字`
    }
  }
  if (item.kind === 'merge') {
    if (!draft.content.trim()) return '正文不能为空'
    const res = ApplyDreamSuggestion.shape.content.safeParse(draft.content)
    return res.success ? null : (res.error.issues[0]?.message ?? '正文长度超出限制')
  }
  if (item.kind === 'merge_variants' || item.kind === 'generalize' || draft.useVariants) {
    if (!draft.variants.length) return '至少保留一个变体'
    if (draft.variants.length > VARIANTS_MAX) return `最多 ${VARIANTS_MAX} 个变体`
    const seen = new Set<string>()
    for (const v of draft.variants) {
      if (!v.content.trim()) return '正文不能为空'
      const contentRes = ApplyDreamSuggestion.shape.content.safeParse(v.content)
      if (!contentRes.success) return contentRes.error.issues[0]?.message ?? '变体正文长度超出限制'
      const sig = whenSignature(normalizeWhen(v.when))
      if (seen.has(sig)) return '存在相同适用条件的重复变体'
      seen.add(sig)
    }
    return null
  }
  if (!draft.content.trim()) return '正文不能为空'
  const res = ApplyDreamSuggestion.shape.content.safeParse(draft.content)
  return res.success ? null : (res.error.issues[0]?.message ?? '正文长度超出限制')
}

function bodyOf(item: DreamSuggestion): ApplyDreamSuggestionBody {
  const draft = drafts.get(item.id)
  if (!draft) return {}
  switch (item.kind) {
    case 'merge':
      return { content: draft.content }
    case 'merge_variants':
    case 'generalize':
      return {
        variants: draft.variants.map((v, i) => ({
          when: normalizeWhen(v.when),
          content: v.content.trim(),
          sortOrder: i,
        })),
      }
    case 'facet_tag':
      return { when: normalizeWhen(draft.when) }
    case 'distill':
    case 'distill_episode': {
      const parsedTopics = parseDraftTopics(draft.topicsText)
      const topics = parsedTopics.ok ? parsedTopics.list : []
      const variants: VariantInput[] = draft.variants.map((v, i) => ({
        when: normalizeWhen(v.when),
        content: v.content.trim(),
        sortOrder: i,
      }))
      return {
        ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
        ...(draft.useVariants
          ? { variants }
          : { content: draft.content, when: normalizeWhen(draft.when) }),
        topics,
        priority: draft.priority,
        disclosure: draft.disclosure.trim() || null,
      }
    }
    case 'promote':
      return { priority: draft.priority }
    default:
      return {}
  }
}

const editable = (kind: DreamSuggestion['kind']) => kind !== 'stale' && kind !== 'review'

// 执行按钮上的说法
function actionLabel(item: DreamSuggestion): string {
  switch (item.kind) {
    case 'merge':
      return '合并'
    case 'merge_variants':
      return '合并为多变体'
    case 'facet_tag':
      return '应用适用条件'
    case 'generalize':
      return '应用泛化上浮'
    case 'distill':
      return '新建记忆'
    case 'distill_episode':
      return '沉淀为记忆'
    case 'stale':
      return '设为过时'
    case 'promote':
      return '提升优先级'
    case 'review':
      return item.verdict === 'delete' ? '删除' : '确认'
  }
}
// 会删掉记忆的先确认：合并删掉其余几条，审核里的删除
const destructive = (item: DreamSuggestion) =>
  item.kind === 'merge' ||
  item.kind === 'merge_variants' ||
  (item.kind === 'review' && item.verdict === 'delete')

// 处理之后要刷新的：建议与运行记录、待确认内容、记忆与双链、联系人页、变更记录、概览与待处理的条数
function refresh(circleId: string) {
  for (const key of [
    'dream-suggestions',
    'inbox-counts',
    'review',
    'entry',
    'entry-list',
    'entry-browse',
    'entry-links',
    'entry-deleted',
    'entry-expired',
    'entry-history',
    'subjects',
    'subject',
    'overview',
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key, circleId] })
  }
  void invalidateActivity(queryClient, circleId)
}

const busy = ref<string | null>(null)
const confirming = ref<DreamSuggestion | null>(null)
const confirmError = ref<string | null>(null)
const confirmConsequences = computed(() => {
  const target = confirming.value
  if (!target) return []
  return [suggestionKinds[target.kind].effect]
})

async function apply(item: DreamSuggestion) {
  if (busy.value) return
  // 请求期间可能换了记忆圈（页面会被复用）：按发出请求时的记忆圈刷新
  const circleId = props.circleId
  const fromModal = confirming.value?.id === item.id
  busy.value = item.id
  if (fromModal) confirmError.value = null
  try {
    const result = await api.applyDreamSuggestion(circleId, item.id, bodyOf(item))
    drafts.delete(item.id)
    if (fromModal) confirming.value = null
    toast.add({
      title: result.entry ? `已新建「${result.entry.title}」` : `已${actionLabel(item)}`,
      color: 'success',
    })
    refresh(circleId)
  } catch (err) {
    const message = err instanceof ApiError ? err.message : '执行失败'
    if (fromModal) confirmError.value = message
    else toast.add({ title: message, color: 'error' })
    // 建议作废了、已经被别人处理了：刷新列表
    if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
      void queryClient.invalidateQueries({ queryKey: ['dream-suggestions', circleId] })
      void invalidateInboxCounts(queryClient, circleId)
    }
  } finally {
    busy.value = null
  }
}
async function reject(item: DreamSuggestion) {
  if (busy.value) return
  const circleId = props.circleId
  busy.value = item.id
  try {
    await api.rejectDreamSuggestion(circleId, item.id)
    drafts.delete(item.id)
    toast.add({ title: '已拒绝，不再提出相同建议', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '拒绝失败', color: 'error' })
  } finally {
    busy.value = null
    void queryClient.invalidateQueries({ queryKey: ['dream-suggestions', circleId] })
    void invalidateInboxCounts(queryClient, circleId)
  }
}

// 「立即整理」：排进后台任务之后按编号每隔几秒查一次，做完了就停（最多等十五分钟）
const runId = ref<string | null>(null)
const starting = ref(false)
const run = useQuery({
  queryKey: computed(() => ['dream-run', props.circleId, runId.value]),
  queryFn: () => api.dreamRun(props.circleId, runId.value!),
  enabled: computed(() => Boolean(runId.value)),
  refetchInterval: 3_000,
  retry: false,
})
let alive = true
let giveUp: ReturnType<typeof setTimeout> | undefined
function stopWaiting() {
  runId.value = null
  clearTimeout(giveUp)
}
onBeforeUnmount(() => {
  alive = false
  stopWaiting()
})
// 换了记忆圈：不再等上一个记忆圈的那一次
watch(() => props.circleId, stopWaiting)
async function runNow() {
  if (starting.value || runId.value) return
  const circleId = props.circleId
  starting.value = true
  try {
    const queued = await api.startDream(circleId)
    // 请求回来之前已经离开了这一页或者换了记忆圈：不再等
    if (!alive || circleId !== props.circleId) return
    runId.value = queued.runId
    giveUp = setTimeout(stopWaiting, 15 * 60_000)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '启动整理失败', color: 'error' })
  } finally {
    starting.value = false
  }
}
watch([() => run.data.value, () => run.isError.value], ([status, failed]) => {
  if (!runId.value || (!failed && status?.state !== 'finished')) return
  stopWaiting()
  const outcome = status && !failed ? runOutcome(status) : null
  toast.add(outcome ?? { title: '无法获取本次整理的状态，请稍后刷新查看', color: 'warning' })
  void queryClient.invalidateQueries({ queryKey: listKey.value })
  void queryClient.invalidateQueries({ queryKey: runsKey.value })
  void invalidateInboxCounts(queryClient, props.circleId)
})
</script>

<template>
  <div class="dream">
    <SectionHeading title="整理建议">
      <template #hint>
        <Hint>
          每天自动整理一次，只提建议，执行后才会修改记忆。建议包含合并重复内容、合并多变体记忆、补全适用条件、跨项目泛化上浮、提炼记忆、沉淀会话摘要、标记过时、审核待确认内容与调整优先级。执行后写入的来源记为本人；已拒绝的相同建议不再提出。
        </Hint>
      </template>
      <template v-if="lastRun" #actions>
        <span class="dream-last tabular-nums">{{ lastRun }}</span>
      </template>
    </SectionHeading>

    <ReadFailureNote v-if="mine.isError.value" class="dream-note" :query="mine" />
    <div class="dream-intro">
      <p v-if="mine.data.value">
        <template v-if="circle?.kind === 'personal'">
          {{
            mine.data.value.includePrivate
              ? '当前为个人圈，整理时会将非机密记忆发送给实例配置的抽取模型，'
              : '当前已在个人圈关闭整理，暂不生成新建议，'
          }}
        </template>
        <template v-else>
          {{
            mine.data.value.includePrivate
              ? '当前账号在个人范围的非机密记忆也会发送给实例配置的抽取模型整理，'
              : '当前账号已关闭个人范围的整理，目前仅整理共享内容，'
          }}
        </template>
        <RouterLink :to="circleSettingsRoute(circleId, 'extraction')" class="text-primary"
          >可在记忆圈设置中{{ mine.data.value.includePrivate ? '关闭' : '开启' }}</RouterLink
        >。
      </p>
      <UButton
        v-if="canAct"
        color="primary"
        variant="outline"
        :loading="starting || Boolean(runId)"
        @click="runNow"
      >
        {{ runId ? '正在整理…' : '立即整理' }}
      </UButton>
    </div>

    <ReadFailureNote
      v-if="suggestions.isError.value && !suggestions.isFetchNextPageError.value"
      class="dream-note"
      :query="suggestions"
    />
    <div v-if="suggestions.isPending.value" class="mt-3 space-y-3">
      <USkeleton v-for="n in 3" :key="n" class="h-32 w-full" />
    </div>
    <template v-else-if="suggestions.data.value">
      <EmptyState v-if="!items.length" title="暂无整理建议" />
      <article v-for="item in items" :key="item.id" class="suggestion">
        <div class="suggestion-main">
          <h3>
            {{ suggestionKinds[item.kind].label }}
            <span
              v-if="item.kind === 'review'"
              class="verdict"
              :class="{ 'text-error': item.verdict === 'delete' }"
            >
              {{ item.verdict === 'delete' ? '建议删除' : '建议确认' }}
            </span>
          </h3>
          <p class="suggestion-meta">
            {{ dreamScopeText(item.scope) }}
            <time :datetime="item.createdAt" :title="formatTime(item.createdAt)">
              {{ formatRelative(item.createdAt) }}
            </time>
          </p>
          <p class="suggestion-reason">{{ item.reason }}</p>

          <ul class="suggestion-memories">
            <li v-for="entry in item.entries" :key="entry.id">
              <p class="memory-head">
                <StrataSwatch :band="bandOf(entry)" :sensitivity="entry.sensitivity" local />
                <RouterLink
                  v-if="entry.kind === 'entry'"
                  :to="entryRoute(circleId, entry.shortId)"
                  class="memory-link"
                >
                  <MemoryName :short-id="entry.shortId" :title="entry.title" />
                </RouterLink>
                <RouterLink
                  v-else-if="entry.subject"
                  :to="{ name: 'contact', params: { circleId, subjectId: entry.subject.id } }"
                  class="memory-link"
                >
                  关于「{{ entry.subject.displayName }}」
                </RouterLink>
                <span v-else>{{ entryKindLabels[entry.kind] }}</span>
                <MemoryFlags
                  v-if="entry.kind === 'entry' || entry.subject"
                  :band="bandOf(entry)"
                  :sensitivity="entry.sensitivity"
                />
                <span v-if="hasWhen(entry.when)" class="memory-flag">
                  {{ whenLabel(entry.when, vocab) }}
                </span>
                <span v-if="item.keepId === entry.id" class="memory-flag">保留</span>
                <span v-if="entry.provenance === 'untrusted'" class="memory-flag warning">
                  未确认来源
                </span>
              </p>
              <p class="memory-body">{{ entry.content }}</p>
            </li>
          </ul>

          <template v-if="item.kind === 'merge'">
            <UFormField v-if="drafts.has(item.id)" class="draft-field" label="合并后的正文">
              <UTextarea
                v-model="drafts.get(item.id)!.content"
                :rows="4"
                autoresize
                class="w-full font-mono"
              />
            </UFormField>
            <div v-else class="draft">
              <span class="draft-label">合并后的正文</span>
              <p>{{ item.content }}</p>
            </div>
          </template>
          <template v-else-if="item.kind === 'merge_variants' || item.kind === 'generalize'">
            <div v-if="drafts.has(item.id)" class="draft-form">
              <div class="draft-variants-head">
                <p class="draft-label">变体列表</p>
                <UButton
                  v-if="drafts.get(item.id)!.variants.length < VARIANTS_MAX"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  @click="addDraftVariant(item.id)"
                >
                  新增变体
                </UButton>
              </div>
              <div
                v-for="(variant, idx) in drafts.get(item.id)!.variants"
                :key="variant.key"
                class="draft-variant"
              >
                <div class="draft-variant-head">
                  <span class="draft-label">变体 {{ idx + 1 }}</span>
                  <UButton
                    v-if="drafts.get(item.id)!.variants.length > 1"
                    size="xs"
                    color="error"
                    variant="ghost"
                    @click="removeDraftVariant(item.id, idx)"
                  >
                    删除变体
                  </UButton>
                </div>
                <FacetWhenPicker
                  v-model="variant.when"
                  :circle-id="circleId"
                  :vocabulary="facets.data.value ?? null"
                />
                <UFormField label="正文">
                  <UTextarea
                    v-model="variant.content"
                    :rows="3"
                    autoresize
                    class="w-full font-mono"
                  />
                </UFormField>
              </div>
            </div>
            <div v-else class="draft">
              <span class="draft-label">建议变体列表</span>
              <div v-for="(variant, idx) in item.variants ?? []" :key="idx" class="draft-slice">
                <p class="draft-meta">{{ whenLabel(variant.when, vocab) }}</p>
                <p>{{ variant.content }}</p>
              </div>
            </div>
          </template>
          <template v-else-if="item.kind === 'facet_tag'">
            <div v-if="drafts.has(item.id)" class="draft-form">
              <p class="draft-label">适用条件</p>
              <FacetWhenPicker
                v-model="drafts.get(item.id)!.when"
                :circle-id="circleId"
                :vocabulary="facets.data.value ?? null"
              />
            </div>
            <div v-else class="draft">
              <span class="draft-label">建议适用条件</span>
              <p>{{ whenLabel(item.when ?? {}, vocab) }}</p>
            </div>
          </template>
          <template v-else-if="item.kind === 'distill' || item.kind === 'distill_episode'">
            <div v-if="drafts.has(item.id)" class="draft-form">
              <p class="draft-label">草稿</p>
              <UFormField label="标题">
                <UInput
                  v-model="drafts.get(item.id)!.title"
                  :maxlength="ENTRY_TITLE_MAX"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="优先级">
                <USelect
                  v-model="drafts.get(item.id)!.priority"
                  :items="distillPriorityItems"
                  value-key="value"
                  aria-label="优先级"
                  class="w-60"
                />
              </UFormField>
              <UFormField label="主题标签" help="多个标签用逗号分隔">
                <UInput v-model="drafts.get(item.id)!.topicsText" class="w-full" />
              </UFormField>
              <UFormField label="召回说明" help="什么场景下应该想起这条记忆">
                <UInput
                  v-model="drafts.get(item.id)!.disclosure"
                  :maxlength="DISCLOSURE_MAX"
                  class="w-full"
                />
              </UFormField>
              <template v-if="drafts.get(item.id)!.useVariants">
                <div class="draft-variants-head">
                  <span class="draft-label">变体列表</span>
                  <UButton
                    v-if="drafts.get(item.id)!.variants.length < VARIANTS_MAX"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    @click="addDraftVariant(item.id)"
                  >
                    新增变体
                  </UButton>
                </div>
                <div
                  v-for="(variant, idx) in drafts.get(item.id)!.variants"
                  :key="variant.key"
                  class="draft-variant"
                >
                  <div class="draft-variant-head">
                    <span class="draft-label">变体 {{ idx + 1 }}</span>
                    <UButton
                      v-if="drafts.get(item.id)!.variants.length > 1"
                      size="xs"
                      color="error"
                      variant="ghost"
                      @click="removeDraftVariant(item.id, idx)"
                    >
                      删除变体
                    </UButton>
                  </div>
                  <FacetWhenPicker
                    v-model="variant.when"
                    :circle-id="circleId"
                    :vocabulary="facets.data.value ?? null"
                  />
                  <UFormField label="正文">
                    <UTextarea
                      v-model="variant.content"
                      :rows="3"
                      autoresize
                      class="w-full font-mono"
                    />
                  </UFormField>
                </div>
              </template>
              <template v-else>
                <UFormField label="适用条件">
                  <FacetWhenPicker
                    v-model="drafts.get(item.id)!.when"
                    :circle-id="circleId"
                    :vocabulary="facets.data.value ?? null"
                  />
                </UFormField>
                <UFormField label="正文">
                  <UTextarea
                    v-model="drafts.get(item.id)!.content"
                    :rows="4"
                    autoresize
                    class="w-full font-mono"
                  />
                </UFormField>
              </template>
            </div>
            <div v-else class="draft">
              <span class="draft-label">草稿</span>
              <p v-if="item.title" class="draft-meta">
                <b>{{ item.title }}</b>
              </p>
              <p v-if="item.topics?.length" class="draft-meta">
                主题标签：{{ item.topics.join('、') }}
              </p>
              <p v-if="item.disclosure" class="draft-meta">召回说明：{{ item.disclosure }}</p>
              <template v-if="item.variants?.length">
                <div v-for="(variant, idx) in item.variants" :key="idx" class="draft-slice">
                  <p class="draft-meta">{{ whenLabel(variant.when, vocab) }}</p>
                  <p>{{ variant.content }}</p>
                </div>
              </template>
              <template v-else>
                <p v-if="hasWhen(item.when)" class="draft-meta">
                  适用条件：{{ whenLabel(item.when ?? {}, vocab) }}
                </p>
                <p>{{ item.content }}</p>
              </template>
            </div>
          </template>
          <template v-else-if="item.kind === 'promote'">
            <UFormField v-if="drafts.has(item.id)" class="draft-field" label="目标优先级">
              <USelect
                v-model="drafts.get(item.id)!.priority"
                :items="[
                  { label: '最高优先级 · 每次会话启动加载', value: 0 },
                  { label: '重要 · 优先召回', value: 1 },
                ]"
                value-key="value"
                class="w-60"
              />
            </UFormField>
            <div v-else class="draft">
              <span class="draft-label">建议目标</span>
              <p>
                {{
                  (item.targetPriority ?? 1) === 0
                    ? '最高优先级 · 每次会话启动加载'
                    : '重要 · 优先召回'
                }}
              </p>
            </div>
          </template>
          <NoteLine
            v-if="drafts.has(item.id) && looksDraftPlaintext(item)"
            class="dream-note"
            tone="warning"
          >
            正文疑似包含明文凭据
            <template #detail>建议转存为凭据（「凭据」页），正文改用占位符。</template>
          </NoteLine>
          <p class="suggestion-effect">{{ suggestionKinds[item.kind].effect }}</p>
          <p v-if="canAct && !item.actionable" class="suggestion-effect">
            包含当前账号无权写入的记忆（如其他成员的客户端的记忆），需由有权限的成员处理。
          </p>
          <p v-if="draftProblem(item)" class="suggestion-problem">{{ draftProblem(item) }}</p>
        </div>

        <!-- 每张建议的操作都用线框，和待处理的其他三类一样；实心只留给确认对话框 -->
        <div v-if="canAct && item.actionable" class="suggestion-actions">
          <UButton
            :color="item.kind === 'review' && item.verdict === 'delete' ? 'error' : 'primary'"
            variant="outline"
            :loading="busy === item.id"
            :disabled="Boolean(busy) || Boolean(draftProblem(item))"
            @click="destructive(item) ? ((confirming = item), (confirmError = null)) : apply(item)"
          >
            {{ actionLabel(item) }}
          </UButton>
          <UButton
            v-if="editable(item.kind) && !drafts.has(item.id)"
            color="primary"
            variant="outline"
            :disabled="Boolean(busy)"
            @click="startEdit(item)"
          >
            修改
          </UButton>
          <UButton
            v-else-if="drafts.has(item.id)"
            color="primary"
            variant="outline"
            @click="drafts.delete(item.id)"
          >
            取消修改
          </UButton>
          <UButton
            color="primary"
            variant="outline"
            :disabled="Boolean(busy)"
            @click="reject(item)"
          >
            拒绝
          </UButton>
        </div>
      </article>
      <div v-if="suggestions.isFetchNextPageError.value" class="mt-3">
        <NoteLine tone="error">{{ readFailure(suggestions.error.value) }}</NoteLine>
      </div>
      <div v-if="suggestions.hasNextPage.value" class="mt-4 flex justify-center">
        <UButton
          color="neutral"
          variant="outline"
          :loading="suggestions.isFetchingNextPage.value"
          @click="suggestions.fetchNextPage()"
        >
          加载更多
        </UButton>
      </div>
    </template>

    <section class="runs">
      <SectionHeading title="最近整理" :level="3">
        <template #hint>
          <Hint>
            整理使用抽取模型，用量计入记忆圈的抽取预算。只处理上次以来新增或修改的记忆，其他成员的个人内容不在此列出。共享内容先整理并记录一条汇总，之后才整理各成员的个人内容，因此当前账号的结果可能稍晚于整理状态出现。
          </Hint>
        </template>
      </SectionHeading>
      <ReadFailureNote v-if="runs.isError.value" class="dream-note" :query="runs" />
      <USkeleton v-if="runs.isPending.value" class="mt-3 h-16 w-full" />
      <p v-else-if="runs.data.value && !runs.data.value.runs.length" class="dream-empty">
        暂无整理记录
      </p>
      <ul v-else-if="runs.data.value">
        <li v-for="entry in runs.data.value.runs" :key="entry.runId" class="run">
          <p class="run-head">
            <span>{{ formatTime(entry.at) }}</span>
            <span class="run-trigger">{{ triggerLabels[entry.trigger] }}</span>
          </p>
          <ul>
            <li v-for="(part, i) in entry.entries" :key="i" class="run-part">
              <b>{{ part.scope ? dreamScopeText(part.scope) : '共享内容' }}：</b
              >{{ part.scope ? runEntrySummary(part) : sharedSummaryText(part) }}
              <span v-if="part.error" class="run-error">{{ part.error }}</span>
            </li>
          </ul>
        </li>
      </ul>
    </section>

    <ConsequenceModal
      :open="confirming !== null"
      :title="
        confirming?.kind === 'merge' || confirming?.kind === 'merge_variants'
          ? '合并这几条记忆？'
          : '删除这条内容？'
      "
      :consequences="confirmConsequences"
      :action="confirming ? actionLabel(confirming) : '确定'"
      :busy="busy !== null"
      :error="confirmError"
      @close="confirming = null"
      @confirm="confirming && apply(confirming)"
    />
  </div>
</template>

<style scoped>
.dream-last {
  font-size: 14px;
  white-space: nowrap;
}
.dream-intro {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 24px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  color: var(--ui-text-muted);
}
.dream-intro p {
  flex: 1 1 20em;
  min-width: 0;
}
.dream-intro > :last-child {
  margin-left: auto;
}
.note-line.dream-note {
  margin: 10px 0 0;
  border-top: 0;
}
.dream-empty {
  padding: 22px 0;
  color: var(--ui-text-muted);
}
.suggestion {
  display: flex;
  justify-content: space-between;
  gap: 32px;
  padding: 16px 0 18px;
  border-bottom: 1px solid var(--ui-border);
}
.suggestion-main {
  flex: 1;
  min-width: 0;
  max-width: 760px;
}
.suggestion h3 {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.6;
}
.verdict {
  margin-left: 8px;
  font-size: 13px;
  font-weight: 500;
}
.suggestion-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.suggestion-reason {
  margin-top: 1px;
  font-size: 14px;
  color: var(--ui-text-muted);
}
.suggestion-memories {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 9px;
}
.memory-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 9px;
  font-size: 14px;
  line-height: 1.6;
}
.memory-link {
  min-width: 0;
}
.memory-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.memory-flag {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.memory-flag.warning {
  color: var(--ui-warning);
}
.memory-body {
  max-height: 12rem;
  margin: 2px 0 0 27px;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.65;
  color: var(--ui-text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.draft {
  margin-top: 12px;
  padding: 9px 12px 10px;
  border: 1px solid var(--ui-border-accented);
  font-size: 14px;
  line-height: 1.75;
}
.draft p {
  max-height: 12rem;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.draft-label {
  display: block;
  margin-bottom: 1px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.draft-uri {
  display: flex;
  flex-wrap: wrap;
  gap: 0 8px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.draft-uri code {
  color: var(--ui-text);
}
.draft-meta {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.draft-slice + .draft-slice {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--ui-border);
}
.draft-variants-head,
.draft-variant-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.draft-variant {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
}
.draft-field {
  margin-top: 12px;
}
.draft-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}
.suggestion-effect {
  margin-top: 8px;
  font-size: 14px;
  color: var(--ui-text-muted);
}
.suggestion-problem {
  margin-top: 4px;
  font-size: 14px;
  color: var(--ui-error);
}
.suggestion-actions {
  flex: none;
  display: flex;
  align-self: flex-start;
  gap: 6px;
}
.runs {
  margin-top: 28px;
}
.run {
  padding: 8px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
}
.run-head {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}
.run-trigger {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.run-part {
  line-height: 1.65;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.run-part b {
  font-weight: 400;
  color: var(--ui-text);
}
.run-error {
  display: block;
  color: var(--ui-error);
}
@media (max-width: 1023.98px) {
  .suggestion {
    flex-direction: column;
    gap: 12px;
  }
  .suggestion-actions {
    align-self: stretch;
  }
  .suggestion-actions > * {
    flex: 1;
    justify-content: center;
  }
  .dream-last {
    white-space: normal;
  }
}
</style>
