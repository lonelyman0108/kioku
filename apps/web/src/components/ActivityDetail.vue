<script setup lang="ts">
import { whenSignature, type ActivityFieldChange, type ActivityItem } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import {
  collapseUnchanged,
  diffVariantSnapshots,
  diffWithStatus,
  type DiffRow,
  type VariantDiffItem,
} from '../diff'
import { icons } from '../icons'
import {
  activityActor,
  activityActorIcons,
  activityLinkable,
  changeLabels,
  entryKindLabels,
  eventLabel,
  sensitivityLabels,
} from '../labels'
import { whenLabel } from '../memoryDetail'
import { entryRoute } from '../routes'
import ActivityFlags from './ActivityFlags.vue'
import MemoryHistory from './MemoryHistory.vue'
import PropertyList from './strata/PropertyList.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import { entryBand } from './strata/strata'

// 变更记录里一条改动的详情：谁、什么时候、经由哪里、各字段的前后值。按事件 id 读这一条改动（带前后快照），
// 不在已加载的列表里（打开带 event 的地址、或者更早的改动）也能显示；列表里有的先用列表的那一项占位。
// 正文的差异用这一条的前后快照对比
const props = defineProps<{ eventId: number; circleId: string; initial?: ActivityItem | null }>()
const emit = defineEmits<{ close: [] }>()
const { circle } = useSession()

// 前后快照里有正文：不留缓存、每次打开都重取（gcTime 0），和解密的正文一样。改成机密、转存为凭据、删除之后
// 历史里的正文会被抹掉，留着缓存就会再显示旧的明文；凡是让 entry-history 失效的地方也让它失效
const event = useQuery({
  queryKey: computed(() => ['activity-event', props.circleId, props.eventId]),
  queryFn: () => api.activityEvent(props.circleId, props.eventId),
  gcTime: 0,
  staleTime: 0,
  refetchOnMount: 'always',
})
const facets = useQuery({
  queryKey: computed(() => ['facets', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
  staleTime: 60_000,
})
const vocab = computed(() => facets.data.value ?? undefined)
const item = computed(() => event.data.value?.item ?? props.initial ?? null)
const band = computed(() =>
  item.value ? entryBand({ kind: item.value.kind }, circle.value) : null,
)

const actor = computed(() => (item.value ? activityActor(item.value) : null))
const op = computed(() => eventLabel(item.value?.type ?? ''))
const via = computed(() => {
  const i = item.value
  if (!i || !actor.value) return null
  if (i.bench) return `测试台，运行标记 ${i.bench.run}`
  if (actor.value.kind === 'client') {
    return i.actor.keyName ? `访问密钥「${i.actor.keyName}」` : '访问密钥'
  }
  return actor.value.kind === 'account' ? '管理界面' : null
})
const time = computed(() =>
  item.value ? new Date(item.value.createdAt).toLocaleString('zh-CN', { hour12: false }) : '',
)
const version = computed(() => {
  if (!item.value) return null
  const { versionBefore: b, versionAfter: a } = item.value
  if (b === null && a === null) return null
  if (b === null) return `${a}`
  return a === null || a === b ? `${b}` : `${b} → ${a}`
})

// 正文按行对比；单一切片且切面未变、两边都有正文时直接对比
const diff = computed(() => {
  const bv = event.data.value?.before?.variants
  const av = event.data.value?.after?.variants
  if (bv?.length !== 1 || av?.length !== 1) return null
  if (whenSignature(bv[0]!.when) !== whenSignature(av[0]!.when)) return null
  const before = bv[0]!.content
  const after = av[0]!.content
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return null
  const { lines, complete } = diffWithStatus(before, after)
  return {
    rows: collapseUnchanged(lines) as DiffRow[],
    complete,
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'remove').length,
  }
})
const variantDiffs = computed<VariantDiffItem[]>(() => {
  const after = event.data.value?.after
  if (!after) return []
  return diffVariantSnapshots(event.data.value?.before?.variants ?? null, after.variants).filter(
    (d) => d.status !== 'unchanged',
  )
})
const variantDiffStatusLabels: Record<VariantDiffItem['status'], string> = {
  added: '新增切片',
  removed: '移除切片',
  modified: '修改',
  unchanged: '未变',
  secret: '机密',
}
// 增删的行数：逐行对齐算出了差异时用画出来的这份，和下面的差异对得上；正文太长没有逐行对齐（整段算删掉
// 再加上）或者没有对比时，用列表给的近似值（按行做集合的差）
function lineCounts(change: { added: number | null; removed: number | null }) {
  return diff.value?.complete ? diff.value : change
}

type Scalar = Exclude<
  ActivityFieldChange,
  { field: 'content' | 'glossary' | 'topics' | 'variants' }
>
const scalarText = (change: Scalar, side: 'before' | 'after'): string => {
  const value = change[side]
  if (change.field === 'sensitivity') return sensitivityLabels[change[side]]
  if (change.field === 'validTo') {
    return value ? new Date(String(value)).toLocaleString('zh-CN', { hour12: false }) : '长期有效'
  }
  if (change.field === 'priority') return String(value)
  return value === null || value === '' ? '（无）' : String(value)
}
const emptyText = computed(() => {
  const i = item.value
  if (!i) return ''
  if (i.left) return '此次改动后，这条记忆超出当前账号的可见范围，只显示改动之前的记录。'
  if (i.type === 'create' || i.type === 'import') return '新建时的全部字段，见记忆详情。'
  if (i.type === 'delete') return '记忆移入「已删除」，保留期内可以恢复。'
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
    <div v-if="!item" class="detail-body">
      <ReadFailureNote v-if="event.isError.value" :query="event" />
      <USkeleton v-else class="h-24 w-full" />
    </div>
    <div v-else class="detail-body">
      <ReadFailureNote v-if="event.isError.value" class="mb-3" :query="event" />
      <h2 class="detail-title">
        <StrataSwatch :band="band" :sensitivity="item.sensitivity" />
        <span class="min-w-0 wrap-anywhere" :title="item.shortId">{{
          item.title || item.shortId
        }}</span>
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
            { key: 'kind', label: '类型', value: entryKindLabels[item.kind] },
            { key: 'shortId', label: '短 ID', value: item.shortId },
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
            <UIcon :name="activityActorIcons[actor!.kind]" class="text-dimmed" />{{ actor!.name }}
          </span>
          <span v-if="via" class="block text-xs/5 text-muted">{{ via }}</span>
        </template>
        <template #shortId>
          <span class="font-mono">{{ item.shortId }}</span>
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
              <p class="detail-note">
                增加 {{ lineCounts(change).added }} 行，删除 {{ lineCounts(change).removed }} 行
              </p>
              <USkeleton v-if="event.isPending.value" class="mt-1 h-16 w-full" />
              <template v-else-if="diff">
                <p v-if="!diff.complete" class="detail-note">
                  正文太长，未逐行对齐，下面整段对比改前与改后；行数是近似值。
                </p>
                <pre class="diff"><template v-for="(row, index) in diff.rows" :key="index"><span
                v-if="row.kind === 'skip'"
                class="diff-skip"
              >… 省略未改动的 {{ row.count }} 行</span><span
                v-else
                class="diff-line"
                :class="row.kind"
              >{{ row.text }}</span></template></pre>
              </template>
              <template v-else-if="variantDiffs.length">
                <div v-for="v in variantDiffs" :key="v.sig" class="variant-diff">
                  <p class="variant-diff-head">
                    <span>{{ variantDiffStatusLabels[v.status] }}</span>
                    <span class="text-muted">{{ whenLabel(v.when, vocab) }}</span>
                  </p>
                  <pre
                    v-if="v.rows.length"
                    class="diff"
                  ><template v-for="(row, index) in v.rows" :key="index"><span
                    v-if="row.kind === 'skip'"
                    class="diff-skip"
                  >… 省略未改动的 {{ row.count }} 行</span><span
                    v-else
                    class="diff-line"
                    :class="row.kind"
                  >{{ row.text }}</span></template></pre>
                </div>
              </template>
            </template>
          </template>
          <template v-else-if="change.field === 'variants'">
            <p class="detail-note">
              <template v-if="change.added">新增 {{ change.added }} 个</template>
              <template v-if="change.modified">
                <template v-if="change.added">，</template>修改 {{ change.modified }} 个
              </template>
              <template v-if="change.removed">
                <template v-if="change.added || change.modified">，</template>移除
                {{ change.removed }} 个
              </template>
            </p>
            <USkeleton v-if="event.isPending.value" class="mt-1 h-16 w-full" />
            <template v-else-if="variantDiffs.length">
              <div v-for="v in variantDiffs" :key="v.sig" class="variant-diff">
                <p class="variant-diff-head">
                  <span>{{ variantDiffStatusLabels[v.status] }}</span>
                  <span class="text-muted">{{ whenLabel(v.when, vocab) }}</span>
                </p>
                <p v-if="v.status === 'secret'" class="detail-note">机密切片不展示内容。</p>
                <pre
                  v-else-if="v.rows.length"
                  class="diff"
                ><template v-for="(row, index) in v.rows" :key="index"><span
                  v-if="row.kind === 'skip'"
                  class="diff-skip"
                >… 省略未改动的 {{ row.count }} 行</span><span
                  v-else
                  class="diff-line"
                  :class="row.kind"
                >{{ row.text }}</span></template></pre>
              </div>
            </template>
          </template>
          <template v-else-if="change.field === 'glossary' || change.field === 'topics'">
            <p v-if="change.added.length">添加：{{ change.added.join('、') }}</p>
            <p v-if="change.removed.length">移除：{{ change.removed.join('、') }}</p>
          </template>
          <p v-else class="before-after">
            <s>{{ scalarText(change, 'before') }}</s>
            <UIcon :name="icons.inherits" class="arrow" aria-label="改为" />
            <span>{{ scalarText(change, 'after') }}</span>
          </p>
        </div>
      </div>

      <div class="detail-actions">
        <UButton
          v-if="activityLinkable(item)"
          :to="entryRoute(circleId, item.shortId)"
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
    <USlideover
      v-if="item"
      v-model:open="historyOpen"
      :title="`历史：${item.title || item.shortId}`"
    >
      <template #body>
        <MemoryHistory :circle-id="circleId" :entry-id="item.entryId" :can-restore="false" />
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
  font-size: 14px;
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
  font-size: 14px;
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
.variant-diff {
  margin-top: 8px;
}
.variant-diff-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 18px;
}
</style>
