<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import RecallDebugPanel from '../components/RecallDebugPanel.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import StrataSwatch from '../components/strata/StrataSwatch.vue'
import UriPath from '../components/strata/UriPath.vue'
import { recallTotal, volumeBars } from '../recall'
import { memoryRoute } from '../routes'
import { formatRelative, formatShort, formatTime } from '../time'

const route = useRoute()
const spaceId = computed(() => String(route.params.spaceId))

const stats = useQuery({
  queryKey: computed(() => ['recall-stats', spaceId.value]),
  queryFn: () => api.recallStats(spaceId.value),
})
const data = computed(() => stats.data.value)
const bars = computed(() => volumeBars(data.value?.apps ?? []))
const total = computed(() => recallTotal(data.value?.apps ?? []))

const memoryLink = (uri: string) => memoryRoute(spaceId.value, uri)
</script>

<template>
  <div class="recall-page">
    <NoteLine v-if="stats.isError.value && !data" tone="error">
      {{ stats.error.value instanceof ApiError ? stats.error.value.message : '读取失败' }}
    </NoteLine>
    <div v-else-if="!data" class="stats">
      <USkeleton v-for="n in 4" :key="n" class="h-48 w-full" />
    </div>
    <section v-else class="stats">
      <div class="stat-total">
        <h1>召回</h1>
        <div class="total-number">{{ total.toLocaleString() }}</div>
        <p class="total-label">{{ data.retentionDays }} 天召回</p>
        <p class="total-note">
          <span>{{ formatShort(data.recordingSince) }} 开始记录，</span>
          <span class="me-1.5">明细保留 {{ data.retentionDays }} 天</span>
          <Hint>
            更早的事件只保留每条记忆的累计次数。次数仅统计当前账号有权查看的记忆；各应用的调用量仅列出当前账号可管理
            Key 的应用。
          </Hint>
        </p>
      </div>

      <div class="stat-apps">
        <SectionHeading title="应用">
          <template #hint>
            <Hint>条长按调用量的平方根，确切的次数写在旁边；条内按来路分段。</Hint>
          </template>
        </SectionHeading>
        <ul v-if="bars.length">
          <li v-for="bar in bars" :key="bar.volume.appId" class="volume">
            <p class="volume-head">
              <RouterLink
                v-if="bar.volume.name"
                :to="{ name: 'app', params: { spaceId, appId: bar.volume.appId } }"
                >{{ bar.volume.name }}</RouterLink
              >
              <span v-else class="volume-gone">已删除的应用</span>
              <span class="font-mono">{{ bar.volume.total.toLocaleString() }}</span>
            </p>
            <div class="volume-bar" :style="{ width: `${bar.width}%` }">
              <i
                v-for="segment in bar.segments"
                :key="segment.source"
                :class="`source-${segment.source.replace('.', '-')}`"
                :style="{ width: `${segment.share}%` }"
                :title="`${segment.label} ${segment.count}`"
              />
            </div>
            <p class="volume-key">
              <span v-for="segment in bar.segments" :key="segment.source">
                <i :class="`source-${segment.source.replace('.', '-')}`" />{{ segment.label }}
                <b class="font-mono">{{ segment.count.toLocaleString() }}</b>
              </span>
            </p>
          </li>
        </ul>
        <p v-else class="stat-empty">保留期内暂无召回</p>
      </div>

      <div class="stat-top">
        <SectionHeading title="常被召回" />
        <ul v-if="data.top.length">
          <li v-for="memory in data.top" :key="memory.id" class="top-row">
            <StrataSwatch :layer="memory.layer" :sensitivity="memory.sensitivity" />
            <RouterLink :to="memoryLink(memory.uri)"><UriPath :uri="memory.uri" /></RouterLink>
            <span class="font-mono top-count">{{ memory.total }}</span>
            <time
              v-if="memory.lastRecalledAt"
              class="top-when"
              :datetime="memory.lastRecalledAt"
              :title="`最近一次 ${formatTime(memory.lastRecalledAt)}`"
            >
              {{ formatRelative(memory.lastRecalledAt) }}
            </time>
            <span v-else class="top-when">–</span>
          </li>
        </ul>
        <p v-else class="stat-empty">暂无被召回的记忆</p>
      </div>

      <div class="stat-never">
        <SectionHeading>
          从未召回
          <span class="never-count font-mono">{{ data.neverTotal }}</span>
          <template #hint>
            <Hint>
              创建已满
              {{ data.retentionDays }}
              天，未被任何应用召回。最早创建的排在前面。记忆创建和开始记录召回事件都满
              {{ data.retentionDays }}
              天才计入。不含机密内容（不参与召回）和启动加载的节点（每次会话开始时注入）。长期未被召回时，可检查是否缺少关键词与触发场景、内容过于笼统或已无用处。
            </Hint>
          </template>
        </SectionHeading>
        <ul v-if="data.never.length">
          <li v-for="memory in data.never" :key="memory.id" class="never-row">
            <StrataSwatch :layer="memory.layer" :sensitivity="memory.sensitivity" />
            <RouterLink :to="memoryLink(memory.uri)"><UriPath :uri="memory.uri" /></RouterLink>
            <time
              class="never-when"
              :datetime="memory.createdAt"
              :title="formatTime(memory.createdAt)"
            >
              创建于 {{ formatShort(memory.createdAt) }}
            </time>
          </li>
        </ul>
        <p v-else class="stat-empty">暂无从未召回的记忆</p>
        <p v-if="data.neverTotal > data.never.length" class="never-more">
          仅显示最早的 {{ data.never.length }} 条
        </p>
      </div>
    </section>

    <RecallDebugPanel class="debug" :space-id="spaceId" />
  </div>
</template>

<style scoped>
.recall-page {
  --source-1: var(--ui-text-highlighted);
  --source-2: color-mix(in srgb, var(--ui-text-highlighted) 52%, var(--ui-bg));
  --source-3: color-mix(in srgb, var(--ui-text-highlighted) 24%, var(--ui-bg));
  --source-4: color-mix(in srgb, var(--ui-text-highlighted) 72%, var(--ui-bg));
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 22px 32px 56px;
}
.stats {
  display: grid;
  grid-template-columns: 172px minmax(0, 1.05fr) minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 0 32px;
}
.stat-total h1 {
  margin-bottom: 9px;
  font-size: 28px;
  font-weight: 500;
  line-height: 1.3;
}
.total-number {
  font-family: var(--font-mono);
  font-size: 38px;
  font-weight: 300;
  line-height: 1.2;
}
.total-label {
  font-size: 14px;
  line-height: 1.6;
}
.total-note {
  margin-top: 5px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--ui-text-muted);
}
.total-note span {
  display: inline-block;
}
.stat-empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.volume {
  padding: 7px 0;
  border-bottom: 1px solid var(--ui-border);
}
.volume-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 14px;
  line-height: 1.45;
}
.volume-head a {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.volume-head a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.volume-gone {
  color: var(--ui-text-muted);
}
.volume-bar {
  display: flex;
  height: 6px;
  margin: 3px 0;
}
.volume-bar i {
  display: block;
  min-width: 2px;
  border-right: 1px solid var(--ui-bg);
}
.volume-bar i:last-child {
  border-right: 0;
}
.volume-key {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.volume-key > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.volume-key i {
  display: block;
  width: 7px;
  height: 7px;
}
.volume-key b {
  font-weight: 400;
}
.source-prompt-submit {
  background: var(--source-1);
}
.source-session-start {
  background: var(--source-2);
}
.source-mcp-search {
  background: var(--source-3);
}
.source-rest-recall {
  background: var(--source-4);
}
.top-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 30px 66px;
  column-gap: 8px;
  align-items: center;
  padding: 5px 0 4px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.5;
}
.top-row a,
.never-row a {
  min-width: 0;
}
.top-row a:hover,
.never-row a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.top-count {
  font-size: 13px;
  text-align: right;
}
.top-when {
  font-size: 12px;
  color: var(--ui-text-muted);
  text-align: right;
  white-space: nowrap;
}
.never-count {
  font-size: 13px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.never-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  column-gap: 8px;
  align-items: center;
  padding: 6px 0 5px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.5;
}
.never-when {
  grid-column: 2;
  line-height: 1.45;
  color: var(--ui-text-muted);
}
.never-more {
  margin-top: 8px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.debug {
  margin-top: 20px;
}
@media (max-width: 1240px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px 28px;
  }
}
@media (max-width: 1023.98px) {
  .recall-page {
    padding: 12px 16px 40px;
  }
  .stats {
    grid-template-columns: minmax(0, 1fr);
  }
  .top-row {
    grid-template-columns: 18px minmax(0, 1fr) auto auto;
  }
}
</style>
