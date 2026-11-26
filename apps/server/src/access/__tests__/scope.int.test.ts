import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  canAccessCredential,
  canReadEntry,
  credentialRealmConditionSql,
  hasExclusiveSceneConflict,
  readableEntrySql,
  synthesizeFocus,
  type AccessScope,
} from '../scope'
import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { credentials, entries } from '../../db/schema'
import type { KeyPrincipal } from '../../http/env'
import { EntryService } from '../../memory/service'
import {
  databaseNow,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'

function keyScope(overrides: Partial<KeyPrincipal> = {}): KeyPrincipal {
  return {
    kind: 'key',
    keyId: '00000000-0000-4000-8000-000000000001',
    name: 'Test Key',
    prefix: 'kioku_test',
    runtimeFamily: 'claudecode',
    envs: [],
    allowedRealms: null,
    canWrite: true,
    canResolveCredentials: true,
    ...overrides,
  }
}

describe('场景焦点合成与互斥冲突判定', () => {
  it('synthesizeFocus 默认继承密钥透镜，显式请求态参数覆盖对应维度', () => {
    const scope = keyScope({
      runtimeFamily: 'claudecode',
      envs: ['home', 'office'],
      allowedRealms: ['work'],
    })
    const inherited = synthesizeFocus(scope, { project: { repoName: 'org/Kioku' } })
    expect(inherited.envs).toEqual(['home', 'office'])
    expect(inherited.realms).toEqual(['work'])
    expect(inherited.projects).toEqual(['kioku'])
    expect(inherited.runtimes).toEqual(['claudecode'])

    const overridden = synthesizeFocus(scope, {
      env: 'Server',
      realm: 'Personal',
      runtime: 'codex',
    })
    expect(overridden.envs).toEqual(['server'])
    expect(overridden.realms).toEqual(['personal'])
    expect(overridden.runtimes).toEqual(['codex'])
  })

  it('hasExclusiveSceneConflict 只在双方同独占维度（环境/场域/客户端）皆非空且无交集时判为冲突', () => {
    const focus = { envs: ['home'], realms: ['personal'], projects: ['kioku'], runtimes: ['codex'] }
    expect(hasExclusiveSceneConflict({ envs: [], realms: [], runtimes: [] }, focus)).toBe(false)
    expect(hasExclusiveSceneConflict({ envs: ['office'], realms: [], runtimes: [] }, focus)).toBe(
      true,
    )
    expect(
      hasExclusiveSceneConflict({ envs: ['home', 'office'], realms: [], runtimes: [] }, focus),
    ).toBe(false)
    expect(hasExclusiveSceneConflict({ envs: [], realms: ['work'], runtimes: [] }, focus)).toBe(
      true,
    )
    expect(
      hasExclusiveSceneConflict({ envs: [], realms: [], runtimes: ['claudecode'] }, focus),
    ).toBe(true)
  })
})

describe.skipIf(!testDatabaseUrl)('allowed_realms 硬边界（JS 与 SQL 一致性）', () => {
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

  it('词条可读判断在 JS canReadEntry 与 SQL readableEntrySql 上逐条完全一致', async () => {
    const now = await databaseNow(database.db)
    const past = new Date(now.getTime() - 60_000)
    const future = new Date(now.getTime() + 60_000)

    const samples = [
      { shortId: 'm-aaa222', title: 'universal', realms: [], deletedAt: null, validTo: null },
      { shortId: 'm-aaa333', title: 'work-only', realms: ['work'], deletedAt: null, validTo: null },
      {
        shortId: 'm-aaa444',
        title: 'personal-only',
        realms: ['personal'],
        deletedAt: null,
        validTo: null,
      },
      {
        shortId: 'm-aaa555',
        title: 'multi-realm',
        realms: ['work', 'client-a'],
        deletedAt: null,
        validTo: future,
      },
      {
        shortId: 'm-aaa666',
        title: 'expired-universal',
        realms: [],
        deletedAt: null,
        validTo: past,
      },
      {
        shortId: 'm-aaa777',
        title: 'deleted-work',
        realms: ['work'],
        deletedAt: past,
        validTo: null,
      },
    ]

    for (const item of samples) {
      await database.db.insert(entries).values({
        shortId: item.shortId,
        kind: 'entry',
        title: item.title,
        content: item.title,
        realms: item.realms,
        deletedAt: item.deletedAt,
        validTo: item.validTo,
      })
    }

    const scopes: AccessScope[] = [
      { kind: 'console', accountId: 'acc', sessionId: 'sess' },
      keyScope({ allowedRealms: null }),
      keyScope({ allowedRealms: [] }),
      keyScope({ allowedRealms: ['work'] }),
      keyScope({ allowedRealms: ['personal'] }),
      keyScope({ allowedRealms: ['client-a', 'other'] }),
    ]

    const allRows = await database.db.select().from(entries)

    for (const scope of scopes) {
      const sqlRows = await database.db
        .select({ shortId: entries.shortId })
        .from(entries)
        .where(readableEntrySql(scope, { now }))
      const sqlSet = new Set(sqlRows.map((r) => r.shortId))
      const jsSet = new Set(
        allRows.filter((row) => canReadEntry(scope, row, { now })).map((r) => r.shortId),
      )
      expect(sqlSet).toEqual(jsSet)
    }

    // 明确验证 work 密钥看不见 personal，但看得见无场域通用词条和 work/multi-realm
    const workScope = keyScope({ allowedRealms: ['work'] })
    const workRows = await database.db
      .select({ shortId: entries.shortId })
      .from(entries)
      .where(readableEntrySql(workScope, { now }))
    expect(workRows.map((r) => r.shortId).sort()).toEqual(['m-aaa222', 'm-aaa333', 'm-aaa555'])
  })

  it('凭据采用 fail-closed 边界：凭据未标场域时，受限场域密钥不可访问，仅全权限密钥可访问', async () => {
    const masterKey = testMasterKey()
    const svc = new CredentialService(database.db, masterKey)

    await svc.create({ slug: 'unscoped', label: 'Unscoped', value: 'val-a', allowedRealms: [] })
    await svc.create({
      slug: 'work-only',
      label: 'Work',
      value: 'val-b',
      allowedRealms: ['work'],
    })
    await svc.create({
      slug: 'personal-only',
      label: 'Personal',
      value: 'val-c',
      allowedRealms: ['personal'],
    })
    await svc.create({
      slug: 'both',
      label: 'Both',
      value: 'val-d',
      allowedRealms: ['work', 'personal'],
    })

    const allCreds = await database.db.select().from(credentials)
    const scopes: AccessScope[] = [
      { kind: 'console', accountId: 'acc', sessionId: 'sess' },
      keyScope({ allowedRealms: null, canResolveCredentials: true }),
      keyScope({ allowedRealms: null, canResolveCredentials: false }),
      keyScope({ allowedRealms: ['work'], canResolveCredentials: true }),
      keyScope({ allowedRealms: ['personal'], canResolveCredentials: true }),
      keyScope({ allowedRealms: [], canResolveCredentials: true }),
    ]

    for (const scope of scopes) {
      const sqlRows = await database.db
        .select({ slug: credentials.slug })
        .from(credentials)
        .where(credentialRealmConditionSql(scope))
      const sqlSlugs = new Set(sqlRows.map((r) => r.slug))
      const jsSlugs = new Set(
        allCreds.filter((row) => canAccessCredential(scope, row)).map((r) => r.slug),
      )
      expect(sqlSlugs).toEqual(jsSlugs)
    }

    // work 密钥绝对不能访问 unscoped（allowedRealms=[]）和 personal-only
    const workScope = keyScope({ allowedRealms: ['work'], canResolveCredentials: true })
    const visibleToWork = allCreds
      .filter((c) => canAccessCredential(workScope, c))
      .map((c) => c.slug)
      .sort()
    expect(visibleToWork).toEqual(['both', 'work-only'])
  })

  it('EntryService.history 严格执行 allowed_realms 权限隔离，禁止越权读取历史版本', async () => {
    const masterKey = testMasterKey()
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope: AccessScope = { kind: 'console', accountId: 'acc', sessionId: 'sess' }

    const personalEntry = await entrySvc.create(consoleScope, {
      title: '个人备忘',
      content: '私人内容',
      realms: ['personal'],
      isPinned: false,
      envs: [],
      projects: [],
      runtimes: [],
      topics: [],
    })
    const workEntry = await entrySvc.create(consoleScope, {
      title: '工作约定',
      content: '工作内容',
      realms: ['work'],
      isPinned: false,
      envs: [],
      projects: [],
      runtimes: [],
      topics: [],
    })
    const universalEntry = await entrySvc.create(consoleScope, {
      title: '通用规范',
      content: '通用内容',
      realms: [],
      isPinned: false,
      envs: [],
      projects: [],
      runtimes: [],
      topics: [],
    })

    const workScope = keyScope({ allowedRealms: ['work'] })
    await expect(entrySvc.history(workScope, personalEntry.entry.shortId)).rejects.toMatchObject({
      status: 404,
    })
    const workHistory = await entrySvc.history(workScope, workEntry.entry.shortId)
    expect(workHistory.items).toHaveLength(1)
    const universalHistory = await entrySvc.history(workScope, universalEntry.entry.shortId)
    expect(universalHistory.items).toHaveLength(1)

    // 词条从 personal 改迁至 work 后，work 密钥绝不可读取原 personal 版本的历史快照或说明
    await entrySvc.update(consoleScope, personalEntry.entry.shortId, {
      content: '脱敏后的工作内容',
      realms: ['work'],
    })
    const migratedDetail = await entrySvc.get(workScope, personalEntry.entry.shortId)
    expect(migratedDetail.entry.lastChangeSummary).toBeNull()
    expect(migratedDetail.recentHistory?.every((ev) => ev.version !== 1)).toBe(true)

    const migratedHistory = await entrySvc.history(workScope, personalEntry.entry.shortId, {
      includeSnapshots: true,
    })
    expect(migratedHistory.items.map((ev) => ev.version)).toEqual([2])
    const v1Attempt = await entrySvc.history(workScope, personalEntry.entry.shortId, { version: 1 })
    expect(v1Attempt.items).toEqual([])
  })
})
