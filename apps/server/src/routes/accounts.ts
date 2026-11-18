import { createRoute, z } from '@hono/zod-openapi'
import {
  ACCOUNT_LINK_TTL_HOURS,
  AccountLink,
  AdminAccount,
  AdminAccountList,
  CreateAccountRequest,
  CreatedAccount,
  ErrorResponse,
  UpdateAccountRequest,
  type AccountLinkPurpose,
} from '@kioku/contracts'
import { and, asc, count, eq, gt, inArray, isNull, max, ne, sql } from 'drizzle-orm'

import { createPersonalCircle, personalCircleName } from '../access/circles'
import { lockAsAdmin, requireConsole, requireInstanceAdmin } from '../auth/middleware'
import { hashToken, newToken } from '../auth/session'
import type { Db, Tx } from '../db/client'
import { accountLinks, accounts, circleMembers, circles, sessions } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

export { personalCircleName }

const AccountParams = z.object({ accountId: z.uuid() })
const forbidden = jsonResponse('需要实例管理员', ErrorResponse)
const notFound = jsonResponse('账号不存在', ErrorResponse)

type AccountRow = typeof accounts.$inferSelect

async function describeAccounts(db: Db | Tx, rows: AccountRow[]): Promise<AdminAccount[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const memberships = await db
    .select({
      accountId: circleMembers.accountId,
      id: circles.id,
      slug: circles.slug,
      name: circles.name,
      kind: circles.kind,
      role: circleMembers.role,
    })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .where(inArray(circleMembers.accountId, ids))
    .orderBy(asc(circles.kind), asc(circles.createdAt))

  const circleIds = [...new Set(memberships.map((m) => m.id))]
  const owners = circleIds.length
    ? await db
        .select({ circleId: circleMembers.circleId, n: count() })
        .from(circleMembers)
        .innerJoin(accounts, eq(accounts.id, circleMembers.accountId))
        .where(
          and(
            inArray(circleMembers.circleId, circleIds),
            eq(circleMembers.role, 'owner'),
            isNull(accounts.disabledAt),
          ),
        )
        .groupBy(circleMembers.circleId)
    : []
  const activeOwners = new Map(owners.map((o) => [o.circleId, o.n]))

  const activity = await db
    .select({ accountId: sessions.accountId, last: max(sessions.lastActiveAt) })
    .from(sessions)
    .where(and(inArray(sessions.accountId, ids), gt(sessions.expiresAt, sql`now()`)))
    .groupBy(sessions.accountId)

  const links = await db
    .select({
      accountId: accountLinks.accountId,
      purpose: accountLinks.purpose,
      expiresAt: accountLinks.expiresAt,
    })
    .from(accountLinks)
    .where(
      and(
        inArray(accountLinks.accountId, ids),
        isNull(accountLinks.usedAt),
        gt(accountLinks.expiresAt, sql`now()`),
      ),
    )
    .orderBy(asc(accountLinks.createdAt))
  const lastActive = new Map(activity.map((a) => [a.accountId, a.last]))
  const pending = new Map(links.map((l) => [l.accountId, l]))

  return rows.map((row) => {
    const link = pending.get(row.id)
    const last = lastActive.get(row.id)
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
      passwordSet: row.passwordHash !== null,
      disabledAt: row.disabledAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      lastActiveAt: last ? new Date(last).toISOString() : null,
      circles: memberships
        .filter((m) => m.accountId === row.id)
        .map(({ id, slug, name, kind, role }) => ({
          id,
          slug,
          name,
          kind,
          role,
          soleActiveOwner: role === 'owner' && !row.disabledAt && activeOwners.get(id) === 1,
        })),
      pendingLink: link ? { purpose: link.purpose, expiresAt: link.expiresAt.toISOString() } : null,
    }
  })
}

async function describeAccount(db: Db | Tx, accountId: string): Promise<AdminAccount | null> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId))
  return row ? (await describeAccounts(db, [row]))[0]! : null
}

async function issueLink(
  tx: Tx,
  account: { id: string; passwordHash: string | null },
  createdBy: string,
): Promise<AccountLink> {
  await tx
    .delete(accountLinks)
    .where(and(eq(accountLinks.accountId, account.id), isNull(accountLinks.usedAt)))
  const token = newToken()
  const purpose: AccountLinkPurpose = account.passwordHash === null ? 'setup' : 'reset'
  const [row] = await tx
    .insert(accountLinks)
    .values({
      accountId: account.id,
      purpose,
      tokenHash: hashToken(token),
      createdBy,
      expiresAt: sql`now() + make_interval(hours => ${ACCOUNT_LINK_TTL_HOURS})`,
    })
    .returning({ expiresAt: accountLinks.expiresAt })
  return { token, purpose, expiresAt: row!.expiresAt.toISOString() }
}

const listAccounts = createRoute({
  method: 'get',
  path: '/instance/accounts',
  tags: ['accounts'],
  summary: '实例里的全部账号：所属记忆圈与角色、最近活动、停用状态与待用的链接',
  responses: { 200: jsonResponse('账号列表', AdminAccountList), 403: forbidden },
})

const createAccount = createRoute({
  method: 'post',
  path: '/instance/accounts',
  tags: ['accounts'],
  summary:
    '新建账号：同时建一个不可删除的个人圈、本人是所有者；返回设置密码的一次性链接令牌（只返回这一次）',
  request: { body: jsonBody(CreateAccountRequest) },
  responses: {
    201: jsonResponse('已创建', CreatedAccount),
    403: forbidden,
    409: jsonResponse('用户名已被占用', ErrorResponse),
  },
})

const regenerateLink = createRoute({
  method: 'post',
  path: '/instance/accounts/{accountId}/link',
  tags: ['accounts'],
  summary:
    '重新生成一次性链接（重置密码也用它）：作废没用过的旧链接；不改现在的密码，链接用掉时才改',
  request: { params: AccountParams },
  responses: {
    201: jsonResponse('新链接', AccountLink),
    403: forbidden,
    404: notFound,
    409: jsonResponse('账号已停用', ErrorResponse),
  },
})

const updateAccount = createRoute({
  method: 'patch',
  path: '/instance/accounts/{accountId}',
  tags: ['accounts'],
  summary:
    '修改账号：显示名、管理员身份、停用与启用。不能改自己的管理员身份与停用状态，至少保留一个可用的管理员；停用时清掉会话与链接',
  request: { params: AccountParams, body: jsonBody(UpdateAccountRequest) },
  responses: {
    200: jsonResponse('已修改', AdminAccount),
    400: jsonResponse('不能改自己的管理员身份或停用状态', ErrorResponse),
    403: forbidden,
    404: notFound,
    409: jsonResponse('至少保留一个可用的管理员', ErrorResponse),
  },
})

export function accountRoutes(deps: Deps) {
  const app = router()
  for (const path of ['/instance/accounts', '/instance/accounts/*']) {
    app.use(path, requireConsole(deps), requireInstanceAdmin(deps))
  }
  return app
    .openapi(listAccounts, async (c) => {
      const rows = await deps.db.select().from(accounts).orderBy(asc(accounts.createdAt))
      return c.json({ accounts: await describeAccounts(deps.db, rows) }, 200)
    })
    .openapi(createAccount, async (c) => {
      const body = c.req.valid('json')
      const actor = c.get('console').accountId
      const created = await deps.db.transaction(async (tx) => {
        if (!(await lockAsAdmin(tx, actor))) return 'forbidden' as const
        const [account] = await tx
          .insert(accounts)
          .values({
            username: body.username,
            displayName: body.displayName,
            passwordHash: null,
            isAdmin: body.isAdmin,
          })
          .onConflictDoNothing({ target: accounts.username })
          .returning()
        if (!account) return null
        await createPersonalCircle(tx, account)
        const link = await issueLink(tx, account, actor)
        return { account: (await describeAccount(tx, account.id))!, link }
      })
      if (created === 'forbidden') return c.json({ error: '需要实例管理员' }, 403)
      if (!created) return c.json({ error: '用户名已被占用' }, 409)
      return c.json(created, 201)
    })
    .openapi(regenerateLink, async (c) => {
      const { accountId } = c.req.valid('param')
      const actor = c.get('console').accountId
      const result = await deps.db.transaction(async (tx) => {
        if (!(await lockAsAdmin(tx, actor))) return 'forbidden' as const
        await tx
          .select({ id: accountLinks.id })
          .from(accountLinks)
          .where(eq(accountLinks.accountId, accountId))
          .for('update')
        const [account] = await tx
          .select({
            id: accounts.id,
            passwordHash: accounts.passwordHash,
            disabledAt: accounts.disabledAt,
          })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for('update')
        if (!account) return 'missing' as const
        if (account.disabledAt) return 'disabled' as const
        return issueLink(tx, account, actor)
      })
      if (result === 'forbidden') return c.json({ error: '需要实例管理员' }, 403)
      if (result === 'missing') return c.json({ error: '账号不存在' }, 404)
      if (result === 'disabled') return c.json({ error: '账号已停用，先启用再生成链接' }, 409)
      return c.json(result, 201)
    })
    .openapi(updateAccount, async (c) => {
      const { accountId } = c.req.valid('param')
      const body = c.req.valid('json')
      const actor = c.get('console').accountId
      const result = await deps.db.transaction(async (tx) => {
        if (!(await lockAsAdmin(tx, actor))) return 'forbidden' as const
        await tx
          .select({ id: accountLinks.id })
          .from(accountLinks)
          .where(eq(accountLinks.accountId, accountId))
          .for('update')
        const [target] = await tx
          .select()
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for('update')
        if (!target) return 'missing' as const
        const disable = body.disabled !== undefined && body.disabled !== Boolean(target.disabledAt)
        const adminChange = body.isAdmin !== undefined && body.isAdmin !== target.isAdmin
        if (accountId === actor && (disable || adminChange)) return 'self' as const
        const usableAdmin = target.isAdmin && !target.disabledAt
        const staysUsableAdmin =
          (adminChange ? body.isAdmin! : target.isAdmin) &&
          !(disable ? body.disabled! : target.disabledAt)
        if (usableAdmin && !staysUsableAdmin) {
          const [others] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(accounts)
            .where(
              and(
                eq(accounts.isAdmin, true),
                isNull(accounts.disabledAt),
                ne(accounts.id, accountId),
              ),
            )
          if (!others?.n) return 'last-admin' as const
        }
        if (disable && body.disabled) {
          await tx.delete(accountLinks).where(eq(accountLinks.accountId, accountId))
          await tx.delete(sessions).where(eq(sessions.accountId, accountId))
        }
        const changes = {
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          ...(adminChange ? { isAdmin: body.isAdmin! } : {}),
          ...(disable ? { disabledAt: body.disabled ? sql`now()` : null } : {}),
        }
        if (Object.keys(changes).length) {
          await tx.update(accounts).set(changes).where(eq(accounts.id, accountId))
        }
        return (await describeAccount(tx, accountId))!
      })
      if (result === 'forbidden') return c.json({ error: '需要实例管理员' }, 403)
      if (result === 'missing') return c.json({ error: '账号不存在' }, 404)
      if (result === 'self') return c.json({ error: '不能修改自己的管理员身份或停用状态' }, 400)
      if (result === 'last-admin') return c.json({ error: '至少保留一个可用的实例管理员' }, 409)
      return c.json(result, 200)
    })
}
