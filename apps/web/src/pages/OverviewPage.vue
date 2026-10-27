<script setup lang="ts">
import { LAYERS, SENSITIVITIES } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import ActivityEntry from '../components/ActivityEntry.vue'
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
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div class="rounded-lg border border-default p-4">
            <p class="text-sm text-muted">记忆</p>
            <p class="mt-1 text-2xl font-semibold tabular-nums">{{ data.total }}</p>
            <p class="mt-1 text-xs text-muted">你读得到的策展记忆</p>
          </div>
          <div class="rounded-lg border border-default p-4">
            <p class="text-sm text-muted">缺 disclosure</p>
            <p
              class="mt-1 text-2xl font-semibold tabular-nums"
              :class="data.missingDisclosure ? 'text-warning' : ''"
            >
              {{ data.missingDisclosure }}
            </p>
            <p class="mt-1 text-xs text-muted">
              没写什么场景下该想起，召回时少一条线索。
              <RouterLink
                v-if="data.missingDisclosure"
                class="underline"
                :to="{
                  name: 'memories',
                  params: { spaceId },
                  query: { view: 'list', missingDisclosure: 'true' },
                }"
              >
                逐条补上
              </RouterLink>
            </p>
          </div>
          <div class="rounded-lg border border-default p-4">
            <p class="text-sm text-muted">像有明文凭据</p>
            <p
              class="mt-1 text-2xl font-semibold tabular-nums"
              :class="data.plaintextCredentials ? 'text-warning' : ''"
            >
              {{ data.plaintextCredentials }}
            </p>
            <p class="mt-1 text-xs text-muted">
              正文里像有密码或 Token，值该存成凭据、正文里换成占位符。
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
            <p class="text-sm text-muted">向量</p>
            <template v-if="data.embedding.configured">
              <p class="mt-1 text-2xl font-semibold tabular-nums">
                {{ data.embedding.embedded }} / {{ data.embedding.eligible }}
              </p>
              <UProgress v-if="coverage !== null" :model-value="coverage" size="sm" class="mt-2" />
              <p class="mt-1 truncate text-xs text-muted">模型 {{ data.embedding.model }}</p>
            </template>
            <template v-else>
              <p class="mt-1 text-sm">还没有配置嵌入模型</p>
              <p class="mt-1 text-xs text-muted">
                召回暂时只走全文与关键词。
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
            <p class="mt-1 text-xs text-muted">你看得到的有效 Key 共 {{ activeKeys }} 把</p>
          </div>
        </div>

        <section>
          <h2 class="mb-2 text-sm font-medium">按层与敏感级</h2>
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
              <h2 class="text-sm font-medium">最近的改动</h2>
              <UButton
                :to="{ name: 'activity', params: { spaceId } }"
                size="xs"
                variant="link"
                color="neutral"
              >
                全部活动
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
            <p v-else class="text-sm text-muted">还没有改动。</p>
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
                管理应用与 Key
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
                    {{ app.keys.active }} 把有效 Key
                    <template v-if="app.keys.lastUsedAt">
                      · 最近使用
                      <time
                        :datetime="app.keys.lastUsedAt"
                        :title="formatTime(app.keys.lastUsedAt)"
                      >
                        {{ formatRelative(app.keys.lastUsedAt) }}
                      </time>
                    </template>
                    <template v-else-if="app.keys.active">· 还没用过</template>
                  </template>
                  <template v-else>Key 的情况只给应用主人看</template>
                </span>
              </li>
            </ul>
            <p v-else class="text-sm text-muted">还没有应用。</p>
          </section>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
