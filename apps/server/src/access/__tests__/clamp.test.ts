import { ENTRY_KINDS, type LensKeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  clampScopesToRole,
  computeKeyGrants,
  keyEffectiveScopes,
  type CircleGrantMembership,
} from '../access'

const full: LensKeyScopes = {
  readKinds: [...ENTRY_KINDS],
  writeKinds: [...ENTRY_KINDS],
  maxSensitivity: 'secret',
  allowedRealms: ['work'],
  admin: true,
  credentials: 'manage',
}

describe('密钥上限随主人当前角色收紧', () => {
  it('owner 保持原样', () => {
    expect(clampScopesToRole(full, 'owner')).toEqual(full)
  })

  it('editor 失去 admin、secret 与凭据能力，保留可写与允许场域', () => {
    expect(clampScopesToRole(full, 'editor')).toEqual({
      ...full,
      maxSensitivity: 'private',
      admin: false,
      credentials: 'none',
    })
  })

  it('viewer 转为只读', () => {
    expect(clampScopesToRole(full, 'viewer')).toEqual({
      ...full,
      writeKinds: [],
      maxSensitivity: 'private',
      admin: false,
      credentials: 'none',
    })
  })

  it('原本更低的敏感级不会被抬高', () => {
    const low: LensKeyScopes = { ...full, maxSensitivity: 'public', admin: false }
    expect(clampScopesToRole(low, 'editor').maxSensitivity).toBe('public')
  })
})

describe('密钥有效上限与多记忆圈独立授权计算', () => {
  const issuedAt = new Date('2026-10-01T00:00:00Z')
  const joinedBefore = new Date('2026-09-01T00:00:00Z')
  const joinedAfter = new Date('2026-10-02T00:00:00Z')
  const key = { scopes: full, createdAt: issuedAt, revokedAt: null }

  const primary: CircleGrantMembership = {
    circleId: '11111111-1111-4111-8111-111111111111',
    circleSlug: 'work',
    circleName: '工作圈',
    circleKind: 'shared',
    role: 'owner',
    memberSince: joinedBefore,
  }
  const personal: CircleGrantMembership = {
    circleId: '22222222-2222-4222-8222-222222222222',
    circleSlug: 'me',
    circleName: '个人圈',
    circleKind: 'personal',
    role: 'owner',
    memberSince: joinedBefore,
  }
  const home: CircleGrantMembership = {
    circleId: '33333333-3333-4333-8333-333333333333',
    circleSlug: 'home',
    circleName: '家庭圈',
    circleKind: 'shared',
    role: 'editor',
    memberSince: joinedBefore,
  }

  it('keyEffectiveScopes 吊销、离圈、重进或账号停用时返回 null', () => {
    expect(
      keyEffectiveScopes(key, { role: 'owner', memberSince: joinedBefore, disabledAt: null }),
    ).toEqual(full)
    expect(
      keyEffectiveScopes(key, { role: 'editor', memberSince: joinedBefore, disabledAt: null }),
    ).toEqual(clampScopesToRole(full, 'editor'))
    expect(
      keyEffectiveScopes(
        { ...key, revokedAt: new Date() },
        { role: 'owner', memberSince: joinedBefore, disabledAt: null },
      ),
    ).toBeNull()
    expect(
      keyEffectiveScopes(key, { role: 'owner', memberSince: joinedAfter, disabledAt: null }),
    ).toBeNull()
    expect(
      keyEffectiveScopes(key, { role: 'owner', memberSince: joinedBefore, disabledAt: new Date() }),
    ).toBeNull()
  })

  it('computeKeyGrants：主场失效则整把密钥失效；客场失效仅剥离该客场', () => {
    const normal = computeKeyGrants({
      key,
      ownerDisabledAt: null,
      primary,
      linked: [
        { grant: { circleId: personal.circleId, mode: 'read' }, membership: personal },
        { grant: { circleId: home.circleId, mode: 'read_write' }, membership: home },
      ],
    })
    expect(normal.effectiveScopes).toEqual(full)
    expect(normal.circleGrants[1]).toMatchObject({
      circleId: personal.circleId,
      mode: 'read',
      maxSensitivity: 'private',
      credentials: 'none',
      writeKinds: [],
      active: true,
    })
    expect(normal.circleGrants[2]).toMatchObject({
      circleId: home.circleId,
      mode: 'read_write',
      writeKinds: ['entry'],
      maxSensitivity: 'private',
      credentials: 'none',
      active: true,
    })

    // 客场被降为 viewer 时自动收紧为只读；客场离开重进时仅该客场失效
    const downgradedAndRejoined = computeKeyGrants({
      key,
      ownerDisabledAt: null,
      primary,
      linked: [
        {
          grant: { circleId: personal.circleId, mode: 'read' },
          membership: { ...personal, memberSince: joinedAfter },
        },
        {
          grant: { circleId: home.circleId, mode: 'read_write' },
          membership: { ...home, role: 'viewer' },
        },
      ],
    })
    expect(downgradedAndRejoined.effectiveScopes).toEqual(full)
    expect(downgradedAndRejoined.circleGrants[1]!.active).toBe(false)
    expect(downgradedAndRejoined.circleGrants[2]).toMatchObject({
      mode: 'read',
      writeKinds: [],
      active: true,
    })

    // 主场离开后所有记忆圈全部失效
    const primaryLost = computeKeyGrants({
      key,
      ownerDisabledAt: null,
      primary: { ...primary, memberSince: joinedAfter },
      linked: [{ grant: { circleId: home.circleId, mode: 'read_write' }, membership: home }],
    })
    expect(primaryLost.effectiveScopes).toBeNull()
    expect(primaryLost.circleGrants.every((g) => !g.active)).toBe(true)
  })
})
