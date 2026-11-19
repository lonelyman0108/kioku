import { createRoute, z } from '@hono/zod-openapi'
import {
  ClientConfig,
  ClientGroupRuleList,
  ClientGroupRules,
  ClientInfo,
  CreateClientRequest,
  CreateKeyRequest,
  ErrorResponse,
  IssuedKey,
  KeyAccessMatrix,
  KeyInfo,
  RotateKeyRequest,
  UpdateClientRequest,
  type MemberRole,
} from '@kioku/contracts'
import { and, eq, isNull } from 'drizzle-orm'

import { accessMatrix } from '../access/access'
import {
  createClient as createClientRow,
  deleteClient as deleteClientRow,
  listClientGroupRules,
  listClients as listClientRows,
  replaceClientGroupRules,
  updateClient as updateClientRow,
} from '../access/clients'
import {
  buildKeyInfos,
  clientOwnerOf,
  describeClientKeys,
  issueClientKey,
  issueDenial,
  linkedCirclesDenial,
  rotateClientKey,
} from '../access/issue'
import { resolveStaticContextRealms } from '../access/realms'
import { memberRole } from '../auth/middleware'
import { withCircle } from '../db/client'
import { apiKeys, circles, clients, facetTerms } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const CircleParams = z.object({ circleId: z.uuid() })
const ClientParams = CircleParams.extend({ clientId: z.uuid() })
const KeyParams = ClientParams.extend({ keyId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在', ErrorResponse)

const listClients = createRoute({
  method: 'get',
  path: '/circles/{circleId}/clients',
  tags: ['clients'],
  summary: '列出记忆圈里的接入实例',
  request: { params: CircleParams },
  responses: { 200: jsonResponse('接入实例列表', z.array(ClientInfo)), 403: forbidden },
})

const createClient = createRoute({
  method: 'post',
  path: '/circles/{circleId}/clients',
  tags: ['clients'],
  summary: '新建接入实例，创建者就是这个接入实例的所有者',
  request: { params: CircleParams, body: jsonBody(CreateClientRequest) },
  responses: {
    201: jsonResponse('已创建', ClientInfo),
    403: forbidden,
    404: jsonResponse('默认人格不存在', ErrorResponse),
    409: jsonResponse('标识已被占用', ErrorResponse),
  },
})

const updateClient = createRoute({
  method: 'patch',
  path: '/circles/{circleId}/clients/{clientId}',
  tags: ['clients'],
  summary: '修改接入实例的名称、默认人格、配置或转让所有权（转让时吊销该实例下全部密钥）',
  request: { params: ClientParams, body: jsonBody(UpdateClientRequest) },
  responses: {
    200: jsonResponse('已修改', ClientInfo),
    400: jsonResponse('新所有者不是记忆圈成员，或转移时夹带其他修改', ErrorResponse),
    403: forbidden,
    404: notFound,
  },
})

const deleteClient = createRoute({
  method: 'delete',
  path: '/circles/{circleId}/clients/{clientId}',
  tags: ['clients'],
  summary: '删除接入实例并级联删除其访问密钥、会话缓冲与按群规则',
  request: { params: ClientParams },
  responses: {
    204: { description: '已删除' },
    403: forbidden,
    404: notFound,
  },
})

const listGroupRules = createRoute({
  method: 'get',
  path: '/circles/{circleId}/clients/{clientId}/group-rules',
  tags: ['clients'],
  summary: '列出接入实例的按群规则（按群切换人格与单群强隔离锁）',
  request: { params: ClientParams },
  responses: { 200: jsonResponse('规则', ClientGroupRuleList), 403: forbidden, 404: notFound },
})

const replaceGroupRules = createRoute({
  method: 'put',
  path: '/circles/{circleId}/clients/{clientId}/group-rules',
  tags: ['clients'],
  summary: '整组替换按群规则，只有接入实例所有者能改',
  request: { params: ClientParams, body: jsonBody(ClientGroupRules) },
  responses: {
    200: jsonResponse('替换后的规则', ClientGroupRuleList),
    400: jsonResponse('规则不合法', ErrorResponse),
    403: forbidden,
    404: notFound,
  },
})

const listKeys = createRoute({
  method: 'get',
  path: '/circles/{circleId}/clients/{clientId}/keys',
  tags: ['clients'],
  summary: '列出接入实例的访问密钥（不含明文）',
  request: { params: ClientParams },
  responses: { 200: jsonResponse('密钥列表', z.array(KeyInfo)), 403: forbidden, 404: notFound },
})

const createKey = createRoute({
  method: 'post',
  path: '/circles/{circleId}/clients/{clientId}/keys',
  tags: ['clients'],
  summary: '签发透镜访问密钥，明文只在这次响应里出现',
  request: { params: ClientParams, body: jsonBody(CreateKeyRequest) },
  responses: { 201: jsonResponse('已签发', IssuedKey), 403: forbidden, 404: notFound },
})

const rotateKey = createRoute({
  method: 'post',
  path: '/circles/{circleId}/clients/{clientId}/keys/{keyId}/rotate',
  tags: ['clients'],
  summary: '轮换访问密钥：同事务吊销旧密钥并继承有效配置签发新密钥，明文仅本次返回',
  request: { params: KeyParams, body: jsonBody(RotateKeyRequest) },
  responses: { 201: jsonResponse('已轮换', IssuedKey), 403: forbidden, 404: notFound },
})

const keyMatrix = createRoute({
  method: 'get',
  path: '/circles/{circleId}/clients/{clientId}/keys/{keyId}/matrix',
  tags: ['clients'],
  summary: '一把访问密钥在各种会话上下文下对各记忆圈各类词条、各敏感级的读写权限矩阵',
  request: { params: KeyParams },
  responses: {
    200: jsonResponse('权限矩阵', KeyAccessMatrix),
    403: forbidden,
    404: notFound,
  },
})

const revokeKey = createRoute({
  method: 'delete',
  path: '/circles/{circleId}/clients/{clientId}/keys/{keyId}',
  tags: ['clients'],
  summary: '吊销访问密钥',
  request: { params: KeyParams },
  responses: { 204: { description: '已吊销' }, 403: forbidden, 404: notFound },
})

const canManageClients = (role: MemberRole | null) => role === 'owner' || role === 'editor'

export function appRoutes(deps: Deps) {
  const app = router()
  const roleOf = (circleId: string, accountId: string) => memberRole(deps, circleId, accountId)

  return app
    .openapi(listClients, async (c) => {
      const { circleId } = c.req.valid('param')
      if (!(await roleOf(circleId, c.get('console').accountId))) {
        return c.json({ error: '无权访问此记忆圈' }, 403)
      }
      const rows = await withCircle(deps.db, circleId, (tx) => listClientRows(tx))
      return c.json(rows, 200)
    })
    .openapi(createClient, async (c) => {
      const { circleId } = c.req.valid('param')
      const body = c.req.valid('json')
      const accountId = c.get('console').accountId
      if (!canManageClients(await roleOf(circleId, accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const res = await withCircle(deps.db, circleId, (tx) =>
        createClientRow(tx, {
          circleId,
          ownerAccountId: accountId,
          slug: body.slug,
          name: body.name,
          runtimeFamily: body.runtimeFamily,
          defaultPersonaId: body.defaultPersonaId,
          config: body.config,
        }),
      )
      if (!res.ok) {
        return res.reason === 'no-persona'
          ? c.json({ error: '默认人格不存在' }, 404)
          : c.json({ error: `标识 ${body.slug} 已被占用` }, 409)
      }
      return c.json(res.client, 201)
    })
    .openapi(updateClient, async (c) => {
      const { circleId, clientId } = c.req.valid('param')
      const { ownerAccountId, ...changes } = c.req.valid('json')
      const accountId = c.get('console').accountId
      const role = await roleOf(circleId, accountId)
      if (!canManageClients(role)) return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      if (ownerAccountId !== undefined) {
        if (role !== 'owner') return c.json({ error: '仅记忆圈所有者可转让接入实例' }, 403)
        if (Object.keys(changes).length) {
          return c.json({ error: '转移所有权时不能同时修改其他字段' }, 400)
        }
      }
      const res = await withCircle(deps.db, circleId, async (tx) => {
        const owner = await clientOwnerOf(tx, clientId, true)
        if (!owner) return 'no-client' as const
        if (ownerAccountId === undefined && owner !== accountId) return 'forbidden' as const
        return updateClientRow(tx, {
          circleId,
          clientId,
          ...(ownerAccountId !== undefined ? { ownerAccountId } : {}),
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.defaultPersonaId !== undefined
            ? { defaultPersonaId: changes.defaultPersonaId }
            : {}),
          ...(changes.config !== undefined ? { config: changes.config } : {}),
        })
      })
      if (res === 'forbidden') return c.json({ error: '仅接入实例所有者可修改此接入实例' }, 403)
      if (res === 'no-client') return c.json({ error: '接入实例不存在' }, 404)
      if (!res.ok) {
        if (res.reason === 'invalid-owner') {
          return c.json({ error: '新所有者须为此记忆圈的有效所有者或编辑者' }, 400)
        }
        return c.json(
          { error: res.reason === 'no-client' ? '接入实例不存在' : '默认人格不存在' },
          404,
        )
      }
      return c.json(res.client, 200)
    })
    .openapi(deleteClient, async (c) => {
      const { circleId, clientId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await roleOf(circleId, accountId)
      if (!canManageClients(role)) return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      const outcome = await withCircle(deps.db, circleId, async (tx) => {
        const owner = await clientOwnerOf(tx, clientId, true)
        if (!owner) return 'missing' as const
        if (owner !== accountId && role !== 'owner') return 'forbidden' as const
        await deleteClientRow(tx, clientId)
        return 'deleted' as const
      })
      if (outcome === 'missing') return c.json({ error: '接入实例不存在' }, 404)
      if (outcome === 'forbidden') {
        return c.json({ error: '仅接入实例所有者或记忆圈所有者可删除接入实例' }, 403)
      }
      return c.body(null, 204)
    })
    .openapi(listGroupRules, async (c) => {
      const { circleId, clientId } = c.req.valid('param')
      if (!(await roleOf(circleId, c.get('console').accountId))) {
        return c.json({ error: '无权访问此记忆圈' }, 403)
      }
      const rules = await withCircle(deps.db, circleId, (tx) =>
        listClientGroupRules(tx, circleId, clientId),
      )
      if (!rules) return c.json({ error: '接入实例不存在' }, 404)
      return c.json({ rules }, 200)
    })
    .openapi(replaceGroupRules, async (c) => {
      const { circleId, clientId } = c.req.valid('param')
      const { rules } = c.req.valid('json')
      const accountId = c.get('console').accountId
      if (!canManageClients(await roleOf(circleId, accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const result = await withCircle(deps.db, circleId, async (tx) => {
        const owner = await clientOwnerOf(tx, clientId, true)
        if (!owner) return 'no-client' as const
        if (owner !== accountId) return 'forbidden' as const
        return replaceClientGroupRules(tx, circleId, clientId, rules)
      })
      if (result === 'no-client') return c.json({ error: '接入实例不存在' }, 404)
      if (result === 'forbidden') {
        return c.json({ error: '仅接入实例所有者可修改此接入实例' }, 403)
      }
      if (!result.ok) {
        if (result.reason === 'duplicate-group') {
          return c.json({ error: '同一个群只能有一条规则' }, 400)
        }
        if (result.reason === 'not-group') {
          return c.json({ error: '规则只能按群或频道配置' }, 400)
        }
        return c.json(
          {
            error:
              result.reason === 'no-client'
                ? '接入实例不存在'
                : result.reason === 'no-group'
                  ? '群不存在'
                  : '人格不存在',
          },
          404,
        )
      }
      return c.json({ rules: result.rules }, 200)
    })
    .openapi(listKeys, async (c) => {
      const { circleId, clientId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await roleOf(circleId, accountId)
      if (!role) return c.json({ error: '无权访问此记忆圈' }, 403)
      const owner = await withCircle(deps.db, circleId, (tx) => clientOwnerOf(tx, clientId))
      if (!owner) return c.json({ error: '接入实例不存在' }, 404)
      if (owner !== accountId && role !== 'owner') {
        return c.json({ error: '仅接入实例所有者或记忆圈所有者可查看访问密钥' }, 403)
      }
      const list = await withCircle(deps.db, circleId, (tx) =>
        describeClientKeys(tx, circleId, clientId),
      )
      if (!list) return c.json({ error: '接入实例不存在' }, 404)
      return c.json(list, 200)
    })
    .openapi(createKey, async (c) => {
      const { circleId, clientId } = c.req.valid('param')
      const body = c.req.valid('json')
      const accountId = c.get('console').accountId
      const role = await roleOf(circleId, accountId)
      const denial = issueDenial(role, body.scopes)
      if (denial) return c.json({ error: denial }, 403)
      const linkedDenial = await linkedCirclesDenial(
        deps.db,
        accountId,
        circleId,
        body.linkedCircles,
      )
      if (linkedDenial) return c.json({ error: linkedDenial }, 403)

      const result = await withCircle(deps.db, circleId, (tx) =>
        issueClientKey(tx, {
          circleId,
          clientId,
          accountId,
          name: body.name,
          linkedCircles: body.linkedCircles,
          contextFacets: body.contextFacets,
          personaOverrideId: body.personaOverrideId,
          scopes: body.scopes,
        }),
      )
      if (!result.ok) {
        if (result.reason === 'missing') return c.json({ error: '接入实例不存在' }, 404)
        if (result.reason === 'no-persona') return c.json({ error: '覆写人格不存在' }, 404)
        return c.json({ error: '仅接入实例所有者可签发此接入实例的访问密钥' }, 403)
      }
      const [info] = await buildKeyInfos(deps.db, circleId, accountId, [result.row])
      return c.json({ ...info!, key: result.plaintext }, 201)
    })
    .openapi(rotateKey, async (c) => {
      const { circleId, clientId, keyId } = c.req.valid('param')
      const body = c.req.valid('json')
      const accountId = c.get('console').accountId
      const role = await roleOf(circleId, accountId)
      if (!canManageClients(role)) return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)

      const result = await withCircle(deps.db, circleId, (tx) =>
        rotateClientKey(tx, {
          circleId,
          clientId,
          keyId,
          accountId,
          ...(body.name !== undefined ? { name: body.name } : {}),
        }),
      )
      if (!result.ok) {
        if (result.reason === 'missing') return c.json({ error: '接入实例或访问密钥不存在' }, 404)
        if (result.reason === 'not-owner') {
          return c.json({ error: '仅接入实例所有者可轮换此接入实例的访问密钥' }, 403)
        }
        return c.json({ error: '当前成员角色已不支持保留原访问密钥的授权范围' }, 403)
      }
      const [info] = await buildKeyInfos(deps.db, circleId, accountId, [result.row])
      return c.json({ ...info!, key: result.plaintext }, 201)
    })
    .openapi(keyMatrix, async (c) => {
      const { circleId, clientId, keyId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await roleOf(circleId, accountId)
      if (!role) return c.json({ error: '无权访问此记忆圈' }, 403)
      const found = await withCircle(deps.db, circleId, async (tx) => {
        const [client] = await tx.select().from(clients).where(eq(clients.id, clientId))
        if (!client) return 'no-client' as const
        if (client.ownerAccountId !== accountId && role !== 'owner') return 'forbidden' as const
        const [key] = await tx
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.id, keyId), eq(apiKeys.clientId, clientId)))
        if (!key) return 'missing' as const
        const [[circle], terms] = await Promise.all([
          tx
            .select({ defaultFacets: circles.defaultFacets })
            .from(circles)
            .where(eq(circles.id, circleId))
            .limit(1),
          tx
            .select({
              dimensionKey: facetTerms.dimensionKey,
              slug: facetTerms.slug,
              implies: facetTerms.implies,
            })
            .from(facetTerms)
            .where(eq(facetTerms.circleId, circleId)),
        ])
        return { client, key, circle, terms }
      })
      if (found === 'no-client') return c.json({ error: '接入实例不存在' }, 404)
      if (found === 'missing') return c.json({ error: '访问密钥不存在' }, 404)
      if (found === 'forbidden') {
        return c.json({ error: '仅接入实例所有者或记忆圈所有者可查看访问密钥' }, 403)
      }
      const { client, key, circle, terms } = found
      const [info] = await buildKeyInfos(deps.db, circleId, client.ownerAccountId, [key])
      if (!info?.effectiveScopes) return c.json({ error: '访问密钥已作废' }, 404)
      const config = ClientConfig.parse(client.config)
      const staticContextRealms = resolveStaticContextRealms(key.contextFacets ?? {}, terms)
      return c.json(
        accessMatrix({
          primaryCircleId: circleId,
          primaryCircleRealms: circle?.defaultFacets?.realm ?? [],
          scopes: info.effectiveScopes,
          grants: info.circleGrants,
          staticContextRealms,
          client: {
            clientId: client.id,
            ownerAccountId: client.ownerAccountId,
            personMemoryMode: config.personMemoryMode,
            ...(config.elevateOwnerDirect ? { elevateOwnerDirect: config.elevateOwnerDirect } : {}),
          },
        }),
        200,
      )
    })
    .openapi(revokeKey, async (c) => {
      const { circleId, clientId, keyId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await roleOf(circleId, accountId)
      const owner = role
        ? await withCircle(deps.db, circleId, (tx) => clientOwnerOf(tx, clientId))
        : null
      if (role !== 'owner' && owner !== accountId) {
        return c.json({ error: '仅接入实例所有者或记忆圈所有者可吊销访问密钥' }, 403)
      }
      const rows = await deps.db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, keyId),
            eq(apiKeys.circleId, circleId),
            eq(apiKeys.clientId, clientId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id })
      if (!rows[0]) return c.json({ error: '访问密钥不存在或已吊销' }, 404)
      return c.body(null, 204)
    })
}
