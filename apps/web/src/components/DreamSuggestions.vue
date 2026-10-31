<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  PLAIN_LAYERS,
  PLAINTEXT_CREDENTIAL,
  URI_PATTERN,
  type ApplyDreamSuggestion,
  type DreamSuggestion,
  type PlainLayer,
} from '@kioku/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
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
import { layerLabels } from '../labels'
import { memoryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import UriPath from './strata/UriPath.vue'

const props = defineProps<{ spaceId: string; canAct: boolean }>()
const toast = useToast()
const queryClient = useQueryClient()

const active = useActivated()
const listKey = computed(() => ['dream-suggestions', props.spaceId] as const)
const suggestions = useInfiniteQuery({
  queryKey: listKey,
  // 参数从键里取：换了空间之后，旧键剩下的页还在重新拉取时，不会去请求新的空间
  queryFn: ({ pageParam, queryKey: [, spaceId] }) => api.dreamSuggestions(spaceId, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  enabled: active,
})
const items = computed(() => suggestions.data.value?.pages.flatMap((page) => page.items) ?? [])

const runsKey = computed(() => ['dream-runs', props.spaceId] as const)
const runs = useQuery({
  queryKey: runsKey,
  queryFn: ({ queryKey: [, spaceId] }) => api.dreamRuns(spaceId),
  enabled: active,
})
const lastRun = computed(() => {
  const run = runs.data.value?.runs[0]
  return run ? lastRunSummary(run) : null
})
// 自己的画像层与私人层整理不整理：在空间设置里改，这里说一声
const mine = useQuery({
  queryKey: computed(() => dreamSettingsKey(props.spaceId)),
  queryFn: ({ queryKey: [, spaceId] }) => api.dreamSettings(spaceId),
  enabled: active,
})

// 正在改的合并正文与提炼草稿，按建议记下；没改的按建议原样执行。层为 default 时用默认的（自己的私人层）
type LayerChoice = PlainLayer | 'default'
interface Draft {
  content: string
  uri: string
  layer: LayerChoice
  disclosure: string
}
const drafts = reactive(new Map<string, Draft>())
watch(
  () => props.spaceId,
  () => drafts.clear(),
)
function startEdit(item: DreamSuggestion) {
  drafts.set(item.id, {
    content: item.content ?? '',
    uri: item.uri ?? '',
    layer: 'default',
    disclosure: item.disclosure ?? '',
  })
}
const layerItems = [
  { label: '默认：当前账号的私人层', value: 'default' },
  ...PLAIN_LAYERS.map((l) => ({ label: layerLabels[l], value: l })),
]
// persona:// 与 app:// 下的层由 URI 决定
const layerFixed = (uri: string) => /^(persona|app):\/\//.test(uri)
const looksPlaintext = (text: string) => PLAINTEXT_CREDENTIAL.test(text)

// 改过的草稿能不能提交：URI 格式对、正文不空
function draftProblem(item: DreamSuggestion): string | null {
  const draft = drafts.get(item.id)
  if (!draft) return null
  if (!draft.content.trim()) return '正文不能为空'
  if (item.kind === 'distill' && !URI_PATTERN.test(draft.uri.trim())) {
    return 'URI 格式为 domain://path，例如 people://xiaoming'
  }
  return null
}

function bodyOf(item: DreamSuggestion): ApplyDreamSuggestion {
  const draft = drafts.get(item.id)
  if (!draft) return {}
  if (item.kind === 'merge') return { content: draft.content }
  const uri = draft.uri.trim()
  return {
    uri,
    content: draft.content,
    disclosure: draft.disclosure.trim() || null,
    ...(draft.layer !== 'default' && !layerFixed(uri) ? { layer: draft.layer } : {}),
  }
}

// 执行按钮上的说法
function actionLabel(item: DreamSuggestion): string {
  if (item.kind === 'merge') return '合并'
  if (item.kind === 'distill') return '新建记忆'
  if (item.kind === 'stale') return '设为过时'
  return item.verdict === 'delete' ? '删除' : '确认'
}
// 会删掉记忆的先确认：合并删掉其余几条，审核里的删除
const destructive = (item: DreamSuggestion) =>
  item.kind === 'merge' || (item.kind === 'review' && item.verdict === 'delete')

// 处理之后要刷新的：建议与运行记录、待确认内容、记忆的各个列表、联系人页、变更记录、概览与待处理的条数
function refresh(spaceId: string) {
  for (const key of [
    'dream-suggestions',
    'inbox-counts',
    'review',
    'memory',
    'memory-list',
    'memory-children',
    'memory-deleted',
    'memory-expired',
    'memory-history',
    'subjects',
    'subject',
    'activity',
    'overview',
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key, spaceId] })
  }
}

const busy = ref<string | null>(null)
const confirming = ref<DreamSuggestion | null>(null)
async function apply(item: DreamSuggestion) {
  if (busy.value) return
  // 请求期间可能换了空间（页面会被复用）：按发出请求时的空间刷新
  const spaceId = props.spaceId
  busy.value = item.id
  try {
    const result = await api.applyDreamSuggestion(spaceId, item.id, bodyOf(item))
    drafts.delete(item.id)
    toast.add({
      title: result.memory ? `已新建 ${result.memory.uri}` : `已${actionLabel(item)}`,
      color: 'success',
    })
    refresh(spaceId)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '执行失败', color: 'error' })
    // 建议作废了、已经被别人处理了：刷新列表
    if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
      void queryClient.invalidateQueries({ queryKey: ['dream-suggestions', spaceId] })
      void invalidateInboxCounts(queryClient, spaceId)
    }
  } finally {
    busy.value = null
    confirming.value = null
  }
}
async function reject(item: DreamSuggestion) {
  if (busy.value) return
  const spaceId = props.spaceId
  busy.value = item.id
  try {
    await api.rejectDreamSuggestion(spaceId, item.id)
    drafts.delete(item.id)
    toast.add({ title: '已拒绝，不再提出相同建议', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '拒绝失败', color: 'error' })
  } finally {
    busy.value = null
    void queryClient.invalidateQueries({ queryKey: ['dream-suggestions', spaceId] })
    void invalidateInboxCounts(queryClient, spaceId)
  }
}

// 「立即整理」：排进后台任务之后按编号每隔几秒查一次，做完了就停（最多等十五分钟）
const runId = ref<string | null>(null)
const starting = ref(false)
const run = useQuery({
  queryKey: computed(() => ['dream-run', props.spaceId, runId.value]),
  queryFn: () => api.dreamRun(props.spaceId, runId.value!),
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
// 换了空间：不再等上一个空间的那一次
watch(() => props.spaceId, stopWaiting)
async function runNow() {
  if (starting.value || runId.value) return
  const spaceId = props.spaceId
  starting.value = true
  try {
    const queued = await api.startDream(spaceId)
    // 请求回来之前已经离开了这一页或者换了空间：不再等
    if (!alive || spaceId !== props.spaceId) return
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
  void invalidateInboxCounts(queryClient, props.spaceId)
})
</script>

<template>
  <div class="dream">
    <SectionHeading title="整理建议">
      <template #hint>
        <Hint>
          Dream
          每天整理一次，只提建议，执行后才会修改记忆。建议分四类：合并重复内容、将多条事实提炼为一个节点、标记可能过时的内容、对未确认来源的内容建议确认或删除。执行后写入的来源记为本人；已拒绝的相同建议不再提出。
        </Hint>
      </template>
      <template v-if="lastRun" #actions>
        <span class="dream-last">{{ lastRun }}</span>
      </template>
    </SectionHeading>

    <div class="dream-intro">
      <p v-if="mine.data.value">
        {{
          mine.data.value.includePrivate
            ? '当前账号的个人画像层与私人层（机密除外）也会发送给实例配置的抽取模型整理，'
            : '当前账号已关闭个人画像层与私人层的整理，目前仅整理共享内容，'
        }}<RouterLink :to="{ name: 'space-settings', params: { spaceId } }" class="text-primary"
          >可在空间设置中{{ mine.data.value.includePrivate ? '关闭' : '开启' }}</RouterLink
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

    <NoteLine v-if="suggestions.isError.value" class="dream-note" tone="error">
      {{
        suggestions.error.value instanceof ApiError ? suggestions.error.value.message : '读取失败'
      }}
    </NoteLine>
    <div v-else-if="suggestions.isPending.value" class="mt-3 space-y-3">
      <USkeleton v-for="n in 3" :key="n" class="h-32 w-full" />
    </div>
    <template v-else>
      <p v-if="!items.length" class="dream-empty">暂无整理建议</p>
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
            <li v-for="memory in item.memories" :key="memory.id">
              <p class="memory-head">
                <StrataSwatch :layer="memory.layer" :sensitivity="memory.sensitivity" />
                <RouterLink
                  v-if="memory.uri"
                  :to="memoryRoute(spaceId, memory.uri)"
                  class="memory-link"
                >
                  <UriPath :uri="memory.uri" />
                </RouterLink>
                <RouterLink
                  v-else-if="memory.subject"
                  :to="{ name: 'subject', params: { spaceId, subjectId: memory.subject.id } }"
                  class="memory-link"
                >
                  关于「{{ memory.subject.displayName }}」
                </RouterLink>
                <span v-else>{{ layerLabels[memory.layer] }}</span>
                <span v-if="item.keepId === memory.id" class="memory-flag">保留</span>
                <span v-if="memory.provenance === 'untrusted'" class="memory-flag warning">
                  未确认来源
                </span>
              </p>
              <p class="memory-body">{{ memory.content }}</p>
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
          <template v-else-if="item.kind === 'distill'">
            <div v-if="drafts.has(item.id)" class="draft-form">
              <p class="draft-label">草稿</p>
              <div class="grid gap-3 sm:grid-cols-2">
                <UFormField label="URI">
                  <UInput v-model="drafts.get(item.id)!.uri" class="w-full font-mono" />
                </UFormField>
                <UFormField
                  label="层"
                  :help="layerFixed(drafts.get(item.id)!.uri) ? '由 URI 决定' : undefined"
                >
                  <USelect
                    v-model="drafts.get(item.id)!.layer"
                    :items="layerItems"
                    :disabled="layerFixed(drafts.get(item.id)!.uri)"
                    class="w-full"
                  />
                </UFormField>
              </div>
              <UFormField label="触发场景" help="什么场景下应该想起这条记忆">
                <UInput v-model="drafts.get(item.id)!.disclosure" class="w-full" />
              </UFormField>
              <UFormField label="正文">
                <UTextarea
                  v-model="drafts.get(item.id)!.content"
                  :rows="4"
                  autoresize
                  class="w-full font-mono"
                />
              </UFormField>
            </div>
            <div v-else class="draft">
              <span class="draft-label">草稿</span>
              <p class="draft-uri">
                <code>{{ item.uri }}</code>
                <span>默认放在当前账号的私人层</span>
              </p>
              <p v-if="item.disclosure" class="draft-uri">触发场景：{{ item.disclosure }}</p>
              <p>{{ item.content }}</p>
            </div>
          </template>
          <NoteLine
            v-if="drafts.has(item.id) && looksPlaintext(drafts.get(item.id)!.content)"
            class="dream-note"
            tone="warning"
          >
            正文疑似包含明文凭据
            <template #detail>建议转存为凭据（「凭据」页），正文改用占位符。</template>
          </NoteLine>
          <p class="suggestion-effect">{{ suggestionKinds[item.kind].effect }}</p>
          <p v-if="canAct && !item.actionable" class="suggestion-effect">
            包含当前账号无权写入的记忆（如其他成员应用的应用层），需由有权限的成员处理。
          </p>
          <p v-if="draftProblem(item)" class="suggestion-problem">{{ draftProblem(item) }}</p>
        </div>

        <div v-if="canAct && item.actionable" class="suggestion-actions">
          <UButton
            :color="item.kind === 'review' && item.verdict === 'delete' ? 'error' : 'primary'"
            :loading="busy === item.id"
            :disabled="Boolean(busy) || Boolean(draftProblem(item))"
            @click="destructive(item) ? (confirming = item) : apply(item)"
          >
            {{ actionLabel(item) }}
          </UButton>
          <UButton
            v-if="(item.kind === 'merge' || item.kind === 'distill') && !drafts.has(item.id)"
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
            整理使用抽取模型，用量计入空间的抽取预算。只处理上次以来新增或修改的记忆，其他成员的个人画像层与私人层不在此列出。共享内容先整理并记录一条汇总，之后才整理各成员的个人画像层与私人层，因此当前账号的结果可能稍晚于整理状态出现。
          </Hint>
        </template>
      </SectionHeading>
      <NoteLine v-if="runs.isError.value" class="dream-note" tone="error">
        {{ runs.error.value instanceof ApiError ? runs.error.value.message : '读取失败' }}
      </NoteLine>
      <USkeleton v-else-if="runs.isPending.value" class="mt-3 h-16 w-full" />
      <p v-else-if="!runs.data.value?.runs.length" class="dream-empty">暂无整理记录</p>
      <ul v-else>
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

    <UModal
      :open="confirming !== null"
      :title="confirming?.kind === 'merge' ? '合并这几条记忆？' : '删除这条内容？'"
      @update:open="(v) => !v && (confirming = null)"
    >
      <template #body>
        <p class="text-sm">{{ confirming && suggestionKinds[confirming.kind].effect }}</p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirming = null">取消</UButton>
          <UButton
            :color="confirming?.kind === 'merge' ? 'primary' : 'error'"
            :loading="busy !== null"
            @click="confirming && apply(confirming)"
          >
            {{ confirming && actionLabel(confirming) }}
          </UButton>
        </div>
      </template>
    </UModal>
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
