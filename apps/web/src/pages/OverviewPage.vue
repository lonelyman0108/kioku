<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { backupNotice } from '../backup'
import Hint from '../components/Hint.vue'
import OverviewRow from '../components/OverviewRow.vue'
import RecentChange from '../components/RecentChange.vue'
import SubjectBindings from '../components/SubjectBindings.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import StrataColumn from '../components/strata/StrataColumn.vue'
import {
  columnSize,
  isConversationLayer,
  tallyCounts,
  type StrataSelection,
} from '../components/strata/strata'
import { useSession } from '../composables/useSession'
import { useViewport } from '../composables/useViewport'
import { bindingNote, budgetWarning, splitNote, strataFilterQuery } from '../overview'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const router = useRouter()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const overview = useQuery({
  queryKey: computed(() => ['overview', spaceId.value]),
  queryFn: () => api.overview(spaceId.value),
})
const data = computed(() => overview.data.value)

const viewport = useViewport()
const size = computed(() => columnSize(viewport.value))

// 层 × 敏感级的条数：记忆加上来自对话的两层
const counts = computed(() =>
  data.value ? tallyCounts([...data.value.counts, ...data.value.extractedCounts]) : null,
)
const extracted = computed(() =>
  (data.value?.extractedCounts ?? []).reduce((sum, c) => sum + c.count, 0),
)

// 点地层柱：记忆列表按层和敏感级筛选。来自对话的两层不在记忆列表里，它们的内容在联系人页
function openStrata(selection: StrataSelection) {
  const params = { spaceId: spaceId.value }
  if (selection.layer && isConversationLayer(selection.layer)) {
    void router.push({ name: 'subjects', params })
    return
  }
  void router.push({ name: 'memories', params, query: strataFilterQuery(selection) })
}

// 账号绑定只有这里和联系人详情能处理：行内展开
const bindingsOpen = ref(false)
const bindingsListed = computed(() => data.value?.pendingBindings.length ?? 0)

// 另外三类待处理跳到它们的页面
const pending = computed(() => {
  const inbox = data.value?.inbox
  if (!inbox) return []
  const params = { spaceId: spaceId.value }
  return [
    {
      title: '待确认内容',
      count: inbox.review,
      note: '来自群聊与陌生人私聊',
      action: '去确认',
      hot: true,
      to: { name: 'review', params },
    },
    {
      title: '整理建议',
      count: inbox.dreamSuggestions,
      note: 'Dream 建议合并重复、标记过时',
      action: '查看',
      hot: false,
      to: { name: 'review', params, query: { tab: 'dream' } },
    },
    {
      title: '疑似明文凭据',
      count: inbox.plaintext,
      note: '建议转存为凭据，正文改用占位符',
      action: '逐条处理',
      hot: false,
      to: { name: 'memories', params, query: { view: 'list', plaintext: 'true' } },
    },
  ]
})

const coverage = computed(() => {
  const e = data.value?.embedding
  return e && e.eligible ? Math.round((e.embedded / e.eligible) * 100) : null
})

const budget = computed(() => {
  const warning = data.value ? budgetWarning(data.value.extraction) : null
  return warning && { ...warning, note: splitNote(warning.description) }
})
// 备份只给实例管理员提醒（别人拿到的是 null）
const backup = computed(() => {
  const notice = backupNotice(data.value?.backup ?? null)
  return notice && { ...notice, note: splitNote(notice.description) }
})
const canAdjustBudget = computed(() => space.value?.role === 'owner')
</script>

<template>
  <div class="overview">
    <div v-if="overview.isError.value" class="overview-failed">
      <NoteLine tone="error">
        {{ overview.error.value instanceof ApiError ? overview.error.value.message : '读取失败' }}
      </NoteLine>
    </div>
    <div v-else-if="!data || !counts" class="overview-grid">
      <div v-for="n in 3" :key="n" class="overview-col space-y-4">
        <USkeleton class="h-8 w-2/3" />
        <USkeleton class="h-96 w-full" />
      </div>
    </div>
    <div v-else class="overview-grid">
      <div class="overview-col plate">
        <header class="plate-head">
          <h1>{{ data.total }} 条记忆，{{ data.inbox.total }} 项待处理</h1>
          <p>
            <span v-if="extracted">另有 {{ extracted }} 条来自对话</span>
            <span v-else>统计范围</span>
            <Hint>统计范围为当前账号有权查看的内容，不含从对话中记下的事实与会话摘要。</Hint>
          </p>
        </header>
        <section>
          <SectionHeading title="记忆分布">
            <template #hint>
              <Hint>
                带的高度表示条数的多少，数字是确切的条数。点击任意一格，查看对应的记忆；来自对话的两层在联系人页查看。
              </Hint>
            </template>
          </SectionHeading>
          <StrataColumn
            :counts="counts"
            :height="size.height"
            :width="size.width"
            :compact="size.compact"
            @select="openStrata"
          />
        </section>
      </div>

      <div class="overview-col middle">
        <section>
          <SectionHeading title="待处理" />
          <OverviewRow
            title="账号绑定申请"
            :value="data.inbox.bindings"
            :note="bindingNote(data.pendingBindings, data.inbox.bindings) ?? '暂无'"
            :action="bindingsListed ? (bindingsOpen ? '收起' : '查看') : null"
            :expanded="bindingsOpen"
            :hot="data.inbox.bindings > 0"
            :zero="!data.inbox.bindings"
            @action="bindingsOpen = !bindingsOpen"
          />
          <div v-if="bindingsOpen && bindingsListed" class="bindings">
            <p class="text-sm">
              确认后，该账号的私聊视为本人对话，此操作不可撤销。如无法辨认，请拒绝。<Hint>
                对方在 Bot 私聊中使用绑定码发起申请，确认后账号并入标记为本人的联系人。
              </Hint>
            </p>
            <p v-if="data.inbox.bindings > bindingsListed" class="text-sm text-muted">
              仅列出前 {{ bindingsListed }} 个，处理后显示其余的。
            </p>
            <SubjectBindings :space-id="spaceId" :items="data.pendingBindings" />
          </div>
          <OverviewRow
            v-for="row in pending"
            :key="row.title"
            :title="row.title"
            :value="row.count"
            :note="row.count ? row.note : '暂无'"
            :action="row.count ? row.action : null"
            :to="row.to"
            :hot="row.hot && row.count > 0"
            :zero="!row.count"
          />
        </section>

        <section>
          <SectionHeading title="记忆健康" />
          <OverviewRow
            title="未设触发场景"
            :value="data.missingDisclosure"
            note="补全后召回更准确"
            :action="data.missingDisclosure ? '去补全' : null"
            :to="{
              name: 'memories',
              params: { spaceId },
              query: { view: 'list', missingDisclosure: 'true' },
            }"
            :zero="!data.missingDisclosure"
          />
          <OverviewRow
            title="从未召回"
            :value="data.neverRecalled"
            :action="data.neverRecalled ? '查看' : null"
            :to="{ name: 'recall', params: { spaceId } }"
            :zero="!data.neverRecalled"
          >
            <template #note>
              创建已久，未被任何应用召回<Hint>
                创建与开始记录召回均已满明细保留天数才计入，不含机密内容与启动加载的节点。可能缺少关键词、内容过于笼统，或已不再需要。
              </Hint>
            </template>
          </OverviewRow>
          <OverviewRow
            v-if="data.embedding.configured"
            title="向量索引"
            :value="coverage === null ? '–' : `${coverage}%`"
            :note="`${data.embedding.embedded} / ${data.embedding.eligible}，模型 ${data.embedding.model}`"
          >
            <span
              v-if="coverage !== null"
              class="meter"
              role="img"
              :aria-label="`已建立索引 ${coverage}%`"
            >
              <i
                :style="{ width: `${(data.embedding.embedded / data.embedding.eligible) * 100}%` }"
              />
            </span>
          </OverviewRow>
          <OverviewRow
            v-else
            title="向量索引"
            value="–"
            note="未配置嵌入模型，召回仅使用全文与关键词"
            :action="me.data.value?.isAdmin ? '去配置' : null"
            :to="{ name: 'settings' }"
            zero
          />
        </section>
      </div>

      <div class="overview-col side">
        <section>
          <SectionHeading title="系统提醒" />
          <div v-if="budget" class="notice">
            <p
              class="notice-title"
              :class="{ 'text-error': budget.over, 'text-warning': !budget.over }"
            >
              {{ budget.title }}<Hint v-if="budget.note.rest">{{ budget.note.rest }}</Hint>
            </p>
            <p class="notice-body">
              <span>{{ budget.note.first }}</span>
              <RouterLink
                v-if="canAdjustBudget"
                :to="{ name: 'space-settings', params: { spaceId } }"
                class="notice-link"
              >
                调整预算
              </RouterLink>
            </p>
          </div>
          <div v-if="backup" class="notice">
            <p
              class="notice-title"
              :class="{
                'text-error': backup.color === 'error',
                'text-warning': backup.color === 'warning',
              }"
            >
              {{ backup.title }}<Hint v-if="backup.note.rest">{{ backup.note.rest }}</Hint>
            </p>
            <p class="notice-body">
              <span>{{ backup.note.first }}</span>
              <RouterLink :to="{ name: 'settings' }" class="notice-link">去实例设置</RouterLink>
            </p>
          </div>
          <p v-if="!budget && !backup" class="empty">暂无提醒</p>
        </section>

        <section>
          <SectionHeading title="最近变更">
            <template #actions>
              <RouterLink :to="{ name: 'activity', params: { spaceId } }" class="heading-link">
                全部变更
              </RouterLink>
            </template>
          </SectionHeading>
          <ul v-if="data.recent.length">
            <RecentChange
              v-for="item in data.recent"
              :key="item.id"
              :item="item"
              :space-id="spaceId"
            />
          </ul>
          <p v-else class="empty">暂无变更记录</p>
        </section>

        <section>
          <SectionHeading title="应用">
            <template #actions>
              <RouterLink :to="{ name: 'apps', params: { spaceId } }" class="heading-link">
                管理应用
              </RouterLink>
            </template>
          </SectionHeading>
          <ul v-if="data.apps.length">
            <li v-for="app in data.apps" :key="app.id" class="app-row">
              <RouterLink
                :to="{ name: 'app', params: { spaceId, appId: app.id } }"
                class="app-name"
              >
                <b>{{ app.name }}</b>
                <span class="app-runtime">{{ app.runtimeFamily }}</span>
              </RouterLink>
              <template v-if="app.keys">
                <span class="app-meta">
                  有效 Key <span class="font-mono">{{ app.keys.active }}</span>
                </span>
                <time
                  v-if="app.keys.lastUsedAt"
                  class="app-meta"
                  :datetime="app.keys.lastUsedAt"
                  :title="`最近使用 ${formatTime(app.keys.lastUsedAt)}`"
                >
                  {{ formatRelative(app.keys.lastUsedAt) }}
                </time>
                <span v-else-if="app.keys.active" class="app-meta">尚未使用</span>
                <span v-else class="app-meta" />
              </template>
              <span v-else class="app-meta app-hidden">仅应用所有者可查看 Key</span>
            </li>
          </ul>
          <p v-else class="empty">暂无应用</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overview {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.overview-failed {
  padding: 24px 32px;
}
.overview-grid {
  display: grid;
  grid-template-columns: 600px minmax(0, 1fr) minmax(0, 1fr);
  min-height: 100%;
}
.overview-col {
  min-width: 0;
  padding: 24px 28px 22px;
}
.overview-col section + section {
  margin-top: 26px;
}
.plate {
  padding: 22px 32px;
  border-right: 1px solid var(--strata-rule);
}
.middle {
  padding-right: 26px;
  border-right: 1px solid var(--ui-border-accented);
}
.side {
  padding-right: 32px;
}
.plate :deep(.strata-figure) {
  margin-top: 9px;
}
.plate-head {
  margin-bottom: 18px;
}
.plate-head h1 {
  font-size: 28px;
  line-height: 1.3;
  font-weight: 500;
  letter-spacing: -0.005em;
}
.plate-head p {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 3px;
  color: var(--ui-text-muted);
}
.bindings {
  padding: 12px 0 8px;
  border-bottom: 1px solid var(--ui-border);
}
.meter {
  position: relative;
  grid-column: 1 / -1;
  height: 6px;
  margin: 8px 0 3px;
  border: 1px solid var(--strata-rule);
}
.meter i {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--ui-text-highlighted);
}
.notice {
  padding: 10px 0 11px;
  border-bottom: 1px solid var(--ui-border);
}
.notice-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  line-height: 1.5;
  font-weight: 600;
}
.notice-body {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.notice-link,
.heading-link {
  font-size: 13px;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
.notice-link:hover,
.heading-link:hover {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.app-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  column-gap: 14px;
  align-items: baseline;
  padding: 8px 0 7px;
  border-bottom: 1px solid var(--ui-border);
}
.app-row:hover {
  background: var(--ui-bg-muted);
}
.app-name {
  min-width: 0;
}
.app-name::after {
  content: '';
  position: absolute;
  inset: 0;
}
.app-name b {
  display: block;
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-runtime {
  display: block;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-meta {
  font-size: 13px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.app-hidden {
  grid-column: 2 / -1;
}

/* 中等宽度：地层柱和待处理两栏，右栏放到下面排成三列 */
@media (max-width: 1240px) {
  .overview-grid {
    grid-template-columns: 600px minmax(0, 1fr);
  }
  .middle {
    border-right: 0;
    padding-right: 32px;
  }
  .side {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0 28px;
    padding-left: 32px;
    border-top: 1px solid var(--strata-rule);
  }
  .side section + section {
    margin-top: 0;
  }
}
/* 窄屏单栏 */
@media (max-width: 1023.98px) {
  .overview-grid {
    display: block;
    min-height: 0;
  }
  .overview-col {
    padding: 18px 16px;
  }
  .plate {
    border-right: 0;
    border-bottom: 1px solid var(--strata-rule);
  }
  .plate-head h1 {
    font-size: 23px;
  }
  .middle {
    padding-right: 16px;
  }
  .side {
    display: block;
    padding: 18px 16px 32px;
    border-top: 0;
  }
  .side section + section {
    margin-top: 26px;
  }
}
</style>
