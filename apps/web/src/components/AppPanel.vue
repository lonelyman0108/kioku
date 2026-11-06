<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { conversationRoute, conversationSubline, conversationTitle } from '../conversations'
import { memoryRoute } from '../routes'
import { formatRelative, formatShort, formatTime } from '../time'
import Hint from './Hint.vue'
import CoordinateLine from './strata/CoordinateLine.vue'
import MemoryRow from './strata/MemoryRow.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataStrip from './strata/StrataStrip.vue'

// 记忆目录里选中一个应用时右边的内容：它的记忆、最近的会话，以及去「接入 › 应用」管理访问密钥的入口。
// 应用的设置（默认人格、按群切换人格、访问密钥）仍在接入那边，这里不重复
const props = defineProps<{ spaceId: string; appId: string; canWrite: boolean }>()
const emit = defineEmits<{ create: []; openPersona: [personaId: string] }>()

const apps = useQuery({
  queryKey: computed(() => ['apps', props.spaceId]),
  queryFn: () => api.apps(props.spaceId),
})
const app = computed(() => apps.data.value?.find((a) => a.id === props.appId) ?? null)
const head = computed(() => (app.value ? `app://${app.value.slug}/` : ''))
const personas = useQuery({
  queryKey: computed(() => ['personas', props.spaceId]),
  queryFn: () => api.personas(props.spaceId),
})
const persona = computed(() =>
  app.value?.defaultPersonaId
    ? (personas.data.value?.find((p) => p.id === app.value!.defaultPersonaId) ?? null)
    : null,
)

// 这个应用的记忆：按位置筛选坐标开头 app://<应用>，按优先级排。键挂在 memory-list 下，写入之后跟着列表失效
const MEMORY_LIMIT = 50
const memories = useQuery({
  queryKey: computed(
    () => ['memory-list', props.spaceId, { under: app.value?.slug, panel: true }] as const,
  ),
  queryFn: () =>
    api.memoryList(props.spaceId, {
      under: `app://${app.value!.slug}`,
      sort: 'priority',
      limit: MEMORY_LIMIT,
    }),
  enabled: computed(() => app.value !== null),
})

// 最近的几个会话，全部的在对话页按这个应用筛
const conversations = useQuery({
  queryKey: computed(() => ['conversations', props.spaceId, props.appId, 'recent'] as const),
  queryFn: ({ queryKey: [, sid, id] }) => api.conversations(sid, { appId: id }),
})
const recent = computed(() => conversations.data.value?.items.slice(0, 5) ?? [])

// 访问密钥的情况和概览共用一份：只有应用所有者与空间所有者看得到，其他人为 null
const overview = useQuery({
  queryKey: computed(() => ['overview', props.spaceId]),
  queryFn: () => api.overview(props.spaceId),
  staleTime: 60_000,
})
const keys = computed(() => overview.data.value?.apps.find((a) => a.id === props.appId)?.keys)

const titleEl = ref<HTMLElement | null>(null)
defineExpose({ focusTitle: () => titleEl.value?.focus() })
</script>

<template>
  <div v-if="!app" class="detail-note space-y-3">
    <slot name="nav" />
    <ReadFailureNote v-if="apps.isError.value" :query="apps" />
    <template v-else-if="apps.isPending.value">
      <USkeleton class="h-6 w-1/3" />
      <USkeleton class="h-40 w-full" />
    </template>
    <NoteLine v-else>应用不存在或已删除</NoteLine>
  </div>
  <article v-else class="app-panel">
    <StrataStrip layer="app" sensitivity="internal" />
    <header class="detail-head">
      <div class="detail-nav"><slot name="nav" /></div>
      <h1 ref="titleEl" tabindex="-1">{{ app.name }}</h1>
      <p class="detail-meta">
        <span>{{ app.runtimeFamily }}</span>
        <span v-if="persona">
          默认人格
          <button type="button" class="inline-link" @click="emit('openPersona', persona.id)">
            {{ persona.name }}
          </button>
        </span>
        <span v-else-if="!app.defaultPersonaId">未设默认人格</span>
      </p>
      <div class="detail-actions">
        <UButton v-if="canWrite" size="sm" @click="emit('create')">新建记忆</UButton>
        <UButton
          size="sm"
          color="primary"
          variant="outline"
          :to="{ name: 'app', params: { spaceId, appId } }"
        >
          访问密钥与设置
        </UButton>
      </div>
    </header>

    <div class="detail-body">
      <section>
        <SectionHeading title="记忆">
          <template #actions>
            <b v-if="memories.data.value" class="count">
              {{ memories.data.value.items.length }}{{ memories.data.value.nextCursor ? '+' : '' }}
            </b>
          </template>
        </SectionHeading>
        <ReadFailureNote v-if="memories.isError.value" :query="memories" size="xs" />
        <USkeleton v-if="memories.isPending.value" class="mt-2 h-24 w-full" />
        <ul v-else-if="memories.data.value?.items.length">
          <li v-for="m in memories.data.value.items" :key="m.id">
            <MemoryRow
              flush
              :uri="m.uri"
              :title="m.title"
              :layer="m.layer"
              :sensitivity="m.sensitivity"
              :priority="m.priority"
              :to="memoryRoute(spaceId, m.uri)"
            >
              <span v-if="m.disclosure" class="block truncate">{{ m.disclosure }}</span>
            </MemoryRow>
          </li>
        </ul>
        <p v-else-if="memories.data.value" class="empty">暂无记忆</p>
        <p v-if="memories.data.value?.nextCursor" class="more">
          仅列出优先级最高的 {{ MEMORY_LIMIT }} 条，全部的在目录中展开查看
        </p>
      </section>

      <section>
        <SectionHeading title="会话">
          <template #hint>
            <Hint>这个应用在群聊、私聊里，或不带会话上下文时的对话，最近活动的在前。</Hint>
          </template>
          <template #actions>
            <RouterLink
              :to="{ name: 'conversations', params: { spaceId }, query: { app: appId } }"
              class="heading-link"
            >
              全部会话
            </RouterLink>
          </template>
        </SectionHeading>
        <ReadFailureNote v-if="conversations.isError.value" :query="conversations" size="xs" />
        <USkeleton v-if="conversations.isPending.value" class="mt-2 h-16 w-full" />
        <ul v-else-if="recent.length">
          <li v-for="c in recent" :key="c.id" class="side-row">
            <RouterLink :to="conversationRoute(spaceId, c.id)" class="side-name">
              {{ conversationTitle(c) }}
            </RouterLink>
            <span class="side-meta">
              {{ conversationSubline(c) }} ·
              <time :datetime="c.lastActiveAt" :title="formatTime(c.lastActiveAt)">
                {{ formatShort(c.lastActiveAt) }}
              </time>
            </span>
          </li>
        </ul>
        <p v-else-if="conversations.data.value" class="empty">暂无会话</p>
      </section>

      <section>
        <SectionHeading title="访问密钥" />
        <p v-if="overview.isError.value" class="empty">{{ readFailure(overview.error.value) }}</p>
        <p v-else-if="keys" class="key-line">
          有效访问密钥 <span class="font-mono">{{ keys.active }}</span> 个<template
            v-if="keys.lastUsedAt"
          >
            · 最近使用
            <time :datetime="keys.lastUsedAt" :title="formatTime(keys.lastUsedAt)">
              {{ formatRelative(keys.lastUsedAt) }}
            </time>
          </template>
        </p>
        <p v-else-if="overview.data.value" class="empty">仅应用所有者可查看访问密钥</p>
        <p class="key-line">
          <RouterLink :to="{ name: 'app', params: { spaceId, appId } }" class="heading-link">
            在「接入 › 应用」中签发或吊销
          </RouterLink>
        </p>
      </section>
    </div>

    <CoordinateLine :value="head" label="坐标开头" />
  </article>
</template>

<style scoped>
.app-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.app-panel > * {
  flex: none;
}
.detail-note {
  padding: 24px 32px;
}
.detail-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 24px;
  padding: 14px 32px 15px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.detail-head > * {
  grid-column: 1;
}
.detail-head h1 {
  font-size: 21px;
  font-weight: 500;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.detail-head h1:focus {
  outline: 0;
}
.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  margin-top: 3px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.inline-link {
  color: var(--ui-text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 70%, transparent);
  text-underline-offset: 3px;
}
.inline-link:hover {
  text-decoration-color: currentColor;
}
.detail-head > .detail-actions {
  grid-column: 2;
  grid-row: 1 / span 4;
  align-self: start;
  display: flex;
  gap: 6px;
}
.detail-body {
  flex: 1 0 auto;
  padding: 20px 32px 40px;
}
.detail-body section + section {
  margin-top: 26px;
}
.count {
  font-family: var(--font-mono);
  font-weight: 600;
}
.empty,
.more {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.heading-link {
  color: var(--ui-text-muted);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 70%, transparent);
  text-underline-offset: 3px;
}
.heading-link:hover {
  color: var(--ui-text-highlighted);
}
.side-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 10px;
  padding: 7px 0 6px;
  border-bottom: 1px solid var(--ui-border);
}
.side-name {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.side-name:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.side-meta {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.key-line {
  padding: 9px 0 0;
  line-height: 1.6;
}
@media (max-width: 1240px) {
  .detail-head {
    grid-template-columns: minmax(0, 1fr);
  }
  .detail-head > .detail-actions {
    grid-column: 1;
    grid-row: auto;
    margin-top: 11px;
  }
}
@media (max-width: 1023.98px) {
  .detail-note {
    padding: 16px;
  }
  .detail-head {
    padding: 12px 16px 14px;
  }
  .detail-head h1 {
    font-size: 18px;
  }
  .detail-body {
    padding: 16px 16px 32px;
  }
}
</style>
