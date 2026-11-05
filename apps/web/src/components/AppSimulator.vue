<script setup lang="ts">
import type { BootPreview } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { bootUsage, simulatorState } from '../apps'
import { layerShortLabels } from '../labels'
import { memoryRoute } from '../routes'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import UriPath from './strata/UriPath.vue'

// 启动加载预览：按应用的一个 Key 模拟会话开始，只给应用所有者（会读到所有者的私人层）。
// keyId 是左边选中的 Key，没有有效 Key 时没有。
// settings 是会影响模拟结果的应用设置（默认人格、本人私聊时读取画像）拼成的串：变了的话，之前的结果就不是现在的样子了
const props = defineProps<{
  spaceId: string
  appId: string
  keyId: string | undefined
  settings: string
}>()

// 和左边的 Key 列表同一份缓存：没有选中的 Key 时，靠它分清是还在读、读取失败，还是真的没有有效 Key。
// 这里只说读不到的情况：读到过又刷新失败时，左边的列表已经说了
const keys = useQuery({
  queryKey: computed(() => ['keys', props.spaceId, props.appId] as const),
  queryFn: ({ queryKey: [, sid, aid] }) => api.keys(sid, aid),
})
const state = computed(() =>
  simulatorState(
    { isPending: keys.isPending.value, hasData: Boolean(keys.data.value) },
    props.keyId,
  ),
)

const failure = ref<string | null>(null)
// 每次模拟一个序号，current 是进行中的那次：结果、报错与 loading 都只认它；
// 换了应用、Key 或应用设置时清掉，进行中的那次就作废了
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
      api.bootPreview(props.spaceId, props.appId, id, {
        ...(dirName || repoName
          ? { project: { ...(dirName ? { dirName } : {}), ...(repoName ? { repoName } : {}) } }
          : {}),
      }),
    (result) => (preview.value = result),
  )
}

// 换了应用、Key 或应用设置时清掉上一次的结果（它们属于别的 Key，或是改之前的样子），按新的重新模拟。
// 模拟不写库，也不计入召回记录
watch(
  [() => props.spaceId, () => props.appId, () => props.keyId, () => props.settings],
  () => {
    current.value = null
    preview.value = null
    failure.value = null
    void runPreview()
  },
  { immediate: true },
)

const usage = computed(() => (preview.value ? bootUsage(preview.value) : null))
const memoryLink = (uri: string) => memoryRoute(props.spaceId, uri)
const droppedLabels = { recent: '近期更新的记忆', related: '与当前项目相关的记忆' }
</script>

<template>
  <section class="boot">
    <SectionHeading title="启动加载">
      <template #hint>
        <Hint>
          按所选 Key
          的当前权限模拟会话开始时注入的内容，不计入召回记录。会话上下文（私聊、群聊）暂不可选，当前按无上下文模拟。
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
    <p v-else-if="state === 'none'" class="boot-empty">暂无有效 Key。签发后可模拟。</p>
    <template v-else>
      <NoteLine v-if="failure" class="boot-note" tone="error">{{ failure }}</NoteLine>
      <USkeleton v-if="running && !preview" class="mt-3 h-40 w-full" />
      <template v-if="preview && usage">
        <div
          class="boot-bar"
          role="img"
          :aria-label="`已用 ${usage.used} 字${usage.limit ? `，上限 ${usage.limit} 字` : ''}`"
        >
          <i
            v-for="segment in usage.segments"
            :key="segment.uri"
            :style="{ width: `${segment.width}%`, background: `var(--layer-${segment.layer})` }"
            :title="`${segment.uri}：${segment.chars} 字`"
          />
          <i
            v-if="usage.other > 0"
            class="boot-other"
            :style="{ width: `${usage.other}%` }"
            title="标题、近期更新与相关记忆"
          />
        </div>
        <NoteLine v-if="preview.dropped.length" class="boot-note" tone="warning">
          超出客户端接收上限，未附加：{{ preview.dropped.map((d) => droppedLabels[d]).join('、') }}
        </NoteLine>

        <ul v-if="preview.entries.length" class="boot-list">
          <li v-for="entry in preview.entries" :key="entry.uri">
            <StrataSwatch :layer="entry.layer" plain />
            <RouterLink :to="memoryLink(entry.uri)" class="boot-uri">
              <UriPath :uri="entry.uri" />
            </RouterLink>
            <span class="boot-layer">{{ layerShortLabels[entry.layer] }}</span>
            <span class="boot-chars">{{ entry.chars.toLocaleString() }}</span>
          </li>
        </ul>
        <p v-else class="boot-empty">暂无启动加载的节点</p>
        <p v-if="preview.omitted.length" class="boot-omitted">
          超出预算、未展开：<span class="font-mono">{{ preview.omitted.join('、') }}</span>
        </p>
      </template>

      <div class="boot-subs">
        <div v-if="preview">
          <SectionHeading title="近期更新" :level="3" class="boot-sub-head" />
          <ul v-if="preview.recent.length" class="boot-list">
            <li v-for="memory in preview.recent" :key="memory.uri">
              <RouterLink :to="memoryLink(memory.uri)" class="boot-uri">
                <UriPath :uri="memory.uri" />
              </RouterLink>
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
            <li v-for="candidate in preview.related" :key="candidate.uri">
              <StrataSwatch :layer="candidate.layer" plain />
              <RouterLink :to="memoryLink(candidate.uri)" class="boot-uri">
                <UriPath :uri="candidate.uri" />
              </RouterLink>
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
        :to="{ name: 'recall', params: { spaceId }, query: { key: keyId } }"
        size="sm"
        color="neutral"
        variant="outline"
      >
        召回调试
      </UButton>
      <UButton
        :to="{ name: 'bench', params: { spaceId }, query: { app: appId, key: keyId } }"
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
