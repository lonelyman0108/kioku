import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { ME_KEY, queryClient } from '../query'
import {
  captureRoute,
  credentialRoute,
  entryRoute,
  installGuards,
  newCredentialRoute,
  resolveSettingsSection,
  routes,
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
  settingsRoute,
  setupLost,
} from '../routes'

const readyStatus = {
  needsSetup: false,
  database: { state: 'ready' as const, source: 'env' as const, failure: null, summary: null },
  masterKey: true,
}

const sampleMe = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'owner',
  displayName: 'Owner',
  hasMasterKey: true,
  hasEmbeddingModel: true,
  hasChatModel: false,
  version: '2.0.0',
}

function makeRouter() {
  const router = createRouter({ history: createMemoryHistory(), routes })
  installGuards(router)
  return router
}

afterEach(() => {
  vi.restoreAllMocks()
  queryClient.clear()
  setupLost()
})

describe('路由表与地址辅助函数', () => {
  it('全部路由不包含旧版记忆圈前缀，设置页兼容三标签并支持六子视图直达', () => {
    const paths = routes.flatMap((r) => [r.path, ...(r.children ?? []).map((c) => c.path)])
    expect(paths.some((p) => p.includes('circle') || p.includes('space'))).toBe(false)
    expect(SETTINGS_TABS).toEqual(['keys', 'models', 'account'])
    expect(SETTINGS_SECTIONS).toEqual(['keys', 'embed', 'chat', 'schedule', 'account', 'transfer'])
    expect(entryRoute('m-ab2345')).toEqual({ name: 'memories', query: { id: 'm-ab2345' } })
    expect(captureRoute()).toEqual({ name: 'memories', query: { capture: '1' } })
    expect(captureRoute('  偏好表格  ')).toEqual({
      name: 'memories',
      query: { capture: '1', draft: '偏好表格' },
    })
    expect(captureRoute('偏好表格', { id: 'm-ab2345', project: 'kioku' })).toEqual({
      name: 'memories',
      query: { id: 'm-ab2345', project: 'kioku', capture: '1', draft: '偏好表格' },
    })
    expect(credentialRoute('prod-db')).toEqual({ name: 'credentials', query: { id: 'prod-db' } })
    expect(newCredentialRoute()).toEqual({ name: 'credentials', query: { new: '1' } })
    expect(settingsRoute('models')).toEqual({ name: 'settings', params: { tab: 'models' } })
    expect(settingsRoute('embed')).toEqual({ name: 'settings', params: { tab: 'embed' } })
    expect(settingsRoute('transfer')).toEqual({ name: 'settings', params: { tab: 'transfer' } })

    expect(resolveSettingsSection(undefined)).toBe('keys')
    expect(resolveSettingsSection('keys')).toBe('keys')
    expect(resolveSettingsSection('models')).toBe('chat')
    expect(resolveSettingsSection('models', 'embed')).toBe('embed')
    expect(resolveSettingsSection('models', undefined, 'schedule')).toBe('schedule')
    expect(resolveSettingsSection('embedding')).toBe('embed')
    expect(resolveSettingsSection('account')).toBe('account')
    expect(resolveSettingsSection('account', 'transfer')).toBe('transfer')
    expect(resolveSettingsSection('transfer')).toBe('transfer')
    expect(resolveSettingsSection('unknown')).toBe('keys')
  })
})

describe('路由守卫', () => {
  it('未初始化时跳转到初始化页', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue({ ...readyStatus, needsSetup: true })
    const router = makeRouter()
    await router.push('/memories')
    await router.isReady()
    expect(router.currentRoute.value.name).toBe('setup')
  })

  it('数据库不可用时跳转到数据库不可用页并保留原目标地址', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue({
      needsSetup: false,
      database: {
        state: 'unavailable',
        source: 'env',
        failure: 'unreachable',
        summary: null,
      },
      masterKey: true,
    })
    const router = makeRouter()
    await router.push('/credentials')
    await router.isReady()
    expect(router.currentRoute.value.name).toBe('database-unavailable')
    expect(router.currentRoute.value.query.next).toBe('/credentials')
  })

  it('未登录时跳转到登录页，已登录时根路径重定向到记忆页且旧版 /inbox 重定向到 /organize', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue(readyStatus)
    vi.spyOn(api, 'me').mockRejectedValue(Object.assign(new Error('401'), { status: 401 }))
    queryClient.setQueryData(ME_KEY, null)

    const router = makeRouter()
    await router.push('/inbox')
    await router.isReady()
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.next).toBe('/organize')

    queryClient.setQueryData(ME_KEY, sampleMe)
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('memories')

    await router.push('/inbox?from=bookmark')
    expect(router.currentRoute.value.name).toBe('organize')
    expect(router.currentRoute.value.fullPath).toBe('/organize?from=bookmark')
  }, 15_000)
})
