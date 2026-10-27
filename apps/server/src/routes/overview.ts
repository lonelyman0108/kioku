import { createRoute, z } from '@hono/zod-openapi'
import { ErrorResponse, SpaceOverview } from '@kioku/contracts'
import { and, count, eq, inArray, isNull, max } from 'drizzle-orm'

import { memberRole } from '../auth/middleware'
import { withSpace } from '../db/client'
import { apiKeys, apps } from '../db/schema'
import { embeddingSettingsView } from '../embedding/settings'
import type { Deps } from '../http/env'
import { jsonResponse, router } from '../http/openapi'
import { memoryServiceForConsole } from '../memory/context'

const overview = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/overview',
  tags: ['console'],
  summary: '空间概览：记忆的分布、向量覆盖率与各应用 Key 的使用情况',
  request: { params: z.object({ spaceId: z.uuid() }) },
  responses: {
    200: jsonResponse('概览', SpaceOverview),
    403: jsonResponse('不是该空间成员', ErrorResponse),
  },
})

export function overviewRoutes(deps: Deps) {
  return router().openapi(overview, async (c) => {
    const { spaceId } = c.req.valid('param')
    const accountId = c.get('console').accountId
    const role = await memberRole(deps, spaceId, accountId)
    if (!role) return c.json({ error: '不是该空间成员' }, 403)

    const [settings, service, appRows] = await Promise.all([
      embeddingSettingsView(deps.db),
      memoryServiceForConsole(deps, spaceId, accountId, role),
      withSpace(deps.db, spaceId, (tx) => tx.select().from(apps).orderBy(apps.createdAt)),
    ])
    const stats = await service.stats(settings.model)
    // Key 的情况与 Key 列表一样，只给应用主人和空间 owner 看
    const visible = appRows
      .filter((a) => role === 'owner' || a.ownerAccountId === accountId)
      .map((a) => a.id)
    const keyRows = visible.length
      ? await deps.db
          .select({
            appId: apiKeys.appId,
            active: count(),
            lastUsedAt: max(apiKeys.lastUsedAt),
          })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.spaceId, spaceId),
              inArray(apiKeys.appId, visible),
              isNull(apiKeys.revokedAt),
            ),
          )
          .groupBy(apiKeys.appId)
      : []
    const keysByApp = new Map(keyRows.map((k) => [k.appId, k]))

    return c.json(
      {
        counts: stats.counts,
        total: stats.total,
        missingDisclosure: stats.missingDisclosure,
        embedding: {
          configured: settings.configured,
          model: settings.model,
          eligible: stats.eligible,
          embedded: stats.embedded,
        },
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
      },
      200,
    )
  })
}
