import { fileURLToPath } from 'node:url'

import { and, asc, eq, sql } from 'drizzle-orm'
import { pgTable, text, type PgTable } from 'drizzle-orm/pg-core'

import { connect, withCircle, type Database, type Db, type Tx } from '../db/client'
import { runMigrations } from '../db/migrate'
import { accounts, clients, conversations, settings, subjects } from '../db/schema'
import { settleRecallEvents } from '../recall/pending'
import { settleUpdateChecks } from '../settings/updateCheck'
import { testWorkers, workerDatabaseUrl } from './workers'

// 集成测试共用：需要真实 PostgreSQL。本地用 docker-compose.dev.yml 起库后设置 KIOKU_TEST_DATABASE_URL；
// CI 里必须提供，没有就失败，避免集成测试被悄悄跳过。并行时每个 worker 换成自己的库，见 workers.ts
const baseUrl = process.env.KIOKU_TEST_DATABASE_URL
if (!baseUrl && process.env.CI) throw new Error('CI 环境缺少 KIOKU_TEST_DATABASE_URL')
export const testDatabaseUrl =
  baseUrl && workerDatabaseUrl(baseUrl, testWorkers(), process.env.VITEST_POOL_ID)

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url))

export async function openTestDatabase(): Promise<Database> {
  const database = connect(testDatabaseUrl!, { max: 2 })
  await runMigrations(database, migrationsFolder)
  // 实例设置不挂在 circles、accounts 下，resetDatabase 清不到。每个文件开始时清掉：同一个库上先跑的文件
  // 留下的设置（比如换过的嵌入模型）会让后面的文件读错，并行时每次跑的先后还不一样。
  // 文件自己在 beforeAll 里写的设置在这之后，照常保留
  await database.db.execute(sql`truncate settings`)
  return database
}

// 服务端判断有效期只用数据库的钟，测试里要算「现在之后多久」的时间（写进库的有效到、请求里的有效到）也从
// 数据库的时间算，不用应用的 Date.now()：两个钟会差，拨应用的钟测偏差时尤其如此
export { databaseNow } from '../db/client'

// 清空所有数据；内容表都挂在 circles 或 accounts 下，级联即可。先等上一个用例还没写完的召回事件
export async function resetDatabase(database: Database): Promise<void> {
  await Promise.all([settleRecallEvents(), settleUpdateChecks()])
  await database.db.execute(sql`truncate circles, accounts, login_attempts cascade`)
}

// 这条连接（事务句柄就是事务所在的连接）的后端进程号，杀连接时用
export async function backendOf(db: Db | Tx): Promise<number> {
  const [row] = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
  return row!.pid
}

// 杀掉这个后端，返回事务 reject 的错误；事务没有 reject 时抛错。先接住事务的 promise 再杀：
// kill 的响应回来之前事务可能已经 reject 了，那时还没人接就算未处理的 rejection
export async function killDuring(
  via: Db,
  pid: number,
  transaction: Promise<unknown>,
): Promise<unknown> {
  const rejection = transaction.then(
    () => {
      throw new Error('连接被杀了，事务却没有 reject')
    },
    (err: unknown) => err,
  )
  await via.execute(sql`select pg_terminate_backend(${pid})`)
  return rejection
}

// 读实例设置时数据库真的报错（改查一张不存在的表），别的查询照常，事务里也一样。drizzle 的错误信息带 SQL 与全部参数
const NO_SUCH_TABLE = pgTable('no_such_table', { key: text() })
export const settingsQueryFails = (db: Db): Db =>
  new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') {
        return (run: (tx: Db) => Promise<unknown>) =>
          target.transaction((tx) => run(settingsQueryFails(tx as unknown as Db)))
      }
      if (prop !== 'select') return Reflect.get(target, prop)
      return (...args: []) =>
        new Proxy(target.select(...args), {
          get(builder, method) {
            if (method !== 'from') return Reflect.get(builder, method)
            return (table: PgTable) => builder.from(table === settings ? NO_SUCH_TABLE : table)
          },
        })
    },
  })

// 所有表的内容：回滚之后、不该写库的操作之后，要和之前逐行相同
export async function tableDigests(
  database: Database,
  circleId: string,
): Promise<Record<string, string>> {
  const tables = await database.db.execute<{ name: string }>(sql`
    select table_name as name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)
  return withCircle(database.db, circleId, async (tx) => {
    const out: Record<string, string> = {}
    for (const { name } of tables) {
      const [row] = await tx.execute<{ n: number; digest: string }>(
        sql.raw(`select count(*)::int as n,
          md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest
          from "${name}" t`),
      )
      out[name] = `${row!.n}:${row!.digest}`
    }
    return out
  })
}

async function ensureTestConversation(
  tx: Tx,
  circleId: string,
  clientId: string,
  target:
    | { kind: 'none'; ownerAccountId: string; deviceKey?: string; projectSlug?: string }
    | { kind: 'group' | 'direct'; subjectId: string },
): Promise<string> {
  if (target.kind === 'none') {
    const deviceKey = target.deviceKey ?? ''
    const projectSlug = target.projectSlug ?? ''
    const [existing] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.clientId, clientId),
          eq(conversations.kind, 'none'),
          eq(conversations.ownerAccountId, target.ownerAccountId),
          eq(conversations.deviceKey, deviceKey),
          eq(conversations.projectSlug, projectSlug),
        ),
      )
      .limit(1)
    if (existing) return existing.id
    const [created] = await tx
      .insert(conversations)
      .values({
        circleId,
        clientId,
        kind: 'none',
        ownerAccountId: target.ownerAccountId,
        deviceKey,
        projectSlug,
      })
      .returning({ id: conversations.id })
    return created!.id
  }
  const [existing] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.clientId, clientId), eq(conversations.subjectId, target.subjectId)))
    .limit(1)
  if (existing) return existing.id
  const [created] = await tx
    .insert(conversations)
    .values({
      circleId,
      clientId,
      kind: target.kind,
      subjectId: target.subjectId,
    })
    .returning({ id: conversations.id })
  return created!.id
}

// 直接往库里写会话摘要的测试用：会话摘要都要挂在会话上（约束 entries_shape_by_kind）。
// 用这个记忆圈里最早的接入端（没有就建一个，所有者取最早的账号，也没有账号时建一个）不带会话上下文的会话；
// 要测群聊、私聊的会话时另外建
export async function summaryConversation(tx: Tx, circleId: string): Promise<string> {
  const [client] = await tx
    .select({ id: clients.id, ownerAccountId: clients.ownerAccountId })
    .from(clients)
    .where(eq(clients.circleId, circleId))
    .orderBy(asc(clients.createdAt), asc(clients.id))
    .limit(1)
  let target = client
  if (!target) {
    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .orderBy(asc(accounts.createdAt))
      .limit(1)
    const owner =
      account ??
      (
        await tx
          .insert(accounts)
          .values({ username: 'summaries', displayName: '会话摘要', passwordHash: 'x' })
          .returning({ id: accounts.id })
      )[0]!
    ;[target] = await tx
      .insert(clients)
      .values({
        circleId,
        slug: 'summaries',
        name: '会话摘要',
        runtimeFamily: 'mcp',
        ownerAccountId: owner.id,
      })
      .returning({ id: clients.id, ownerAccountId: clients.ownerAccountId })
  }
  return ensureTestConversation(tx, circleId, target!.id, {
    kind: 'none',
    ownerAccountId: target!.ownerAccountId,
  })
}

// 一个群和这个接入端在群里的会话：直接写群聊的会话摘要的测试用
export async function groupConversation(
  tx: Tx,
  circleId: string,
  clientId: string,
  name = '测试群',
): Promise<{ subjectId: string; conversationId: string }> {
  const [group] = await tx
    .insert(subjects)
    .values({ circleId, kind: 'group', displayName: name })
    .returning({ id: subjects.id })
  const conversationId = await ensureTestConversation(tx, circleId, clientId, {
    kind: 'group',
    subjectId: group!.id,
  })
  return { subjectId: group!.id, conversationId }
}

// 来源作用域对应的会话：group:<群> 是这个群的会话，direct:<联系人> 是和这个人的私聊；别的作用域用 summaryConversation
export async function conversationOfScope(
  tx: Tx,
  circleId: string,
  clientId: string,
  originScope: string,
): Promise<string> {
  const [kind, subjectId] = originScope.split(':') as [string, string | undefined]
  if ((kind === 'group' || kind === 'direct') && subjectId) {
    return ensureTestConversation(tx, circleId, clientId, { kind, subjectId })
  }
  return summaryConversation(tx, circleId)
}
