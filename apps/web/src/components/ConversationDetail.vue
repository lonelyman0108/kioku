<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { retryable } from '../api/client'
import { api } from '../api/endpoints'
import { conversationKindLabels, conversationTitle, runCounts } from '../conversations'
import { provenanceLabels } from '../labels'
import { formatRelative, formatShort, formatTime } from '../time'
import Hint from './Hint.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataStrip from './strata/StrataStrip.vue'
import StrataSwatch from './strata/StrataSwatch.vue'

// 会话详情：会话摘要的时间线、在这里记下的事实、抽取记录，都是新的在前。
// 事实挂在各自的联系人上，删、确认都去联系人详情或待处理
const props = defineProps<{ spaceId: string; id: string }>()

const detail = useQuery({
  queryKey: computed(() => ['conversation', props.spaceId, props.id] as const),
  queryFn: ({ queryKey: [, spaceId, id] }) => api.conversation(spaceId, id),
})
const data = computed(() =>
  detail.data.value && detail.data.value.id === props.id ? detail.data.value : null,
)

// 窄屏上打开一个会话之后，页面把焦点放到这里
const titleEl = ref<HTMLElement | null>(null)
defineExpose({ focusTitle: () => titleEl.value?.focus() })
</script>

<template>
  <article class="conversation-detail">
    <div v-if="detail.isPending.value" class="detail-note space-y-3">
      <slot name="nav" />
      <USkeleton class="h-7 w-1/3" />
      <USkeleton class="h-40 w-full" />
    </div>
    <!-- 没读到过，或者是确定的结果（别处删掉、看不到之后的 404）：整块报错，旧内容不留 -->
    <div
      v-else-if="!data || (detail.isError.value && !retryable(detail.error.value))"
      class="detail-note"
    >
      <slot name="nav" />
      <ReadFailureNote :query="detail" />
    </div>
    <template v-else>
      <StrataStrip layer="episode" :sensitivity="data.kind === 'none' ? 'private' : 'public'" />
      <header class="detail-head">
        <slot name="nav" />
        <h2 ref="titleEl" tabindex="-1">{{ conversationTitle(data) }}</h2>
        <p class="head-meta">
          <!-- 不带会话上下文的会话，名字就是应用 -->
          <span v-if="data.kind !== 'none'">{{ data.app.name }}</span>
          <span>{{ data.kind === 'none' ? '本人' : conversationKindLabels[data.kind] }}</span>
          <RouterLink
            v-if="data.subject"
            :to="{ name: 'contact', params: { spaceId, subjectId: data.subject.id } }"
            class="head-link"
          >
            {{ data.subject.kind === 'group' ? '群的联系人详情' : '联系人详情' }}
          </RouterLink>
          <span>
            最近活动
            <time :datetime="data.lastActiveAt" :title="formatTime(data.lastActiveAt)">
              {{ formatRelative(data.lastActiveAt) }}
            </time>
          </span>
        </p>
      </header>

      <div v-if="detail.isError.value" class="stale-note">
        <ReadFailureNote :query="detail" />
      </div>

      <div class="detail-body">
        <section>
          <SectionHeading :title="`会话摘要（${data.summaries.length}）`">
            <template #hint>
              <Hint>
                {{
                  data.kind === 'none'
                    ? '不带会话上下文的会话只写摘要，不记联系人的事实。'
                    : '群聊、私聊的摘要来自未确认来源，不进入启动加载。'
                }}会话摘要到期后清除。
              </Hint>
            </template>
            <template #actions>
              <StrataSwatch layer="episode" plain label="layer" />
            </template>
          </SectionHeading>
          <p v-if="!data.summaries.length" class="empty">暂无会话摘要</p>
          <ol v-else class="timeline">
            <li v-for="summary in data.summaries" :key="summary.id" class="entry-row">
              <time
                class="entry-time"
                :datetime="summary.createdAt"
                :title="formatTime(summary.createdAt)"
              >
                {{ formatShort(summary.createdAt) }}
              </time>
              <div class="entry-body">
                <p class="entry-text">{{ summary.content }}</p>
                <p class="entry-meta">
                  <span>{{ provenanceLabels[summary.provenance] }}</span>
                  <span v-if="summary.expiresAt">{{ formatTime(summary.expiresAt) }} 到期</span>
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section v-if="data.kind !== 'none'">
          <SectionHeading :title="`在这里记下的事实（${data.facts.length}）`">
            <template #hint>
              <Hint>事实挂在各自的联系人上，在联系人详情中删除或恢复生效。</Hint>
            </template>
            <template #actions>
              <StrataSwatch layer="subject" plain label="layer" />
            </template>
          </SectionHeading>
          <p v-if="!data.facts.length" class="empty">暂无事实</p>
          <ul v-else>
            <li v-for="fact in data.facts" :key="fact.id" class="entry-row">
              <div class="entry-body">
                <p class="entry-text">{{ fact.content }}</p>
                <p class="entry-meta">
                  <RouterLink
                    :to="{ name: 'contact', params: { spaceId, subjectId: fact.subject.id } }"
                    class="entry-link"
                  >
                    {{ fact.subject.displayName }}
                  </RouterLink>
                  <span>{{ provenanceLabels[fact.provenance] }}</span>
                  <time :datetime="fact.updatedAt" :title="formatTime(fact.updatedAt)">
                    {{ formatRelative(fact.updatedAt) }}
                  </time>
                </p>
              </div>
            </li>
          </ul>
        </section>

        <section>
          <SectionHeading title="最近抽取" />
          <p v-if="!data.runs.length" class="empty">暂无相关抽取</p>
          <ul v-else>
            <li v-for="run in data.runs" :key="run.id" class="entry-row">
              <div class="entry-body">
                <p class="entry-meta">
                  <time :datetime="run.createdAt" :title="formatTime(run.createdAt)">
                    {{ formatShort(run.createdAt) }}
                  </time>
                  <span v-if="run.summaryOnly" class="text-warning">预算已用完，仅写入摘要</span>
                  <span v-else-if="run.summarized">已写入摘要</span>
                </p>
                <p class="entry-meta">{{ runCounts(run) }}</p>
                <p v-if="run.error" class="entry-meta text-error">{{ run.error }}</p>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </article>
</template>

<style scoped>
.conversation-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.conversation-detail > * {
  flex: none;
}
.detail-note {
  padding: 24px 32px;
}
.stale-note {
  padding: 14px 32px 0;
}
.detail-head {
  padding: 14px 32px 15px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.detail-head h2 {
  font-size: 21px;
  font-weight: 500;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.detail-head h2:focus {
  outline: 0;
}
.head-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  margin-top: 4px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.head-link,
.entry-link {
  color: var(--ui-text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 70%, transparent);
  text-underline-offset: 3px;
}
.head-link:hover,
.entry-link:hover {
  text-decoration-color: currentColor;
}
.detail-body {
  padding: 20px 32px 48px;
}
.detail-body section + section {
  margin-top: 26px;
}
.empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.entry-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 9px 0 8px;
  border-bottom: 1px solid var(--ui-border);
}
.entry-time {
  flex: none;
  width: 6.5rem;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.65rem;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.entry-body {
  flex: 1;
  min-width: 0;
}
.entry-text {
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.entry-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 10px;
  line-height: 1.6;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
@media (max-width: 1023.98px) {
  .detail-note {
    padding: 16px;
  }
  .stale-note {
    padding: 12px 16px 0;
  }
  .detail-head {
    padding: 12px 16px 14px;
  }
  .detail-body {
    padding: 16px 16px 32px;
  }
  .entry-row {
    flex-direction: column;
    gap: 2px;
  }
  .entry-time {
    width: auto;
    line-height: 1.6;
  }
}
</style>
