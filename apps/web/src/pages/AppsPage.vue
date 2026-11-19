<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { SENSITIVITIES, type RuntimeFamily } from '@kioku/contracts'
import { useQueries, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { refreshClientCaches } from '../appQueries'
import { lastUsedAt, usableKeys } from '../apps'
import Hint from '../components/Hint.vue'
import RuntimeIcon from '../components/RuntimeIcon.vue'
import RuntimeLabel from '../components/RuntimeLabel.vue'
import AccessLegend from '../components/strata/AccessLegend.vue'
import EmptyState from '../components/strata/EmptyState.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import ScopeTags from '../components/strata/ScopeTags.vue'
import StrataCore from '../components/strata/StrataCore.vue'
import StrataSwatch from '../components/strata/StrataSwatch.vue'
import { presentKinds, type BandAccessRow } from '../components/strata/strata'
import { useKeyMatrices } from '../composables/useKeyMatrices'
import { useSession } from '../composables/useSession'
import { scopesSummary, sensitivityLabels } from '../labels'
import { failedReads } from '../query'
import { RUNTIME_OPTIONS } from '../runtimes'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { me, circle } = useSession()
const circleId = computed(() => String(route.params.circleId))
const role = computed(() => circle.value?.role ?? 'viewer')
const isCircleOwner = computed(() => role.value === 'owner')
const canCreate = computed(() => role.value === 'owner' || role.value === 'editor')

const clients = useQuery({
  queryKey: computed(() => ['clients', circleId.value] as const),
  queryFn: () => api.clients(circleId.value),
})
const personas = useQuery({
  queryKey: computed(() => ['personas', circleId.value] as const),
  queryFn: () => api.personas(circleId.value),
})
const members = useQuery({
  queryKey: computed(() => ['members', circleId.value] as const),
  queryFn: () => api.members(circleId.value),
})
const personaItems = computed(() => [
  { label: '不使用人格', value: null },
  ...(personas.data.value ?? []).map((p) => ({ label: p.name, value: p.id })),
])
const personaName = (id: string | null) =>
  personas.data.value?.find((p) => p.id === id)?.name ?? '–'
const ownerName = (id: string) =>
  members.data.value?.find((m) => m.accountId === id)?.displayName ?? '–'

// 只有接入实例所有者和记忆圈所有者能看访问密钥：别人的接入实例不去请求，请求了也是 403
const visibleClients = computed(() =>
  (clients.data.value ?? []).filter(
    (c) => isCircleOwner.value || c.ownerAccountId === me.data.value?.id,
  ),
)
const keyResults = useQueries({
  queries: computed(() =>
    visibleClients.value.map((c) => ({
      queryKey: ['keys', circleId.value, c.id] as const,
      queryFn: ({ queryKey: [, cid, id] }: { queryKey: readonly string[] }) => api.keys(cid!, id!),
    })),
  ),
})
const rows = computed(() =>
  (clients.data.value ?? []).map((client) => {
    const index = visibleClients.value.findIndex((c) => c.id === client.id)
    const result = index < 0 ? undefined : keyResults.value[index]
    const keys = result?.data ?? null
    return {
      client,
      canSeeKeys: index >= 0,
      keys,
      keysFailure: result?.isError ? readFailure(result.error) : null,
      usable: usableKeys(keys ?? []),
      lastUsed: lastUsedAt(keys ?? []),
    }
  }),
)
const liveKeys = computed(() =>
  rows.value.flatMap((row) => row.usable.map((key) => ({ clientId: row.client.id, key }))),
)
const { rowsOf, failureOf } = useKeyMatrices(circleId, liveKeys)
const legendKinds = computed(() =>
  presentKinds(liveKeys.value.flatMap(({ key }): readonly BandAccessRow[] => rowsOf(key.id) ?? [])),
)
const failures = computed(() => failedReads([clients, personas, members]))

function failed(err: unknown, fallback: string) {
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })
}

const open = ref(false)
const form = reactive({
  slug: '',
  name: '',
  runtimeFamily: 'claudecode' as RuntimeFamily,
  defaultPersonaId: null as string | null,
})
const resetForm = () =>
  Object.assign(form, { slug: '', name: '', runtimeFamily: 'claudecode', defaultPersonaId: null })
watch(circleId, () => {
  open.value = false
  resetForm()
})
const creating = ref(false)
async function create() {
  if (creating.value) return
  creating.value = true
  const cid = circleId.value
  try {
    await api.createClient(cid, { ...form })
    open.value = false
    resetForm()
    await refreshClientCaches(queryClient, cid)
    toast.add({ title: '已创建接入实例', color: 'success' })
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
        <h1>接入实例</h1>
        <p>
          每个接入的工具或机器人（如 Claude Code、AstrBot）对应一个接入实例。
          <Hint>
            访问密钥的权限由签发透镜范围与所有者当前角色共同决定，并可关联客场记忆圈与固定切面。点击名称进入设置、访问密钥与按群规则。
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
        新建接入实例
      </UButton>
    </header>

    <ReadFailureNote v-for="failure in failures" :key="failure.key" :query="failure.read" />
    <USkeleton v-if="clients.isPending.value" class="h-40 w-full" />
    <EmptyState v-else-if="clients.data.value && !clients.data.value.length" title="暂无接入实例">
      <template v-if="canCreate" #actions>
        <UButton size="sm" color="primary" variant="outline" @click="open = true">
          新建接入实例
        </UButton>
      </template>
    </EmptyState>
    <template v-else-if="clients.data.value">
      <div class="apps-table">
        <table>
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">运行时</th>
              <th scope="col">默认人格</th>
              <th scope="col">有效访问密钥</th>
              <th scope="col">最近使用</th>
              <th scope="col">所有者</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="{ client, canSeeKeys, keys, keysFailure, usable, lastUsed } in rows"
              :key="client.id"
            >
              <td class="cell-name">
                <RouterLink :to="{ name: 'client', params: { circleId, clientId: client.id } }">
                  <b>{{ client.name }}</b>
                  <code>{{ client.slug }}</code>
                </RouterLink>
              </td>
              <td class="cell-runtime">
                <RuntimeLabel :family="client.runtimeFamily" />
              </td>
              <td class="cell-persona">{{ personaName(client.defaultPersonaId) }}</td>
              <td class="cell-keys">
                <div v-if="canSeeKeys" class="keys-inner">
                  <span class="key-count">{{ keys ? usable.length : '–' }}</span>
                  <ul v-if="usable.length" class="tray">
                    <li v-for="key in usable" :key="key.id">
                      <RouterLink
                        :to="{
                          name: 'client',
                          params: { circleId, clientId: client.id },
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
                          <ScopeTags
                            class="tray-tags"
                            :scopes="key.effectiveScopes ?? key.scopes"
                            :title="scopesSummary(key.effectiveScopes ?? key.scopes)"
                          />
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
                <span v-else class="key-hidden">仅接入实例所有者可查看访问密钥</span>
                <p v-if="keysFailure" class="key-failed">{{ keysFailure }}</p>
              </td>
              <td class="cell-used">
                <time v-if="lastUsed" :datetime="lastUsed" :title="formatTime(lastUsed)">
                  {{ formatRelative(lastUsed) }}
                </time>
                <template v-else>–</template>
              </td>
              <td class="cell-owner">
                {{ ownerName(client.ownerAccountId)
                }}<span v-if="client.ownerAccountId === me.data.value?.id" class="app-mine"
                  >我的</span
                >
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

  <UModal
    v-model:open="open"
    title="新建接入实例"
    :dismissible="!creating"
    :close="!creating"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <form id="create-client" class="space-y-4" @submit.prevent="create">
        <UFormField label="标识" help="小写字母、数字和连字符，例如 claudecode、qqbot">
          <UInput v-model="form.slug" class="w-full font-mono" required />
        </UFormField>
        <UFormField label="名称">
          <UInput v-model="form.name" class="w-full" required />
        </UFormField>
        <UFormField label="运行时" help="决定生命周期钩子的输出格式">
          <div class="runtime-grid" role="radiogroup" aria-label="运行时">
            <label
              v-for="opt in RUNTIME_OPTIONS"
              :key="opt.value"
              :data-selected="form.runtimeFamily === opt.value"
              class="runtime-card"
            >
              <input
                v-model="form.runtimeFamily"
                type="radio"
                name="client-runtime-family"
                :value="opt.value"
                class="sr-only"
              />
              <RuntimeIcon :family="opt.value" :size="18" class="runtime-card-icon" />
              <span class="runtime-card-text">
                <span class="runtime-card-name">{{ opt.label }}</span>
                <span class="runtime-card-hint">{{ opt.hint }}</span>
              </span>
            </label>
          </div>
        </UFormField>
        <UFormField label="默认人格">
          <USelect
            v-model="form.defaultPersonaId"
            :items="personaItems"
            value-key="value"
            class="w-full"
          />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="creating" @click="open = false">
          取消
        </UButton>
        <UButton type="submit" form="create-client" :loading="creating">创建</UButton>
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
.tray-tags {
  margin: 2px 0;
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
  font-size: 13px;
}
.runtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.runtime-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}
.runtime-card:hover {
  border-color: var(--strata-rule);
}
.runtime-card:has(input:focus-visible) {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: 2px;
}
.runtime-card[data-selected='true'] {
  border-color: var(--ui-text-highlighted);
  background: var(--ui-bg-elevated);
}
.runtime-card-icon {
  display: inline-block;
  flex: none;
  margin-top: 2px;
  color: var(--ui-text);
}
.runtime-card-text {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.runtime-card-name {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--ui-text-highlighted);
}
.runtime-card-hint {
  font-size: 12px;
  line-height: 1.35;
  color: var(--ui-text-muted);
}
@media (max-width: 639.98px) {
  .runtime-grid {
    grid-template-columns: minmax(0, 1fr);
  }
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
