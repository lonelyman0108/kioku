<script setup lang="ts">
import { versionLabel, type CircleSummary } from '@kioku/contracts'
import type { CommandPaletteItem, DropdownMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import { useQuery } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import CreateSpaceModal from '../components/CreateSpaceModal.vue'
import ImportSpaceModal from '../components/ImportSpaceModal.vue'
import KiokuMark from '../components/KiokuMark.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import StrataPatterns from '../components/strata/StrataPatterns.vue'
import { COLOR_PREFERENCES, useColorPreference } from '../composables/useColorPreference'
import { useConsoleSearch } from '../composables/useConsoleSearch'
import { NEW_CIRCLE, useCreateCircle } from '../composables/useCreateSpace'
import { useInboxCounts } from '../composables/useInboxCounts'
import { confirmDiscard, hasUnsavedChanges } from '../composables/unsavedChanges'
import { LOGOUT } from '../composables/useLogout'
import { forgetCircle, ME_KEY, useSession } from '../composables/useSession'
import { icons } from '../icons'
import { actionableInboxCount } from '../inbox'
import { circleKindLabels } from '../labels'
import { queryClient } from '../query'
import {
  accountSettingsRoute,
  circleSettingsRoute,
  instanceSettingsRoute,
  roleName,
} from '../settingsSections'

const router = useRouter()
const route = useRoute()
const toast = useToast()
const { me, circle } = useSession()

// 会话过期或在别的标签页退出后，当前账号会变成 null：带人回登录页，登录后回到原来的页面
let loggingOut = false
watch(
  () => me.data.value,
  (m) => {
    if (m === null) forgetCircle()
    if (m === null && !loggingOut) {
      void router.replace({ name: 'login', query: { next: route.fullPath } })
    }
  },
)

const circles = computed(() => {
  const list = me.data.value?.circles ?? []
  const personal = list.filter((c) => c.kind === 'personal')
  const shared = list.filter((c) => c.kind !== 'personal')
  return [...personal, ...shared]
})
// 新建共享圈与导入记忆圈：登录的账号都有，共享圈名额用完时「新建共享圈」不可用、旁边写原因
const newCircle = useCreateCircle(computed(() => Boolean(me.data.value)))
provide(NEW_CIRCLE, newCircle)

// 窄屏的导航收进抽屉，换页就关上
const navOpen = ref(false)
watch(
  () => route.fullPath,
  () => {
    navOpen.value = false
  },
)

// 窗口变宽或转屏到放得下顶部导航时关上，不然抽屉盖着桌面布局。分界和模板里的 1024px 一致
const wideScreen = window.matchMedia('(min-width: 1024px)')
function closeNavOnWideScreen(event: MediaQueryListEvent) {
  if (event.matches) navOpen.value = false
}
onMounted(() => wideScreen.addEventListener('change', closeNavOnWideScreen))
onBeforeUnmount(() => wideScreen.removeEventListener('change', closeNavOnWideScreen))

// 这时菜单按钮已经隐藏，焦点还不回去，放到账号菜单上
const accountButton = ref<{ $el: HTMLElement } | null>(null)
function focusAfterNavClosed(event: Event) {
  if (!wideScreen.matches) return
  event.preventDefault()
  accountButton.value?.$el.focus()
}

function switchCircle(id: string) {
  // 已经在这个记忆圈的概览时地址不变，上面的 watch 不会触发，抽屉要在这里关
  navOpen.value = false
  void router.push({ name: 'overview', params: { circleId: id } })
}

// 测试台只给接入实例所有者（会读取所有者的个人隐私上下文）：本圈没有自己的接入实例时不显示入口，后端同样拒绝
const clients = useQuery({
  queryKey: computed(() => ['clients', circle.value?.id] as const),
  queryFn: ({ queryKey: [, id] }) => api.clients(id!),
  enabled: computed(() => Boolean(circle.value)),
})
const ownsClient = computed(() =>
  (clients.data.value ?? []).some((client) => client.ownerAccountId === me.data.value?.id),
)

interface NavItem {
  label: string
  icon: string
  to: RouteLocationRaw
  // 这些路由算在这个入口下：详情页也要点亮列表的入口
  routes: string[]
  // 入口后面的数字，0 不显示
  count?: number | undefined
}

// 待处理的条数：角标和待处理页共用缓存，处理完待办之后失效，不跟着每个页面重取
const inboxCounts = useInboxCounts(computed(() => circle.value?.id ?? null))
const inboxBadge = computed(() =>
  inboxCounts.data.value && circle.value
    ? actionableInboxCount(inboxCounts.data.value, circle.value.role)
    : undefined,
)

// 联系人详情也算在「对话」下面
const CONVERSATION_ROUTES = ['conversations', 'contact']
// 召回与测试台收归客户端模块内作为二级页签，访问时同样点亮顶栏「客户端」
const CLIENT_ROUTES = ['clients', 'client', 'recall', 'bench']
// 设置的三组是同一个页面，都点亮「设置」
const SETTINGS_ROUTES = ['circle-settings', 'account-settings', 'instance-settings']

// 顶部导航分为两组共 9 项，与核心领域对象一一对应
const navGroups = computed<{ items: NavItem[] }[]>(() => {
  const id = circle.value?.id
  if (!id) return []
  const params = { circleId: id }
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
        { label: '对话', ...link('conversations', icons.conversations, CONVERSATION_ROUTES) },
        { label: '人格', ...link('personas', icons.personas) },
        { label: '凭据', ...link('credentials', icons.credentials) },
        { label: '待处理', ...link('inbox', icons.review), count: inboxBadge.value },
      ],
    },
    {
      items: [
        { label: '客户端', ...link('clients', icons.clients, CLIENT_ROUTES) },
        { label: '变更记录', ...link('activity', icons.activity) },
        // 「设置」进记忆圈组，账号设置与实例设置放在账号菜单里
        { label: '设置', ...link('circle-settings', icons.settings, SETTINGS_ROUTES) },
      ],
    },
  ]
})
// 账号菜单里的两组设置：账号设置人人都有，实例设置只给实例管理员
const accountNav = computed<NavItem[]>(() => [
  {
    label: '账号设置',
    icon: icons.account,
    to: accountSettingsRoute('account'),
    routes: ['account-settings'],
  },
  ...(me.data.value?.isAdmin
    ? [
        {
          label: '实例设置',
          icon: icons.instance,
          to: instanceSettingsRoute(),
          routes: ['instance-settings'],
        },
      ]
    : []),
])
const isCurrent = (item: NavItem) => item.routes.includes(String(route.name))

// ⌘K 里的页面覆盖顶栏导航、客户端二级页签、语境词典及两组全局设置；记忆搜索结果来自服务端跨圈检索
const pages = computed<CommandPaletteItem[]>(() => {
  const id = circle.value?.id
  const subPages: { label: string; icon: string; to: RouteLocationRaw }[] = id
    ? [
        {
          label: '召回与试算',
          icon: icons.recall,
          to: { name: 'recall', params: { circleId: id } },
        },
        ...(ownsClient.value
          ? [
              {
                label: '测试台',
                icon: icons.bench,
                to: { name: 'bench', params: { circleId: id } },
              },
            ]
          : []),
        {
          label: '语境词典',
          icon: icons.vocabulary,
          to: circleSettingsRoute(id, 'vocabulary'),
        },
      ]
    : []
  return [
    ...navGroups.value.flatMap((group) =>
      group.items.map((item) => ({ label: item.label, icon: item.icon, to: item.to })),
    ),
    ...subPages,
    ...accountNav.value.map((item) => ({ label: item.label, icon: item.icon, to: item.to })),
  ]
})
const {
  term: searchTerm,
  loading: searching,
  groups: searchGroups,
} = useConsoleSearch(
  computed(() => circle.value?.id ?? null),
  pages,
  circles,
)

const colorPreference = useColorPreference()
const displayName = computed(() => me.data.value?.displayName ?? '')
// 账号菜单底部的版本号，取自公开的存活检查：服务重启之前不会变
const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: Infinity })
const versionText = computed(() =>
  health.data.value ? `Kioku ${versionLabel(health.data.value.version)}` : null,
)
const userMenu = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: displayName.value, description: me.data.value?.username }],
  accountNav.value.map((item) => ({ label: item.label, icon: item.icon, to: item.to })),
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
// 菜单项上额外带的标注：个人圈标「本人」，独立圈标当前账号角色（多成员时带人数）
const badgeOf = (item: unknown) => (item as { badge?: string }).badge
const circleBadge = (c: CircleSummary) =>
  c.kind === 'personal'
    ? '本人'
    : (c.memberCount ?? 1) > 1
      ? `${roleName(c.role)} · ${c.memberCount} 人`
      : roleName(c.role)
const personalCircles = computed(() => circles.value.filter((c) => c.kind === 'personal'))
const sharedCircles = computed(() => circles.value.filter((c) => c.kind !== 'personal'))

// 记忆圈切换器：个人圈置顶，其后列各独立圈及角色（当前记忆圈打勾），下面是设置、新建与导入
const circleMenu = computed<DropdownMenuItem[][]>(() => {
  const toItem = (c: CircleSummary): DropdownMenuItem => ({
    type: 'checkbox',
    slot: 'circle',
    label: c.name,
    badge: circleBadge(c),
    checked: c.id === circle.value?.id,
    onSelect: () => switchCircle(c.id),
  })
  return [
    ...(personalCircles.value.length
      ? [
          [
            { type: 'label' as const, label: circleKindLabels.personal },
            ...personalCircles.value.map(toItem),
          ],
        ]
      : []),
    ...(sharedCircles.value.length
      ? [
          [
            { type: 'label' as const, label: circleKindLabels.shared },
            ...sharedCircles.value.map(toItem),
          ],
        ]
      : []),
    // 没有记忆圈时不留空的分隔组
    ...(circle.value
      ? [
          [
            {
              label: circle.value.kind === 'personal' ? '记忆圈设置' : '成员与设置',
              icon: icons.settings,
              to: circleSettingsRoute(circle.value.id),
            },
          ],
        ]
      : []),
    [
      {
        label: '新建独立圈',
        icon: icons.add,
        disabled: Boolean(newCircle.blocked.value),
        onSelect: () => (newCircle.open.value = true),
      },
      {
        label: '导入记忆圈',
        icon: icons.importCircle,
        onSelect: () => (newCircle.importing.value = true),
      },
      // 不可用时原因写成文字，不只靠禁用的样子
      ...(newCircle.blocked.value
        ? [
            {
              type: 'label' as const,
              label: newCircle.blocked.value,
              class: 'font-normal text-muted',
            },
          ]
        : []),
    ],
  ]
})

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
  forgetCircle()
  // 清掉全部缓存：下一个在这个标签页登录的人不能看到上一个人的记忆
  queryClient.clear()
  queryClient.setQueryData(ME_KEY, null)
  await router.replace({ name: 'login' })
}
provide(LOGOUT, logout)
</script>

<template>
  <!--
    UDashboardGroup 只为搜索留着：搜索按钮和 ⌘K 的开关状态靠它的上下文共享。
    Group 默认左右排，这里改成上下排，顶部导航在上、页面在下
  -->
  <UDashboardGroup class="flex-col">
    <StrataPatterns />

    <header
      class="flex h-13 shrink-0 items-stretch gap-4 border-b border-rule px-4 min-[1121px]:gap-6 min-[1121px]:px-8"
    >
      <RouterLink :to="{ name: 'home' }" class="flex shrink-0 items-center">
        <KiokuMark />
      </RouterLink>

      <nav class="flex shrink-0 items-stretch max-[1024px]:hidden" aria-label="主导航">
        <div
          v-for="(group, index) in navGroups"
          :key="index"
          class="relative flex items-stretch"
          :class="index > 0 ? 'nav-group ml-1 pl-1 min-[1321px]:ml-2 min-[1321px]:pl-2' : ''"
        >
          <RouterLink
            v-for="item in group.items"
            :key="item.label"
            :to="item.to"
            :aria-current="isCurrent(item) ? 'page' : undefined"
            class="nav-link flex items-center gap-1.5 px-1.5 whitespace-nowrap min-[1121px]:px-2"
          >
            <UIcon :name="item.icon" class="nav-icon max-[1180px]:hidden" />
            {{ item.label }}
            <span v-if="item.count" class="nav-count">
              {{ item.count }}<span class="sr-only"> 项</span>
            </span>
          </RouterLink>
        </div>
      </nav>

      <!-- 导航和搜索不缩，宽度不够时由这一段的名字让出来，账号菜单一直在屏幕里 -->
      <div class="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        <UDashboardSearchButton
          label="搜索"
          aria-label="搜索"
          color="neutral"
          class="shrink-0"
          :ui="{
            label: 'max-[1320px]:min-[1024px]:hidden',
            trailing: 'hidden min-[1024px]:flex items-center gap-0.5 ms-1',
          }"
        />
        <div class="flex min-w-0 items-center gap-1.5 max-[1024px]:hidden">
          <UDropdownMenu
            :items="circleMenu"
            :content="{ align: 'end' }"
            :ui="{ content: 'min-w-60 max-w-80' }"
            size="sm"
          >
            <UButton
              :label="circle?.name ?? '选择记忆圈'"
              :title="circle?.name"
              :icon="icons.circle"
              :trailing-icon="icons.chevronDown"
              color="neutral"
              variant="ghost"
              class="max-w-48 min-w-0"
              aria-label="切换记忆圈"
            />
            <template #circle-trailing="{ item }">
              <span class="text-xs text-muted">{{ badgeOf(item) }}</span>
            </template>
          </UDropdownMenu>
          <UDropdownMenu
            :items="userMenu"
            :content="{ align: 'end' }"
            :ui="{ content: 'min-w-60 max-w-80' }"
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
            <nav aria-label="主导航">
              <div
                v-for="(group, index) in navGroups"
                :key="index"
                class="border-b border-default px-5 py-2"
              >
                <RouterLink
                  v-for="item in group.items"
                  :key="item.label"
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
              </div>
            </nav>
            <div class="space-y-3 px-5 py-4">
              <div v-if="circles.length">
                <template v-if="personalCircles.length">
                  <p class="pb-1 text-xs text-muted">{{ circleKindLabels.personal }}</p>
                  <button
                    v-for="c in personalCircles"
                    :key="c.id"
                    type="button"
                    class="flex w-full items-baseline gap-2 py-1.5 text-left text-sm/6"
                    :class="c.id === circle?.id ? 'font-semibold' : ''"
                    :aria-current="c.id === circle?.id ? 'true' : undefined"
                    @click="switchCircle(c.id)"
                  >
                    <span class="min-w-0 truncate" :title="c.name">{{ c.name }}</span>
                    <span class="ml-auto shrink-0 text-xs font-normal text-muted">{{
                      circleBadge(c)
                    }}</span>
                  </button>
                </template>
                <template v-if="sharedCircles.length">
                  <p class="pt-2 pb-1 text-xs text-muted">{{ circleKindLabels.shared }}</p>
                  <button
                    v-for="c in sharedCircles"
                    :key="c.id"
                    type="button"
                    class="flex w-full items-baseline gap-2 py-1.5 text-left text-sm/6"
                    :class="c.id === circle?.id ? 'font-semibold' : ''"
                    :aria-current="c.id === circle?.id ? 'true' : undefined"
                    @click="switchCircle(c.id)"
                  >
                    <span class="min-w-0 truncate" :title="c.name">{{ c.name }}</span>
                    <span class="ml-auto shrink-0 text-xs font-normal text-muted">{{
                      circleBadge(c)
                    }}</span>
                  </button>
                </template>
                <RouterLink
                  v-if="circle"
                  :to="circleSettingsRoute(circle.id)"
                  class="block py-1.5 text-sm/6"
                  @click="navOpen = false"
                >
                  {{ circle.kind === 'personal' ? '记忆圈设置' : '成员与设置' }}
                </RouterLink>
              </div>
              <div>
                <button
                  type="button"
                  class="block py-1.5 text-left text-sm/6 disabled:cursor-not-allowed disabled:text-muted"
                  :disabled="Boolean(newCircle.blocked.value)"
                  :aria-describedby="newCircle.blocked.value ? 'circle-limit-note' : undefined"
                  @click="((navOpen = false), (newCircle.open.value = true))"
                >
                  新建独立圈
                </button>
                <button
                  type="button"
                  class="block py-1.5 text-left text-sm/6"
                  @click="((navOpen = false), (newCircle.importing.value = true))"
                >
                  导入记忆圈
                </button>
                <p v-if="newCircle.blocked.value" id="circle-limit-note" class="text-xs text-muted">
                  {{ newCircle.blocked.value }}
                </p>
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
                <p class="truncate pb-1 text-sm" :title="displayName">{{ displayName }}</p>
                <RouterLink
                  v-for="item in accountNav"
                  :key="item.label"
                  :to="item.to"
                  class="block py-1.5 text-sm/6"
                  @click="navOpen = false"
                >
                  {{ item.label }}
                </RouterLink>
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

    <!-- 组件库默认的空状态是「没有匹配的数据」，还在搜的时候也这么说：搜索中另说，搜完再说暂无匹配 -->
    <UDashboardSearch
      v-model:search-term="searchTerm"
      :groups="searchGroups"
      :loading="searching"
      placeholder="搜索记忆或跳转页面"
    >
      <template #empty>{{ searching ? '搜索中' : '暂无匹配' }}</template>
    </UDashboardSearch>

    <main class="flex min-h-0 flex-1">
      <!-- 地址里的记忆圈无权访问（被移出了、或打开了旧链接）：说明情况，不展示别的记忆圈的内容和操作 -->
      <div v-if="me.data.value && route.params.circleId && !circle" class="not-member">
        <NoteLine>
          无权访问此记忆圈
          <template #actions>
            <UButton :to="{ name: 'home' }" color="neutral" variant="outline" size="sm">
              返回我的记忆圈
            </UButton>
          </template>
        </NoteLine>
      </div>
      <RouterView v-else />
    </main>
    <CreateSpaceModal
      :open="newCircle.open.value"
      @close="newCircle.open.value = false"
      @created="newCircle.created"
    />
    <ImportSpaceModal
      :open="newCircle.importing.value"
      @close="newCircle.importing.value = false"
    />
  </UDashboardGroup>
</template>

<style scoped>
.not-member {
  flex: 1;
  min-width: 0;
  padding: 24px 32px;
}
@media (max-width: 1023.98px) {
  .not-member {
    padding: 16px;
  }
}
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
.nav-icon {
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
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  color: var(--ui-error);
}
</style>
