<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  ACCESS_CONTEXTS,
  PERSON_MEMORY_MODES,
  type AccessContext,
  type ClientConfig,
  type ClientInfo,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { forgetClient, refreshClientCaches } from '../appQueries'
import { lastUsedAt, usableKeys } from '../apps'
import AppAdvancedSettings from '../components/AppAdvancedSettings.vue'
import AppGroupPersonas from '../components/AppGroupPersonas.vue'
import AppKeys from '../components/AppKeys.vue'
import AppRecallEvents from '../components/AppRecallEvents.vue'
import AppSimulator from '../components/AppSimulator.vue'
import Hint from '../components/Hint.vue'
import KeyMatrix from '../components/KeyMatrix.vue'
import RuntimeLabel from '../components/RuntimeLabel.vue'
import SegmentedChoice from '../components/SegmentedChoice.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { useSession } from '../composables/useSession'
import { personMemoryModeLabels } from '../labels'
import { failedReads } from '../query'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me, circle } = useSession()
const circleId = computed(() => String(route.params.circleId))
const clientId = computed(() => String(route.params.clientId))
const role = computed(() => circle.value?.role ?? 'viewer')
const isCircleOwner = computed(() => role.value === 'owner')

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
const facets = useQuery({
  queryKey: computed(() => ['facets', circleId.value] as const),
  queryFn: () => api.facets(circleId.value),
})

const client = computed(() => clients.data.value?.find((a) => a.id === clientId.value) ?? null)
const isClientOwner = computed(() => client.value?.ownerAccountId === me.data.value?.id)
const canManage = computed(() => isClientOwner.value && role.value !== 'viewer')
const canDelete = computed(() => canManage.value || isCircleOwner.value)
const ownerName = computed(
  () => members.data.value?.find((m) => m.accountId === client.value?.ownerAccountId)?.displayName,
)
const personaName = computed(
  () => personas.data.value?.find((p) => p.id === client.value?.defaultPersonaId)?.name,
)
const personaItems = computed(() => [
  { label: '不使用人格', value: null },
  ...(personas.data.value ?? []).map((p) => ({ label: p.name, value: p.id })),
])

const canSeeKeys = computed(() => isClientOwner.value || isCircleOwner.value)
const keys = useQuery({
  queryKey: computed(() => ['keys', circleId.value, clientId.value] as const),
  queryFn: () => api.keys(circleId.value, clientId.value),
  enabled: canSeeKeys,
})
const seenKeys = computed(() => (canSeeKeys.value ? keys.data.value : undefined))
const usable = computed(() => usableKeys(seenKeys.value ?? []))
const failures = computed(() => failedReads([clients, personas, members]))
const lastUsed = computed(() => lastUsedAt(seenKeys.value ?? []))

const selectedKey = computed(
  () => usable.value.find((key) => key.id === route.query.key) ?? usable.value[0] ?? null,
)
function selectKey(id: string) {
  void router.replace({ query: { ...route.query, key: id } })
}
const context = computed<AccessContext>({
  get: () => ACCESS_CONTEXTS.find((c) => c === route.query.ctx) ?? 'none',
  set: (value) =>
    void router.replace({
      query: { ...route.query, ctx: value === 'none' ? undefined : value },
    }),
})

function failed(err: unknown, fallback: string) {
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })
}

async function update(body: Parameters<typeof api.updateClient>[2], done = '已保存') {
  const cid = circleId.value
  const id = clientId.value
  try {
    const saved = await api.updateClient(cid, id, body)
    queryClient.setQueryData<ClientInfo[]>(['clients', cid], (list) =>
      list?.map((a) => (a.id === id ? saved : a)),
    )
    await refreshClientCaches(queryClient, cid, id)
    toast.add({ title: done, color: 'success' })
    return true
  } catch (err) {
    failed(err, '保存失败')
    return false
  }
}

const savingConfig = ref<string | null>(null)
async function updateConfig(patch: Partial<ClientConfig>) {
  const id = clientId.value
  if (savingConfig.value === id) return
  const merged: Record<string, unknown> = { ...client.value?.config, ...patch }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  savingConfig.value = id
  try {
    await update({ config: merged as ClientConfig })
  } finally {
    if (savingConfig.value === id) savingConfig.value = null
  }
}

const personModeItems = computed(() =>
  PERSON_MEMORY_MODES.map((value) => ({
    value,
    label: personMemoryModeLabels[value],
    disabled: !canManage.value || savingConfig.value === client.value?.id,
  })),
)

const stillOn = (cid: string, id: string) =>
  route.name === 'client' && route.params.circleId === cid && route.params.clientId === id

const name = ref('')
watch(
  () => client.value?.name,
  (value) => (name.value = value ?? ''),
  { immediate: true },
)

const transferTo = ref<string | undefined>()
const transferItems = computed(() =>
  (members.data.value ?? [])
    .filter((m) => m.role !== 'viewer' && m.accountId !== client.value?.ownerAccountId)
    .map((m) => ({ label: `${m.displayName}（${m.username}）`, value: m.accountId })),
)
const transferName = computed(
  () => members.data.value?.find((m) => m.accountId === transferTo.value)?.displayName,
)
const confirmingTransfer = ref(false)
const transferringId = ref<string | null>(null)
const transferring = computed(() => transferringId.value === clientId.value)
function closeTransfer() {
  if (transferring.value) return
  confirmingTransfer.value = false
  transferTo.value = undefined
}
async function transfer() {
  if (!transferTo.value || transferring.value) return
  const cid = circleId.value
  const id = clientId.value
  transferringId.value = id
  try {
    const done = await update(
      { ownerAccountId: transferTo.value },
      '已转移，原有访问密钥已全部吊销',
    )
    if (done && stillOn(cid, id)) {
      confirmingTransfer.value = false
      transferTo.value = undefined
    }
  } finally {
    if (transferringId.value === id) transferringId.value = null
  }
}

const confirmingDelete = ref(false)
const deletingId = ref<string | null>(null)
const deleting = computed(() => deletingId.value === clientId.value)
async function remove(target: ClientInfo) {
  if (deleting.value) return
  const cid = circleId.value
  deletingId.value = target.id
  try {
    await api.deleteClient(cid, target.id)
    if (stillOn(cid, target.id)) {
      confirmingDelete.value = false
      await router.replace({ name: 'clients', params: { circleId: cid } })
    }
    toast.add({ title: `已删除接入实例「${target.name}」`, color: 'success' })
    await forgetClient(queryClient, cid, target.id)
  } catch (err) {
    failed(err, '删除失败')
  } finally {
    if (deletingId.value === target.id) deletingId.value = null
  }
}

watch([circleId, clientId], () => {
  confirmingTransfer.value = false
  confirmingDelete.value = false
  transferTo.value = undefined
})
</script>

<template>
  <div class="app-page">
    <div v-if="failures.length" class="app-failed">
      <ReadFailureNote v-for="failure in failures" :key="failure.key" :query="failure.read" />
    </div>
    <div v-if="clients.isPending.value" class="app-state"><USkeleton class="h-40 w-full" /></div>
    <div v-else-if="clients.data.value && !client" class="app-state">
      <NoteLine>接入实例不存在或已删除</NoteLine>
      <UButton
        :to="{ name: 'clients', params: { circleId } }"
        size="sm"
        color="primary"
        variant="outline"
      >
        返回接入实例列表
      </UButton>
    </div>
    <template v-else-if="client">
      <header class="app-head">
        <div class="app-title">
          <nav class="crumbs" aria-label="路径">
            <RouterLink :to="{ name: 'clients', params: { circleId } }">接入实例</RouterLink>
            <i aria-hidden="true">›</i>
            <span>{{ client.name }}</span>
          </nav>
          <h1>{{ client.name }}</h1>
          <code>{{ client.slug }}</code>
        </div>
        <dl class="app-meta">
          <div>
            <dt>运行时</dt>
            <dd><RuntimeLabel :family="client.runtimeFamily" /></dd>
          </div>
          <div>
            <dt>默认人格</dt>
            <dd>{{ personaName ?? '–' }}</dd>
          </div>
          <div>
            <dt>有效访问密钥</dt>
            <dd class="font-mono">{{ seenKeys ? usable.length : '–' }}</dd>
          </div>
          <div>
            <dt>最近使用</dt>
            <dd>
              <time v-if="lastUsed" :datetime="lastUsed" :title="formatTime(lastUsed)">
                {{ formatRelative(lastUsed) }}
              </time>
              <template v-else>{{ usable.length ? '尚未使用' : '–' }}</template>
            </dd>
          </div>
          <div>
            <dt>所有者</dt>
            <dd>{{ ownerName ?? '–' }}<span v-if="isClientOwner" class="app-mine">我的</span></dd>
          </div>
        </dl>
      </header>

      <div class="app-grid" :class="{ solo: !selectedKey }">
        <AppKeys
          class="app-keys-area"
          :circle-id="circleId"
          :circle-kind="circle?.kind ?? 'shared'"
          :client-id="client.id"
          :is-client-owner="isClientOwner"
          :can-issue="canManage"
          :is-circle-owner="isCircleOwner"
          :selected="selectedKey?.id ?? null"
          :personas="personas.data.value ?? []"
          :linked-circle-options="me.data.value?.circles ?? []"
          :vocabulary="facets.data.value ?? null"
          @select="selectKey"
        />

        <KeyMatrix
          v-if="selectedKey"
          v-model:context="context"
          class="app-matrix-area"
          :circle-id="circleId"
          :client-id="client.id"
          :key-info="selectedKey"
        />

        <section class="app-settings-area">
          <SectionHeading title="设置" />
          <p v-if="!canManage" class="set-note">仅接入实例所有者可修改设置</p>
          <div class="set">
            <label :for="`client-name-${client.id}`">名称</label>
            <div class="set-name">
              <UInput :id="`client-name-${client.id}`" v-model="name" :disabled="!canManage" />
              <UButton
                v-if="canManage"
                color="primary"
                variant="outline"
                :disabled="!name.trim() || name === client.name"
                @click="update({ name: name.trim() })"
                >保存</UButton
              >
            </div>
          </div>
          <div class="set">
            <span class="set-label">
              默认人格
              <Hint>未配置按群规则或密钥人格覆盖时使用的人格设定。</Hint>
              <RouterLink
                v-if="client.defaultPersonaId"
                :to="{
                  name: 'vocabulary',
                  params: { circleId },
                  query: { tab: 'personas', persona: client.defaultPersonaId },
                }"
                class="set-link"
                >查看人格</RouterLink
              >
            </span>
            <USelect
              :model-value="client.defaultPersonaId"
              :items="personaItems"
              value-key="value"
              class="set-select"
              aria-label="默认人格"
              :disabled="!canManage"
              @update:model-value="
                (v) => update({ defaultPersonaId: (v as string | null) ?? null })
              "
            />
          </div>
          <div class="set col">
            <div class="set-mode-row">
              <span class="set-label">
                人物跨群识人模式
                <Hint>
                  严格单群隔离下各群事实互不流转；拟人跨群识人允许在未开单群隔离锁的群与私聊间按需召回同一发言人事实。
                </Hint>
              </span>
              <SegmentedChoice
                :model-value="client.config.personMemoryMode ?? 'strict'"
                :items="personModeItems"
                label="人物跨群识人模式"
                @update:model-value="(v) => updateConfig({ personMemoryMode: v })"
              />
            </div>
          </div>
          <div class="set">
            <USwitch
              label="本人私聊提权至内部敏感级"
              :model-value="client.config.elevateOwnerDirect === 'internal'"
              :disabled="!canManage || savingConfig === client.id"
              @update:model-value="
                (v) => updateConfig({ elevateOwnerDirect: v ? 'internal' : undefined })
              "
            />
            <Hint>识别为本人的私聊可读取内部及以下词条（受接入实例与密钥透镜上限约束）。</Hint>
          </div>
          <div class="set">
            <USwitch
              label="记录召回提示语"
              :model-value="client.config.recordPrompt !== false"
              :disabled="!canManage || savingConfig === client.id"
              @update:model-value="(v) => updateConfig({ recordPrompt: v ? undefined : false })"
            />
            <Hint>保留提示语前 200 字，疑似凭据的片段自动打码，仅所有者可见。</Hint>
          </div>
          <div class="set col">
            <AppGroupPersonas
              :circle-id="circleId"
              :client-id="client.id"
              :can-manage="canManage"
              :personas="personas.data.value ?? []"
              :personas-loaded="personas.isSuccess.value"
            />
          </div>
          <div v-if="isCircleOwner || canDelete" class="set-actions">
            <UButton
              v-if="isCircleOwner"
              color="primary"
              variant="outline"
              @click="confirmingTransfer = true"
            >
              转移接入实例
            </UButton>
            <UButton
              v-if="canDelete"
              color="error"
              variant="outline"
              @click="confirmingDelete = true"
            >
              删除接入实例
            </UButton>
          </div>
        </section>

        <div class="app-side-area">
          <!-- 模拟按接入实例所有者的视角执行，仅给接入实例所有者 -->
          <AppSimulator
            v-if="isClientOwner"
            class="app-boot-area"
            :circle-id="circleId"
            :client-id="client.id"
            :key-id="selectedKey?.id"
            :settings="`${client.defaultPersonaId}:${client.config.elevateOwnerDirect ?? ''}:${client.config.personMemoryMode ?? ''}`"
            :vocabulary="facets.data.value ?? null"
          />
          <AppRecallEvents class="app-events-area" :circle-id="circleId" :client-id="client.id" />
        </div>
        <AppAdvancedSettings
          v-if="canSeeKeys"
          class="app-advanced-area"
          :circle-id="circleId"
          :client-id="client.id"
        />
      </div>
    </template>
  </div>

  <UModal
    :open="confirmingTransfer"
    title="转移这个接入实例？"
    :dismissible="!transferring"
    @update:open="(v) => !v && closeTransfer()"
  >
    <template #body>
      <div class="space-y-3 text-sm">
        <USelect
          v-model="transferTo"
          :items="transferItems"
          value-key="value"
          placeholder="选择新所有者（记忆圈所有者或编辑者）"
          aria-label="新所有者"
          class="w-full"
        />
        <p v-if="transferTo">
          转移给 {{ transferName }} 后，「{{
            client?.name
          }}」现有的访问密钥全部吊销，新所有者需重新签发；成员私有视角与凭据归属将切换为
          {{ transferName }}。
        </p>
        <p v-else>
          转移后现有访问密钥全部吊销，新所有者需重新签发。
          <Hint>接入实例无上下文请求与凭据授权属于其所有者，转移后改为新所有者。</Hint>
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="transferring" @click="closeTransfer"
          >取消</UButton
        >
        <UButton color="warning" :disabled="!transferTo" :loading="transferring" @click="transfer"
          >转移</UButton
        >
      </div>
    </template>
  </UModal>

  <UModal
    :open="confirmingDelete"
    title="删除这个接入实例？"
    :dismissible="!deleting"
    @update:open="(v) => !v && !deleting && (confirmingDelete = false)"
  >
    <template #body>
      <div class="space-y-2 text-sm">
        <p>
          删除「{{
            client?.name
          }}」后，其全部访问密钥与按群规则将一并删除，使用这些访问密钥的客户端将立即失去访问权限。
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="deleting"
          @click="confirmingDelete = false"
          >取消</UButton
        >
        <UButton color="error" :loading="deleting" @click="client && remove(client)">删除</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.app-page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 32px 56px;
}
.app-failed {
  max-width: 640px;
  padding-top: 8px;
}
.app-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  max-width: 640px;
  padding-top: 8px;
}
.app-state > * {
  width: 100%;
}
.app-state > a {
  width: auto;
}
.app-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 32px;
  padding-bottom: 15px;
}
.app-title {
  min-width: 0;
}
.crumbs {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.crumbs a:hover {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.crumbs span {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-title h1 {
  font-size: 28px;
  font-weight: 500;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.app-title code {
  display: block;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.app-meta {
  flex: none;
  display: flex;
  gap: 30px;
}
.app-meta dt {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.app-meta dd {
  max-width: 14em;
  overflow: hidden;
  font-size: 14px;
  line-height: 1.55;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-mine {
  margin-left: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.app-grid {
  display: grid;
  grid-template-columns: 420px minmax(0, 1fr);
  gap: 0 36px;
}
.app-keys-area {
  grid-column: 1;
  grid-row: 1;
}
.app-matrix-area {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
}
.app-settings-area {
  grid-column: 1;
  grid-row: 2;
  margin-top: 30px;
}
.app-side-area {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  gap: 30px;
  margin-top: 30px;
  min-width: 0;
}
.app-grid.solo .app-side-area {
  grid-row: 1 / span 2;
  margin-top: 0;
}
.app-advanced-area {
  grid-column: 1 / -1;
  grid-row: 3;
  max-width: 60rem;
  margin-top: 30px;
}
.set {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 7px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
}
.set.col {
  display: block;
  padding: 11px 0 13px;
}
.set-mode-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.set-note {
  padding: 10px 0 6px;
  font-size: 14px;
  color: var(--ui-text-muted);
}
.set-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.set-link {
  margin-left: 4px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.set-link:hover {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.set-select {
  flex: 0 1 200px;
  min-width: 0;
}
.set-name {
  flex: 0 1 260px;
  display: flex;
  gap: 6px;
  min-width: 0;
}
.set-name > :first-child {
  flex: 1;
  min-width: 0;
}
.set-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
}

@media (max-width: 1240px) {
  .app-grid,
  .app-grid.solo {
    grid-template-columns: minmax(0, 1fr);
  }
  .app-keys-area,
  .app-matrix-area,
  .app-settings-area {
    grid-column: 1;
    grid-row: auto;
  }
  .app-grid .app-side-area {
    display: contents;
  }
  .app-matrix-area,
  .app-boot-area,
  .app-events-area {
    margin-top: 30px;
  }
  .app-boot-area {
    order: 3;
  }
  .app-settings-area {
    order: 4;
  }
  .app-advanced-area {
    grid-column: 1;
    grid-row: auto;
    order: 5;
  }
  .app-events-area {
    order: 6;
  }
}
@media (max-width: 1023.98px) {
  .app-page {
    padding: 12px 16px 40px;
  }
  .app-head {
    display: block;
  }
  .app-meta {
    flex-wrap: wrap;
    gap: 6px 20px;
    margin-top: 9px;
  }
}
</style>
