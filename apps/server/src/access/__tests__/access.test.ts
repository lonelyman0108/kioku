import { LAYERS, type KeyScopes } from '@kioku/contracts'
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
  type MemoryFacts,
} from '../access'

const OWNER = 'owner-account'
const app = { appId: 'app-1', ownerAccountId: OWNER }
const fullKey: KeyScopes = {
  readLayers: [...LAYERS],
  writeLayers: [...LAYERS],
  maxSensitivity: 'private',
  admin: false,
  credentials: 'none',
}

const memory = (over: Partial<MemoryFacts> = {}): MemoryFacts => ({
  layer: 'core',
  sensitivity: 'public',
  originScope: 'global',
  ownerAccountId: null,
  personaId: null,
  appId: null,
  validTo: null,
  expiresAt: null,
  deletedAt: null,
  ...over,
})
const opts = { personaIds: ['persona-1'] }
// 本人的私密记忆与内部记忆（原来的私人层与个人画像合并成了本人，按敏感级区分）
const privateFact = memory({ layer: 'user', sensitivity: 'private', ownerAccountId: OWNER })
const ownerPref = memory({ layer: 'user', sensitivity: 'internal', ownerAccountId: OWNER })
const soul = memory({ layer: 'persona', personaId: 'persona-1' })
// 不带会话上下文的会话摘要：归所属成员、私密
const localSummary = memory({ layer: 'episode', sensitivity: 'private', ownerAccountId: OWNER })

describe('没有会话上下文（本机 agent）', () => {
  const access = resolveAccess(fullKey, app)

  it('能读本人的私密与内部记忆', () => {
    expect(canRead(access, privateFact, opts)).toBe(true)
    expect(canRead(access, ownerPref, opts)).toBe(true)
  })

  it('读不到别的成员的本人记忆', () => {
    expect(canRead(access, { ...privateFact, ownerAccountId: 'someone-else' }, opts)).toBe(false)
  })

  it('读得到本人不带会话上下文的会话摘要，别的成员的读不到', () => {
    expect(canRead(access, localSummary, opts)).toBe(true)
    expect(canRead(access, { ...localSummary, ownerAccountId: 'someone-else' }, opts)).toBe(false)
  })

  it('不会超过 Key 的敏感级上限', () => {
    expect(
      canRead(access, { ...privateFact, sensitivity: 'secret' }, { ...opts, explicit: true }),
    ).toBe(false)
  })
})

describe('群聊', () => {
  const access = resolveAccess(fullKey, app, { chatType: 'group', groupSubjectId: 'g1' })

  it('能借用人格', () => {
    expect(canRead(access, soul, opts)).toBe(true)
  })

  it('读不到本人的记忆与不带会话上下文的会话摘要，即使 Key 有权限', () => {
    expect(canRead(access, privateFact, opts)).toBe(false)
    expect(canRead(access, ownerPref, opts)).toBe(false)
    expect(canRead(access, localSummary, opts)).toBe(false)
  })

  it('只看得到本群和全局来源的联系人事实', () => {
    const inGroup = memory({ layer: 'subject', originScope: 'group:g1' })
    expect(canRead(access, inGroup, opts)).toBe(true)
    expect(canRead(access, { ...inGroup, originScope: 'group:g2' }, opts)).toBe(false)
    expect(canRead(access, { ...inGroup, originScope: 'direct:alice' }, opts)).toBe(false)
  })

  it('敏感级封顶在 public', () => {
    expect(canRead(access, memory({ sensitivity: 'internal' }), opts)).toBe(false)
  })

  it('只能以 untrusted 身份写联系人的事实与会话摘要', () => {
    expect(access.writeProvenance).toBe('untrusted')
    expect(access.writeOriginScope).toBe('group:g1')
    const intent = { sensitivity: 'public', appId: null, personaId: null } as const
    expect(canWrite(access, { ...intent, layer: 'subject' })).toBe(true)
    expect(canWrite(access, { ...intent, layer: 'episode' })).toBe(true)
    expect(canWrite(access, { ...intent, layer: 'persona' })).toBe(false)
    expect(canWrite(access, { ...intent, layer: 'user' })).toBe(false)
  })

  it('只能改动不可信来源写下的记录：受信的（本人确认过的、agent 写的）动不了', () => {
    const row = { layer: 'subject', sensitivity: 'public', appId: null, personaId: null } as const
    expect(canModify(access, { ...row, provenance: 'untrusted' })).toBe(true)
    expect(canModify(access, { ...row, provenance: 'owner' })).toBe(false)
    expect(canModify(access, { ...row, provenance: 'agent' })).toBe(false)
    // 受信的写入方不受这条限制
    const agent = resolveAccess(fullKey, app, {})
    expect(canModify(agent, { ...row, provenance: 'untrusted' })).toBe(true)
    expect(canModify(agent, { ...row, provenance: 'owner' })).toBe(true)
  })

  it('缺少群时拒绝解析', () => {
    expect(() => resolveAccess(fullKey, app, { chatType: 'group' })).toThrow()
  })
})

describe('私聊', () => {
  it('陌生人私聊只看得到与自己相关的联系人事实', () => {
    const access = resolveAccess(fullKey, app, { chatType: 'direct', senderSubjectId: 'bob' })
    const aboutBob = memory({ layer: 'subject', originScope: 'direct:bob' })
    expect(canRead(access, aboutBob, opts)).toBe(true)
    expect(canRead(access, { ...aboutBob, originScope: 'direct:alice' }, opts)).toBe(false)
    expect(canRead(access, ownerPref, opts)).toBe(false)
  })

  it('本人私聊默认不读本人的记忆', () => {
    const access = resolveAccess(fullKey, app, {
      chatType: 'direct',
      senderSubjectId: 'me',
      senderIsOwner: true,
    })
    expect(access.maxSensitivity).toBe('public')
    expect(canRead(access, ownerPref, opts)).toBe(false)
  })

  it('开启「本人私聊时读取本人记忆」后读得到本人的内部记忆，私密的与本机会话的摘要仍读不到', () => {
    const access = resolveAccess(
      fullKey,
      { ...app, elevateOwnerDirect: 'internal' },
      { chatType: 'direct', senderSubjectId: 'me', senderIsOwner: true },
    )
    expect(access.maxSensitivity).toBe('internal')
    expect(canRead(access, { ...ownerPref, originScope: 'global' }, opts)).toBe(true)
    expect(canRead(access, privateFact, opts)).toBe(false)
    expect(canRead(access, localSummary, opts)).toBe(false)
  })

  it('不是本人时即使应用开了也不读本人的记忆', () => {
    const access = resolveAccess(
      fullKey,
      { ...app, elevateOwnerDirect: 'internal' },
      { chatType: 'direct', senderSubjectId: 'bob', senderIsOwner: false },
    )
    expect(access.maxSensitivity).toBe('public')
  })
})

describe('上下文只能收紧', () => {
  it('Key 只给 public 时，提升也不会超过 public', () => {
    const access = resolveAccess(
      { ...fullKey, maxSensitivity: 'public' },
      { ...app, elevateOwnerDirect: 'internal' },
      { chatType: 'direct', senderSubjectId: 'me', senderIsOwner: true },
    )
    expect(access.maxSensitivity).toBe('public')
  })

  it('Key 没给的归属，任何上下文都拿不到', () => {
    const access = resolveAccess({ ...fullKey, readLayers: ['core'] }, app)
    expect(canRead(access, soul, opts)).toBe(false)
  })
})

describe('secret', () => {
  const secretKey: KeyScopes = { ...fullKey, maxSensitivity: 'secret' }
  const secret = { ...privateFact, sensitivity: 'secret' as const }

  it('只有显式读取时才返回', () => {
    const access = resolveAccess(secretKey, app)
    expect(canRead(access, secret, opts)).toBe(false)
    expect(canRead(access, secret, { ...opts, explicit: true })).toBe(true)
  })

  it('任何会话上下文里都读不到', () => {
    const access = resolveAccess(secretKey, app, { chatType: 'cron' })
    expect(canRead(access, secret, { ...opts, explicit: true })).toBe(false)
  })
})

describe('有效期', () => {
  const access = resolveAccess(fullKey, app)
  const now = new Date('2026-10-26T00:00:00Z')

  it('已失效、已过期、已删除的记忆都不可见', () => {
    const past = new Date('2026-10-01T00:00:00Z')
    expect(canRead(access, memory({ validTo: past }), { ...opts, now })).toBe(false)
    expect(canRead(access, memory({ expiresAt: past }), { ...opts, now })).toBe(false)
    expect(canRead(access, memory({ deletedAt: past }), { ...opts, now })).toBe(false)
  })

  it('人格的记忆只能读当前人格继承链上的', () => {
    expect(canRead(access, { ...soul, personaId: 'other' }, opts)).toBe(false)
  })

  it('应用的记忆只能读本应用的', () => {
    const appRule = memory({ layer: 'app', appId: 'app-1' })
    expect(canRead(access, appRule, opts)).toBe(true)
    expect(canRead(access, { ...appRule, appId: 'app-2' }, opts)).toBe(false)
  })
})

describe('应用的记忆的写入', () => {
  const appRule = (appId: string) => ({
    layer: 'app' as const,
    sensitivity: 'internal' as const,
    appId,
    personaId: null,
  })

  it('Key 只能写本应用的记忆，admin Key 不限', () => {
    const access = resolveAccess(fullKey, app)
    expect(canWrite(access, appRule('app-1'))).toBe(true)
    expect(canWrite(access, appRule('app-2'))).toBe(false)
    expect(canWrite(resolveAccess({ ...fullKey, admin: true }, app), appRule('app-2'))).toBe(true)
  })

  it('管理界面里 owner 能写所有应用，editor 只能写自己是所有者的应用，viewer 都不能写', () => {
    expect(canWrite(consoleAccess('owner', OWNER), appRule('app-2'))).toBe(true)
    const editor = consoleAccess('editor', 'bob', ['app-bob'])
    expect(canWrite(editor, appRule('app-bob'))).toBe(true)
    expect(canWrite(editor, appRule('app-1'))).toBe(false)
    expect(editor.admin).toBe(false)
    expect(canWrite(consoleAccess('viewer', 'carol', ['app-carol']), appRule('app-carol'))).toBe(
      false,
    )
  })
})

describe('人格的记忆的写入', () => {
  const personaRule = (personaId: string) => ({
    layer: 'persona' as const,
    sensitivity: 'public' as const,
    appId: null,
    personaId,
  })
  const withPersona = { ...app, personaId: 'persona-child' }

  it('Key 只能写应用当前的人格，不能写继承链上的祖先；admin Key 不限', () => {
    const access = resolveAccess(fullKey, withPersona)
    expect(canWrite(access, personaRule('persona-child'))).toBe(true)
    expect(canWrite(access, personaRule('persona-parent'))).toBe(false)
    expect(
      canWrite(
        resolveAccess({ ...fullKey, admin: true }, withPersona),
        personaRule('persona-parent'),
      ),
    ).toBe(true)
  })

  it('应用没有人格时 Key 写不了人格的记忆', () => {
    expect(canWrite(resolveAccess(fullKey, app), personaRule('persona-child'))).toBe(false)
  })

  it('管理界面里 owner 与 editor 能写任何人格，viewer 不能写', () => {
    expect(canWrite(consoleAccess('owner', OWNER), personaRule('persona-parent'))).toBe(true)
    expect(canWrite(consoleAccess('editor', 'bob'), personaRule('persona-parent'))).toBe(true)
    expect(canWrite(consoleAccess('viewer', 'carol'), personaRule('persona-parent'))).toBe(false)
  })
})

describe('凭据', () => {
  const useKey: KeyScopes = { ...fullKey, credentials: 'use' }
  const manageKey: KeyScopes = { ...fullKey, credentials: 'manage' }
  const own = { appIds: null }

  it('取用要凭据能力至少是取用，并能读本人、至少 private 级；不再借用 secret 级', () => {
    expect(canUseCredential(resolveAccess(useKey, app), own)).toBe(true)
    expect(credentialDenial(resolveAccess(fullKey, app), own, 'use')).toBe('capability')
    expect(
      credentialDenial(resolveAccess({ ...fullKey, maxSensitivity: 'secret' }, app), own, 'use'),
    ).toBe('capability')
    expect(
      credentialDenial(resolveAccess({ ...useKey, maxSensitivity: 'internal' }, app), own, 'use'),
    ).toBe('scope')
    expect(
      credentialDenial(
        resolveAccess({ ...useKey, readLayers: LAYERS.filter((l) => l !== 'user') }, app),
        own,
        'use',
      ),
    ).toBe('scope')
  })

  it('群聊、私聊（包括开启后的本人私聊）、定时任务与子 agent 都用不了凭据', () => {
    const contexts = [
      resolveAccess(manageKey, app, { chatType: 'group', groupSubjectId: 'g1' }),
      resolveAccess(
        manageKey,
        { ...app, elevateOwnerDirect: 'internal' },
        { chatType: 'direct', senderSubjectId: 's1', senderIsOwner: true },
      ),
      resolveAccess(manageKey, app, { chatType: 'cron' }),
      resolveAccess(manageKey, app, { chatType: 'subagent' }),
    ]
    for (const access of contexts) {
      expect(credentialDenial(access, own, 'use')).toBe('context')
      expect(credentialDenial(access, own, 'manage')).toBe('context')
    }
  })

  it('限定了应用的只给那些应用用，跨人格 / 应用写入的 Key 也不放宽；管理界面不受限', () => {
    const limited = { appIds: ['app-2'] }
    expect(credentialDenial(resolveAccess(useKey, app), limited, 'use')).toBe('app')
    expect(canUseCredential(resolveAccess({ ...useKey, admin: true }, app), limited)).toBe(false)
    expect(canUseCredential(resolveAccess(useKey, { ...app, appId: 'app-2' }), limited)).toBe(true)
    expect(canUseCredential(consoleAccess('owner', OWNER), limited)).toBe(true)
  })

  it('管理要凭据能力是管理，并能读写本人', () => {
    expect(credentialDenial(resolveAccess(manageKey, app), own, 'manage')).toBeNull()
    expect(credentialDenial(resolveAccess(useKey, app), own, 'manage')).toBe('capability')
    expect(
      credentialDenial(
        resolveAccess({ ...manageKey, writeLayers: LAYERS.filter((l) => l !== 'user') }, app),
        own,
        'manage',
      ),
    ).toBe('scope')
  })

  it('管理界面里只有空间 owner 能管理凭据；editor 与 viewer 只能看自己的', () => {
    for (const role of ['editor', 'viewer'] as const) {
      const access = consoleAccess(role, OWNER)
      expect(canUseCredential(access, own)).toBe(true)
      expect(credentialDenial(access, own, 'manage')).not.toBeNull()
    }
    expect(credentialDenial(consoleAccess('owner', OWNER), own, 'manage')).toBeNull()
  })

  it('权限范围给出每个会话上下文下实际的凭据能力', () => {
    const matrix = accessMatrix(manageKey, app)
    expect(Object.fromEntries(matrix.contexts.map((c) => [c.context, c.credentials]))).toEqual({
      none: 'manage',
      direct: 'none',
      owner_direct: 'none',
      group: 'none',
      cron: 'none',
    })
    const readOnly = accessMatrix({ ...manageKey, writeLayers: [] }, app)
    expect(readOnly.contexts.find((c) => c.context === 'none')!.credentials).toBe('use')
  })
})

describe('读不到的原因', () => {
  const access = resolveAccess(fullKey, app)

  it('按 canRead 的顺序给出第一个原因，读得到时为 null', () => {
    expect(readDenial(access, privateFact, opts)).toBeNull()
    expect(readDenial(access, memory({ deletedAt: new Date() }), opts)).toBe('deleted')
    expect(
      readDenial(access, memory({ validTo: new Date(0) }), { ...opts, now: new Date(1) }),
    ).toBe('expired')
    // 有有效期又没给时刻：不拿应用的钟顶替
    expect(() => readDenial(access, memory({ validTo: new Date(0) }), opts)).toThrow('数据库的时刻')
    expect(readDenial(resolveAccess({ ...fullKey, readLayers: [] }, app), memory(), opts)).toBe(
      'layer',
    )
    expect(readDenial(access, memory({ sensitivity: 'secret' }), opts)).toBe('secret')
    expect(
      readDenial(
        access,
        memory({ layer: 'user', sensitivity: 'private', ownerAccountId: 'x' }),
        opts,
      ),
    ).toBe('owner')
    expect(readDenial(access, memory({ layer: 'persona', personaId: 'other' }), opts)).toBe(
      'persona',
    )
    expect(
      readDenial(access, memory({ layer: 'app', sensitivity: 'internal', appId: 'app-2' }), opts),
    ).toBe('app')
    const group = resolveAccess(fullKey, app, { chatType: 'group', groupSubjectId: 'g1' })
    expect(readDenial(group, memory({ sensitivity: 'internal' }), opts)).toBe('sensitivity')
    expect(readDenial(group, memory({ originScope: 'group:g2' }), opts)).toBe('origin')
  })
})

describe('本人不设公开', () => {
  it('写不了本人的公开记忆，权限范围里那一格读写都没有', () => {
    const access = resolveAccess(fullKey, app)
    const intent = { layer: 'user', appId: null, personaId: null } as const
    expect(canWrite(access, { ...intent, sensitivity: 'public' })).toBe(false)
    expect(canWrite(access, { ...intent, sensitivity: 'internal' })).toBe(true)
    const none = accessMatrix(fullKey, app).contexts.find((c) => c.context === 'none')!
    const user = none.rows.find((r) => r.layer === 'user')!
    expect(user.cells.find((c) => c.sensitivity === 'public')).toEqual({
      sensitivity: 'public',
      read: 'none',
      write: false,
    })
    expect(user.cells.find((c) => c.sensitivity === 'private')).toMatchObject({
      read: 'recall',
      write: true,
    })
  })
})
