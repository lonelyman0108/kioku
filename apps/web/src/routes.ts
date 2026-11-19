import type { RouteRecordRaw, Router } from 'vue-router'

import { api } from './api/endpoints'
import { loadMe, rememberCircle } from './composables/useSession'
import { legacyReviewTab } from './inbox'
import UnavailablePage from './pages/UnavailablePage.vue'
import { legacyCircleSettingsRedirect, legacySettingsRedirect } from './settingsSections'

export const routes: RouteRecordRaw[] = [
  { path: '/setup', name: 'setup', component: () => import('./pages/SetupPage.vue') },
  // 配了的数据库暂时连不上：服务在重试，不进初始化页
  {
    path: '/database-unavailable',
    name: 'database-unavailable',
    component: () => import('./pages/DatabaseUnavailablePage.vue'),
  },
  { path: '/login', name: 'login', component: () => import('./pages/LoginPage.vue') },
  // 设置密码链接：不需要登录，已登录时也照样打开
  {
    path: '/password/:token',
    name: 'password',
    component: () => import('./pages/PasswordPage.vue'),
  },
  // 浏览器授权的确认页：要登录，不在外壳里（不带记忆圈）。确认码在页面里输入，地址里不带
  {
    path: '/authorize',
    name: 'authorize',
    component: () => import('./pages/AuthorizePage.vue'),
  },
  // 静态引入：后端连不上时，按需加载的页面文件也拿不到
  { path: '/unavailable', name: 'unavailable', component: UnavailablePage },
  {
    path: '/',
    component: () => import('./layouts/ConsoleLayout.vue'),
    children: [
      { path: '', name: 'home', component: () => import('./pages/HomePage.vue') },
      {
        path: 'circles/:circleId',
        name: 'overview',
        component: () => import('./pages/OverviewPage.vue'),
      },
      {
        path: 'circles/:circleId/memories',
        name: 'memories',
        component: () => import('./pages/MemoriesPage.vue'),
      },
      {
        path: 'circles/:circleId/vocabulary',
        name: 'vocabulary',
        component: () => import('./pages/VocabularyPage.vue'),
      },
      {
        path: 'circles/:circleId/activity',
        name: 'activity',
        component: () => import('./pages/ActivityPage.vue'),
      },
      {
        path: 'circles/:circleId/credentials',
        name: 'credentials',
        component: () => import('./pages/CredentialsPage.vue'),
      },
      // 旧地址重定向：人格管理并入词表页的独立人格分页
      {
        path: 'circles/:circleId/personas',
        name: 'personas',
        redirect: (to) => ({
          name: 'vocabulary',
          params: to.params,
          query: { tab: 'personas' },
        }),
      },
      {
        path: 'circles/:circleId/conversations',
        name: 'conversations',
        component: () => import('./pages/ConversationsPage.vue'),
      },
      {
        path: 'circles/:circleId/conversations/contacts/:subjectId',
        name: 'contact',
        component: () => import('./pages/ContactDetailPage.vue'),
      },
      // 旧地址：联系人并进了对话页的联系人分页
      {
        path: 'circles/:circleId/subjects',
        redirect: (to) => ({
          name: 'conversations',
          params: to.params,
          query: { tab: 'contacts' },
        }),
      },
      {
        path: 'circles/:circleId/subjects/:subjectId',
        redirect: (to) => ({ name: 'contact', params: to.params }),
      },
      {
        path: 'circles/:circleId/inbox',
        name: 'inbox',
        component: () => import('./pages/InboxPage.vue'),
      },
      // 旧地址：书签和别处的链接还能到对应的分类
      {
        path: 'circles/:circleId/review',
        name: 'review',
        redirect: (to) => ({
          name: 'inbox',
          params: to.params,
          query: { tab: legacyReviewTab(to.query.tab) },
        }),
      },
      {
        path: 'circles/:circleId/clients',
        name: 'clients',
        component: () => import('./pages/AppsPage.vue'),
      },
      {
        path: 'circles/:circleId/clients/:clientId',
        name: 'client',
        component: () => import('./pages/AppDetailPage.vue'),
      },
      // 旧地址 /apps 重定向到 /clients
      {
        path: 'circles/:circleId/apps',
        redirect: (to) => ({ name: 'clients', params: to.params, query: to.query }),
      },
      {
        path: 'circles/:circleId/apps/:appId',
        redirect: (to) => ({
          name: 'client',
          params: { circleId: to.params.circleId, clientId: to.params.appId },
          query: to.query,
        }),
      },
      {
        path: 'circles/:circleId/recall',
        name: 'recall',
        component: () => import('./pages/RecallPage.vue'),
      },
      {
        path: 'circles/:circleId/bench',
        name: 'bench',
        component: () => import('./pages/BenchPage.vue'),
      },
      // 设置的三组：每组一个路由组件，都包着 SettingsPage。换组时换掉整页，离开前由页面确认未保存的改动
      {
        path: 'circles/:circleId/settings/:section?',
        name: 'circle-settings',
        component: () => import('./pages/SpaceSettingsPage.vue'),
        // 旧地址 ?section=：换成合并后的小节
        beforeEnter: (to) =>
          to.params.section
            ? true
            : (legacyCircleSettingsRedirect(String(to.params.circleId), to.query) ?? true),
      },
      // 旧 /spaces/:spaceId/... 书签重定向到 /circles/:spaceId/...
      {
        path: 'spaces/:spaceId/:rest(.*)*',
        redirect: (to) => {
          const rest = Array.isArray(to.params.rest)
            ? to.params.rest.join('/')
            : typeof to.params.rest === 'string'
              ? to.params.rest
              : ''
          return {
            path: `/circles/${to.params.spaceId}${rest ? `/${rest}` : ''}`,
            query: to.query,
            hash: to.hash,
          }
        },
      },
      {
        path: 'settings/account/:section?',
        name: 'account-settings',
        component: () => import('./pages/AccountSettingsPage.vue'),
      },
      {
        path: 'settings/instance/:section?',
        name: 'instance-settings',
        component: () => import('./pages/InstanceSettingsPage.vue'),
        meta: { requiresAdmin: true },
      },
      // 旧地址：实例设置的小节合并之后在实例组，不带小节的去个人组
      {
        path: 'settings',
        name: 'settings',
        redirect: (to) => legacySettingsRedirect(to.query),
      },
    ],
  },
]

// 记忆页打开某条词条的地址；各处链到词条都用它
export const entryRoute = (circleId: string, id: string) => ({
  name: 'memories',
  params: { circleId },
  query: { id },
})

// 记忆页按分组打开，或跳转到指定条目
export const memoryNodeRoute = (circleId: string, node: string) => ({
  name: 'memories',
  params: { circleId },
  query: { node },
})

// 初始化状态只会从「需要」变成「不需要」，确认过一次就不再请求；
// 服务回报没接上数据库时（重启后连不上库）由 setupLost 清掉，下次导航重新确认
let setupDone = false

export function setupLost(): void {
  setupDone = false
}

export function installGuards(router: Router): void {
  // 记下最近访问的记忆圈：个人与实例设置这些不带记忆圈的页面沿用它
  router.afterEach((to, _from, failure) => {
    if (!failure && typeof to.params.circleId === 'string') rememberCircle(to.params.circleId)
  })
  router.beforeEach(async (to) => {
    if (to.name === 'unavailable') return true
    try {
      if (!setupDone) {
        const status = await api.setupStatus()
        // 数据库暂时连不上：不知道有没有账号，不当作要初始化；每次导航都重新确认
        if (status.database.state === 'unavailable') {
          return to.name === 'database-unavailable'
            ? true
            : { name: 'database-unavailable', query: { next: to.fullPath } }
        }
        setupDone = !status.needsSetup
        if (!setupDone) return to.name === 'setup' ? true : { name: 'setup' }
      }
      if (to.name === 'setup' || to.name === 'database-unavailable') return { name: 'home' }
      if (to.name === 'password') return true
      const me = await loadMe()
      if (!me) return to.name === 'login' ? true : { name: 'login', query: { next: to.fullPath } }
      if (to.name === 'login') return { name: 'home' }
      if (to.meta.requiresAdmin && !me.isAdmin) return { name: 'home' }
      return true
    } catch {
      // 后端暂时连不上（重启、升级、代理返回 502）：给出说明和重试，而不是一片空白
      return { name: 'unavailable', query: { next: to.fullPath } }
    }
  })
}
