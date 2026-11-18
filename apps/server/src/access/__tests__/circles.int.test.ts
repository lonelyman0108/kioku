import { CIRCLE_LIMIT_DEFAULT, ENTRY_KINDS, type LensKeyScopes } from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { withCircle, type Database, type Db } from '../../db/client'
import {
  accounts,
  apiKeys,
  circleDepartures,
  circleMembers,
  clientGroupRules,
  clients,
  personas,
  subjects,
} from '../../db/schema'
import type { Deps } from '../../http/env'
import { router } from '../../http/openapi'
import { accountRoutes } from '../../routes/accounts'
import { authRoutes } from '../../routes/auth'
import { setupRoutes } from '../../routes/setup'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  circleLimitView,
  createPersonalCircle,
  createSharedCircle,
  deleteSharedCircle,
  listMembers,
  loadSessionUser,
  removeMember,
  saveCircleLimit,
  transferOwnership,
  updateCircle,
  updateMemberRole,
} from '../circles'
import {
  createClient,
  listClientGroupRules,
  replaceClientGroupRules,
  updateClient,
} from '../clients'
import { issueClientKey } from '../issue'
import { lockSubjects, mergeSubjects } from '../subjects'

const KEY_SCOPES: LensKeyScopes = {
  readKinds: [...ENTRY_KINDS],
  writeKinds: [...ENTRY_KINDS],
  maxSensitivity: 'private',
  allowedRealms: null,
  admin: false,
  credentials: 'none',
}

function makeDeps(db: Db): Deps {
  return {
    db,
    cookieSecure: false,
    masterKey: null,
    embedder: { get: async () => null } as never,
    jobs: null,
  }
}

async function seedUser(db: Db, username: string, displayName = username) {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ username, displayName, passwordHash: 'x' })
      .returning()
    const personal = await createPersonalCircle(tx, account!)
    return { account: account!, personal }
  })
}

function jsonPost(path: string, body: unknown, cookie?: string) {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

function extractSessionCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const matched = /kioku_session=[^;]+/.exec(raw)
  return matched ? matched[0] : ''
}

describe.skipIf(!testDatabaseUrl)('记忆圈配额、成员生命周期与接入实例', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('初始化与新建账号自动建唯一个人圈且不占共享圈配额，共享圈受配额限制', async () => {
    const deps = makeDeps(database.db)
    const app = router()
    app.route('/', setupRoutes(deps))
    app.route('/', authRoutes(deps))
    app.route('/', accountRoutes(deps))

    const setupRes = await app.request(
      jsonPost('/setup', {
        setupCode: 'ignored',
        username: 'admin',
        displayName: '管理员',
        password: 'correct horse battery',
        circleName: '初始化团队圈',
      }),
    )
    expect(setupRes.status).toBe(201)
    const adminCookie = extractSessionCookie(setupRes)
    const setupMe = await setupRes.json()
    expect(setupMe.personalCircleId).toBeTruthy()
    expect(setupMe.circles).toHaveLength(2)
    expect(setupMe.ownedSharedCircles).toBe(1)
    expect(setupMe.maxOwnedCircles).toBe(CIRCLE_LIMIT_DEFAULT)

    // 个人圈不计入共享圈配额：调整上限到 1 时管理员因已有一个共享圈而不可再新建
    await saveCircleLimit(database.db, { maxOwnedCircles: 1 })
    const limitView = await circleLimitView(database.db, setupMe.id)
    expect(limitView).toEqual({ maxOwnedCircles: 1, ownedCircles: 1, canCreate: false })

    const overRes = await createSharedCircle(database.db, {
      name: '第二个共享圈',
      ownerAccountId: setupMe.id,
    })
    expect(overRes).toEqual({ ok: false, reason: 'owner-limit', limit: 1 })

    // 管理员建新账号：新账号自动带个人圈，个人圈不占共享圈上限 1，因此新账号仍可新建 1 个共享圈
    const createRes = await app.request(
      jsonPost(
        '/instance/accounts',
        { username: 'bob', displayName: 'Bob', isAdmin: false },
        adminCookie,
      ),
    )
    expect(createRes.status).toBe(201)
    const createdAccount = await createRes.json()
    expect(createdAccount.account.circles).toHaveLength(1)
    expect(createdAccount.account.circles[0].kind).toBe('personal')

    const bobId = createdAccount.account.id as string
    const bobMe = await loadSessionUser(database.db, bobId)
    expect(bobMe?.ownedSharedCircles).toBe(0)

    // 并发创建共享圈：受咨询锁排队保护，只有 1 个成功、另一个被配额拦截
    const concurrent = await Promise.all([
      createSharedCircle(database.db, { name: 'Bob 圈一', ownerAccountId: bobId }),
      createSharedCircle(database.db, { name: 'Bob 圈二', ownerAccountId: bobId }),
    ])
    const okCount = concurrent.filter((r) => r.ok).length
    const limitCount = concurrent.filter((r) => !r.ok && r.reason === 'owner-limit').length
    expect(okCount).toBe(1)
    expect(limitCount).toBe(1)
  })

  it('个人圈禁止直接删除与增删改成员；共享圈支持成员邀请/改角色/30天离开与重进', async () => {
    const { account: alice, personal: alicePersonal } = await seedUser(database.db, 'alice')
    const { account: bob } = await seedUser(database.db, 'bob')

    expect(
      await deleteSharedCircle(database.db, {
        circleId: alicePersonal.id,
        actor: alice.id,
        admin: true,
        confirmName: alicePersonal.name,
      }),
    ).toEqual({ ok: false, reason: 'personal-circle' })
    expect(
      await addMember(database.db, {
        circleId: alicePersonal.id,
        actor: alice.id,
        username: 'bob',
        role: 'editor',
      }),
    ).toEqual({ ok: false, reason: 'personal-circle' })

    const renamedPersonal = await updateCircle(database.db, {
      circleId: alicePersonal.id,
      actor: alice.id,
      name: '我的个人小窝',
    })
    expect(renamedPersonal.ok).toBe(true)

    const created = await createSharedCircle(database.db, {
      name: '家庭圈',
      defaultFacets: { realm: ['home'] },
      ownerAccountId: alice.id,
    })
    if (!created.ok) throw new Error('建共享圈失败')
    const circleId = created.value.id

    // 添加 bob 为 editor，且为 bob 建接入实例与密钥
    const added = await addMember(database.db, {
      circleId,
      actor: alice.id,
      username: 'bob',
      role: 'editor',
    })
    expect(added.ok).toBe(true)

    await withCircle(database.db, circleId, async (tx) => {
      const cRes = await createClient(tx, {
        circleId,
        ownerAccountId: bob.id,
        slug: 'bob-phone',
        name: 'Bob手机',
        runtimeFamily: 'astrbot',
      })
      if (!cRes.ok) throw new Error('建接入实例失败')
      await issueClientKey(tx, {
        circleId,
        clientId: cRes.client.id,
        accountId: bob.id,
        name: '初始密钥',
        scopes: KEY_SCOPES,
      })
    })

    // 唯活跃所有者保护：alice 不可自降或自离
    expect(
      await updateMemberRole(database.db, {
        circleId,
        actor: alice.id,
        target: alice.id,
        role: 'editor',
      }),
    ).toEqual({ ok: false, reason: 'last-owner' })
    expect(
      await removeMember(database.db, { circleId, actor: alice.id, target: alice.id }),
    ).toEqual({ ok: false, reason: 'last-owner' })

    // 先将 bob 的 dreamPrivate 设为 false 再移除，验证记入 circle_departures 且立即吊销 bob 在该圈密钥
    await database.db
      .update(circleMembers)
      .set({ dreamPrivate: false })
      .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, bob.id)))

    expect(await removeMember(database.db, { circleId, actor: alice.id, target: bob.id })).toEqual({
      ok: true,
      value: null,
    })

    const [departure] = await database.db
      .select()
      .from(circleDepartures)
      .where(and(eq(circleDepartures.circleId, circleId), eq(circleDepartures.accountId, bob.id)))
    expect(departure?.dreamPrivate).toBe(false)

    const keysAfterRemoval = await database.db
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.circleId, circleId))
    expect(keysAfterRemoval[0]?.revokedAt).not.toBeNull()

    // 若清理已开始（purgeStartedAt 非空），禁止重新加入
    await database.db
      .update(circleDepartures)
      .set({ purgeStartedAt: new Date() })
      .where(and(eq(circleDepartures.circleId, circleId), eq(circleDepartures.accountId, bob.id)))
    expect(
      await addMember(database.db, {
        circleId,
        actor: alice.id,
        username: 'bob',
        role: 'editor',
      }),
    ).toEqual({ ok: false, reason: 'departure-purging' })

    // 清理尚未开始时重新加入，恢复原 dreamPrivate 设置并清除离开记录
    await database.db
      .update(circleDepartures)
      .set({ purgeStartedAt: null })
      .where(and(eq(circleDepartures.circleId, circleId), eq(circleDepartures.accountId, bob.id)))
    const rejoined = await addMember(database.db, {
      circleId,
      actor: alice.id,
      username: 'bob',
      role: 'editor',
    })
    expect(rejoined.ok).toBe(true)

    const [restoredMember] = await database.db
      .select({ dreamPrivate: circleMembers.dreamPrivate })
      .from(circleMembers)
      .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, bob.id)))
    expect(restoredMember?.dreamPrivate).toBe(false)

    // 转让所有者：bob 成为 owner，alice 降为 editor
    const transferred = await transferOwnership(database.db, {
      circleId,
      actor: alice.id,
      target: bob.id,
    })
    expect(transferred.ok).toBe(true)
    const members = await listMembers(database.db, circleId)
    expect(members.find((m) => m.accountId === bob.id)?.role).toBe('owner')
    expect(members.find((m) => m.accountId === alice.id)?.role).toBe('editor')
  })

  it('接入实例转让所有者时吊销密钥并剥离 prompts.guidance；群对象合并时单群隔离锁取逻辑或（OR）', async () => {
    const { account: alice } = await seedUser(database.db, 'alice')
    const { account: bob } = await seedUser(database.db, 'bob')

    const shared = await createSharedCircle(database.db, {
      name: '机器人社交圈',
      ownerAccountId: alice.id,
    })
    if (!shared.ok) throw new Error('建圈失败')
    const circleId = shared.value.id

    await addMember(database.db, { circleId, actor: alice.id, username: 'bob', role: 'editor' })

    await withCircle(database.db, circleId, async (tx) => {
      const [p1] = await tx
        .insert(personas)
        .values({ circleId, slug: 'cool', name: '冷静版' })
        .returning()

      const cRes = await createClient(tx, {
        circleId,
        ownerAccountId: alice.id,
        slug: 'qq-bot',
        name: 'QQ机器人',
        runtimeFamily: 'astrbot',
        config: {
          personMemoryMode: 'persona_shared',
          advanced: {
            'recall.limit': 12,
            'prompts.guidance': '私有指引必须剥离',
          },
        } as never,
      })
      if (!cRes.ok) throw new Error('建接入实例失败')
      const clientId = cRes.client.id

      await issueClientKey(tx, {
        circleId,
        clientId,
        accountId: alice.id,
        name: '待吊销',
        scopes: KEY_SCOPES,
      })

      // 转让所有权给 bob：密钥应全被吊销，prompts.guidance 剥离而 recall.limit 保留
      const upd = await updateClient(tx, {
        circleId,
        clientId,
        ownerAccountId: bob.id,
      })
      expect(upd.ok).toBe(true)

      const [clientRow] = await tx.select().from(clients).where(eq(clients.id, clientId))
      const storedAdv = (clientRow?.config as Record<string, Record<string, unknown>>).advanced
      expect(storedAdv?.['prompts.guidance']).toBeUndefined()
      expect(storedAdv?.['recall.limit']).toBe(12)

      const keysAfterTransfer = await tx
        .select({ revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.clientId, clientId))
      expect(keysAfterTransfer[0]?.revokedAt).not.toBeNull()

      // 验证合并两个群对象：groupFrom（开启单群强隔离锁）并入 groupInto（未开启锁、有按群人格）
      const [groupFrom] = await tx
        .insert(subjects)
        .values({ circleId, kind: 'group', displayName: '隐私群' })
        .returning()
      const [groupInto] = await tx
        .insert(subjects)
        .values({ circleId, kind: 'group', displayName: '普通群' })
        .returning()

      await replaceClientGroupRules(tx, circleId, clientId, [
        { groupSubjectId: groupFrom!.id, personaId: null, isolateGroupMemory: true },
        { groupSubjectId: groupInto!.id, personaId: p1!.id, isolateGroupMemory: false },
      ])

      const locked = await lockSubjects(tx, [groupFrom!.id, groupInto!.id])
      const fromRow = locked.find((r) => r.id === groupFrom!.id)!
      const intoRow = locked.find((r) => r.id === groupInto!.id)!
      await mergeSubjects(tx, fromRow, intoRow)

      const rulesAfter = await listClientGroupRules(tx, circleId, clientId)
      expect(rulesAfter).toEqual([
        {
          groupSubjectId: groupInto!.id,
          personaId: p1!.id,
          isolateGroupMemory: true,
          groupName: '普通群',
        },
      ])

      const leftover = await tx
        .select()
        .from(clientGroupRules)
        .where(eq(clientGroupRules.groupSubjectId, groupFrom!.id))
      expect(leftover).toEqual([])
    })
  })
})
