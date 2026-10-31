<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type {
  ConsoleCredential,
  CredentialProvider,
  DeletedCredentialProvider,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import CredentialDetail from '../components/CredentialDetail.vue'
import CredentialFormModal from '../components/CredentialFormModal.vue'
import Hint from '../components/Hint.vue'
import ProviderFormModal from '../components/ProviderFormModal.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import PageHead from '../components/strata/PageHead.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { useNow } from '../composables/useNow'
import { useSession } from '../composables/useSession'
import { credentialSourceLabels, providerKindLabels, restrictedAppsLabel } from '../labels'
import { deletionNotice, providerPurgeNote, purgeAt, purgeNote } from '../retention'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
// 管理凭据要 secret 级，和签发 Key 的规则一样只有空间 owner 有；别的成员只能看自己凭据的说明
const canManage = computed(() => space.value?.role === 'owner')

// 凭据源是单独一块，一直显示；左边在有效的凭据和已删除之间切换
type Tab = 'credentials' | 'deleted'
const tab = ref<Tab>('credentials')
const tabItems = [
  { label: '有效', value: 'credentials' },
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
const deletedProviders = useQuery({
  queryKey: computed(() => ['credential-providers-deleted', spaceId.value] as const),
  queryFn: ({ queryKey: [, id] }) => api.deletedCredentialProviders(id),
  enabled: showingDeleted,
})
// 已删除的凭据与凭据源过了保留期永久清除：保留期两个列表都带着，是同一个
const retention = computed(() => deleted.data.value?.retention ?? null)
// 还剩几天按它算：停在「已删除」上时每分钟跟着变，切到别的标签时停下
const now = useNow(60_000, showingDeleted)
const credentialNotes = computed(() => {
  const r = retention.value
  const items = deleted.data.value?.items ?? []
  return new Map(r ? items.map((c) => [c.id, purgeNote(c.deletedAt!, r, now.value)]) : [])
})
const providerNotes = computed(() => {
  const r = deletedProviders.data.value?.retention
  const items = deletedProviders.data.value?.items ?? []
  return new Map(r ? items.map((p) => [p.id, providerPurgeNote(p, r, now.value)]) : [])
})
// 凭据源的说明为什么是这个时间：还有凭据指着时说怎样才会清除，等已删除的凭据时说明要等它们
function providerPurgeTitle(p: DeletedCredentialProvider): string {
  const r = deletedProviders.data.value?.retention
  if (p.retentionFrom === null) {
    return '已恢复的凭据仍绑定此凭据源。改绑或删除这些凭据后，才按保留期清除。'
  }
  const at = r ? formatTime(purgeAt(p.retentionFrom, r).toISOString()) : ''
  return new Date(p.retentionFrom).getTime() > new Date(p.deletedAt).getTime()
    ? `随绑定它的已删除凭据一起清除，最早在 ${at} 之后`
    : `最早在 ${at} 之后清除`
}
const providers = useQuery({
  queryKey: computed(() => ['credential-providers', spaceId.value] as const),
  queryFn: ({ queryKey: [, id] }) => api.credentialProviders(id),
})
const apps = useQuery({
  queryKey: computed(() => ['apps', spaceId.value] as const),
  queryFn: ({ queryKey: [, id] }) => api.apps(id),
})

const sourceOf = (c: ConsoleCredential) =>
  c.source === 'hosted'
    ? credentialSourceLabels.hosted
    : c.provider
      ? `${c.provider.name}${c.provider.deleted ? '（已删除）' : ''}`
      : credentialSourceLabels.external
const appsOf = (c: ConsoleCredential) =>
  restrictedAppsLabel(c.appIds, apps.data.value, me.data.value?.id)

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
const providerOpen = ref(false)
const editingProvider = ref<CredentialProvider | null>(null)
// 切换空间时关掉打开着的窗口：里面的内容属于上一个空间。详情不关，它记在地址里、跟着地址走：
// 按浏览历史在两个空间的凭据之间前进后退时，地址里的 id 本来就是那个空间的
watch(spaceId, () => {
  formOpen.value = false
  providerOpen.value = false
  removing.value = null
  removingProvider.value = null
})

async function refreshLists(sid: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['credentials', sid] }),
    queryClient.invalidateQueries({ queryKey: ['credentials-deleted', sid] }),
    queryClient.invalidateQueries({ queryKey: ['credential-providers', sid] }),
    queryClient.invalidateQueries({ queryKey: ['credential-providers-deleted', sid] }),
  ])
}

function openCreate() {
  editing.value = null
  formOpen.value = true
}
function openEdit() {
  editing.value = detail.value
  formOpen.value = true
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

function openProvider(provider: CredentialProvider | null) {
  editingProvider.value = provider
  providerOpen.value = true
}
const removingProvider = ref<CredentialProvider | null>(null)
async function removeProvider() {
  const target = removingProvider.value
  if (!target || busy.value) return
  const sid = spaceId.value
  busy.value = true
  try {
    await api.deleteCredentialProvider(sid, target.id)
    removingProvider.value = null
    toast.add({ title: `已删除凭据源 ${target.name}`, color: 'success' })
    await refreshLists(sid)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '删除失败', color: 'error' })
    removingProvider.value = null
    await refreshLists(sid)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="credentials">
    <PageHead title="凭据">
      <template #note>
        密码与 Token 存为凭据，记忆正文只放占位符，例如
        <code v-pre class="font-mono text-[13px]">{{cred:file-server#password}}</code
        >。<Hint>
          Agent 用到时才取值。值由 Kioku 加密保存，或保留在密码管理器（凭据源）中，由 Agent
          在本机获取。凭据仅所有者可见。<template v-if="!canManage"
            >管理凭据与查看托管的值需要空间所有者权限。</template
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
            v-if="canManage"
            class="shrink-0 self-center"
            size="sm"
            color="primary"
            variant="outline"
            @click="openCreate"
          >
            新建凭据
          </UButton>
        </div>

        <div v-if="tab === 'credentials'" class="column-body">
          <div v-if="credentials.isError.value" class="pt-3.5">
            <NoteLine tone="error">
              {{
                credentials.error.value instanceof ApiError
                  ? credentials.error.value.message
                  : '读取失败'
              }}
            </NoteLine>
          </div>
          <div v-else-if="credentials.isPending.value" class="space-y-2 pt-3.5">
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
                  <span :class="{ 'text-warning': c.provider?.deleted }">{{ sourceOf(c) }}</span>
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
          <p v-else class="empty">暂无凭据</p>
          <p v-if="credentials.data.value?.truncated" class="ledger-note">仅显示前 1000 条</p>
        </div>

        <div v-else class="column-body">
          <p class="deleted-note">
            已删除的凭据在保留期内可以恢复。<Hint>同一标识已有有效凭据时无法恢复。</Hint>
          </p>
          <p v-if="retention" class="deleted-note text-warning">{{ deletionNotice(retention) }}</p>
          <div v-if="deleted.isError.value" class="pt-3.5">
            <NoteLine tone="error">
              {{
                deleted.error.value instanceof ApiError ? deleted.error.value.message : '读取失败'
              }}
            </NoteLine>
          </div>
          <div v-else-if="deleted.isPending.value" class="space-y-2 pt-3.5">
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
          <p v-else class="empty">暂无已删除的凭据</p>

          <template v-if="deletedProviders.data.value?.items.length">
            <SectionHeading class="mt-7" title="已删除的凭据源" />
            <p class="deleted-note">
              已删除的凭据源无法恢复。<Hint>
                仍有凭据绑定时（包括可恢复的已删除凭据），等这些凭据清除后才清除。
              </Hint>
            </p>
            <ul>
              <li v-for="p in deletedProviders.data.value.items" :key="p.id" class="provider-gone">
                <span class="font-medium">{{ p.name }}</span>
                <span class="row-muted">{{ providerKindLabels[p.kind] }}</span>
                <span class="row-muted">
                  删除于
                  <time :datetime="p.deletedAt" :title="formatTime(p.deletedAt)">
                    {{ formatRelative(p.deletedAt, now) }}
                  </time>
                </span>
                <span
                  v-if="providerNotes.get(p.id)"
                  :class="providerNotes.get(p.id)!.soon ? 'text-warning' : 'row-muted'"
                  :title="providerPurgeTitle(p)"
                >
                  {{ providerNotes.get(p.id)!.text }}
                </span>
              </li>
            </ul>
            <p v-if="deletedProviders.data.value.truncated" class="ledger-note">仅显示前 1000 个</p>
          </template>
        </div>
      </section>

      <section class="side-column">
        <SectionHeading title="凭据源">
          <template #hint>
            <Hint>
              凭据源是密码管理器或其他取值方式，值由 Agent 在本机获取。Kioku
              不保存凭据源的访问凭据。使用说明会原样发送给 Agent。
            </Hint>
          </template>
          <template v-if="canManage" #actions>
            <UButton size="xs" color="primary" variant="outline" @click="openProvider(null)">
              添加凭据源
            </UButton>
          </template>
        </SectionHeading>
        <ul v-if="providers.data.value?.length">
          <li v-for="p in providers.data.value" :key="p.id" class="provider-row">
            <div class="provider-head">
              <span class="provider-name">{{ p.name }}</span>
              <div v-if="canManage" class="flex shrink-0 gap-1">
                <UButton size="xs" color="neutral" variant="ghost" @click="openProvider(p)">
                  修改
                </UButton>
                <UTooltip
                  :text="
                    p.credentialCount
                      ? '无法删除：仍有凭据绑定。请先改绑或删除这些凭据。'
                      : undefined
                  "
                  :disabled="!p.credentialCount"
                >
                  <UButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    :disabled="p.credentialCount > 0"
                    @click="removingProvider = p"
                  >
                    删除
                  </UButton>
                </UTooltip>
              </div>
            </div>
            <p class="row-muted">
              {{ providerKindLabels[p.kind] }} · 已绑定
              <b class="font-mono font-medium">{{ p.credentialCount }}</b> 条凭据
            </p>
            <p v-if="p.instructions" class="provider-instructions">{{ p.instructions }}</p>
            <p v-else class="row-muted">暂无使用说明</p>
          </li>
        </ul>
        <p v-else-if="providers.isError.value" class="empty text-error">
          {{
            providers.error.value instanceof ApiError ? providers.error.value.message : '读取失败'
          }}
        </p>
        <p v-else-if="providers.data.value" class="empty">
          暂无凭据源。全部由 Kioku 托管时无需添加。
        </p>
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
      <NoteLine v-if="selected.isError.value" tone="error">
        {{ selected.error.value instanceof ApiError ? selected.error.value.message : '读取失败' }}
      </NoteLine>
      <CredentialDetail
        v-else-if="detail"
        :space-id="spaceId"
        :credential="detail"
        :apps="apps.data.value"
        :can-manage="canManage"
        @edit="openEdit"
        @remove="removing = detail"
        @undelete="undelete(detail)"
      />
      <USkeleton v-else class="h-40 w-full" />
    </template>
  </USlideover>

  <CredentialFormModal
    v-model:open="formOpen"
    :space-id="spaceId"
    :credential="editing"
    :providers="providers.data.value ?? []"
    :apps="apps.data.value ?? []"
    @saved="onSaved"
    @conflict="onConflict"
  />
  <ProviderFormModal
    v-model:open="providerOpen"
    :space-id="spaceId"
    :provider="editingProvider"
    @saved="(sid) => refreshLists(sid)"
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
  <UModal
    :open="removingProvider !== null"
    :title="`删除凭据源 ${removingProvider?.name ?? ''}？`"
    @update:open="(v) => !v && (removingProvider = null)"
  >
    <template #body>
      <p class="text-sm">删除后无法恢复。曾绑定它的已删除凭据恢复后需重新绑定。</p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="removingProvider = null">取消</UButton>
        <UButton color="error" :loading="busy" @click="removeProvider">删除</UButton>
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
  grid-template-columns: minmax(0, 1fr) 360px;
  align-items: stretch;
  border-top: 1px solid var(--strata-rule);
}
.main-column {
  min-width: 0;
  border-right: 1px solid var(--strata-rule);
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
.side-column {
  min-width: 0;
  padding: 12px 32px 40px 24px;
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
.provider-gone {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 12px;
  padding: 8px 0 7px;
  border-bottom: 1px solid var(--ui-border);
  line-height: 1.5;
}
.provider-row {
  padding: 8px 0 10px;
  border-bottom: 1px solid var(--ui-border);
  line-height: 1.55;
}
.provider-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.provider-name {
  min-width: 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.provider-instructions {
  margin-top: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 表格放不下时，凭据源放到下面 */
@media (max-width: 1240px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
  .main-column {
    border-right: 0;
  }
  .side-column {
    padding: 14px 32px 40px;
    border-top: 1px solid var(--strata-rule);
  }
}
/* 窄屏：一行拆成几行，字段和限定应用带上名字 */
@media (max-width: 1023.98px) {
  .column-head {
    padding: 0 16px 0 7px;
  }
  .column-body {
    padding: 0 16px 24px;
  }
  .side-column {
    padding: 14px 16px 32px;
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
    content: attr(data-label) ' ';
    margin-right: 6px;
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 400;
    color: var(--ui-text-muted);
  }
}
</style>
