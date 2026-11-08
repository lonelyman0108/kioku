<script setup lang="ts">
import type { ActivityFieldChange, ActivityItem } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { api } from '../api/endpoints'
import { collapseUnchanged, diffLines, type DiffRow } from '../diff'
import { icons } from '../icons'
import {
  activityActor,
  activityActorIcons,
  activityLinkable,
  changeLabels,
  eventLabel,
  layerLabels,
  sensitivityLabels,
} from '../labels'
import { memoryRoute } from '../routes'
import ActivityFlags from './ActivityFlags.vue'
import MemoryHistory from './MemoryHistory.vue'
import PropertyList from './strata/PropertyList.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import StrataSwatch from './strata/StrataSwatch.vue'

// 变更记录里一条改动的详情：谁、什么时候、经由哪里、各字段的前后值。正文的差异按记忆取历史，
// 用这个事件的前后快照对比（和历史里的「查看改动」同一份数据）
const props = defineProps<{ item: ActivityItem; spaceId: string }>()
const emit = defineEmits<{ close: [] }>()

const actor = computed(() => activityActor(props.item))
const op = computed(() => eventLabel(props.item.type))
const via = computed(() => {
  const item = props.item
  if (item.bench) return `测试台，运行标记 ${item.bench.run}`
  if (actor.value.kind === 'app') {
    return item.actor.keyName ? `访问密钥「${item.actor.keyName}」` : '访问密钥'
  }
  return actor.value.kind === 'account' ? '管理界面' : null
})
const time = computed(() =>
  new Date(props.item.createdAt).toLocaleString('zh-CN', { hour12: false }),
)
const version = computed(() => {
  const { versionBefore: b, versionAfter: a } = props.item
  if (b === null && a === null) return null
  if (b === null) return `${a}`
  return a === null || a === b ? `${b}` : `${b} → ${a}`
})

const contentChange = computed(() => props.item.fieldChanges.find((c) => c.field === 'content'))
// 正文改了、能对比时才取历史
const wantsDiff = computed(
  () =>
    !!contentChange.value &&
    contentChange.value.field === 'content' &&
    contentChange.value.added !== null,
)
const history = useQuery({
  queryKey: computed(() => ['memory-history', props.spaceId, props.item.memoryId]),
  queryFn: () => api.memoryHistory(props.spaceId, props.item.memoryId),
  enabled: wantsDiff,
})
const diffRows = computed<DiffRow[] | null>(() => {
  const event = history.data.value?.events.find((e) => e.id === props.item.id)
  if (!event || event.left || !event.before || !event.after) return null
  if (event.before.content === null || event.after.content === null) return null
  return collapseUnchanged(diffLines(event.before.content, event.after.content))
})

type Scalar = Exclude<ActivityFieldChange, { field: 'content' | 'glossary' }>
const scalarText = (change: Scalar, side: 'before' | 'after'): string => {
  const value = change[side]
  if (change.field === 'layer') return layerLabels[change[side]]
  if (change.field === 'sensitivity') return sensitivityLabels[change[side]]
  if (change.field === 'validTo') {
    return value ? new Date(String(value)).toLocaleString('zh-CN', { hour12: false }) : '长期有效'
  }
  if (change.field === 'priority') return String(value)
  return value === null || value === '' ? '（无）' : String(value)
}
const emptyText = computed(() => {
  const item = props.item
  if (item.left) return '此次改动后，这条记忆超出当前账号的可见范围，只显示改动之前的记录。'
  if (item.type === 'create' || item.type === 'import') return '新建时的全部字段，见记忆详情。'
  if (item.type === 'delete') return '记忆移入「已删除」，保留期内可以恢复。'
  return '无字段变化。'
})
const historyOpen = ref(false)
</script>

<template>
  <section class="detail" aria-label="改动详情">
    <header class="detail-head">
      <b>改动详情</b>
      <UButton
        :icon="icons.cancel"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="关闭"
        @click="emit('close')"
      />
    </header>
    <div class="detail-body">
      <h2 class="detail-title">
        <StrataSwatch :layer="item.layer" :sensitivity="item.sensitivity" />
        <span class="min-w-0 wrap-anywhere" :title="item.uri">{{ item.title || item.uri }}</span>
        <UIcon v-if="item.sensitivity === 'secret'" :name="icons.secret" aria-label="机密" />
      </h2>
      <ActivityFlags
        v-if="item.deleted || item.expired || item.bench || item.left"
        class="mt-2"
        :item="item"
      />
      <PropertyList
        class="mt-3"
        :groups="[
          [
            { key: 'op', label: '操作' },
            { key: 'time', label: '时间', value: time },
            { key: 'actor', label: '操作者' },
            { key: 'layer', label: '归属', value: layerLabels[item.layer] },
            ...(version ? [{ key: 'version', label: '版本', value: version }] : []),
          ],
        ]"
      >
        <template #op>
          <span class="inline-flex items-center gap-1.5">
            <UIcon :name="op.icon" class="text-dimmed" />{{ op.label }}
          </span>
        </template>
        <template #actor>
          <span class="inline-flex items-center gap-1.5">
            <UIcon :name="activityActorIcons[actor.kind]" class="text-dimmed" />{{ actor.name }}
          </span>
          <span v-if="via" class="block text-xs/5 text-muted">{{ via }}</span>
        </template>
        <template #version>
          <span class="font-mono">{{ version }}</span>
        </template>
      </PropertyList>

      <h3 class="detail-section">改动</h3>
      <p v-if="!item.fieldChanges.length" class="detail-note">{{ emptyText }}</p>
      <div v-for="change in item.fieldChanges" :key="change.field" class="field-change">
        <span class="field-name">{{ changeLabels[change.field] ?? change.field }}</span>
        <div class="min-w-0">
          <template v-if="change.field === 'content'">
            <p v-if="change.added === null" class="detail-note">机密的正文不进变更记录。</p>
            <template v-else>
              <p class="detail-note">增加 {{ change.added }} 行，删除 {{ change.removed }} 行</p>
              <ReadFailureNote
                v-if="history.isError.value"
                :query="history"
                size="xs"
                fallback="正文对比读取失败"
              />
              <USkeleton v-else-if="history.isPending.value" class="mt-1 h-16 w-full" />
              <pre
                v-else-if="diffRows"
                class="diff"
              ><template v-for="(row, index) in diffRows" :key="index"><span
                v-if="row.kind === 'skip'"
                class="diff-skip"
              >… 省略未改动的 {{ row.count }} 行</span><span
                v-else
                class="diff-line"
                :class="row.kind"
              >{{ row.text }}</span></template></pre>
            </template>
          </template>
          <template v-else-if="change.field === 'glossary'">
            <p v-if="change.added.length">添加：{{ change.added.join('、') }}</p>
            <p v-if="change.removed.length">移除：{{ change.removed.join('、') }}</p>
          </template>
          <p v-else class="before-after" :class="{ 'font-mono': change.field === 'uri' }">
            <s>{{ scalarText(change, 'before') }}</s>
            <UIcon :name="icons.inherits" class="arrow" aria-label="改为" />
            <span>{{ scalarText(change, 'after') }}</span>
          </p>
        </div>
      </div>

      <div class="detail-actions">
        <UButton
          v-if="activityLinkable(item)"
          :to="memoryRoute(spaceId, item.uri)"
          :icon="icons.link"
          size="sm"
          color="neutral"
          variant="outline"
        >
          打开记忆
        </UButton>
        <UButton
          v-if="!item.left"
          :icon="icons.activity"
          size="sm"
          color="neutral"
          variant="ghost"
          @click="historyOpen = true"
        >
          这条记忆的历史
        </UButton>
      </div>
    </div>
    <USlideover v-model:open="historyOpen" :title="`历史：${item.title || item.uri}`">
      <template #body>
        <MemoryHistory :space-id="spaceId" :memory-id="item.memoryId" :can-restore="false" />
      </template>
    </USlideover>
  </section>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.detail-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 12px 0 20px;
  border-bottom: 1px solid var(--strata-rule);
  background: var(--ui-bg);
  font-size: 14px;
}
.detail-head b {
  flex: 1;
}
.detail-body {
  padding: 14px 20px 32px;
  font-size: 14px;
}
.detail-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
}
.detail-section {
  margin-top: 18px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 12px;
  font-weight: 600;
}
.detail-note {
  margin-top: 4px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.field-change {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 8px 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--ui-border);
}
.field-name {
  padding-top: 1px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.before-after {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  overflow-wrap: anywhere;
}
.before-after s {
  color: var(--ui-text-muted);
}
.arrow {
  flex-shrink: 0;
  color: var(--ui-text-dimmed);
}
.diff {
  max-height: 20rem;
  margin-top: 6px;
  overflow: auto;
  border: 1px solid var(--ui-border);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.diff-skip {
  display: block;
  padding-left: 18px;
  color: var(--ui-text-muted);
}
.diff-line {
  position: relative;
  display: block;
  min-height: 1.7em;
  padding-left: 18px;
}
.diff-line::before {
  position: absolute;
  left: 4px;
  content: '';
}
.diff-line.add {
  background: var(--ui-bg-muted);
  font-weight: 600;
}
.diff-line.add::before {
  content: '+';
}
.diff-line.remove {
  color: var(--ui-text-muted);
  text-decoration: line-through;
}
.diff-line.remove::before {
  content: '−';
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 18px;
}
</style>
