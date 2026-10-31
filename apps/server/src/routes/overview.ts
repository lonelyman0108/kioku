import { createRoute, z } from '@hono/zod-openapi'
import { ErrorResponse, InboxCounts, SpaceOverview } from '@kioku/contracts'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { pendingBindingsFor } from '../access/binding'
import { isInstanceAdmin } from '../auth/middleware'
import { backupSettingsView } from '../backup/settings'
import { withSpace, type Db } from '../db/client'
import { apiKeys, apps, spaceMembers } from '../db/schema'
import { embeddingSettingsView } from '../embedding/settings'
import { extractionUsage } from '../extraction/budget'
import type { Deps } from '../http/env'
import { jsonResponse, router } from '../http/openapi'
import { consoleMemberFor, consoleRoleFor, memoryServiceForConsole } from '../memory/context'
import { inboxCounts } from '../memory/inbox'
import { loadRecallWindow } from '../recall/retention'

// 概览里列出的最近改动数
const RECENT_LIMIT = 8
// 概览里最多列出这么多条等查看者确认的绑定
const PENDING_BINDINGS_LIMIT = 20

const overview = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/overview',
  tags: ['console'],
  summary:
    '空间概览：记忆的分布、向量覆盖率、本月抽取的用量、各应用 Key 的使用情况、等你确认的绑定，实例管理员还看得到备份的情况',
  request: { params: z.object({ spaceId: z.uuid() }) },
  responses: {
    200: jsonResponse('概览', SpaceOverview),
    403: jsonResponse('不是该空间成员', ErrorResponse),
  },
})

const counts = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/inbox/counts',
  tags: ['console'],
  summary: '待处理的四类（账号绑定、待确认内容、Dream 的建议、疑似明文）各有多少条，导航角标用',
  request: { params: z.object({ spaceId: z.uuid() }) },
  responses: {
    200: jsonResponse('待处理总数', InboxCounts),
    403: jsonResponse('不是该空间成员', ErrorResponse),
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

export function overviewRoutes(deps: Deps) {
  const app = router().openapi(counts, async (c) => {
    const { spaceId } = c.req.valid('param')
    const accountId = c.get('console').accountId
    const { role, service } = await consoleMemberFor(deps, spaceId, accountId)
    return c.json(await inboxCounts(deps.db, spaceId, service, { accountId, role }), 200)
  })
  return app.openapi(overview, async (c) => {
    const { spaceId } = c.req.valid('param')
    const accountId = c.get('console').accountId
    // 先确认是成员，不是成员就不去查别的空间的数据
    const role = await consoleRoleFor(deps, spaceId, accountId)
    const [settings, recall, appRows, members, extraction, backup, pendingBindings] =
      await Promise.all([
        embeddingSettingsView(deps.db),
        loadRecallWindow(deps.db, spaceId),
        withSpace(deps.db, spaceId, (tx) => tx.select().from(apps).orderBy(apps.createdAt)),
        deps.db
          .select({ accountId: spaceMembers.accountId, since: spaceMembers.createdAt })
          .from(spaceMembers)
          .where(eq(spaceMembers.spaceId, spaceId)),
        extractionUsage(deps.db, spaceId),
        backupSummary(deps.db, accountId),
        withSpace(deps.db, spaceId, (tx) =>
          pendingBindingsFor(tx, { accountId, role }, PENDING_BINDINGS_LIMIT),
        ),
      ])
    // 应用表只读上面这一次：editor 能写哪些应用的应用层也从这里挑
    const service = await memoryServiceForConsole(deps, spaceId, accountId, role, appRows)
    const [stats, recent] = await Promise.all([
      service.stats(settings.active?.model ?? null, {
        retentionDays: recall.settings.retentionDays,
        recordingSince: recall.recordingSince,
      }),
      service.activity({ limit: RECENT_LIMIT }),
    ])
    // 疑似明文的条数上面算过了
    const inbox = await inboxCounts(
      deps.db,
      spaceId,
      service,
      { accountId, role },
      stats.plaintextCredentials,
    )
    // Key 的情况与 Key 列表一样，只给应用主人和空间 owner 看
    const visible = appRows
      .filter((a) => role === 'owner' || a.ownerAccountId === accountId)
      .map((a) => a.id)
    const keyRows = visible.length
      ? await deps.db
          .select({
            appId: apiKeys.appId,
            createdAt: apiKeys.createdAt,
            lastUsedAt: apiKeys.lastUsedAt,
          })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.spaceId, spaceId),
              inArray(apiKeys.appId, visible),
              isNull(apiKeys.revokedAt),
            ),
          )
      : []
    // 有效的 Key 与鉴权的规则一致：没吊销、应用主人还在空间里、是主人这次加入之后签发的
    const since = new Map(members.map((m) => [m.accountId, m.since]))
    const ownerOf = new Map(appRows.map((a) => [a.id, a.ownerAccountId]))
    const keysByApp = new Map<string, { active: number; lastUsedAt: Date | null }>()
    for (const k of keyRows) {
      const joined = since.get(ownerOf.get(k.appId) ?? '')
      if (!joined || k.createdAt < joined) continue
      const agg = keysByApp.get(k.appId) ?? { active: 0, lastUsedAt: null }
      agg.active += 1
      if (k.lastUsedAt && (!agg.lastUsedAt || k.lastUsedAt > agg.lastUsedAt)) {
        agg.lastUsedAt = k.lastUsedAt
      }
      keysByApp.set(k.appId, agg)
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
        apps: appRows.map((a) => {
          const keys = keysByApp.get(a.id)
          return {
            id: a.id,
            slug: a.slug,
            name: a.name,
            runtimeFamily: a.runtimeFamily,
            ownerAccountId: a.ownerAccountId,
            keys: visible.includes(a.id)
              ? { active: keys?.active ?? 0, lastUsedAt: keys?.lastUsedAt?.toISOString() ?? null }
              : null,
          }
        }),
        recent: recent.items,
        backup,
        pendingBindings,
        inbox,
      },
      200,
    )
  })
}
