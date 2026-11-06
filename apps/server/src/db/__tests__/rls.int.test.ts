import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  openTestDatabase,
  resetDatabase,
  summaryConversation,
  testDatabaseUrl,
} from '../../testing/db'
import { assertRuntimeRole, pgConstraint, withSpace, type Database, type Tx } from '../client'
import {
  accounts,
  apiKeys,
  apps,
  conversations,
  conversationTurns,
  memories,
  personas,
  RLS_TABLES,
  spaces,
  subjects,
} from '../schema'

describe.skipIf(!testDatabaseUrl)('数据层与空间隔离', () => {
  let database: Database
  let spaceA: string
  let spaceB: string
  let accountId: string

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    const { db } = database
    await resetDatabase(database)
    const [a, b] = await db
      .insert(spaces)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning({ id: spaces.id })
    spaceA = a!.id
    spaceB = b!.id
    const [acc] = await db
      .insert(accounts)
      .values({ username: 'alice', displayName: 'Alice', passwordHash: 'x' })
      .returning({ id: accounts.id })
    accountId = acc!.id
  })

  const baseMemory = (spaceId: string, path: string) => ({
    spaceId,
    form: 'curated' as const,
    layer: 'core' as const,
    sensitivity: 'public' as const,
    provenance: 'owner' as const,
    domain: 'core',
    path,
    title: `标题 ${path}`,
    content: `内容 ${path}`,
  })
  const inA = <T>(fn: (tx: Tx) => Promise<T>) => withSpace(database.db, spaceA, fn)
  // 写入违反了哪一条约束；没有出错时为 undefined
  const violation = (write: Promise<unknown>) =>
    write.then(
      () => undefined,
      (err: unknown) => pgConstraint(err),
    )
  // 本人的记忆：开头是 user://，带所属成员
  const userMemory = () => ({
    layer: 'user' as const,
    domain: 'user',
    ownerAccountId: accountId,
    sensitivity: 'internal' as const,
  })
  // 来自对话的记忆：没有坐标与标题
  const extracted = { form: 'extracted' as const, domain: null, path: null, title: null }

  it('应用角色不是超级用户，也没有 BYPASSRLS', async () => {
    await expect(assertRuntimeRole(database.db)).resolves.toBeUndefined()
  })

  it('每张带 space_id 的内容表都开启并强制了 RLS', async () => {
    const rows = await database.db.execute<{ relname: string }>(sql`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity
      order by c.relname`)
    expect(rows.map((r) => r.relname).sort()).toEqual([...RLS_TABLES].sort())

    const withSpaceId = await database.db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'space_id'`)
    const identityTables = ['api_keys', 'space_members']
    expect(
      withSpaceId
        .map((r) => r.table_name)
        .filter((t) => !identityTables.includes(t))
        .sort(),
    ).toEqual([...RLS_TABLES].sort())
  })

  it('没有声明空间时读不到任何内容，也写不进去', async () => {
    await withSpace(database.db, spaceA, (tx) =>
      tx.insert(memories).values(baseMemory(spaceA, 'a')),
    )
    const visible = await database.db.select().from(memories)
    expect(visible).toHaveLength(0)
    await expect(database.db.insert(memories).values(baseMemory(spaceA, 'b'))).rejects.toThrow()
  })

  it('一个空间看不到另一个空间的记忆', async () => {
    await withSpace(database.db, spaceA, (tx) =>
      tx.insert(memories).values(baseMemory(spaceA, 'a')),
    )
    await withSpace(database.db, spaceB, (tx) =>
      tx.insert(memories).values(baseMemory(spaceB, 'b')),
    )

    const readA = await withSpace(database.db, spaceA, (tx) => tx.select().from(memories))
    expect(readA.map((m) => m.path)).toEqual(['a'])
    const readB = await withSpace(database.db, spaceB, (tx) => tx.select().from(memories))
    expect(readB.map((m) => m.path)).toEqual(['b'])
  })

  it('在 A 空间的事务里写 B 空间的数据会被拒绝', async () => {
    await expect(
      withSpace(database.db, spaceA, (tx) => tx.insert(memories).values(baseMemory(spaceB, 'x'))),
    ).rejects.toThrow()
  })

  it('记忆不能挂到别的空间的人格上', async () => {
    const [persona] = await withSpace(database.db, spaceB, (tx) =>
      tx
        .insert(personas)
        .values({ spaceId: spaceB, slug: 'doubao', name: '豆包' })
        .returning({ id: personas.id }),
    )
    await expect(
      withSpace(database.db, spaceA, (tx) =>
        tx.insert(memories).values({
          ...baseMemory(spaceA, 'doubao/soul'),
          layer: 'persona',
          domain: 'persona',
          personaId: persona!.id,
        }),
      ),
    ).rejects.toThrow()
  })

  it('secret 级不允许存明文', async () => {
    expect(
      await violation(
        inA((tx) =>
          tx.insert(memories).values({
            ...baseMemory(spaceA, 'pw'),
            ...userMemory(),
            sensitivity: 'secret',
          }),
        ),
      ),
    ).toBe('memories_secret_encrypted')
  })

  it('untrusted 来源不能写本人', async () => {
    expect(
      await violation(
        inA((tx) =>
          tx.insert(memories).values({
            ...baseMemory(spaceA, 'p'),
            ...userMemory(),
            provenance: 'untrusted',
          }),
        ),
      ),
    ).toBe('memories_untrusted_layers')
  })

  it('本人要有所属成员、不收公开；别的记下的归属没有所属成员', async () => {
    await inA((tx) => tx.insert(memories).values({ ...baseMemory(spaceA, 'u'), ...userMemory() }))
    expect(
      await violation(
        inA((tx) =>
          tx
            .insert(memories)
            .values({ ...baseMemory(spaceA, 'n'), ...userMemory(), ownerAccountId: null }),
        ),
      ),
    ).toBe('memories_owner_by_layer')
    expect(
      await violation(
        inA((tx) =>
          tx
            .insert(memories)
            .values({ ...baseMemory(spaceA, 'p'), ...userMemory(), sensitivity: 'public' }),
        ),
      ),
    ).toBe('memories_user_not_public')
    expect(
      await violation(
        inA((tx) =>
          tx.insert(memories).values({ ...baseMemory(spaceA, 'c'), ownerAccountId: accountId }),
        ),
      ),
    ).toBe('memories_owner_by_layer')
  })

  it('记下的四类有坐标与标题、坐标的开头就是归属；来自对话的两类都没有', async () => {
    expect(
      await violation(
        inA((tx) => tx.insert(memories).values({ ...baseMemory(spaceA, 't'), title: null })),
      ),
    ).toBe('memories_title_by_form')
    expect(
      await violation(
        inA((tx) =>
          tx
            .insert(memories)
            .values({ ...baseMemory(spaceA, 'd'), ...userMemory(), domain: 'core' }),
        ),
      ),
    ).toBe('memories_domain_by_layer')
    // 来自对话的两类不能是记下的（开头凑成和归属一样也不行），记下的四类也不能是来自对话的
    expect(
      await violation(
        inA(async (tx) =>
          tx.insert(memories).values({
            ...baseMemory(spaceA, 'e'),
            layer: 'episode',
            domain: 'episode',
            conversationId: await summaryConversation(tx, spaceA),
          }),
        ),
      ),
    ).toBe('memories_form_by_layer')
    expect(
      await violation(
        inA((tx) => tx.insert(memories).values({ ...baseMemory(spaceA, 'x'), ...extracted })),
      ),
    ).toBe('memories_form_by_layer')
    expect(
      await violation(
        inA(async (tx) =>
          tx.insert(memories).values({
            ...baseMemory(spaceA, 'x'),
            ...extracted,
            layer: 'episode',
            title: '摘要',
            conversationId: await summaryConversation(tx, spaceA),
          }),
        ),
      ),
    ).toBe('memories_title_by_form')
    // 会话摘要都挂在会话上
    expect(
      await violation(
        inA((tx) =>
          tx
            .insert(memories)
            .values({ ...baseMemory(spaceA, 'x'), ...extracted, layer: 'episode' }),
        ),
      ),
    ).toBe('memories_episode_conversation')
  })

  // 一个应用、一个 Key、一个群与一个人，会话与对话缓冲要挂在它们上面
  async function chatFixtures() {
    return inA(async (tx) => {
      const [app] = await tx
        .insert(apps)
        .values({
          spaceId: spaceA,
          slug: 'qq-bot',
          name: '群聊机器人',
          runtimeFamily: 'astrbot',
          ownerAccountId: accountId,
        })
        .returning({ id: apps.id })
      const [key] = await tx
        .insert(apiKeys)
        .values({
          spaceId: spaceA,
          appId: app!.id,
          name: 'k',
          prefix: 'kk_test',
          secretHash: 'x',
          scopes: { readLayers: [], writeLayers: [], maxSensitivity: 'public', admin: false },
        })
        .returning({ id: apiKeys.id })
      const [group, person] = await tx
        .insert(subjects)
        .values([
          { spaceId: spaceA, kind: 'group', displayName: '读书会' },
          { spaceId: spaceA, kind: 'person', displayName: '小明' },
        ])
        .returning({ id: subjects.id })
      return { appId: app!.id, keyId: key!.id, groupId: group!.id, personId: person!.id }
    })
  }

  it('会话按种类带群或人、或者所属成员；同一个应用里一个群、一个人、一个成员各只有一个会话', async () => {
    const { appId, groupId, personId } = await chatFixtures()
    const conversation = (
      kind: 'group' | 'direct' | 'none',
      subjectId: string | null,
      ownerAccountId: string | null,
    ) =>
      inA((tx) =>
        tx
          .insert(conversations)
          .values({ spaceId: spaceA, appId, kind, subjectId, ownerAccountId }),
      )
    await conversation('group', groupId, null)
    await conversation('direct', personId, null)
    await conversation('none', null, accountId)
    expect(await violation(conversation('group', groupId, null))).toBe('conversations_subject_idx')
    expect(await violation(conversation('none', null, accountId))).toBe('conversations_owner_idx')
    for (const [kind, subjectId, owner] of [
      ['none', personId, accountId],
      ['none', null, null],
      ['direct', null, accountId],
      ['group', groupId, accountId],
    ] as const) {
      expect(await violation(conversation(kind, subjectId, owner)), kind).toBe(
        'conversations_kind_shape',
      )
    }
  })

  it('删掉会话时会话摘要跟着删，在这里听到的事实只断开关联；删应用时级联删会话也一样', async () => {
    const { appId, groupId, personId } = await chatFixtures()
    const setup = () =>
      inA(async (tx) => {
        const [conversation] = await tx
          .insert(conversations)
          .values({ spaceId: spaceA, appId, kind: 'group', subjectId: groupId })
          .returning({ id: conversations.id })
        const common = {
          spaceId: spaceA,
          sensitivity: 'public' as const,
          provenance: 'untrusted' as const,
          originScope: `group:${groupId}`,
          conversationId: conversation!.id,
          ...extracted,
        }
        const [summary, fact] = await tx
          .insert(memories)
          .values([
            { ...common, layer: 'episode', content: '聊了读书会的安排' },
            { ...common, layer: 'subject', subjectId: personId, content: '小明在学日语' },
          ])
          .returning({ id: memories.id })
        return { conversationId: conversation!.id, summaryId: summary!.id, factId: fact!.id }
      })
    const remaining = (ids: string[]) =>
      inA((tx) =>
        tx
          .select({ id: memories.id, conversationId: memories.conversationId })
          .from(memories)
          .where(inArray(memories.id, ids)),
      )

    const deleted = await setup()
    await inA((tx) => tx.delete(conversations).where(eq(conversations.id, deleted.conversationId)))
    expect(await remaining([deleted.summaryId, deleted.factId])).toEqual([
      { id: deleted.factId, conversationId: null },
    ])

    const cascaded = await setup()
    await inA((tx) => tx.delete(apps).where(eq(apps.id, appId)))
    expect(await remaining([cascaded.summaryId, cascaded.factId])).toEqual([
      { id: cascaded.factId, conversationId: null },
    ])
  })

  it('不带会话上下文的会话也写摘要，归所属成员；记下的四类不挂会话', async () => {
    const { appId } = await chatFixtures()
    const [conversation] = await inA((tx) =>
      tx
        .insert(conversations)
        .values({ spaceId: spaceA, appId, kind: 'none', ownerAccountId: accountId })
        .returning({ id: conversations.id }),
    )
    await inA((tx) =>
      tx.insert(memories).values({
        spaceId: spaceA,
        layer: 'episode',
        sensitivity: 'private',
        provenance: 'agent',
        ownerAccountId: accountId,
        conversationId: conversation!.id,
        content: '讨论了记忆架构改版',
        ...extracted,
      }),
    )
    expect(
      await violation(
        inA((tx) =>
          tx
            .insert(memories)
            .values({ ...baseMemory(spaceA, 'c'), conversationId: conversation!.id }),
        ),
      ),
    ).toBe('memories_conversation_by_layer')
  })

  it('对话缓冲收不带会话上下文的轮次：没有群与发言人，记所属成员', async () => {
    const { appId, keyId, groupId, personId } = await chatFixtures()
    const turn = (chatType: string, ids: { group?: string; sender?: string; owner?: string }) =>
      inA((tx) =>
        tx.insert(conversationTurns).values({
          spaceId: spaceA,
          appId,
          keyId,
          scope: 'test',
          sessionId: 's',
          chatType,
          groupSubjectId: ids.group ?? null,
          senderSubjectId: ids.sender ?? null,
          ownerAccountId: ids.owner ?? null,
          userText: '你好',
          replyText: '你好',
        }),
      )
    await turn('none', { owner: accountId })
    await turn('direct', { sender: personId })
    await turn('group', { group: groupId, sender: personId })
    await turn('channel', { group: groupId, sender: personId })
    for (const [chatType, ids] of [
      ['none', {}],
      ['none', { owner: accountId, sender: personId }],
      ['direct', { sender: personId, owner: accountId }],
      ['direct', {}],
      ['group', { group: groupId }],
      ['cron', { owner: accountId }],
    ] as const) {
      expect(await violation(turn(chatType, ids)), `${chatType} ${JSON.stringify(ids)}`).toBe(
        'conversation_turns_chat_type',
      )
    }
  })

  it('中文全文检索配置能分词', async () => {
    const rows = await database.db.execute<{ v: string }>(
      sql`select to_tsvector('kioku_zh', '记忆分层与授权')::text as v`,
    )
    expect(rows[0]!.v).toContain('记忆')
  })
})
