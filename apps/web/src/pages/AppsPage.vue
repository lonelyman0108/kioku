<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { RUNTIME_FAMILIES, type AppInfo, type RuntimeFamily } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import AppKeys from '../components/AppKeys.vue'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'

const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const role = computed(() => space.value?.role ?? 'viewer')
const canCreate = computed(() => role.value === 'owner' || role.value === 'editor')
// 应用的设置与 Key 只有应用主人能管，而且主人在空间里还得是 owner 或 editor（被降为 viewer 后就不能改了）
const ownsApp = (app: { ownerAccountId: string }) =>
  canCreate.value && app.ownerAccountId === me.data.value?.id

const apps = useQuery({
  queryKey: computed(() => ['apps', spaceId.value]),
  queryFn: () => api.apps(spaceId.value),
})
const personas = useQuery({
  queryKey: computed(() => ['personas', spaceId.value]),
  queryFn: () => api.personas(spaceId.value),
})
const personaItems = computed(() => [
  { label: '不使用人格', value: null },
  ...(personas.data.value ?? []).map((p) => ({ label: p.name, value: p.id })),
])
const runtimeItems = RUNTIME_FAMILIES.map((r) => ({ label: r, value: r }))

function failed(err: unknown, fallback: string) {
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })
}

async function update(app: AppInfo, body: Parameters<typeof api.updateApp>[2]) {
  try {
    await api.updateApp(spaceId.value, app.id, body)
    await queryClient.invalidateQueries({ queryKey: ['apps', spaceId.value] })
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    failed(err, '保存失败')
  }
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
async function create() {
  try {
    await api.createApp(spaceId.value, { ...form })
    open.value = false
    Object.assign(form, { slug: '', name: '', runtimeFamily: 'claudecode', defaultPersonaId: null })
    await queryClient.invalidateQueries({ queryKey: ['apps', spaceId.value] })
    toast.add({ title: '已创建应用', color: 'success' })
  } catch (err) {
    failed(err, '创建失败')
  }
}
</script>

<template>
  <UDashboardPanel id="apps">
    <template #header>
      <UDashboardNavbar title="应用与 Key">
        <template #right>
          <UButton v-if="canCreate" :icon="icons.add" size="sm" @click="open = true"
            >新建应用</UButton
          >
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <p class="mb-4 text-sm text-muted">
        每个接入方（Claude Code、AstrBot 等）是一个应用。应用读写的私人层属于它的主人；Key
        的权限在签发时决定，且不会超过主人当前的角色。
      </p>
      <div class="space-y-4">
        <UCard v-for="app in apps.data.value ?? []" :key="app.id">
          <template #header>
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ app.name }}</span>
              <code class="text-xs text-muted">app://{{ app.slug }}</code>
              <UBadge variant="subtle">{{ app.runtimeFamily }}</UBadge>
              <UBadge v-if="ownsApp(app)" color="primary" variant="subtle">我的</UBadge>
            </div>
          </template>
          <div class="space-y-4">
            <div v-if="ownsApp(app)" class="grid gap-4 sm:grid-cols-2">
              <UFormField label="默认人格" help="这个应用读写哪个人格的设定">
                <USelect
                  :model-value="app.defaultPersonaId"
                  :items="personaItems"
                  class="w-full"
                  @update:model-value="
                    (v) => update(app, { defaultPersonaId: (v as string | null) ?? null })
                  "
                />
              </UFormField>
              <UFormField
                label="主人私聊提升"
                help="平台账号认出是主人时，私聊可读到主人画像（内部级）"
              >
                <USwitch
                  :model-value="app.config.elevateOwnerDirect === 'internal'"
                  @update:model-value="
                    (v) => update(app, { config: v ? { elevateOwnerDirect: 'internal' } : {} })
                  "
                />
              </UFormField>
            </div>
            <AppKeys
              :space-id="spaceId"
              :app-id="app.id"
              :is-app-owner="ownsApp(app)"
              :is-space-owner="role === 'owner'"
            />
          </div>
        </UCard>
        <p v-if="apps.data.value?.length === 0" class="text-sm text-muted">还没有应用。</p>
      </div>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="open" title="新建应用">
    <template #body>
      <form id="create-app" class="space-y-4" @submit.prevent="create">
        <UFormField label="标识" help="小写字母、数字和连字符；应用层记忆放在 app://<标识>/ 下">
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
        <UButton type="submit" form="create-app">创建</UButton>
      </div>
    </template>
  </UModal>
</template>
