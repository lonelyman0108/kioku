import { ENTRY_KINDS, type LensKeyScopes } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPersonalCircle, createSharedCircle } from '../../access/circles'
import { createClient } from '../../access/clients'
import { issueClientKey } from '../../access/issue'
import { accessForKey, resolveKeySession } from '../../access/session'
import { principalForKeyId } from '../../auth/middleware'
import { withCircle, withCircles, type Database, type Db } from '../../db/client'
import { accounts, entries, entryLinks, entryVariants, subjects } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { entryServiceForConsole, entryServiceForKey } from '../entryContext'
import {
  expandOneHopNeighbors,
  resolveEntryNeighbors,
  resolveReadableLinkTitles,
  syncEntryLinks,
} from '../links'

const ALL_SCOPES: LensKeyScopes = {
  readKinds: [...ENTRY_KINDS],
  writeKinds: [...ENTRY_KINDS],
  maxSensitivity: 'secret',
  allowedRealms: null,
  admin: false,
  credentials: 'none',
}

function makeDeps(db: Db): Deps {
  return {
    db,
    cookieSecure: false,
    masterKey: Buffer.alloc(32, 7),
    embedder: staticEmbedderSource(null),
    jobs: null,
  }
}

async function seedAccount(db: Db, username: string) {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ username, displayName: username, passwordHash: 'hash' })
      .returning()
    const personal = await createPersonalCircle(tx, account!)
    return { account: account!, personal }
  })
}

describe.skipIf(!testDatabaseUrl)('双链索引、权限过滤、待确认联动与 1 跳安全扩散', () => {
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

  it('维护双向 1 跳边、跳过 secret/untrusted 并随 confirm 激活、保留悬空与软删除边、且在受限对话中隐藏客场圈名', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const workRes = await createSharedCircle(database.db, {
      name: '研发圈',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    if (!workRes.ok) throw new Error('建圈失败')
    const workId = workRes.value.id
    const deps = makeDeps(database.db)

    const { client, keyId } = await withCircle(database.db, personal.id, async (tx) => {
      const cRes = await createClient(tx, {
        circleId: personal.id,
        ownerAccountId: alice.id,
        slug: 'chat-bot',
        name: '聊天助手机',
        runtimeFamily: 'astrbot',
        config: { personMemoryMode: 'strict' },
      })
      if (!cRes.ok) throw new Error('建实例失败')
      const kRes = await issueClientKey(tx, {
        circleId: personal.id,
        clientId: cRes.client.id,
        accountId: alice.id,
        name: 'main-key',
        scopes: ALL_SCOPES,
        linkedCircles: [{ circleId: workId, mode: 'read_write' }],
      })
      if (!kRes.ok) throw new Error('签发失败')
      return { client: cRes.client, keyId: kRes.row.id }
    })

    const principal = await principalForKeyId(database.db, keyId)
    if (!principal) throw new Error('未加载密钥')
    const keySvc = entryServiceForKey(deps, principal)

    // 1. 客场创建目标节点，主场创建带别名与悬空目标的节点
    const workTarget = await keySvc.create({
      circle: workRes.value.slug,
      title: '研发部署手册',
      content: '线上发布步骤如下。',
      sensitivity: 'public',
    })
    const homeSource = await keySvc.create({
      title: '总览索引',
      content: `请先看 [[${workTarget.shortId}|发布步骤]]，以及尚未创建的 [[m-999999|未来计划]]。`,
    })
    expect(homeSource.links).toEqual([
      {
        shortId: workTarget.shortId,
        title: '研发部署手册',
        circleId: workId,
        circleSlug: workRes.value.slug,
        kind: 'entry',
        sensitivity: 'public',
        direction: 'outgoing',
        sourceVariantId: homeSource.variants[0]!.id,
      },
    ])

    // 反向入链同样可查
    const backFromTarget = await keySvc.get({ id: workTarget.shortId })
    expect(backFromTarget.links).toEqual([
      {
        shortId: homeSource.shortId,
        title: '总览索引',
        circleId: personal.id,
        circleSlug: personal.slug,
        kind: 'entry',
        sensitivity: 'private',
        direction: 'incoming',
        sourceVariantId: homeSource.variants[0]!.id,
      },
    ])

    // 2. 悬空边 m-999999 仍保留在 entry_links 中
    const storedLinks = await withCircle(database.db, personal.id, (tx) =>
      tx.select().from(entryLinks).where(eq(entryLinks.sourceEntryId, homeSource.id)),
    )
    expect(storedLinks.map((l) => l.targetShortId).sort()).toEqual(
      ['m-999999', workTarget.shortId].sort(),
    )

    // 3. 软删除目标后对外部隐藏邻居但保留边；恢复目标后邻居立即重现
    const consoleWork = await entryServiceForConsole(deps, workId, alice.id)
    await consoleWork.remove({ id: workTarget.shortId })
    const afterSoftDel = await keySvc.get({ id: homeSource.shortId })
    expect(afterSoftDel.links).toEqual([])
    const linksStillStored = await withCircle(database.db, personal.id, (tx) =>
      tx.select().from(entryLinks).where(eq(entryLinks.sourceEntryId, homeSource.id)),
    )
    expect(linksStillStored.some((l) => l.targetShortId === workTarget.shortId)).toBe(true)

    await consoleWork.undelete({ entryId: workTarget.id })
    const afterUndelete = await keySvc.get({ id: homeSource.shortId })
    expect(afterUndelete.links.map((l) => l.shortId)).toEqual([workTarget.shortId])

    // 4. untrusted 来源记录不生成出链；review confirm 后同步激活出链；secret 不生成出链
    const untrustedRow = await withCircle(database.db, personal.id, async (tx) => {
      const [sub] = await tx
        .insert(subjects)
        .values({ circleId: personal.id, kind: 'person', displayName: '张三' })
        .returning()
      const [e] = await tx
        .insert(entries)
        .values({
          circleId: personal.id,
          shortId: 'm-222233',
          circleKind: 'personal',
          kind: 'fact',
          ownerAccountId: null,
          clientId: client.id,
          subjectId: sub!.id,
          subjectKind: 'person',
          provenance: 'untrusted',
          originScope: 'group:test-group',
          title: '张三偏好',
          sensitivity: 'internal',
          priority: 2,
        })
        .returning()
      const [v] = await tx
        .insert(entryVariants)
        .values({
          circleId: personal.id,
          entryId: e!.id,
          kind: 'fact',
          sensitivity: 'internal',
          when: {},
          whenSignature: '{}',
          sortOrder: 0,
          content: `提到 [[${homeSource.shortId}]]`,
          searchHeader: '张三偏好',
        })
        .returning()
      await syncEntryLinks(tx, {
        circleId: personal.id,
        entryId: e!.id,
        shortId: e!.shortId,
        sensitivity: e!.sensitivity,
        provenance: e!.provenance,
        variants: [{ id: v!.id, content: v!.content }],
      })
      return e!
    })

    expect(
      await withCircle(database.db, personal.id, (tx) =>
        tx.select().from(entryLinks).where(eq(entryLinks.sourceEntryId, untrustedRow.id)),
      ),
    ).toHaveLength(0)

    const consolePersonal = await entryServiceForConsole(deps, personal.id, alice.id)
    await consolePersonal.review({
      action: 'confirm',
      items: [{ id: untrustedRow.id, version: untrustedRow.version }],
    })
    expect(
      await withCircle(database.db, personal.id, (tx) =>
        tx.select().from(entryLinks).where(eq(entryLinks.sourceEntryId, untrustedRow.id)),
      ),
    ).toHaveLength(1)

    // 5. 受限群聊对话上下文下解析客场标题与 1 跳扩散：隐藏客场 circleSlug
    const groupSession = await resolveKeySession(deps, principal, {
      chatType: 'group',
      platform: 'qq',
      group: { id: 'g-100', name: '测试群' },
      sender: { id: 'u-200', name: '甲' },
    })
    const restrictedAccess = accessForKey(principal, groupSession)
    await withCircles(
      database.db,
      { read: [...restrictedAccess.circles.keys()] },
      async (tx, now) => {
        const titles = await resolveReadableLinkTitles(
          tx,
          restrictedAccess,
          [homeSource.shortId, workTarget.shortId],
          now,
        )
        // 主场 private 在群聊上下文不可读，不出现在 titles
        expect(titles.has(homeSource.shortId)).toBe(false)
        // 客场 public 可读，但隐藏客场 circleSlug
        expect(titles.get(workTarget.shortId)).toEqual({
          title: '研发部署手册',
          circleId: workId,
          circleSlug: null,
        })

        // 1 跳邻居扩散不泄露不可读目标
        const neighbors = await expandOneHopNeighbors(
          tx,
          restrictedAccess,
          [
            {
              entryId: workTarget.id,
              shortId: workTarget.shortId,
              activeVariantIds: [workTarget.variants[0]!.id],
              score: 1,
            },
          ],
          { now },
        )
        expect(neighbors).toEqual([])

        // 而在非受限密钥（no chat context）下，1 跳邻居可顺畅扩散
        const fullAccess = accessForKey(principal)
        const homeNeighbors = await resolveEntryNeighbors(tx, fullAccess, homeSource, { now })
        expect(
          homeNeighbors.some(
            (n) => n.shortId === workTarget.shortId && n.circleSlug === workRes.value.slug,
          ),
        ).toBe(true)
        const hops = await expandOneHopNeighbors(
          tx,
          fullAccess,
          [
            {
              entryId: homeSource.id,
              shortId: homeSource.shortId,
              activeVariantIds: [homeSource.variants[0]!.id],
              score: 1,
            },
          ],
          { now },
        )
        expect(hops.some((h) => h.shortId === workTarget.shortId)).toBe(true)
      },
      { accessMode: 'read only' },
    )

    // protect 为 secret 后清除已有明文出链
    await consolePersonal.protect({
      entryId: homeSource.id,
      expectedVersion: homeSource.version,
      target: 'secret',
    })
    expect(
      await withCircle(database.db, personal.id, (tx) =>
        tx.select().from(entryLinks).where(eq(entryLinks.sourceEntryId, homeSource.id)),
      ),
    ).toHaveLength(0)
  })
})
