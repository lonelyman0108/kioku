import type { ApiKeyView } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  buildKeyFilterOptions,
  countMatchingCredentials,
  createDefaultKeyFilter,
  filterActiveKeys,
  hasActiveKeyFilter,
  KEY_FILTER_ALL,
  KEY_REALM_GENERIC,
  KEY_REALM_UNRESTRICTED,
  pruneStaleKeyFilter,
} from '../keyFilters'

function makeKey(overrides: Partial<ApiKeyView> & { id: string; name: string }): ApiKeyView {
  return {
    runtimeFamily: 'claudecode',
    prefix: 'kk_live_abcd',
    envs: [],
    allowedRealms: null,
    focusRealms: null,
    canWrite: true,
    canResolveCredentials: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  }
}

const sampleKeys: ApiKeyView[] = [
  makeKey({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'MacBook Pro Claude',
    runtimeFamily: 'claudecode',
    prefix: 'kk_live_mbp1',
    envs: ['mac', 'mbp-work'],
    allowedRealms: ['work'],
    canWrite: true,
    canResolveCredentials: true,
  }),
  makeKey({
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Linux CI Codex',
    runtimeFamily: 'codex',
    prefix: 'kk_live_ci02',
    envs: ['linux'],
    allowedRealms: [],
    canWrite: false,
    canResolveCredentials: false,
  }),
  makeKey({
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Personal Studio',
    runtimeFamily: 'claudecode',
    prefix: 'kk_live_per3',
    envs: ['mac'],
    allowedRealms: null,
    canWrite: true,
    canResolveCredentials: true,
  }),
  makeKey({
    id: '00000000-0000-4000-8000-000000000004',
    name: 'Home Assistant',
    runtimeFamily: 'openclaw',
    prefix: 'kk_live_hom4',
    envs: ['linux', 'home-24'],
    allowedRealms: ['personal', 'work'],
    canWrite: false,
    canResolveCredentials: true,
  }),
]

describe('访问密钥多维筛选', () => {
  it('根据有效密钥动态生成客户端、环境、场域与权限选项及计数', () => {
    const opts = buildKeyFilterOptions(sampleKeys)

    expect(opts.runtimes.map((o) => [o.value, o.label])).toEqual([
      ['__all__', '全部客户端（4）'],
      ['claudecode', 'Claude Code（2）'],
      ['codex', 'Codex（1）'],
      ['openclaw', 'OpenClaw（1）'],
    ])

    expect(opts.envs.map((o) => [o.value, o.label])).toEqual([
      ['__all__', '全部环境'],
      ['linux', 'Linux（2）'],
      ['mac', 'macOS（2）'],
      ['home-24', 'home-24（1）'],
      ['mbp-work', 'mbp-work（1）'],
    ])

    expect(opts.realms.map((o) => [o.value, o.count])).toEqual([
      ['__all__', 4],
      [KEY_REALM_UNRESTRICTED, 1],
      [KEY_REALM_GENERIC, 1],
      ['work', 2],
      ['personal', 1],
    ])

    expect(opts.permissions.map((o) => [o.value, o.count])).toEqual([
      ['all', 4],
      ['credentials', 3],
      ['readonly', 2],
    ])
  })

  it('支持按客户端、环境、场域、权限与关键字即时组合过滤', () => {
    const base = createDefaultKeyFilter()
    expect(hasActiveKeyFilter(base)).toBe(false)
    expect(filterActiveKeys(sampleKeys, base)).toHaveLength(4)

    expect(
      filterActiveKeys(sampleKeys, { ...base, runtime: 'codex' }).map((k) => k.prefix),
    ).toEqual(['kk_live_ci02'])
    expect(filterActiveKeys(sampleKeys, { ...base, env: 'home-24' }).map((k) => k.prefix)).toEqual([
      'kk_live_hom4',
    ])
    expect(
      filterActiveKeys(sampleKeys, { ...base, realm: KEY_REALM_UNRESTRICTED }).map((k) => k.prefix),
    ).toEqual(['kk_live_per3'])
    expect(
      filterActiveKeys(sampleKeys, { ...base, realm: KEY_REALM_GENERIC }).map((k) => k.prefix),
    ).toEqual(['kk_live_ci02'])
    expect(filterActiveKeys(sampleKeys, { ...base, realm: 'work' }).map((k) => k.prefix)).toEqual([
      'kk_live_mbp1',
      'kk_live_hom4',
    ])
    expect(
      filterActiveKeys(sampleKeys, { ...base, permission: 'credentials' }).map((k) => k.prefix),
    ).toEqual(['kk_live_mbp1', 'kk_live_per3', 'kk_live_hom4'])
    expect(
      filterActiveKeys(sampleKeys, { ...base, permission: 'readonly' }).map((k) => k.prefix),
    ).toEqual(['kk_live_ci02', 'kk_live_hom4'])

    // 关键字同时匹配名称与前缀（忽略大小写）
    expect(filterActiveKeys(sampleKeys, { ...base, q: 'KK_LIVE_MBP' }).map((k) => k.name)).toEqual([
      'MacBook Pro Claude',
    ])
    expect(filterActiveKeys(sampleKeys, { ...base, q: 'studio' }).map((k) => k.prefix)).toEqual([
      'kk_live_per3',
    ])

    // 组合条件与清空检测
    const combined = { ...base, realm: 'work', permission: 'readonly' as const }
    expect(hasActiveKeyFilter(combined)).toBe(true)
    expect(filterActiveKeys(sampleKeys, combined).map((k) => k.prefix)).toEqual(['kk_live_hom4'])
    expect(filterActiveKeys(sampleKeys, { ...combined, runtime: 'codex' })).toEqual([])
  })

  it('有效密钥变化导致动态筛选项消失时自动回退失效维度且保留仍有效的条件', () => {
    const remainingKeys = sampleKeys.filter((k) => k.runtimeFamily !== 'openclaw')
    const opts = buildKeyFilterOptions(remainingKeys)

    const pruned = pruneStaleKeyFilter(
      {
        runtime: 'openclaw',
        env: 'home-24',
        realm: 'personal',
        permission: 'credentials',
        q: 'mbp',
      },
      opts,
    )
    expect(pruned).toEqual({
      runtime: KEY_FILTER_ALL,
      env: KEY_FILTER_ALL,
      realm: KEY_FILTER_ALL,
      permission: 'credentials',
      q: 'mbp',
    })

    // 仍存在的动态选项保持不变
    const kept = pruneStaleKeyFilter(
      {
        runtime: 'claudecode',
        env: 'mac',
        realm: 'work',
        permission: 'all',
        q: '',
      },
      opts,
    )
    expect(kept).toEqual({
      runtime: 'claudecode',
      env: 'mac',
      realm: 'work',
      permission: 'all',
      q: '',
    })
  })
})

describe('托管凭据边界匹配计数', () => {
  const creds = [
    { allowedRealms: ['work'] },
    { allowedRealms: ['personal'] },
    { allowedRealms: ['work', 'ops'] },
    { allowedRealms: null },
    { allowedRealms: [] },
  ]

  it('严格遵循失败即拒绝边界规则', () => {
    expect(
      countMatchingCredentials({ canResolveCredentials: false, allowedRealms: null }, creds),
    ).toBe(0)
    expect(
      countMatchingCredentials({ canResolveCredentials: true, allowedRealms: null }, creds),
    ).toBe(5)
    expect(
      countMatchingCredentials({ canResolveCredentials: true, allowedRealms: [] }, creds),
    ).toBe(0)
    expect(
      countMatchingCredentials({ canResolveCredentials: true, allowedRealms: ['work'] }, creds),
    ).toBe(2)
    expect(
      countMatchingCredentials(
        { canResolveCredentials: true, allowedRealms: ['WORK', 'personal'] },
        creds,
      ),
    ).toBe(3)
  })
})
