<script setup lang="ts">
import type { EntryFacetsSummary, EntryTab, EntryTabCounts, PinnedGroup } from '@kioku/contracts'
import { computed } from 'vue'

import { icons } from '../icons'
import { entryTabIcons, entryTabLabels } from '../labels'
import { runtimeName } from '../runtimes'

const GLOBAL_FULL_CHAR_CAP = 3_500

const props = withDefaults(
  defineProps<{
    tab: EntryTab
    pinnedGroup: PinnedGroup | null
    project: string | null
    realm: string | null
    runtime: string | null
    facets: EntryFacetsSummary | null
    counts: EntryTabCounts | null
    pendingInboxCount?: number
  }>(),
  { pendingInboxCount: 0 },
)

const emit = defineEmits<{
  'update:tab': [value: EntryTab]
  'update:pinnedGroup': [value: PinnedGroup | null]
  'update:project': [value: string | null]
  'update:realm': [value: string | null]
  'update:runtime': [value: string | null]
  previewBoot: []
}>()

const globalFullChars = computed(() => props.counts?.globalFullPinnedChars ?? 0)
const globalFullCount = computed(() => props.counts?.globalFullPinnedCount ?? 0)
const scopedFullCount = computed(() => props.counts?.scopedFullPinnedCount ?? 0)
const indexPinnedCount = computed(() => props.counts?.indexPinnedCount ?? 0)
const overChars = computed(() => Math.max(0, globalFullChars.value - GLOBAL_FULL_CHAR_CAP))
const budgetPct = computed(() =>
  Math.min(100, Math.round((globalFullChars.value / GLOBAL_FULL_CHAR_CAP) * 100)),
)

const hasSceneFacets = computed(
  () =>
    Boolean(props.facets?.projects.length) ||
    Boolean(props.facets?.realms.length) ||
    Boolean(props.facets?.runtimes?.length),
)

function selectTab(next: EntryTab) {
  emit('update:tab', next)
}

function selectPinnedSub(group: PinnedGroup) {
  emit('update:pinnedGroup', props.pinnedGroup === group && props.tab === 'pinned' ? null : group)
}

function toggleFacet(kind: 'project' | 'realm' | 'runtime', value: string) {
  if (kind === 'project') emit('update:project', props.project === value ? null : value)
  else if (kind === 'realm') emit('update:realm', props.realm === value ? null : value)
  else emit('update:runtime', props.runtime === value ? null : value)
}
</script>

<template>
  <aside class="index-rail" aria-label="记忆目录与库状态">
    <div class="rail-scroll">
      <nav class="tree-group" aria-label="记忆视图">
        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': tab === 'all' }"
          :aria-current="tab === 'all' ? 'page' : undefined"
          @click="selectTab('all')"
        >
          <span class="tree-item-lead">
            <UIcon :name="entryTabIcons.all" class="tree-icon" aria-hidden="true" />
            <span>{{ entryTabLabels.all }}</span>
          </span>
          <span v-if="counts?.all !== undefined" class="tree-count tabular-nums">
            {{ counts.all }}
          </span>
        </button>

        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': tab === 'pinned' && pinnedGroup === null }"
          :aria-current="tab === 'pinned' && pinnedGroup === null ? 'page' : undefined"
          title="实线轨对应列表中的常驻记忆"
          @click="selectTab('pinned')"
        >
          <span class="tree-item-lead">
            <span class="rail-swatch solid" aria-hidden="true" />
            <UIcon :name="entryTabIcons.pinned" class="tree-icon" aria-hidden="true" />
            <span>{{ entryTabLabels.pinned }}</span>
          </span>
          <span v-if="counts?.pinned !== undefined" class="tree-count tabular-nums">
            {{ counts.pinned }}
          </span>
        </button>

        <div class="tree-children" role="group" aria-label="常驻分层">
          <button
            type="button"
            class="tree-item tree-child"
            :class="{ 'is-active': tab === 'pinned' && pinnedGroup === 'global_full' }"
            :title="
              overChars > 0
                ? `全局全文超出预算 ${overChars.toLocaleString()} 字，点击按字数降序查看`
                : '无场景限定的全局全文常驻（默认上限 3,500 字）'
            "
            @click="selectPinnedSub('global_full')"
          >
            <span>全局全文</span>
            <span class="tree-child-right">
              <span v-if="overChars > 0" class="over-chip tabular-nums">
                超+{{ overChars.toLocaleString() }}
              </span>
              <span class="tree-count tabular-nums">{{ globalFullCount }}</span>
            </span>
          </button>

          <button
            type="button"
            class="tree-item tree-child"
            :class="{ 'is-active': tab === 'pinned' && pinnedGroup === 'scoped_full' }"
            title="带项目、环境、场域或客户端限定的全文常驻记忆"
            @click="selectPinnedSub('scoped_full')"
          >
            <span>场景全文</span>
            <span class="tree-count tabular-nums">{{ scopedFullCount }}</span>
          </button>

          <button
            type="button"
            class="tree-item tree-child"
            :class="{ 'is-active': tab === 'pinned' && pinnedGroup === 'index' }"
            title="仅在启动目录槽注入标题与概要的长篇记忆"
            @click="selectPinnedSub('index')"
          >
            <span>目录常驻</span>
            <span class="tree-count tabular-nums">{{ indexPinnedCount }}</span>
          </button>
        </div>

        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': tab === 'regular' }"
          :aria-current="tab === 'regular' ? 'page' : undefined"
          @click="selectTab('regular')"
        >
          <span class="tree-item-lead">
            <UIcon :name="entryTabIcons.regular" class="tree-icon" aria-hidden="true" />
            <span>{{ entryTabLabels.regular }}</span>
          </span>
          <span v-if="counts?.regular !== undefined" class="tree-count tabular-nums">
            {{ counts.regular }}
          </span>
        </button>

        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': tab === 'episodes' }"
          :aria-current="tab === 'episodes' ? 'page' : undefined"
          title="虚线轨对应列表中的近期会话摘要"
          @click="selectTab('episodes')"
        >
          <span class="tree-item-lead">
            <span class="rail-swatch dashed" aria-hidden="true" />
            <UIcon :name="entryTabIcons.episodes" class="tree-icon" aria-hidden="true" />
            <span>{{ entryTabLabels.episodes }}</span>
          </span>
          <span v-if="counts?.episodes !== undefined" class="tree-count tabular-nums">
            {{ counts.episodes }}
          </span>
        </button>

        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': tab === 'trash' }"
          :aria-current="tab === 'trash' ? 'page' : undefined"
          @click="selectTab('trash')"
        >
          <span class="tree-item-lead">
            <UIcon :name="entryTabIcons.trash" class="tree-icon" aria-hidden="true" />
            <span>{{ entryTabLabels.trash }}</span>
          </span>
          <span v-if="counts?.trash !== undefined" class="tree-count tabular-nums">
            {{ counts.trash }}
          </span>
        </button>
      </nav>

      <template v-if="hasSceneFacets">
        <div class="rail-divider" aria-hidden="true" />
        <div class="rail-section-title">常用场景直达</div>

        <div class="facet-stack">
          <div v-if="facets?.projects.length" class="facet-group">
            <div class="facet-heading">
              <UIcon :name="icons.project" class="facet-icon" aria-hidden="true" />
              <span>项目</span>
            </div>
            <div class="facet-chips">
              <button
                v-for="p in facets.projects.slice(0, 12)"
                :key="`p:${p}`"
                type="button"
                class="facet-chip font-mono"
                :class="{ 'is-active': project === p }"
                :aria-pressed="project === p"
                @click="toggleFacet('project', p)"
              >
                {{ p }}
              </button>
            </div>
          </div>

          <div v-if="facets?.realms.length" class="facet-group">
            <div class="facet-heading">
              <UIcon :name="icons.realm" class="facet-icon" aria-hidden="true" />
              <span>场域</span>
            </div>
            <div class="facet-chips">
              <button
                v-for="r in facets.realms.slice(0, 8)"
                :key="`r:${r}`"
                type="button"
                class="facet-chip"
                :class="{ 'is-active': realm === r }"
                :aria-pressed="realm === r"
                @click="toggleFacet('realm', r)"
              >
                {{ r }}
              </button>
            </div>
          </div>

          <div v-if="facets?.runtimes?.length" class="facet-group">
            <div class="facet-heading">
              <UIcon :name="icons.terminal" class="facet-icon" aria-hidden="true" />
              <span>客户端</span>
            </div>
            <div class="facet-chips">
              <button
                v-for="rt in facets.runtimes.slice(0, 8)"
                :key="`rt:${rt}`"
                type="button"
                class="facet-chip"
                :class="{ 'is-active': runtime === rt }"
                :aria-pressed="runtime === rt"
                @click="toggleFacet('runtime', rt)"
              >
                {{ runtimeName(rt) }}
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div class="health-strip">
      <button
        type="button"
        class="health-budget-btn"
        :title="
          overChars > 0
            ? `全局全文超出预算 ${overChars.toLocaleString()} 字，点击定位全局全文常驻记忆`
            : '点击筛选全局全文常驻记忆（默认上限 3,500 字）'
        "
        @click="selectPinnedSub('global_full')"
      >
        <div class="health-line">
          <span class="health-label">
            <UIcon
              :name="overChars > 0 ? icons.warning : icons.gauge"
              class="health-icon"
              :class="{ 'is-warn': overChars > 0 }"
              aria-hidden="true"
            />
            <span>全局常驻预算</span>
          </span>
          <span class="health-val tabular-nums" :class="{ 'is-warn': overChars > 0 }">
            {{ globalFullChars.toLocaleString() }} / {{ GLOBAL_FULL_CHAR_CAP.toLocaleString() }}
          </span>
        </div>
        <div class="meter-track" aria-hidden="true">
          <div
            class="meter-fill"
            :class="{ 'is-warn': overChars > 0 }"
            :style="{ width: `${budgetPct}%` }"
          />
        </div>
      </button>

      <RouterLink v-if="pendingInboxCount > 0" :to="{ name: 'organize' }" class="health-link-row">
        <span class="health-label">
          <UIcon :name="icons.listChecks" class="health-icon" aria-hidden="true" />
          <span>待确认建议</span>
        </span>
        <span class="health-pending tabular-nums">{{ pendingInboxCount }} 条</span>
      </RouterLink>

      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        :icon="icons.terminal"
        block
        @click="emit('previewBoot')"
      >
        预览终端加载
      </UButton>
    </div>
  </aside>
</template>

<style scoped>
.index-rail {
  display: flex;
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
.tree-item.is-active .tree-count {
  color: var(--ui-text-toned);
}
.tree-children {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 1px 0 3px 15px;
  padding-left: 8px;
  border-left: 1px solid var(--ui-border-accented);
}
.tree-child {
  min-height: 26px;
  padding: 3px 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.tree-child-right {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
}
.over-chip {
  padding: 0 4px;
  border: 1px solid var(--ui-warning);
  background: var(--ui-bg-bright);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--ui-warning);
}
.rail-swatch {
  display: inline-block;
  flex: none;
  width: 3px;
  height: 11px;
}
.rail-swatch.solid {
  background: var(--ui-rule);
}
.rail-swatch.dashed {
  background: repeating-linear-gradient(to bottom, var(--ui-info) 0 3px, transparent 3px 6px);
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
.facet-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 6px;
}
.facet-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.facet-heading {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.facet-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.facet-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.facet-chip {
  max-width: 100%;
  padding: 1px 7px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-toned);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.facet-chip:hover {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.facet-chip.is-active {
  border-color: var(--ui-selected);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.health-strip {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 10px 12px;
  border-top: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-elevated);
}
.health-budget-btn {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 2px 0;
  text-align: left;
  cursor: pointer;
}
.health-budget-btn:hover .health-label {
  color: var(--ui-text-highlighted);
}
.health-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
}
.health-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-text-muted);
}
.health-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.health-icon.is-warn {
  color: var(--ui-warning);
}
.health-val {
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-toned);
}
.health-val.is-warn {
  color: var(--ui-warning);
}
.meter-track {
  height: 4px;
  width: 100%;
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
}
.meter-fill {
  height: 100%;
  background: var(--ui-rule);
}
.meter-fill.is-warn {
  background: var(--ui-warning);
}
.health-link-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 3px 0;
  border-top: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-toned);
}
.health-link-row:hover {
  color: var(--ui-text-highlighted);
}
.health-pending {
  font-weight: 600;
  color: var(--ui-error);
}
</style>
