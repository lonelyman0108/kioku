<script setup lang="ts">
import { versionLabel } from '@kioku/contracts'
import type { CommandPaletteItem, DropdownMenuItem } from '@nuxt/ui'
import { useKbd, useToast } from '@nuxt/ui/composables'
import { useQuery } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import BackgroundTasksIndicator from '../components/BackgroundTasksIndicator.vue'
import KiokuMark from '../components/KiokuMark.vue'
import { confirmDiscard, hasUnsavedChanges } from '../composables/unsavedChanges'
import { COLOR_PREFERENCES, useColorPreference } from '../composables/useColorPreference'
import { useConsoleSearch } from '../composables/useConsoleSearch'
import { LOGOUT } from '../composables/useLogout'
import { ME_KEY, useSession } from '../composables/useSession'
import { icons } from '../icons'
import { queryClient } from '../query'
import { captureRoute, settingsRoute } from '../routes'

const router = useRouter()
const route = useRoute()
const toast = useToast()
const { getKbdKey } = useKbd()
const { me } = useSession()

const captureShortcut = computed(() => {
  const mod = getKbdKey('meta')?.trim() || 'Ctrl'
  return mod === '⌘' ? '⌘J' : `${mod}+J`
})

function openQuickCapture() {
  if (route.name === 'memories') {
    void router.replace(captureRoute('', route.query))
    return
  }
  void router.push(captureRoute())
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (
    !me.data.value ||
    event.defaultPrevented ||
    event.isComposing ||
    !(event.metaKey || event.ctrlKey) ||
    event.shiftKey ||
    event.altKey ||
    event.key.toLowerCase() !== 'j'
  ) {
    return
  }
  if (isEditableElement(event.target)) return
  if (document.querySelector('[role="dialog"], [data-reka-popper-content-wrapper]')) return
  event.preventDefault()
  openQuickCapture()
}

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

const wideScreen = window.matchMedia('(min-width: 768px)')
function closeNavOnWideScreen(event: MediaQueryListEvent) {
  if (event.matches) navOpen.value = false
}
onMounted(() => {
  wideScreen.addEventListener('change', closeNavOnWideScreen)
  window.addEventListener('keydown', onGlobalKeydown)
})
onBeforeUnmount(() => {
  wideScreen.removeEventListener('change', closeNavOnWideScreen)
  window.removeEventListener('keydown', onGlobalKeydown)
})

const accountButton = ref<{ $el: HTMLElement } | null>(null)
function focusAfterNavClosed(event: Event) {
  if (!wideScreen.matches) return
  event.preventDefault()
  accountButton.value?.$el.focus()
}

// 待确认建议条数与后台长任务状态：与整理页共用 inbox 缓存，运行期间自动轮询
const inbox = useQuery({
  queryKey: ['inbox'] as const,
  queryFn: () => api.inbox(),
  enabled: computed(() => Boolean(me.data.value)),
  staleTime: 30_000,
  refetchInterval: (query) => {
    const d = query.state.data
    return d?.dreamState.running || d?.embeddingBackfill?.running ? 2500 : false
  },
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
    label: '整理',
    icon: icons.listChecks,
    to: { name: 'organize' },
    routeName: 'organize',
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
    <header class="shrink-0 border-b border-rule">
      <div class="console-header-inner flex h-13 items-stretch">
        <RouterLink :to="{ name: 'memories' }" class="flex shrink-0 items-center">
          <KiokuMark />
        </RouterLink>

        <nav class="desktop-nav shrink-0 items-stretch" aria-label="主导航">
          <RouterLink
            v-for="item in navItems"
            :key="item.routeName"
            :to="item.to"
            :title="item.count ? `${item.label}（${item.count} 条待确认建议）` : undefined"
            :aria-current="isCurrent(item) ? 'page' : undefined"
            class="nav-link flex items-center gap-1.5 whitespace-nowrap"
          >
            <UIcon :name="item.icon" class="nav-icon" aria-hidden="true" />
            {{ item.label }}
            <span v-if="item.count" class="nav-count">
              {{ item.count }}<span class="sr-only"> 条待确认</span>
            </span>
          </RouterLink>
        </nav>

        <div class="header-actions flex min-w-0 flex-1 items-center justify-end">
          <BackgroundTasksIndicator
            :dream-state="inbox.data.value?.dreamState ?? null"
            :embedding-backfill="inbox.data.value?.embeddingBackfill ?? null"
          />
          <UButton
            size="sm"
            :icon="icons.capture"
            :title="`记录一条习惯、约定或事实更新，自动归并至既有记忆（${captureShortcut}）`"
            class="shrink-0 whitespace-nowrap"
            @click="openQuickCapture"
          >
            <span>随手记</span>
            <span class="capture-kbd" aria-hidden="true">{{ captureShortcut }}</span>
          </UButton>
          <UDashboardSearchButton
            size="sm"
            label="搜索"
            aria-label="搜索"
            color="neutral"
            class="shrink-0 whitespace-nowrap"
            :ui="{
              trailing: 'hidden min-[1024px]:flex items-center gap-0.5 ms-1',
            }"
          />
          <div class="desktop-account min-w-0 items-center">
            <UDropdownMenu
              :items="userMenu"
              :content="{ align: 'end' }"
              :ui="{ content: 'min-w-56 max-w-80' }"
            >
              <UButton
                ref="accountButton"
                :icon="icons.account"
                :label="displayName"
                :title="displayName"
                :trailing-icon="icons.chevronDown"
                color="neutral"
                variant="ghost"
                class="account-trigger min-w-0"
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
              size="sm"
              :icon="icons.menu"
              label="导航"
              color="neutral"
              variant="ghost"
              class="mobile-nav-trigger shrink-0 whitespace-nowrap"
              aria-label="打开导航"
            />
            <template #body>
              <nav class="border-b border-default px-5 py-2" aria-label="主导航">
                <RouterLink
                  v-for="item in navItems"
                  :key="item.routeName"
                  :to="item.to"
                  :title="item.count ? `${item.label}（${item.count} 条待确认建议）` : undefined"
                  :aria-current="isCurrent(item) ? 'page' : undefined"
                  class="drawer-link flex items-center gap-2 py-2 text-[15px]/6 aria-[current=page]:font-semibold"
                  @click="navOpen = false"
                >
                  <UIcon :name="item.icon" class="nav-icon" aria-hidden="true" />
                  {{ item.label }}
                  <span v-if="item.count" class="nav-count">
                    {{ item.count }}<span class="sr-only"> 条待确认</span>
                  </span>
                </RouterLink>
              </nav>
              <div class="space-y-4 px-5 py-4">
                <div>
                  <p class="pb-1.5 text-xs text-muted">主题</p>
                  <div class="flex flex-wrap gap-1">
                    <UButton
                      v-for="option in COLOR_PREFERENCES"
                      :key="option.value"
                      :icon="option.icon"
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
                  <p class="flex items-center gap-2 pb-1 text-sm" :title="displayName">
                    <UIcon
                      :name="icons.account"
                      class="inline-block size-4 shrink-0 text-muted"
                      aria-hidden="true"
                    />
                    <span class="truncate">{{ displayName }}</span>
                  </p>
                  <button
                    type="button"
                    class="flex w-full cursor-pointer items-center gap-2 py-1.5 text-left text-sm/6"
                    @click="logout"
                  >
                    <UIcon
                      :name="icons.logout"
                      class="inline-block size-4 shrink-0 text-muted"
                      aria-hidden="true"
                    />
                    <span>退出登录</span>
                  </button>
                  <p v-if="versionText" class="pt-2 text-xs text-muted">{{ versionText }}</p>
                </div>
              </div>
            </template>
          </USlideover>
        </div>
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
.console-header-inner {
  width: 100%;
  max-width: 1840px;
  margin-inline: auto;
  gap: 24px;
  padding-inline: 32px;
}
.desktop-nav {
  display: flex;
}
.desktop-account {
  display: flex;
}
.mobile-nav-trigger {
  display: none;
}
.header-actions {
  gap: 6px;
}
.account-trigger {
  max-width: 12rem;
}
.nav-link {
  padding-inline: 10px;
}
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
.capture-kbd {
  font-family: var(--font-mono);
  font-size: 12px;
  opacity: 0.78;
}
@media (max-width: 1120px) {
  .console-header-inner {
    gap: 12px;
    padding-inline: 16px;
  }
}
@media (max-width: 1023.98px) {
  .nav-link {
    padding-inline: 8px;
  }
  .account-trigger {
    max-width: 8.5rem;
  }
  .capture-kbd {
    display: none;
  }
}
@media (pointer: coarse) {
  .capture-kbd {
    display: none;
  }
}
@media (max-width: 767.98px) {
  .console-header-inner {
    gap: 6px;
    padding-inline: 10px;
  }
  .header-actions {
    gap: 4px;
  }
  .desktop-nav,
  .desktop-account {
    display: none;
  }
  .mobile-nav-trigger {
    display: inline-flex;
  }
}
</style>
