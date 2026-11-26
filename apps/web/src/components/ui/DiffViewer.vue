<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  buildDiffDisplayChunks,
  buildDiffVisibilityMask,
  buildSplitDiffPairs,
  computeStructuredDiff,
  expandDiffGap,
  type InlineDiffPart,
  type NumberedDiffLine,
} from '../../diff'
import { icons } from '../../icons'
import SegmentedChoice from '../SegmentedChoice.vue'

export type DiffLayoutMode = 'unified' | 'split'
export type DiffContextMode = 'folded' | 'full'

const props = withDefaults(
  defineProps<{
    before: string | null
    after: string
    context?: number
    expandStep?: number
    defaultLayout?: DiffLayoutMode
    showToolbar?: boolean
    allowSplit?: boolean
    maxHeight?: string
    emptyText?: string
  }>(),
  {
    context: 3,
    expandStep: 10,
    defaultLayout: 'unified',
    showToolbar: true,
    allowSplit: true,
    maxHeight: undefined,
    emptyText: '正文未改动',
  },
)

const layout = defineModel<DiffLayoutMode>('layout')
const contextMode = defineModel<DiffContextMode>('contextMode')

const internalLayout = ref<DiffLayoutMode>(props.defaultLayout)
const internalContext = ref<DiffContextMode>('folded')

const activeLayout = computed<DiffLayoutMode>({
  get: () => layout.value ?? internalLayout.value,
  set: (v: DiffLayoutMode) => {
    internalLayout.value = v
    if (layout.value !== undefined) layout.value = v
  },
})

const activeContext = computed<DiffContextMode>({
  get: () => contextMode.value ?? internalContext.value,
  set: (v: DiffContextMode) => {
    internalContext.value = v
    if (contextMode.value !== undefined) contextMode.value = v
  },
})

const LAYOUT_OPTIONS = [
  { value: 'unified' as const, label: '单栏', icon: icons.unifiedDiff, title: '单栏合并对比' },
  { value: 'split' as const, label: '双栏', icon: icons.splitPane, title: '左右双栏对比' },
]

const CONTEXT_OPTIONS = [
  {
    value: 'folded' as const,
    label: '折叠',
    icon: icons.foldVertical,
    title: '折叠未改动上下文并保持紧凑高度',
  },
  {
    value: 'full' as const,
    label: '全文',
    icon: icons.unfoldVertical,
    title: '展开全部未改动行与完整高度',
  },
]

const structured = computed(() => computeStructuredDiff(props.before, props.after))
const hasChanges = computed(
  () => structured.value.addedCount > 0 || structured.value.removedCount > 0,
)
const defaultMask = computed(() =>
  buildDiffVisibilityMask(structured.value.lines, structured.value.hunkStarts, props.context),
)
const hasFoldableGaps = computed(() => defaultMask.value.some((visible) => !visible))

// 每行是否处于已展开可见态（支持就地向上/向下按需加载上下文）
const visibleMask = ref<boolean[]>([])
const manualExpanded = ref(false)
const focusedHunk = ref(0)
const rootRef = ref<HTMLElement | null>(null)
const scrollRef = ref<HTMLElement | null>(null)
const tableRef = ref<HTMLElement | null>(null)
const containerWidth = ref<number>(1024)
const tableHeight = ref<number>(0)
const resolvedMaxHeightPx = ref<number | null>(null)
let rootObserver: ResizeObserver | null = null
let tableObserver: ResizeObserver | null = null

const isSplit = computed(
  () => props.allowSplit && activeLayout.value === 'split' && containerWidth.value >= 640,
)

const isHeightClamped = computed(() => activeContext.value === 'folded' && Boolean(props.maxHeight))

function measureMaxHeightPx() {
  if (!props.maxHeight) {
    resolvedMaxHeightPx.value = null
    return
  }
  const el = scrollRef.value
  if (!el || typeof window === 'undefined') return
  if (isHeightClamped.value) {
    const computedPx = Number.parseFloat(getComputedStyle(el).maxHeight)
    if (Number.isFinite(computedPx) && computedPx > 0) {
      resolvedMaxHeightPx.value = computedPx
    }
  }
}

const overflowsMaxHeight = computed(
  () =>
    Boolean(props.maxHeight) &&
    resolvedMaxHeightPx.value !== null &&
    tableHeight.value > resolvedMaxHeightPx.value + 4,
)

// 处于全文态且启用了 maxHeight 时保留收起入口，避免宽屏/双栏或滚动条消失引起按钮瞬隐而卡在全文态
const canToggleContext = computed(
  () =>
    hasFoldableGaps.value ||
    overflowsMaxHeight.value ||
    (activeContext.value === 'full' && Boolean(props.maxHeight)),
)
const showBottomToggle = computed(
  () =>
    Boolean(props.maxHeight) &&
    (overflowsMaxHeight.value || hasFoldableGaps.value || activeContext.value === 'full'),
)

function onWindowResize() {
  measureMaxHeightPx()
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onWindowResize)
  }
  if (rootRef.value && typeof ResizeObserver !== 'undefined') {
    containerWidth.value = rootRef.value.clientWidth || 1024
    rootObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined && w > 0) containerWidth.value = w
    })
    rootObserver.observe(rootRef.value)
  }
  measureMaxHeightPx()
})

watch(
  [scrollRef, () => props.maxHeight, isHeightClamped],
  () => {
    measureMaxHeightPx()
  },
  { flush: 'post' },
)

watch(
  tableRef,
  (el) => {
    tableObserver?.disconnect()
    tableObserver = null
    if (!el) {
      tableHeight.value = 0
      return
    }
    tableHeight.value = el.scrollHeight || el.getBoundingClientRect().height
    if (typeof ResizeObserver !== 'undefined') {
      tableObserver = new ResizeObserver((entries) => {
        const h = entries[0]?.contentRect.height
        if (h !== undefined) tableHeight.value = h
      })
      tableObserver.observe(el)
    }
  },
  { flush: 'post' },
)

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', onWindowResize)
  }
  rootObserver?.disconnect()
  rootObserver = null
  tableObserver?.disconnect()
  tableObserver = null
})

function gapRangeText(start: number, end: number): string {
  const first = structured.value.lines[start]
  const last = structured.value.lines[end - 1]
  const from = first?.newLine ?? first?.oldLine ?? start + 1
  const to = last?.newLine ?? last?.oldLine ?? end
  return from === to ? `第 ${from} 行未改动` : `第 ${from}–${to} 行未改动`
}

function resetVisibility(resetFocus = true) {
  visibleMask.value = [...defaultMask.value]
  manualExpanded.value = false
  if (resetFocus) focusedHunk.value = 0
}

watch([() => props.before, () => props.after, () => props.context], () => resetVisibility(true), {
  immediate: true,
})

watch(activeContext, (mode) => {
  if (mode === 'folded') {
    resetVisibility(false)
  }
})

const chunks = computed(() =>
  buildDiffDisplayChunks(structured.value.lines, visibleMask.value, activeContext.value === 'full'),
)

const focusedLineIndex = computed(() => structured.value.hunkStarts[focusedHunk.value] ?? -1)

async function expandGap(start: number, end: number, direction: 'up' | 'down' | 'all') {
  const next = expandDiffGap(visibleMask.value, start, end, direction, props.expandStep)
  visibleMask.value = next
  manualExpanded.value = true
  if (!next.every(Boolean)) return
  if (!props.maxHeight) {
    activeContext.value = 'full'
    return
  }
  // 带高度上限的卡片手工展开完所有省略段后，若此时并未超出高度，则同步到「全文」态避免出现无效点击
  await nextTick()
  measureMaxHeightPx()
  const actualHeight = tableRef.value?.scrollHeight ?? tableHeight.value
  const limit = resolvedMaxHeightPx.value
  if (visibleMask.value.every(Boolean) && (limit === null || actualHeight <= limit + 4)) {
    activeContext.value = 'full'
  }
}

function resetExpansion() {
  resetVisibility(false)
}

function jumpHunk(delta: number) {
  const starts = structured.value.hunkStarts
  if (!starts.length) return
  focusedHunk.value = (focusedHunk.value + delta + starts.length) % starts.length
  const targetIdx = starts[focusedHunk.value]!
  const row = rootRef.value?.querySelector<HTMLElement>(`tr[data-line-idx="${targetIdx}"]`)
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function splitPairsOf(start: number, end: number) {
  return buildSplitDiffPairs(structured.value.lines, start, end)
}

function sliceLines(start: number, end: number): NumberedDiffLine[] {
  return structured.value.lines.slice(start, end)
}

function partClass(part: InlineDiffPart): string | undefined {
  if (part.kind === 'add') return 'diff-mark-add'
  if (part.kind === 'remove') return 'diff-mark-del'
  return undefined
}

defineExpose({
  jumpHunk,
  resetExpansion,
  hunkCount: computed(() => structured.value.hunkStarts.length),
  addedCount: computed(() => structured.value.addedCount),
  removedCount: computed(() => structured.value.removedCount),
  focusedHunk: computed(() => focusedHunk.value),
  hasFoldableGaps,
  canToggleContext,
  manualExpanded: computed(() => manualExpanded.value),
})
</script>

<template>
  <div ref="rootRef" class="diff-root">
    <div v-if="showToolbar && hasChanges" class="diff-toolbar">
      <div class="toolbar-group">
        <SegmentedChoice
          v-if="allowSplit"
          v-model="activeLayout"
          :items="LAYOUT_OPTIONS"
          label="对比排版方式"
          compact
          class="layout-switch"
        />
        <SegmentedChoice
          v-if="canToggleContext"
          v-model="activeContext"
          :items="CONTEXT_OPTIONS"
          label="上下文折叠模式"
          compact
        />
        <UButton
          v-if="activeContext === 'folded' && manualExpanded"
          type="button"
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="icons.foldVertical"
          @click="resetExpansion"
        >
          重新折叠
        </UButton>
      </div>

      <div class="toolbar-group">
        <span class="diff-stats tabular-nums">
          <span class="stat-add">+{{ structured.addedCount }}</span>
          <span class="stat-del">−{{ structured.removedCount }}</span>
          <span v-if="structured.hunkStarts.length" class="stat-hunks">
            · {{ focusedHunk + 1 }}/{{ structured.hunkStarts.length }} 处
          </span>
        </span>
        <template v-if="structured.hunkStarts.length > 1">
          <UButton
            type="button"
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.up"
            @click="jumpHunk(-1)"
          >
            上一处
          </UButton>
          <UButton
            type="button"
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.down"
            @click="jumpHunk(1)"
          >
            下一处
          </UButton>
        </template>
      </div>
    </div>

    <p v-if="!structured.complete" class="diff-incomplete-note">改动跨度较大，已按整段增删展示。</p>

    <p v-if="!hasChanges" class="diff-empty">{{ emptyText }}</p>

    <div
      v-else
      ref="scrollRef"
      class="diff-scroll"
      :class="{ 'is-split': isSplit }"
      :style="isHeightClamped ? { maxHeight } : undefined"
    >
      <table ref="tableRef" class="diff-table">
        <colgroup v-if="isSplit">
          <col class="col-w-ln" />
          <col class="col-w-sign" />
          <col />
          <col class="col-w-ln" />
          <col class="col-w-sign" />
          <col />
        </colgroup>
        <colgroup v-else>
          <col class="col-w-ln" />
          <col class="col-w-ln" />
          <col class="col-w-sign" />
          <col />
        </colgroup>

        <tbody>
          <template
            v-for="(chunk, chunkIdx) in chunks"
            :key="`${chunk.kind}-${chunk.start}-${chunkIdx}`"
          >
            <!-- 可交互折叠区间：支持向上/向下按需多看上下文，无需离开对比视图 -->
            <tr v-if="chunk.kind === 'gap'" class="row-gap">
              <td :colspan="isSplit ? 6 : 4">
                <div class="gap-bar">
                  <div class="gap-actions">
                    <button
                      v-if="chunk.start > 0 && chunk.count > expandStep"
                      type="button"
                      class="gap-btn"
                      @click="expandGap(chunk.start, chunk.end, 'down')"
                    >
                      <UIcon :name="icons.chevronsDown" class="gap-icon" aria-hidden="true" />
                      <span>向下 {{ expandStep }} 行</span>
                    </button>
                    <button
                      type="button"
                      class="gap-btn"
                      @click="expandGap(chunk.start, chunk.end, 'all')"
                    >
                      <UIcon :name="icons.unfoldVertical" class="gap-icon" aria-hidden="true" />
                      <span>展开 {{ chunk.count }} 行</span>
                    </button>
                    <button
                      v-if="chunk.end < structured.lines.length && chunk.count > expandStep"
                      type="button"
                      class="gap-btn"
                      @click="expandGap(chunk.start, chunk.end, 'up')"
                    >
                      <UIcon :name="icons.chevronsUp" class="gap-icon" aria-hidden="true" />
                      <span>向上 {{ expandStep }} 行</span>
                    </button>
                  </div>
                  <span class="gap-context">
                    <template v-if="chunk.sectionHeading">
                      <span class="gap-anchor">{{ chunk.sectionHeading }}</span>
                    </template>
                    <template v-else>{{ gapRangeText(chunk.start, chunk.end) }}</template>
                  </span>
                </div>
              </td>
            </tr>

            <!-- 左右双栏 Split -->
            <template v-else-if="isSplit">
              <tr
                v-for="pair in splitPairsOf(chunk.start, chunk.end)"
                :key="`${pair.index}-${pair.left?.oldLine ?? 'n'}-${pair.right?.newLine ?? 'n'}`"
                :data-line-idx="pair.index"
                :class="{ 'row-focus': pair.index === focusedLineIndex }"
              >
                <td
                  class="cell-ln tabular-nums"
                  :class="pair.left ? `cell-${pair.left.kind}` : 'cell-pad'"
                >
                  {{ pair.left?.oldLine ?? '' }}
                </td>
                <td class="cell-sign" :class="pair.left ? `cell-${pair.left.kind}` : 'cell-pad'">
                  {{ pair.left?.kind === 'remove' ? '−' : '' }}
                </td>
                <td class="cell-code" :class="pair.left ? `cell-${pair.left.kind}` : 'cell-pad'">
                  <template v-if="pair.left && pair.left.parts.length">
                    <template v-for="(part, pIdx) in pair.left.parts" :key="pIdx">
                      <mark v-if="partClass(part)" :class="partClass(part)">{{ part.text }}</mark>
                      <template v-else>{{ part.text }}</template>
                    </template>
                  </template>
                  <template v-else>&nbsp;</template>
                </td>

                <td
                  class="cell-ln split-mid tabular-nums"
                  :class="pair.right ? `cell-${pair.right.kind}` : 'cell-pad'"
                >
                  {{ pair.right?.newLine ?? '' }}
                </td>
                <td class="cell-sign" :class="pair.right ? `cell-${pair.right.kind}` : 'cell-pad'">
                  {{ pair.right?.kind === 'add' ? '+' : '' }}
                </td>
                <td class="cell-code" :class="pair.right ? `cell-${pair.right.kind}` : 'cell-pad'">
                  <template v-if="pair.right && pair.right.parts.length">
                    <template v-for="(part, pIdx) in pair.right.parts" :key="pIdx">
                      <mark v-if="partClass(part)" :class="partClass(part)">{{ part.text }}</mark>
                      <template v-else>{{ part.text }}</template>
                    </template>
                  </template>
                  <template v-else>&nbsp;</template>
                </td>
              </tr>
            </template>

            <!-- 单栏 Unified -->
            <template v-else>
              <tr
                v-for="line in sliceLines(chunk.start, chunk.end)"
                :key="line.index"
                :data-line-idx="line.index"
                :class="[`row-${line.kind}`, { 'row-focus': line.index === focusedLineIndex }]"
              >
                <td class="cell-ln tabular-nums">{{ line.oldLine ?? '' }}</td>
                <td class="cell-ln tabular-nums">{{ line.newLine ?? '' }}</td>
                <td class="cell-sign">
                  {{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : '' }}
                </td>
                <td class="cell-code">
                  <template v-if="line.parts.length">
                    <template v-for="(part, pIdx) in line.parts" :key="pIdx">
                      <mark v-if="partClass(part)" :class="partClass(part)">{{ part.text }}</mark>
                      <template v-else>{{ part.text }}</template>
                    </template>
                  </template>
                  <template v-else>&nbsp;</template>
                </td>
              </tr>
            </template>
          </template>
        </tbody>
      </table>
    </div>

    <button
      v-if="hasChanges && showBottomToggle"
      type="button"
      class="diff-expand-footer"
      :aria-expanded="activeContext === 'full'"
      @click="activeContext = activeContext === 'folded' ? 'full' : 'folded'"
    >
      <UIcon
        :name="activeContext === 'folded' ? icons.unfoldVertical : icons.foldVertical"
        class="gap-icon"
        aria-hidden="true"
      />
      <span v-if="activeContext === 'folded'" class="tabular-nums">
        展开完整对比（共 {{ structured.lines.length }} 行）
      </span>
      <span v-else>收起对比视图</span>
    </button>
  </div>
</template>

<style scoped>
.diff-root {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
}
.diff-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.toolbar-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.diff-stats {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.stat-add {
  color: var(--ui-success);
  font-weight: 600;
}
.stat-del {
  color: var(--ui-error);
  font-weight: 600;
}
.stat-hunks {
  font-family: var(--font-sans);
  color: var(--ui-text-muted);
}
.diff-incomplete-note {
  padding: 5px 10px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  color: var(--ui-warning);
}
.diff-empty {
  padding: 12px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.diff-scroll {
  overflow: auto;
}
.diff-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.65;
}
.col-w-ln {
  width: 44px;
}
.col-w-sign {
  width: 22px;
}
.cell-ln {
  padding: 1px 8px 1px 4px;
  border-right: 1px solid var(--ui-border-muted);
  background: var(--ui-bg-muted);
  text-align: right;
  vertical-align: top;
  font-size: 12px;
  color: var(--ui-text-dimmed);
  user-select: none;
}
.cell-sign {
  padding: 1px 0;
  text-align: center;
  vertical-align: top;
  font-weight: 700;
  user-select: none;
}
.cell-code {
  padding: 1px 10px 1px 6px;
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ui-text-toned);
}
.split-mid {
  border-left: 1px solid var(--ui-border-accented);
}

/* 单栏行态着色 */
.row-add td {
  background: var(--ui-diff-add-bg);
}
.row-add .cell-ln {
  background: var(--ui-diff-add-gutter);
  border-right-color: var(--ui-diff-add-mark);
  color: var(--ui-success);
}
.row-add .cell-sign {
  color: var(--ui-success);
}
.row-add .cell-code {
  color: var(--ui-text-highlighted);
}
.row-remove td {
  background: var(--ui-diff-del-bg);
}
.row-remove .cell-ln {
  background: var(--ui-diff-del-gutter);
  border-right-color: var(--ui-diff-del-mark);
  color: var(--ui-error);
}
.row-remove .cell-sign {
  color: var(--ui-error);
}
.row-remove .cell-code {
  color: var(--ui-text);
}

/* 双栏单元格态着色 */
.cell-add {
  background: var(--ui-diff-add-bg);
}
.cell-ln.cell-add {
  background: var(--ui-diff-add-gutter);
  border-right-color: var(--ui-diff-add-mark);
  color: var(--ui-success);
}
.cell-sign.cell-add {
  color: var(--ui-success);
}
.cell-code.cell-add {
  color: var(--ui-text-highlighted);
}
.cell-remove {
  background: var(--ui-diff-del-bg);
}
.cell-ln.cell-remove {
  background: var(--ui-diff-del-gutter);
  border-right-color: var(--ui-diff-del-mark);
  color: var(--ui-error);
}
.cell-sign.cell-remove {
  color: var(--ui-error);
}
.cell-code.cell-remove {
  color: var(--ui-text);
}
.cell-pad {
  background: var(--ui-bg-muted);
}

/* 行内词级高亮（去掉破坏中文的删除线） */
.diff-mark-add {
  padding: 0 1px;
  background: var(--ui-diff-add-mark);
  color: var(--ui-text-highlighted);
  font-weight: 600;
}
.diff-mark-del {
  padding: 0 1px;
  background: var(--ui-diff-del-mark);
  color: var(--ui-text-highlighted);
}

/* 当前跳转聚焦改动点 */
.row-focus > td:first-child {
  border-left: 3px solid var(--ui-rule);
}

/* 可交互上下文展开条 */
.row-gap td {
  padding: 0;
  border-top: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-diff-hunk-bg);
}
.gap-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 4px 10px;
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--ui-diff-hunk-fg);
}
.gap-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.gap-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border: 1px solid var(--ui-diff-hunk-fg);
  background: var(--ui-bg);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ui-diff-hunk-fg);
  cursor: pointer;
}
.gap-btn:hover {
  border-color: var(--ui-selected);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.gap-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.gap-context {
  font-size: 12px;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.gap-anchor {
  font-weight: 600;
  color: var(--ui-diff-hunk-fg);
}
.diff-expand-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.diff-expand-footer:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

/* 窄容器下隐藏双栏切换，避免过窄断行 */
@container (max-width: 639.98px) {
  .layout-switch {
    display: none;
  }
}
</style>
