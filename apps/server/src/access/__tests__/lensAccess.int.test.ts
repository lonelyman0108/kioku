import { DEVICE_KEY_DENIALS, ENTRY_KINDS, type LensKeyScopes } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { principalOf, requireKey } from '../../auth/middleware'
import { createSession, SESSION_COOKIE } from '../../auth/session'
import { withCircle, type Database, type Db } from '../../db/client'
import {
  accounts,
  clientGroupRules,
  conversations,
  facetTerms,
  personas,
  subjectIdentities,
  subjects,
} from '../../db/schema'
import type { Deps } from '../../http/env'
import { router } from '../../http/openapi'
import { deviceRoutes } from '../../routes/device'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { canRead, credentialDenial } from '../access'
import { issueCode, normalizeCode, redeemCode } from '../binding'
import {
  addMember,
  createPersonalCircle,
  createSharedCircle,
  removeMember,
  updateMemberRole,
} from '../circles'
import { createClient, replaceClientGroupRules } from '../clients'
import { ensureConversation } from '../conversations'
import { buildKeyInfos, issueClientKey, rotateClientKey } from '../issue'
import { accessForKey, resolveKeySession } from '../session'

const FULL_LENS_SCOPES: LensKeyScopes = {
  readKinds: [...ENTRY_KINDS],
  writeKinds: [...ENTRY_KINDS],
  maxSensitivity: 'secret',
  allowedRealms: ['work'],
  admin: false,
  credentials: 'manage',
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

async function seedAccount(db: Db, username: string) {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ username, displayName: username, passwordHash: 'x' })
      .returning()
    const personal = await createPersonalCircle(tx, account!)
    return { account: account!, personal }
  })
}

describe.skipIf(!testDatabaseUrl)('透镜密钥鉴权、无缝轮换与设备授权联动', () => {
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

  it('密钥鉴权解析多圈角色收紧、facet_terms 静态蕴含场域锁与无缝密钥轮换（不丢群规则/会话/绑定码）', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const { account: bob } = await seedAccount(database.db, 'bob')

    const workRes = await createSharedCircle(database.db, {
      name: '工作圈',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    const homeRes = await createSharedCircle(database.db, {
      name: '家庭圈',
      defaultFacets: { realm: ['home'] },
      ownerAccountId: bob.id,
    })
    if (!workRes.ok || !homeRes.ok) throw new Error('建记忆圈失败')
    const workId = workRes.value.id
    const homeId = homeRes.value.id

    await addMember(database.db, {
      circleId: homeId,
      actor: bob.id,
      username: 'alice',
      role: 'editor',
    })

    const deps = makeDeps(database.db)
    const keyApp = router()
    keyApp.use('/probe', requireKey(deps))
    keyApp.get('/probe', (c) => {
      const k = c.get('key')
      return c.json({
        keyId: k.keyId,
        circleId: k.circleId,
        staticRealms: [...k.staticContextRealms],
        grants: k.circleGrants,
      })
    })

    // 建工作圈切面词表、人格、接入实例与按群规则，并签发带双客场圈和 contextFacets 的密钥
    const setup = await withCircle(database.db, workId, async (tx) => {
      await tx.insert(facetTerms).values([
        {
          circleId: workId,
          dimensionKey: 'env',
          slug: 'office-pc',
          label: '公司电脑',
          implies: { env: ['win'], realm: ['work'] },
        },
        {
          circleId: workId,
          dimensionKey: 'env',
          slug: 'win',
          label: 'Windows',
          implies: {},
        },
      ])
      const [persona] = await tx
        .insert(personas)
        .values({ circleId: workId, slug: 'work-bot', name: '职场助手机' })
        .returning()
      const cRes = await createClient(tx, {
        circleId: workId,
        ownerAccountId: alice.id,
        slug: 'coding-cli',
        name: '公司电脑代理',
        runtimeFamily: 'claudecode',
        config: { personMemoryMode: 'persona_shared', elevateOwnerDirect: 'internal' },
      })
      if (!cRes.ok) throw new Error('建接入实例失败')
      const client = cRes.client

      const [group1] = await tx
        .insert(subjects)
        .values({ circleId: workId, kind: 'group', displayName: '项目群' })
        .returning()
      const [sender1] = await tx
        .insert(subjects)
        .values({ circleId: workId, kind: 'person', displayName: '同事甲' })
        .returning()
      await tx.insert(subjectIdentities).values({
        circleId: workId,
        subjectId: sender1!.id,
        kind: 'person',
        platform: 'qq',
        externalId: '10001',
        displayName: '同事甲',
      })

      await replaceClientGroupRules(tx, workId, client.id, [
        { groupSubjectId: group1!.id, personaId: persona!.id, isolateGroupMemory: true },
      ])
      const convId = await ensureConversation(tx, workId, client.id, {
        kind: 'none',
        ownerAccountId: alice.id,
        deviceKey: 'win-box',
        projectSlug: 'kioku',
      })

      const issued = await issueClientKey(tx, {
        circleId: workId,
        clientId: client.id,
        accountId: alice.id,
        name: '公司主密钥',
        linkedCircles: [
          { circleId: personal.id, mode: 'read' },
          { circleId: homeId, mode: 'read_write' },
        ],
        contextFacets: { env: ['office-pc'] },
        scopes: FULL_LENS_SCOPES,
      })
      if (!issued.ok) throw new Error('签发密钥失败')
      return { client, groupId: group1!.id, senderId: sender1!.id, convId, issued }
    })

    // 校验 bearer 鉴权与展开后的静态场域 + 多圈授权矩阵
    const okRes = await keyApp.request(
      new Request('http://127.0.0.1/probe', {
        headers: { authorization: `Bearer ${setup.issued.plaintext}` },
      }),
    )
    expect(okRes.status).toBe(200)
    const probe = (await okRes.json()) as { staticRealms: string[]; grants: unknown[] }
    expect(probe.staticRealms).toEqual(['work'])
    expect(probe.grants).toHaveLength(3)

    // 校验静态场域锁与客场凭据 404
    const principal = (await principalOf(database.db, setup.issued.row))!
    const access = accessForKey(principal)
    expect(
      credentialDenial(
        access,
        { circleId: workId, clientIds: null, allowedRealms: ['home'] },
        'use',
      ),
    ).toBe('realm')
    expect(
      credentialDenial(
        access,
        { circleId: personal.id, clientIds: null, allowedRealms: ['work'] },
        'use',
      ),
    ).toBe('circle')
    expect(
      canRead(
        access,
        {
          circleId: workId,
          kind: 'entry',
          sensitivity: 'secret',
          originScope: 'global',
          clientId: null,
          ownerAccountId: null,
          subjectKind: null,
          realms: ['home'],
          validTo: null,
          expiresAt: null,
          deletedAt: null,
        },
        { explicit: true },
      ),
    ).toBe(false)

    // 在轮换前由旧密钥发出绑定码
    const sessionForCode = {
      context: {
        chatType: 'direct' as const,
        senderSubjectId: setup.senderId,
        senderIsOwner: false,
      },
      personaId: null,
      subjects: [],
    }
    const issuedBind = await issueCode(database.db, null, principal, sessionForCode, 'qq', '10001')
    expect(issuedBind).not.toBeNull()

    // 客场角色被降为 viewer 时，仅家庭客场收敛为只读，工作主场仍正常工作
    await updateMemberRole(database.db, {
      circleId: homeId,
      actor: bob.id,
      target: alice.id,
      role: 'viewer',
    })
    const afterDowngrade = (await principalOf(database.db, setup.issued.row))!
    expect(afterDowngrade.circleGrants.find((g) => g.circleId === homeId)).toMatchObject({
      mode: 'read',
      writeKinds: [],
      active: true,
    })

    // 执行无缝密钥轮换：旧密钥失效，新密钥继承同 clientId、群规则、会话与生效中的绑定码
    const rotated = await withCircle(database.db, workId, (tx) =>
      rotateClientKey(tx, {
        circleId: workId,
        clientId: setup.client.id,
        keyId: setup.issued.row.id,
        accountId: alice.id,
        name: '轮换后的新密钥',
      }),
    )
    if (!rotated.ok) throw new Error('轮换失败')

    const oldAfterRotate = await keyApp.request(
      new Request('http://127.0.0.1/probe', {
        headers: { authorization: `Bearer ${setup.issued.plaintext}` },
      }),
    )
    expect(oldAfterRotate.status).toBe(401)

    const newRes = await keyApp.request(
      new Request('http://127.0.0.1/probe', {
        headers: { authorization: `Bearer ${rotated.plaintext}` },
      }),
    )
    expect(newRes.status).toBe(200)

    const [rulesLeft, convsLeft] = await withCircle(database.db, workId, (tx) =>
      Promise.all([
        tx.select().from(clientGroupRules).where(eq(clientGroupRules.clientId, setup.client.id)),
        tx.select().from(conversations).where(eq(conversations.id, setup.convId)),
      ]),
    )
    expect(rulesLeft).toHaveLength(1)
    expect(convsLeft).toHaveLength(1)

    // 用新密钥代表另一私聊对象兑换旧密钥签发的绑定码 -> 照常合并
    const newPrincipal = (await principalOf(database.db, rotated.row))!
    const otherSession = await resolveKeySession(deps, newPrincipal, {
      chatType: 'direct',
      platform: 'qq',
      sender: { id: '20002', name: '同事甲微信' },
    })
    const normalized = normalizeCode(issuedBind!.code)!
    const previewRes = await redeemCode(
      database.db,
      null,
      newPrincipal,
      otherSession,
      normalized,
      { platform: 'qq', externalId: '20002', displayName: '同事甲微信' },
      true,
    )
    expect(previewRes.kind).toBe('preview')
    const mergedRes = await redeemCode(
      database.db,
      null,
      newPrincipal,
      otherSession,
      normalized,
      { platform: 'qq', externalId: '20002', displayName: '同事甲微信' },
      true,
    )
    expect(mergedRes.kind).toBe('merged')

    // 若从关联客场移除再加回，原密钥自动剥离该客场但主场仍有效；离开主场则整把密钥失效
    await removeMember(database.db, { circleId: homeId, actor: bob.id, target: alice.id })
    await addMember(database.db, {
      circleId: homeId,
      actor: bob.id,
      username: 'alice',
      role: 'editor',
    })
    const homeStripped = (await principalOf(database.db, rotated.row))!
    expect(homeStripped.circleGrants.find((g) => g.circleId === homeId)?.active).toBe(false)
    expect(homeStripped.circleGrants[0]?.active).toBe(true)

    const infos = await withCircle(database.db, workId, (tx) =>
      buildKeyInfos(tx, workId, alice.id, [rotated.row]),
    )
    expect(infos[0]!.circleGrants.find((g) => g.circleId === homeId)?.active).toBe(false)

    // 主场离开后新密钥彻底失效（需先加上 bob 为 work owner 才允许 alice 离开）
    await addMember(database.db, {
      circleId: workId,
      actor: alice.id,
      username: 'bob',
      role: 'owner',
    })
    await removeMember(database.db, { circleId: workId, actor: bob.id, target: alice.id })
    expect(await principalOf(database.db, rotated.row)).toBeNull()
  })

  it('浏览器设备授权与取走复核：linkedCircles 失权时以 DEVICE_KEY_DENIALS.linked 拒绝签发', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const { account: bob } = await seedAccount(database.db, 'bob')

    const workRes = await createSharedCircle(database.db, {
      name: '工作圈',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    const homeRes = await createSharedCircle(database.db, {
      name: '家庭圈',
      ownerAccountId: bob.id,
    })
    if (!workRes.ok || !homeRes.ok) throw new Error('建圈失败')
    const workId = workRes.value.id
    const homeId = homeRes.value.id

    await addMember(database.db, {
      circleId: homeId,
      actor: bob.id,
      username: 'alice',
      role: 'editor',
    })

    const deps = makeDeps(database.db)
    const app = router()
    app.route('/', deviceRoutes(deps))
    const sessionToken = await createSession(database.db, alice.id)
    const cookie = `${SESSION_COOKIE}=${sessionToken}`

    const startGrant = async () => {
      const res = await app.request(
        new Request('http://127.0.0.1/device/authorize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            platforms: [{ runtimeFamily: 'claudecode', clientName: '公司电脑' }],
          }),
        }),
      )
      expect(res.status).toBe(201)
      return (await res.json()) as { deviceCode: string; userCode: string }
    }

    // 场景 A：完整批准并成功取走透镜密钥
    const g1 = await startGrant()
    const approve1 = await app.request(
      new Request('http://127.0.0.1/device/grants/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          userCode: g1.userCode,
          circleId: workId,
          linkedCircles: [
            { circleId: personal.id, mode: 'read' },
            { circleId: homeId, mode: 'read_write' },
          ],
          contextFacets: { env: ['office-pc'] },
          items: [
            {
              runtimeFamily: 'claudecode',
              client: { slug: 'win-cc', name: '公司CC' },
              keyName: '公司钥匙',
              scopes: FULL_LENS_SCOPES,
            },
          ],
        }),
      }),
    )
    expect(approve1.status).toBe(200)

    const tok1 = await app.request(
      new Request('http://127.0.0.1/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: g1.deviceCode }),
      }),
    )
    expect(tok1.status).toBe(200)
    const body1 = (await tok1.json()) as { status: string; keys: Array<{ status: string }> }
    expect(body1.status).toBe('approved')
    expect(body1.keys[0]?.status).toBe('issued')

    // 场景 B：确认后在取走前将确认人在客场家庭圈降级为 viewer，取走 read_write 客场授权应被 DEVICE_KEY_DENIALS.linked 拒绝
    const g2 = await startGrant()
    const approve2 = await app.request(
      new Request('http://127.0.0.1/device/grants/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          userCode: g2.userCode,
          circleId: workId,
          linkedCircles: [{ circleId: homeId, mode: 'read_write' }],
          contextFacets: {},
          items: [
            {
              runtimeFamily: 'claudecode',
              client: { slug: 'win-cc-2', name: '公司CC2' },
              keyName: '公司钥匙2',
              scopes: FULL_LENS_SCOPES,
            },
          ],
        }),
      }),
    )
    expect(approve2.status).toBe(200)

    await updateMemberRole(database.db, {
      circleId: homeId,
      actor: bob.id,
      target: alice.id,
      role: 'viewer',
    })

    const tok2 = await app.request(
      new Request('http://127.0.0.1/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: g2.deviceCode }),
      }),
    )
    expect(tok2.status).toBe(200)
    const body2 = (await tok2.json()) as { status: string; keys: Array<Record<string, unknown>> }
    expect(body2.status).toBe('approved')
    expect(body2.keys[0]).toEqual({
      runtimeFamily: 'claudecode',
      status: 'denied',
      reason: DEVICE_KEY_DENIALS.linked,
    })
  })

  it('resolveKeySession 在同圈双机器人、单群锁与本人私聊标记下的会话解析与白名单构建', async () => {
    const { account: alice } = await seedAccount(database.db, 'alice')
    const socialRes = await createSharedCircle(database.db, {
      name: '社交圈',
      ownerAccountId: alice.id,
    })
    if (!socialRes.ok) throw new Error('建圈失败')
    const socialId = socialRes.value.id

    const deps = makeDeps(database.db)
    const { bot1Key, bot2GroupId, unlockedGroupId, lockedGroupId } = await withCircle(
      database.db,
      socialId,
      async (tx) => {
        const b1 = await createClient(tx, {
          circleId: socialId,
          ownerAccountId: alice.id,
          slug: 'bot-1',
          name: '一号机器人',
          runtimeFamily: 'astrbot',
          config: { personMemoryMode: 'persona_shared', elevateOwnerDirect: 'internal' },
        })
        const b2 = await createClient(tx, {
          circleId: socialId,
          ownerAccountId: alice.id,
          slug: 'bot-2',
          name: '二号机器人',
          runtimeFamily: 'astrbot',
          config: { personMemoryMode: 'persona_shared' },
        })
        if (!b1.ok || !b2.ok) throw new Error('建机器人失败')

        const [gOpen, gLocked, gOtherBot, ownerSub] = await tx
          .insert(subjects)
          .values([
            { circleId: socialId, kind: 'group', displayName: '开放群' },
            { circleId: socialId, kind: 'group', displayName: '保密群' },
            { circleId: socialId, kind: 'group', displayName: '二号群' },
            { circleId: socialId, kind: 'person', displayName: '主人', accountId: alice.id },
          ])
          .returning()

        await tx.insert(subjectIdentities).values([
          {
            circleId: socialId,
            subjectId: gOpen!.id,
            kind: 'group',
            platform: 'qq',
            externalId: 'g-open',
            displayName: '开放群',
          },
          {
            circleId: socialId,
            subjectId: gLocked!.id,
            kind: 'group',
            platform: 'qq',
            externalId: 'g-locked',
            displayName: '保密群',
          },
          {
            circleId: socialId,
            subjectId: ownerSub!.id,
            kind: 'person',
            platform: 'qq',
            externalId: 'u-alice',
            displayName: 'Alice',
          },
        ])

        await replaceClientGroupRules(tx, socialId, b1.client.id, [
          { groupSubjectId: gLocked!.id, personaId: null, isolateGroupMemory: true },
        ])
        await ensureConversation(tx, socialId, b1.client.id, {
          kind: 'group',
          subjectId: gOpen!.id,
        })
        await ensureConversation(tx, socialId, b1.client.id, {
          kind: 'group',
          subjectId: gLocked!.id,
        })
        await ensureConversation(tx, socialId, b2.client.id, {
          kind: 'group',
          subjectId: gOtherBot!.id,
        })

        const k1 = await issueClientKey(tx, {
          circleId: socialId,
          clientId: b1.client.id,
          accountId: alice.id,
          name: '一号密钥',
          scopes: FULL_LENS_SCOPES,
        })
        if (!k1.ok) throw new Error('签发失败')
        return {
          bot1Key: k1.row,
          bot2GroupId: gOtherBot!.id,
          unlockedGroupId: gOpen!.id,
          lockedGroupId: gLocked!.id,
        }
      },
    )

    const p1 = (await principalOf(database.db, bot1Key))!

    // 进入未加锁新群聊：sharedGroupScopes 应包含开放群，绝不包含保密群及二号机器人的群
    const sessionOpen = await resolveKeySession(deps, p1, {
      chatType: 'group',
      platform: 'qq',
      group: { id: 'g-third', name: '第三个群' },
      sender: { id: 'u-alice', name: 'Alice' },
    })
    expect(sessionOpen.context.sharedGroupScopes).toEqual([`group:${unlockedGroupId}`])
    expect(sessionOpen.context.sharedGroupScopes).not.toContain(`group:${bot2GroupId}`)
    expect(sessionOpen.context.lockedGroupScopes).toEqual([`group:${lockedGroupId}`])

    // 进入保密群：currentGroupIsolated 为 true，sharedGroupScopes 为空
    const sessionLocked = await resolveKeySession(deps, p1, {
      chatType: 'group',
      platform: 'qq',
      group: { id: 'g-locked', name: '保密群' },
    })
    expect(sessionLocked.context.currentGroupIsolated).toBe(true)
    expect(sessionLocked.context.sharedGroupScopes).toEqual([])

    // 主人私聊：识别 senderIsOwner = true
    const sessionOwnerDirect = await resolveKeySession(deps, p1, {
      chatType: 'direct',
      platform: 'qq',
      sender: { id: 'u-alice', name: 'Alice' },
    })
    expect(sessionOwnerDirect.context.senderIsOwner).toBe(true)
    expect(sessionOwnerDirect.context.sharedGroupScopes).toEqual([`group:${unlockedGroupId}`])
  })
})
