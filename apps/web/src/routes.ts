import type { RouteRecordRaw, Router } from 'vue-router'

import { api } from './api/endpoints'
import { loadMe } from './composables/useSession'
import UnavailablePage from './pages/UnavailablePage.vue'

export const routes: RouteRecordRaw[] = [
  { path: '/setup', name: 'setup', component: () => import('./pages/SetupPage.vue') },
  { path: '/login', name: 'login', component: () => import('./pages/LoginPage.vue') },
  // 静态引入：后端连不上时，按需加载的页面文件也拿不到
  { path: '/unavailable', name: 'unavailable', component: UnavailablePage },
  {
    path: '/',
    component: () => import('./layouts/ConsoleLayout.vue'),
    children: [
      { path: '', name: 'home', component: () => import('./pages/HomePage.vue') },
      {
        path: 'spaces/:spaceId/memories',
        name: 'memories',
        component: () => import('./pages/MemoriesPage.vue'),
      },
      {
        path: 'spaces/:spaceId/personas',
        name: 'personas',
        component: () => import('./pages/PersonasPage.vue'),
      },
      {
        path: 'spaces/:spaceId/apps',
        name: 'apps',
        component: () => import('./pages/AppsPage.vue'),
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('./pages/SettingsPage.vue'),
        meta: { requiresAdmin: true },
      },
    ],
  },
]

// 初始化状态只会从「需要」变成「不需要」，确认过一次就不再请求
let setupDone = false

export function installGuards(router: Router): void {
  router.beforeEach(async (to) => {
    if (to.name === 'unavailable') return true
    try {
      if (!setupDone) {
        setupDone = !(await api.setupStatus()).needsSetup
        if (!setupDone) return to.name === 'setup' ? true : { name: 'setup' }
      }
      if (to.name === 'setup') return { name: 'home' }
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
