<script setup lang="ts">
import { LAYERS, SENSITIVITIES } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { backupNotice } from '../backup'
import ActivityEntry from '../components/ActivityEntry.vue'
import Hint from '../components/Hint.vue'
import SubjectBindings from '../components/SubjectBindings.vue'
import { useSession } from '../composables/useSession'
import { layerLabels, sensitivityColors, sensitivityLabels } from '../labels'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const { me } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const overview = useQuery({
  queryKey: computed(() => ['overview', spaceId.value]),
  queryFn: () => api.overview(spaceId.value),
})
const data = computed(() => overview.data.value)

// 层 × 敏感级的条数。对象层与情节层由对话抽取写入，没有记忆时不列
const rows = computed(() => {
  const counts = data.value?.counts ?? []
  return LAYERS.filter(
    (layer) =>
      (layer !== 'subject' && layer !== 'episode') || counts.some((c) => c.layer === layer),
  ).map((layer) => {
    const cells = SENSITIVITIES.map(
      (s) => counts.find((c) => c.layer === layer && c.sensitivity === s)?.count ?? 0,
    )
    return { layer, cells, total: cells.reduce((sum, n) => sum + n, 0) }
  })
})
const coverage = computed(() => {
  const e = data.value?.embedding
  return e && e.eligible ? Math.round((e.embedded / e.eligible) * 100) : null
})
// 本月抽取（含 Dream 的整理）的 token 用到八成时提醒；用完之后只写会话摘要、不再抽取事实，Dream 也不整理
const budgetWarning = computed(() => {
  const e = data.value?.extraction
  if (!e || e.usedTokens < e.monthlyTokens * 0.8) return null
  const over = e.usedTokens >= e.monthlyTokens
  const used = `已用 ${e.usedTokens.toLocaleString()} / ${e.monthlyTokens.toLocaleString()} token。`
  return {
    over,
    title: over
      ? '本月抽取预算已用完'
      : `本月抽取预算已用 ${Math.floor((e.usedTokens / e.monthlyTokens) * 100)}%`,
    description: over
      ? `${used}本月仅写会话摘要，不再抽取事实，Dream 暂停，下月恢复。空间所有者可在空间设置中调高预算。`
      : `${used}用完后本月仅写会话摘要，不再抽取事实，Dream 暂停。`,
  }
})
// 备份只给实例管理员提醒（别人拿到的是 null）
const backup = computed(() => backupNotice(data.value?.backup ?? null))
const activeKeys = computed(() =>
  (data.value?.apps ?? []).reduce((n, app) => n + (app.keys?.active ?? 0), 0),
)
</script>

<template>
  <UDashboardPanel id="overview">
    <template #header>
      <UDashboardNavbar title="概览" />
    </template>
    <template #body>
      <UAlert
        v-if="overview.isError.value"
        color="error"
        variant="subtle"
        :title="
          overview.error.value instanceof ApiError ? overview.error.value.message : '读取失败'
        "
      />
      <div v-else-if="!data" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <USkeleton v-for="n in 5" :key="n" class="h-28" />
      </div>
      <div v-else class="space-y-6">
        <UAlert
          v-if="backup"
          :color="backup.color"
          variant="subtle"
          :title="backup.title"
          :description="backup.description"
          :actions="[
            { label: '去实例设置', color: 'neutral', variant: 'outline', to: { name: 'settings' } },
          ]"
        />
        <section
          v-if="data.pendingBindings.length"
          class="rounded-lg border border-warning/40 bg-warning/5 p-4"
        >
          <h2 class="text-sm font-medium">{{ data.pendingBindings.length }} 个账号绑定申请</h2>
          <p class="mt-1 text-xs text-muted">
            确认后，该账号的私聊视为本人对话，此操作不可撤销。如无法辨认，请拒绝。<Hint>
              对方在 Bot 私聊中使用绑定码发起申请，确认后账号并入标记为本人的联系人。
            </Hint>
          </p>
          <SubjectBindings :space-id="spaceId" :items="data.pendingBindings" />
        </section>
        <UAlert
          v-if="budgetWarning"
          :color="budgetWarning.over ? 'error' : 'warning'"
          variant="subtle"
          :title="budgetWarning.title"
          :description="budgetWarning.description"
        />
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div class="rounded-lg border border-default p-4">
            <p class="text-sm text-muted">
              总量
              <Hint>统计范围为当前账号有权查看的内容，不含从对话中记下的事实与会话摘要。</Hint>
            </p>
            <p class="mt-1 text-2xl font-semibold tabular-nums">{{ data.total }} 条记忆</p>
          </div>
          <div class="rounded-lg border border-default p-4">
            <p class="text-sm text-muted">未设触发场景</p>
            <p
              class="mt-1 text-2xl font-semibold tabular-nums"
              :class="data.missingDisclosure ? 'text-warning' : ''"
            >
              {{ data.missingDisclosure }}
            </p>
            <p class="mt-1 text-xs text-muted">
              补全后召回更准确。
              <RouterLink
                v-if="data.missingDisclosure"
                class="underline"
                :to="{
                  name: 'memories',
                  params: { spaceId },
                  query: { view: 'list', missingDisclosure: 'true' },
                }"
              >
                去补全
              </RouterLink>
            </p>
          </div>
          <div class="rounded-lg border border-default p-4">
            <p class="text-sm text-muted">疑似明文凭据</p>
            <p
              class="mt-1 text-2xl font-semibold tabular-nums"
              :class="data.plaintextCredentials ? 'text-warning' : ''"
            >
              {{ data.plaintextCredentials }}
            </p>
            <p class="mt-1 text-xs text-muted">
              建议转存为凭据，正文改用占位符。
              <RouterLink
                v-if="data.plaintextCredentials"
                class="underline"
                :to="{
                  name: 'memories',
                  params: { spaceId },
                  query: { view: 'list', plaintext: 'true' },
                }"
              >
                逐条处理
              </RouterLink>
            </p>
          </div>
          <div class="rounded-lg border border-default p-4">
            <p class="text-sm text-muted">从未召回</p>
            <p
              class="mt-1 text-2xl font-semibold tabular-nums"
              :class="data.neverRecalled ? 'text-warning' : ''"
            >
              {{ data.neverRecalled }}
            </p>
            <p class="mt-1 text-xs text-muted">
              创建已久，未被任何应用召回。<Hint>
                创建与开始记录召回均已满明细保留天数才计入，不含机密内容与启动加载的节点。可能缺少关键词、内容过于笼统，或已不再需要。
              </Hint>
              <RouterLink
                v-if="data.neverRecalled"
                class="underline"
                :to="{ name: 'recall', params: { spaceId } }"
              >
                查看
              </RouterLink>
            </p>
          </div>
          <div class="rounded-lg border border-default p-4">
            <p class="text-sm text-muted">向量索引</p>
            <template v-if="data.embedding.configured">
              <p class="mt-1 text-2xl font-semibold tabular-nums">
                {{ data.embedding.embedded }} / {{ data.embedding.eligible }}
              </p>
              <UProgress v-if="coverage !== null" :model-value="coverage" size="sm" class="mt-2" />
              <p class="mt-1 truncate text-xs text-muted">模型 {{ data.embedding.model }}</p>
            </template>
            <template v-else>
              <p class="mt-1 text-sm">未配置嵌入模型</p>
              <p class="mt-1 text-xs text-muted">
                召回仅使用全文与关键词。
                <RouterLink
                  v-if="me.data.value?.isAdmin"
                  :to="{ name: 'settings' }"
                  class="underline"
                >
                  去配置
                </RouterLink>
              </p>
            </template>
          </div>
          <div class="rounded-lg border border-default p-4">
            <p class="text-sm text-muted">应用</p>
            <p class="mt-1 text-2xl font-semibold tabular-nums">{{ data.apps.length }}</p>
            <p class="mt-1 text-xs text-muted">
              {{ activeKeys }} 个有效 Key
              <Hint v-if="data.apps.some((app) => !app.keys)">
                仅统计当前账号有权查看 Key 的应用。
              </Hint>
            </p>
          </div>
        </div>

        <section>
          <h2 class="mb-2 text-sm font-medium">记忆分布</h2>
          <div class="overflow-x-auto rounded-lg border border-default">
            <table class="w-full text-sm">
              <thead class="bg-elevated/50">
                <tr>
                  <th class="px-3 py-2 text-left font-medium">层</th>
                  <th v-for="s in SENSITIVITIES" :key="s" class="px-3 py-2 text-right font-medium">
                    <UBadge :color="sensitivityColors[s]" variant="subtle" size="sm">
                      {{ sensitivityLabels[s] }}
                    </UBadge>
                  </th>
                  <th class="px-3 py-2 text-right font-medium">合计</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="row in rows" :key="row.layer">
                  <td class="px-3 py-2">{{ layerLabels[row.layer] }}</td>
                  <td
                    v-for="(n, i) in row.cells"
                    :key="i"
                    class="px-3 py-2 text-right tabular-nums"
                    :class="n ? '' : 'text-dimmed'"
                  >
                    {{ n || '—' }}
                  </td>
                  <td class="px-3 py-2 text-right font-medium tabular-nums">{{ row.total }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="grid gap-6 lg:grid-cols-2">
          <section>
            <div class="mb-2 flex items-center justify-between">
              <h2 class="text-sm font-medium">最近变更</h2>
              <UButton
                :to="{ name: 'activity', params: { spaceId } }"
                size="xs"
                variant="link"
                color="neutral"
              >
                全部变更
              </UButton>
            </div>
            <div
              v-if="data.recent.length"
              class="divide-y divide-default rounded-lg border border-default px-3"
            >
              <ActivityEntry
                v-for="item in data.recent"
                :key="item.id"
                :item="item"
                :space-id="spaceId"
              />
            </div>
            <p v-else class="text-sm text-muted">暂无变更记录</p>
          </section>
          <section>
            <div class="mb-2 flex items-center justify-between">
              <h2 class="text-sm font-medium">应用</h2>
              <UButton
                :to="{ name: 'apps', params: { spaceId } }"
                size="xs"
                variant="link"
                color="neutral"
              >
                管理应用
              </UButton>
            </div>
            <ul
              v-if="data.apps.length"
              class="divide-y divide-default rounded-lg border border-default"
            >
              <li
                v-for="app in data.apps"
                :key="app.id"
                class="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm"
              >
                <span class="font-medium">{{ app.name }}</span>
                <code class="text-xs text-muted">app://{{ app.slug }}</code>
                <UBadge variant="subtle" size="sm" color="neutral">{{ app.runtimeFamily }}</UBadge>
                <span class="ml-auto text-xs text-muted">
                  <template v-if="app.keys">
                    {{ app.keys.active }} 个有效 Key
                    <template v-if="app.keys.lastUsedAt">
                      · 最近使用
                      <time
                        :datetime="app.keys.lastUsedAt"
                        :title="formatTime(app.keys.lastUsedAt)"
                      >
                        {{ formatRelative(app.keys.lastUsedAt) }}
                      </time>
                    </template>
                    <template v-else-if="app.keys.active">· 尚未使用</template>
                  </template>
                  <template v-else>仅应用所有者可查看 Key</template>
                </span>
              </li>
            </ul>
            <p v-else class="text-sm text-muted">暂无应用</p>
          </section>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
