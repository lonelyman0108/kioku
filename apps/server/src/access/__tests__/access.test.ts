import { LAYERS, type KeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  canManageCredentials,
  canRead,
  canReadCredential,
  canRevealCredential,
  canWrite,
  consoleAccess,
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
}

const memory = (over: Partial<MemoryFacts> = {}): MemoryFacts => ({
  layer: 'base',
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
const privateFact = memory({ layer: 'private', sensitivity: 'private', ownerAccountId: OWNER })
const ownerPref = memory({ layer: 'owner', sensitivity: 'internal', ownerAccountId: OWNER })
const soul = memory({ layer: 'persona', personaId: 'persona-1' })

describe('没有会话上下文（本机 agent）', () => {
  const access = resolveAccess(fullKey, app)

  it('能读主人的私人层和画像', () => {
    expect(canRead(access, privateFact, opts)).toBe(true)
    expect(canRead(access, ownerPref, opts)).toBe(true)
  })

  it('读不到别的成员的私人层', () => {
    expect(canRead(access, { ...privateFact, ownerAccountId: 'someone-else' }, opts)).toBe(false)
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

  it('读不到私人层和主人画像，即使 Key 有权限', () => {
    expect(canRead(access, privateFact, opts)).toBe(false)
    expect(canRead(access, ownerPref, opts)).toBe(false)
  })

  it('只看得到本群和全局来源的对象记忆', () => {
    const inGroup = memory({ layer: 'subject', originScope: 'group:g1' })
    expect(canRead(access, inGroup, opts)).toBe(true)
    expect(canRead(access, { ...inGroup, originScope: 'group:g2' }, opts)).toBe(false)
    expect(canRead(access, { ...inGroup, originScope: 'direct:alice' }, opts)).toBe(false)
  })

  it('敏感级封顶在 public', () => {
    expect(canRead(access, memory({ sensitivity: 'internal' }), opts)).toBe(false)
  })

  it('只能以 untrusted 身份写对象层和情节层', () => {
    expect(access.writeProvenance).toBe('untrusted')
    expect(access.writeOriginScope).toBe('group:g1')
    const intent = { sensitivity: 'public', appId: null, personaId: null } as const
    expect(canWrite(access, { ...intent, layer: 'subject' })).toBe(true)
    expect(canWrite(access, { ...intent, layer: 'persona' })).toBe(false)
    expect(canWrite(access, { ...intent, layer: 'private' })).toBe(false)
  })

  it('缺少群对象时拒绝解析', () => {
    expect(() => resolveAccess(fullKey, app, { chatType: 'group' })).toThrow()
  })
})

describe('私聊', () => {
  it('陌生人私聊只看得到与自己相关的对象记忆', () => {
    const access = resolveAccess(fullKey, app, { chatType: 'direct', senderSubjectId: 'bob' })
    const aboutBob = memory({ layer: 'subject', originScope: 'direct:bob' })
    expect(canRead(access, aboutBob, opts)).toBe(true)
    expect(canRead(access, { ...aboutBob, originScope: 'direct:alice' }, opts)).toBe(false)
    expect(canRead(access, ownerPref, opts)).toBe(false)
  })

  it('主人私聊默认不提升', () => {
    const access = resolveAccess(fullKey, app, {
      chatType: 'direct',
      senderSubjectId: 'me',
      senderIsOwner: true,
    })
    expect(access.maxSensitivity).toBe('public')
    expect(canRead(access, ownerPref, opts)).toBe(false)
  })

  it('配置提升后主人私聊能读画像，但仍读不到私人层', () => {
    const access = resolveAccess(
      fullKey,
      { ...app, elevateOwnerDirect: 'internal' },
      { chatType: 'direct', senderSubjectId: 'me', senderIsOwner: true },
    )
    expect(access.maxSensitivity).toBe('internal')
    expect(canRead(access, { ...ownerPref, originScope: 'global' }, opts)).toBe(true)
    expect(canRead(access, privateFact, opts)).toBe(false)
  })

  it('非主人即使应用开了提升也不提升', () => {
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

  it('Key 没给的层，任何上下文都拿不到', () => {
    const access = resolveAccess({ ...fullKey, readLayers: ['base'] }, app)
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

  it('人格层只能读当前人格继承链上的', () => {
    expect(canRead(access, { ...soul, personaId: 'other' }, opts)).toBe(false)
  })

  it('应用层只能读本应用的', () => {
    const appRule = memory({ layer: 'app', appId: 'app-1' })
    expect(canRead(access, appRule, opts)).toBe(true)
    expect(canRead(access, { ...appRule, appId: 'app-2' }, opts)).toBe(false)
  })
})

describe('应用层的写入', () => {
  const appRule = (appId: string) => ({
    layer: 'app' as const,
    sensitivity: 'internal' as const,
    appId,
    personaId: null,
  })

  it('Key 只能写本应用的应用层，admin Key 不限', () => {
    const access = resolveAccess(fullKey, app)
    expect(canWrite(access, appRule('app-1'))).toBe(true)
    expect(canWrite(access, appRule('app-2'))).toBe(false)
    expect(canWrite(resolveAccess({ ...fullKey, admin: true }, app), appRule('app-2'))).toBe(true)
  })

  it('管理界面里 owner 能写所有应用，editor 只能写自己是主人的应用，viewer 都不能写', () => {
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

describe('人格层的写入', () => {
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

  it('应用没有人格时 Key 写不了人格层', () => {
    expect(canWrite(resolveAccess(fullKey, app), personaRule('persona-child'))).toBe(false)
  })

  it('管理界面里 owner 与 editor 能写任何人格，viewer 不能写', () => {
    expect(canWrite(consoleAccess('owner', OWNER), personaRule('persona-parent'))).toBe(true)
    expect(canWrite(consoleAccess('editor', 'bob'), personaRule('persona-parent'))).toBe(true)
    expect(canWrite(consoleAccess('viewer', 'carol'), personaRule('persona-parent'))).toBe(false)
  })
})

describe('凭据', () => {
  const secretKey: KeyScopes = { ...fullKey, maxSensitivity: 'secret' }
  const own = { ownerAccountId: OWNER, appIds: null }

  it('和私人层一样：读说明要能读私人层、至少 private 级，取托管的值还要 secret 级', () => {
    const privateLevel = resolveAccess(fullKey, app)
    expect(canReadCredential(privateLevel, own)).toBe(true)
    expect(canRevealCredential(privateLevel, own)).toBe(false)
    const secretLevel = resolveAccess(secretKey, app)
    expect(canRevealCredential(secretLevel, own)).toBe(true)
    const internalOnly = resolveAccess({ ...secretKey, maxSensitivity: 'internal' }, app)
    expect(canReadCredential(internalOnly, own)).toBe(false)
    const noPrivate = resolveAccess(
      { ...secretKey, readLayers: LAYERS.filter((l) => l !== 'private') },
      app,
    )
    expect(canReadCredential(noPrivate, own)).toBe(false)
    expect(canRevealCredential(noPrivate, own)).toBe(false)
  })

  it('只看得到这次访问代表的成员自己的凭据', () => {
    const access = resolveAccess(secretKey, app)
    expect(canReadCredential(access, { ...own, ownerAccountId: 'someone-else' })).toBe(false)
  })

  it('群聊、私聊（包括提升后的主人私聊）、定时任务与子 agent 都看不到凭据', () => {
    const contexts = [
      resolveAccess(secretKey, app, { chatType: 'group', groupSubjectId: 'g1' }),
      resolveAccess(
        secretKey,
        { ...app, elevateOwnerDirect: 'internal' },
        { chatType: 'direct', senderSubjectId: 's1', senderIsOwner: true },
      ),
      resolveAccess(secretKey, app, { chatType: 'cron' }),
      resolveAccess(secretKey, app, { chatType: 'subagent' }),
    ]
    for (const access of contexts) {
      expect(canReadCredential(access, own)).toBe(false)
      expect(canManageCredentials(access)).toBe(false)
    }
  })

  it('限定了应用的只给那些应用用，跨人格 / 应用写入的 Key 也不放宽；管理界面不受限', () => {
    const limited = { ...own, appIds: ['app-2'] }
    expect(canReadCredential(resolveAccess(secretKey, app), limited)).toBe(false)
    expect(canReadCredential(resolveAccess({ ...secretKey, admin: true }, app), limited)).toBe(
      false,
    )
    expect(canReadCredential(resolveAccess(secretKey, { ...app, appId: 'app-2' }), limited)).toBe(
      true,
    )
    expect(canReadCredential(consoleAccess('owner', OWNER), limited)).toBe(true)
  })

  it('管理凭据要能读写私人层并且是 secret 级：只读、只写或 private 级的 Key 都不行', () => {
    expect(canManageCredentials(resolveAccess(secretKey, app))).toBe(true)
    expect(canManageCredentials(resolveAccess(fullKey, app))).toBe(false)
    expect(
      canManageCredentials(
        resolveAccess({ ...secretKey, writeLayers: LAYERS.filter((l) => l !== 'private') }, app),
      ),
    ).toBe(false)
    expect(
      canManageCredentials(
        resolveAccess({ ...secretKey, readLayers: LAYERS.filter((l) => l !== 'private') }, app),
      ),
    ).toBe(false)
  })

  it('管理界面里只有空间 owner 能管理凭据、查看托管的值；editor 与 viewer 只能看自己凭据的说明', () => {
    for (const role of ['editor', 'viewer'] as const) {
      const access = consoleAccess(role, OWNER)
      expect(canReadCredential(access, own)).toBe(true)
      expect(canRevealCredential(access, own)).toBe(false)
      expect(canManageCredentials(access)).toBe(false)
    }
    const owner = consoleAccess('owner', OWNER)
    expect(canRevealCredential(owner, own)).toBe(true)
    expect(canManageCredentials(owner)).toBe(true)
  })
})

describe('读不到的原因', () => {
  const access = resolveAccess(fullKey, app)

  it('按 canRead 的顺序给出第一个原因，读得到时为 null', () => {
    expect(readDenial(access, privateFact, opts)).toBeNull()
    expect(readDenial(access, memory({ deletedAt: new Date() }), opts)).toBe('deleted')
    expect(readDenial(access, memory({ validTo: new Date(0) }), opts)).toBe('expired')
    expect(readDenial(resolveAccess({ ...fullKey, readLayers: [] }, app), memory(), opts)).toBe(
      'layer',
    )
    expect(readDenial(access, memory({ sensitivity: 'secret' }), opts)).toBe('secret')
    expect(
      readDenial(
        access,
        memory({ layer: 'private', sensitivity: 'private', ownerAccountId: 'x' }),
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
