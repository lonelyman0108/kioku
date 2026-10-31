<script setup lang="ts">
import type { CommandPaletteItem, DropdownMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ownedApps } from '../benchSession'
import KiokuMark from '../components/KiokuMark.vue'
import StrataPatterns from '../components/strata/StrataPatterns.vue'
import { COLOR_PREFERENCES, useColorPreference } from '../composables/useColorPreference'
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

const spaces = computed(() => me.data.value?.spaces ?? [])

function switchSpace(id: string) {
  void router.push({ name: 'overview', params: { spaceId: id } })
}

// 测试台只给应用主人（会读到主人的私人层）：这个空间里没有自己的应用时不显示入口，后端同样拒绝
const apps = useQuery({
  queryKey: computed(() => ['apps', space.value?.id] as const),
  queryFn: ({ queryKey: [, id] }) => api.apps(id!),
  enabled: computed(() => Boolean(space.value)),
})
const ownsApp = computed(() => ownedApps(apps.data.value ?? [], me.data.value?.id).length > 0)

interface NavItem {
  label: string
  icon: string
  to: RouteLocationRaw
  // 这些路由算在这个入口下：详情页也要点亮列表的入口
  routes: string[]
}

// 顶部导航按用途分组。路由名和路径不变，入口的名字按术语表
const navGroups = computed<{ title?: string; items: NavItem[] }[]>(() => {
  const id = space.value?.id
  if (!id) return []
  const params = { spaceId: id }
  const link = (name: string, icon: string, routes = [name]) => ({
    icon,
    to: { name, params },
    routes,
  })
  return [
    {
      items: [
        { label: '概览', ...link('overview', icons.overview) },
        { label: '记忆', ...link('memories', icons.memories) },
        { label: '待处理', ...link('review', icons.review) },
      ],
    },
    {
      title: '知识',
      items: [
        { label: '人格', ...link('personas', icons.personas) },
        { label: '联系人', ...link('subjects', icons.subjects, ['subjects', 'subject']) },
        { label: '凭据', ...link('credentials', icons.credentials) },
      ],
    },
    {
      title: '接入',
      items: [
        { label: '应用', ...link('apps', icons.apps, ['apps', 'app']) },
        { label: '召回', ...link('recall', icons.recall) },
        ...(ownsApp.value ? [{ label: '测试台', ...link('bench', icons.bench) }] : []),
      ],
    },
    {
      title: '空间',
      items: [
        { label: '变更记录', ...link('activity', icons.activity) },
        // 「设置」指向空间设置，实例设置放在账号菜单里
        { label: '设置', ...link('space-settings', icons.spaceSettings) },
      ],
    },
  ]
})
const instanceNav = computed<NavItem[]>(() =>
  me.data.value?.isAdmin
    ? [{ label: '实例设置', icon: icons.settings, to: { name: 'settings' }, routes: ['settings'] }]
    : [],
)
const isCurrent = (item: NavItem) => item.routes.includes(String(route.name))

// ⌘K 里的页面与导航一致；记忆的搜索结果来自服务端
const pages = computed<CommandPaletteItem[]>(() =>
  [...navGroups.value.flatMap((group) => group.items), ...instanceNav.value].map((item) => ({
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

const colorPreference = useColorPreference()
const displayName = computed(() => me.data.value?.displayName ?? '')
const userMenu = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: displayName.value, description: me.data.value?.username }],
  ...(instanceNav.value.length
    ? [instanceNav.value.map((item) => ({ label: item.label, icon: item.icon, to: item.to }))]
    : []),
  [
    { type: 'label', label: '主题' },
    ...COLOR_PREFERENCES.map((option): DropdownMenuItem => ({
      type: 'checkbox',
      label: option.label,
      icon: option.icon,
      checked: colorPreference.current() === option.value,
      onSelect: () => colorPreference.set(option.value),
    })),
  ],
  [{ label: '退出登录', icon: icons.logout, onSelect: () => void logout() }],
])
const spaceMenu = computed<DropdownMenuItem[][]>(() => [
  spaces.value.map((s) => ({
    type: 'checkbox',
    label: s.name,
    checked: s.id === space.value?.id,
    onSelect: () => switchSpace(s.id),
  })),
])

// 窄屏的导航收进抽屉，换页就关上
const navOpen = ref(false)
watch(
  () => route.fullPath,
  () => {
    navOpen.value = false
  },
)

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
  <!--
    过渡：老页面还在用 UDashboardPanel，面板拖动和 ⌘K 都靠 UDashboardGroup 提供上下文。
    Group 默认左右排，这里改成上下排，顶部导航在上、页面在下。页面都换完之后去掉 Group
  -->
  <UDashboardGroup class="flex-col">
    <StrataPatterns />

    <header
      class="flex h-13 shrink-0 items-stretch gap-4 border-b border-rule px-4 min-[1121px]:gap-6 min-[1121px]:px-8"
    >
      <RouterLink :to="{ name: 'home' }" class="flex shrink-0 items-center">
        <KiokuMark />
      </RouterLink>

      <nav class="flex items-stretch max-[901px]:hidden" aria-label="主导航">
        <div
          v-for="(group, index) in navGroups"
          :key="index"
          class="relative flex items-stretch"
          :class="index > 0 ? 'nav-group ml-1 pl-1 min-[1321px]:ml-2 min-[1321px]:pl-2' : ''"
        >
          <span
            v-if="group.title"
            class="self-center pr-px pl-2 text-xs whitespace-nowrap text-muted max-[1320px]:hidden"
          >
            {{ group.title }}
          </span>
          <RouterLink
            v-for="item in group.items"
            :key="item.label"
            :to="item.to"
            :aria-current="isCurrent(item) ? 'page' : undefined"
            class="nav-link flex items-center px-1.5 whitespace-nowrap min-[1121px]:px-2"
          >
            {{ item.label }}
          </RouterLink>
        </div>
      </nav>

      <div class="ml-auto flex items-center gap-1.5">
        <UDashboardSearchButton
          label="搜索"
          aria-label="搜索"
          color="neutral"
          :ui="{
            label: 'max-[1320px]:hidden',
            trailing: 'hidden min-[901px]:flex items-center gap-0.5 ms-1',
          }"
        />
        <div class="flex items-center gap-1.5 max-[901px]:hidden">
          <UDropdownMenu
            v-if="spaces.length > 1"
            :items="spaceMenu"
            :content="{ align: 'end' }"
            size="sm"
          >
            <UButton
              :label="space?.name ?? '选择空间'"
              :trailing-icon="icons.chevronDown"
              color="neutral"
              variant="ghost"
              aria-label="切换空间"
            />
          </UDropdownMenu>
          <span v-else-if="space" class="px-2.5 text-[13px] whitespace-nowrap text-muted">
            {{ space.name }}
          </span>
          <UDropdownMenu :items="userMenu" :content="{ align: 'end' }">
            <UButton
              :label="displayName"
              :trailing-icon="icons.chevronDown"
              color="neutral"
              variant="ghost"
              aria-label="账号菜单"
            />
          </UDropdownMenu>
        </div>
        <UButton
          :icon="icons.menu"
          color="neutral"
          variant="ghost"
          class="min-[901px]:hidden"
          aria-label="打开导航"
          @click="navOpen = true"
        />
      </div>
    </header>

    <USlideover
      v-model:open="navOpen"
      side="left"
      title="导航"
      :ui="{ content: 'max-w-72', body: 'p-0 sm:p-0' }"
    >
      <template #body>
        <nav aria-label="主导航">
          <div
            v-for="(group, index) in navGroups"
            :key="index"
            class="border-b border-default px-5 py-2"
          >
            <p v-if="group.title" class="pt-1 text-xs text-muted">{{ group.title }}</p>
            <RouterLink
              v-for="item in group.items"
              :key="item.label"
              :to="item.to"
              :aria-current="isCurrent(item) ? 'page' : undefined"
              class="block py-2 text-[15px]/6 aria-[current=page]:font-semibold"
              @click="navOpen = false"
            >
              {{ item.label }}
            </RouterLink>
          </div>
        </nav>
        <div class="space-y-3 px-5 py-4">
          <div v-if="spaces.length > 1">
            <p class="pb-1 text-xs text-muted">空间</p>
            <button
              v-for="s in spaces"
              :key="s.id"
              type="button"
              class="block w-full py-1.5 text-left text-sm/6"
              :class="s.id === space?.id ? 'font-semibold' : ''"
              :aria-current="s.id === space?.id ? 'true' : undefined"
              @click="switchSpace(s.id)"
            >
              {{ s.name }}
            </button>
          </div>
          <div>
            <p class="pb-1 text-xs text-muted">主题</p>
            <div class="flex gap-1">
              <UButton
                v-for="option in COLOR_PREFERENCES"
                :key="option.value"
                :label="option.label"
                :variant="colorPreference.current() === option.value ? 'solid' : 'subtle'"
                :color="colorPreference.current() === option.value ? 'primary' : 'neutral'"
                size="sm"
                :aria-pressed="colorPreference.current() === option.value"
                @click="colorPreference.set(option.value)"
              />
            </div>
          </div>
          <div class="border-t border-default pt-3">
            <p class="pb-1 text-sm">{{ displayName }}</p>
            <RouterLink
              v-for="item in instanceNav"
              :key="item.label"
              :to="item.to"
              class="block py-1.5 text-sm/6"
              @click="navOpen = false"
            >
              {{ item.label }}
            </RouterLink>
            <button type="button" class="block w-full py-1.5 text-left text-sm/6" @click="logout">
              退出登录
            </button>
          </div>
        </div>
      </template>
    </USlideover>

    <UDashboardSearch
      v-model:search-term="searchTerm"
      :groups="searchGroups"
      :loading="searching"
      placeholder="搜索记忆的 URI、关键词或内容，或跳转到页面"
    />

    <main class="flex min-h-0 flex-1">
      <!-- 地址里的空间不是自己的（被移出了、或打开了旧链接）：说明情况，不展示别的空间的内容和操作 -->
      <UDashboardPanel v-if="me.data.value && route.params.spaceId && !space" id="not-member">
        <template #body>
          <div class="space-y-3">
            <p class="text-muted">当前账号不是这个空间的成员，或已被移出。</p>
            <UButton :to="{ name: 'home' }" variant="subtle">返回我的空间</UButton>
          </div>
        </template>
      </UDashboardPanel>
      <RouterView v-else />
    </main>
  </UDashboardGroup>
</template>

<style scoped>
/* 组之间一条短竖线 */
.nav-group::before {
  content: '';
  position: absolute;
  left: 0;
  top: 19px;
  bottom: 19px;
  width: 1px;
  background: var(--ui-border-accented);
}

/* 当前页靠字重和一条压在导航墨线上的 2px 墨线区分 */
.nav-link:hover {
  box-shadow: inset 0 -1px 0 var(--ui-text-highlighted);
}
.nav-link[aria-current='page'] {
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--ui-text-highlighted);
}
</style>
