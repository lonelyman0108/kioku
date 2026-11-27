import type { LocationQuery, LocationQueryRaw, RouteRecordRaw, Router } from 'vue-router'

import { api } from './api/endpoints'
import { loadMe } from './composables/useSession'
import UnavailablePage from './pages/UnavailablePage.vue'

export const SETTINGS_TABS = ['keys', 'models', 'account'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

export const routes: RouteRecordRaw[] = [
  { path: '/setup', name: 'setup', component: () => import('./pages/SetupPage.vue') },
  {
    path: '/database-unavailable',
    name: 'database-unavailable',
    component: () => import('./pages/DatabaseUnavailablePage.vue'),
  },
  { path: '/login', name: 'login', component: () => import('./pages/LoginPage.vue') },
  { path: '/authorize', name: 'authorize', component: () => import('./pages/AuthorizePage.vue') },
  // 静态引入：后端连不上时按需加载的分块也拿不到
  { path: '/unavailable', name: 'unavailable', component: UnavailablePage },
  {
    path: '/',
    component: () => import('./layouts/ConsoleLayout.vue'),
    children: [
      { path: '', name: 'home', redirect: { name: 'memories' } },
      {
        path: 'memories',
        name: 'memories',
        component: () => import('./pages/MemoriesPage.vue'),
      },
      {
        path: 'organize',
        name: 'organize',
        component: () => import('./pages/InboxPage.vue'),
      },
      {
        path: 'inbox',
        redirect: (to) => ({ name: 'organize', query: to.query }),
      },
      {
        path: 'credentials',
        name: 'credentials',
        component: () => import('./pages/CredentialsPage.vue'),
      },
      {
        path: 'settings/:tab?',
        name: 'settings',
        component: () => import('./pages/SettingsPage.vue'),
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'memories' } },
]

export const entryRoute = (shortId: string) => ({
  name: 'memories' as const,
  query: { id: shortId },
})

export const captureRoute = (draft?: string, baseQuery?: LocationQuery) => {
  const query: LocationQueryRaw = baseQuery ? { ...baseQuery } : {}
  query.capture = '1'
  const clean = draft?.trim()
  if (clean) query.draft = clean
  else delete query.draft
  return { name: 'memories' as const, query }
}

export const createEntryRoute = (baseQuery?: LocationQuery) => {
  const query: LocationQueryRaw = baseQuery ? { ...baseQuery } : {}
  query.create = '1'
  delete query.capture
  delete query.draft
  return { name: 'memories' as const, query }
}

export const credentialRoute = (slug: string) => ({
  name: 'credentials' as const,
  query: { id: slug },
})

export const settingsRoute = (tab: SettingsTab = 'keys') => ({
  name: 'settings' as const,
  params: { tab },
})

let setupDone = false

export function setupLost(): void {
  setupDone = false
}

export function installGuards(router: Router): void {
  router.beforeEach(async (to) => {
    if (to.name === 'unavailable') return true
    try {
      if (!setupDone) {
        const status = await api.setupStatus()
        if (status.database.state === 'unavailable') {
          return to.name === 'database-unavailable'
            ? true
            : { name: 'database-unavailable', query: { next: to.fullPath } }
        }
        setupDone = !status.needsSetup
        if (!setupDone) return to.name === 'setup' ? true : { name: 'setup' }
      }
      if (to.name === 'setup' || to.name === 'database-unavailable') return { name: 'memories' }
      const me = await loadMe()
      if (!me) return to.name === 'login' ? true : { name: 'login', query: { next: to.fullPath } }
      if (to.name === 'login') return { name: 'memories' }
      return true
    } catch {
      return { name: 'unavailable', query: { next: to.fullPath } }
    }
  })
}
