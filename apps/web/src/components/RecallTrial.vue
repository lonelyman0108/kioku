<script setup lang="ts">
import type { DebugCandidate } from '@kioku/contracts'
import { useQueries, useQuery } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { TRIAL_STATE_NAMES, trialRows, trialSummary, type TrialRow } from '../advancedSettings'
import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { ownedApps } from '../benchSession'
import { useSession } from '../composables/useSession'
import { debugKeyChoices } from '../recall'
import StrataSwatch from './strata/StrataSwatch.vue'

// 试算：选一个访问密钥、填一句提示语，用召回调试取候选的分数，再按表单里的最低分与条数在本地重算，不保存。
// 召回调试只给应用所有者（会读到所有者的本人记忆），所以只列当前账号是所有者的应用的有效访问密钥
const props = defineProps<{ spaceId: string; minScore: number; limit: number }>()
const { me } = useSession()

const apps = useQuery({
  queryKey: computed(() => ['apps', props.spaceId]),
  queryFn: () => api.apps(props.spaceId),
})
const owned = computed(() => ownedApps(apps.data.value ?? [], me.data.value?.id))
// 和应用详情的访问密钥列表同一份缓存
const keyResults = useQueries({
  queries: computed(() =>
    owned.value.map((app) => ({
      queryKey: ['keys', props.spaceId, app.id] as const,
      queryFn: ({ queryKey: [, sid, id] }: { queryKey: readonly string[] }) => api.keys(sid!, id!),
    })),
  ),
})
const choices = computed(() => debugKeyChoices(owned.value, keyResults.value))
const keysPending = computed(
  () => apps.isPending.value || keyResults.value.some((result) => result.isPending),
)
const items = computed(() =>
  choices.value.options.map(({ app, key }) => ({
    label: `${app.name} · ${key.name}`,
    value: key.id,
  })),
)
const keyId = ref<string | undefined>()
watch(
  items,
  (list) => {
    if (!list.some((item) => item.value === keyId.value)) keyId.value = list[0]?.value
  },
  { immediate: true },
)
// 没有能选的访问密钥时为什么
const unavailable = computed(() => {
  if (apps.isError.value) return readFailure(apps.error.value)
  if (!owned.value.length) return '当前账号在这个空间没有应用，无法试算。'
  if (!items.value.length) {
    return choices.value.failures.length
      ? `访问密钥读取失败：${choices.value.failures[0]!.text}`
      : '当前账号的应用暂无有效访问密钥，无法试算。'
  }
  return null
})

const prompt = ref('')
const candidates = ref<DebugCandidate[] | null>(null)
const failure = ref<string | null>(null)
const running = ref(false)
let counter = 0
// 换了访问密钥或空间，之前的分数就不是这一个的了
watch([() => props.spaceId, keyId], () => {
  counter++
  candidates.value = null
  failure.value = null
  running.value = false
})

async function run() {
  const option = choices.value.options.find((o) => o.key.id === keyId.value)
  const text = prompt.value.trim()
  if (!option || !text) return
  const id = ++counter
  running.value = true
  failure.value = null
  try {
    const debug = await api.recallDebug(props.spaceId, option.app.id, option.key.id, text)
    if (id !== counter) return
    candidates.value = [...debug.injected, ...debug.others]
  } catch (err) {
    if (id !== counter) return
    failure.value = err instanceof ApiError ? err.message : '试算失败'
  } finally {
    if (id === counter) running.value = false
  }
}

const rows = computed<TrialRow[]>(() =>
  candidates.value ? trialRows(candidates.value, props.minScore, props.limit) : [],
)
const percent = (n: number) => `${Math.max(0, Math.min(1, n)) * 100}%`
</script>

<template>
  <div class="trial" aria-live="polite">
    <div class="trial-head">
      <span class="trial-title">试算</span>
      <template v-if="!keysPending && !unavailable">
        <USelect v-model="keyId" :items="items" class="w-60" aria-label="试算用的访问密钥" />
        <!-- 放在设置的表单里：回车试算，不提交外面的表单 -->
        <UInput
          v-model="prompt"
          class="w-56"
          placeholder="提示语"
          aria-label="提示语"
          @keydown.enter.prevent="run"
        />
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          :loading="running"
          :disabled="!prompt.trim()"
          @click="run"
          >试算</UButton
        >
      </template>
      <span class="gap" />
      <span v-if="candidates" class="trial-summary">{{ trialSummary(rows) }}</span>
    </div>
    <p v-if="keysPending" class="trial-note">正在读取访问密钥…</p>
    <p v-else-if="unavailable" class="trial-note">{{ unavailable }}</p>
    <p v-if="failure" class="trial-note text-error">{{ failure }}</p>
    <template v-if="candidates">
      <p v-if="!rows.length" class="trial-note">暂无候选</p>
      <div v-for="row in rows" :key="row.candidate.uri" class="cand" :class="row.state">
        <StrataSwatch :layer="row.candidate.layer" plain :width="12" :height="12" />
        <span class="cand-title" :title="row.candidate.uri">{{ row.candidate.title }}</span>
        <span class="bar" aria-hidden="true">
          <i :style="{ width: percent(row.candidate.rawScore) }" />
          <b :style="{ left: percent(minScore) }" />
        </span>
        <span class="cand-score">{{ row.candidate.score.toFixed(2) }}</span>
        <span class="cand-state">{{ TRIAL_STATE_NAMES[row.state] }}</span>
      </div>
    </template>
    <p class="trial-note">分数来自召回调试，拖动最低分与条数即时重算，不保存。</p>
  </div>
</template>

<style scoped>
.trial {
  margin: 4px 0 8px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
}
.trial-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}
.trial-title {
  font-weight: 500;
}
.gap {
  flex: 1;
}
.trial-summary {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.trial-note {
  margin-top: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.cand {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) minmax(80px, 200px) 40px 64px;
  gap: 10px;
  align-items: center;
  min-height: 30px;
  border-bottom: 1px dashed var(--ui-border);
  font-size: 13px;
}
.cand:first-of-type {
  margin-top: 8px;
}
.cand-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar {
  position: relative;
  height: 8px;
  background: var(--ui-bg-accented);
}
.bar i {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--ui-text-highlighted);
}
.bar b {
  position: absolute;
  top: -5px;
  bottom: -5px;
  border-left: 2px solid var(--ui-text-highlighted);
}
.cand-score {
  font-family: var(--font-mono);
  font-size: 12px;
  text-align: right;
}
.cand-state {
  font-size: 12px;
  text-align: right;
}
.cand.injected .cand-state {
  font-weight: 600;
}
.cand.excluded {
  color: var(--ui-text-dimmed);
}
.cand.excluded .bar i {
  background: var(--ui-border-accented);
}
@media (max-width: 767.98px) {
  .cand {
    grid-template-columns: 14px minmax(0, 1fr) 40px 64px;
  }
  .bar {
    display: none;
  }
}
</style>
