import type { AppInfo, KeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  benchAccountLabel,
  eventLabel,
  memoryViaLabels,
  restrictedAppsLabel,
  scopesSummary,
} from '../labels'

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

  it('不限定、不开放给任何应用、应用还没读出来时不下结论', () => {
    expect(restrictedAppsLabel(null, apps, 'me')).toBe('不限定')
    expect(restrictedAppsLabel([], apps, 'me')).toBe('不开放给任何应用')
    expect(restrictedAppsLabel(['a'], undefined, 'me')).toBe('…')
  })

  it('不是自己的应用标出来，找不到的算已删除', () => {
    expect(restrictedAppsLabel(['a', 'b', 'gone'], apps, 'me')).toBe(
      '编码 agent、别人的机器人（非当前账号的应用，不可用）、已删除的应用',
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
    expect(scopesSummary(scopes)).toBe('可读 2 层，可写 1 层，最高私密')
    expect(scopesSummary({ ...scopes, admin: true })).toBe(
      '可读 2 层，可写 1 层，最高私密，跨人格 / 应用写入',
    )
  })
})

describe('记忆事件', () => {
  it('转存、忽略明文提示与访问有自己的说法，不把类型名显示出来', () => {
    expect(eventLabel('convert_credential').label).toBe('转存为凭据')
    expect(eventLabel('ignore_plaintext').label).toBe('忽略明文提示')
    expect(eventLabel('unignore_plaintext').label).toBe('撤销忽略')
    expect(eventLabel('access').label).toBe('查看正文')
  })

  it('访问经由哪里都有说法', () => {
    const vias = ['console', 'rest', 'kioku_get', 'kioku_list', 'kioku_update', 'kioku_move']
    expect(Object.keys(memoryViaLabels).sort()).toEqual([...vias].sort())
  })
})

describe('测试台写下的事件', () => {
  it('操作的账号，账号已经删掉时说一声', () => {
    expect(benchAccountLabel({ accountName: '主人', run: 'abcd1234' })).toBe('主人')
    expect(benchAccountLabel({ accountName: null, run: 'abcd1234' })).toBe('已删除的账号')
  })
})
