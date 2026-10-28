import type { AppInfo } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { restrictedAppsLabel } from '../labels'

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
