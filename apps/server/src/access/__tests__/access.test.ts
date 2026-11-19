import {
  CREDENTIAL_ACCESS_REASONS,
  ENTRY_KINDS,
  READ_DENIALS,
  type CircleEffectiveGrant,
  type LensKeyScopes,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  accessMatrix,
  canModify,
  canRead,
  canUseCredential,
  canWrite,
  consoleAccess,
  credentialDenial,
  readDenial,
  resolveAccess,
  type ClientAccessConfig,
  type EntryFacts,
  type ResolveAccessInput,
  type SessionContext,
} from '../access'

const OWNER = 'owner-account'
const OTHER = 'other-account'
const PRIMARY_CIRCLE = '11111111-1111-4111-8111-111111111111'
const PERSONAL_CIRCLE = '22222222-2222-4222-8222-222222222222'
const HOME_CIRCLE = '33333333-3333-4333-8333-333333333333'
const CLIENT_1 = '44444444-4444-4444-8444-444444444444'
const CLIENT_2 = '55555555-5555-4555-8555-555555555555'

const fullScopes: LensKeyScopes = {
  readKinds: [...ENTRY_KINDS],
  writeKinds: [...ENTRY_KINDS],
  maxSensitivity: 'secret',
  allowedRealms: null,
  admin: false,
  credentials: 'use',
}

const fullGrants: CircleEffectiveGrant[] = [
  {
    circleId: PRIMARY_CIRCLE,
    circleSlug: 'work',
    circleName: '工作圈',
    circleKind: 'shared',
    isPrimary: true,
    mode: 'read_write',
    readKinds: [...ENTRY_KINDS],
    writeKinds: [...ENTRY_KINDS],
    maxSensitivity: 'secret',
    credentials: 'use',
    active: true,
  },
  {
    circleId: PERSONAL_CIRCLE,
    circleSlug: 'me',
    circleName: '个人圈',
    circleKind: 'personal',
    isPrimary: false,
    mode: 'read',
    readKinds: [...ENTRY_KINDS],
    writeKinds: [],
    maxSensitivity: 'private',
    credentials: 'none',
    active: true,
  },
  {
    circleId: HOME_CIRCLE,
    circleSlug: 'home',
    circleName: '家庭圈',
    circleKind: 'shared',
    isPrimary: false,
    mode: 'read_write',
    readKinds: ['entry'],
    writeKinds: ['entry'],
    maxSensitivity: 'private',
    credentials: 'none',
    active: true,
  },
]

const baseClient: ClientAccessConfig = {
  clientId: CLIENT_1,
  ownerAccountId: OWNER,
  personMemoryMode: 'strict',
}

function makeAccess(
  over: Partial<Omit<ResolveAccessInput, 'context'>> & { context?: SessionContext } = {},
) {
  return resolveAccess({
    primaryCircleId: PRIMARY_CIRCLE,
    primaryCircleRealms: ['work'],
    scopes: fullScopes,
    grants: fullGrants,
    client: baseClient,
    ...over,
  })
}

const entry = (over: Partial<EntryFacts> = {}): EntryFacts => ({
  circleId: PRIMARY_CIRCLE,
  kind: 'entry',
  sensitivity: 'public',
  originScope: 'global',
  clientId: null,
  ownerAccountId: null,
  subjectKind: null,
  realms: [],
  validTo: null,
  expiresAt: null,
  deletedAt: null,
  ...over,
})

describe('本机无上下文编码 Agent 与静态双向场域锁', () => {
  it('主场全可读、客场普通可读，本地摘要按成员隔离', () => {
    const access = makeAccess()
    expect(canRead(access, entry({ sensitivity: 'private' }))).toBe(true)
    expect(
      canRead(
        access,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'private' }),
      ),
    ).toBe(true)
    expect(
      canRead(
        access,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OTHER, sensitivity: 'private' }),
      ),
    ).toBe(false)
    expect(readDenial(access, entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OTHER }))).toBe(
      'owner',
    )

    const localEp = entry({ kind: 'episode', sensitivity: 'private', ownerAccountId: OWNER })
    expect(canRead(access, localEp)).toBe(true)
    expect(canRead(access, { ...localEp, ownerAccountId: OTHER })).toBe(false)
  })

  it('secret 仅限主场圈显式读取，客场圈始终拒绝为 circle', () => {
    const access = makeAccess()
    const homeSecret = entry({ circleId: HOME_CIRCLE, sensitivity: 'secret', realms: ['work'] })
    const primarySecret = entry({ circleId: PRIMARY_CIRCLE, sensitivity: 'secret' })

    expect(readDenial(access, homeSecret, { explicit: true })).toBe('circle')
    expect(readDenial(access, primarySecret, { explicit: false })).toBe('secret')
    expect(canRead(access, primarySecret, { explicit: true })).toBe(true)
  })

  it('静态双向场域锁：allowedRealms 拦截未标场域的个人机密与异场域机密', () => {
    const restricted = makeAccess({
      primaryCircleRealms: [],
      scopes: { ...fullScopes, allowedRealms: ['work'] },
    })

    expect(
      canRead(restricted, entry({ sensitivity: 'secret', realms: ['work'] }), { explicit: true }),
    ).toBe(true)
    expect(
      readDenial(restricted, entry({ sensitivity: 'secret', realms: ['home'] }), {
        explicit: true,
      }),
    ).toBe('realm')
    expect(
      readDenial(restricted, entry({ sensitivity: 'secret', realms: [] }), { explicit: true }),
    ).toBe('realm')

    // allowedRealms 为空时仍校验目标显式 realms 与 staticContextRealms 的交集
    const ctxLocked = makeAccess({
      primaryCircleRealms: [],
      scopes: { ...fullScopes, allowedRealms: null },
      staticContextRealms: new Set(['work']),
    })
    expect(
      readDenial(ctxLocked, entry({ sensitivity: 'secret', realms: ['home'] }), { explicit: true }),
    ).toBe('realm')
    expect(
      canRead(ctxLocked, entry({ sensitivity: 'secret', realms: ['work'] }), { explicit: true }),
    ).toBe(true)
    expect(
      canRead(ctxLocked, entry({ sensitivity: 'secret', realms: [] }), { explicit: true }),
    ).toBe(true)
  })
})

describe('群聊、跨群识人双模式、单群锁与私聊提权', () => {
  const inGroup = (
    over: Partial<SessionContext> = {},
    clientOver: Partial<ClientAccessConfig> = {},
  ) =>
    makeAccess({
      client: { ...baseClient, ...clientOver },
      context: { chatType: 'group', groupSubjectId: 'g1', ...over },
    })

  it('群聊与外人私聊死锁敏感级于 public，破壁点名也读不出个人圈 internal / private', () => {
    const access = inGroup()
    expect(
      canRead(
        access,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'public' }),
      ),
    ).toBe(true)
    expect(
      readDenial(
        access,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'internal' }),
      ),
    ).toBe('sensitivity')
    expect(
      readDenial(
        access,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'private' }),
      ),
    ).toBe('sensitivity')
    expect(
      readDenial(access, entry({ kind: 'episode', sensitivity: 'public', ownerAccountId: OWNER })),
    ).toBe('owner')
  })

  it('strict 模式严禁跨群读取人物事实；persona_shared 允许读取同实例未加锁群的人物印象', () => {
    const otherGroupFact = entry({
      kind: 'fact',
      subjectKind: 'person',
      originScope: 'group:g2',
      clientId: CLIENT_1,
      sensitivity: 'public',
    })
    const otherBotFact = { ...otherGroupFact, clientId: CLIENT_2 }
    const otherGroupSelfFact = { ...otherGroupFact, subjectKind: 'group' as const }
    const directFact = { ...otherGroupFact, originScope: 'direct:u1' }

    const strictAccess = inGroup({}, { personMemoryMode: 'strict' })
    expect(readDenial(strictAccess, otherGroupFact)).toBe('origin')

    const sharedAccess = inGroup(
      { sharedGroupScopes: ['group:g2'], lockedGroupScopes: ['group:g3'] },
      { personMemoryMode: 'persona_shared' },
    )
    expect(canRead(sharedAccess, otherGroupFact)).toBe(true)
    expect(canRead(sharedAccess, { ...otherGroupFact, clientId: null })).toBe(true)
    expect(readDenial(sharedAccess, otherBotFact)).toBe('client')
    expect(readDenial(sharedAccess, otherGroupSelfFact)).toBe('origin')
    expect(readDenial(sharedAccess, directFact)).toBe('origin')
    expect(readDenial(sharedAccess, { ...otherGroupFact, originScope: 'group:g3' })).toBe(
      'group_lock',
    )
  })

  it('单群强隔离锁启用时禁止任何跨群印象流入，即使共享群名单存在', () => {
    const isolated = inGroup(
      {
        currentGroupIsolated: true,
        sharedGroupScopes: ['group:g2'],
        lockedGroupScopes: ['group:g1'],
      },
      { personMemoryMode: 'persona_shared' },
    )
    const fromG2 = entry({
      kind: 'fact',
      subjectKind: 'person',
      originScope: 'group:g2',
      clientId: CLIENT_1,
    })
    expect(readDenial(isolated, fromG2)).toBe('group_lock')
  })

  it('本人私聊默认 public；开启 elevateOwnerDirect 后放宽至 internal 且仍拦 private/secret', () => {
    const normalDirect = makeAccess({
      client: { ...baseClient, personMemoryMode: 'persona_shared' },
      context: {
        chatType: 'direct',
        senderSubjectId: 'owner-sub',
        senderIsOwner: true,
        sharedGroupScopes: ['group:g2'],
      },
    })
    expect(
      readDenial(
        normalDirect,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'internal' }),
      ),
    ).toBe('sensitivity')

    const elevatedDirect = makeAccess({
      client: { ...baseClient, elevateOwnerDirect: 'internal', personMemoryMode: 'persona_shared' },
      context: {
        chatType: 'direct',
        senderSubjectId: 'owner-sub',
        senderIsOwner: true,
        sharedGroupScopes: ['group:g2'],
        lockedGroupScopes: ['group:g3'],
      },
    })
    expect(
      canRead(
        elevatedDirect,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'internal' }),
      ),
    ).toBe(true)
    expect(
      readDenial(
        elevatedDirect,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'private' }),
      ),
    ).toBe('sensitivity')
    expect(
      canRead(
        elevatedDirect,
        entry({ kind: 'fact', subjectKind: 'person', originScope: 'group:g2', clientId: CLIENT_1 }),
      ),
    ).toBe(true)
    expect(
      readDenial(
        elevatedDirect,
        entry({ kind: 'fact', subjectKind: 'person', originScope: 'group:g3', clientId: CLIENT_1 }),
      ),
    ).toBe('group_lock')

    // 陌生人开启同样 client 配置也不能提权
    const strangerDirect = makeAccess({
      client: { ...baseClient, elevateOwnerDirect: 'internal' },
      context: { chatType: 'direct', senderSubjectId: 'stranger', senderIsOwner: false },
    })
    expect(
      readDenial(
        strangerDirect,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'internal' }),
      ),
    ).toBe('sensitivity')
  })

  it('定时任务与子 agent 不读个人圈 internal 及任何群/私聊对话来源', () => {
    const cron = makeAccess({ context: { chatType: 'cron' } })
    expect(canRead(cron, entry({ sensitivity: 'internal' }))).toBe(true)
    expect(
      readDenial(
        cron,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'internal' }),
      ),
    ).toBe('sensitivity')
    expect(
      canRead(
        cron,
        entry({ circleId: PERSONAL_CIRCLE, ownerAccountId: OWNER, sensitivity: 'public' }),
      ),
    ).toBe(true)
    expect(
      readDenial(cron, entry({ originScope: 'group:g1', kind: 'fact', subjectKind: 'person' })),
    ).toBe('origin')
  })
})

describe('写入、修改、凭据校验与权限矩阵', () => {
  it('canWrite 与 canModify 限制可写圈、物种及 untrusted 同作用域', () => {
    const agent = makeAccess()
    expect(canWrite(agent, { circleId: HOME_CIRCLE, kind: 'entry', sensitivity: 'private' })).toBe(
      true,
    )
    expect(canWrite(agent, { circleId: HOME_CIRCLE, kind: 'fact', sensitivity: 'public' })).toBe(
      false,
    )
    expect(
      canWrite(agent, { circleId: PERSONAL_CIRCLE, kind: 'entry', sensitivity: 'public' }),
    ).toBe(false)

    const groupAccess = makeAccess({ context: { chatType: 'group', groupSubjectId: 'g1' } })
    expect(
      canModify(groupAccess, {
        circleId: PRIMARY_CIRCLE,
        kind: 'fact',
        sensitivity: 'public',
        provenance: 'untrusted',
        originScope: 'group:g1',
      }),
    ).toBe(true)
    expect(
      canModify(groupAccess, {
        circleId: PRIMARY_CIRCLE,
        kind: 'fact',
        sensitivity: 'public',
        provenance: 'owner',
        originScope: 'group:g1',
      }),
    ).toBe(false)
    expect(
      canModify(groupAccess, {
        circleId: PRIMARY_CIRCLE,
        kind: 'fact',
        sensitivity: 'public',
        provenance: 'untrusted',
        originScope: 'group:g2',
      }),
    ).toBe(false)
  })

  it('credentialDenial 拦会话上下文、客场圈与静态场域锁', () => {
    const access = makeAccess({
      primaryCircleRealms: [],
      scopes: { ...fullScopes, allowedRealms: ['work'], credentials: 'manage' },
    })
    expect(
      canUseCredential(access, {
        circleId: PRIMARY_CIRCLE,
        clientIds: null,
        allowedRealms: ['work'],
      }),
    ).toBe(true)
    expect(
      credentialDenial(
        access,
        { circleId: PERSONAL_CIRCLE, clientIds: null, allowedRealms: ['work'] },
        'use',
      ),
    ).toBe('circle')
    expect(
      credentialDenial(
        access,
        { circleId: PRIMARY_CIRCLE, clientIds: null, allowedRealms: null },
        'use',
      ),
    ).toBe('realm')
    expect(
      credentialDenial(
        access,
        { circleId: PRIMARY_CIRCLE, clientIds: [CLIENT_2], allowedRealms: ['work'] },
        'use',
      ),
    ).toBe('client')

    const groupAccess = makeAccess({
      scopes: { ...fullScopes, credentials: 'manage' },
      context: { chatType: 'group', groupSubjectId: 'g1' },
    })
    expect(
      credentialDenial(
        groupAccess,
        { circleId: PRIMARY_CIRCLE, clientIds: null, allowedRealms: ['work'] },
        'use',
      ),
    ).toBe('context')
  })

  it('consoleAccess 与 accessMatrix 返回完整结构与全部契约枚举保持一致', () => {
    const matrix = accessMatrix({
      primaryCircleId: PRIMARY_CIRCLE,
      primaryCircleRealms: ['work'],
      scopes: fullScopes,
      grants: fullGrants,
      client: baseClient,
    })
    expect(matrix.contexts).toHaveLength(5)
    expect(matrix.contexts[0]!.circles).toHaveLength(3)
    expect(matrix.contexts.find((c) => c.context === 'group')!.credentials).toBe('none')

    const viewer = consoleAccess(PRIMARY_CIRCLE, 'shared', 'viewer', OWNER, ['work'])
    expect(canRead(viewer, entry({ sensitivity: 'private' }))).toBe(true)
    expect(
      canWrite(viewer, { circleId: PRIMARY_CIRCLE, kind: 'entry', sensitivity: 'public' }),
    ).toBe(false)
    expect(READ_DENIALS.length).toBeGreaterThan(0)
    expect(CREDENTIAL_ACCESS_REASONS.length).toBeGreaterThan(0)
  })
})
