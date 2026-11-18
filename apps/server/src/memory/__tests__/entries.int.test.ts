import { randomBytes } from 'node:crypto'

import { ENTRY_KINDS, SHORT_ID_PATTERN, type LensKeyScopes } from '@kioku/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { consoleAccess } from '../../access/access'
import { createPersonalCircle, createSharedCircle } from '../../access/circles'
import { createClient } from '../../access/clients'
import { issueClientKey } from '../../access/issue'
import { principalForKeyId } from '../../auth/middleware'
import { credentialServiceForConsole, credentialServiceForKey } from '../../credential/context'
import { masterKeyStatus, prepareMasterKey, rotateMasterKey } from '../../crypto/rotation'
import { withCircle, type Database, type Db } from '../../db/client'
import {
  accounts,
  entries,
  entryCredentialRefs,
  entryEvents,
  entryVariants,
  legacyUris,
} from '../../db/schema'
import type { Deps } from '../../http/env'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { entryServiceForConsole, entryServiceForKey } from '../entryContext'
import { ACCESS_EVENT, MemoryError, openVariantContent } from '../service'

const ALL_SCOPES: LensKeyScopes = {
  readKinds: [...ENTRY_KINDS],
  writeKinds: [...ENTRY_KINDS],
  maxSensitivity: 'secret',
  allowedRealms: null,
  admin: false,
  credentials: 'manage',
}

function makeDeps(
  db: Db,
  masterKey: Buffer | { current: Buffer; previous: Buffer | null } | null,
): Deps {
  return {
    db,
    cookieSecure: false,
    masterKey,
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

async function issuePrincipal(
  db: Db,
  circleId: string,
  ownerId: string,
  slug: string,
  scopes: LensKeyScopes = ALL_SCOPES,
  contextFacets: Record<string, string[]> = {},
  linkedCircles: { circleId: string; mode: 'read' | 'read_write' }[] = [],
) {
  const res = await withCircle(db, circleId, async (tx) => {
    const cRes = await createClient(tx, {
      circleId,
      ownerAccountId: ownerId,
      slug,
      name: slug,
      runtimeFamily: 'claudecode',
      config: { personMemoryMode: 'strict' },
    })
    if (!cRes.ok) throw new Error('创建接入实例失败')
    const kRes = await issueClientKey(tx, {
      circleId,
      clientId: cRes.client.id,
      accountId: ownerId,
      name: `${slug}-key`,
      scopes,
      contextFacets,
      linkedCircles,
    })
    if (!kRes.ok) throw new Error('签发密钥失败')
    return { client: cRes.client, keyId: kRes.row.id }
  })
  const principal = await principalForKeyId(db, res.keyId)
  if (!principal) throw new Error('无法加载密钥主体')
  return { client: res.client, principal }
}

describe.skipIf(!testDatabaseUrl)('词条多变体 CRUD、机密防旁路、凭据转存与跨圈迁移', () => {
  let database: Database
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('支持单切片简写、多变体增量增删改、遗留地址与标题兜底查询、以及按切面/主题动态浏览', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const deps = makeDeps(database.db, masterKey)
    const { principal } = await issuePrincipal(database.db, personal.id, alice.id, 'cli-main')
    const svc = entryServiceForKey(deps, principal)

    // 单卡片写入自动生成短 ID 并从正文一级标题推导词条标题
    const single = await svc.create({
      content: '# 网关端口规则\n\n内网入口使用 8080 端口。',
      when: { env: ['home-mac'] },
      topics: ['Network', 'Gateway'],
      priority: 1,
      glossary: ['内网入口'],
    })
    expect(single.shortId).toMatch(SHORT_ID_PATTERN)
    expect(single.title).toBe('网关端口规则')
    expect(single.realms).toEqual([])
    expect(single.variants).toHaveLength(1)

    // 多变体创建 + 增量 upsertVariants / removeVariantWhens
    const multi = await svc.create({
      title: '包管理器用法',
      variants: [
        {
          when: { env: ['mac'], runtime: ['claudecode'] },
          content: 'Mac 上使用 brew。',
          sortOrder: 0,
        },
        { when: { env: ['win'] }, content: 'Windows 上使用 winget。', sortOrder: 1 },
      ],
      topics: ['devtools'],
    })
    expect(multi.variants).toHaveLength(2)

    const updated = await svc.update({
      id: multi.shortId.toUpperCase(),
      expectedVersion: multi.version,
      upsertVariants: [
        { when: { env: ['linux'] }, content: 'Linux 上使用 apt。', sortOrder: 2 },
        {
          when: { env: ['mac'], runtime: ['claudecode'] },
          content: 'Mac 上优先 brew。',
          sortOrder: 0,
        },
      ],
      removeVariantWhens: [{ env: ['win'] }],
    })
    expect(updated.version).toBe(2)
    expect(updated.variants).toHaveLength(2)
    expect(updated.variants.find((v) => v.when.env?.[0] === 'mac')?.content).toBe(
      'Mac 上优先 brew。',
    )
    expect(updated.variants.find((v) => v.when.env?.[0] === 'linux')?.content).toBe(
      'Linux 上使用 apt。',
    )

    // 至少保留一个切片约束
    await expect(
      svc.update({
        id: updated.shortId,
        removeVariantWhens: [{ env: ['mac'], runtime: ['claudecode'] }, { env: ['linux'] }],
      }),
    ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 400)

    // legacy_uris 别名查找与标题精确匹配 + 重名冲突 409
    await withCircle(database.db, personal.id, async (tx) => {
      await tx.insert(legacyUris).values({
        circleId: personal.id,
        entryId: single.id,
        legacyUri: 'user://network/gateway',
        source: 'kioku-legacy',
      })
    })
    expect((await svc.get({ id: 'user://network/gateway' })).id).toBe(single.id)
    expect((await svc.get({ id: '网关端口规则' })).id).toBe(single.id)

    await svc.create({ title: '包管理器用法', content: '另一条同名词条' })
    await expect(svc.get({ id: '包管理器用法' })).rejects.toSatisfy(
      (e) => e instanceof MemoryError && e.status === 409,
    )

    // browse 按切面维度和主题分组
    const byEnv = await svc.browse({ groupBy: 'env', limit: 50 })
    expect(byEnv.groups.some((g) => g.key === 'mac')).toBe(true)
    expect(byEnv.groups.some((g) => g.key === 'linux')).toBe(true)

    const consoleSvc = await entryServiceForConsole(deps, personal.id, alice.id)
    const listed = await consoleSvc.list({
      dimensionKey: 'env',
      termSlug: 'linux',
      sort: 'shortId',
      limit: 50,
    })
    expect(listed.items.map((i) => i.id)).toEqual([multi.id])
  })

  it('强制 secret 同质 realm、静态 allowedRealms 404 隔离、局部降级防旁路与显式审计', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const workRes = await createSharedCircle(database.db, {
      name: '工作圈',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    if (!workRes.ok) throw new Error('建共享圈失败')
    const workId = workRes.value.id
    const deps = makeDeps(database.db, masterKey)

    // 1. 异 realm 变体挂载到 secret 一律拒绝
    const consolePersonal = await entryServiceForConsole(deps, personal.id, alice.id)
    await expect(
      consolePersonal.create({
        title: '混合场域密钥',
        sensitivity: 'secret',
        variants: [
          { when: { realm: ['work'] }, content: 'work secret', sortOrder: 0 },
          { when: { realm: ['home'] }, content: 'home secret', sortOrder: 1 },
        ],
      }),
    ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 400)

    // 2. secret 禁止从正文 Markdown 首行标题推断 title
    const homeSecret = await consolePersonal.create({
      content: '# 家庭 NAS 密码\n\npass: secret-nas-token',
      when: { realm: ['home'] },
      sensitivity: 'secret',
    })
    expect(homeSecret.title).toBe(homeSecret.shortId)
    expect(homeSecret.variants[0]?.content).toBeNull()
    expect('contentHidden' in homeSecret && homeSecret.contentHidden).toBe(true)

    // 从未显式查看时不记录 access 事件
    const preEvents = await withCircle(database.db, personal.id, (tx) =>
      tx
        .select()
        .from(entryEvents)
        .where(
          and(eq(entryEvents.entryId, homeSecret.id), eq(entryEvents.eventType, ACCESS_EVENT)),
        ),
    )
    expect(preEvents).toHaveLength(0)

    // 管理界面显式 reveal 才解密并写入 access 事件
    const revealed = await consolePersonal.reveal(homeSecret.id)
    expect(revealed.contentHidden).toBe(false)
    expect(revealed.variants[0]?.content).toContain('secret-nas-token')

    // 3. 限制 allowedRealms=['work'] 的密钥读 home secret 一律 404，可读 work secret 并审计
    const workSecret = await consolePersonal.create({
      title: '工作密文',
      variants: [
        { when: { realm: ['work'] }, content: 'work plaintext untouched', sortOrder: 0 },
        {
          when: { realm: ['work'], env: ['win'] },
          content: 'password: hidden-work-secret-val',
          sortOrder: 1,
        },
      ],
      sensitivity: 'secret',
    })

    const { principal: workKey } = await issuePrincipal(
      database.db,
      personal.id,
      alice.id,
      'work-only-cli',
      { ...ALL_SCOPES, allowedRealms: ['work'] },
      { realm: ['work'] },
      [{ circleId: workId, mode: 'read' }],
    )
    const keySvc = entryServiceForKey(deps, workKey)
    await expect(keySvc.get({ id: homeSecret.shortId })).rejects.toSatisfy(
      (e) => e instanceof MemoryError && e.status === 404,
    )
    await expect(keySvc.update({ id: homeSecret.shortId, title: 'probe' })).rejects.toSatisfy(
      (e) => e instanceof MemoryError && e.status === 404,
    )

    const keyReadWork = await keySvc.get({ id: workSecret.shortId }, 'kioku_get')
    expect(keyReadWork.variants).toHaveLength(2)

    // 4. 客场圈机密词条同样对外 404
    const consoleWork = await entryServiceForConsole(deps, workId, alice.id)
    const guestSecret = await consoleWork.create({
      title: '共享圈机密',
      content: 'shared top secret',
      sensitivity: 'secret',
    })
    await expect(keySvc.get({ id: guestSecret.shortId })).rejects.toSatisfy(
      (e) => e instanceof MemoryError && e.status === 404,
    )

    // 5. 局部修改与降级防旁路：未改动第二个变体里藏有明文密码，禁止降级；masked 模式禁止改密文
    await expect(
      keySvc.update({
        id: workSecret.shortId,
        sensitivity: 'private',
        upsertVariants: [
          { when: { realm: ['work'] }, content: 'clean variant only', sortOrder: 0 },
        ],
      }),
    ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 400)

    const maskedSvc = entryServiceForKey(deps, workKey, undefined, { maskSecret: true })
    await expect(
      maskedSvc.update({ id: workSecret.shortId, sensitivity: 'private' }),
    ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 400)

    // 验证所有 access 审计记录均已入账
    const allAccess = await withCircle(database.db, personal.id, (tx) =>
      tx.select().from(entryEvents).where(eq(entryEvents.eventType, ACCESS_EVENT)),
    )
    expect(allAccess.length).toBeGreaterThanOrEqual(2)
  })

  it('支持敏感扫描拦截、多变体凭据转存及历史快照清洗，以及静态场域隔离的凭据取用', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const deps = makeDeps(database.db, masterKey)

    const consoleEntries = await entryServiceForConsole(deps, personal.id, alice.id)
    const consoleCreds = await credentialServiceForConsole(deps, personal.id, alice.id)

    // 1. 新增明文凭据被拦截
    await expect(
      consoleEntries.create({
        title: 'API 笔记',
        content: 'password: leaked-credential-value-99',
        sensitivity: 'private',
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof MemoryError && e.status === 400 && Boolean(e.plaintext?.length),
    )

    // 允许放行写入，再做多变体追加，使该值出现在两个历史版本及多个切片里
    const created = await consoleEntries.create({
      title: 'API 笔记',
      variants: [
        { when: { env: ['mac'] }, content: 'password: leaked-credential-value-99', sortOrder: 0 },
        {
          when: { env: ['linux'] },
          content: 'backup password: leaked-credential-value-99',
          sortOrder: 1,
        },
      ],
      sensitivity: 'private',
      allowPlaintext: true,
    })
    expect(await consoleEntries.plaintextCount()).toBe(1)

    // 2. 转存为托管凭据：替换全部变体正文，并清洗 entry_events 历史快照
    const converted = await consoleEntries.convertToCredential(
      {
        entryId: created.id,
        expectedVersion: created.version,
        value: 'leaked-credential-value-99',
        target: {
          kind: 'new',
          identifier: 'api-login-secret',
          name: 'API 登录密钥',
          field: 'password',
        },
      },
      async (tx, target, value) => {
        if (target.kind !== 'new') throw new Error('unexpected target')
        const credId = await consoleCreds.createHostedIn(tx, {
          identifier: target.identifier,
          name: target.name,
          description: target.description ?? null,
          values: { [target.field]: value },
          url: target.url,
          expiresAt: target.expiresAt,
        })
        const view = await consoleCreds.viewIn(tx, credId)
        return {
          identifier: target.identifier,
          field: target.field,
          credential: view,
          created: true,
          storedIn: 'hosted',
        }
      },
    )
    expect(converted.replaced).toBe(2)
    expect(converted.scrubbedEvents).toBeGreaterThanOrEqual(1)
    expect(
      converted.entry.variants.every((v) =>
        v.content?.includes('{{cred:api-login-secret#password}}'),
      ),
    ).toBe(true)

    const hist = await consoleEntries.history(created.id)
    for (const ev of hist.events) {
      for (const v of [...(ev.before?.variants ?? []), ...(ev.after?.variants ?? [])]) {
        expect(v.content ?? '').not.toContain('leaked-credential-value-99')
      }
    }
    expect(await consoleEntries.plaintextCount()).toBe(0)

    // 凭据详情引用列表返回 shortId，事件记录返回 clientName
    const credList = await consoleCreds.list()
    const apiCred = credList.items.find((c) => c.identifier === 'api-login-secret')!
    expect(apiCred.referenceCount).toBe(1)
    const refs = await consoleCreds.references(apiCred.id)
    expect(refs.items[0]?.shortId).toBe(created.shortId)

    // 3. 凭据的静态 allowedRealms 隔离与 keyCreate 继承 allowedRealms
    const workCred = await consoleCreds.create({
      identifier: 'work-deploy-token',
      name: '工作发布令牌',
      source: { kind: 'new', values: { token: 'work-token-secret' } },
      allowedRealms: ['work'],
    })
    expect(workCred.allowedRealms).toEqual(['work'])

    const { principal: homeKey } = await issuePrincipal(
      database.db,
      personal.id,
      alice.id,
      'home-cli',
      { ...ALL_SCOPES, allowedRealms: ['home'] },
      { realm: ['home'] },
    )
    const homeCredSvc = credentialServiceForKey(deps, homeKey)
    const homeVisible = await homeCredSvc.keyList()
    expect(homeVisible.items.some((c) => c.identifier === 'work-deploy-token')).toBe(false)
    await expect(homeCredSvc.use('work-deploy-token', undefined, 'rest')).rejects.toSatisfy(
      (e) => e instanceof MemoryError && e.status === 404,
    )

    const createdByKey = await homeCredSvc.keyCreate({
      identifier: 'home-router-pass',
      name: '路由器密码',
      values: { password: 'router-pass-value' },
    })
    expect(createdByKey.identifier).toBe('home-router-pass')

    const refreshed = await consoleCreds.list()
    const routerCred = refreshed.items.find((c) => c.identifier === 'home-router-pass')!
    expect(routerCred.allowedRealms).toEqual(['home'])
    expect(routerCred.clientIds).toHaveLength(1)

    // 清理引用校验
    const refRows = await withCircle(database.db, personal.id, (tx) =>
      tx.select().from(entryCredentialRefs).where(eq(entryCredentialRefs.entryId, created.id)),
    )
    expect(refRows.map((r) => r.identifier)).toEqual(['api-login-secret'])
  })

  it('软删除保留 shortId；transfer 与 consoleTransfer 物理删除源记录以原地沿用 shortId；主密钥轮换重包装变体密文', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const workRes = await createSharedCircle(database.db, {
      name: '工作圈',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    const homeRes = await createSharedCircle(database.db, {
      name: '家庭圈',
      defaultFacets: { realm: ['home'] },
      ownerAccountId: alice.id,
    })
    if (!workRes.ok || !homeRes.ok) throw new Error('建圈失败')
    const workId = workRes.value.id
    const homeId = homeRes.value.id
    const deps = makeDeps(database.db, masterKey)

    const { principal } = await issuePrincipal(
      database.db,
      workId,
      alice.id,
      'worker',
      ALL_SCOPES,
      {},
      [
        { circleId: homeId, mode: 'read_write' },
        { circleId: personal.id, mode: 'read_write' },
      ],
    )
    const workKeySvc = entryServiceForKey(deps, principal)

    // 1. 软删除后 short_id 仍占位，恢复后继续使用
    const toDelete = await workKeySvc.create({ title: '待删除项', content: 'body' })
    await workKeySvc.remove({ id: toDelete.shortId })
    const deletedRow = await withCircle(database.db, workId, (tx) =>
      tx.select().from(entries).where(eq(entries.shortId, toDelete.shortId)),
    )
    expect(deletedRow).toHaveLength(1)
    expect(deletedRow[0]?.deletedAt).not.toBeNull()

    const consoleWork = await entryServiceForConsole(deps, workId, alice.id)
    const undeleted = await consoleWork.undelete({ entryId: toDelete.id })
    expect(undeleted.version).toBe(3)

    // 2. Key transfer（共享圈之间）：源物理 DELETE，目标 version = 1 保留相同 shortId
    const e1 = await workKeySvc.create({
      title: '共享配置',
      variants: [
        { when: { env: ['mac'] }, content: 'mac content', sortOrder: 0 },
        { when: { env: ['win'] }, content: 'win content', sortOrder: 1 },
      ],
    })
    await workKeySvc.update({ id: e1.shortId, priority: 0 })
    const transferred = await workKeySvc.transfer({
      id: e1.shortId,
      toCircle: homeRes.value.slug,
    })
    expect(transferred.circleId).toBe(homeId)
    expect(transferred.shortId).toBe(e1.shortId)
    expect(transferred.version).toBe(1)
    expect(transferred.variants).toHaveLength(2)

    // 源圈不再存在 entries 行，但保留 entry_id = null 的 transfer_out 事件
    const sourceCheck = await withCircle(database.db, workId, async (tx) => {
      const remaining = await tx.select().from(entries).where(eq(entries.id, e1.id))
      const outEvents = await tx
        .select()
        .from(entryEvents)
        .where(
          and(
            eq(entryEvents.eventType, 'transfer_out'),
            eq(entryEvents.shortId, e1.shortId),
            isNull(entryEvents.entryId),
          ),
        )
      return { remaining, outEvents }
    })
    expect(sourceCheck.remaining).toHaveLength(0)
    expect(sourceCheck.outEvents).toHaveLength(1)

    // 3. consoleTransfer 跨个人圈与共享圈迁移 + 主密钥轮换
    const consolePersonal = await entryServiceForConsole(deps, personal.id, alice.id)
    const personalSecret = await consolePersonal.create({
      title: '个人机密项',
      content: 'secret body across transfer & key rotation',
      sensitivity: 'secret',
    })
    const homeTargetAccess = consoleAccess(homeId, 'shared', 'owner', alice.id, ['home'])
    const movedToShared = await consolePersonal.consoleTransfer(
      { entryId: personalSecret.id, toCircleId: homeId },
      homeTargetAccess,
    )
    expect(movedToShared.shortId).toBe(personalSecret.shortId)
    expect(movedToShared.circleId).toBe(homeId)
    expect(movedToShared.version).toBe(1)

    // 主密钥轮换测试：prepareMasterKey -> rotateMasterKey -> 只配 newKey 解密成功
    const newKey = randomBytes(32)
    await prepareMasterKey(database.db, { current: newKey, previous: masterKey })
    const beforeRot = await masterKeyStatus(database.db, { current: newKey, previous: masterKey })
    expect(beforeRot.remaining.entries).toBe(1)
    const rot = await rotateMasterKey(database.db, { current: newKey, previous: masterKey })
    expect(rot.rewrapped).toBe(1)
    expect(rot.remaining).toBe(0)

    const vRow = await withCircle(database.db, homeId, (tx) =>
      tx.select().from(entryVariants).where(eq(entryVariants.entryId, movedToShared.id)).limit(1),
    )
    expect(openVariantContent(newKey, vRow[0]!.id, vRow[0]!)).toBe(
      'secret body across transfer & key rotation',
    )
    const newDeps = makeDeps(database.db, newKey)
    const consoleHomeNew = await entryServiceForConsole(newDeps, homeId, alice.id)
    const revealedAfterRot = await consoleHomeNew.reveal(movedToShared.id)
    expect(revealedAfterRot.variants[0]?.content).toBe('secret body across transfer & key rotation')
  })
})
