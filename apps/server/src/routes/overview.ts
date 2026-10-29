import { createRoute, z } from '@hono/zod-openapi'
import { ErrorResponse, SpaceOverview } from '@kioku/contracts'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { isInstanceAdmin } from '../auth/middleware'
import { backupSettingsView } from '../backup/settings'
import { withSpace, type Db } from '../db/client'
import { apiKeys, apps, spaceMembers } from '../db/schema'
import { embeddingSettingsView } from '../embedding/settings'
import { extractionUsage } from '../extraction/budget'
import type { Deps } from '../http/env'
import { jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
import { loadRecallWindow } from '../recall/retention'

// 概览里列出的最近改动数
const RECENT_LIMIT = 8

const overview = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/overview',
  tags: ['console'],
  summary:
    '空间概览：记忆的分布、向量覆盖率、本月抽取的用量、各应用 Key 的使用情况，实例管理员还看得到备份的情况',
  request: { params: z.object({ spaceId: z.uuid() }) },
  responses: {
    200: jsonResponse('概览', SpaceOverview),
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
  return router().openapi(overview, async (c) => {
    const { spaceId } = c.req.valid('param')
    const accountId = c.get('console').accountId
    // 先确认是成员，不是成员就不去查别的空间的数据
    const { role, service } = await consoleMemberFor(deps, spaceId, accountId)
    const [settings, recall, appRows, members, extraction, backup] = await Promise.all([
      embeddingSettingsView(deps.db),
      loadRecallWindow(deps.db),
      withSpace(deps.db, spaceId, (tx) => tx.select().from(apps).orderBy(apps.createdAt)),
      deps.db
        .select({ accountId: spaceMembers.accountId, since: spaceMembers.createdAt })
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, spaceId)),
      extractionUsage(deps.db, spaceId),
      backupSummary(deps.db, accountId),
    ])
    const [stats, recent] = await Promise.all([
      service.stats(settings.active?.model ?? null, {
        retentionDays: recall.settings.retentionDays,
        recordingSince: recall.recordingSince,
      }),
      service.activity({ limit: RECENT_LIMIT }),
    ])
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
      },
      200,
    )
  })
}
