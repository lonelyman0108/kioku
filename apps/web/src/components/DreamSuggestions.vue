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
import {
  dreamScopeText,
  dreamSettingsKey,
  runEntrySummary,
  sharedSummaryText,
  runOutcome,
  suggestionKinds,
  triggerLabels,
} from '../dream'
import { icons } from '../icons'
import { layerLabels } from '../labels'
import { memoryRoute } from '../routes'
import { spaceSettingsRoute } from '../settingsSections'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'

const props = defineProps<{ spaceId: string; canAct: boolean }>()
const toast = useToast()
const queryClient = useQueryClient()

const listKey = computed(() => ['dream-suggestions', props.spaceId] as const)
const suggestions = useInfiniteQuery({
  queryKey: listKey,
  // 参数从键里取：换了空间之后，旧键剩下的页还在重新拉取时，不会去请求新的空间
  queryFn: ({ pageParam, queryKey: [, spaceId] }) => api.dreamSuggestions(spaceId, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})
const items = computed(() => suggestions.data.value?.pages.flatMap((page) => page.items) ?? [])

const runsKey = computed(() => ['dream-runs', props.spaceId] as const)
const runs = useQuery({
  queryKey: runsKey,
  queryFn: ({ queryKey: [, spaceId] }) => api.dreamRuns(spaceId),
})
// 自己的画像层与私人层整理不整理：在空间设置里改，这里说一声
const mine = useQuery({
  queryKey: computed(() => dreamSettingsKey(props.spaceId)),
  queryFn: ({ queryKey: [, spaceId] }) => api.dreamSettings(spaceId),
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

// 处理之后要刷新的：建议与运行记录、待审、记忆的各个列表、对象页、活动与概览
function refresh(spaceId: string) {
  for (const key of [
    'dream-suggestions',
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
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start gap-3">
      <div class="min-w-0 flex-1 space-y-1 text-sm text-muted">
        <p>
          Dream 每天整理一次，只提建议，执行后才会修改记忆。
          <Hint>
            建议分四类：合并重复内容、将多条事实提炼为一个节点、标记可能过时的内容、对未确认来源的内容建议确认或删除。执行后写入的来源记为本人；已拒绝的相同建议不再提出。
          </Hint>
        </p>
        <p v-if="mine.data.value">
          {{
            mine.data.value.includePrivate
              ? '当前账号的个人画像层与私人层（机密除外）也会发送给实例配置的抽取模型整理，'
              : '当前账号已关闭个人画像层与私人层的整理，目前仅整理共享内容，'
          }}<RouterLink
            :to="spaceSettingsRoute(spaceId, 'dream')"
            class="text-primary hover:underline"
            >可在空间设置中{{ mine.data.value.includePrivate ? '关闭' : '开启' }}</RouterLink
          >。
        </p>
      </div>
      <UButton
        v-if="canAct"
        :icon="icons.dream"
        :loading="starting || Boolean(runId)"
        @click="runNow"
      >
        {{ runId ? '正在整理…' : '立即整理' }}
      </UButton>
    </div>

    <UAlert
      v-if="suggestions.isError.value"
      color="error"
      variant="subtle"
      :title="
        suggestions.error.value instanceof ApiError ? suggestions.error.value.message : '读取失败'
      "
    />
    <div v-else-if="suggestions.isPending.value" class="space-y-3">
      <USkeleton v-for="n in 3" :key="n" class="h-32 w-full" />
    </div>
    <template v-else>
      <p v-if="!items.length" class="text-sm text-muted">暂无整理建议</p>
      <ul class="space-y-3">
        <li v-for="item in items" :key="item.id">
          <UCard>
            <div class="space-y-3">
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <UBadge :icon="suggestionKinds[item.kind].icon" variant="subtle">
                  {{ suggestionKinds[item.kind].label }}
                </UBadge>
                <UBadge
                  v-if="item.kind === 'review'"
                  size="sm"
                  :color="item.verdict === 'delete' ? 'error' : 'success'"
                  variant="outline"
                >
                  {{ item.verdict === 'delete' ? '建议删除' : '建议确认' }}
                </UBadge>
                <span class="text-muted">{{ dreamScopeText(item.scope) }}</span>
                <time
                  class="text-xs text-muted"
                  :datetime="item.createdAt"
                  :title="formatTime(item.createdAt)"
                >
                  {{ formatRelative(item.createdAt) }}
                </time>
              </div>
              <p class="text-sm">{{ item.reason }}</p>

              <ul class="space-y-2">
                <li
                  v-for="memory in item.memories"
                  :key="memory.id"
                  class="rounded-md border border-default p-2"
                >
                  <p class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <UBadge
                      v-if="item.keepId === memory.id"
                      size="sm"
                      color="primary"
                      variant="subtle"
                    >
                      保留
                    </UBadge>
                    <RouterLink
                      v-if="memory.uri"
                      :to="memoryRoute(spaceId, memory.uri)"
                      class="text-primary hover:underline"
                    >
                      <code>{{ memory.uri }}</code>
                    </RouterLink>
                    <RouterLink
                      v-else-if="memory.subject"
                      :to="{ name: 'subject', params: { spaceId, subjectId: memory.subject.id } }"
                      class="text-primary hover:underline"
                    >
                      关于「{{ memory.subject.displayName }}」
                    </RouterLink>
                    <span v-else>{{ layerLabels[memory.layer] }}</span>
                    <UBadge
                      v-if="memory.provenance === 'untrusted'"
                      size="sm"
                      color="warning"
                      variant="outline"
                    >
                      未确认来源
                    </UBadge>
                  </p>
                  <p class="mt-1 max-h-48 overflow-y-auto text-sm break-words whitespace-pre-wrap">
                    {{ memory.content }}
                  </p>
                </li>
              </ul>

              <template v-if="item.kind === 'merge'">
                <UFormField v-if="drafts.has(item.id)" label="合并后的正文">
                  <UTextarea
                    v-model="drafts.get(item.id)!.content"
                    :rows="4"
                    autoresize
                    class="w-full font-mono"
                  />
                </UFormField>
                <template v-else>
                  <p class="text-xs font-medium">合并后的正文</p>
                  <p
                    class="max-h-48 overflow-y-auto rounded-md bg-elevated p-2 text-sm break-words whitespace-pre-wrap"
                  >
                    {{ item.content }}
                  </p>
                </template>
              </template>
              <template v-else-if="item.kind === 'distill'">
                <p class="text-xs font-medium">草稿</p>
                <div v-if="drafts.has(item.id)" class="space-y-3">
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
                <div v-else class="space-y-1 rounded-md bg-elevated p-2 text-sm">
                  <p class="flex flex-wrap items-center gap-2">
                    <code>{{ item.uri }}</code>
                    <span class="text-xs text-muted">默认放在当前账号的私人层</span>
                  </p>
                  <p v-if="item.disclosure" class="text-xs text-muted">
                    触发场景：{{ item.disclosure }}
                  </p>
                  <p class="break-words whitespace-pre-wrap">{{ item.content }}</p>
                </div>
              </template>
              <UAlert
                v-if="drafts.has(item.id) && looksPlaintext(drafts.get(item.id)!.content)"
                color="warning"
                variant="subtle"
                title="正文疑似包含明文凭据"
                description="建议转存为凭据（「凭据」页），正文改用占位符。"
              />
              <p class="text-xs text-muted">{{ suggestionKinds[item.kind].effect }}</p>

              <div v-if="canAct && item.actionable" class="flex flex-wrap items-center gap-2">
                <UButton
                  :icon="
                    item.kind === 'review' && item.verdict === 'delete' ? icons.remove : icons.apply
                  "
                  :color="item.kind === 'review' && item.verdict === 'delete' ? 'error' : 'primary'"
                  size="sm"
                  :loading="busy === item.id"
                  :disabled="Boolean(busy) || Boolean(draftProblem(item))"
                  @click="destructive(item) ? (confirming = item) : apply(item)"
                >
                  {{ actionLabel(item) }}
                </UButton>
                <UButton
                  v-if="(item.kind === 'merge' || item.kind === 'distill') && !drafts.has(item.id)"
                  :icon="icons.edit"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  :disabled="Boolean(busy)"
                  @click="startEdit(item)"
                >
                  修改
                </UButton>
                <UButton
                  v-else-if="drafts.has(item.id)"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  @click="drafts.delete(item.id)"
                >
                  取消修改
                </UButton>
                <UButton
                  :icon="icons.cancel"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :disabled="Boolean(busy)"
                  @click="reject(item)"
                >
                  拒绝
                </UButton>
                <span v-if="draftProblem(item)" class="text-xs text-error">
                  {{ draftProblem(item) }}
                </span>
              </div>
              <p v-else-if="canAct" class="text-xs text-muted">
                包含当前账号无权写入的记忆（如其他成员应用的应用层），需由有权限的成员处理。
              </p>
            </div>
          </UCard>
        </li>
      </ul>
      <div v-if="suggestions.hasNextPage.value" class="flex justify-center">
        <UButton
          color="neutral"
          variant="subtle"
          :loading="suggestions.isFetchingNextPage.value"
          @click="suggestions.fetchNextPage()"
        >
          加载更多
        </UButton>
      </div>
    </template>

    <UCard>
      <template #header>
        <h3 class="text-sm font-medium">最近整理</h3>
        <p class="mt-1 text-xs text-muted">
          整理使用抽取模型，用量计入空间的抽取预算。
          <Hint>
            只处理上次以来新增或修改的记忆，其他成员的个人画像层与私人层不在此列出。共享内容先整理并记录一条汇总，之后才整理各成员的个人画像层与私人层，因此当前账号的结果可能稍晚于整理状态出现。
          </Hint>
        </p>
      </template>
      <UAlert
        v-if="runs.isError.value"
        color="error"
        variant="subtle"
        :title="runs.error.value instanceof ApiError ? runs.error.value.message : '读取失败'"
      />
      <USkeleton v-else-if="runs.isPending.value" class="h-16 w-full" />
      <p v-else-if="!runs.data.value?.runs.length" class="text-sm text-muted">暂无整理记录</p>
      <ul v-else class="divide-y divide-default">
        <li v-for="entry in runs.data.value.runs" :key="entry.runId" class="space-y-1 py-2 text-sm">
          <p class="flex flex-wrap items-center gap-2">
            <span>{{ formatTime(entry.at) }}</span>
            <UBadge size="sm" color="neutral" variant="subtle">
              {{ triggerLabels[entry.trigger] }}
            </UBadge>
          </p>
          <ul class="space-y-0.5">
            <li v-for="(part, i) in entry.entries" :key="i" class="text-xs text-muted">
              <span class="text-default"
                >{{ part.scope ? dreamScopeText(part.scope) : '共享内容' }}：</span
              >{{ part.scope ? runEntrySummary(part) : sharedSummaryText(part) }}
              <span v-if="part.error" class="block text-error">{{ part.error }}</span>
            </li>
          </ul>
        </li>
      </ul>
    </UCard>

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
