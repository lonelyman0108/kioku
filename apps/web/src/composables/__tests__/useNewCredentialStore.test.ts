import type { VaultConnection } from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, effectScope, nextTick, ref, type EffectScope } from 'vue'

import { ApiError } from '../../api/client'
import { fetchVaultItems } from '../../vaultQueries'
import { storeBlocker, storeLabel } from '../../vault'
import { useNewCredentialStore } from '../useNewCredentialStore'

// 接口换成假的，别的都是真的：新建凭据、转存与保存前处理都靠它说明写到哪里
const fakes = vi.hoisted(() => ({
  api: { vaultConnections: vi.fn(), vaultItems: vi.fn() },
}))
vi.mock('../../api/endpoints', () => ({ api: fakes.api }))

const conn = (over: Partial<VaultConnection> = {}): VaultConnection => ({
  id: '00000000-0000-4000-8000-000000000001',
  serverUrl: 'https://vault.example.com',
  email: 'agent@example.com',
  status: 'ok',
  disabledReason: null,
  lastError: null,
  lastCheckedAt: null,
  disconnectedAt: null,
  credentialCount: 0,
  destination: { collectionId: 'c1', organizationId: 'o1', collectionName: 'Agent' },
  createdAt: '2026-11-07T00:00:00Z',
  updatedAt: '2026-11-07T00:00:00Z',
  ...over,
})
const itemList = (readOnly: boolean, present = true) => ({
  items: [],
  unreadableCount: 0,
  collections: present ? [{ id: 'c1', organizationId: 'o1', name: 'Agent', readOnly }] : [],
  organizations: [],
})

let client: QueryClient
let scope: EffectScope

async function settle() {
  for (let i = 0; i < 6; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve))
  }
}

async function start() {
  const vueApp = createApp({})
  vueApp.use(VueQueryPlugin, { queryClient: client })
  scope = effectScope()
  const state = vueApp.runWithContext(() =>
    scope.run(() => useNewCredentialStore(ref('s1'), ref(true)))!,
  )
  await settle()
  return state
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  fakes.api.vaultConnections.mockReset().mockResolvedValue({ items: [conn()] })
  fakes.api.vaultItems.mockReset().mockResolvedValue(itemList(false))
})
afterEach(() => {
  scope?.stop()
  client.clear()
})

describe('新建凭据的去处', () => {
  it('设了去处、集合可用：写进那个集合，没有提示', async () => {
    const s = await start()
    expect(s.store.value?.kind).toBe('vault')
    expect(s.issue.value).toBeNull()
    expect(s.failed.value).toBe(false)
    // 集合取自连接面板同一个条目列表查询
    expect(fakes.api.vaultItems).toHaveBeenCalledWith('s1', conn().id)
    expect(client.getQueryData(['vault-items', 's1', conn().id])).toBeDefined()
  })

  it('集合变成只读或不见了：提交之前就提示，不等服务端拒绝', async () => {
    fakes.api.vaultItems.mockResolvedValue(itemList(true))
    expect((await start()).issue.value).toContain('集合只读')
    scope.stop()
    client.clear()
    fakes.api.vaultItems.mockResolvedValue(itemList(false, false))
    expect((await start()).issue.value).toContain('集合不可用')
  })

  it('连接不可用时不列条目，只按连接的状态提示', async () => {
    fakes.api.vaultConnections.mockResolvedValue({ items: [conn({ status: 'reauth_required' })] })
    const s = await start()
    expect(fakes.api.vaultItems).not.toHaveBeenCalled()
    expect(s.issue.value).toBe('连接需要重新登录，恢复前新建凭据将失败')
  })

  it('连接列表读取失败：说明读取失败，新建要拦下', async () => {
    fakes.api.vaultConnections.mockRejectedValue(new ApiError(500, '服务器错误'))
    const s = await start()
    expect(s.failed.value).toBe(true)
    expect(s.store.value).toBeNull()
    expect(storeLabel(s.store.value, s.failed.value)).toBe('去处读取失败')
    expect(storeBlocker({ store: s.store.value, failed: s.failed.value })).toBe('去处读取失败')
  })

  it('还在读时是省略号，也不能提交；读到之后放开', () => {
    expect(storeLabel(null, false)).toBe('…')
    expect(storeBlocker({ store: null, failed: false })).toBe('正在读取去处')
    expect(storeBlocker({ store: { kind: 'hosted' }, failed: false })).toBeNull()
    expect(storeLabel({ kind: 'hosted' }, false)).toBe('Kioku 托管')
  })
})

describe('列条目之后', () => {
  const CID = '00000000-0000-4000-8000-0000000000c1'
  const bound = (revisionDate: string) => ({
    ...itemList(false),
    items: [
      {
        id: 'item-1',
        organizationId: 'o1',
        collectionIds: ['c1'],
        name: 'NAS',
        type: 'login',
        fields: [],
        revisionDate,
        credential: { id: CID, identifier: 'nas' },
      },
      {
        id: 'item-2',
        organizationId: 'o1',
        collectionIds: ['c1'],
        name: '没起标识',
        type: 'login',
        fields: [],
        revisionDate,
        credential: null,
      },
    ],
  })

  it('条目的修改时间和缓存里的 valueChangedAt 一样时什么都不失效：几处一起读不会把凭据重读 N 遍', async () => {
    client.setQueryData(['credential', 's1', CID], {
      id: CID,
      valueChangedAt: '2026-11-01T00:00:00Z',
    })
    fakes.api.vaultItems.mockResolvedValue(bound('2026-11-01T00:00:00.000Z'))
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await fetchVaultItems(client, 's1', conn().id)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('对不上的（服务端可能清掉了需要轮换、版本号加一）：凭据列表、那一条的详情与待处理的条数失效', async () => {
    client.setQueryData(['credentials', 's1'], {
      items: [{ id: CID, valueChangedAt: '2026-11-01T00:00:00Z' }],
      truncated: false,
    })
    fakes.api.vaultItems.mockResolvedValue(bound('2026-11-05T00:00:00Z'))
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await fetchVaultItems(client, 's1', conn().id)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credentials', 's1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credential', 's1', CID] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['inbox-counts', 's1'] })
    // 不反过来让条目列表失效，不会循环
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['vault-items', 's1'] })
  })

  it('那条凭据还没缓存时当作可能改了', async () => {
    fakes.api.vaultItems.mockResolvedValue(bound('2026-11-01T00:00:00Z'))
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await fetchVaultItems(client, 's1', conn().id)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credential', 's1', CID] })
  })
})
