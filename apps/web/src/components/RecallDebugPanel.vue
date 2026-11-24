<script setup lang="ts">
import {
  CHAT_TYPES,
  normalizeWhen,
  type ChatType,
  type EntryKind,
  type PreviewTargets,
  type RecallDebug,
  type Sensitivity,
  type StrataBand,
} from '@kioku/contracts'
import { useQueries, useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, toRef, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ownedClients } from '../apps'
import { chatTypeLabels, usesGroup, usesSender } from '../benchForm'
import { useKeyMatrices } from '../composables/useKeyMatrices'
import { useSession } from '../composables/useSession'
import { readDenialLabels } from '../labels'
import { whenLabel } from '../memoryDetail'
import { debugKeyChoices, scoreAxis, scoreParts, type ScorePart } from '../recall'
import { entryRoute } from '../routes'
import CrossCirclePreviewDrawer from './CrossCirclePreviewDrawer.vue'
import FacetWhenPicker from './FacetWhenPicker.vue'
import Hint from './Hint.vue'
import MemoryFlags from './strata/MemoryFlags.vue'
import MemoryName from './strata/MemoryName.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataCore from './strata/StrataCore.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import { entryBand, kindBandForCircle } from './strata/strata'

// 召回调试：按一个访问密钥模拟一句话的召回。只有客户端所有者能用（会读到所有者的个人内容，记忆圈所有者也不行），
// 所以只列自己是所有者的客户端的有效访问密钥。选的是哪个访问密钥记在地址里
const props = defineProps<{ circleId: string }>()
const route = useRoute()
const router = useRouter()
const { me, circle } = useSession()

const clients = useQuery({
  queryKey: computed(() => ['clients', props.circleId]),
  queryFn: () => api.clients(props.circleId),
})
const facetsQuery = useQuery({
  queryKey: computed(() => ['facets', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
  staleTime: 60_000,
})
const vocab = computed(() => facetsQuery.data.value ?? undefined)
const owned = computed(() => ownedClients(clients.data.value ?? [], me.data.value?.id))
// 和客户端详情的访问密钥列表同一份缓存
const keyResults = useQueries({
  queries: computed(() =>
    owned.value.map((client) => ({
      queryKey: ['keys', props.circleId, client.id] as const,
      queryFn: ({ queryKey: [, cid, id] }: { queryKey: readonly string[] }) => api.keys(cid!, id!),
    })),
  ),
})
const choices = computed(() => debugKeyChoices(owned.value, keyResults.value))
const options = computed(() => choices.value.options)
// 所有客户端的访问密钥都有结果（成功或失败）才显示表单：先到的先显示的话，后到的读到后选中项会变，
// 进行中和已有的结果都被清掉；地址里的访问密钥属于慢的客户端时，这段时间还会用错密钥运行
const keysPending = computed(() => keyResults.value.some((result) => result.isPending))
// 地址里的访问密钥不在列表里（失效了、不是自己的）就用第一个
const selected = computed(
  () =>
    options.value.find((option) => option.key.id === route.query.key) ?? options.value[0] ?? null,
)
function select(keyId: string) {
  void router.replace({ query: { ...route.query, key: keyId } })
}
const { rowsOf, failureOf } = useKeyMatrices(
  toRef(props, 'circleId'),
  computed(() => options.value.map(({ client, key }) => ({ clientId: client.id, key }))),
)

const query = ref('')
const optionsOpen = ref(false)
const chatType = ref<ChatType | null>(null)
const groupSubjectId = ref<string | null>(null)
const senderSubjectId = ref<string | null>(null)
const senderIsOwner = ref(false)
const project = reactive({ dirName: '', repoName: '' })
const facets = ref<Record<string, string[]>>({})
const crossCircle = ref(true)
const failure = ref<string | null>(null)
const drawerTarget = ref<{ circleId: string; shortId: string } | null>(null)
// 每次模拟一个序号，current 是进行中的那次：结果、报错与 loading 都只认它；
// 换了访问密钥或客户端设置时清掉，进行中的那次就作废了
let counter = 0
const current = ref<number | null>(null)
const running = computed(() => current.value !== null)
const debug = ref<RecallDebug | null>(null)

const chatTypeItems = [
  { label: '无会话上下文', value: null },
  ...CHAT_TYPES.map((type) => ({ label: chatTypeLabels[type], value: type })),
]

const groupSubjects = useQuery({
  queryKey: computed(() => ['subjects', props.circleId, 'group', 'debug'] as const),
  queryFn: ({ queryKey: [, cid] }) => api.subjects(cid, { kind: 'group' }),
  enabled: computed(() => optionsOpen.value && usesGroup(chatType.value)),
})
const senderSubjects = useQuery({
  queryKey: computed(() => ['subjects', props.circleId, 'person', 'debug'] as const),
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

// 默认人格、本人私聊时读取个人内容与认人模式变了的话，之前的结果就不是现在的样子了
const settings = computed(() => {
  const client = selected.value?.client
  return client
    ? `${client.defaultPersonaId}:${client.config.elevateOwnerDirect ?? ''}:${client.config.personMemoryMode ?? ''}`
    : ''
})
watch([() => props.circleId, () => selected.value?.key.id, settings], () => {
  current.value = null
  debug.value = null
  failure.value = null
})
watch(
  () => props.circleId,
  () => {
    query.value = ''
    chatType.value = null
    groupSubjectId.value = null
    senderSubjectId.value = null
    senderIsOwner.value = false
    project.dirName = ''
    project.repoName = ''
    facets.value = {}
    crossCircle.value = true
    hovered.value = null
    drawerTarget.value = null
  },
)

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

async function run() {
  const target = selected.value
  const text = query.value.trim()
  if (running.value || !target || !text) return
  const id = ++counter
  current.value = id
  failure.value = null
  const normalizedFacets = normalizeWhen(facets.value)
  const dirName = project.dirName.trim()
  const repoName = project.repoName.trim()
  const previewTargets = buildPreviewTargets()
  try {
    const result = await api.recallDebug(props.circleId, target.client.id, target.key.id, {
      query: text,
      ...(Object.keys(normalizedFacets).length ? { facets: normalizedFacets } : {}),
      crossCircle: crossCircle.value,
      ...(dirName || repoName
        ? { project: { ...(dirName ? { dirName } : {}), ...(repoName ? { repoName } : {}) } }
        : {}),
      ...(previewTargets ? { previewTargets } : {}),
    })
    if (id === current.value) debug.value = result
  } catch (err) {
    if (id === current.value) failure.value = err instanceof ApiError ? err.message : '模拟失败'
  } finally {
    if (current.value === id) current.value = null
  }
}

const axis = computed(() =>
  debug.value
    ? scoreAxis(
        [...debug.value.injected, ...debug.value.others].map((c) => c.score),
        debug.value.minScore,
      )
    : null,
)
const widthOf = (score: number) => `${Math.max(0, score / axis.value!.max) * 100}%`

// 悬停一行时，在所选访问密钥的岩芯上标出这条记忆的位置：落在空白处就是当前访问密钥碰不到
const hovered = ref<{ band: StrataBand; sensitivity: Sensitivity | null } | null>(null)

function circleMetaOf(c: { circleId?: string; circleSlug?: string | null }) {
  const list = me.data.value?.circles ?? []
  const byId = c.circleId ? list.find((ci) => ci.id === c.circleId) : undefined
  const bySlug = !byId && c.circleSlug ? list.find((ci) => ci.slug === c.circleSlug) : undefined
  const matched = byId ?? bySlug
  const resolvedId = c.circleId ?? matched?.id
  const resolvedKind =
    matched?.kind ??
    (c.circleSlug === 'personal' ? 'personal' : c.circleSlug ? 'shared' : undefined)
  return { resolvedId, resolvedKind }
}

function bandOf(c: { kind: EntryKind; circleId?: string; circleSlug?: string | null }): StrataBand {
  const { resolvedId, resolvedKind } = circleMetaOf(c)
  return entryBand(
    {
      kind: c.kind,
      ...(resolvedId ? { circleId: resolvedId } : {}),
      ...(resolvedKind ? { circleKind: resolvedKind } : {}),
    },
    circle.value,
  )
}

function hoverBandOf(c: {
  kind: EntryKind
  circleId?: string
  circleSlug?: string | null
}): StrataBand {
  const { resolvedId, resolvedKind } = circleMetaOf(c)
  const primaryKind = circle.value?.kind ?? 'shared'
  const isPrimary = !resolvedId || resolvedId === props.circleId
  return kindBandForCircle(c.kind, {
    circleKind: isPrimary ? primaryKind : (resolvedKind ?? 'shared'),
    isPrimary,
  })
}

const hasFacets = (when: Record<string, readonly string[]> | undefined) =>
  !!when && Object.keys(normalizeWhen(when)).length > 0

function formatPartValue(part: ScorePart): string {
  if (part.label === '语境') {
    if (part.value > 0) return `+${part.value.toFixed(2)}`
    if (part.value < 0) return part.value.toFixed(2)
    return '–'
  }
  return part.value > 0 ? part.value.toFixed(2) : '–'
}

const groupName = useId()
</script>

<template>
  <section class="recall-debug">
    <SectionHeading class="debug-head">
      召回调试
      <template #hint>
        <Hint>
          按所选访问密钥的当前权限模拟一句话的召回，不计入召回记录。支持设置会话上下文、项目信息、显式适用条件与跨圈关联开关。模拟会读取客户端所有者的个人内容，只能选当前账号是所有者的客户端的访问密钥。
        </Hint>
      </template>
    </SectionHeading>

    <ReadFailureNote v-if="clients.isError.value" class="debug-note" :query="clients" />
    <!-- 一个客户端的访问密钥读取失败不挡别的 -->
    <NoteLine
      v-for="failed in choices.failures"
      :key="failed.client.id"
      class="debug-note"
      tone="error"
    >
      客户端「{{ failed.client.name }}」的访问密钥：{{ failed.text }}
    </NoteLine>
    <USkeleton v-if="clients.isPending.value || keysPending" class="mt-3 h-40 w-full" />
    <NoteLine v-else-if="clients.data.value && !owned.length" class="debug-note">
      当前账号暂无客户端，无法调试
      <template #detail>召回调试只能使用当前账号是所有者的客户端的访问密钥。</template>
      <template #actions>
        <UButton
          :to="{ name: 'clients', params: { circleId } }"
          size="sm"
          color="primary"
          variant="outline"
        >
          管理客户端
        </UButton>
      </template>
    </NoteLine>
    <NoteLine
      v-else-if="owned.length && !options.length && !choices.failures.length"
      class="debug-note"
    >
      暂无有效访问密钥。签发后可调试。
      <template #actions>
        <UButton
          :to="{ name: 'client', params: { circleId, clientId: owned[0]!.id } }"
          size="sm"
          color="primary"
          variant="outline"
        >
          签发访问密钥
        </UButton>
      </template>
    </NoteLine>
    <div v-else-if="options.length" class="debug-body">
      <form class="debug-form" @submit.prevent="run">
        <fieldset>
          <legend>访问密钥</legend>
          <label
            v-for="option in options"
            :key="option.key.id"
            class="debug-key"
            :class="{ on: selected?.key.id === option.key.id }"
          >
            <input
              type="radio"
              :name="groupName"
              :checked="selected?.key.id === option.key.id"
              @change="select(option.key.id)"
            />
            <StrataCore
              :rows="rowsOf(option.key.id)"
              :label="`${option.key.name} 无上下文时`"
              :width="34"
              :height="54"
              :mark="selected?.key.id === option.key.id ? hovered : null"
            />
            <span class="debug-key-text">
              <b>{{ option.key.name }}</b>
              <span>{{ option.client.name }}</span>
              <span v-if="failureOf(option.key.id)">
                权限范围：{{ failureOf(option.key.id) }}
              </span>
            </span>
          </label>
        </fieldset>
        <UFormField label="输入一句话">
          <UTextarea
            v-model="query"
            :rows="2"
            autoresize
            placeholder="查看当前访问密钥的召回结果"
            aria-label="模拟输入"
            class="w-full"
          />
        </UFormField>
        <UCheckbox v-model="crossCircle" label="允许跨圈关联召回" />
        <details
          class="debug-facets"
          @toggle="optionsOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>会话上下文、项目与适用条件（可选）</summary>
          <div class="debug-facets-body">
            <div class="debug-sim-grid">
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
            <ReadFailureNote v-if="groupSubjects.isError.value" :query="groupSubjects" size="xs" />
            <ReadFailureNote
              v-if="senderSubjects.isError.value"
              :query="senderSubjects"
              size="xs"
            />
            <div class="debug-project-row">
              <UInput v-model="project.dirName" placeholder="项目目录名" aria-label="项目目录名" />
              <UInput v-model="project.repoName" placeholder="项目仓库名" aria-label="项目仓库名" />
            </div>
            <FacetWhenPicker
              v-model="facets"
              :circle-id="circleId"
              :vocabulary="facetsQuery.data.value ?? undefined"
              mode="context"
            />
          </div>
        </details>
        <UButton
          type="submit"
          class="self-start"
          :loading="running"
          :disabled="!selected || !query.trim()"
          >调试</UButton
        >
      </form>

      <div class="debug-result">
        <NoteLine v-if="failure" class="debug-note" tone="error">{{ failure }}</NoteLine>
        <p v-if="!debug && !failure" class="debug-idle">输入一句话，查看当前访问密钥的召回结果</p>
        <div
          v-if="debug && axis"
          class="res"
          :style="{ '--threshold': `${axis.threshold}%` }"
          @mouseleave="hovered = null"
        >
          <div
            v-if="hasFacets(debug.resolvedFacets) || debug.flippedTerms.length"
            class="debug-resolved"
          >
            <span v-if="hasFacets(debug.resolvedFacets)" class="resolved-item">
              <b>匹配语境</b>{{ whenLabel(debug.resolvedFacets, vocab) }}
            </span>
            <span v-if="debug.flippedTerms.length" class="resolved-item">
              <b>命中别名</b>
              <span
                v-for="t in debug.flippedTerms"
                :key="`${t.dimensionKey}:${t.slug}:${t.alias}`"
                class="resolved-tag"
              >
                {{ t.dimensionKey }}:{{ t.label }} ← 「{{ t.alias }}」
              </span>
            </span>
          </div>
          <div class="ax">
            <div class="ax-left">
              <span>
                {{
                  debug.semantic ? '已使用向量检索' : '未使用向量检索（嵌入接口未配置、出错或超时）'
                }}
              </span>
            </div>
            <div class="ax-score">分数</div>
            <div class="ax-scale">
              <span class="ax-threshold" :style="{ left: `${axis.threshold}%` }">
                <b>阈值</b> <span class="ax-num">{{ debug.minScore.toFixed(2) }}</span>
              </span>
              <span
                v-for="(tick, i) in axis.ticks"
                :key="tick.value"
                class="ax-tick"
                :class="{ first: i === 0, last: i === axis.ticks.length - 1 }"
                :style="{ left: `${tick.left}%` }"
                >{{ tick.label }}</span
              >
            </div>
          </div>

          <ul>
            <li class="rg">
              <div class="rg-label">
                <b>将注入</b>
                <span class="rg-count">{{ debug.injected.length }}</span>
                <Hint>分数达到 {{ debug.minScore }} 的前几条将注入。</Hint>
              </div>
              <div class="rg-scale" />
            </li>
            <li v-if="!debug.injected.length" class="rr empty">
              <p>没有达到阈值的记忆，这一轮不注入内容。</p>
              <div class="rr-scale" />
            </li>
            <li
              v-for="c in debug.injected"
              :key="c.entryId"
              class="rr"
              @mouseenter="hovered = { band: hoverBandOf(c), sensitivity: null }"
            >
              <div class="rr-uri">
                <StrataSwatch :band="bandOf(c)" plain />
                <div class="rr-uri-text">
                  <span class="rr-uri-line">
                    <RouterLink
                      v-if="c.circleId === circleId"
                      :to="entryRoute(c.circleId, c.shortId)"
                      ><MemoryName :short-id="c.shortId" :title="c.title"
                    /></RouterLink>
                    <button
                      v-else
                      type="button"
                      class="rr-cross"
                      :title="`${c.shortId}（其他记忆圈，点击侧栏预览）`"
                      @click="drawerTarget = { circleId: c.circleId, shortId: c.shortId }"
                    >
                      <MemoryName :short-id="c.shortId" :title="c.title" />
                    </button>
                    <code class="rr-id">{{ c.shortId }}</code>
                    <MemoryFlags :band="bandOf(c)" />
                  </span>
                  <span v-if="c.cues.length" class="rr-cues">{{ c.cues.join('、') }}</span>
                  <span
                    v-if="
                      (c.circleId !== circleId && c.circleSlug) ||
                      hasFacets(c.matchedWhen) ||
                      c.otherVariantsCount > 0 ||
                      c.crossGroup
                    "
                    class="rr-tags"
                  >
                    <span v-if="c.circleId !== circleId && c.circleSlug" class="rr-tag">{{
                      c.circleSlug
                    }}</span>
                    <span v-if="hasFacets(c.matchedWhen)" class="rr-tag">{{
                      whenLabel(c.matchedWhen, vocab)
                    }}</span>
                    <span v-if="c.otherVariantsCount > 0" class="rr-tag"
                      >另有 {{ c.otherVariantsCount }} 变体</span
                    >
                    <span v-if="c.crossGroup" class="rr-tag">跨群</span>
                  </span>
                </div>
              </div>
              <div class="rr-score">{{ c.score.toFixed(2) }}</div>
              <div class="rr-scale">
                <div class="bar">
                  <div
                    class="bar-fill"
                    :style="{ width: widthOf(c.score), background: `var(--layer-${bandOf(c)})` }"
                  >
                    <template v-for="part in scoreParts(c)" :key="part.label">
                      <i
                        v-if="part.value > 0"
                        :style="{ width: `${part.share}%` }"
                        :title="`${part.label} ${formatPartValue(part)}`"
                      />
                    </template>
                  </div>
                </div>
                <span class="parts">
                  <span v-for="part in scoreParts(c)" :key="part.label">
                    {{ part.label }}
                    <b>{{ formatPartValue(part) }}</b>
                  </span>
                </span>
              </div>
            </li>

            <template v-if="debug.others.length">
              <li class="rg">
                <div class="rg-label">
                  <b>未注入</b>
                  <span class="rg-count">{{ debug.others.length }}</span>
                  <Hint>未达到阈值，或排在注入的前几条之后。</Hint>
                </div>
                <div class="rg-scale" />
              </li>
              <li
                v-for="c in debug.others"
                :key="c.entryId"
                class="rr below"
                @mouseenter="hovered = { band: hoverBandOf(c), sensitivity: null }"
              >
                <div class="rr-uri">
                  <StrataSwatch :band="bandOf(c)" plain />
                  <div class="rr-uri-text">
                    <span class="rr-uri-line">
                      <RouterLink
                        v-if="c.circleId === circleId"
                        :to="entryRoute(c.circleId, c.shortId)"
                        ><MemoryName :short-id="c.shortId" :title="c.title"
                      /></RouterLink>
                      <button
                        v-else
                        type="button"
                        class="rr-cross"
                        :title="`${c.shortId}（其他记忆圈，点击侧栏预览）`"
                        @click="drawerTarget = { circleId: c.circleId, shortId: c.shortId }"
                      >
                        <MemoryName :short-id="c.shortId" :title="c.title" />
                      </button>
                      <code class="rr-id">{{ c.shortId }}</code>
                      <MemoryFlags :band="bandOf(c)" />
                    </span>
                    <span
                      v-if="
                        (c.circleId !== circleId && c.circleSlug) ||
                        hasFacets(c.matchedWhen) ||
                        c.otherVariantsCount > 0 ||
                        c.crossGroup
                      "
                      class="rr-tags"
                    >
                      <span v-if="c.circleId !== circleId && c.circleSlug" class="rr-tag">{{
                        c.circleSlug
                      }}</span>
                      <span v-if="hasFacets(c.matchedWhen)" class="rr-tag">{{
                        whenLabel(c.matchedWhen, vocab)
                      }}</span>
                      <span v-if="c.otherVariantsCount > 0" class="rr-tag"
                        >另有 {{ c.otherVariantsCount }} 变体</span
                      >
                      <span v-if="c.crossGroup" class="rr-tag">跨群</span>
                    </span>
                  </div>
                </div>
                <div class="rr-score">{{ c.score.toFixed(2) }}</div>
                <div class="rr-scale">
                  <div class="bar">
                    <div
                      class="bar-fill"
                      :style="{ width: widthOf(c.score), background: `var(--layer-${bandOf(c)})` }"
                    >
                      <template v-for="part in scoreParts(c)" :key="part.label">
                        <i
                          v-if="part.value > 0"
                          :style="{ width: `${part.share}%` }"
                          :title="`${part.label} ${formatPartValue(part)}`"
                        />
                      </template>
                    </div>
                  </div>
                  <span class="parts">
                    <span v-for="part in scoreParts(c)" :key="part.label">
                      {{ part.label }}
                      <b>{{ formatPartValue(part) }}</b>
                    </span>
                  </span>
                </div>
              </li>
            </template>
          </ul>

          <ul v-if="debug.filtered.length" class="denied-list">
            <li class="rg">
              <div class="rg-label">
                <b>未进入当前访问密钥的召回</b>
                <span class="rg-count">{{ debug.filtered.length }}</span>
                <Hint>管理界面能搜索到，但当前访问密钥不会召回的记忆，每条后面写着原因。</Hint>
              </div>
            </li>
            <li
              v-for="f in debug.filtered"
              :key="f.shortId"
              class="rr denied"
              @mouseenter="hovered = { band: hoverBandOf(f), sensitivity: f.sensitivity }"
            >
              <div class="rr-uri">
                <StrataSwatch :band="bandOf(f)" :sensitivity="f.sensitivity" />
                <div class="rr-uri-text">
                  <span class="rr-uri-line">
                    <RouterLink
                      v-if="f.circleId === circleId"
                      :to="entryRoute(f.circleId, f.shortId)"
                      ><MemoryName :short-id="f.shortId" :title="f.title"
                    /></RouterLink>
                    <button
                      v-else
                      type="button"
                      class="rr-cross"
                      :title="`${f.shortId}（其他记忆圈，点击侧栏预览）`"
                      @click="drawerTarget = { circleId: f.circleId, shortId: f.shortId }"
                    >
                      <MemoryName :short-id="f.shortId" :title="f.title" />
                    </button>
                    <code class="rr-id">{{ f.shortId }}</code>
                    <MemoryFlags :band="bandOf(f)" :sensitivity="f.sensitivity" />
                  </span>
                  <span v-if="f.circleId !== circleId && f.circleSlug" class="rr-tags">
                    <span class="rr-tag">{{ f.circleSlug }}</span>
                  </span>
                </div>
              </div>
              <div class="rr-score">–</div>
              <div class="rr-why">{{ readDenialLabels[f.reason] }}</div>
            </li>
          </ul>

          <details v-if="debug.block" class="res-raw">
            <summary>注入内容</summary>
            <pre>{{ debug.block }}</pre>
          </details>
        </div>
      </div>
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
.debug-head {
  border-bottom-width: 2px;
}
.debug-head :deep(h2) {
  font-size: 16px;
}
.note-line.debug-note {
  margin: 10px 0 0;
  border-top: 0;
}
.debug-body {
  display: grid;
  grid-template-columns: 304px minmax(0, 1fr);
  gap: 0 32px;
  margin-top: 14px;
}
.debug-form {
  display: flex;
  flex-direction: column;
  gap: 13px;
  min-width: 0;
}
fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
legend {
  margin-bottom: 5px;
  padding: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.debug-key {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 7px 10px;
  border: 1px solid var(--ui-border-accented);
  cursor: pointer;
}
.debug-key + .debug-key {
  margin-top: -1px;
}
.debug-key:hover {
  background: var(--ui-bg-muted);
}
.debug-key input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.debug-key.on,
.debug-key.on:hover {
  --strata-frame: var(--strata-selected-frame);
  z-index: 1;
  border-color: var(--strata-selected);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.debug-key:has(input:focus-visible) {
  z-index: 2;
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: 2px;
}
.debug-key-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.debug-key-text b {
  font-weight: 500;
}
.debug-key-text span {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.debug-key.on .debug-key-text span {
  color: var(--strata-on-selected-muted);
}
.debug-facets {
  border: 1px solid var(--ui-border);
  padding: 6px 8px;
}
.debug-facets summary {
  font-size: 13px;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.debug-facets-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}
.debug-sim-grid,
.debug-project-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
.debug-resolved {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 6px 0 8px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.resolved-item {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}
.resolved-item b {
  font-weight: 500;
  color: var(--ui-text);
}
.resolved-tag {
  padding: 1px 6px;
  border: 1px solid var(--ui-border);
  font-family: var(--font-mono);
}
.rr-id {
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.rr-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.rr-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.debug-result {
  min-width: 0;
}
.debug-idle {
  padding: 22px 0;
  color: var(--ui-text-muted);
}

/* 结果：同一根数轴，阈值线从上到下穿过所有分数条 */
.ax,
.rr,
.rg {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 46px minmax(0, 1.5fr);
  column-gap: 14px;
}
.ax {
  align-items: end;
  height: 42px;
}
.ax-left {
  padding-bottom: 3px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.ax-score {
  padding-bottom: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  text-align: right;
}
.ax-scale {
  position: relative;
  height: 42px;
}
.ax-scale::after {
  content: '';
  position: absolute;
  top: 17px;
  bottom: 0;
  left: var(--threshold);
  width: 1px;
  background: var(--strata-rule);
}
.ax-tick {
  position: absolute;
  bottom: 3px;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-muted);
  transform: translateX(-50%);
}
.ax-tick.first {
  transform: none;
}
.ax-tick.last {
  transform: translateX(-100%);
}
.ax-threshold {
  position: absolute;
  top: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  transform: translateX(-50%);
}
.ax-threshold b {
  font-weight: 600;
}
.ax-num {
  font-variant-numeric: tabular-nums;
}
.rg {
  align-items: center;
  min-height: 30px;
  border-top: 1px solid var(--strata-rule);
}
.rg-label {
  grid-column: 1 / span 2;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
}
.rg-label b {
  font-weight: 600;
}
.rg-count {
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-muted);
}
.rg-scale,
.rr-scale {
  position: relative;
  align-self: stretch;
}
.rg-scale::after,
.rr-scale::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--threshold);
  width: 1px;
  background: var(--strata-rule);
}
.rr {
  align-items: center;
  min-height: 54px;
  border-top: 1px solid var(--ui-border);
}
.rr-uri {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  column-gap: 9px;
  align-items: center;
  min-width: 0;
  padding: 6px 0;
}
.rr-uri-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 14px;
  line-height: 1.5;
}
/* 归属名跟在短 ID 后面，和记忆列表一样：色块旁边要有文字。名称放不下时先缩它，短 ID 与标志不缩 */
.rr-uri-line {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}
.rr-uri-line > a,
.rr-uri-line > .rr-cross {
  min-width: 0;
}
.rr-cross {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.rr-uri-text a:hover,
.rr-uri-text .rr-cross:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.rr-cues {
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.rr-score {
  font-variant-numeric: tabular-nums;
  font-size: 16px;
  font-weight: 500;
  line-height: 1;
  text-align: right;
}
.rr-scale {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  padding: 7px 0 6px;
}
.bar {
  position: relative;
  height: 13px;
}
.bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  display: flex;
  max-width: 100%;
  box-shadow: inset 0 0 0 1px var(--strata-frame);
}
.bar-fill i {
  display: block;
  border-right: 1px solid var(--strata-frame);
}
.bar-fill i:last-child {
  border-right: 0;
}
.parts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px 10px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-muted);
}
.parts > span {
  position: relative;
  z-index: 1;
  justify-self: start;
  padding-right: 5px;
  background: var(--ui-bg);
  white-space: nowrap;
}
.parts b {
  font-variant-numeric: tabular-nums;
  font-weight: 400;
  color: var(--ui-text);
}
.rr.below .bar-fill {
  opacity: 0.55;
}
.rr.below .rr-score {
  font-weight: 400;
  color: var(--ui-text-muted);
}
.rr.empty {
  min-height: 48px;
}
.rr.empty p {
  grid-column: 1 / span 2;
  padding: 9px 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.denied-list .rg {
  grid-template-columns: minmax(0, 1fr);
}
.denied-list .rg-label {
  grid-column: 1;
}
.rr.denied {
  min-height: 38px;
}
.rr.denied .rr-score {
  font-size: 14px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.rr.denied .rr-uri-text {
  color: var(--ui-text-muted);
}
.rr-why {
  font-size: 14px;
}
.res-raw {
  margin-top: 8px;
}
.res-raw summary {
  font-size: 13px;
  line-height: 32px;
  cursor: pointer;
}
.res-raw summary:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.res-raw pre {
  margin-top: 6px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border-accented);
  font-size: 14px;
  line-height: 1.75;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 1240px) {
  .debug-body {
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
  }
}
@media (max-width: 1023.98px) {
  .ax {
    grid-template-columns: minmax(0, 1fr);
  }
  .ax-left,
  .ax-score {
    display: none;
  }
  .rg {
    grid-template-columns: minmax(0, 1fr);
  }
  .rg-label {
    grid-column: 1;
  }
  .rg-scale {
    display: none;
  }
  .rr {
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 10px;
    padding: 8px 0 4px;
  }
  .rr-uri {
    padding: 0;
  }
  .rr > .rr-scale {
    grid-column: 1 / -1;
  }
  .rr.denied > .rr-why {
    grid-column: 1 / -1;
    padding: 4px 0 6px 27px;
  }
  .rr.empty p {
    grid-column: 1 / -1;
  }
  .rr.empty > .rr-scale {
    display: none;
  }
  .parts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
