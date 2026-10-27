<script setup lang="ts">
import type { CommandPaletteItem, DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useConsoleSearch } from '../composables/useConsoleSearch'
import { confirmDiscard, hasUnsavedChanges } from '../composables/unsavedChanges'
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
  void router.push({ name: 'overview', params: { spaceId: id } })
}

const nav = computed<NavigationMenuItem[]>(() => {
  const id = space.value?.id
  if (!id) return []
  const params = { spaceId: id }
  return [
    { label: '概览', icon: icons.overview, to: { name: 'overview', params } },
    { label: '记忆', icon: icons.memories, to: { name: 'memories', params } },
    { label: '活动', icon: icons.activity, to: { name: 'activity', params } },
    { label: '人格', icon: icons.personas, to: { name: 'personas', params } },
    { label: '应用与 Key', icon: icons.apps, to: { name: 'apps', params } },
    { label: '空间设置', icon: icons.spaceSettings, to: { name: 'space-settings', params } },
  ]
})
const instanceNav = computed<NavigationMenuItem[]>(() =>
  me.data.value?.isAdmin
    ? [{ label: '实例设置', icon: icons.settings, to: { name: 'settings' } }]
    : [],
)

// ⌘K 里的页面与侧栏一致；记忆的搜索结果来自服务端
const pages = computed<CommandPaletteItem[]>(() =>
  [...nav.value, ...instanceNav.value].map((item) => ({
    label: item.label,
    icon: item.icon,
    to: item.to,
  })),
)
const {
  term: searchTerm,
  loading: searching,
  groups: searchGroups,
} = useConsoleSearch(
  computed(() => space.value?.id ?? null),
  pages,
)

const displayName = computed(() => me.data.value?.displayName ?? '')
const userMenu = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: displayName.value, description: me.data.value?.username }],
  [{ label: '退出登录', icon: icons.logout, onSelect: () => void logout() }],
])

async function logout() {
  // 先确认未保存的修改，取消就什么都不做；确认之后再去服务端退出
  const hadUnsaved = hasUnsavedChanges.value
  if (!confirmDiscard()) return
  try {
    await api.logout()
  } catch (err) {
    // 会话已经失效（例如在别的标签页退出过）时返回 401，照样清掉本地状态；
    // 其他错误说明服务端的会话可能还在，不能装作已经退出，未保存的修改也还在，要继续受保护
    if (!(err instanceof ApiError && err.status === 401)) {
      hasUnsavedChanges.value = hadUnsaved
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
    <UDashboardSidebar collapsible :ui="{ footer: 'border-t border-default' }">
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
        <UDashboardSearchButton :collapsed="collapsed" label="搜索记忆…" />
        <UNavigationMenu :items="nav" :collapsed="collapsed" orientation="vertical" />
        <UNavigationMenu
          v-if="instanceNav.length"
          :items="instanceNav"
          :collapsed="collapsed"
          orientation="vertical"
          class="mt-auto"
        />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full items-center gap-1">
          <UDropdownMenu :items="userMenu" :content="{ align: 'start' }">
            <UButton
              :avatar="{ alt: displayName }"
              :label="collapsed ? undefined : displayName"
              color="neutral"
              variant="ghost"
              class="min-w-0 flex-1"
              aria-label="账号菜单"
            />
          </UDropdownMenu>
          <UColorModeButton v-if="!collapsed" />
        </div>
      </template>
    </UDashboardSidebar>

    <UDashboardSearch
      v-model:search-term="searchTerm"
      :groups="searchGroups"
      :loading="searching"
      placeholder="搜索记忆的 URI、关键词或内容，或跳转到页面"
    />

    <!-- 地址里的空间不是自己的（被移出了、或打开了旧链接）：说明情况，不展示别的空间的内容和操作 -->
    <UDashboardPanel v-if="me.data.value && route.params.spaceId && !space" id="not-member">
      <template #body>
        <div class="space-y-3">
          <p class="text-muted">你不是这个空间的成员，或者已经被移出。</p>
          <UButton :to="{ name: 'home' }" variant="subtle">回到我的空间</UButton>
        </div>
      </template>
    </UDashboardPanel>
    <RouterView v-else />
  </UDashboardGroup>
</template>
