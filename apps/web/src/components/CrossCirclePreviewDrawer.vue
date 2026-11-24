<script setup lang="ts">
import type { CircleKind } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { circleKindLabels } from '../labels'
import type { WikiLinkTargets } from '../markdown'
import { whenLabel } from '../memoryDetail'
import { entryRoute } from '../routes'
import MemoryContent from './MemoryContent.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import ShortIdLine from './strata/ShortIdLine.vue'
import StrataStrip from './strata/StrataStrip.vue'
import StrataTag from './strata/StrataTag.vue'
import { entryBand } from './strata/strata'

// 跨记忆圈双链只读预览抽屉：点击引用自其他记忆圈的 [[m-xxxxxx]] 时，先在当前页右侧预览，
// 确认后再切换到目标记忆圈打开，不打断当前阅读或编辑上下文
const props = defineProps<{
  target: { circleId: string; shortId: string } | null
  currentCircleId: string
}>()
const emit = defineEmits<{
  close: []
  switchTo: [circleId: string, shortId: string]
}>()

const router = useRouter()
const { me } = useSession()
const open = computed(() => props.target !== null)

const targetCircle = computed(() =>
  props.target
    ? (me.data.value?.circles.find((c) => c.id === props.target!.circleId) ?? null)
    : null,
)
const targetCircleKind = computed<CircleKind>(() => targetCircle.value?.kind ?? 'shared')
const targetCircleName = computed(
  () =>
    targetCircle.value?.name ??
    (targetCircleKind.value === 'personal' ? circleKindLabels.personal : '其他记忆圈'),
)

const entryQuery = useQuery({
  queryKey: computed(() => ['entry', props.target?.circleId, props.target?.shortId] as const),
  queryFn: ({ queryKey: [, cid, sid] }) => api.entry(cid!, sid!, { allVariants: true }),
  enabled: open,
})
const wikiLinks = computed<WikiLinkTargets | null>(() => {
  const m = entryQuery.data.value
  if (!m) return null
  return {
    byShortId: new Map(m.links.map((l) => [l.shortId, { circleId: l.circleId, title: l.title }])),
    href: (sid, cid) => router.resolve(entryRoute(cid ?? m.circleId, sid)).href,
  }
})
function openDrawerLink(shortId: string, linkCircleId?: string) {
  const destCircleId = linkCircleId ?? props.target?.circleId
  if (!destCircleId) return
  emit('switchTo', destCircleId, shortId)
}
const facetsQuery = useQuery({
  queryKey: computed(() => ['facets', props.target?.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid!),
  enabled: open,
})

const entry = computed(() => entryQuery.data.value ?? null)
const variants = computed(() => entry.value?.variants ?? [])
const sliceIdx = ref(0)
watch(
  () => props.target,
  () => {
    sliceIdx.value = 0
  },
)
const activeVariant = computed(() => variants.value[sliceIdx.value] ?? variants.value[0] ?? null)

const band = computed(() =>
  entry.value
    ? entryBand(
        {
          kind: entry.value.kind,
          circleId: entry.value.circleId,
          circleKind: targetCircleKind.value,
        },
        { id: props.currentCircleId, kind: 'shared' },
      )
    : null,
)
</script>

<template>
  <USlideover
    :open="open"
    side="right"
    title="跨记忆圈引用预览"
    :ui="{ content: 'max-w-xl sm:max-w-xl', body: 'p-0 sm:p-0' }"
    @update:open="(v) => !v && emit('close')"
  >
    <template #body>
      <div class="preview-drawer">
        <StrataStrip v-if="entry && band" :band="band" :sensitivity="entry.sensitivity" />

        <div class="drawer-head">
          <div class="circle-banner">
            <span class="circle-kind">{{ circleKindLabels[targetCircleKind] }}</span>
            <b>{{ targetCircleName }}</b>
          </div>

          <template v-if="entry">
            <h2 class="drawer-title">{{ entry.title || entry.shortId }}</h2>
            <div class="drawer-tags">
              <StrataTag v-if="band" :band="band" :sensitivity="entry.sensitivity" />
              <span class="tag-prio">P{{ entry.priority }}</span>
              <span v-if="variants.length > 1" class="tag-vars">{{ variants.length }} 变体</span>
            </div>
          </template>
        </div>

        <div class="drawer-body">
          <ReadFailureNote v-if="entryQuery.isError.value" :query="entryQuery" />
          <div v-else-if="entryQuery.isPending.value" class="space-y-3">
            <USkeleton class="h-6 w-2/3" />
            <USkeleton class="h-36 w-full" />
          </div>
          <template v-else-if="entry">
            <NoteLine v-if="entry.contentHidden">
              机密记忆默认不传输明文。查看正文会记录一次访问事件，请切换到所属记忆圈后查看。
            </NoteLine>
            <template v-else>
              <div v-if="variants.length >= 2" class="slice-bar" role="tablist" aria-label="变体">
                <button
                  v-for="(v, idx) in variants"
                  :key="v.id"
                  type="button"
                  role="tab"
                  :aria-selected="idx === sliceIdx"
                  class="slice-tab"
                  :class="{ active: idx === sliceIdx }"
                  @click="sliceIdx = idx"
                >
                  {{ whenLabel(v.when, facetsQuery.data.value) }}
                </button>
              </div>
              <p
                v-else-if="variants.length === 1 && Object.keys(variants[0]!.when).length > 0"
                class="single-when"
              >
                适用条件：{{ whenLabel(variants[0]!.when, facetsQuery.data.value) }}
              </p>

              <MemoryContent
                v-if="activeVariant"
                :content="activeVariant.content ?? ''"
                :self="entry.shortId"
                :wiki-links="wikiLinks"
                @open="openDrawerLink"
              />
            </template>

            <dl v-if="entry.disclosure || entry.topics.length" class="drawer-meta">
              <template v-if="entry.disclosure">
                <dt>召回说明</dt>
                <dd>{{ entry.disclosure }}</dd>
              </template>
              <template v-if="entry.topics.length">
                <dt>主题</dt>
                <dd class="topics">
                  <span v-for="t in entry.topics" :key="t">{{ t }}</span>
                </dd>
              </template>
            </dl>
          </template>
        </div>

        <ShortIdLine v-if="entry" :value="entry.shortId" />
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton color="neutral" variant="ghost" @click="emit('close')">关闭</UButton>
        <UButton
          v-if="target"
          :icon="icons.link"
          @click="emit('switchTo', target.circleId, target.shortId)"
        >
          切换到「{{ targetCircleName }}」打开
        </UButton>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
.preview-drawer {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.drawer-head {
  padding: 16px 20px 14px;
  border-bottom: 1px solid var(--strata-rule);
}
.circle-banner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.circle-kind {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
}
.drawer-title {
  margin-top: 4px;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
}
.drawer-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
}
.tag-prio,
.tag-vars {
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-muted);
}
.drawer-body {
  flex: 1;
  padding: 16px 20px 28px;
}
.slice-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 12px;
}
.slice-tab {
  padding: 3px 9px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  background: var(--ui-bg);
  color: var(--ui-text-muted);
  cursor: pointer;
}
.slice-tab.active {
  background: var(--strata-selected);
  border-color: var(--strata-selected-frame);
  color: var(--strata-on-selected);
}
.single-when {
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.drawer-meta {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 6px 12px;
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
  font-size: 13px;
}
.drawer-meta dt {
  color: var(--ui-text-muted);
}
.topics {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.topics span {
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  font-size: 12px;
}
</style>
