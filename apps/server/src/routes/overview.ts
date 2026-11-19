import { createRoute, z } from '@hono/zod-openapi'
import { CircleOverview, ErrorResponse, InboxCounts, LensKeyScopes } from '@kioku/contracts'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { keyEffectiveScopes } from '../access/access'
import { pendingBindingsFor } from '../access/binding'
import { isInstanceAdmin } from '../auth/middleware'
import { backupSettingsView } from '../backup/settings'
import { withCircle, type Db } from '../db/client'
import { accounts, apiKeys, circleMembers, clients } from '../db/schema'
import { embeddingSettingsView } from '../embedding/settings'
import { extractionUsage } from '../extraction/budget'
import type { Deps } from '../http/env'
import { jsonResponse, router } from '../http/openapi'
import { consoleMemberFor, consoleRoleFor, entryServiceForConsole } from '../memory/context'
import { inboxCounts } from '../memory/inbox'
import { loadUpdateStatus, startUpdateCheck, updateNotice } from '../settings/updateCheck'

// 概览里列出的最近改动数
const RECENT_LIMIT = 8
// 概览里最多列出这么多条等查看者确认的绑定
const PENDING_BINDINGS_LIMIT = 20

const overview = createRoute({
  method: 'get',
  path: '/circles/{circleId}/overview',
  tags: ['console'],
  summary:
    '记忆圈概览：词条分布、向量覆盖率、本月抽取用量、各接入实例密钥使用情况、等你确认的绑定，实例管理员还看得到备份情况',
  request: { params: z.object({ circleId: z.uuid() }) },
  responses: {
    200: jsonResponse('概览', CircleOverview),
    403: jsonResponse('不是该记忆圈成员', ErrorResponse),
  },
})

const counts = createRoute({
  method: 'get',
  path: '/circles/{circleId}/inbox/counts',
  tags: ['console'],
  summary: '待处理的五类（账号绑定、待确认内容、Dream 建议、疑似敏感内容、即将到期凭据）数量',
  request: { params: z.object({ circleId: z.uuid() }) },
  responses: {
    200: jsonResponse('待处理总数', InboxCounts),
    403: jsonResponse('不是该记忆圈成员', ErrorResponse),
  },
})

// 备份是整个实例的事，只给实例管理员看
async function backupSummary(db: Db, accountId: string) {
  if (!(await isInstanceAdmin(db, accountId))) return null
  const view = await backupSettingsView(db)
  return {
    configured: view.configured,
    lastSuccessAt: view.status.lastSuccess?.at ?? null,
    lastError: view.status.lastError,
  }
}

async function updateSummary(deps: Deps, accountId: string) {
  if (!(await isInstanceAdmin(deps.db, accountId))) return null
  const status = await loadUpdateStatus(deps.db)
  await startUpdateCheck(deps.db, deps.updateCheck, status)
  return updateNotice(status, deps.updateCheck?.current)
}

export function overviewRoutes(deps: Deps) {
  const app = router().openapi(counts, async (c) => {
    const { circleId } = c.req.valid('param')
    const accountId = c.get('console').accountId
    const { role, service } = await consoleMemberFor(deps, circleId, accountId)
    return c.json(await inboxCounts(deps.db, circleId, service, { accountId, role }), 200)
  })
  return app.openapi(overview, async (c) => {
    const { circleId } = c.req.valid('param')
    const accountId = c.get('console').accountId
    const role = await consoleRoleFor(deps, accountId, circleId)
    const [settings, clientRows, members, extraction, backup, update, pendingBindings, service] =
      await Promise.all([
        embeddingSettingsView(deps.db),
        withCircle(deps.db, circleId, (tx) => tx.select().from(clients).orderBy(clients.createdAt)),
        deps.db
          .select({
            accountId: circleMembers.accountId,
            role: circleMembers.role,
            memberSince: circleMembers.createdAt,
            disabledAt: accounts.disabledAt,
          })
          .from(circleMembers)
          .innerJoin(accounts, eq(accounts.id, circleMembers.accountId))
          .where(eq(circleMembers.circleId, circleId)),
        extractionUsage(deps.db, circleId),
        backupSummary(deps.db, accountId),
        updateSummary(deps, accountId),
        withCircle(deps.db, circleId, (tx) =>
          pendingBindingsFor(tx, { accountId, role }, PENDING_BINDINGS_LIMIT),
        ),
        entryServiceForConsole(deps, circleId, accountId),
      ])
    const [stats, recent] = await Promise.all([
      service.stats(),
      service.activity({ limit: RECENT_LIMIT }),
    ])
    const inbox = await inboxCounts(
      deps.db,
      circleId,
      service,
      { accountId, role },
      stats.plaintextCredentials,
    )
    const visible = clientRows
      .filter((cl) => role === 'owner' || cl.ownerAccountId === accountId)
      .map((cl) => cl.id)
    const keyRows = visible.length
      ? await deps.db
          .select({
            clientId: apiKeys.clientId,
            scopes: apiKeys.scopes,
            createdAt: apiKeys.createdAt,
            revokedAt: apiKeys.revokedAt,
            lastUsedAt: apiKeys.lastUsedAt,
          })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.circleId, circleId),
              inArray(apiKeys.clientId, visible),
              isNull(apiKeys.revokedAt),
            ),
          )
      : []
    const memberOf = new Map(members.map((m) => [m.accountId, m]))
    const ownerOf = new Map(clientRows.map((cl) => [cl.id, cl.ownerAccountId]))
    const keysByClient = new Map<string, { active: number; lastUsedAt: Date | null }>()
    for (const k of keyRows) {
      const owner = memberOf.get(ownerOf.get(k.clientId) ?? '')
      if (!keyEffectiveScopes({ ...k, scopes: LensKeyScopes.parse(k.scopes) }, owner)) continue
      const agg = keysByClient.get(k.clientId) ?? { active: 0, lastUsedAt: null }
      agg.active += 1
      if (k.lastUsedAt && (!agg.lastUsedAt || k.lastUsedAt > agg.lastUsedAt)) {
        agg.lastUsedAt = k.lastUsedAt
      }
      keysByClient.set(k.clientId, agg)
    }

    return c.json(
      {
        counts: stats.counts,
        total: stats.total,
        extractedCounts: stats.extractedCounts,
        missingDisclosure: stats.missingDisclosure,
        plaintextCredentials: stats.plaintextCredentials,
        neverRecalled: stats.neverRecalled,
        embedding: {
          configured: settings.active !== null,
          model: settings.active?.model ?? null,
          eligible: stats.eligible,
          embedded: stats.embedded,
        },
        extraction,
        clients: clientRows.map((cl) => {
          const keys = keysByClient.get(cl.id)
          return {
            id: cl.id,
            slug: cl.slug,
            name: cl.name,
            runtimeFamily: cl.runtimeFamily,
            ownerAccountId: cl.ownerAccountId,
            keys: visible.includes(cl.id)
              ? { active: keys?.active ?? 0, lastUsedAt: keys?.lastUsedAt?.toISOString() ?? null }
              : null,
          }
        }),
        recent: recent.items,
        backup,
        update,
        pendingBindings,
        inbox,
      },
      200,
    )
  })
}
