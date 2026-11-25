<script setup lang="ts">
import { versionLabel } from '@kioku/contracts'
import type { CommandPaletteItem, DropdownMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import { useQuery } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import KiokuMark from '../components/KiokuMark.vue'
import { confirmDiscard, hasUnsavedChanges } from '../composables/unsavedChanges'
import { COLOR_PREFERENCES, useColorPreference } from '../composables/useColorPreference'
import { useConsoleSearch } from '../composables/useConsoleSearch'
import { LOGOUT } from '../composables/useLogout'
import { ME_KEY, useSession } from '../composables/useSession'
import { icons } from '../icons'
import { queryClient } from '../query'
import { settingsRoute } from '../routes'

const router = useRouter()
const route = useRoute()
const toast = useToast()
const { me } = useSession()

let loggingOut = false
watch(
  () => me.data.value,
  (m) => {
    if (m === null && !loggingOut) {
      void router.replace({ name: 'login', query: { next: route.fullPath } })
    }
  },
)

const navOpen = ref(false)
watch(
  () => route.fullPath,
  () => {
    navOpen.value = false
  },
)

const wideScreen = window.matchMedia('(min-width: 1024px)')
function closeNavOnWideScreen(event: MediaQueryListEvent) {
  if (event.matches) navOpen.value = false
}
onMounted(() => wideScreen.addEventListener('change', closeNavOnWideScreen))
onBeforeUnmount(() => wideScreen.removeEventListener('change', closeNavOnWideScreen))

const accountButton = ref<{ $el: HTMLElement } | null>(null)
function focusAfterNavClosed(event: Event) {
  if (!wideScreen.matches) return
  event.preventDefault()
  accountButton.value?.$el.focus()
}

// 待处理条数：与待处理页共用 inbox 缓存，应用或忽略建议后失效
const inbox = useQuery({
  queryKey: ['inbox'] as const,
  queryFn: () => api.inbox(),
  enabled: computed(() => Boolean(me.data.value)),
  staleTime: 30_000,
})
const inboxBadge = computed(() => {
  const count = inbox.data.value?.pendingCount ?? 0
  return count > 0 ? count : undefined
})

interface NavItem {
  label: string
  icon: string
  to: RouteLocationRaw
  routeName: string
  count?: number | undefined
}

const navItems = computed<NavItem[]>(() => [
  { label: '记忆', icon: icons.memories, to: { name: 'memories' }, routeName: 'memories' },
  {
    label: '待处理',
    icon: icons.inbox,
    to: { name: 'inbox' },
    routeName: 'inbox',
    count: inboxBadge.value,
  },
  {
    label: '凭据',
    icon: icons.credentials,
    to: { name: 'credentials' },
    routeName: 'credentials',
  },
  {
    label: '设置',
    icon: icons.settings,
    to: settingsRoute('keys'),
    routeName: 'settings',
  },
])

const isCurrent = (item: NavItem) => String(route.name) === item.routeName

const pages = computed<CommandPaletteItem[]>(() =>
  navItems.value.map((item) => ({
    label: item.label,
    icon: item.icon,
    to: item.to,
  })),
)
const { term: searchTerm, loading: searching, groups: searchGroups } = useConsoleSearch(pages)

const colorPreference = useColorPreference()
const displayName = computed(() => me.data.value?.displayName ?? '')
const versionText = computed(() =>
  me.data.value?.version ? `Kioku ${versionLabel(me.data.value.version)}` : null,
)

const userMenu = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: displayName.value, description: me.data.value?.username }],
  [
    {
      label: '账号与数据',
      icon: icons.account,
      to: settingsRoute('account'),
    },
  ],
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
  ...(versionText.value ? [[{ type: 'label' as const, label: versionText.value }]] : []),
])

async function logout() {
  const hadUnsaved = hasUnsavedChanges.value
  if (!confirmDiscard()) return
  try {
    await api.logout()
  } catch (err) {
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
  queryClient.clear()
  queryClient.setQueryData(ME_KEY, null)
  await router.replace({ name: 'login' })
}
provide(LOGOUT, logout)
</script>

<template>
  <UDashboardGroup class="flex-col">
    <header
      class="flex h-13 shrink-0 items-stretch gap-4 border-b border-rule px-4 min-[1121px]:gap-6 min-[1121px]:px-8"
    >
      <RouterLink :to="{ name: 'memories' }" class="flex shrink-0 items-center">
        <KiokuMark />
      </RouterLink>

      <nav class="flex shrink-0 items-stretch max-[1024px]:hidden" aria-label="主导航">
        <RouterLink
          v-for="item in navItems"
          :key="item.routeName"
          :to="item.to"
          :aria-current="isCurrent(item) ? 'page' : undefined"
          class="nav-link flex items-center gap-1.5 px-2.5 whitespace-nowrap"
        >
          <UIcon :name="item.icon" class="nav-icon" />
          {{ item.label }}
          <span v-if="item.count" class="nav-count">
            {{ item.count }}<span class="sr-only"> 项</span>
          </span>
        </RouterLink>
      </nav>

      <div class="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        <UDashboardSearchButton
          label="搜索"
          aria-label="搜索"
          color="neutral"
          class="shrink-0"
          :ui="{
            label: 'max-[1120px]:hidden',
            trailing: 'hidden min-[1024px]:flex items-center gap-0.5 ms-1',
          }"
        />
        <div class="flex min-w-0 items-center max-[1024px]:hidden">
          <UDropdownMenu
            :items="userMenu"
            :content="{ align: 'end' }"
            :ui="{ content: 'min-w-56 max-w-80' }"
          >
            <UButton
              ref="accountButton"
              :label="displayName"
              :title="displayName"
              :trailing-icon="icons.chevronDown"
              color="neutral"
              variant="ghost"
              class="max-w-48 min-w-0"
              aria-label="账号菜单"
            />
          </UDropdownMenu>
        </div>

        <USlideover
          v-model:open="navOpen"
          side="left"
          title="导航"
          :content="{ onCloseAutoFocus: focusAfterNavClosed }"
          :ui="{ content: 'max-w-72 sm:max-w-72', body: 'p-0 sm:p-0' }"
        >
          <UButton
            :icon="icons.menu"
            color="neutral"
            variant="ghost"
            class="shrink-0 min-[1024px]:hidden"
            aria-label="打开导航"
          />
          <template #body>
            <nav class="border-b border-default px-5 py-2" aria-label="主导航">
              <RouterLink
                v-for="item in navItems"
                :key="item.routeName"
                :to="item.to"
                :aria-current="isCurrent(item) ? 'page' : undefined"
                class="drawer-link flex items-center gap-2 py-2 text-[15px]/6 aria-[current=page]:font-semibold"
                @click="navOpen = false"
              >
                <UIcon :name="item.icon" class="nav-icon" />
                {{ item.label }}
                <span v-if="item.count" class="nav-count">
                  {{ item.count }}<span class="sr-only"> 项</span>
                </span>
              </RouterLink>
            </nav>
            <div class="space-y-4 px-5 py-4">
              <div>
                <p class="pb-1.5 text-xs text-muted">主题</p>
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
                <p class="truncate pb-1 text-sm" :title="displayName">{{ displayName }}</p>
                <button
                  type="button"
                  class="block w-full py-1.5 text-left text-sm/6"
                  @click="logout"
                >
                  退出登录
                </button>
                <p v-if="versionText" class="pt-2 text-xs text-muted">{{ versionText }}</p>
              </div>
            </div>
          </template>
        </USlideover>
      </div>
    </header>

    <UDashboardSearch
      v-model:search-term="searchTerm"
      :groups="searchGroups"
      :loading="searching"
      placeholder="搜索记忆或跳转页面"
    >
      <template #empty>{{ searching ? '搜索中' : '暂无匹配' }}</template>
    </UDashboardSearch>

    <main class="flex min-h-0 flex-1">
      <RouterView />
    </main>
  </UDashboardGroup>
</template>

<style scoped>
.nav-link:hover {
  box-shadow: inset 0 -1px 0 var(--ui-text-highlighted);
}
.nav-link[aria-current='page'] {
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--ui-text-highlighted);
}
.nav-icon {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--ui-text-dimmed);
}
.nav-link[aria-current='page'] .nav-icon,
.drawer-link[aria-current='page'] .nav-icon {
  color: currentColor;
}
.nav-count {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  color: var(--ui-error);
}
</style>
