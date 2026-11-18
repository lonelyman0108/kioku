import { and, asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  assertRuntimeRole,
  eachCircle,
  isUniqueViolation,
  pgConstraint,
  pgErrorCode,
  withCircle,
  withCircles,
  type Database,
  type Db,
} from '../client'
import {
  accounts,
  circles,
  clients,
  conversations,
  entries,
  entryVariants,
  facetDimensions,
  facetTerms,
  personas,
  RLS_TABLES,
  subjects,
} from '../schema'

const NON_RLS_CIRCLE_TABLES = ['circle_members', 'circle_departures', 'device_grants']

async function expectSavepointError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('预期操作失败，却执行成功了')
}

async function seedAccount(db: Db, username: string): Promise<{ id: string; username: string }> {
  const [acc] = await db
    .insert(accounts)
    .values({ username, displayName: username, passwordHash: 'x' })
    .returning({ id: accounts.id, username: accounts.username })
  return acc!
}

async function seedSharedCircle(
  db: Db,
  slug: string,
  name = slug,
): Promise<{ id: string; slug: string }> {
  const [circle] = await db
    .insert(circles)
    .values({ slug, name, kind: 'shared' })
    .returning({ id: circles.id, slug: circles.slug })
  return circle!
}

async function seedPersonalCircle(
  db: Db,
  ownerAccountId: string,
  slug: string,
): Promise<{ id: string; slug: string }> {
  const [circle] = await db
    .insert(circles)
    .values({ slug, name: slug, kind: 'personal', ownerAccountId })
    .returning({ id: circles.id, slug: circles.slug })
  return circle!
}

describe.skipIf(!testDatabaseUrl)('行级安全隔离与基线约束', () => {
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

  it('运行角色校验：当前非特权角色通过，超级用户或 BYPASSRLS 角色拒绝启动', async () => {
    await expect(assertRuntimeRole(database.db)).resolves.toBeUndefined()

    const superRoleDb = {
      execute: async () => [{ rolname: 'postgres', rolsuper: true, rolbypassrls: false }],
    } as unknown as Db
    await expect(assertRuntimeRole(superRoleDb)).rejects.toThrow('会绕过记忆圈隔离')

    const bypassRoleDb = {
      execute: async () => [{ rolname: 'bypass_user', rolsuper: false, rolbypassrls: true }],
    } as unknown as Db
    await expect(assertRuntimeRole(bypassRoleDb)).rejects.toThrow('会绕过记忆圈隔离')
  })

  it('元数据全覆盖：31 张 RLS 表全部强制启用 RLS 与读写四策略，并涵盖全部带 circle_id 的表', async () => {
    const classRows = await database.db.execute<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(sql`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `)
    const classMap = new Map(classRows.map((r) => [r.relname, r]))

    const policyRows = await database.db.execute<{
      tablename: string
      policyname: string
      cmd: string
    }>(sql`
      select tablename, policyname, cmd
      from pg_policies
      where schemaname = 'public'
    `)
    const policiesByTable = new Map<string, Map<string, string>>()
    for (const row of policyRows) {
      const m = policiesByTable.get(row.tablename) ?? new Map<string, string>()
      m.set(row.policyname, row.cmd)
      policiesByTable.set(row.tablename, m)
    }

    expect(RLS_TABLES).toHaveLength(31)
    for (const table of RLS_TABLES) {
      const meta = classMap.get(table)
      expect(meta?.relrowsecurity, `${table} 未启用 RLS`).toBe(true)
      expect(meta?.relforcerowsecurity, `${table} 未启用 FORCE RLS`).toBe(true)

      const policies = policiesByTable.get(table)
      expect(policies?.get('circle_select'), `${table} 缺 circle_select`).toBe('SELECT')
      expect(policies?.get('circle_insert'), `${table} 缺 circle_insert`).toBe('INSERT')
      expect(policies?.get('circle_update'), `${table} 缺 circle_update`).toBe('UPDATE')
      expect(policies?.get('circle_delete'), `${table} 缺 circle_delete`).toBe('DELETE')
    }

    const colRows = await database.db.execute<{ table_name: string }>(sql`
      select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.column_name = 'circle_id'
    `)
    const tablesWithCircleId = new Set(colRows.map((r) => r.table_name))
    const expected = new Set<string>([...RLS_TABLES, ...NON_RLS_CIRCLE_TABLES])
    expect(tablesWithCircleId).toEqual(expected)
  })

  it('未设置 GUC 拒绝读写全部 RLS 表，非法圈 ID 直接报错', async () => {
    await expect(
      withCircles(database.db, { read: ['not-a-uuid'] }, async () => {}),
    ).rejects.toThrow('无效的记忆圈标识')
    await expect(
      withCircles(database.db, { read: [], write: ['bad'] }, async () => {}),
    ).rejects.toThrow('无效的记忆圈标识')

    const circle = await seedSharedCircle(database.db, 'unscoped-circle')
    await withCircle(database.db, circle.id, async (tx) => {
      await tx.insert(personas).values({ circleId: circle.id, slug: 'p1', name: '人格一' })
    })

    const rows = await database.db.select().from(personas)
    expect(rows).toEqual([])

    const err = await expectSavepointError(() =>
      database.db.insert(personas).values({ circleId: circle.id, slug: 'p2', name: '人格二' }),
    )
    expect(pgErrorCode(err)).toBe('42501')
  })

  it('双 GUC 读写分权：多圈可读但跨圈写入/改写/删均被拒绝，且支持嵌套恢复与 eachCircle', async () => {
    const circleA = await seedSharedCircle(database.db, 'circle-a', '圈子A')
    const circleB = await seedSharedCircle(database.db, 'circle-b', '圈子B')

    const personaA = await withCircle(database.db, circleA.id, async (tx) => {
      const [row] = await tx
        .insert(personas)
        .values({ circleId: circleA.id, slug: 'pa', name: '人格A' })
        .returning()
      return row!
    })
    const personaB = await withCircle(database.db, circleB.id, async (tx) => {
      const [row] = await tx
        .insert(personas)
        .values({ circleId: circleB.id, slug: 'pb', name: '人格B' })
        .returning()
      return row!
    })

    await withCircles(
      database.db,
      { read: [circleA.id, circleB.id], write: [circleA.id] },
      async (tx) => {
        const visible = await tx.select().from(personas).orderBy(asc(personas.slug))
        expect(visible.map((p) => p.slug)).toEqual(['pa', 'pb'])

        const [created] = await tx
          .insert(personas)
          .values({ circleId: circleA.id, slug: 'pa2', name: '人格A2' })
          .returning()
        expect(created?.circleId).toBe(circleA.id)

        const insertBErr = await expectSavepointError(() =>
          tx.transaction((sp) =>
            sp.insert(personas).values({ circleId: circleB.id, slug: 'pb2', name: '非法写入B' }),
          ),
        )
        expect(pgErrorCode(insertBErr)).toBe('42501')

        const updatedB = await tx
          .update(personas)
          .set({ name: '试图改写B' })
          .where(eq(personas.id, personaB.id))
          .returning()
        expect(updatedB).toEqual([])

        const moveErr = await expectSavepointError(() =>
          tx.transaction((sp) =>
            sp.update(personas).set({ circleId: circleB.id }).where(eq(personas.id, personaA.id)),
          ),
        )
        expect(pgErrorCode(moveErr)).toBe('42501')

        const deletedB = await tx.delete(personas).where(eq(personas.id, personaB.id)).returning()
        expect(deletedB).toEqual([])

        // 嵌套较窄只读作用域退出后，外层读写作用域应恢复
        await withCircles(tx, { read: [circleB.id] }, async (innerTx) => {
          const innerRows = await innerTx.select().from(personas)
          expect(innerRows.map((p) => p.slug)).toEqual(['pb'])
          const innerWriteErr = await expectSavepointError(() =>
            innerTx.transaction((sp) =>
              sp.insert(personas).values({ circleId: circleA.id, slug: 'nested-fail', name: 'x' }),
            ),
          )
          expect(pgErrorCode(innerWriteErr)).toBe('42501')
        })

        const [afterNested] = await tx
          .insert(personas)
          .values({ circleId: circleA.id, slug: 'pa3', name: '恢复可写' })
          .returning()
        expect(afterNested?.slug).toBe('pa3')
      },
    )

    // 确认 B 圈原记录毫发无伤
    await withCircles(database.db, { read: [circleB.id] }, async (tx) => {
      const [rowB] = await tx.select().from(personas).where(eq(personas.id, personaB.id))
      expect(rowB?.name).toBe('人格B')

      const readOnlyErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(personas).values({ circleId: circleB.id, slug: 'ro-fail', name: 'x' }),
        ),
      )
      expect(pgErrorCode(readOnlyErr)).toBe('42501')
    })

    // read 为空时 write 自动并入 read，保证 INSERT ... RETURNING 正常工作
    await withCircles(database.db, { read: [], write: [circleB.id] }, async (tx) => {
      const [row] = await tx
        .insert(personas)
        .values({ circleId: circleB.id, slug: 'pb-write-only', name: '写入并可读' })
        .returning()
      expect(row?.slug).toBe('pb-write-only')
    })

    const visited = new Set<string>()
    await eachCircle(database.db, async (tx) => {
      const rows = await tx.select().from(personas)
      for (const r of rows) visited.add(r.slug)
    })
    expect(visited).toEqual(new Set(['pa', 'pa2', 'pa3', 'pb', 'pb-write-only']))

    await expect(
      eachCircle(database.db, async () => {
        await eachCircle(database.db, async () => {})
      }),
    ).rejects.toThrow('eachCircle 不能嵌套调用')
  })

  it('个人圈每账号唯一且账号存在时禁止直接删除，删除账号时级联清除', async () => {
    const acc = await seedAccount(database.db, 'alice')
    const p1 = await seedPersonalCircle(database.db, acc.id, 'p-alice')

    const dupErr = await expectSavepointError(() =>
      seedPersonalCircle(database.db, acc.id, 'p-alice-2'),
    )
    expect(isUniqueViolation(dupErr, 'circles_personal_owner_idx')).toBe(true)

    const delCircleErr = await expectSavepointError(() =>
      database.db.delete(circles).where(eq(circles.id, p1.id)),
    )
    expect(pgErrorCode(delCircleErr)).toBe('23514')
    expect(pgConstraint(delCircleErr)).toBe('circles_personal_undeletable')

    await database.db.delete(accounts).where(eq(accounts.id, acc.id))
    const remainingCircles = await database.db.select().from(circles).where(eq(circles.id, p1.id))
    expect(remainingCircles).toEqual([])
  })

  it('entries 与 entry_variants 约束完备，且 kioku_zh 支持中文分词全文检索', async () => {
    const acc = await seedAccount(database.db, 'bob')
    const personal = await seedPersonalCircle(database.db, acc.id, 'p-bob')
    const shared = await seedSharedCircle(database.db, 's-team')

    await withCircle(database.db, personal.id, async (tx) => {
      const badShortErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(entries).values({
            circleId: personal.id,
            circleKind: 'personal',
            shortId: 'm-10ilo',
            kind: 'entry',
            title: '非法短ID',
            sensitivity: 'internal',
            provenance: 'owner',
            ownerAccountId: acc.id,
          }),
        ),
      )
      expect(pgErrorCode(badShortErr)).toBe('23514')
      expect(pgConstraint(badShortErr)).toBe('entries_short_id_format')

      const missingOwnerErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(entries).values({
            circleId: personal.id,
            circleKind: 'personal',
            shortId: 'm-234567',
            kind: 'entry',
            title: '缺所有者',
            sensitivity: 'internal',
            provenance: 'owner',
            ownerAccountId: null,
          }),
        ),
      )
      expect(pgErrorCode(missingOwnerErr)).toBe('23514')
      expect(pgConstraint(missingOwnerErr)).toBe('entries_shape_by_kind')

      const [softDeleted] = await tx
        .insert(entries)
        .values({
          circleId: personal.id,
          circleKind: 'personal',
          shortId: 'm-234567',
          kind: 'entry',
          title: '已软删词条',
          sensitivity: 'internal',
          provenance: 'owner',
          ownerAccountId: acc.id,
          deletedAt: new Date(),
        })
        .returning()
      expect(softDeleted?.shortId).toBe('m-234567')
    })

    await withCircle(database.db, shared.id, async (tx) => {
      // 跨圈且即使原词条已软删，shortId 依然全局不可复用
      const dupShortErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(entries).values({
            circleId: shared.id,
            circleKind: 'shared',
            shortId: 'm-234567',
            kind: 'entry',
            title: '撞号词条',
            sensitivity: 'internal',
            provenance: 'owner',
          }),
        ),
      )
      expect(isUniqueViolation(dupShortErr, 'entries_short_id_unique')).toBe(true)

      const sharedWithOwnerErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(entries).values({
            circleId: shared.id,
            circleKind: 'shared',
            shortId: 'm-234568',
            kind: 'entry',
            title: '共享圈不能有所有者',
            sensitivity: 'internal',
            provenance: 'owner',
            ownerAccountId: acc.id,
          }),
        ),
      )
      expect(pgErrorCode(sharedWithOwnerErr)).toBe('23514')
      expect(pgConstraint(sharedWithOwnerErr)).toBe('entries_shape_by_kind')

      const [client] = await tx
        .insert(clients)
        .values({
          circleId: shared.id,
          slug: 'cli',
          name: '测试端',
          runtimeFamily: 'mcp',
          ownerAccountId: acc.id,
        })
        .returning()
      const [conv] = await tx
        .insert(conversations)
        .values({
          circleId: shared.id,
          clientId: client!.id,
          kind: 'none',
          ownerAccountId: acc.id,
        })
        .returning()

      // episode 的 priority 与非 secret 校验
      const zeroPriorityErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(entries).values({
            circleId: shared.id,
            circleKind: 'shared',
            shortId: 'm-234569',
            kind: 'episode',
            title: '优先级不足',
            sensitivity: 'internal',
            provenance: 'untrusted',
            conversationId: conv!.id,
            priority: 0,
          }),
        ),
      )
      expect(pgErrorCode(zeroPriorityErr)).toBe('23514')
      expect(pgConstraint(zeroPriorityErr)).toBe('entries_episode_priority')

      const secretEpisodeErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(entries).values({
            circleId: shared.id,
            circleKind: 'shared',
            shortId: 'm-234572',
            kind: 'episode',
            title: '机密摘要非法',
            sensitivity: 'secret',
            provenance: 'untrusted',
            conversationId: conv!.id,
            priority: 1,
          }),
        ),
      )
      expect(pgErrorCode(secretEpisodeErr)).toBe('23514')
      expect(pgConstraint(secretEpisodeErr)).toBe('entries_episode_not_secret')

      const [ep] = await tx
        .insert(entries)
        .values({
          circleId: shared.id,
          circleKind: 'shared',
          shortId: 'm-234573',
          kind: 'episode',
          title: '架构讨论摘要',
          sensitivity: 'internal',
          provenance: 'untrusted',
          conversationId: conv!.id,
          priority: 1,
        })
        .returning()

      const condEpisodeErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(entryVariants).values({
            circleId: shared.id,
            entryId: ep!.id,
            sensitivity: 'internal',
            kind: 'episode',
            when: { realms: ['work'] },
            whenSignature: 'r:work',
            content: '带条件摘要非法',
          }),
        ),
      )
      expect(pgErrorCode(condEpisodeErr)).toBe('23514')
      expect(pgConstraint(condEpisodeErr)).toBe('entry_variants_episode_unconditional')

      await tx.insert(entryVariants).values({
        circleId: shared.id,
        entryId: ep!.id,
        sensitivity: 'internal',
        kind: 'episode',
        content: '第一次无条件摘要',
      })

      const secondEpVariantErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(entryVariants).values({
            circleId: shared.id,
            entryId: ep!.id,
            sensitivity: 'internal',
            kind: 'episode',
            content: '第二条摘要应拒绝',
          }),
        ),
      )
      expect(pgErrorCode(secondEpVariantErr)).toBe('23505')

      // 正式词条、机密密文检查与 kioku_zh 中文分词检索
      const [entry] = await tx
        .insert(entries)
        .values({
          circleId: shared.id,
          circleKind: 'shared',
          shortId: 'm-234574',
          kind: 'entry',
          title: '系统架构说明',
          sensitivity: 'internal',
          provenance: 'owner',
        })
        .returning()

      await tx.insert(entryVariants).values({
        circleId: shared.id,
        entryId: entry!.id,
        sensitivity: 'internal',
        kind: 'entry',
        searchHeader: '系统架构',
        content: '长期记忆服务支持中文全文检索测试',
      })

      const ftsMatches = await tx
        .select({ id: entryVariants.id, fts: entryVariants.fts })
        .from(entryVariants)
        .where(
          and(
            eq(entryVariants.entryId, entry!.id),
            sql`${entryVariants.fts} @@ to_tsquery('kioku_zh', '架构 & 全文检索')`,
          ),
        )
      expect(ftsMatches).toHaveLength(1)
      expect(String(ftsMatches[0]!.fts)).toContain('全文检索')

      const [secretEntry] = await tx
        .insert(entries)
        .values({
          circleId: shared.id,
          circleKind: 'shared',
          shortId: 'm-234575',
          kind: 'entry',
          title: '私钥备忘',
          sensitivity: 'secret',
          provenance: 'owner',
        })
        .returning()

      const badSecretErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(entryVariants).values({
            circleId: shared.id,
            entryId: secretEntry!.id,
            sensitivity: 'secret',
            kind: 'entry',
            searchHeader: '不应该有检索头',
            content: '明文泄露',
          }),
        ),
      )
      expect(pgErrorCode(badSecretErr)).toBe('23514')
      expect(pgConstraint(badSecretErr)).toBe('entry_variants_secret_encrypted')

      const [okSecret] = await tx
        .insert(entryVariants)
        .values({
          circleId: shared.id,
          entryId: secretEntry!.id,
          sensitivity: 'secret',
          kind: 'entry',
          searchHeader: '',
          content: null,
          ciphertext: Buffer.from('enc-payload'),
          wrappedKey: Buffer.from('wrapped-key'),
          keyId: 'key-1',
        })
        .returning()
      expect(okSecret?.keyId).toBe('key-1')
    })
  })

  it('延迟外键 entry_variants_state_fk 允许单事务同步切换敏感级，但仅改单侧会在作用域结束前暴露', async () => {
    const shared = await seedSharedCircle(database.db, 'defer-circle')

    const entryId = await withCircle(database.db, shared.id, async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({
          circleId: shared.id,
          circleKind: 'shared',
          shortId: 'm-234582',
          kind: 'entry',
          title: '可升级机密词条',
          sensitivity: 'internal',
          provenance: 'owner',
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: shared.id,
        entryId: entry!.id,
        sensitivity: 'internal',
        kind: 'entry',
        searchHeader: '头信息',
        content: '初始明文内容',
      })
      return entry!.id
    })

    // 同一 withCircle 内同步更新 entries 与 entry_variants 从 internal 到 secret
    await withCircle(database.db, shared.id, async (tx) => {
      await tx.update(entries).set({ sensitivity: 'secret' }).where(eq(entries.id, entryId))
      await tx
        .update(entryVariants)
        .set({
          sensitivity: 'secret',
          searchHeader: '',
          content: null,
          ciphertext: Buffer.from('cipher'),
          wrappedKey: Buffer.from('wk'),
          keyId: 'k-sync',
        })
        .where(eq(entryVariants.entryId, entryId))
    })

    // 外层事务（savepoint）中仅修改 entries.sensitivity 而不动 variants，withCircle 退出前必须立即拒绝
    await database.db.transaction(async (outerTx) => {
      const mismatchErr = await expectSavepointError(() =>
        withCircle(outerTx, shared.id, async (tx) => {
          await tx.update(entries).set({ sensitivity: 'internal' }).where(eq(entries.id, entryId))
        }),
      )
      expect(pgErrorCode(mismatchErr)).toBe('23503')
      expect(pgConstraint(mismatchErr)).toBe('entry_variants_state_fk')

      const [stillAlive] = await outerTx.execute<{ ok: number }>(sql`select 1 as ok`)
      expect(stillAlive?.ok).toBe(1)
    })
  })

  it('细粒度 none 会话索引、列名级 ON DELETE SET NULL 与删会话清理摘要触发器均按预期工作', async () => {
    const acc = await seedAccount(database.db, 'carol')
    const shared = await seedSharedCircle(database.db, 'conv-circle')

    await withCircle(database.db, shared.id, async (tx) => {
      const [persona] = await tx
        .insert(personas)
        .values({ circleId: shared.id, slug: 'default-p', name: '默认人格' })
        .returning()
      const [client] = await tx
        .insert(clients)
        .values({
          circleId: shared.id,
          slug: 'bot',
          name: '工作助手',
          runtimeFamily: 'mcp',
          ownerAccountId: acc.id,
          defaultPersonaId: persona!.id,
        })
        .returning()

      // 删掉 defaultPersona 后，仅 defaultPersonaId 置空，clients.circleId 保持完好
      await tx.delete(personas).where(eq(personas.id, persona!.id))
      const [clientAfter] = await tx.select().from(clients).where(eq(clients.id, client!.id))
      expect(clientAfter?.defaultPersonaId).toBeNull()
      expect(clientAfter?.circleId).toBe(shared.id)

      // 同一 (clientId, ownerAccountId) 下不同 (deviceKey, projectSlug) 可创建多个 none 会话
      const [c1] = await tx
        .insert(conversations)
        .values({
          circleId: shared.id,
          clientId: client!.id,
          kind: 'none',
          ownerAccountId: acc.id,
          deviceKey: 'mac',
          projectSlug: 'kioku',
        })
        .returning()
      const [c2] = await tx
        .insert(conversations)
        .values({
          circleId: shared.id,
          clientId: client!.id,
          kind: 'none',
          ownerAccountId: acc.id,
          deviceKey: 'linux',
          projectSlug: 'kioku',
        })
        .returning()
      expect(c1?.id).not.toBe(c2?.id)

      const dupConvErr = await expectSavepointError(() =>
        tx.transaction((sp) =>
          sp.insert(conversations).values({
            circleId: shared.id,
            clientId: client!.id,
            kind: 'none',
            ownerAccountId: acc.id,
            deviceKey: 'mac',
            projectSlug: 'kioku',
          }),
        ),
      )
      expect(isUniqueViolation(dupConvErr, 'conversations_none_idx')).toBe(true)

      const [subject] = await tx
        .insert(subjects)
        .values({ circleId: shared.id, kind: 'group', displayName: '研发群' })
        .returning()

      const [episodeEntry] = await tx
        .insert(entries)
        .values({
          circleId: shared.id,
          circleKind: 'shared',
          shortId: 'm-234592',
          kind: 'episode',
          title: '临时会话摘要',
          sensitivity: 'internal',
          provenance: 'untrusted',
          conversationId: c1!.id,
          priority: 1,
        })
        .returning()
      const [factEntry] = await tx
        .insert(entries)
        .values({
          circleId: shared.id,
          circleKind: 'shared',
          shortId: 'm-234593',
          kind: 'fact',
          title: '群内长期事实',
          sensitivity: 'internal',
          provenance: 'untrusted',
          subjectId: subject!.id,
          subjectKind: 'group',
          conversationId: c1!.id,
        })
        .returning()

      // 删除 c1 会话：触发器删除 episode，保留 fact 且仅将 conversationId 置空
      await tx.delete(conversations).where(eq(conversations.id, c1!.id))

      const remainingEp = await tx.select().from(entries).where(eq(entries.id, episodeEntry!.id))
      expect(remainingEp).toEqual([])

      const [remainingFact] = await tx.select().from(entries).where(eq(entries.id, factEntry!.id))
      expect(remainingFact?.id).toBe(factEntry!.id)
      expect(remainingFact?.circleId).toBe(shared.id)
      expect(remainingFact?.conversationId).toBeNull()
    })
  })

  it('切面维度禁止内置保留名，facet_terms 在不同记忆圈间严格隔离', async () => {
    const circleA = await seedSharedCircle(database.db, 'facet-a')
    const circleB = await seedSharedCircle(database.db, 'facet-b')

    await withCircle(database.db, circleA.id, async (tx) => {
      for (const builtin of ['realm', 'env', 'runtime', 'project']) {
        const err = await expectSavepointError(() =>
          tx.transaction((sp) =>
            sp.insert(facetDimensions).values({
              circleId: circleA.id,
              key: builtin,
              name: builtin,
            }),
          ),
        )
        expect(pgErrorCode(err)).toBe('23514')
        expect(pgConstraint(err)).toBe('facet_dimensions_not_builtin')
      }

      await tx.insert(facetDimensions).values({
        circleId: circleA.id,
        key: 'city',
        name: '城市',
      })
      await tx.insert(facetTerms).values({
        circleId: circleA.id,
        dimensionKey: 'city',
        slug: 'shanghai',
        label: '上海',
      })
    })

    await withCircle(database.db, circleB.id, async (tx) => {
      await tx.insert(facetTerms).values({
        circleId: circleB.id,
        dimensionKey: 'city',
        slug: 'tokyo',
        label: '东京',
      })
      const visibleB = await tx.select().from(facetTerms)
      expect(visibleB.map((t) => t.slug)).toEqual(['tokyo'])
    })

    await withCircle(database.db, circleA.id, async (tx) => {
      const visibleA = await tx.select().from(facetTerms)
      expect(visibleA.map((t) => t.slug)).toEqual(['shanghai'])
    })
  })
})
