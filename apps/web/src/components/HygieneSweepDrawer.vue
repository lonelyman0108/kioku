<script setup lang="ts">
import {
  stripDuplicateLeadingHeading,
  stripLegacyGlossaryLines,
  type HygieneSweepCandidate,
  type HygieneSweepPreviewResponse,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { hygieneFixLabels } from '../labels'
import { entryRoute } from '../routes'
import DiffViewer from './ui/DiffViewer.vue'
import EmptyState from './ui/EmptyState.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import SectionHeading from './ui/SectionHeading.vue'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ applied: [] }>()

const toast = useToast()
const queryClient = useQueryClient()

const previewQuery = useQuery({
  queryKey: ['hygiene-sweep-preview'] as const,
  queryFn: () => api.previewHygieneSweep(),
  enabled: open,
  staleTime: 0,
})

const report = computed<HygieneSweepPreviewResponse | null>(() => previewQuery.data.value ?? null)
const candidates = computed<HygieneSweepCandidate[]>(
  () => report.value?.deterministicCandidates ?? [],
)
const suspectTruncated = computed(() => report.value?.suspectTruncated ?? [])
const suspectObsolete = computed(() => report.value?.suspectObsolete ?? [])
const brokenLinks = computed(() => report.value?.brokenLinks ?? [])

const selectedShortIds = ref<string[]>([])
const selectionInitialized = ref(false)
const applying = ref(false)
const applyError = ref<string | null>(null)
const expandedPreviewIds = ref<string[]>([])
const previewLoading = ref<Record<string, boolean>>({})
const previewDiffs = ref<Record<string, { before: string; after: string }>>({})
const previewErrors = ref<Record<string, string>>({})
const candidatesSectionRef = ref<HTMLElement | null>(null)
const truncatedSectionRef = ref<HTMLElement | null>(null)
const obsoleteSectionRef = ref<HTMLElement | null>(null)
const brokenLinksSectionRef = ref<HTMLElement | null>(null)
let previewEpoch = 0

function resetPreviewCache() {
  previewEpoch++
  expandedPreviewIds.value = []
  previewLoading.value = {}
  previewDiffs.value = {}
  previewErrors.value = {}
}

function refreshScan() {
  if (applying.value) return
  resetPreviewCache()
  void previewQuery.refetch()
}

function jumpToSection(el: HTMLElement | null) {
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 按候选清洗项在本地推演改动后文本，供抽屉内就地展示行级预览
function computeCandidatePreview(
  title: string,
  before: string,
  item: HygieneSweepCandidate,
): string {
  let after = before
  if (item.fixes.includes('strip_duplicate_heading')) {
    after = stripDuplicateLeadingHeading(title, after)
  }
  if (item.fixes.includes('strip_legacy_glossary')) {
    after = stripLegacyGlossaryLines(after).content
  }
  if (item.rewrites.length) {
    const orderedRewrites = [...item.rewrites].sort((a, b) => b.raw.length - a.raw.length)
    const lines = after.replace(/\r\n/g, '\n').split('\n')
    let fence: string | null = null
    const rewritten = lines.map((line) => {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (fence !== null) {
        if (
          m &&
          m[1]![0] === fence[0] &&
          m[1]!.length >= fence.length &&
          /^[ \t]*$/.test(m[2] ?? '')
        ) {
          fence = null
        }
        return line
      }
      if (m && !(m[1]![0] === '`' && (m[2] ?? '').includes('`'))) {
        fence = m[1]!
        return line
      }
      // 跳过行内反引号代码片段
      return line
        .split(/(`+[^`]*`+)/g)
        .map((seg, idx) => {
          if (idx % 2 === 1) return seg
          let out = seg
          for (const rw of orderedRewrites) {
            if (rw.raw && out.includes(rw.raw)) out = out.replaceAll(rw.raw, rw.replacement)
          }
          return out
        })
        .join('')
    })
    after = rewritten.join('\n')
  }
  return after
}

async function togglePreviewDiff(item: HygieneSweepCandidate) {
  const sid = item.shortId
  if (expandedPreviewIds.value.includes(sid)) {
    expandedPreviewIds.value = expandedPreviewIds.value.filter((id) => id !== sid)
    return
  }
  expandedPreviewIds.value = [...expandedPreviewIds.value, sid]
  if (previewDiffs.value[sid] || previewLoading.value[sid]) return
  const epoch = previewEpoch
  previewLoading.value = { ...previewLoading.value, [sid]: true }
  const nextErrors = { ...previewErrors.value }
  delete nextErrors[sid]
  previewErrors.value = nextErrors
  try {
    const detail = await api.entry(sid)
    if (epoch !== previewEpoch || !open.value) return
    const before = detail.entry.content
    const after = computeCandidatePreview(detail.entry.title, before, item)
    previewDiffs.value = { ...previewDiffs.value, [sid]: { before, after } }
  } catch (err) {
    if (epoch !== previewEpoch || !open.value) return
    previewErrors.value = {
      ...previewErrors.value,
      [sid]: err instanceof ApiError ? err.message : '加载对比预览失败',
    }
  } finally {
    if (epoch === previewEpoch) {
      previewLoading.value = { ...previewLoading.value, [sid]: false }
    }
  }
}

watch(
  candidates,
  (list) => {
    if (!selectionInitialized.value) {
      if (report.value) {
        selectedShortIds.value = list.map((item) => item.shortId)
        selectionInitialized.value = true
      }
      return
    }
    const valid = new Set(list.map((item) => item.shortId))
    selectedShortIds.value = selectedShortIds.value.filter((id) => valid.has(id))
  },
  { immediate: true },
)

watch(open, (visible) => {
  if (visible) {
    applyError.value = null
  } else {
    selectionInitialized.value = false
    resetPreviewCache()
  }
})

const allSelected = computed(
  () => candidates.value.length > 0 && selectedShortIds.value.length === candidates.value.length,
)

function toggleSelectAll() {
  if (applying.value) return
  if (allSelected.value) {
    selectedShortIds.value = []
  } else {
    selectedShortIds.value = candidates.value.map((item) => item.shortId)
  }
}

function toggleCandidate(shortId: string) {
  if (applying.value) return
  if (selectedShortIds.value.includes(shortId)) {
    selectedShortIds.value = selectedShortIds.value.filter((id) => id !== shortId)
  } else {
    selectedShortIds.value = [...selectedShortIds.value, shortId]
  }
}

const isClean = computed(
  () =>
    Boolean(report.value) &&
    candidates.value.length === 0 &&
    suspectTruncated.value.length === 0 &&
    suspectObsolete.value.length === 0 &&
    brokenLinks.value.length === 0,
)

async function applySelected() {
  if (!selectedShortIds.value.length || applying.value) return
  applying.value = true
  applyError.value = null
  try {
    const payload =
      allSelected.value && candidates.value.length > 500 ? {} : { shortIds: selectedShortIds.value }
    const res = await api.applyHygieneSweep(payload)
    const summary =
      res.skipped > 0
        ? `已预清洗 ${res.applied} 条记忆，跳过 ${res.skipped} 条`
        : `已预清洗 ${res.applied} 条记忆`
    toast.add({ title: summary, color: res.applied > 0 ? 'success' : 'neutral' })
    selectionInitialized.value = false
    resetPreviewCache()
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
      ...res.appliedShortIds.flatMap((sid) => [
        queryClient.invalidateQueries({ queryKey: ['entry', sid] }),
        queryClient.invalidateQueries({ queryKey: ['entry-history', sid] }),
      ]),
      previewQuery.refetch(),
    ])
    emit('applied')
  } catch (err) {
    applyError.value = err instanceof ApiError ? err.message : '预清洗执行失败，请重试'
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <USlideover
    :open="open"
    side="right"
    title="结构体检与预清洗"
    description="无需对话模型，检查并修复重复标题、旧引用与异常记忆"
    :dismissible="!applying"
    :close="!applying"
    :ui="{ content: 'w-[min(92vw,960px)] max-w-[960px] sm:max-w-[960px] ring-2 ring-rule' }"
    @update:open="(v) => !applying && (open = v)"
  >
    <template #body>
      <ReadFailureNote v-if="previewQuery.isError.value" :query="previewQuery" />
      <div v-else-if="previewQuery.isPending.value && !report" class="space-y-3">
        <USkeleton class="h-14 w-full" />
        <USkeleton v-for="n in 4" :key="n" class="h-20 w-full" />
      </div>

      <div v-else-if="report" class="sweep-body">
        <div class="sweep-head-row">
          <span class="sweep-head-label">扫描概览</span>
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.refresh"
            :loading="previewQuery.isFetching.value"
            :disabled="applying"
            @click="refreshScan"
          >
            重新扫描
          </UButton>
        </div>

        <!-- 扫描概览（有结果项支持点击直达对应分组） -->
        <div class="sweep-stats tabular-nums">
          <div class="stat-cell">
            <span class="stat-label">已扫描记忆</span>
            <span class="stat-val">{{ report.totalScanned }} 条</span>
          </div>
          <button
            v-if="candidates.length"
            type="button"
            class="stat-cell is-clickable"
            @click="jumpToSection(candidatesSectionRef)"
          >
            <span class="stat-label">可确定性预清洗</span>
            <span class="stat-val">{{ candidates.length }} 条</span>
          </button>
          <div v-else class="stat-cell">
            <span class="stat-label">可确定性预清洗</span>
            <span class="stat-val">0 条</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label">待规范标题</span>
            <span class="stat-val" :class="{ 'text-warning': report.dirtyTitleCount > 0 }">
              {{ report.dirtyTitleCount }} 条
            </span>
          </div>
          <button
            v-if="suspectTruncated.length + suspectObsolete.length > 0"
            type="button"
            class="stat-cell is-clickable"
            @click="jumpToSection(truncatedSectionRef ?? obsoleteSectionRef)"
          >
            <span class="stat-label">异常标注</span>
            <span
              class="stat-val"
              :class="{
                'text-error': suspectTruncated.length > 0,
                'text-warning': suspectTruncated.length === 0 && suspectObsolete.length > 0,
              }"
            >
              {{ suspectTruncated.length + suspectObsolete.length }} 条
            </span>
          </button>
          <div v-else class="stat-cell">
            <span class="stat-label">异常标注</span>
            <span class="stat-val">0 条</span>
          </div>
          <button
            v-if="brokenLinks.length"
            type="button"
            class="stat-cell is-clickable"
            @click="jumpToSection(brokenLinksSectionRef)"
          >
            <span class="stat-label">悬空断链</span>
            <span class="stat-val text-warning">{{ brokenLinks.length }} 条</span>
          </button>
          <div v-else class="stat-cell">
            <span class="stat-label">悬空断链</span>
            <span class="stat-val">0 条</span>
          </div>
        </div>

        <EmptyState
          v-if="isClean"
          :title="report.dirtyTitleCount > 0 ? '无需确定性预清洗' : '记忆结构良好'"
          :description="
            report.dirtyTitleCount > 0
              ? `未检测到可自动修复的结构问题；另有 ${report.dirtyTitleCount} 条记忆标题含日期或较长，可在待处理页发起存量规范整理。`
              : '未检测到可确定性预清洗项，也未发现疑似残缺或过时记忆。'
          "
        />

        <!-- 确定性预清洗项 -->
        <section v-if="candidates.length" ref="candidatesSectionRef" class="sweep-section">
          <SectionHeading title="确定性预清洗项" :level="3">
            <template #actions>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="applying"
                @click="toggleSelectAll"
              >
                {{ allSelected ? '取消全选' : '全选' }}
              </UButton>
              <UButton
                size="xs"
                :icon="icons.check"
                :loading="applying"
                :disabled="!selectedShortIds.length"
                @click="applySelected"
              >
                应用所选（{{ selectedShortIds.length }} 条）
              </UButton>
            </template>
          </SectionHeading>

          <p v-if="applyError" class="text-sm text-error" role="alert">{{ applyError }}</p>

          <ul class="sweep-list">
            <li v-for="item in candidates" :key="item.shortId" class="sweep-item">
              <div class="sweep-item-head">
                <div class="sweep-check">
                  <input
                    type="checkbox"
                    :aria-label="`选择 ${item.title}`"
                    :checked="selectedShortIds.includes(item.shortId)"
                    :disabled="applying"
                    @change="toggleCandidate(item.shortId)"
                  />
                  <RouterLink
                    :to="entryRoute(item.shortId)"
                    class="text-primary font-medium"
                    @click="open = false"
                  >
                    {{ item.title }}
                  </RouterLink>
                </div>
                <span class="sweep-meta tabular-nums">
                  <span class="font-mono">{{ item.shortId }}</span>
                  <span v-if="item.isPinned" class="mini-pill">常驻</span>
                  <span>{{ item.beforeChars }} → {{ item.afterChars }} 字</span>
                </span>
              </div>

              <div class="fix-tags">
                <span v-for="fix in item.fixes" :key="fix" class="fix-tag">
                  {{ hygieneFixLabels[fix] }}
                </span>
                <UButton
                  type="button"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.compare"
                  :loading="Boolean(previewLoading[item.shortId])"
                  :aria-expanded="expandedPreviewIds.includes(item.shortId)"
                  class="ml-auto"
                  @click="togglePreviewDiff(item)"
                >
                  {{ expandedPreviewIds.includes(item.shortId) ? '收起改动' : '预览改动' }}
                </UButton>
              </div>

              <div v-if="expandedPreviewIds.includes(item.shortId)" class="mt-1">
                <p v-if="previewErrors[item.shortId]" class="text-xs text-error">
                  {{ previewErrors[item.shortId] }}
                </p>
                <USkeleton v-else-if="previewLoading[item.shortId]" class="h-20 w-full" />
                <DiffViewer
                  v-else-if="previewDiffs[item.shortId]"
                  :before="previewDiffs[item.shortId]!.before"
                  :after="previewDiffs[item.shortId]!.after"
                  :context="2"
                  :expand-step="10"
                  max-height="18rem"
                />
              </div>

              <ul v-if="item.rewrites.length" class="rewrite-list">
                <li v-for="(rw, idx) in item.rewrites" :key="idx">
                  <span class="font-mono text-muted">{{ rw.raw }}</span>
                  <UIcon :name="icons.inherits" class="rewrite-arrow" aria-hidden="true" />
                  <span class="font-mono text-highlighted">{{ rw.replacement }}</span>
                  <span class="text-muted">（{{ rw.targetTitle }}）</span>
                </li>
              </ul>

              <p v-if="item.unresolvedRefs.length" class="unresolved-note">
                未匹配到的旧引用（保留原文）：{{ item.unresolvedRefs.join('、') }}
              </p>
            </li>
          </ul>
        </section>

        <!-- 疑似残缺记忆 -->
        <section v-if="suspectTruncated.length" ref="truncatedSectionRef" class="sweep-section">
          <SectionHeading title="疑似残缺记忆" :level="3" />
          <p class="text-xs text-muted">篇幅异常偏短，建议核对版本历史</p>
          <ul class="flag-list">
            <li v-for="flag in suspectTruncated" :key="flag.shortId" class="flag-item is-error">
              <div class="flag-head">
                <RouterLink
                  :to="entryRoute(flag.shortId)"
                  class="text-primary font-medium"
                  @click="open = false"
                >
                  {{ flag.title }}
                </RouterLink>
                <span class="sweep-meta tabular-nums">
                  <span class="font-mono">{{ flag.shortId }}</span>
                  <span v-if="flag.isPinned" class="mini-pill">常驻</span>
                  <span>{{ flag.charCount }} 字</span>
                </span>
              </div>
              <p class="flag-reason">{{ flag.reason }}</p>
            </li>
          </ul>
        </section>

        <!-- 疑似过时记忆 -->
        <section v-if="suspectObsolete.length" ref="obsoleteSectionRef" class="sweep-section">
          <SectionHeading title="疑似过时记忆" :level="3" />
          <p class="text-xs text-muted">阶段性或已停用，建议核实更新</p>
          <ul class="flag-list">
            <li v-for="flag in suspectObsolete" :key="flag.shortId" class="flag-item is-warning">
              <div class="flag-head">
                <RouterLink
                  :to="entryRoute(flag.shortId)"
                  class="text-primary font-medium"
                  @click="open = false"
                >
                  {{ flag.title }}
                </RouterLink>
                <span class="sweep-meta tabular-nums">
                  <span class="font-mono">{{ flag.shortId }}</span>
                  <span v-if="flag.isPinned" class="mini-pill">常驻</span>
                  <span>{{ flag.charCount }} 字</span>
                </span>
              </div>
              <p class="flag-reason">{{ flag.reason }}</p>
            </li>
          </ul>
        </section>
        <!-- 悬空断链记忆 -->
        <section v-if="brokenLinks.length" ref="brokenLinksSectionRef" class="sweep-section">
          <SectionHeading title="悬空断链记忆" :level="3" />
          <p class="text-xs text-muted">指向已删除或不存在的目标</p>
          <ul class="flag-list">
            <li v-for="item in brokenLinks" :key="item.shortId" class="flag-item is-warning">
              <div class="flag-head">
                <RouterLink
                  :to="entryRoute(item.shortId)"
                  class="text-primary font-medium"
                  @click="open = false"
                >
                  {{ item.title }}
                </RouterLink>
                <span class="sweep-meta tabular-nums">
                  <span class="font-mono">{{ item.shortId }}</span>
                  <span v-if="item.isPinned" class="mini-pill">常驻</span>
                  <span>{{ item.targets.length }} 处断链</span>
                </span>
              </div>
              <p class="flag-reason font-mono">
                {{
                  item.targets
                    .map(
                      (t) =>
                        `[[${t.targetShortId}]]（${t.status === 'deleted' ? `已删除：${t.targetTitle ?? ''}` : '不存在'}）`,
                    )
                    .join('；')
                }}
              </p>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
.sweep-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.sweep-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
  gap: 1px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-border);
}
.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  background: var(--ui-bg-muted);
  text-align: left;
}
.stat-cell.is-clickable {
  cursor: pointer;
}
.stat-cell.is-clickable:hover {
  background: var(--ui-bg-elevated);
}
.stat-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.stat-val {
  font-size: 15px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.sweep-head-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.sweep-head-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.sweep-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sweep-list,
.flag-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sweep-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.sweep-item-head,
.flag-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px 12px;
  font-size: 13px;
}
.sweep-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.sweep-check input[type='checkbox'] {
  flex: none;
  accent-color: var(--ui-primary);
  cursor: pointer;
}
.sweep-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.mini-pill {
  padding: 0 5px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  line-height: 1.35;
  color: var(--ui-text-highlighted);
}
.fix-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.fix-tag {
  padding: 1px 6px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
  font-size: 12px;
  color: var(--ui-text-toned);
}
.rewrite-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  border-left: 2px solid var(--ui-success);
  background: var(--ui-bg-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.rewrite-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.rewrite-arrow {
  display: inline-block;
  width: 12px;
  height: 12px;
  color: var(--ui-text-dimmed);
}
.unresolved-note {
  font-size: 12px;
  color: var(--ui-warning);
  overflow-wrap: anywhere;
}
.flag-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-left: 3px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.flag-item.is-error {
  border-left-color: var(--ui-error);
}
.flag-item.is-warning {
  border-left-color: var(--ui-warning);
}
.flag-reason {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
</style>
