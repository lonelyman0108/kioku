import type { AppInfo, KeyInfo, KeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { ownedApps, REAL_MODE_CONSEQUENCES, usableKeys } from '../benchSession'

const scopes: KeyScopes = {
  readLayers: ['private'],
  writeLayers: ['private'],
  maxSensitivity: 'private',
  admin: false,
}

describe('谁能用测试台', () => {
  const app = (id: string, ownerAccountId: string) => ({ id, ownerAccountId }) as AppInfo

  it('只列自己是主人的应用：空间 owner 也看不到别人的应用', () => {
    const apps = [app('a', 'me'), app('b', 'other'), app('c', 'me')]
    expect(ownedApps(apps, 'me').map((a) => a.id)).toEqual(['a', 'c'])
    expect(ownedApps(apps, undefined)).toEqual([])
  })

  it('只列还有效的 Key：吊销的与作废的 effectiveScopes 是 null', () => {
    const key = (id: string, effectiveScopes: KeyScopes | null) =>
      ({ id, effectiveScopes }) as KeyInfo
    const keys = [key('live', scopes), key('revoked', null), key('live2', scopes)]
    expect(usableKeys(keys).map((k) => k.id)).toEqual(['live', 'live2'])
  })
})

describe('真实模式的确认文字', () => {
  it('列出写入是真的、对象删不掉、turn.end 排抽取', () => {
    const text = REAL_MODE_CONSEQUENCES.join('\n')
    expect(text).toContain('写入是真的')
    expect(text).toContain('新建的对象没有删除接口，只能合并')
    expect(text).toContain('turn.end')
    expect(text).toContain('排抽取')
  })
})
