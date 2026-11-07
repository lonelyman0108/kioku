<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ConsoleCredential, VaultConnection, VaultItemSummary } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError, retryable } from '../api/client'
import { api } from '../api/endpoints'
import CredentialDetail from '../components/CredentialDetail.vue'
import CredentialFormModal from '../components/CredentialFormModal.vue'
import Hint from '../components/Hint.vue'
import VaultConnectionPanel from '../components/VaultConnectionPanel.vue'
import VaultLoginModal from '../components/VaultLoginModal.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import PageHead from '../components/strata/PageHead.vue'
import { useNow } from '../composables/useNow'
import { useSession } from '../composables/useSession'
import { credentialSourceLabels, restrictedAppsLabel } from '../labels'
import { deletionNotice, purgeAt, purgeNote } from '../retention'
import { formatRelative, formatTime } from '../time'
import { canManageCredentials } from '../vault'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
// 凭据与密码库连接的操作都只给空间所有者，别的成员只看列表
const canManage = computed(() => canManageCredentials(space.value?.role))

// 凭据、密码库与已删除的凭据三个分页
type Tab = 'credentials' | 'vault' | 'deleted'
const tab = ref<Tab>('credentials')
const tabItems = [
  { label: '凭据', value: 'credentials' },
  { label: '密码库', value: 'vault' },
  { label: '已删除', value: 'deleted' },
]

const credentials = useQuery({
  queryKey: computed(() => ['credentials', spaceId.value] as const),
  queryFn: ({ queryKey: [, id] }) => api.credentials(id),
})
const showingDeleted = computed(() => tab.value === 'deleted')
const deleted = useQuery({
  queryKey: computed(() => ['credentials-deleted', spaceId.value] as const),
  queryFn: ({ queryKey: [, id] }) => api.deletedCredentials(id),
  enabled: showingDeleted,
})
// 已删除的凭据过了保留期永久清除
const retention = computed(() => deleted.data.value?.retention ?? null)
// 还剩几天按它算：停在「已删除」上时每分钟跟着变，切到别的标签时停下
const now = useNow(60_000, showingDeleted)
const credentialNotes = computed(() => {
  const r = retention.value
  const items = deleted.data.value?.items ?? []
  return new Map(r ? items.map((c) => [c.id, purgeNote(c.deletedAt!, r, now.value)]) : [])
})
const connections = useQuery({
  queryKey: computed(() => ['vault-connections', spaceId.value] as const),
  queryFn: ({ queryKey: [, id] }) => api.vaultConnections(id),
})
const apps = useQuery({
  queryKey: computed(() => ['apps', spaceId.value] as const),
  queryFn: ({ queryKey: [, id] }) => api.apps(id),
})

// 列表上的来源：托管，或密码库（哪个连接）
function sourceOf(c: ConsoleCredential): string {
  if (!c.vault) return credentialSourceLabels.hosted
  const conn = connections.data.value?.items.find((x) => x.id === c.vault!.connectionId)
  return conn ? `${credentialSourceLabels.vault} ${conn.email}` : credentialSourceLabels.vault
}
const appsOf = (c: ConsoleCredential) =>
  restrictedAppsLabel(c.appIds, apps.data.value, me.data.value?.id)
const identifiers = computed(() => (credentials.data.value?.items ?? []).map((c) => c.identifier))

// 详情：每次打开都按 id 重新读，删除、修改之后拿到的是最新的一版。打开的是哪一条记在地址里，
// 从记忆正文里的凭据徽章点过来时直接打开它
const selectedId = computed<string | null>({
  get: () => (typeof route.query.id === 'string' ? route.query.id : null),
  set: (id) => {
    const query = { ...route.query }
    if (id) query.id = id
    else delete query.id
    void router.replace({ query })
  },
})
const selected = useQuery({
  queryKey: computed(() => ['credential', spaceId.value, selectedId.value] as const),
  queryFn: ({ queryKey: [, sid, id] }) => api.credential(sid, id!),
  enabled: computed(() => selectedId.value !== null),
})
const detail = computed(() =>
  selected.data.value && selected.data.value.id === selectedId.value ? selected.data.value : null,
)

const formOpen = ref(false)
const editing = ref<ConsoleCredential | null>(null)
const naming = ref<{ connectionId: string; item: VaultItemSummary } | null>(null)
const loginOpen = ref(false)
const reconnecting = ref<VaultConnection | null>(null)
// 切换空间时关掉打开着的窗口：里面的内容属于上一个空间。详情不关，它记在地址里、跟着地址走：
// 按浏览历史在两个空间的凭据之间前进后退时，地址里的 id 本来就是那个空间的
watch(spaceId, () => {
  formOpen.value = false
  loginOpen.value = false
  removing.value = null
})

async function refreshLists(sid: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['credentials', sid] }),
    queryClient.invalidateQueries({ queryKey: ['credentials-deleted', sid] }),
    queryClient.invalidateQueries({ queryKey: ['vault-connections', sid] }),
    queryClient.invalidateQueries({ queryKey: ['vault-items', sid] }),
  ])
}

function openCreate() {
  editing.value = null
  naming.value = null
  formOpen.value = true
}
function openEdit() {
  editing.value = detail.value
  naming.value = null
  formOpen.value = true
}
function openNaming(connectionId: string, item: VaultItemSummary) {
  editing.value = null
  naming.value = { connectionId, item }
  formOpen.value = true
}
function openLogin(connection: VaultConnection | null) {
  reconnecting.value = connection
  loginOpen.value = true
}
// 按保存到的空间写缓存；保存期间换了空间，就不在新空间里打开它
function onSaved(credential: ConsoleCredential, sid: string) {
  queryClient.setQueryData(['credential', sid, credential.id], credential)
  void refreshLists(sid)
  if (sid === spaceId.value) selectedId.value = credential.id
}
function onConflict() {
  void selected.refetch()
}

// 删除确认：打开时记下这一版，期间被改过就返回冲突，不会删掉没看过的修改
const removing = ref<ConsoleCredential | null>(null)
const busy = ref(false)
async function remove() {
  const target = removing.value
  if (!target || busy.value) return
  const sid = spaceId.value
  busy.value = true
  try {
    await api.deleteCredential(sid, target.id, target.version)
    removing.value = null
    toast.add({ title: `已删除凭据 ${target.identifier}`, color: 'success' })
    if (selectedId.value === target.id) selectedId.value = null
    // 缓存里的详情还是删除前的样子，从「已删除」里再打开时要重新读
    queryClient.removeQueries({ queryKey: ['credential', sid, target.id], exact: true })
    await refreshLists(sid)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '删除失败', color: 'error' })
    removing.value = null
    void selected.refetch()
  } finally {
    busy.value = false
  }
}

async function undelete(c: ConsoleCredential) {
  if (busy.value) return
  const sid = spaceId.value
  busy.value = true
  try {
    const restored = await api.undeleteCredential(sid, c.id)
    queryClient.setQueryData(['credential', sid, restored.id], restored)
    toast.add({ title: `已恢复 ${restored.identifier}`, color: 'success' })
    await refreshLists(sid)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复失败', color: 'error' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="credentials">
    <PageHead title="凭据">
      <template #note>
        密码与令牌存为凭据，记忆正文只放占位符，例如
        <code v-pre class="font-mono text-[13px]">{{cred:file-server#password}}</code
        >。<Hint>
          Agent 用到时向 Kioku 取值。值由 Kioku
          加密保存，或保留在连接的密码库中、取用时获取。凭据与密码库连接仅所有者可见。<template
            v-if="!canManage"
            >管理凭据、连接密码库与查看值需要空间所有者权限。</template
          >
        </Hint>
      </template>
    </PageHead>

    <div class="columns">
      <section class="main-column" aria-label="凭据列表">
        <div class="column-head">
          <UTabs
            v-model="tab"
            :items="tabItems"
            :content="false"
            variant="link"
            size="md"
            :ui="{ root: 'min-w-0', list: 'border-0', trigger: 'px-2 py-0 h-11 text-sm/5' }"
          />
          <UButton
            v-if="canManage && tab === 'credentials'"
            class="shrink-0 self-center"
            size="sm"
            color="primary"
            variant="outline"
            @click="openCreate"
          >
            新建凭据
          </UButton>
          <UButton
            v-else-if="canManage && tab === 'vault'"
            class="shrink-0 self-center"
            size="sm"
            color="primary"
            variant="outline"
            @click="openLogin(null)"
          >
            连接密码库
          </UButton>
        </div>

        <div v-if="tab === 'credentials'" class="column-body">
          <!-- 后台刷新失败时读到过的列表留着，错误放在上面 -->
          <div v-if="credentials.isError.value" class="pt-3.5">
            <ReadFailureNote :query="credentials" />
          </div>
          <div v-if="credentials.isPending.value" class="space-y-2 pt-3.5">
            <USkeleton v-for="n in 5" :key="n" class="h-10 w-full" />
          </div>
          <template v-else-if="credentials.data.value?.items.length">
            <div class="ledger-head credential-grid" aria-hidden="true">
              <span>名称</span>
              <span>标识</span>
              <span>来源</span>
              <span>字段</span>
              <span class="num">引用</span>
              <span>限定应用</span>
              <span class="num">更新</span>
            </div>
            <ul>
              <li v-for="c in credentials.data.value.items" :key="c.id">
                <button type="button" class="ledger-row credential-grid" @click="selectedId = c.id">
                  <span class="row-name">{{ c.name }}</span>
                  <span class="row-code">{{ c.identifier }}</span>
                  <span class="row-source" data-label="来源">{{ sourceOf(c) }}</span>
                  <span class="row-fields" data-label="字段">
                    {{ c.fields.map((f) => f.name).join('、') }}
                  </span>
                  <span
                    class="num row-count"
                    :class="{ zero: !c.referenceCount }"
                    data-label="引用"
                  >
                    {{ c.referenceCount }}
                  </span>
                  <span class="row-muted row-apps" data-label="限定应用">{{ appsOf(c) }}</span>
                  <time
                    class="num row-muted row-time"
                    :datetime="c.updatedAt"
                    :title="formatTime(c.updatedAt)"
                  >
                    {{ formatRelative(c.updatedAt) }}
                  </time>
                </button>
              </li>
            </ul>
          </template>
          <p v-else-if="credentials.data.value" class="empty">暂无凭据</p>
          <p v-if="credentials.data.value?.truncated" class="ledger-note">仅显示前 1000 条</p>
        </div>

        <div v-else-if="tab === 'vault'" class="column-body">
          <p class="deleted-note">
            连接密码库后，给条目起标识，条目即成为凭据。<Hint>
              <span class="block">
                仅接受专用账号：账号中有个人条目，或在组织中是所有者、管理员时，连接被拒绝；连接后出现这些情况，连接停用。
              </span>
              <span class="mt-1 block">
                为 Kioku 单独注册一个账号，加入一个组织，只分配一个集合，把要给 Agent
                用的条目放进这个集合。条目列表不含值；未起标识的条目 Agent 无法取用。
              </span>
            </Hint>
          </p>
          <div v-if="connections.isError.value" class="pt-3.5">
            <ReadFailureNote :query="connections" />
          </div>
          <div v-if="connections.isPending.value" class="space-y-2 pt-3.5">
            <USkeleton v-for="n in 2" :key="n" class="h-16 w-full" />
          </div>
          <template v-else-if="connections.data.value?.items.length">
            <VaultConnectionPanel
              v-for="conn in connections.data.value.items"
              :key="conn.id"
              :space-id="spaceId"
              :connection="conn"
              :can-manage="canManage"
              @reconnect="openLogin(conn)"
              @open-credential="(id) => (selectedId = id)"
              @name-item="(item) => openNaming(conn.id, item)"
            />
          </template>
          <p v-else-if="connections.data.value" class="empty">暂无密码库连接</p>
        </div>

        <div v-else class="column-body">
          <p class="deleted-note">
            已删除的凭据在保留期内可以恢复。<Hint>同一标识已有有效凭据时无法恢复。</Hint>
          </p>
          <p v-if="retention" class="deleted-note text-warning">{{ deletionNotice(retention) }}</p>
          <div v-if="deleted.isError.value" class="pt-3.5">
            <ReadFailureNote :query="deleted" />
          </div>
          <div v-if="deleted.isPending.value" class="space-y-2 pt-3.5">
            <USkeleton v-for="n in 3" :key="n" class="h-10 w-full" />
          </div>
          <template v-else-if="deleted.data.value?.items.length">
            <div class="ledger-head deleted-grid" aria-hidden="true">
              <span>名称</span>
              <span>标识</span>
              <span>删除于</span>
              <span>永久清除</span>
              <span />
            </div>
            <ul>
              <li v-for="c in deleted.data.value.items" :key="c.id" class="ledger-row deleted-grid">
                <button type="button" class="row-name" @click="selectedId = c.id">
                  {{ c.name }}
                </button>
                <span class="row-code">{{ c.identifier }}</span>
                <time
                  class="row-muted row-deleted"
                  :datetime="c.deletedAt!"
                  :title="formatTime(c.deletedAt!)"
                  data-label="删除于"
                >
                  {{ formatRelative(c.deletedAt!, now) }}
                </time>
                <span
                  v-if="retention && credentialNotes.get(c.id)"
                  class="row-purge"
                  :class="credentialNotes.get(c.id)!.soon ? 'text-warning' : 'row-muted'"
                  :title="`最早在 ${formatTime(purgeAt(c.deletedAt!, retention).toISOString())} 之后清除`"
                >
                  {{ credentialNotes.get(c.id)!.text }}
                </span>
                <span v-else class="row-purge" />
                <UButton
                  v-if="canManage"
                  class="row-action"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :loading="busy"
                  @click="undelete(c)"
                >
                  恢复
                </UButton>
              </li>
            </ul>
          </template>
          <p v-else-if="deleted.data.value" class="empty">暂无已删除的凭据</p>
        </div>
      </section>
    </div>
  </div>

  <USlideover
    :open="selectedId !== null"
    :title="detail?.name ?? '凭据'"
    :ui="{ content: 'max-w-xl' }"
    @update:open="(v) => !v && (selectedId = null)"
  >
    <template #body>
      <!--
        没读到过，或者是确定的结果（别处删掉之后的 404）：只有错误，旧内容和操作都不留。
        还能再读的刷新失败才照常显示详情，错误放在上面
      -->
      <ReadFailureNote
        v-if="selected.isError.value && (!detail || !retryable(selected.error.value))"
        :query="selected"
      />
      <template v-else-if="detail">
        <ReadFailureNote v-if="selected.isError.value" :query="selected" />
        <CredentialDetail
          :space-id="spaceId"
          :credential="detail"
          :apps="apps.data.value"
          :can-manage="canManage"
          @edit="openEdit"
          @remove="removing = detail"
          @undelete="undelete(detail)"
        />
      </template>
      <USkeleton v-else class="h-40 w-full" />
    </template>
  </USlideover>

  <CredentialFormModal
    v-model:open="formOpen"
    :space-id="spaceId"
    :credential="editing"
    :vault-item="naming"
    :apps="apps.data.value ?? []"
    :identifiers="identifiers"
    @saved="onSaved"
    @conflict="onConflict"
  />
  <VaultLoginModal
    v-model:open="loginOpen"
    :space-id="spaceId"
    :connection="reconnecting"
    @connected="(_, sid) => refreshLists(sid)"
  />

  <UModal
    :open="removing !== null"
    :title="`删除凭据 ${removing?.identifier ?? ''}？`"
    @update:open="(v) => !v && (removing = null)"
  >
    <template #body>
      <p class="text-sm">
        删除后，引用它的占位符将无法取值。可在「已删除」中恢复。仍有记忆引用时无法删除。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="removing = null">取消</UButton>
        <UButton color="error" :loading="busy" @click="remove">删除</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.credentials {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
}
.columns {
  flex: 1 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch;
  border-top: 1px solid var(--strata-rule);
}
.main-column {
  min-width: 0;
}
.column-head {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 8px;
  height: 44px;
  padding: 0 32px 0 24px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.column-body {
  padding: 0 32px 40px;
}
.credential-grid {
  display: grid;
  grid-template-columns:
    minmax(9rem, 1.3fr) minmax(7rem, 1fr) minmax(5.5rem, 0.8fr) minmax(6rem, 1fr)
    2.5rem minmax(5rem, 0.8fr) 4.75rem;
  column-gap: 14px;
}
.deleted-grid {
  display: grid;
  grid-template-columns: minmax(9rem, 1.2fr) minmax(7rem, 1fr) 6rem minmax(8rem, 1fr) 4rem;
  column-gap: 14px;
}
.ledger-head {
  padding: 10px 0 6px;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.num {
  text-align: right;
}
.ledger-row {
  position: relative;
  width: 100%;
  align-items: baseline;
  padding: 9px 0 8px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.5;
  text-align: left;
  overflow-wrap: anywhere;
}
.ledger-row:hover {
  background: var(--ui-bg-muted);
}
.ledger-row:focus-visible,
.row-name:focus-visible {
  outline-offset: -2px;
}
.row-name {
  min-width: 0;
  font-weight: 500;
  text-align: left;
}
/* 已删除的一行里还有恢复按钮，不能整行是按钮：点击区撑满整行，按钮和要看说明的两格压在上面 */
button.row-name::after {
  content: '';
  position: absolute;
  inset: 0;
}
.row-deleted,
.row-purge {
  position: relative;
  z-index: 1;
}
.row-code {
  font-family: var(--font-mono);
  font-size: 13px;
}
.row-fields {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text-toned);
}
.row-count {
  font-family: var(--font-mono);
  font-weight: 500;
}
.row-count.zero {
  font-weight: 400;
  color: var(--ui-text-muted);
}
.row-muted {
  color: var(--ui-text-muted);
}
.row-time {
  font-size: 13px;
  white-space: nowrap;
}
.row-action {
  position: relative;
  z-index: 1;
  justify-self: end;
}
.ledger-note {
  padding-top: 8px;
  color: var(--ui-text-muted);
}
.empty {
  padding: 12px 0;
  color: var(--ui-text-muted);
}
.deleted-note {
  padding-top: 10px;
  line-height: 1.6;
}
.deleted-note:not(.text-warning) {
  color: var(--ui-text-muted);
}
/* 宽屏的表头只给眼睛看，读屏靠这个知道一列是什么；窄屏没有表头，它显示出来 */
[data-label]::before {
  content: attr(data-label) ' ';
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
/* 窄屏：一行拆成几行，字段和限定应用带上名字 */
@media (max-width: 1023.98px) {
  .column-head {
    padding: 0 16px 0 7px;
  }
  .column-body {
    padding: 0 16px 24px;
  }
  .ledger-head {
    display: none;
  }
  .credential-grid,
  .deleted-grid {
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 1px 12px;
  }
  .credential-grid > *,
  .deleted-grid > * {
    grid-column: 1 / -1;
  }
  .ledger-row .row-name {
    grid-row: 1;
    grid-column: 1 / 3;
  }
  .ledger-row .row-time,
  .ledger-row .row-action {
    grid-row: 1;
    grid-column: 3;
  }
  .ledger-row .row-count,
  .ledger-row .row-deleted {
    grid-column: 1;
    text-align: left;
  }
  .ledger-row .row-apps,
  .ledger-row .row-purge {
    grid-column: 2 / -1;
  }
  [data-label]::before {
    position: static;
    width: auto;
    height: auto;
    margin-right: 6px;
    overflow: visible;
    clip-path: none;
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 400;
    color: var(--ui-text-muted);
  }
}
</style>
