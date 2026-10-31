<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { ACCESS_CONTEXTS, type AccessContext, type AppConfig, type AppInfo } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import AppGroupPersonas from '../components/AppGroupPersonas.vue'
import AppKeys from '../components/AppKeys.vue'
import AppRecallEvents from '../components/AppRecallEvents.vue'
import AppSimulator from '../components/AppSimulator.vue'
import Hint from '../components/Hint.vue'
import KeyMatrix from '../components/KeyMatrix.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { forgetApp, refreshAppCaches } from '../appQueries'
import { lastUsedAt } from '../apps'
import { usableKeys } from '../benchSession'
import { useSession } from '../composables/useSession'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const appId = computed(() => String(route.params.appId))
const role = computed(() => space.value?.role ?? 'viewer')
const isSpaceOwner = computed(() => role.value === 'owner')

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
const app = computed(() => apps.data.value?.find((a) => a.id === appId.value) ?? null)
const isAppOwner = computed(() => app.value?.ownerAccountId === me.data.value?.id)
// 应用的设置与 Key 只有应用主人能管，而且主人在空间里还得是 owner 或 editor（被降为 viewer 后就不能改了）
const canManage = computed(() => isAppOwner.value && role.value !== 'viewer')
const canDelete = computed(() => canManage.value || isSpaceOwner.value)
const ownerName = computed(
  () => members.data.value?.find((m) => m.accountId === app.value?.ownerAccountId)?.displayName,
)
const personaName = computed(
  () => personas.data.value?.find((p) => p.id === app.value?.defaultPersonaId)?.name,
)
const personaItems = computed(() => [
  { label: '不使用人格', value: null },
  ...(personas.data.value ?? []).map((p) => ({ label: p.name, value: p.id })),
])

// 只有应用所有者和空间所有者能看 Key。AppKeys 用同一份缓存
const canSeeKeys = computed(() => isAppOwner.value || isSpaceOwner.value)
const keys = useQuery({
  queryKey: computed(() => ['keys', spaceId.value, appId.value]),
  queryFn: () => api.keys(spaceId.value, appId.value),
  enabled: canSeeKeys,
})
const usable = computed(() => usableKeys(keys.data.value ?? []))
const lastUsed = computed(() => lastUsedAt(keys.data.value ?? []))

// 看的是哪个 Key、哪种会话上下文：记在地址里。地址里的 Key 失效了就看第一个有效的
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

// 发请求时的空间与应用记下来：请求期间换了页面，刷新的仍是被改的那个应用
async function update(body: Parameters<typeof api.updateApp>[2], done = '已保存') {
  const sid = spaceId.value
  const id = appId.value
  try {
    const saved = await api.updateApp(sid, id, body)
    // 先把返回的这一版写进缓存：接着改别的设置时，拼的是这一版，不会盖掉刚保存的
    queryClient.setQueryData<AppInfo[]>(['apps', sid], (list) =>
      list?.map((a) => (a.id === id ? saved : a)),
    )
    await refreshAppCaches(queryClient, sid, id)
    toast.add({ title: done, color: 'success' })
    return true
  } catch (err) {
    failed(err, '保存失败')
    return false
  }
}

// 应用配置整个替换：改一项时带上其余几项，没设的不写（不设就是默认）。保存期间两个开关都不能动，
// 否则第二次拼的还是改之前的配置，会把第一次的改动盖掉
const savingConfig = ref<string | null>(null)
async function updateConfig(patch: Partial<AppConfig>) {
  const id = appId.value
  if (savingConfig.value === id) return
  const merged: Record<string, unknown> = { ...app.value?.config, ...patch }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  savingConfig.value = id
  try {
    await update({ config: merged as AppConfig })
  } finally {
    if (savingConfig.value === id) savingConfig.value = null
  }
}

// 还停在发请求时的那个应用的页面上吗：请求返回之后，换了页面就不再动这一页的弹窗与选择
const stillOn = (sid: string, id: string) =>
  route.name === 'app' && route.params.spaceId === sid && route.params.appId === id

// 名称在输入框里改，点保存才提交；换了应用（或数据重新读出来）时回到服务端的值
const name = ref('')
watch(
  () => app.value?.name,
  (value) => (name.value = value ?? ''),
  { immediate: true },
)

// 转移：只有空间 owner 能做，新主人要是 owner 或 editor；转移会吊销这个应用现有的全部 Key
const transferTo = ref<string | undefined>()
const transferItems = computed(() =>
  (members.data.value ?? [])
    .filter((m) => m.role !== 'viewer' && m.accountId !== app.value?.ownerAccountId)
    .map((m) => ({ label: `${m.displayName}（${m.username}）`, value: m.accountId })),
)
const transferName = computed(
  () => members.data.value?.find((m) => m.accountId === transferTo.value)?.displayName,
)
// 转移与删除进行中记的是哪个应用：换到别的应用时，那边的按钮不跟着转圈
const confirmingTransfer = ref(false)
const transferringId = ref<string | null>(null)
const transferring = computed(() => transferringId.value === appId.value)
function closeTransfer() {
  if (transferring.value) return
  confirmingTransfer.value = false
  transferTo.value = undefined
}
async function transfer() {
  if (!transferTo.value || transferring.value) return
  const sid = spaceId.value
  const id = appId.value
  transferringId.value = id
  try {
    const done = await update({ ownerAccountId: transferTo.value }, '已转移，原有 Key 已全部吊销')
    if (done && stillOn(sid, id)) {
      confirmingTransfer.value = false
      transferTo.value = undefined
    }
  } finally {
    if (transferringId.value === id) transferringId.value = null
  }
}

const confirmingDelete = ref(false)
const deletingId = ref<string | null>(null)
const deleting = computed(() => deletingId.value === appId.value)
async function remove(target: AppInfo) {
  if (deleting.value) return
  const sid = spaceId.value
  deletingId.value = target.id
  try {
    await api.deleteApp(sid, target.id)
    // 还停在这个应用的页面上就先离开，再刷新列表：否则会先闪一下「应用不存在」。
    // 请求期间已经离开的，不再动它的弹窗，也不跳转
    if (stillOn(sid, target.id)) {
      confirmingDelete.value = false
      await router.replace({ name: 'apps', params: { spaceId: sid } })
    }
    toast.add({ title: `已删除应用「${target.name}」`, color: 'success' })
    await forgetApp(queryClient, sid, target.id)
  } catch (err) {
    failed(err, '删除失败')
  } finally {
    if (deletingId.value === target.id) deletingId.value = null
  }
}

// 换了空间或应用时关掉对话框：里面的内容属于上一个
watch([spaceId, appId], () => {
  confirmingTransfer.value = false
  confirmingDelete.value = false
  transferTo.value = undefined
})
</script>

<template>
  <div class="app-page">
    <div v-if="apps.isPending.value" class="app-state"><USkeleton class="h-40 w-full" /></div>
    <div v-else-if="apps.isError.value && !apps.data.value" class="app-state">
      <NoteLine tone="error">
        {{ apps.error.value instanceof ApiError ? apps.error.value.message : '读取失败' }}
      </NoteLine>
    </div>
    <div v-else-if="!app" class="app-state">
      <NoteLine>应用不存在或已删除</NoteLine>
      <UButton
        :to="{ name: 'apps', params: { spaceId } }"
        size="sm"
        color="primary"
        variant="outline"
      >
        返回应用列表
      </UButton>
    </div>
    <template v-else>
      <header class="app-head">
        <div class="app-title">
          <nav class="crumbs" aria-label="路径">
            <RouterLink :to="{ name: 'apps', params: { spaceId } }">应用</RouterLink>
            <i aria-hidden="true">›</i>
            <span>{{ app.name }}</span>
          </nav>
          <h1>{{ app.name }}</h1>
          <code>app://{{ app.slug }}</code>
        </div>
        <dl class="app-meta">
          <div>
            <dt>运行时</dt>
            <dd class="font-mono">{{ app.runtimeFamily }}</dd>
          </div>
          <div>
            <dt>默认人格</dt>
            <dd>{{ personaName ?? '–' }}</dd>
          </div>
          <div>
            <dt>有效 Key</dt>
            <dd class="font-mono">{{ canSeeKeys ? usable.length : '–' }}</dd>
          </div>
          <div>
            <dt>最近使用</dt>
            <dd>
              <time v-if="lastUsed" :datetime="lastUsed" :title="formatTime(lastUsed)">
                {{ formatRelative(lastUsed) }}
              </time>
              <template v-else>{{ canSeeKeys && usable.length ? '尚未使用' : '–' }}</template>
            </dd>
          </div>
          <div>
            <dt>所有者</dt>
            <dd>{{ ownerName ?? '–' }}<span v-if="isAppOwner" class="app-mine">我的</span></dd>
          </div>
        </dl>
      </header>

      <div class="app-grid" :class="{ solo: !selectedKey }">
        <AppKeys
          class="app-keys-area"
          :space-id="spaceId"
          :app-id="app.id"
          :is-app-owner="isAppOwner"
          :can-issue="canManage"
          :is-space-owner="isSpaceOwner"
          :selected="selectedKey?.id ?? null"
          @select="selectKey"
        />

        <KeyMatrix
          v-if="selectedKey"
          v-model:context="context"
          class="app-matrix-area"
          :space-id="spaceId"
          :app-id="app.id"
          :key-info="selectedKey"
        />

        <section class="app-settings-area">
          <SectionHeading title="设置" />
          <p v-if="!canManage" class="set-note">仅应用所有者可修改设置</p>
          <div class="set">
            <label :for="`app-name-${app.id}`">名称</label>
            <div class="set-name">
              <UInput :id="`app-name-${app.id}`" v-model="name" :disabled="!canManage" />
              <UButton
                v-if="canManage"
                color="primary"
                variant="outline"
                :disabled="!name.trim() || name === app.name"
                @click="update({ name: name.trim() })"
                >保存</UButton
              >
            </div>
          </div>
          <div class="set">
            <span class="set-label">
              默认人格
              <Hint>应用读写所选人格的设定。</Hint>
              <RouterLink
                v-if="app.defaultPersonaId"
                :to="{
                  name: 'personas',
                  params: { spaceId },
                  query: { id: app.defaultPersonaId },
                }"
                class="set-link"
                >查看人格</RouterLink
              >
            </span>
            <USelect
              :model-value="app.defaultPersonaId"
              :items="personaItems"
              class="set-select"
              aria-label="默认人格"
              :disabled="!canManage"
              @update:model-value="
                (v) => update({ defaultPersonaId: (v as string | null) ?? null })
              "
            />
          </div>
          <div class="set">
            <USwitch
              label="本人私聊时读取画像"
              :model-value="app.config.elevateOwnerDirect === 'internal'"
              :disabled="!canManage || savingConfig === app.id"
              @update:model-value="
                (v) => updateConfig({ elevateOwnerDirect: v ? 'internal' : undefined })
              "
            />
            <Hint>识别为本人的私聊可读取个人画像（内部级）。</Hint>
          </div>
          <div class="set">
            <USwitch
              label="记录召回提示语"
              :model-value="app.config.recordPrompt !== false"
              :disabled="!canManage || savingConfig === app.id"
              @update:model-value="(v) => updateConfig({ recordPrompt: v ? undefined : false })"
            />
            <Hint>保留提示语前 200 字，疑似凭据的片段自动打码，仅所有者可见。</Hint>
          </div>
          <div class="set col">
            <AppGroupPersonas
              :space-id="spaceId"
              :app-id="app.id"
              :can-manage="canManage"
              :personas="personas.data.value ?? []"
              :personas-loaded="personas.isSuccess.value"
            />
          </div>
          <div v-if="isSpaceOwner || canDelete" class="set-actions">
            <UButton
              v-if="isSpaceOwner"
              color="primary"
              variant="outline"
              @click="confirmingTransfer = true"
            >
              转移应用
            </UButton>
            <UButton
              v-if="canDelete"
              color="error"
              variant="outline"
              @click="confirmingDelete = true"
            >
              删除应用
            </UButton>
          </div>
        </section>

        <div class="app-side-area">
          <!-- 模拟会读到应用所有者的私人层，只给应用所有者 -->
          <AppSimulator
            v-if="isAppOwner"
            class="app-boot-area"
            :space-id="spaceId"
            :app-id="app.id"
            :key-id="selectedKey?.id"
            :settings="`${app.defaultPersonaId}:${app.config.elevateOwnerDirect ?? ''}`"
          />
          <AppRecallEvents class="app-events-area" :space-id="spaceId" :app-id="app.id" />
        </div>
      </div>
    </template>
  </div>

  <UModal
    :open="confirmingTransfer"
    title="转移这个应用？"
    :dismissible="!transferring"
    @update:open="(v) => !v && closeTransfer()"
  >
    <template #body>
      <div class="space-y-3 text-sm">
        <USelect
          v-model="transferTo"
          :items="transferItems"
          placeholder="选择新所有者（空间所有者或编辑者）"
          aria-label="新所有者"
          class="w-full"
        />
        <p v-if="transferTo">
          转移给 {{ transferName }} 后，「{{ app?.name }}」现有的 Key
          全部吊销，新所有者需重新签发；应用读取的个人画像层与私人层改为 {{ transferName }} 的。
        </p>
        <p v-else>
          转移后现有 Key 全部吊销，新所有者需重新签发。
          <Hint>应用读写的个人画像层与私人层属于应用所有者，转移后改为新所有者的。</Hint>
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
    title="删除这个应用？"
    :dismissible="!deleting"
    @update:open="(v) => !v && !deleting && (confirmingDelete = false)"
  >
    <template #body>
      <div class="space-y-2 text-sm">
        <p>删除「{{ app?.name }}」及其全部 Key 后，使用这些 Key 的客户端将立即失去访问权限。</p>
        <p class="text-muted">
          仍有应用层记忆时无法删除。
          <Hint>已删除但仍可恢复的应用层记忆也算在内，需先移到其他命名空间。</Hint>
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
        <UButton color="error" :loading="deleting" @click="app && remove(app)">删除</UButton>
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
/* 没有权限范围可看时（看不到 Key，或者暂无有效 Key）右栏从顶上开始 */
.app-grid.solo .app-side-area {
  grid-row: 1 / span 2;
  margin-top: 0;
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

/* 单栏时的顺序：Key、权限范围、启动加载、设置，召回记录可能很长，放最后 */
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
  .app-events-area {
    order: 5;
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
