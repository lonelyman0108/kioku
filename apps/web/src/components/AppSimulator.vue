<script setup lang="ts">
import type { BootPreview, DebugCandidate, RecallDebug } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { layerShortLabels, readDenialLabels, sensitivityLabels } from '../labels'

// 启动预览与召回调试台：按应用的一把 Key 模拟，只给应用主人（会读到主人的私人层）
const props = defineProps<{ spaceId: string; appId: string }>()

const keys = useQuery({
  queryKey: computed(() => ['keys', props.spaceId, props.appId]),
  queryFn: () => api.keys(props.spaceId, props.appId),
})
// 只能模拟还有效的 Key
const keyItems = computed(() =>
  (keys.data.value ?? [])
    .filter((k) => k.effectiveScopes)
    .map((k) => ({ label: `${k.name}（${k.prefix}）`, value: k.id })),
)
const keyId = ref<string | undefined>()
watch(
  keyItems,
  (items) => {
    if (!items.some((i) => i.value === keyId.value)) keyId.value = items[0]?.value
  },
  { immediate: true },
)

const tab = ref<'preview' | 'debug'>('preview')
const tabs = [
  { label: '启动预览', value: 'preview', icon: icons.preview },
  { label: '召回调试', value: 'debug', icon: icons.debug },
]

const failure = ref<string | null>(null)
const running = ref(false)
const project = reactive({ dirName: '', repoName: '' })
const preview = ref<BootPreview | null>(null)
const query = ref('')
const debug = ref<RecallDebug | null>(null)

// 换了应用或 Key 时清掉上一次的结果：它们属于别的 Key
watch([() => props.spaceId, () => props.appId, keyId], () => {
  preview.value = null
  debug.value = null
  failure.value = null
})

// 请求期间换了 Key 或应用，结果不写回来
async function run<T>(call: () => Promise<T>, apply: (result: T) => void) {
  if (running.value || !keyId.value) return
  running.value = true
  failure.value = null
  const context = [props.spaceId, props.appId, keyId.value].join('/')
  try {
    const result = await call()
    if (context === [props.spaceId, props.appId, keyId.value].join('/')) apply(result)
  } catch (err) {
    failure.value = err instanceof ApiError ? err.message : '模拟失败'
  } finally {
    running.value = false
  }
}

function runPreview() {
  const id = keyId.value!
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

function runDebug() {
  const id = keyId.value!
  const text = query.value.trim()
  if (!text) return
  return run(
    () => api.recallDebug(props.spaceId, props.appId, id, text),
    (result) => (debug.value = result),
  )
}

const memoryLink = (uri: string) => ({
  name: 'memories',
  params: { spaceId: props.spaceId },
  query: { uri },
})
const parts = (c: DebugCandidate) =>
  [
    ['向量', c.breakdown.semantic],
    ['全文', c.breakdown.fulltext],
    ['关键词', c.breakdown.glossary],
    ['priority', c.breakdown.priority],
  ]
    .filter(([, value]) => Number(value) > 0)
    .map(([label, value]) => `${label} ${Number(value).toFixed(2)}`)
    .join(' + ')
const droppedLabels = { recent: '近期更新的记忆', related: '与当前项目相关的记忆' }
</script>

<template>
  <div class="space-y-4 text-sm">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="font-medium">启动预览与召回调试</h2>
      <USelect
        v-model="keyId"
        :items="keyItems"
        placeholder="选择一把 Key"
        aria-label="模拟用的 Key"
        class="ml-auto min-w-56"
      />
    </div>
    <p v-if="keys.isSuccess.value && !keyItems.length" class="text-muted">
      这个应用还没有有效的 Key，先签发一把再模拟。
    </p>
    <template v-else>
      <p class="text-xs text-muted">
        按所选 Key
        现在的有效上限模拟，不记召回事件。会话上下文（私聊、群聊）接入之后才能选，现在按无上下文模拟。
      </p>
      <UTabs v-model="tab" :items="tabs" :content="false" size="sm" class="w-full" />
      <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />

      <div v-if="tab === 'preview'" class="space-y-4">
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="runPreview">
          <UFormField label="目录名">
            <UInput v-model="project.dirName" placeholder="例如 kioku" />
          </UFormField>
          <UFormField label="仓库名">
            <UInput v-model="project.repoName" />
          </UFormField>
          <UButton type="submit" :icon="icons.preview" :loading="running" :disabled="!keyId"
            >预览</UButton
          >
        </form>
        <p class="text-xs text-muted">目录名与仓库名用来召回与当前项目相关的记忆，可以不填。</p>
        <template v-if="preview">
          <p>
            共 {{ preview.context.length }} 字<template v-if="preview.limit">
              ，宿主（{{ preview.runtimeFamily }}）能完整接收 {{ preview.limit }} 字</template
            >。
          </p>
          <UAlert
            v-if="preview.dropped.length"
            color="warning"
            variant="subtle"
            :title="`放不下，没有附上：${preview.dropped.map((d) => droppedLabels[d]).join('、')}`"
          />
          <section class="space-y-1">
            <h3 class="font-medium">启动节点</h3>
            <ul v-if="preview.entries.length" class="divide-y divide-default">
              <li
                v-for="entry in preview.entries"
                :key="entry.uri"
                class="flex items-center gap-2 py-1.5"
              >
                <UBadge size="sm" variant="subtle" color="neutral">{{
                  layerShortLabels[entry.layer]
                }}</UBadge>
                <RouterLink :to="memoryLink(entry.uri)" class="font-mono text-xs hover:underline">{{
                  entry.uri
                }}</RouterLink>
                <span class="ml-auto text-xs text-muted">{{ entry.chars }} 字</span>
              </li>
            </ul>
            <p v-else class="text-muted">没有启动节点。</p>
            <p v-if="preview.omitted.length" class="text-xs text-muted">
              超出预算、只列出 URI 的：{{ preview.omitted.join('、') }}
            </p>
          </section>
          <section v-if="preview.recent.length" class="space-y-1">
            <h3 class="font-medium">近期更新的记忆</h3>
            <p class="font-mono text-xs">{{ preview.recent.map((m) => m.uri).join('、') }}</p>
          </section>
          <section v-if="preview.related.length" class="space-y-1">
            <h3 class="font-medium">与当前项目相关的记忆</h3>
            <p class="font-mono text-xs">
              {{ preview.related.map((c) => `${c.score.toFixed(2)} ${c.uri}`).join('、') }}
            </p>
          </section>
          <details>
            <summary class="cursor-pointer text-muted">宿主收到的原文</summary>
            <pre
              class="mt-2 max-h-96 overflow-auto rounded bg-elevated p-3 text-xs whitespace-pre-wrap"
              >{{ preview.context }}</pre>
          </details>
        </template>
      </div>

      <div v-else class="space-y-4">
        <form class="space-y-2" @submit.prevent="runDebug">
          <UTextarea
            v-model="query"
            :rows="2"
            autoresize
            placeholder="输入一句话，看这把 Key 会召回什么"
            aria-label="模拟的输入"
            class="w-full"
          />
          <UButton
            type="submit"
            :icon="icons.debug"
            :loading="running"
            :disabled="!keyId || !query.trim()"
            >调试</UButton
          >
        </form>
        <template v-if="debug">
          <p class="text-xs text-muted">
            {{ debug.semantic ? '走了向量这一路' : '没走向量（嵌入接口没配、出错或超时）' }}；分数过
            {{ debug.minScore }} 的前几条会注入。
          </p>
          <section class="space-y-1">
            <h3 class="font-medium">会注入的</h3>
            <ul v-if="debug.injected.length" class="divide-y divide-default">
              <li v-for="c in debug.injected" :key="c.uri" class="space-y-0.5 py-1.5">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-xs">{{ c.score.toFixed(2) }}</span>
                  <RouterLink :to="memoryLink(c.uri)" class="font-mono text-xs hover:underline">{{
                    c.uri
                  }}</RouterLink>
                  <span v-if="c.cues.length" class="text-xs text-muted">{{
                    c.cues.join('、')
                  }}</span>
                </div>
                <p class="text-xs text-muted">{{ parts(c) }}</p>
              </li>
            </ul>
            <p v-else class="text-muted">没有过阈值的记忆，这一轮不会注入召回块。</p>
          </section>
          <details v-if="debug.others.length">
            <summary class="cursor-pointer font-medium">
              没注入的（{{ debug.others.length }}）
            </summary>
            <ul class="mt-1 divide-y divide-default">
              <li v-for="c in debug.others" :key="c.uri" class="space-y-0.5 py-1.5">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-xs">{{ c.score.toFixed(2) }}</span>
                  <RouterLink :to="memoryLink(c.uri)" class="font-mono text-xs hover:underline">{{
                    c.uri
                  }}</RouterLink>
                </div>
                <p class="text-xs text-muted">{{ parts(c) }}</p>
              </li>
            </ul>
          </details>
          <section v-if="debug.filtered.length" class="space-y-1">
            <h3 class="font-medium">管理界面搜得到、这把 Key 读不到的</h3>
            <ul class="divide-y divide-default">
              <li
                v-for="f in debug.filtered"
                :key="f.uri"
                class="flex flex-wrap items-center gap-2 py-1.5"
              >
                <RouterLink :to="memoryLink(f.uri)" class="font-mono text-xs hover:underline">{{
                  f.uri
                }}</RouterLink>
                <UBadge size="sm" variant="subtle" color="neutral">{{
                  `${layerShortLabels[f.layer]} · ${sensitivityLabels[f.sensitivity]}`
                }}</UBadge>
                <span class="text-xs text-muted">{{ readDenialLabels[f.reason] }}</span>
              </li>
            </ul>
          </section>
          <details v-if="debug.block">
            <summary class="cursor-pointer text-muted">注入的召回块</summary>
            <pre class="mt-2 overflow-auto rounded bg-elevated p-3 text-xs whitespace-pre-wrap">{{
              debug.block
            }}</pre>
          </details>
        </template>
      </div>
    </template>
  </div>
</template>
