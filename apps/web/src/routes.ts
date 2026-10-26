import type { RouteRecordRaw, Router } from 'vue-router'

import { api } from './api/endpoints'
import { loadMe } from './composables/useSession'

export const routes: RouteRecordRaw[] = [
  { path: '/setup', name: 'setup', component: () => import('./pages/SetupPage.vue') },
  { path: '/login', name: 'login', component: () => import('./pages/LoginPage.vue') },
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
      { path: 'settings', name: 'settings', component: () => import('./pages/SettingsPage.vue') },
    ],
  },
]

// 初始化状态只会从「需要」变成「不需要」，确认过一次就不再请求
let setupDone = false

export function installGuards(router: Router): void {
  router.beforeEach(async (to) => {
    if (!setupDone) {
      setupDone = !(await api.setupStatus()).needsSetup
      if (!setupDone) return to.name === 'setup' ? true : { name: 'setup' }
    }
    if (to.name === 'setup') return { name: 'home' }
    const me = await loadMe()
    if (!me) return to.name === 'login' ? true : { name: 'login', query: { next: to.fullPath } }
    if (to.name === 'login') return { name: 'home' }
    return true
  })
}
