<script setup lang="ts">
import type { BootPreview, EntryKind, FacetVocabularyView } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { bootUsage, simulatorState } from '../apps'
import { useSession } from '../composables/useSession'
import { entryKindLabels, sessionExtraLabels } from '../labels'
import { whenLabel } from '../memoryDetail'
import { formatShort, formatTime } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import { entryBand } from './strata/strata'

// 启动加载预览：按接入实例的一个访问密钥模拟会话开始，只给接入实例所有者
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
const preview = ref<BootPreview | null>(null)

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
  return run(
    () =>
      api.bootPreview(props.circleId, props.clientId, id, {
        ...(dirName || repoName
          ? { project: { ...(dirName ? { dirName } : {}), ...(repoName ? { repoName } : {}) } }
          : {}),
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
const entryLink = (targetCircleId: string, shortId: string) => ({
  name: 'memories',
  params: { circleId: targetCircleId },
  query: { id: shortId },
})
</script>

<template>
  <section class="boot">
    <SectionHeading title="启动加载">
      <template #hint>
        <Hint>
          按所选访问密钥的当前权限与固定切面透镜模拟会话开始时注入的内容，不计入召回记录。当前按无会话上下文模拟。
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
        <p v-if="resolvedFacetsText" class="boot-facets">展开切面：{{ resolvedFacetsText }}</p>
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
              :to="entryLink(entry.circleId, entry.shortId)"
              class="boot-uri"
              :title="entry.shortId"
            >
              {{ entry.title }}
            </RouterLink>
            <span class="boot-layer">{{ entry.circleSlug ?? entryKindLabels.entry }}</span>
            <span class="boot-chars">{{ entry.chars.toLocaleString() }}</span>
          </li>
        </ul>
        <p v-else class="boot-empty">暂无启动加载的词条</p>
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
              <Hint>不带会话上下文的会话最近几条摘要；群聊、私聊的摘要不进入启动加载。</Hint>
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
            <li v-for="memory in preview.recent" :key="memory.shortId">
              <RouterLink
                :to="entryLink(circleId, memory.shortId)"
                class="boot-uri"
                :title="memory.shortId"
              >
                {{ memory.title }}
              </RouterLink>
              <span v-if="memory.circleSlug" class="boot-layer">{{ memory.circleSlug }}</span>
            </li>
          </ul>
          <p v-else class="boot-empty">暂无</p>
        </div>
        <div>
          <SectionHeading title="与当前项目相关" :level="3" class="boot-sub-head">
            <template #hint>
              <Hint>目录名与仓库名用于召回与当前项目相关的记忆，可留空。</Hint>
            </template>
          </SectionHeading>
          <!-- 表单一直在：第一次预览失败时，这里也是重试的地方 -->
          <form class="boot-project" @submit.prevent="runPreview">
            <UInput v-model="project.dirName" placeholder="目录名" aria-label="目录名" />
            <UInput v-model="project.repoName" placeholder="仓库名" aria-label="仓库名" />
            <UButton type="submit" color="primary" variant="outline" :loading="running">
              预览
            </UButton>
          </form>
          <ul v-if="preview?.related.length" class="boot-list">
            <li v-for="candidate in preview.related" :key="candidate.entryId">
              <StrataSwatch :band="entryBandOf(candidate, candidate.kind)" plain />
              <RouterLink
                :to="entryLink(candidate.circleId, candidate.shortId)"
                class="boot-uri"
                :title="candidate.shortId"
              >
                {{ candidate.title }}
              </RouterLink>
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
  </section>
</template>

<style scoped>
.boot-total {
  font-family: var(--font-mono);
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
  font-family: var(--font-mono);
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
  font-family: var(--font-mono);
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
.boot-project {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 6px;
  margin-top: 9px;
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
