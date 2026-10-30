import type { AppInfo, KeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { benchAccountLabel, restrictedAppsLabel, scopesSummary } from '../labels'

const app = (id: string, name: string, owner: string): AppInfo => ({
  id,
  slug: name,
  name,
  runtimeFamily: 'mcp',
  ownerAccountId: owner,
  defaultPersonaId: null,
  config: {},
})

describe('凭据限定的应用', () => {
  const apps = [app('a', '编码 agent', 'me'), app('b', '别人的机器人', 'other')]

  it('不限定、不给任何应用、应用还没读出来时不下结论', () => {
    expect(restrictedAppsLabel(null, apps, 'me')).toBe('不限定')
    expect(restrictedAppsLabel([], apps, 'me')).toBe('不给任何应用')
    expect(restrictedAppsLabel(['a'], undefined, 'me')).toBe('…')
  })

  it('不是自己的应用标出来，找不到的算已删除', () => {
    expect(restrictedAppsLabel(['a', 'b', 'gone'], apps, 'me')).toBe(
      '编码 agent、别人的机器人（不是你的应用，用不了）、已删除的应用',
    )
  })
})

describe('Key 的权限', () => {
  const scopes: KeyScopes = {
    readLayers: ['base', 'private'],
    writeLayers: ['private'],
    maxSensitivity: 'private',
    admin: false,
  }

  it('一句话说完，跨人格写入才提', () => {
    expect(scopesSummary(scopes)).toBe('读 2 层 · 写 1 层 · 最高私密')
    expect(scopesSummary({ ...scopes, admin: true })).toBe(
      '读 2 层 · 写 1 层 · 最高私密 · 跨人格 / 应用写入',
    )
  })
})

describe('测试台写下的事件', () => {
  it('操作的账号，账号已经删掉时说一声', () => {
    expect(benchAccountLabel({ accountName: '主人', run: 'abcd1234' })).toBe('主人')
    expect(benchAccountLabel({ accountName: null, run: 'abcd1234' })).toBe('已删除的账号')
  })
})
