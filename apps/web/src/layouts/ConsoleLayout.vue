<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ME_KEY, useSession } from '../composables/useSession'
import { icons } from '../icons'
import { queryClient } from '../query'

const router = useRouter()
const route = useRoute()
const toast = useToast()
const { me, space } = useSession()

// 会话过期或在别的标签页退出后，当前账号会变成 null：带人回登录页，登录后回到原来的页面
let loggingOut = false
watch(
  () => me.data.value,
  (m) => {
    if (m === null && !loggingOut) {
      void router.replace({ name: 'login', query: { next: route.fullPath } })
    }
  },
)

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
  try {
    await api.logout()
  } catch (err) {
    // 会话已经失效（例如在别的标签页退出过）时返回 401，照样清掉本地状态；
    // 其他错误说明服务端的会话可能还在，不能装作已经退出
    if (!(err instanceof ApiError && err.status === 401)) {
      toast.add({
        title: err instanceof ApiError ? err.message : '退出失败，请重试',
        color: 'error',
      })
      return
    }
  }
  loggingOut = true
  // 清掉全部缓存：下一个在这个标签页登录的人不能看到上一个人的记忆
  queryClient.clear()
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
