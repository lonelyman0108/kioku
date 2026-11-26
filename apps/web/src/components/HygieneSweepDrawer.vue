<script setup lang="ts">
import type { HygieneSweepCandidate, HygieneSweepPreviewResponse } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { hygieneFixLabels } from '../labels'
import { entryRoute } from '../routes'
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

const selectedShortIds = ref<string[]>([])
const selectionInitialized = ref(false)
const applying = ref(false)
const applyError = ref<string | null>(null)

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
    suspectObsolete.value.length === 0,
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
    v-model:open="open"
    side="right"
    title="结构体检与预清洗"
    description="无需对话模型，零误差检查重复标题、旧版关键词行、断链引用与异常记忆"
    :dismissible="!applying"
    :ui="{ content: 'max-w-2xl sm:max-w-2xl' }"
  >
    <template #body>
      <ReadFailureNote v-if="previewQuery.isError.value" :query="previewQuery" />
      <div v-else-if="previewQuery.isPending.value && !report" class="space-y-3">
        <USkeleton class="h-14 w-full" />
        <USkeleton v-for="n in 4" :key="n" class="h-20 w-full" />
      </div>

      <div v-else-if="report" class="sweep-body">
        <!-- 扫描概览 -->
        <div class="sweep-stats tabular-nums">
          <div class="stat-cell">
            <span class="stat-label">已扫描记忆</span>
            <span class="stat-val">{{ report.totalScanned }} 条</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label">可确定性预清洗</span>
            <span class="stat-val">{{ candidates.length }} 条</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label">待规范标题</span>
            <span class="stat-val" :class="{ 'text-warning': report.dirtyTitleCount > 0 }">
              {{ report.dirtyTitleCount }} 条
            </span>
          </div>
          <div class="stat-cell">
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
          </div>
        </div>

        <div class="sweep-toolbar">
          <span class="text-xs text-muted">
            确定性预清洗只做安全结构修复，原有完整内容均保存在版本历史中，可随时恢复。
          </span>
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.refresh"
            :loading="previewQuery.isFetching.value"
            :disabled="applying"
            @click="previewQuery.refetch()"
          >
            重新扫描
          </UButton>
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
        <section v-if="candidates.length" class="sweep-section">
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
        <section v-if="suspectTruncated.length" class="sweep-section">
          <SectionHeading title="疑似残缺记忆" :level="3" />
          <p class="text-xs text-muted">
            正文篇幅异常偏短或可能被局部片段覆盖，建议打开记忆查看版本历史确认。
          </p>
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
        <section v-if="suspectObsolete.length" class="sweep-section">
          <SectionHeading title="疑似过时记忆" :level="3" />
          <p class="text-xs text-muted">
            疑似阶段性记录或已停用记忆，建议核实后决定保留、更新或移入回收站。
          </p>
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
.sweep-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
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
