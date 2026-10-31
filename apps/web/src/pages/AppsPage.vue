<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { RUNTIME_FAMILIES, SENSITIVITIES, type RuntimeFamily } from '@kioku/contracts'
import { useQueries, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { refreshAppCaches } from '../appQueries'
import { lastUsedAt } from '../apps'
import { usableKeys } from '../benchSession'
import Hint from '../components/Hint.vue'
import AccessLegend from '../components/strata/AccessLegend.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import StrataCore from '../components/strata/StrataCore.vue'
import StrataSwatch from '../components/strata/StrataSwatch.vue'
import { presentKinds, type AccessRow } from '../components/strata/strata'
import { useKeyMatrices } from '../composables/useKeyMatrices'
import { useSession } from '../composables/useSession'
import { scopesSummary, sensitivityLabels } from '../labels'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const role = computed(() => space.value?.role ?? 'viewer')
const isSpaceOwner = computed(() => role.value === 'owner')
const canCreate = computed(() => role.value === 'owner' || role.value === 'editor')

const apps = useQuery({
  queryKey: computed(() => ['apps', spaceId.value]),
  queryFn: () => api.apps(spaceId.value),
})
const personas = useQuery({
  queryKey: computed(() => ['personas', spaceId.value]),
  queryFn: () => api.personas(spaceId.value),
})
const members = useQuery({
  queryKey: computed(() => ['members', spaceId.value]),
  queryFn: () => api.members(spaceId.value),
})
const personaItems = computed(() => [
  { label: '不使用人格', value: null },
  ...(personas.data.value ?? []).map((p) => ({ label: p.name, value: p.id })),
])
const runtimeItems = RUNTIME_FAMILIES.map((r) => ({ label: r, value: r }))
const personaName = (id: string | null) =>
  personas.data.value?.find((p) => p.id === id)?.name ?? '–'
const ownerName = (id: string) =>
  members.data.value?.find((m) => m.accountId === id)?.displayName ?? '–'

// 只有应用所有者和空间所有者能看 Key：别人的应用不去请求，请求了也是 403
const visibleApps = computed(() =>
  (apps.data.value ?? []).filter(
    (app) => isSpaceOwner.value || app.ownerAccountId === me.data.value?.id,
  ),
)
// 和应用详情的 Key 列表同一份缓存
const keyResults = useQueries({
  queries: computed(() =>
    visibleApps.value.map((app) => ({
      queryKey: ['keys', spaceId.value, app.id] as const,
      queryFn: ({ queryKey: [, sid, id] }: { queryKey: readonly string[] }) => api.keys(sid!, id!),
    })),
  ),
})
// 表格的每一行。keys 为 null：看不到 Key，或者还没读到、读取失败
const rows = computed(() =>
  (apps.data.value ?? []).map((app) => {
    const index = visibleApps.value.findIndex((a) => a.id === app.id)
    const result = index < 0 ? undefined : keyResults.value[index]
    const keys = result?.data ?? null
    return {
      app,
      canSeeKeys: index >= 0,
      keys,
      keysFailure: result?.isError ? readFailure(result.error) : null,
      usable: usableKeys(keys ?? []),
      lastUsed: lastUsedAt(keys ?? []),
    }
  }),
)
const liveKeys = computed(() =>
  rows.value.flatMap((row) => row.usable.map((key) => ({ appId: row.app.id, key }))),
)
// 每个有效的 Key 一根岩芯，画的是无上下文时的实际范围
const { rowsOf, failureOf } = useKeyMatrices(spaceId, liveKeys)
const legendKinds = computed(() =>
  presentKinds(liveKeys.value.flatMap(({ key }): readonly AccessRow[] => rowsOf(key.id) ?? [])),
)
// 默认人格和所有者只显示名字，读不到时是「–」：要说出来，不然分不清是没有还是没读到
const readFailures = computed(() => [
  ...new Set(
    [apps, personas, members].filter((q) => q.isError.value).map((q) => readFailure(q.error.value)),
  ),
])

function failed(err: unknown, fallback: string) {
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })
}

const open = ref(false)
// 切换空间时关掉新建窗口：里面的内容属于上一个空间
watch(spaceId, () => (open.value = false))
const form = reactive({
  slug: '',
  name: '',
  runtimeFamily: 'claudecode' as RuntimeFamily,
  defaultPersonaId: null as string | null,
})
// 创建中不接受第二次提交：连点两次会先成功、再报标识已被占用
const creating = ref(false)
async function create() {
  if (creating.value) return
  creating.value = true
  try {
    await api.createApp(spaceId.value, { ...form })
    open.value = false
    Object.assign(form, { slug: '', name: '', runtimeFamily: 'claudecode', defaultPersonaId: null })
    await refreshAppCaches(queryClient, spaceId.value)
    toast.add({ title: '已创建应用', color: 'success' })
  } catch (err) {
    failed(err, '创建失败')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="apps-page">
    <header class="apps-head">
      <div>
        <h1>应用</h1>
        <p>
          每个接入的客户端（如 Claude Code、AstrBot）对应一个应用。
          <Hint>
            应用读写的私人层属于应用所有者。Key
            的权限在签发时确定，且不超过所有者当前的角色。点击名称可进入应用的设置、Key 与权限范围。
          </Hint>
        </p>
      </div>
      <UButton
        v-if="canCreate"
        class="shrink-0"
        color="primary"
        variant="outline"
        @click="open = true"
      >
        新建应用
      </UButton>
    </header>

    <NoteLine v-for="message in readFailures" :key="message" tone="error">{{ message }}</NoteLine>
    <USkeleton v-if="apps.isPending.value" class="h-40 w-full" />
    <p v-else-if="apps.data.value && !apps.data.value.length" class="apps-empty">暂无应用</p>
    <template v-else-if="apps.data.value">
      <div class="apps-table">
        <table>
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">运行时</th>
              <th scope="col">默认人格</th>
              <th scope="col">有效 Key</th>
              <th scope="col">最近使用</th>
              <th scope="col">所有者</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="{ app, canSeeKeys, keys, keysFailure, usable, lastUsed } in rows"
              :key="app.id"
            >
              <td class="cell-name">
                <RouterLink :to="{ name: 'app', params: { spaceId, appId: app.id } }">
                  <b>{{ app.name }}</b>
                  <code>app://{{ app.slug }}</code>
                </RouterLink>
              </td>
              <td class="cell-runtime">{{ app.runtimeFamily }}</td>
              <td class="cell-persona">{{ personaName(app.defaultPersonaId) }}</td>
              <td class="cell-keys">
                <div v-if="canSeeKeys" class="keys-inner">
                  <span class="key-count">{{ keys ? usable.length : '–' }}</span>
                  <ul v-if="usable.length" class="tray">
                    <li v-for="key in usable" :key="key.id">
                      <RouterLink
                        :to="{
                          name: 'app',
                          params: { spaceId, appId: app.id },
                          query: { key: key.id },
                        }"
                      >
                        <StrataCore
                          :rows="rowsOf(key.id)"
                          :label="`${key.name} 无上下文时`"
                          :width="44"
                          :height="72"
                        />
                        <span class="tray-text">
                          <b>{{ key.name }}</b>
                          <code>{{ key.prefix }}</code>
                          <span>{{ scopesSummary(key.effectiveScopes ?? key.scopes) }}</span>
                          <span v-if="key.lastUsedAt" :title="formatTime(key.lastUsedAt)">
                            {{ formatRelative(key.lastUsedAt) }}
                          </span>
                          <span v-else>尚未使用</span>
                          <span v-if="failureOf(key.id)" class="key-failed">
                            权限范围：{{ failureOf(key.id) }}
                          </span>
                        </span>
                      </RouterLink>
                    </li>
                  </ul>
                </div>
                <span v-else class="key-hidden">仅应用所有者可查看 Key</span>
                <p v-if="keysFailure" class="key-failed">{{ keysFailure }}</p>
              </td>
              <td class="cell-used">
                <time v-if="lastUsed" :datetime="lastUsed" :title="formatTime(lastUsed)">
                  {{ formatRelative(lastUsed) }}
                </time>
                <template v-else>–</template>
              </td>
              <td class="cell-owner">
                {{ ownerName(app.ownerAccountId)
                }}<span v-if="app.ownerAccountId === me.data.value?.id" class="app-mine">我的</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="liveKeys.length" class="apps-legend">
        <AccessLegend :kinds="legendKinds" />
        <ul class="sensitivity-legend">
          <li v-for="s in SENSITIVITIES" :key="s">
            <StrataSwatch :sensitivity="s" :width="28" :height="18" decorative />
            <span>{{ sensitivityLabels[s] }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>

  <UModal v-model:open="open" title="新建应用">
    <template #body>
      <form id="create-app" class="space-y-4" @submit.prevent="create">
        <UFormField label="标识" help="小写字母、数字和连字符；应用层记忆位于 app://<标识>/ 下">
          <UInput v-model="form.slug" class="w-full font-mono" required />
        </UFormField>
        <UFormField label="名称">
          <UInput v-model="form.name" class="w-full" required />
        </UFormField>
        <UFormField label="运行时" help="决定生命周期钩子的输出格式">
          <USelect v-model="form.runtimeFamily" :items="runtimeItems" class="w-full" />
        </UFormField>
        <UFormField label="默认人格">
          <USelect v-model="form.defaultPersonaId" :items="personaItems" class="w-full" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">取消</UButton>
        <UButton type="submit" form="create-app" :loading="creating">创建</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.apps-page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 22px 32px 40px;
}
.apps-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 17px;
}
.apps-head h1 {
  font-size: 28px;
  font-weight: 500;
  line-height: 1.3;
}
.apps-head p {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 14px;
  color: var(--ui-text-muted);
}
.apps-empty {
  padding: 16px 0;
  color: var(--ui-text-muted);
}
.apps-table {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th {
  padding: 0 16px 7px 0;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ui-text-muted);
  text-align: left;
  white-space: nowrap;
}
td {
  padding: 14px 16px 16px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.6;
  vertical-align: top;
  white-space: nowrap;
}
.cell-name a {
  display: block;
}
.cell-name b {
  display: block;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
}
.cell-name a:hover b {
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
}
.cell-name code {
  font-size: 14px;
  color: var(--ui-text-muted);
}
.cell-runtime {
  font-family: var(--font-mono);
  font-size: 13px;
}
.cell-keys {
  white-space: normal;
}
.keys-inner {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.key-count {
  flex: none;
  min-width: 18px;
  font-family: var(--font-mono);
}
.key-hidden {
  color: var(--ui-text-muted);
}
.key-failed {
  color: var(--ui-error);
}
.tray {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
}
.tray a {
  display: flex;
  gap: 14px;
  width: 300px;
  max-width: 100%;
}
.tray a:hover b {
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
}
.tray-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
.tray-text b {
  font-weight: 500;
  line-height: 1.5;
  color: var(--ui-text);
}
.tray-text code {
  font-size: 13px;
  color: var(--ui-text);
}
.app-mine {
  margin-left: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.apps-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 44px;
  margin-top: 18px;
}
.sensitivity-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}
.sensitivity-legend li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
@media (max-width: 1240px) {
  .tray {
    flex-direction: column;
    flex-wrap: nowrap;
  }
}
@media (max-width: 1023.98px) {
  .apps-page {
    padding: 16px 16px 32px;
  }
  .apps-table {
    overflow: visible;
  }
  table,
  tbody {
    display: block;
  }
  thead {
    display: none;
  }
  tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 12px;
    padding: 13px 0 14px;
    border-bottom: 1px solid var(--ui-border);
  }
  td {
    display: block;
    padding: 0;
    border: 0;
    white-space: normal;
  }
  .cell-name {
    grid-column: 1 / -1;
  }
  .cell-keys {
    grid-column: 1 / -1;
    margin-top: 7px;
  }
  .tray {
    flex-direction: column;
    gap: 14px;
  }
  .tray a {
    width: auto;
  }
  .cell-used,
  .cell-owner {
    font-size: 13px;
    color: var(--ui-text-muted);
  }
  .cell-persona,
  .cell-owner {
    text-align: right;
  }
}
</style>
