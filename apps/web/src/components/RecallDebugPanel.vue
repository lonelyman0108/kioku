<script setup lang="ts">
import type { Layer, RecallDebug, Sensitivity } from '@kioku/contracts'
import { useQueries, useQuery } from '@tanstack/vue-query'
import { computed, ref, toRef, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { ownedApps } from '../benchSession'
import { useKeyMatrices } from '../composables/useKeyMatrices'
import { useSession } from '../composables/useSession'
import { readDenialLabels } from '../labels'
import { debugKeyChoices, scoreAxis, scoreParts } from '../recall'
import { memoryRoute } from '../routes'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataCore from './strata/StrataCore.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import UriPath from './strata/UriPath.vue'

// 召回调试：按一个 Key 模拟一句话的召回。只有应用所有者能用（会读到所有者的私人层，空间所有者也不行），
// 所以只列自己是所有者的应用的有效 Key，和服务端的 keyToSimulate 一个规则。选的是哪个 Key 记在地址里
const props = defineProps<{ spaceId: string }>()
const route = useRoute()
const router = useRouter()
const { me } = useSession()

const apps = useQuery({
  queryKey: computed(() => ['apps', props.spaceId]),
  queryFn: () => api.apps(props.spaceId),
})
const owned = computed(() => ownedApps(apps.data.value ?? [], me.data.value?.id))
// 和应用详情的 Key 列表同一份缓存
const keyResults = useQueries({
  queries: computed(() =>
    owned.value.map((app) => ({
      queryKey: ['keys', props.spaceId, app.id] as const,
      queryFn: ({ queryKey: [, sid, id] }: { queryKey: readonly string[] }) => api.keys(sid!, id!),
    })),
  ),
})
const choices = computed(() => debugKeyChoices(owned.value, keyResults.value))
const options = computed(() => choices.value.options)
const keysPending = computed(() => keyResults.value.some((result) => result.isPending))
// 地址里的 Key 不在列表里（失效了、不是自己的）就用第一个
const selected = computed(
  () =>
    options.value.find((option) => option.key.id === route.query.key) ?? options.value[0] ?? null,
)
function select(keyId: string) {
  void router.replace({ query: { ...route.query, key: keyId } })
}
const { rowsOf, failureOf } = useKeyMatrices(
  toRef(props, 'spaceId'),
  computed(() => options.value.map(({ app, key }) => ({ appId: app.id, key }))),
)

const query = ref('')
const failure = ref<string | null>(null)
// 每次模拟一个序号，current 是进行中的那次：结果、报错与 loading 都只认它；
// 换了 Key 或应用设置时清掉，进行中的那次就作废了
let counter = 0
const current = ref<number | null>(null)
const running = computed(() => current.value !== null)
const debug = ref<RecallDebug | null>(null)

// 默认人格、本人私聊时读取画像变了的话，之前的结果就不是现在的样子了
const settings = computed(() => {
  const app = selected.value?.app
  return app ? `${app.defaultPersonaId}:${app.config.elevateOwnerDirect ?? ''}` : ''
})
watch([() => props.spaceId, () => selected.value?.key.id, settings], () => {
  current.value = null
  debug.value = null
  failure.value = null
})

async function run() {
  const target = selected.value
  const text = query.value.trim()
  if (running.value || !target || !text) return
  const id = ++counter
  current.value = id
  failure.value = null
  try {
    const result = await api.recallDebug(props.spaceId, target.app.id, target.key.id, text)
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
const widthOf = (score: number) => `${(score / axis.value!.max) * 100}%`

// 悬停一行时，在所选 Key 的岩芯上标出这条记忆的位置：落在空白处就是当前 Key 碰不到
const hovered = ref<{ layer: Layer; sensitivity: Sensitivity | null } | null>(null)

const memoryLink = (uri: string) => memoryRoute(props.spaceId, uri)
const groupName = useId()
</script>

<template>
  <section class="recall-debug">
    <SectionHeading class="debug-head">
      召回调试
      <template #hint>
        <Hint>
          按所选 Key
          的当前权限模拟一句话的召回，不计入召回记录。会话上下文（私聊、群聊）暂不可选，当前按无上下文模拟。模拟会读取应用所有者的私人层，只能选当前账号是所有者的应用的
          Key。
        </Hint>
      </template>
    </SectionHeading>

    <NoteLine v-if="apps.isError.value" class="debug-note" tone="error">
      {{ readFailure(apps.error.value) }}
    </NoteLine>
    <!-- 一个应用的 Key 读取失败不挡别的应用 -->
    <NoteLine
      v-for="failed in choices.failures"
      :key="failed.app.id"
      class="debug-note"
      tone="error"
    >
      应用「{{ failed.app.name }}」的 Key：{{ failed.text }}
    </NoteLine>
    <USkeleton
      v-if="apps.isPending.value || (keysPending && !options.length)"
      class="mt-3 h-40 w-full"
    />
    <NoteLine v-else-if="apps.data.value && !owned.length" class="debug-note">
      当前账号暂无应用，无法调试
      <template #detail>召回调试只能使用当前账号是所有者的应用的 Key。</template>
      <template #actions>
        <UButton
          :to="{ name: 'apps', params: { spaceId } }"
          size="sm"
          color="primary"
          variant="outline"
        >
          管理应用
        </UButton>
      </template>
    </NoteLine>
    <NoteLine
      v-else-if="owned.length && !options.length && !choices.failures.length"
      class="debug-note"
    >
      暂无有效 Key。签发后可调试。
      <template #actions>
        <UButton
          :to="{ name: 'app', params: { spaceId, appId: owned[0]!.id } }"
          size="sm"
          color="primary"
          variant="outline"
        >
          签发 Key
        </UButton>
      </template>
    </NoteLine>
    <div v-else-if="options.length" class="debug-body">
      <form class="debug-form" @submit.prevent="run">
        <fieldset>
          <legend>Key</legend>
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
              <span>{{ option.app.name }}</span>
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
            placeholder="查看当前 Key 的召回结果"
            aria-label="模拟输入"
            class="w-full"
          />
        </UFormField>
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
        <p v-if="!debug && !failure" class="debug-idle">输入一句话，查看当前 Key 的召回结果</p>
        <div
          v-if="debug && axis"
          class="res"
          :style="{ '--threshold': `${axis.threshold}%` }"
          @mouseleave="hovered = null"
        >
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
                <b>阈值</b> <span class="font-mono">{{ debug.minScore.toFixed(2) }}</span>
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
                <span class="font-mono">{{ debug.injected.length }}</span>
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
              :key="c.uri"
              class="rr"
              @mouseenter="hovered = { layer: c.layer, sensitivity: null }"
            >
              <div class="rr-uri">
                <StrataSwatch :layer="c.layer" plain />
                <div class="rr-uri-text">
                  <RouterLink :to="memoryLink(c.uri)"><UriPath :uri="c.uri" /></RouterLink>
                  <span v-if="c.cues.length" class="rr-cues">{{ c.cues.join('、') }}</span>
                </div>
              </div>
              <div class="rr-score">{{ c.score.toFixed(2) }}</div>
              <div class="rr-scale">
                <div class="bar">
                  <div
                    class="bar-fill"
                    :style="{ width: widthOf(c.score), background: `var(--layer-${c.layer})` }"
                  >
                    <template v-for="part in scoreParts(c)" :key="part.label">
                      <i
                        v-if="part.value > 0"
                        :style="{ width: `${part.share}%` }"
                        :title="`${part.label} ${part.value.toFixed(2)}`"
                      />
                    </template>
                  </div>
                </div>
                <span class="parts">
                  <span v-for="part in scoreParts(c)" :key="part.label">
                    {{ part.label }}
                    <b>{{ part.value > 0 ? part.value.toFixed(2) : '–' }}</b>
                  </span>
                </span>
              </div>
            </li>

            <template v-if="debug.others.length">
              <li class="rg">
                <div class="rg-label">
                  <b>未注入</b>
                  <span class="font-mono">{{ debug.others.length }}</span>
                  <Hint>未达到阈值，或排在注入的前几条之后。</Hint>
                </div>
                <div class="rg-scale" />
              </li>
              <li
                v-for="c in debug.others"
                :key="c.uri"
                class="rr below"
                @mouseenter="hovered = { layer: c.layer, sensitivity: null }"
              >
                <div class="rr-uri">
                  <StrataSwatch :layer="c.layer" plain />
                  <div class="rr-uri-text">
                    <RouterLink :to="memoryLink(c.uri)"><UriPath :uri="c.uri" /></RouterLink>
                  </div>
                </div>
                <div class="rr-score">{{ c.score.toFixed(2) }}</div>
                <div class="rr-scale">
                  <div class="bar">
                    <div
                      class="bar-fill"
                      :style="{ width: widthOf(c.score), background: `var(--layer-${c.layer})` }"
                    >
                      <template v-for="part in scoreParts(c)" :key="part.label">
                        <i
                          v-if="part.value > 0"
                          :style="{ width: `${part.share}%` }"
                          :title="`${part.label} ${part.value.toFixed(2)}`"
                        />
                      </template>
                    </div>
                  </div>
                  <span class="parts">
                    <span v-for="part in scoreParts(c)" :key="part.label">
                      {{ part.label }}
                      <b>{{ part.value > 0 ? part.value.toFixed(2) : '–' }}</b>
                    </span>
                  </span>
                </div>
              </li>
            </template>
          </ul>

          <ul v-if="debug.filtered.length" class="denied-list">
            <li class="rg">
              <div class="rg-label">
                <b>未进入当前 Key 的召回</b>
                <span class="font-mono">{{ debug.filtered.length }}</span>
                <Hint>管理界面能搜索到，但当前 Key 不会召回的记忆，每条后面写着原因。</Hint>
              </div>
            </li>
            <li
              v-for="f in debug.filtered"
              :key="f.uri"
              class="rr denied"
              @mouseenter="hovered = { layer: f.layer, sensitivity: f.sensitivity }"
            >
              <div class="rr-uri">
                <StrataSwatch :layer="f.layer" :sensitivity="f.sensitivity" />
                <div class="rr-uri-text">
                  <RouterLink :to="memoryLink(f.uri)"><UriPath :uri="f.uri" /></RouterLink>
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
  font-family: var(--font-mono);
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
.rg-label .font-mono {
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
.rr-uri-text a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.rr-cues {
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.rr-score {
  font-family: var(--font-mono);
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0 10px;
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
  font-family: var(--font-mono);
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
