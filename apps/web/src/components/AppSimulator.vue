<script setup lang="ts">
import {
  CHAT_TYPES,
  normalizeWhen,
  type BootPreview,
  type ChatType,
  type EntryKind,
  type FacetVocabularyView,
  type PreviewTargets,
} from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { bootUsage, simulatorState } from '../apps'
import { chatTypeLabels, usesGroup, usesSender } from '../benchForm'
import { useSession } from '../composables/useSession'
import { entryKindLabels, sessionExtraLabels } from '../labels'
import { whenLabel } from '../memoryDetail'
import { entryRoute } from '../routes'
import { formatShort, formatTime } from '../time'
import CrossCirclePreviewDrawer from './CrossCirclePreviewDrawer.vue'
import FacetWhenPicker from './FacetWhenPicker.vue'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import { entryBand } from './strata/strata'

// 启动加载预览：按客户端的一个访问密钥模拟会话开始，只给客户端所有者
const props = withDefaults(
  defineProps<{
    circleId: string
    clientId: string
    keyId: string | undefined
    settings: string
    vocabulary?: FacetVocabularyView | null
  }>(),
  { vocabulary: null },
)

const router = useRouter()

const keys = useQuery({
  queryKey: computed(() => ['keys', props.circleId, props.clientId] as const),
  queryFn: ({ queryKey: [, cid, clid] }) => api.keys(cid, clid),
})
const state = computed(() =>
  simulatorState(
    { isPending: keys.isPending.value, hasData: Boolean(keys.data.value) },
    props.keyId,
  ),
)

const failure = ref<string | null>(null)
let counter = 0
const current = ref<number | null>(null)
const running = computed(() => current.value !== null)
const project = reactive({ dirName: '', repoName: '' })
const optionsOpen = ref(false)
const chatType = ref<ChatType | null>(null)
const groupSubjectId = ref<string | null>(null)
const senderSubjectId = ref<string | null>(null)
const senderIsOwner = ref(false)
const facets = ref<Record<string, string[]>>({})
const preview = ref<BootPreview | null>(null)
const drawerTarget = ref<{ circleId: string; shortId: string } | null>(null)

const chatTypeItems = [
  { label: '无会话上下文', value: null },
  ...CHAT_TYPES.map((type) => ({ label: chatTypeLabels[type], value: type })),
]

const groupSubjects = useQuery({
  queryKey: computed(() => ['subjects', props.circleId, 'group', 'preview'] as const),
  queryFn: ({ queryKey: [, cid] }) => api.subjects(cid, { kind: 'group' }),
  enabled: computed(() => optionsOpen.value && usesGroup(chatType.value)),
})
const senderSubjects = useQuery({
  queryKey: computed(() => ['subjects', props.circleId, 'person', 'preview'] as const),
  queryFn: ({ queryKey: [, cid] }) => api.subjects(cid, { kind: 'person' }),
  enabled: computed(() => optionsOpen.value && usesSender(chatType.value)),
})

const groupItems = computed(() => [
  { label: '不指定具体群聊', value: null },
  ...(groupSubjects.data.value?.items ?? []).map((s) => ({
    label: s.displayName,
    value: s.id,
  })),
])
const senderItems = computed(() => [
  { label: '不指定具体联系人', value: null },
  ...(senderSubjects.data.value?.items ?? []).map((s) => ({
    label: s.displayName,
    value: s.id,
  })),
])

watch(chatType, (next) => {
  if (!usesGroup(next)) groupSubjectId.value = null
  if (!usesSender(next)) {
    senderSubjectId.value = null
    senderIsOwner.value = false
  }
})

watch([() => props.circleId, () => props.clientId], () => {
  chatType.value = null
  groupSubjectId.value = null
  senderSubjectId.value = null
  senderIsOwner.value = false
  facets.value = {}
  drawerTarget.value = null
})

function buildPreviewTargets(): PreviewTargets | undefined {
  const type = chatType.value
  if (!type) return undefined
  return {
    chatType: type,
    ...(usesGroup(type) && groupSubjectId.value ? { groupSubjectId: groupSubjectId.value } : {}),
    ...(usesSender(type) && senderSubjectId.value
      ? { senderSubjectId: senderSubjectId.value }
      : {}),
    ...(usesSender(type) && senderIsOwner.value ? { senderIsOwner: true } : {}),
  }
}

async function switchToEntry(targetCircleId: string, shortId: string) {
  await router.push(entryRoute(targetCircleId, shortId))
  drawerTarget.value = null
}

async function run<T>(call: () => Promise<T>, apply: (result: T) => void) {
  if (running.value || !props.keyId) return
  const id = ++counter
  current.value = id
  failure.value = null
  try {
    const result = await call()
    if (id === current.value) apply(result)
  } catch (err) {
    if (id === current.value) failure.value = err instanceof ApiError ? err.message : '模拟失败'
  } finally {
    if (current.value === id) current.value = null
  }
}

function runPreview() {
  const id = props.keyId
  if (!id) return
  const dirName = project.dirName.trim()
  const repoName = project.repoName.trim()
  const normalizedFacets = normalizeWhen(facets.value)
  const previewTargets = buildPreviewTargets()
  return run(
    () =>
      api.bootPreview(props.circleId, props.clientId, id, {
        ...(dirName || repoName
          ? { project: { ...(dirName ? { dirName } : {}), ...(repoName ? { repoName } : {}) } }
          : {}),
        ...(Object.keys(normalizedFacets).length ? { facets: normalizedFacets } : {}),
        ...(previewTargets ? { previewTargets } : {}),
      }),
    (result) => (preview.value = result),
  )
}

watch(
  [() => props.circleId, () => props.clientId, () => props.keyId, () => props.settings],
  () => {
    current.value = null
    preview.value = null
    failure.value = null
    void runPreview()
  },
  { immediate: true },
)

const usage = computed(() => (preview.value ? bootUsage(preview.value) : null))
const dropped = computed(() =>
  (preview.value?.dropped ?? []).map((extra) => sessionExtraLabels[extra]).join('、'),
)
const resolvedFacetsText = computed(() => {
  const f = preview.value?.resolvedFacets
  return f && Object.keys(f).length ? whenLabel(f, props.vocabulary ?? undefined) : null
})
const { me } = useSession()
const circlesById = computed(() => new Map((me.data.value?.circles ?? []).map((c) => [c.id, c])))
const entryBandOf = (
  item: { circleId: string; circleSlug?: string | null },
  kind: EntryKind = 'entry',
) => {
  const currentKind = circlesById.value.get(props.circleId)?.kind ?? 'shared'
  const targetKind =
    circlesById.value.get(item.circleId)?.kind ??
    (item.circleId === props.circleId
      ? currentKind
      : item.circleSlug === 'personal'
        ? 'personal'
        : 'shared')
  return entryBand(
    { kind, circleId: item.circleId, circleKind: targetKind },
    { id: props.circleId, kind: currentKind },
  )
}
</script>

<template>
  <section class="boot">
    <SectionHeading title="启动加载">
      <template #hint>
        <Hint>
          按所选访问密钥的当前访问范围、默认语境与模拟条件模拟会话开始时注入的内容，不计入召回记录。可在下方展开设置会话上下文与适用条件。
        </Hint>
      </template>
      <template v-if="usage" #actions>
        <span
          class="boot-total"
          :class="{ over: usage.over }"
          :title="
            usage.limit
              ? `客户端（${preview?.runtimeFamily}）可完整接收 ${usage.limit} 字`
              : `客户端（${preview?.runtimeFamily}）不限字数`
          "
        >
          {{ usage.used.toLocaleString()
          }}<template v-if="usage.limit"> / {{ usage.limit.toLocaleString() }}</template> 字
        </span>
      </template>
    </SectionHeading>

    <USkeleton v-if="state === 'loading'" class="mt-3 h-40 w-full" />
    <NoteLine v-else-if="state === 'failed'" class="boot-note" tone="error">
      {{ readFailure(keys.error.value) }}
    </NoteLine>
    <p v-else-if="state === 'none'" class="boot-empty">暂无有效访问密钥。签发后可模拟。</p>
    <template v-else>
      <NoteLine v-if="failure" class="boot-note" tone="error">{{ failure }}</NoteLine>
      <USkeleton v-if="running && !preview" class="mt-3 h-40 w-full" />
      <template v-if="preview && usage">
        <p v-if="resolvedFacetsText" class="boot-facets">展开语境：{{ resolvedFacetsText }}</p>
        <div
          class="boot-bar"
          role="img"
          :aria-label="`已用 ${usage.used} 字${usage.limit ? `，上限 ${usage.limit} 字` : ''}`"
        >
          <i
            v-for="segment in usage.segments"
            :key="segment.shortId"
            :style="{
              width: `${segment.width}%`,
              background: `var(--layer-${entryBandOf(segment)})`,
            }"
            :title="`${segment.title}（${segment.shortId}）：${segment.chars} 字`"
          />
          <i
            v-if="usage.other > 0"
            class="boot-other"
            :style="{ width: `${usage.other}%` }"
            title="人格设定、会话摘要、近期更新与相关记忆"
          />
        </div>
        <NoteLine v-if="preview.dropped.length" class="boot-note" tone="warning">
          超出客户端接收上限，未附加：{{ dropped }}
        </NoteLine>

        <div v-if="preview.personaTraits.length" class="boot-summaries">
          <SectionHeading
            :title="`人格设定段（${preview.personaTraits.length}）`"
            :level="3"
            class="boot-sub-head"
          />
          <ul class="boot-list">
            <li v-for="trait in preview.personaTraits" :key="trait.traitKey">
              <StrataSwatch band="persona" plain />
              <span class="boot-uri">{{ trait.title }}</span>
              <code class="boot-id">{{ trait.traitKey }}</code>
            </li>
          </ul>
        </div>

        <ul v-if="preview.entries.length" class="boot-list">
          <li v-for="entry in preview.entries" :key="`${entry.circleId}:${entry.shortId}`">
            <StrataSwatch :band="entryBandOf(entry)" plain />
            <RouterLink
              v-if="entry.circleId === circleId"
              :to="entryRoute(entry.circleId, entry.shortId)"
              class="boot-uri"
              :title="entry.shortId"
            >
              {{ entry.title }}
            </RouterLink>
            <button
              v-else
              type="button"
              class="boot-uri boot-cross"
              :title="`${entry.shortId}（其他记忆圈，点击侧栏预览）`"
              @click="drawerTarget = { circleId: entry.circleId, shortId: entry.shortId }"
            >
              {{ entry.title }}
            </button>
            <span class="boot-layer">{{ entry.circleSlug ?? entryKindLabels.entry }}</span>
            <span class="boot-chars">{{ entry.chars.toLocaleString() }}</span>
          </li>
        </ul>
        <p v-else class="boot-empty">暂无启动加载的正式记忆</p>
        <p
          v-if="preview.omitted.length"
          class="boot-omitted"
          :title="preview.omitted.map((item) => item.shortId).join('\n')"
        >
          超出预算、未展开：{{
            preview.omitted.map((item) => `${item.title}（${item.shortId}）`).join('、')
          }}
        </p>

        <div v-if="preview.summaries.length" class="boot-summaries">
          <SectionHeading title="会话摘要" :level="3" class="boot-sub-head">
            <template #hint>
              <Hint>对应当前模拟会话上下文的最近几条摘要；群聊与私聊摘要按会话范围隔离。</Hint>
            </template>
          </SectionHeading>
          <ul class="boot-list">
            <li
              v-for="(summary, i) in preview.summaries"
              :key="`${summary.createdAt}|${i}`"
              class="boot-summary"
            >
              <time
                class="boot-date"
                :datetime="summary.createdAt"
                :title="formatTime(summary.createdAt)"
              >
                {{ formatShort(summary.createdAt) }}
              </time>
              <span class="boot-summary-text">{{ summary.content }}</span>
            </li>
          </ul>
        </div>
      </template>

      <div class="boot-subs">
        <div v-if="preview">
          <SectionHeading title="近期更新" :level="3" class="boot-sub-head" />
          <ul v-if="preview.recent.length" class="boot-list">
            <li v-for="memory in preview.recent" :key="`${memory.circleId}:${memory.shortId}`">
              <StrataSwatch :band="entryBandOf(memory)" plain />
              <RouterLink
                v-if="memory.circleId === circleId"
                :to="entryRoute(memory.circleId, memory.shortId)"
                class="boot-uri"
                :title="memory.shortId"
              >
                {{ memory.title }}
              </RouterLink>
              <button
                v-else
                type="button"
                class="boot-uri boot-cross"
                :title="`${memory.shortId}（其他记忆圈，点击侧栏预览）`"
                @click="drawerTarget = { circleId: memory.circleId, shortId: memory.shortId }"
              >
                {{ memory.title }}
              </button>
              <span class="boot-layer">{{ memory.circleSlug ?? entryKindLabels.entry }}</span>
            </li>
          </ul>
          <p v-else class="boot-empty">暂无</p>
        </div>
        <div>
          <SectionHeading title="模拟参数" :level="3" class="boot-sub-head">
            <template #hint>
              <Hint>目录名与仓库名用于匹配项目相关记忆，也可展开模拟会话上下文与适用条件。</Hint>
            </template>
          </SectionHeading>
          <!-- 表单一直在：第一次预览失败时，这里也是重试的地方 -->
          <form class="boot-sim-form" @submit.prevent="runPreview">
            <div class="boot-project">
              <UInput v-model="project.dirName" placeholder="目录名" aria-label="目录名" />
              <UInput v-model="project.repoName" placeholder="仓库名" aria-label="仓库名" />
              <UButton type="submit" color="primary" variant="outline" :loading="running">
                预览
              </UButton>
            </div>
            <details
              class="boot-options"
              @toggle="optionsOpen = ($event.target as HTMLDetailsElement).open"
            >
              <summary>会话上下文与适用条件（可选）</summary>
              <div class="boot-options-body">
                <div class="boot-context-grid">
                  <UFormField label="聊天类型">
                    <USelect v-model="chatType" :items="chatTypeItems" class="w-full" />
                  </UFormField>
                  <UFormField v-if="usesGroup(chatType)" label="群聊或频道">
                    <USelect
                      v-model="groupSubjectId"
                      :items="groupItems"
                      :loading="groupSubjects.isFetching.value"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField v-if="usesSender(chatType)" label="发言人">
                    <USelect
                      v-model="senderSubjectId"
                      :items="senderItems"
                      :loading="senderSubjects.isFetching.value"
                      class="w-full"
                    />
                  </UFormField>
                </div>
                <UCheckbox
                  v-if="usesSender(chatType)"
                  v-model="senderIsOwner"
                  label="以所有者身份发言"
                />
                <ReadFailureNote
                  v-if="groupSubjects.isError.value"
                  :query="groupSubjects"
                  size="xs"
                />
                <ReadFailureNote
                  v-if="senderSubjects.isError.value"
                  :query="senderSubjects"
                  size="xs"
                />
                <FacetWhenPicker
                  v-model="facets"
                  :circle-id="circleId"
                  :vocabulary="vocabulary ?? undefined"
                  mode="context"
                />
              </div>
            </details>
          </form>
          <ul v-if="preview?.related.length" class="boot-list">
            <li v-for="candidate in preview.related" :key="candidate.entryId">
              <StrataSwatch :band="entryBandOf(candidate, candidate.kind)" plain />
              <RouterLink
                v-if="candidate.circleId === circleId"
                :to="entryRoute(candidate.circleId, candidate.shortId)"
                class="boot-uri"
                :title="candidate.shortId"
              >
                {{ candidate.title }}
              </RouterLink>
              <button
                v-else
                type="button"
                class="boot-uri boot-cross"
                :title="`${candidate.shortId}（其他记忆圈，点击侧栏预览）`"
                @click="drawerTarget = { circleId: candidate.circleId, shortId: candidate.shortId }"
              >
                {{ candidate.title }}
              </button>
              <span class="boot-layer">{{ entryKindLabels[candidate.kind] }}</span>
              <span class="boot-chars">{{ candidate.score.toFixed(2) }}</span>
            </li>
          </ul>
        </div>
      </div>

      <details v-if="preview" class="boot-raw">
        <summary>客户端收到的原文</summary>
        <pre>{{ preview.context }}</pre>
      </details>
    </template>

    <div class="boot-links">
      <UButton
        v-if="keyId"
        :to="{ name: 'recall', params: { circleId }, query: { key: keyId } }"
        size="sm"
        color="neutral"
        variant="outline"
      >
        召回调试
      </UButton>
      <UButton
        :to="{ name: 'bench', params: { circleId }, query: { client: clientId, key: keyId } }"
        size="sm"
        color="neutral"
        variant="outline"
      >
        在测试台打开
      </UButton>
    </div>

    <CrossCirclePreviewDrawer
      :target="drawerTarget"
      :current-circle-id="circleId"
      @close="drawerTarget = null"
      @switch-to="switchToEntry"
    />
  </section>
</template>

<style scoped>
.boot-total {
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  white-space: nowrap;
}
.boot-total.over {
  color: var(--ui-warning);
}
.boot-facets {
  margin-top: 8px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.boot-empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.note-line.boot-note {
  margin: 8px 0 0;
  border-top: 0;
}
.boot-bar {
  display: flex;
  height: 22px;
  margin-top: 12px;
  border: 1px solid var(--strata-rule);
  overflow: hidden;
}
.boot-bar i {
  display: block;
  flex: none;
  min-width: 2px;
  border-right: 1px solid var(--strata-band-line);
}
.boot-other {
  background: var(--strata-neutral);
}
.boot-list {
  margin-top: 9px;
}
.boot-list li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 0 5px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.5;
}
.boot-uri {
  display: block;
  flex: 1 1 0;
  min-width: 0;
}
.boot-cross {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.boot-uri:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.boot-id {
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.boot-layer {
  flex: none;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.boot-chars {
  flex: none;
  min-width: 44px;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  text-align: right;
}
.boot-omitted {
  margin-top: 8px;
  font-size: 14px;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.boot-summaries {
  margin-top: 17px;
}
.boot-list .boot-summary {
  align-items: baseline;
}
.boot-date {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.boot-summary-text {
  flex: 1 1 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.boot-subs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 28px;
  margin-top: 17px;
}
.boot-sub-head {
  border-color: var(--ui-border-accented);
}
.boot-sim-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 9px;
}
.boot-project {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 6px;
}
.boot-options {
  border: 1px solid var(--ui-border);
  padding: 6px 8px;
}
.boot-options summary {
  font-size: 13px;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.boot-options-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}
.boot-context-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}
.boot-raw {
  margin-top: 12px;
}
.boot-raw summary {
  font-size: 13px;
  line-height: 32px;
  cursor: pointer;
}
.boot-raw summary:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.boot-raw pre {
  max-height: 24rem;
  margin-top: 6px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border-accented);
  font-size: 14px;
  line-height: 1.75;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.boot-links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
@media (max-width: 1023.98px) {
  .boot-subs {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }
}
</style>
