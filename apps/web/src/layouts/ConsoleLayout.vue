<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { computed } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { ME_KEY, useSession } from '../composables/useSession'
import { icons } from '../icons'
import { queryClient } from '../query'

const router = useRouter()
const { me, space } = useSession()

const spaceItems = computed(() =>
  (me.data.value?.spaces ?? []).map((s) => ({ label: s.name, value: s.id })),
)

function switchSpace(id: string) {
  void router.push({ name: 'memories', params: { spaceId: id } })
}

const nav = computed<NavigationMenuItem[]>(() => {
  const id = space.value?.id
  if (!id) return []
  const items: NavigationMenuItem[] = [
    { label: '记忆', icon: icons.memories, to: { name: 'memories', params: { spaceId: id } } },
    { label: '人格', icon: icons.personas, to: { name: 'personas', params: { spaceId: id } } },
    { label: '应用与 Key', icon: icons.apps, to: { name: 'apps', params: { spaceId: id } } },
  ]
  if (me.data.value?.isAdmin)
    items.push({ label: '实例设置', icon: icons.settings, to: { name: 'settings' } })
  return items
})

async function logout() {
  await api.logout()
  queryClient.setQueryData(ME_KEY, null)
  await router.replace({ name: 'login' })
}
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar collapsible>
      <template #header="{ collapsed }">
        <div class="flex w-full items-center gap-2">
          <span v-if="!collapsed" class="font-semibold">Kioku</span>
          <USelect
            v-if="!collapsed && spaceItems.length > 1"
            :model-value="space?.id"
            :items="spaceItems"
            class="ml-auto min-w-0 flex-1"
            @update:model-value="switchSpace"
          />
        </div>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu :items="nav" :collapsed="collapsed" orientation="vertical" />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full items-center gap-2">
          <UAvatar :alt="me.data.value?.displayName" size="xs" />
          <span v-if="!collapsed" class="truncate text-sm">{{ me.data.value?.displayName }}</span>
          <UButton
            v-if="!collapsed"
            :icon="icons.logout"
            color="neutral"
            variant="ghost"
            class="ml-auto"
            aria-label="退出登录"
            @click="logout"
          />
        </div>
      </template>
    </UDashboardSidebar>

    <RouterView />
  </UDashboardGroup>
</template>
