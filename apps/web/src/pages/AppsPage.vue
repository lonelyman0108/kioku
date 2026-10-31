<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { RUNTIME_FAMILIES, type RuntimeFamily } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import { useSession } from '../composables/useSession'
import { refreshAppCaches } from '../appQueries'
import { icons } from '../icons'

const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const role = computed(() => space.value?.role ?? 'viewer')
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
  personas.data.value?.find((p) => p.id === id)?.name ?? '—'
const ownerName = (id: string) =>
  members.data.value?.find((m) => m.accountId === id)?.displayName ?? '—'

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
  <UDashboardPanel id="apps">
    <template #header>
      <UDashboardNavbar title="应用">
        <template #right>
          <UButton v-if="canCreate" :icon="icons.add" size="sm" @click="open = true"
            >新建应用</UButton
          >
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <p class="mb-4 text-sm text-muted">
        每个接入的客户端（如 Claude Code、AstrBot）对应一个应用。
        <Hint>
          应用读写的私人层属于应用所有者。Key
          的权限在签发时确定，且不超过所有者当前的角色。点击名称可进入应用的设置、Key 与权限范围。
        </Hint>
      </p>
      <UTable
        :data="apps.data.value ?? []"
        :loading="apps.isPending.value"
        :columns="[
          { accessorKey: 'name', header: '名称' },
          { accessorKey: 'slug', header: '标识' },
          { accessorKey: 'runtimeFamily', header: '运行时' },
          {
            id: 'persona',
            header: '默认人格',
            cell: ({ row }) => personaName(row.original.defaultPersonaId),
          },
          {
            id: 'owner',
            header: '所有者',
            cell: ({ row }) => ownerName(row.original.ownerAccountId),
          },
        ]"
        empty="暂无应用"
      >
        <template #name-cell="{ row }">
          <RouterLink
            :to="{ name: 'app', params: { spaceId, appId: row.original.id } }"
            class="font-medium text-primary hover:underline"
            >{{ row.original.name }}</RouterLink
          >
          <UBadge
            v-if="row.original.ownerAccountId === me.data.value?.id"
            class="ml-2"
            color="primary"
            variant="subtle"
            size="sm"
            >我的</UBadge
          >
        </template>
        <template #slug-cell="{ row }">
          <code class="text-xs">app://{{ row.original.slug }}</code>
        </template>
      </UTable>
    </template>
  </UDashboardPanel>

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
