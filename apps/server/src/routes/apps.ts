import { createRoute, z } from '@hono/zod-openapi'
import {
  AppConfig,
  AppInfo,
  CreateAppRequest,
  CreatedKey,
  CreateKeyRequest,
  ErrorResponse,
  KeyAccessMatrix,
  KeyInfo,
  KeyScopes,
  UpdateAppRequest,
  type MemberRole,
} from '@kioku/contracts'
import { and, count, desc, eq, isNull } from 'drizzle-orm'

import { accessMatrix, keyEffectiveScopes } from '../access/access'
import { generateApiKey } from '../auth/keys'
import { memberRole } from '../auth/middleware'
import { withSpace } from '../db/client'
import { apiKeys, apps, memories, personas, spaceMembers } from '../db/schema'
import type { Tx } from '../db/client'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const SpaceParams = z.object({ spaceId: z.uuid() })
const AppParams = SpaceParams.extend({ appId: z.uuid() })
const KeyParams = AppParams.extend({ keyId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在', ErrorResponse)

const toAppInfo = (row: typeof apps.$inferSelect) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  runtimeFamily: row.runtimeFamily,
  ownerAccountId: row.ownerAccountId,
  defaultPersonaId: row.defaultPersonaId,
  config: AppConfig.parse(row.config),
})

// 应用主人现在在空间里的角色与加入时间；不在空间里时为 undefined。Key 的当前有效上限按它算
type OwnerMembership = { role: MemberRole; memberSince: Date } | undefined

const toKeyInfo = (row: typeof apiKeys.$inferSelect, owner: OwnerMembership) => {
  const scopes = KeyScopes.parse(row.scopes)
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes,
    effectiveScopes: keyEffectiveScopes({ ...row, scopes }, owner),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }
}

async function ownerMembership(
  deps: Deps,
  spaceId: string,
  accountId: string,
): Promise<OwnerMembership> {
  const [row] = await deps.db
    .select({ role: spaceMembers.role, memberSince: spaceMembers.createdAt })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, accountId)))
    .limit(1)
  return row
}

const listApps = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/apps',
  tags: ['apps'],
  summary: '列出空间里的接入应用',
  request: { params: SpaceParams },
  responses: { 200: jsonResponse('应用列表', z.array(AppInfo)), 403: forbidden },
})

const createApp = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/apps',
  tags: ['apps'],
  summary: '新建接入应用，创建者就是这个应用的主人',
  request: { params: SpaceParams, body: jsonBody(CreateAppRequest) },
  responses: {
    201: jsonResponse('已创建', AppInfo),
    403: forbidden,
    404: jsonResponse('默认人格不存在', ErrorResponse),
    409: jsonResponse('标识已被占用', ErrorResponse),
  },
})

const updateApp = createRoute({
  method: 'patch',
  path: '/spaces/{spaceId}/apps/{appId}',
  tags: ['apps'],
  summary: '修改应用名称、默认人格或配置',
  request: { params: AppParams, body: jsonBody(UpdateAppRequest) },
  responses: {
    200: jsonResponse('已修改', AppInfo),
    400: jsonResponse('新主人不是空间成员', ErrorResponse),
    403: forbidden,
    404: notFound,
  },
})

const deleteApp = createRoute({
  method: 'delete',
  path: '/spaces/{spaceId}/apps/{appId}',
  tags: ['apps'],
  summary: '删除应用：还有应用层记忆（含已删除的）时不能删；它的 Key 一起删除',
  request: { params: AppParams },
  responses: {
    204: { description: '已删除' },
    403: forbidden,
    404: notFound,
    409: jsonResponse('还有应用层记忆', ErrorResponse),
  },
})

const listKeys = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/apps/{appId}/keys',
  tags: ['apps'],
  summary: '列出应用的 API Key（不含明文）',
  request: { params: AppParams },
  responses: { 200: jsonResponse('Key 列表', z.array(KeyInfo)), 403: forbidden, 404: notFound },
})

const createKey = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/apps/{appId}/keys',
  tags: ['apps'],
  summary: '签发 API Key，明文只在这次响应里出现',
  request: { params: AppParams, body: jsonBody(CreateKeyRequest) },
  responses: { 201: jsonResponse('已签发', CreatedKey), 403: forbidden, 404: notFound },
})

const keyMatrix = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}/matrix',
  tags: ['apps'],
  summary: '一把 Key 在各种会话上下文下能读写哪些层、哪些敏感级（按当前有效上限）',
  request: { params: KeyParams },
  responses: {
    200: jsonResponse('权限矩阵', KeyAccessMatrix),
    403: forbidden,
    404: notFound,
  },
})

const revokeKey = createRoute({
  method: 'delete',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}',
  tags: ['apps'],
  summary: '吊销 API Key',
  request: { params: KeyParams },
  responses: { 204: { description: '已吊销' }, 403: forbidden, 404: notFound },
})

// 外键检查不受 RLS 约束，默认人格必须在 RLS 下可见，也就是同一空间
async function personaVisible(tx: Tx, personaId: string | null | undefined): Promise<boolean> {
  if (!personaId) return true
  const [row] = await tx
    .select({ id: personas.id })
    .from(personas)
    .where(eq(personas.id, personaId))
  return Boolean(row)
}

const canManageApps = (role: MemberRole | null) => role === 'owner' || role === 'editor'

// 应用的权限按「主人」算：Key 读到的 owner / private 层就是应用主人的。
// 所以只有应用主人能改配置、签发和查看 Key；空间 owner 可以吊销任何 Key（止损），但不能签发
// lock 为 true 时锁住应用这一行直到事务结束：签发 Key 与转移所有权都先拿这把锁，
// 保证「检查主人 → 写 Key」与「吊销 Key → 换主人」不会交错，转移之后不会冒出前任主人的新 Key
async function appOwnerOf(tx: Tx, appId: string, lock = false): Promise<string | null> {
  const query = tx.select({ owner: apps.ownerAccountId }).from(apps).where(eq(apps.id, appId))
  const [row] = lock ? await query.for('update') : await query
  return row?.owner ?? null
}

export function appRoutes(deps: Deps) {
  const app = router()

  const roleOf = (spaceId: string, accountId: string) => memberRole(deps, spaceId, accountId)

  return app
    .openapi(listApps, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await roleOf(spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      const rows = await withSpace(deps.db, spaceId, (tx) =>
        tx.select().from(apps).orderBy(apps.createdAt),
      )
      return c.json(rows.map(toAppInfo), 200)
    })
    .openapi(createApp, async (c) => {
      const { spaceId } = c.req.valid('param')
      const body = c.req.valid('json')
      const accountId = c.get('console').accountId
      if (!canManageApps(await roleOf(spaceId, accountId))) {
        return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      }
      const rows = await withSpace(deps.db, spaceId, async (tx) => {
        if (!(await personaVisible(tx, body.defaultPersonaId))) return null
        return tx
          .insert(apps)
          .values({ spaceId, ...body, ownerAccountId: accountId })
          .onConflictDoNothing()
          .returning()
      })
      if (!rows) return c.json({ error: '默认人格不存在' }, 404)
      if (!rows[0]) return c.json({ error: `标识 ${body.slug} 已被占用` }, 409)
      return c.json(toAppInfo(rows[0]), 201)
    })
    .openapi(updateApp, async (c) => {
      const { spaceId, appId } = c.req.valid('param')
      const { ownerAccountId, ...changes } = c.req.valid('json')
      const accountId = c.get('console').accountId
      const role = await roleOf(spaceId, accountId)
      if (!canManageApps(role)) return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      // 转移所有权只有空间 owner 能做，新主人必须是空间成员；转移请求不能夹带别的修改
      if (ownerAccountId !== undefined) {
        if (role !== 'owner') return c.json({ error: '只有空间 owner 能转移应用' }, 403)
        if (Object.keys(changes).length)
          return c.json({ error: '转移所有权时不能同时修改其他字段' }, 400)
      }
      const rows = await withSpace(deps.db, spaceId, async (tx) => {
        const owner = await appOwnerOf(tx, appId, true)
        if (!owner) return []
        if (ownerAccountId !== undefined) {
          // 在同一个事务里锁住新主人的成员记录再检查角色，避免检查之后、转移之前他被移出空间；
          // 新主人要能管理应用和签发 Key，所以至少是 editor
          const [member] = await tx
            .select({ role: spaceMembers.role })
            .from(spaceMembers)
            .where(
              and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, ownerAccountId)),
            )
            .for('update')
          if (member?.role !== 'owner' && member?.role !== 'editor') return 'bad-owner' as const
          // Key 的权限按应用当前主人计算：不吊销的话，前一位主人手里的 Key 会转而读到新主人的私人层
          if (ownerAccountId !== owner) {
            await tx
              .update(apiKeys)
              .set({ revokedAt: new Date() })
              .where(and(eq(apiKeys.appId, appId), isNull(apiKeys.revokedAt)))
          }
          return tx
            .update(apps)
            .set({ ownerAccountId, updatedAt: new Date() })
            .where(eq(apps.id, appId))
            .returning()
        }
        if (owner !== accountId) return null
        if (!(await personaVisible(tx, changes.defaultPersonaId))) return []
        return tx
          .update(apps)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(apps.id, appId))
          .returning()
      })
      if (rows === 'bad-owner')
        return c.json({ error: '新主人必须是空间里的 owner 或 editor' }, 400)
      if (!rows) return c.json({ error: '只有应用的主人能修改它' }, 403)
      if (!rows[0]) return c.json({ error: '应用或默认人格不存在' }, 404)
      return c.json(toAppInfo(rows[0]), 200)
    })
    .openapi(deleteApp, async (c) => {
      const { spaceId, appId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await roleOf(spaceId, accountId)
      if (!canManageApps(role)) return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        // 锁住应用这一行：写应用层记忆时的外键检查要等这把锁，检查之后不会再冒出一条被连带删掉的记忆
        const owner = await appOwnerOf(tx, appId, true)
        if (!owner) return 'missing' as const
        if (owner !== accountId && role !== 'owner') return 'forbidden' as const
        // 删除应用会把应用层记忆连带硬删除，已删除、还能撤销删除的也算
        const [stored] = await tx
          .select({ n: count() })
          .from(memories)
          .where(eq(memories.appId, appId))
        if (stored!.n > 0) return stored!.n
        await tx.delete(apps).where(eq(apps.id, appId))
        return 'deleted' as const
      })
      if (result === 'missing') return c.json({ error: '应用不存在' }, 404)
      if (result === 'forbidden')
        return c.json({ error: '只有应用的主人或空间 owner 能删除应用' }, 403)
      if (result !== 'deleted') {
        return c.json(
          {
            error: `还有 ${result} 条应用层记忆（含已删除、还能撤销删除的），移到别的命名空间之后才能删除应用`,
          },
          409,
        )
      }
      return c.body(null, 204)
    })
    .openapi(listKeys, async (c) => {
      const { spaceId, appId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await roleOf(spaceId, accountId)
      if (!role) return c.json({ error: '不是该空间成员' }, 403)
      const owner = await withSpace(deps.db, spaceId, (tx) => appOwnerOf(tx, appId))
      if (!owner) return c.json({ error: '应用不存在' }, 404)
      // 列表只有元数据、不含明文；空间 owner 要能看到 Key 编号才能吊销泄露的 Key
      if (owner !== accountId && role !== 'owner') {
        return c.json({ error: '只有应用的主人或空间 owner 能查看 Key' }, 403)
      }
      const rows = await deps.db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.spaceId, spaceId), eq(apiKeys.appId, appId)))
        .orderBy(desc(apiKeys.createdAt))
      const membership = await ownerMembership(deps, spaceId, owner)
      return c.json(
        rows.map((row) => toKeyInfo(row, membership)),
        200,
      )
    })
    .openapi(createKey, async (c) => {
      const { spaceId, appId } = c.req.valid('param')
      const body = c.req.valid('json')
      const accountId = c.get('console').accountId
      const role = await roleOf(spaceId, accountId)
      // viewer 不能签发 Key；admin Key 能越过人格与应用命名空间的写入限制，只有空间 owner 能签发
      if (role !== 'owner' && role !== 'editor') {
        return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      }
      // Key 的上限不能超过签发人的角色：admin 与 secret 级只有空间 owner 能给。
      // editor 签发的 Key 仍能读写应用主人（也就是 editor 自己）的私人层，以及 secret 以下的共享内容
      if (role !== 'owner' && (body.scopes.admin || body.scopes.maxSensitivity === 'secret')) {
        return c.json({ error: '只有空间 owner 能签发 admin 或 secret 级的 Key' }, 403)
      }
      const generated = generateApiKey()
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        const owner = await appOwnerOf(tx, appId, true)
        if (!owner) return 'missing' as const
        if (owner !== accountId) return 'not-owner' as const
        const [row] = await tx
          .insert(apiKeys)
          .values({
            spaceId,
            appId,
            name: body.name,
            prefix: generated.prefix,
            secretHash: generated.secretHash,
            scopes: body.scopes,
          })
          .returning()
        return row!
      })
      if (result === 'missing') return c.json({ error: '应用不存在' }, 404)
      if (result === 'not-owner') return c.json({ error: '只有应用的主人能签发它的 Key' }, 403)
      const membership = await ownerMembership(deps, spaceId, accountId)
      return c.json({ ...toKeyInfo(result, membership), key: generated.plaintext }, 201)
    })
    .openapi(keyMatrix, async (c) => {
      const { spaceId, appId, keyId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await roleOf(spaceId, accountId)
      if (!role) return c.json({ error: '不是该空间成员' }, 403)
      const found = await withSpace(deps.db, spaceId, async (tx) => {
        const [app] = await tx.select().from(apps).where(eq(apps.id, appId))
        if (!app) return null
        const [key] = await tx
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.id, keyId), eq(apiKeys.appId, appId)))
        return key ? { app, key } : null
      })
      if (!found) return c.json({ error: 'Key 不存在' }, 404)
      const { app, key } = found
      // 和 Key 列表一样，只给应用主人与空间 owner 看
      if (app.ownerAccountId !== accountId && role !== 'owner') {
        return c.json({ error: '只有应用的主人或空间 owner 能查看 Key' }, 403)
      }
      const scopes = keyEffectiveScopes(
        { ...key, scopes: KeyScopes.parse(key.scopes) },
        await ownerMembership(deps, spaceId, app.ownerAccountId),
      )
      if (!scopes) return c.json({ error: 'Key 已作废' }, 404)
      const config = AppConfig.parse(app.config)
      return c.json(
        accessMatrix(scopes, {
          appId: app.id,
          ownerAccountId: app.ownerAccountId,
          personaId: app.defaultPersonaId,
          ...(config.elevateOwnerDirect ? { elevateOwnerDirect: config.elevateOwnerDirect } : {}),
        }),
        200,
      )
    })
    .openapi(revokeKey, async (c) => {
      const { spaceId, appId, keyId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await roleOf(spaceId, accountId)
      const owner = role ? await withSpace(deps.db, spaceId, (tx) => appOwnerOf(tx, appId)) : null
      if (role !== 'owner' && owner !== accountId) {
        return c.json({ error: '只有应用的主人或空间 owner 能吊销 Key' }, 403)
      }
      const rows = await deps.db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, keyId),
            eq(apiKeys.spaceId, spaceId),
            eq(apiKeys.appId, appId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id })
      if (!rows[0]) return c.json({ error: 'Key 不存在或已吊销' }, 404)
      return c.body(null, 204)
    })
}
