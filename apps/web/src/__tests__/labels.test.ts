import type { ClientInfo, LensKeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  allowedRealmsLabel,
  benchAccountLabel,
  entryViaLabels,
  eventLabel,
  originScopeText,
  restrictedClientsLabel,
  scopeTagText,
  scopeTags,
  scopesSummary,
} from '../labels'

const client = (id: string, name: string, owner: string): ClientInfo => ({
  id,
  circleId: '00000000-0000-4000-8000-000000000001',
  slug: name,
  name,
  runtimeFamily: 'mcp',
  ownerAccountId: owner,
  defaultPersonaId: null,
  config: { personMemoryMode: 'strict' },
})

describe('凭据限定的客户端与场域', () => {
  const clients = [client('a', '编码 agent', 'me'), client('b', '别人的机器人', 'other')]

  it('不限定、不开放给任何客户端、客户端列表还没读出来时不下结论', () => {
    expect(restrictedClientsLabel(null, clients, 'me')).toBe('不限定')
    expect(restrictedClientsLabel([], clients, 'me')).toBe('不开放给任何客户端')
    expect(restrictedClientsLabel(['a'], undefined, 'me')).toBe('…')
  })

  it('不是自己的客户端标出来，找不到的算已删除', () => {
    expect(restrictedClientsLabel(['a', 'b', 'gone'], clients, 'me')).toBe(
      '编码 agent、别人的机器人（非当前账号的客户端，不可用）、已删除的客户端',
    )
  })

  it('允许的场域说清不限定、空数组与列表', () => {
    expect(allowedRealmsLabel(null)).toBe('不限定')
    expect(allowedRealmsLabel([])).toBe('禁止所有场域')
    expect(allowedRealmsLabel(['work', 'home'])).toBe('work、home')
  })
})

describe('访问密钥的权限', () => {
  const scopes: LensKeyScopes = {
    readKinds: ['entry', 'fact'],
    writeKinds: ['entry'],
    maxSensitivity: 'private',
    allowedRealms: null,
    admin: false,
    credentials: 'none',
  }

  it('拆成标签，场域白名单、凭据能力与管理语境词典有才写', () => {
    expect(scopeTags(scopes).map(scopeTagText)).toEqual(['读 2 类', '写 1 类', '至私密'])
    expect(scopesSummary(scopes)).toBe('读 2 类，写 1 类，至私密')
    expect(scopesSummary({ ...scopes, admin: true })).toBe(
      '读 2 类，写 1 类，至私密，管理语境词典与人格',
    )
    expect(scopesSummary({ ...scopes, allowedRealms: ['work'], credentials: 'use' })).toBe(
      '读 2 类，写 1 类，至私密，场域 work，凭据取用',
    )
  })

  it('传了实际的凭据能力就写它：签发弹窗底部按范围算出的实际值', () => {
    expect(scopesSummary({ ...scopes, credentials: 'manage' }, 'use')).toBe(
      '读 2 类，写 1 类，至私密，凭据取用',
    )
    expect(scopeTags({ ...scopes, credentials: 'use' }, 'none').map((t) => t.key)).toEqual([
      'read',
      'write',
      'max',
    ])
  })
})

describe('词条事件与来源', () => {
  it('转存、跨圈迁移、忽略明文提示与访问有自己的说法，不把类型名显示出来', () => {
    expect(eventLabel('transfer_out').label).toBe('迁出记忆圈')
    expect(eventLabel('transfer_in').label).toBe('迁入记忆圈')
    expect(eventLabel('convert_credential').label).toBe('转存为凭据')
    expect(eventLabel('protect').label).toBe('提高保护')
    expect(eventLabel('redact').label).toBe('抹除敏感段')
    expect(eventLabel('ignore_plaintext').label).toBe('忽略明文提示')
    expect(eventLabel('unignore_plaintext').label).toBe('撤销忽略')
    expect(eventLabel('access').label).toBe('查看正文')
  })

  it('访问经由哪里都有说法', () => {
    const vias = [
      'console',
      'export',
      'rest',
      'kioku_get',
      'kioku_browse',
      'kioku_update',
      'kioku_transfer',
    ]
    expect(Object.keys(entryViaLabels).sort()).toEqual([...vias].sort())
  })

  it('来源作用域按群、私聊、客户端与全局显示', () => {
    expect(originScopeText({ kind: 'client', id: 'c1', name: 'Codex' })).toBe('客户端「Codex」')
    expect(originScopeText({ kind: 'client', id: 'c1', name: null })).toBe('已删除的客户端')
    expect(originScopeText({ kind: 'global', id: '', name: null })).toBe('全局')
  })
})

describe('测试台写下的事件', () => {
  it('操作的账号，账号已经删掉时说一声', () => {
    expect(benchAccountLabel({ accountName: 'Alice', run: 'abcd1234' })).toBe('Alice')
    expect(benchAccountLabel({ accountName: null, run: 'abcd1234' })).toBe('已删除的账号')
  })
})
