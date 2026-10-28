<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ConsoleCredential, CredentialProvider } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import CredentialDetail from '../components/CredentialDetail.vue'
import CredentialFormModal from '../components/CredentialFormModal.vue'
import ProviderFormModal from '../components/ProviderFormModal.vue'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { credentialSourceLabels, providerKindLabels, restrictedAppsLabel } from '../labels'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
// 管理凭据要 secret 级，和签发 Key 的规则一样只有空间 owner 有；别的成员只能看自己凭据的说明
const canManage = computed(() => space.value?.role === 'owner')

type Tab = 'credentials' | 'providers' | 'deleted'
const tab = ref<Tab>('credentials')
const tabItems = [
  { label: '凭据', value: 'credentials', icon: icons.credentials },
  { label: '凭据源', value: 'providers', icon: icons.provider },
  { label: '已删除', value: 'deleted', icon: icons.remove },
]

const credentials = useQuery({
  queryKey: computed(() => ['credentials', spaceId.value] as const),
  queryFn: ({ queryKey: [, id] }) => api.credentials(id),
})
const deleted = useQuery({
  queryKey: computed(() => ['credentials-deleted', spaceId.value] as const),
  queryFn: ({ queryKey: [, id] }) => api.deletedCredentials(id),
  enabled: computed(() => tab.value === 'deleted'),
})
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

const columns = [
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'identifier', header: '标识' },
  { id: 'source', header: '来源' },
  { id: 'fields', header: '字段' },
  { accessorKey: 'referenceCount', header: '引用' },
  { id: 'apps', header: '限定应用' },
  { accessorKey: 'updatedAt', header: '更新' },
]
const deletedColumns = [
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'identifier', header: '标识' },
  { accessorKey: 'deletedAt', header: '删除于' },
  { id: 'actions', header: '' },
]

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
    toast.add({ title: `已撤销删除 ${restored.identifier}`, color: 'success' })
    await refreshLists(sid)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '撤销删除失败', color: 'error' })
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
  <UDashboardPanel id="credentials">
    <template #header>
      <UDashboardNavbar title="凭据">
        <template #right>
          <UButton
            v-if="canManage && tab === 'providers'"
            :icon="icons.add"
            size="sm"
            @click="openProvider(null)"
          >
            添加凭据源
          </UButton>
          <UButton v-else-if="canManage" :icon="icons.add" size="sm" @click="openCreate">
            新建凭据
          </UButton>
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <UTabs
          v-model="tab"
          :items="tabItems"
          :content="false"
          variant="link"
          size="sm"
          class="w-full"
        />
      </UDashboardToolbar>
    </template>

    <template #body>
      <p class="mb-4 text-sm text-muted">
        密码、Token 不写进记忆：正文里只放占位符，例如
        <code v-pre>{{cred:file-server#password}}</code
        >，agent 用到时才取值。值由 Kioku 加密保存，或者留在你的密码管理器里（凭据源），由 agent
        在本机取。每个成员只看得到自己的凭据。<template v-if="!canManage"
          >管理凭据与查看托管的值要空间 owner 才行。</template
        >
      </p>

      <template v-if="tab === 'credentials'">
        <UAlert
          v-if="credentials.isError.value"
          color="error"
          variant="subtle"
          :title="
            credentials.error.value instanceof ApiError
              ? credentials.error.value.message
              : '读取失败'
          "
        />
        <UTable
          v-else
          :data="credentials.data.value?.items ?? []"
          :columns="columns"
          :loading="credentials.isPending.value"
          empty="还没有凭据"
        >
          <template #name-cell="{ row }">
            <UButton
              variant="link"
              color="neutral"
              class="p-0"
              @click="selectedId = row.original.id"
            >
              {{ row.original.name }}
            </UButton>
          </template>
          <template #identifier-cell="{ row }">
            <code class="text-xs">{{ row.original.identifier }}</code>
          </template>
          <template #source-cell="{ row }">{{ sourceOf(row.original) }}</template>
          <template #fields-cell="{ row }">
            <span class="text-xs">{{ row.original.fields.map((f) => f.name).join('、') }}</span>
          </template>
          <template #apps-cell="{ row }">{{ appsOf(row.original) }}</template>
          <template #updatedAt-cell="{ row }">
            <time :datetime="row.original.updatedAt" :title="formatTime(row.original.updatedAt)">
              {{ formatRelative(row.original.updatedAt) }}
            </time>
          </template>
        </UTable>
        <p v-if="credentials.data.value?.truncated" class="mt-2 text-xs text-muted">
          只列出了前 1000 条。
        </p>
      </template>

      <template v-else-if="tab === 'providers'">
        <p class="mb-3 text-sm text-muted">
          凭据源是你用的密码管理器（或别的取值方式）。Kioku 不保存它的访问凭据，外部来源的值一律由
          agent 在本机取；使用说明会原样给 agent 看。
        </p>
        <div class="space-y-3">
          <UCard v-for="p in providers.data.value ?? []" :key="p.id">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ p.name }}</span>
              <UBadge variant="subtle">{{ providerKindLabels[p.kind] }}</UBadge>
              <span class="text-xs text-muted">{{ p.credentialCount }} 条凭据绑定它</span>
              <div v-if="canManage" class="ml-auto flex gap-1">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.edit"
                  @click="openProvider(p)"
                >
                  修改
                </UButton>
                <UTooltip
                  :text="p.credentialCount ? '还有凭据绑定它，先改绑或删除这些凭据' : undefined"
                  :disabled="!p.credentialCount"
                >
                  <UButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    :icon="icons.remove"
                    :disabled="p.credentialCount > 0"
                    @click="removingProvider = p"
                  >
                    删除
                  </UButton>
                </UTooltip>
              </div>
            </div>
            <p v-if="p.instructions" class="mt-2 text-sm whitespace-pre-wrap">
              {{ p.instructions }}
            </p>
            <p v-else class="mt-2 text-sm text-muted">没有写使用说明。</p>
          </UCard>
          <p v-if="providers.data.value && !providers.data.value.length" class="text-sm text-muted">
            还没有凭据源。都由 Kioku 托管的话，可以不加。
          </p>
        </div>
      </template>

      <template v-else>
        <p class="mb-3 text-sm text-muted">
          删除的凭据可以撤销删除；同一个标识已经有一条有效的凭据时不能撤销。
        </p>
        <UTable
          :data="deleted.data.value?.items ?? []"
          :columns="deletedColumns"
          :loading="deleted.isPending.value"
          empty="没有删除的凭据"
        >
          <template #name-cell="{ row }">
            <UButton
              variant="link"
              color="neutral"
              class="p-0"
              @click="selectedId = row.original.id"
            >
              {{ row.original.name }}
            </UButton>
          </template>
          <template #identifier-cell="{ row }">
            <code class="text-xs">{{ row.original.identifier }}</code>
          </template>
          <template #deletedAt-cell="{ row }">
            <time :datetime="row.original.deletedAt!" :title="formatTime(row.original.deletedAt!)">
              {{ formatRelative(row.original.deletedAt!) }}
            </time>
          </template>
          <template #actions-cell="{ row }">
            <UButton
              v-if="canManage"
              size="xs"
              variant="subtle"
              :icon="icons.undelete"
              :loading="busy"
              @click="undelete(row.original)"
            >
              撤销删除
            </UButton>
          </template>
        </UTable>
      </template>
    </template>
  </UDashboardPanel>

  <USlideover
    :open="selectedId !== null"
    :title="detail?.name ?? '凭据'"
    :ui="{ content: 'max-w-xl' }"
    @update:open="(v) => !v && (selectedId = null)"
  >
    <template #body>
      <UAlert
        v-if="selected.isError.value"
        color="error"
        variant="subtle"
        :title="
          selected.error.value instanceof ApiError ? selected.error.value.message : '读取失败'
        "
      />
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
        删除之后，引用它的占位符取不到值；可以在「已删除」里撤销。还有记忆引用它时删不掉。
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
      <p class="text-sm">已删除的凭据如果绑定过它，撤销删除之后要重新绑定。</p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="removingProvider = null">取消</UButton>
        <UButton color="error" :loading="busy" @click="removeProvider">删除</UButton>
      </div>
    </template>
  </UModal>
</template>
