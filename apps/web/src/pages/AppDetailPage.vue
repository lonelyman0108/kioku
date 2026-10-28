<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { AppConfig, AppInfo } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import AppGroupPersonas from '../components/AppGroupPersonas.vue'
import AppKeys from '../components/AppKeys.vue'
import AppRecallEvents from '../components/AppRecallEvents.vue'
import AppSimulator from '../components/AppSimulator.vue'
import { forgetApp, refreshAppCaches } from '../appQueries'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'

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
const personaItems = computed(() => [
  { label: '不使用人格', value: null },
  ...(personas.data.value ?? []).map((p) => ({ label: p.name, value: p.id })),
])

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
async function transfer() {
  if (!transferTo.value || transferring.value) return
  const sid = spaceId.value
  const id = appId.value
  transferringId.value = id
  try {
    const done = await update({ ownerAccountId: transferTo.value }, '已转移，原来的 Key 都已吊销')
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
  <UDashboardPanel id="app">
    <template #header>
      <UDashboardNavbar :title="app?.name ?? '应用'">
        <template #leading>
          <UButton
            :icon="icons.back"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="返回应用列表"
            :to="{ name: 'apps', params: { spaceId } }"
          />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <USkeleton v-if="apps.isPending.value" class="h-40 w-full" />
      <UAlert
        v-else-if="apps.isError.value && !apps.data.value"
        color="error"
        variant="subtle"
        :title="apps.error.value instanceof ApiError ? apps.error.value.message : '读取失败'"
      />
      <UAlert
        v-else-if="!app"
        color="neutral"
        variant="subtle"
        title="应用不存在，可能已经被删除。"
      />
      <div v-else class="max-w-3xl space-y-6">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <code class="text-xs text-muted">app://{{ app.slug }}</code>
          <UBadge variant="subtle">{{ app.runtimeFamily }}</UBadge>
          <UBadge v-if="isAppOwner" color="primary" variant="subtle">我的</UBadge>
          <span class="text-muted">主人：{{ ownerName ?? '—' }}</span>
        </div>

        <UCard>
          <template #header><h2 class="text-sm font-medium">设置</h2></template>
          <p v-if="!canManage" class="mb-4 text-sm text-muted">应用的设置只有它的主人能改。</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="名称">
              <div class="flex gap-2">
                <UInput v-model="name" class="w-full" :disabled="!canManage" />
                <UButton
                  v-if="canManage"
                  variant="subtle"
                  class="shrink-0"
                  :disabled="!name.trim() || name === app.name"
                  @click="update({ name: name.trim() })"
                  >保存</UButton
                >
              </div>
            </UFormField>
            <UFormField label="默认人格" help="这个应用读写哪个人格的设定">
              <template v-if="app.defaultPersonaId" #hint>
                <RouterLink
                  :to="{
                    name: 'personas',
                    params: { spaceId },
                    query: { id: app.defaultPersonaId },
                  }"
                  class="text-primary hover:underline"
                  >查看人格</RouterLink
                >
              </template>
              <USelect
                :model-value="app.defaultPersonaId"
                :items="personaItems"
                class="w-full"
                :disabled="!canManage"
                @update:model-value="
                  (v) => update({ defaultPersonaId: (v as string | null) ?? null })
                "
              />
            </UFormField>
            <UFormField
              label="主人私聊提升"
              help="平台账号认出是主人时，私聊可读到主人画像（内部级）"
            >
              <USwitch
                :model-value="app.config.elevateOwnerDirect === 'internal'"
                :disabled="!canManage || savingConfig === app.id"
                @update:model-value="
                  (v) => updateConfig({ elevateOwnerDirect: v ? 'internal' : undefined })
                "
              />
            </UFormField>
            <UFormField
              label="召回事件记录提示语"
              help="记下每次召回时提示语的前 200 字（像凭据的片段打码），只有你看得到"
            >
              <USwitch
                :model-value="app.config.recordPrompt !== false"
                :disabled="!canManage || savingConfig === app.id"
                @update:model-value="(v) => updateConfig({ recordPrompt: v ? undefined : false })"
              />
            </UFormField>
          </div>
        </UCard>

        <UCard>
          <AppGroupPersonas :space-id="spaceId" :app-id="app.id" :can-manage="canManage" />
        </UCard>

        <UCard>
          <AppKeys
            :space-id="spaceId"
            :app-id="app.id"
            :is-app-owner="isAppOwner"
            :can-issue="canManage"
            :is-space-owner="isSpaceOwner"
          />
        </UCard>

        <!-- 模拟会读到应用主人的私人层，只给应用主人 -->
        <UCard v-if="isAppOwner">
          <AppSimulator
            :space-id="spaceId"
            :app-id="app.id"
            :settings="`${app.defaultPersonaId}:${app.config.elevateOwnerDirect ?? ''}`"
          />
        </UCard>

        <UCard>
          <AppRecallEvents :space-id="spaceId" :app-id="app.id" />
        </UCard>

        <UCard v-if="isSpaceOwner">
          <template #header><h2 class="text-sm font-medium">转给别的成员</h2></template>
          <p class="mb-3 text-sm text-muted">
            应用读写的画像层与私人层属于它的主人。转移之后这个应用现有的 Key
            全部吊销，新主人要重新签发。
          </p>
          <div class="flex flex-wrap gap-2">
            <USelect
              v-model="transferTo"
              :items="transferItems"
              placeholder="选择新主人（owner 或 editor）"
              aria-label="新主人"
              class="min-w-60"
            />
            <UButton
              :icon="icons.transfer"
              variant="subtle"
              :disabled="!transferTo"
              @click="confirmingTransfer = true"
              >转移</UButton
            >
          </div>
        </UCard>

        <UCard v-if="canDelete">
          <template #header><h2 class="text-sm font-medium">删除应用</h2></template>
          <div class="flex flex-wrap items-center gap-3">
            <p class="flex-1 text-sm text-muted">
              它的 Key 一起删除。还有应用层记忆（含已删除的）时删不掉，要先移到别的命名空间。
            </p>
            <UButton color="error" variant="subtle" @click="confirmingDelete = true">删除</UButton>
          </div>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>

  <UModal
    :open="confirmingTransfer"
    title="转移这个应用？"
    :dismissible="!transferring"
    @update:open="(v) => !v && !transferring && (confirmingTransfer = false)"
  >
    <template #body>
      <p class="text-sm">
        转给 {{ transferName }} 之后，「{{ app?.name }}」现有的 Key
        全部吊销，它读到的画像层与私人层换成 {{ transferName }} 的。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="transferring"
          @click="confirmingTransfer = false"
          >取消</UButton
        >
        <UButton color="warning" :loading="transferring" @click="transfer">转移</UButton>
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
      <p class="text-sm">
        删除「{{ app?.name }}」和它的全部 Key，用这些 Key 的接入方会立刻失去访问权限。
      </p>
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
