<script setup lang="ts">
import type { DreamFailedItem, DreamMode, DreamState, DreamSuggestionKind } from '@kioku/contracts'
import type { DropdownMenuItem } from '@nuxt/ui'
import { computed, ref } from 'vue'

import { icons } from '../icons'
import { dreamKindIcons, dreamKindLabels, dreamModeLabels, dreamOutcomeLabels } from '../labels'
import { entryRoute, settingsRoute } from '../routes'
import { formatRelative, formatTime } from '../time'

export type OrganizeScopeFilter = 'all' | 'review' | 'safe'

export interface OrganizeKindOption {
  kind: DreamSuggestionKind
  count: number
}

export interface OrganizeScheduleItem {
  mode: DreamMode
  label: string
  icon: string
  enabled: boolean
  intervalHours: number
  lastRunAt: string | null
}

const props = defineProps<{
  scopeFilter: OrganizeScopeFilter
  kindFilter: 'all' | DreamSuggestionKind
  totalCount: number
  reviewCount: number
  safeCount: number
  nonZeroKinds: readonly OrganizeKindOption[]
  tidyPendingCount: number
  hasChatModel: boolean
  meLoaded: boolean
  state: DreamState | null
  scheduleItems: readonly OrganizeScheduleItem[]
  scheduleSummaryText: string
  runningStageLabel: string
  runningModeIcon: string
  progressPercent: number
  showFailureBanner: boolean
  latestFailedItems: readonly DreamFailedItem[]
  latestRetryableShortIds: readonly string[]
  latestRunMode: DreamMode
  standardBusy: boolean
  retryFailedBusy: boolean
  cancellingDream: boolean
  modelRunDisabled: boolean
  tidyMenuItems: DropdownMenuItem[][]
}>()

const emit = defineEmits<{
  'update:scopeFilter': [value: OrganizeScopeFilter]
  'update:kindFilter': [value: 'all' | DreamSuggestionKind]
  runStandard: []
  runTidySingle: []
  runCrossMemory: []
  openSweep: []
  cancelDream: []
  retryFailed: []
  dismissFailure: []
}>()

const statusPopoverOpen = ref(false)
const failedDetailsOpen = ref(false)

const progress = computed(() => props.state?.progress ?? null)
const latestRun = computed(() => props.state?.recentRuns[0] ?? null)
const hasEnabledSchedule = computed(() => props.scheduleItems.some((item) => item.enabled))

function formatScheduleInterval(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) {
    return `每 ${hours / 24} 天（${hours}h）`
  }
  return `每 ${hours} 小时`
}

function selectScope(next: OrganizeScopeFilter) {
  emit('update:scopeFilter', next)
}

function selectKind(kind: DreamSuggestionKind) {
  emit('update:kindFilter', props.kindFilter === kind ? 'all' : kind)
}

function openFailureDetailsPopover() {
  failedDetailsOpen.value = true
  statusPopoverOpen.value = true
}

function onRetryFromPopover() {
  statusPopoverOpen.value = false
  emit('retryFailed')
}
</script>

<template>
  <aside class="index-rail" aria-label="整理目录与运行状态">
    <div class="rail-scroll">
      <nav class="tree-group" aria-label="待确认视图">
        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': kindFilter === 'all' && scopeFilter === 'all' }"
          :aria-current="kindFilter === 'all' && scopeFilter === 'all' ? 'page' : undefined"
          @click="selectScope('all')"
        >
          <span class="tree-item-lead">
            <UIcon :name="icons.layers" class="tree-icon" aria-hidden="true" />
            <span>全部待确认</span>
          </span>
          <span class="tree-count tabular-nums">{{ totalCount }}</span>
        </button>

        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': kindFilter === 'all' && scopeFilter === 'review' }"
          :aria-current="kindFilter === 'all' && scopeFilter === 'review' ? 'page' : undefined"
          title="含合并重复、移入回收站、正文变动或存在完整性提示的建议，须逐条核对"
          @click="selectScope('review')"
        >
          <span class="tree-item-lead">
            <span class="risk-swatch is-review" aria-hidden="true" />
            <UIcon :name="icons.lock" class="tree-icon" aria-hidden="true" />
            <span>须逐条核对</span>
          </span>
          <span
            class="tree-count tabular-nums"
            :class="{
              'is-hot': reviewCount > 0 && !(kindFilter === 'all' && scopeFilter === 'review'),
            }"
          >
            {{ reviewCount }}
          </span>
        </button>

        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': kindFilter === 'all' && scopeFilter === 'safe' }"
          :aria-current="kindFilter === 'all' && scopeFilter === 'safe' ? 'page' : undefined"
          title="无引用缺失的标题/概要规范、启动加载调整与双链补全建议，支持批量安全应用"
          @click="selectScope('safe')"
        >
          <span class="tree-item-lead">
            <span class="risk-swatch is-safe" aria-hidden="true" />
            <UIcon :name="icons.shieldCheck" class="tree-icon" aria-hidden="true" />
            <span>安全快批</span>
          </span>
          <span
            class="tree-count tabular-nums"
            :class="{
              'is-safe': safeCount > 0 && !(kindFilter === 'all' && scopeFilter === 'safe'),
            }"
          >
            {{ safeCount }}
          </span>
        </button>
      </nav>

      <template v-if="nonZeroKinds.length > 0">
        <div class="rail-divider" aria-hidden="true" />
        <div class="rail-section-title">建议类型</div>
        <nav class="tree-group" aria-label="按建议类型筛选">
          <button
            v-for="item in nonZeroKinds"
            :key="item.kind"
            type="button"
            class="tree-item"
            :class="{ 'is-active': kindFilter === item.kind }"
            :aria-current="kindFilter === item.kind ? 'page' : undefined"
            @click="selectKind(item.kind)"
          >
            <span class="tree-item-lead">
              <UIcon :name="dreamKindIcons[item.kind]" class="tree-icon" aria-hidden="true" />
              <span class="tree-label-text">{{ dreamKindLabels[item.kind] }}</span>
            </span>
            <span class="tree-count tabular-nums">{{ item.count }}</span>
          </button>
        </nav>
      </template>

      <div class="rail-divider" aria-hidden="true" />
      <div class="rail-section-title">发起整理</div>
      <div class="rail-actions">
        <template v-if="meLoaded && !hasChatModel">
          <UButton size="xs" :icon="icons.shieldCheck" block @click="emit('openSweep')">
            结构检查
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.models"
            :to="settingsRoute('models')"
            block
          >
            前往模型设置
          </UButton>
        </template>
        <template v-else>
          <UButton
            size="xs"
            :icon="icons.sparkles"
            :loading="standardBusy"
            :disabled="modelRunDisabled"
            block
            @click="emit('runStandard')"
          >
            {{ state?.running ? '整理中' : '增量整理' }}
          </UButton>

          <UDropdownMenu
            v-if="tidyPendingCount > 10"
            :items="tidyMenuItems"
            :content="{ align: 'start', side: 'right', sideOffset: 6 }"
            :ui="{ content: 'w-56' }"
          >
            <button
              type="button"
              class="rail-action-btn"
              :disabled="modelRunDisabled"
              title="逐条规范标题、补概要并归档旧日志"
            >
              <span class="rail-action-lead">
                <UIcon :name="icons.tidy" class="rail-action-icon" aria-hidden="true" />
                <span>规范整理</span>
              </span>
              <span class="rail-action-right">
                <span class="pending-chip tabular-nums">{{ tidyPendingCount }}</span>
                <UIcon :name="icons.chevronRight" class="rail-action-caret" aria-hidden="true" />
              </span>
            </button>
          </UDropdownMenu>
          <button
            v-else
            type="button"
            class="rail-action-btn"
            :disabled="modelRunDisabled || tidyPendingCount <= 0"
            :title="
              tidyPendingCount > 0 ? '逐条规范标题、补概要并归档旧日志' : '当前暂无待规范记忆'
            "
            @click="emit('runTidySingle')"
          >
            <span class="rail-action-lead">
              <UIcon :name="icons.tidy" class="rail-action-icon" aria-hidden="true" />
              <span>规范整理</span>
            </span>
            <span v-if="tidyPendingCount > 0" class="pending-chip tabular-nums">
              {{ tidyPendingCount }}
            </span>
          </button>

          <button
            type="button"
            class="rail-action-btn"
            :disabled="modelRunDisabled"
            title="全库扫描重复合并、补全双链与常驻巡检"
            @click="emit('runCrossMemory')"
          >
            <span class="rail-action-lead">
              <UIcon :name="icons.links" class="rail-action-icon" aria-hidden="true" />
              <span>查重与关联</span>
            </span>
          </button>

          <button
            type="button"
            class="rail-action-btn is-quiet"
            title="不消耗模型，检查并清理重复标题、旧引用与悬空断链"
            @click="emit('openSweep')"
          >
            <span class="rail-action-lead">
              <UIcon :name="icons.shieldCheck" class="rail-action-icon" aria-hidden="true" />
              <span>结构检查</span>
            </span>
          </button>
        </template>
      </div>
    </div>

    <!-- 底部固定调度与运行状态条（同记忆页 health-strip 视觉重心） -->
    <div
      class="rail-status"
      :class="{
        'is-running': Boolean(state?.running),
        'is-failed': !state?.running && showFailureBanner,
        'is-partial':
          !state?.running &&
          showFailureBanner &&
          (state?.lastOutcome === 'partial' || state?.lastOutcome === 'cancelled'),
      }"
    >
      <div
        v-if="state?.running"
        class="rail-progress-edge"
        role="progressbar"
        aria-label="整理进度"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="progressPercent"
      >
        <div class="rail-progress-fill" :style="{ width: `${progressPercent}%` }" />
      </div>

      <!-- 运行中状态 -->
      <template v-if="state?.running">
        <div class="status-row tabular-nums" role="status" aria-live="polite">
          <span class="status-lead is-running">
            <UIcon :name="runningModeIcon" class="status-icon" aria-hidden="true" />
            <span>{{ runningStageLabel }}</span>
          </span>
          <span v-if="progress && progress.total > 0" class="status-val">
            {{ progress.processed }} / {{ progress.total }}
          </span>
        </div>
        <p class="status-sub tabular-nums">
          <template v-if="progress">
            已生成 {{ progress.suggested }} 条<template v-if="progress.failed > 0"
              >，失败 {{ progress.failed }} 条</template
            >
          </template>
          <template v-else>正在准备候选记忆…</template>
        </p>
        <div class="status-btn-row">
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.stop"
            :loading="cancellingDream"
            class="flex-1"
            @click="emit('cancelDream')"
          >
            取消整理
          </UButton>
        </div>
      </template>

      <!-- 上次失败就地重试态 -->
      <template v-else-if="showFailureBanner">
        <div class="status-row tabular-nums" role="status">
          <span class="status-lead is-error">
            <UIcon
              :name="
                state?.lastOutcome === 'partial' || state?.lastOutcome === 'cancelled'
                  ? icons.warning
                  : icons.error
              "
              class="status-icon"
              aria-hidden="true"
            />
            <span v-if="latestFailedItems.length > 0">
              上次 {{ latestFailedItems.length }} 条失败
            </span>
            <span v-else>上次整理异常</span>
          </span>
          <button
            type="button"
            class="status-dismiss-btn"
            aria-label="关闭失败提示"
            @click="emit('dismissFailure')"
          >
            关闭
          </button>
        </div>
        <p v-if="state?.lastError" class="status-sub is-clamp">{{ state.lastError }}</p>
        <div class="status-btn-row">
          <UButton
            v-if="hasChatModel && latestRetryableShortIds.length > 0"
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.refresh"
            :loading="retryFailedBusy"
            :disabled="modelRunDisabled"
            class="flex-1"
            @click="emit('retryFailed')"
          >
            仅重试（{{ latestRetryableShortIds.length }}）
          </UButton>
          <UButton
            v-if="latestFailedItems.length > 0"
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="icons.reveal"
            @click="openFailureDetailsPopover"
          >
            明细
          </UButton>
        </div>
      </template>

      <!-- 空闲摘要态 -->
      <template v-else>
        <div class="status-row">
          <span class="status-label">
            <span
              class="status-sq"
              :class="hasEnabledSchedule ? 'is-on' : 'is-off'"
              aria-hidden="true"
            />
            <span>自动整理</span>
          </span>
          <span class="status-val tabular-nums">{{ scheduleSummaryText }}</span>
        </div>
        <div class="status-row">
          <span class="status-label">最近评估</span>
          <span
            v-if="state?.lastRunAt"
            class="status-val tabular-nums"
            :title="formatTime(state.lastRunAt)"
          >
            {{ formatRelative(state.lastRunAt) }}
          </span>
          <span v-else class="status-val">尚未整理</span>
        </div>
      </template>

      <!-- 调度与运行底账 Popover（所有状态均可打开查看） -->
      <UPopover
        v-model:open="statusPopoverOpen"
        :content="{ side: 'top', align: 'start', sideOffset: 6 }"
      >
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :icon="icons.calendarClock"
          :trailing-icon="icons.chevronUp"
          :aria-expanded="statusPopoverOpen"
          block
        >
          调度与运行底账
        </UButton>

        <template #content>
          <div class="status-popover">
            <div class="popover-head">
              <span class="popover-title">
                <UIcon :name="icons.calendarClock" class="popover-head-icon" aria-hidden="true" />
                <span>整理状态与定时</span>
              </span>
              <span class="popover-state" :class="{ 'is-active': state?.running }">
                {{ state?.running ? '整理中' : '空闲' }}
              </span>
            </div>

            <ul class="popover-schedules tabular-nums" aria-label="定时整理日程">
              <li v-for="sched in scheduleItems" :key="sched.mode" class="popover-sched-row">
                <span class="popover-sched-name">
                  <UIcon :name="sched.icon" class="popover-sched-icon" aria-hidden="true" />
                  <span>{{ sched.label }}</span>
                </span>
                <span class="popover-sched-val" :class="{ 'is-enabled': sched.enabled }">
                  {{ sched.enabled ? formatScheduleInterval(sched.intervalHours) : '已关闭' }}
                </span>
              </li>
            </ul>

            <dl class="kv-list tabular-nums">
              <dt>待规范记忆</dt>
              <dd>{{ tidyPendingCount }} 条</dd>
              <dt>对话模型</dt>
              <dd>{{ hasChatModel ? '已启用' : '未配置' }}</dd>
              <dt>上次整理</dt>
              <dd>
                <span v-if="state?.running">正在整理…</span>
                <template v-else-if="state?.lastRunAt">
                  {{ formatRelative(state.lastRunAt) }}
                  <template v-if="state.lastOutcome">
                    （{{ dreamOutcomeLabels[state.lastOutcome] }}）
                  </template>
                </template>
                <span v-else>尚未执行过</span>
              </dd>
              <template v-if="latestRun">
                <dt>最近批次</dt>
                <dd>
                  {{ dreamModeLabels[latestRun.mode ?? 'standard'] }} · 评估
                  {{ latestRun.considered }} 条，生成 {{ latestRun.suggested }} 条
                  <template v-if="latestRun.retriedCount">
                    （重试 {{ latestRun.retriedCount }} 次）
                  </template>
                </dd>
              </template>
            </dl>

            <p
              v-if="!state?.running && state?.lastError"
              class="popover-error"
              :class="{ 'is-partial': state.lastOutcome === 'partial' }"
            >
              <UIcon
                :name="state.lastOutcome === 'partial' ? icons.warning : icons.error"
                class="popover-error-icon"
                aria-hidden="true"
              />
              <span>
                {{ state.lastOutcome === 'partial' ? state.lastError : `错误：${state.lastError}` }}
              </span>
            </p>

            <div v-if="!state?.running && latestFailedItems.length > 0" class="popover-failures">
              <div class="failures-head tabular-nums">
                <span>失败明细（{{ latestFailedItems.length }} 条）</span>
                <button
                  type="button"
                  class="failures-toggle"
                  :aria-expanded="failedDetailsOpen"
                  @click="failedDetailsOpen = !failedDetailsOpen"
                >
                  <UIcon
                    :name="failedDetailsOpen ? icons.chevronDown : icons.chevronRight"
                    class="failures-toggle-icon"
                    aria-hidden="true"
                  />
                  <span>{{ failedDetailsOpen ? '收起' : '展开' }}</span>
                </button>
              </div>

              <ul v-if="failedDetailsOpen" class="failures-list">
                <li v-for="item in latestFailedItems" :key="item.shortId" class="failure-row">
                  <div class="failure-top">
                    <RouterLink
                      :to="entryRoute(item.shortId)"
                      class="failure-title text-primary font-medium"
                      :title="item.title ? `${item.title}（${item.shortId}）` : item.shortId"
                      @click="statusPopoverOpen = false"
                    >
                      {{ item.title || item.shortId }}
                    </RouterLink>
                  </div>
                  <p class="failure-reason">{{ item.reason }}</p>
                </li>
              </ul>

              <UButton
                v-if="hasChatModel && latestRetryableShortIds.length > 0"
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.refresh"
                :loading="retryFailedBusy"
                :disabled="modelRunDisabled"
                block
                @click="onRetryFromPopover"
              >
                仅重试失败项（{{ latestRetryableShortIds.length }} 条）
              </UButton>
            </div>

            <div class="popover-foot">
              <span>确认后才写入记忆</span>
              <RouterLink
                :to="settingsRoute('models')"
                class="popover-foot-link text-primary"
                @click="statusPopoverOpen = false"
              >
                <UIcon :name="icons.models" class="popover-foot-icon" aria-hidden="true" />
                <span>前往模型设置</span>
              </RouterLink>
            </div>
          </div>
        </template>
      </UPopover>
    </div>
  </aside>
</template>

<style scoped>
.index-rail {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--ui-bg-muted);
}
.rail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 8px 14px;
}
.tree-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tree-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border-left: 2px solid transparent;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ui-text-toned);
  text-align: left;
  cursor: pointer;
}
.tree-item:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.tree-item.is-active {
  border-left-color: var(--ui-rule);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
  font-weight: 600;
}
.tree-item-lead {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.tree-label-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.tree-item.is-active .tree-icon {
  color: var(--ui-text-highlighted);
}
.tree-count {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.tree-count.is-hot {
  font-weight: 600;
  color: var(--ui-error);
}
.tree-count.is-safe {
  font-weight: 500;
  color: var(--ui-success);
}
.tree-item.is-active .tree-count {
  color: var(--ui-text-toned);
}
.risk-swatch {
  display: inline-block;
  flex: none;
  width: 3px;
  height: 11px;
}
.risk-swatch.is-review {
  background: var(--ui-error);
}
.risk-swatch.is-safe {
  background: var(--ui-success);
}
.rail-divider {
  height: 1px;
  margin: 10px 6px;
  background: var(--ui-border);
}
.rail-section-title {
  padding: 2px 8px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-dimmed);
}
.rail-actions {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 0 4px;
}
.rail-action-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  min-height: 28px;
  padding: 3px 8px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-bright);
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-toned);
  text-align: left;
  cursor: pointer;
}
.rail-action-btn.is-quiet {
  border-color: var(--ui-border);
  background: var(--ui-bg);
}
.rail-action-btn:hover:not(:disabled) {
  border-color: var(--ui-rule);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.rail-action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.rail-action-lead {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.rail-action-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.rail-action-right {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.rail-action-caret {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-dimmed);
}
.pending-chip {
  padding: 0 5px;
  border: 1px solid var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 10%, var(--ui-bg-bright));
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--ui-warning);
}

/* 底部调度与状态微条 */
.rail-status {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 10px 12px;
  border-top: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-elevated);
}
.rail-status.is-failed {
  border-top-color: var(--ui-error);
  background: color-mix(in srgb, var(--ui-error) 5%, var(--ui-bg-elevated));
}
.rail-status.is-failed.is-partial {
  border-top-color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 6%, var(--ui-bg-elevated));
}
.rail-progress-edge {
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--ui-border);
  overflow: hidden;
}
.rail-progress-fill {
  height: 100%;
  background: var(--ui-info);
  transition: width 220ms ease;
}
.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;
}
.status-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-muted);
}
.status-lead {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-weight: 600;
}
.status-lead.is-running {
  color: var(--ui-info);
}
.status-lead.is-error {
  color: var(--ui-error);
}
.rail-status.is-partial .status-lead.is-error {
  color: var(--ui-warning);
}
.status-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.status-sq {
  display: inline-block;
  flex: none;
  width: 6px;
  height: 6px;
}
.status-sq.is-on {
  background: var(--ui-success);
}
.status-sq.is-off {
  background: var(--ui-text-dimmed);
}
.status-val {
  color: var(--ui-text-toned);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-sub {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.status-sub.is-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.status-dismiss-btn {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted);
  text-decoration: underline;
  cursor: pointer;
}
.status-dismiss-btn:hover {
  color: var(--ui-text-highlighted);
}
.status-btn-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

/* 调度与运行底账 Popover */
.status-popover {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 14px 16px;
  background: var(--ui-bg-bright);
}
.popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
}
.popover-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.popover-head-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.popover-schedules {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 12px;
}
.popover-sched-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.popover-sched-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-toned);
}
.popover-sched-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.popover-sched-val {
  color: var(--ui-text-muted);
}
.popover-sched-val.is-enabled {
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.popover-state {
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.popover-state.is-active {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.kv-list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  font-size: 13px;
}
.kv-list dt {
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.kv-list dd {
  text-align: right;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.popover-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--ui-error);
  background: var(--ui-bg);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-error);
  overflow-wrap: anywhere;
}
.popover-error-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}
.popover-error.is-partial {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.popover-failures {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
}
.failures-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.failures-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  cursor: pointer;
}
.failures-toggle-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.failures-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.failures-list > * {
  flex-shrink: 0;
}
.failure-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-border);
}
.failure-row:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}
.failure-top {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.failure-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.failure-reason {
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.popover-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.popover-foot-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.popover-foot-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
</style>
