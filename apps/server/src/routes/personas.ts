import { createRoute, z } from '@hono/zod-openapi'
import {
  CreatePersonaRequest,
  ErrorResponse,
  PersonaDetail,
  PersonaInfo,
  PersonaTrait,
  TraitKey,
  UpdatePersonaRequest,
  UpsertPersonaTraitRequest,
  type ResolvedPersonaTrait,
} from '@kioku/contracts'
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import { memberRole } from '../auth/middleware'
import { withCircle, type Tx } from '../db/client'
import { apiKeys, clientGroupRules, clients, personaTraits, personas, subjects } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleRoleFor } from '../memory/context'
import { MAX_PERSONA_DEPTH, personaChain } from '../memory/personas'

const CircleParams = z.object({ circleId: z.uuid() })
const PersonaParams = CircleParams.extend({ personaId: z.uuid() })
const TraitParams = PersonaParams.extend({ traitKey: TraitKey })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在', ErrorResponse)

const toInfo = (row: typeof personas.$inferSelect, groupRuleCount = 0) => ({
  id: row.id,
  circleId: row.circleId,
  slug: row.slug,
  name: row.name,
  extendsId: row.extendsId,
  description: row.description,
  groupRuleCount,
})

const toTrait = (row: typeof personaTraits.$inferSelect): PersonaTrait => ({
  traitKey: row.traitKey,
  title: row.title,
  content: row.content,
  sortOrder: row.sortOrder,
  updatedAt: row.updatedAt.toISOString(),
})

const list = createRoute({
  method: 'get',
  path: '/circles/{circleId}/personas',
  tags: ['personas'],
  summary: '列出记忆圈里的人格',
  request: { params: CircleParams },
  responses: {
    200: jsonResponse('人格列表', z.array(PersonaInfo)),
    403: forbidden,
  },
})

const create = createRoute({
  method: 'post',
  path: '/circles/{circleId}/personas',
  tags: ['personas'],
  summary: '新建人格，可继承另一个人格并带入初始设定段',
  request: { params: CircleParams, body: jsonBody(CreatePersonaRequest) },
  responses: {
    201: jsonResponse('已创建', PersonaInfo),
    400: jsonResponse('继承链太长或设定键重复', ErrorResponse),
    403: forbidden,
    404: jsonResponse('被继承的人格不存在', ErrorResponse),
    409: jsonResponse('标识已被占用', ErrorResponse),
  },
})

const detail = createRoute({
  method: 'get',
  path: '/circles/{circleId}/personas/{personaId}',
  tags: ['personas'],
  summary: '人格详情：继承链、自身与继承的设定段（标出覆盖者）与使用该人格的接入实例',
  request: { params: PersonaParams },
  responses: { 200: jsonResponse('人格详情', PersonaDetail), 403: forbidden, 404: notFound },
})

const update = createRoute({
  method: 'patch',
  path: '/circles/{circleId}/personas/{personaId}',
  tags: ['personas'],
  summary: '修改人格的名称、说明或继承关系；标识不能改',
  request: { params: PersonaParams, body: jsonBody(UpdatePersonaRequest) },
  responses: {
    200: jsonResponse('已修改', PersonaInfo),
    400: jsonResponse('继承成环或太长', ErrorResponse),
    403: forbidden,
    404: notFound,
  },
})

const remove = createRoute({
  method: 'delete',
  path: '/circles/{circleId}/personas/{personaId}',
  tags: ['personas'],
  summary: '删除人格：有接入实例或按群规则在用、或被其他人格继承时不能删',
  request: { params: PersonaParams },
  responses: {
    204: { description: '已删除' },
    403: forbidden,
    404: notFound,
    409: jsonResponse('人格还在用', ErrorResponse),
  },
})

const upsertTrait = createRoute({
  method: 'put',
  path: '/circles/{circleId}/personas/{personaId}/traits',
  tags: ['personas'],
  summary: '新增或按设定键覆盖人格的设定段',
  request: { params: PersonaParams, body: jsonBody(UpsertPersonaTraitRequest) },
  responses: {
    200: jsonResponse('已保存', PersonaTrait),
    403: forbidden,
    404: notFound,
  },
})

const deleteTrait = createRoute({
  method: 'delete',
  path: '/circles/{circleId}/personas/{personaId}/traits/{traitKey}',
  tags: ['personas'],
  summary: '删除人格自身的某条设定段（保留祖先同键设定）',
  request: { params: TraitParams },
  responses: {
    204: { description: '已删除' },
    403: forbidden,
    404: notFound,
  },
})

// 继承关系的改动（新建时指定继承、改继承、删除）在一个记忆圈里串行执行：
// 两个请求各自检查都不成环，合起来却可能成环
async function lockPersonaGraph(tx: Tx, circleId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`personas:${circleId}`}, 0))`,
  )
}

async function subtreeHeight(tx: Tx, personaId: string): Promise<number> {
  const [row] = await tx.execute<{ height: number }>(sql`
    with recursive sub(id, depth) as (
      select ${personas.id}, 1 from ${personas} where ${personas.id} = ${personaId}
      union all
      select p.id, sub.depth + 1 from ${personas} p join sub on p.extends_id = sub.id
      where sub.depth <= ${MAX_PERSONA_DEPTH}
    )
    select max(depth)::int as height from sub`)
  return row?.height ?? 0
}

async function inheritanceProblem(
  tx: Tx,
  personaId: string | null,
  parentId: string,
): Promise<'missing' | string | null> {
  const [parent] = await tx
    .select({ id: personas.id })
    .from(personas)
    .where(eq(personas.id, parentId))
  if (!parent) return 'missing'
  const ancestors = await personaChain(tx, parentId)
  if (personaId && ancestors.includes(personaId)) return '不能继承自身或后代：继承关系会成环'
  const height = personaId ? await subtreeHeight(tx, personaId) : 1
  if (ancestors.length + height > MAX_PERSONA_DEPTH) {
    return `继承链最多 ${MAX_PERSONA_DEPTH} 层（含自身与继承它的人格）`
  }
  return null
}

export function personaRoutes(deps: Deps) {
  const app = router()
  const canManage = async (circleId: string, accountId: string) => {
    const role = await memberRole(deps, circleId, accountId)
    return role === 'owner' || role === 'editor'
  }
  return app
    .openapi(list, async (c) => {
      const { circleId } = c.req.valid('param')
      await consoleRoleFor(deps, c.get('console').accountId, circleId)
      const { rows, ruleCounts } = await withCircle(deps.db, circleId, async (tx) => {
        const [personaRows, ruleRows] = await Promise.all([
          tx.select().from(personas).orderBy(asc(personas.createdAt)),
          tx
            .select({ personaId: clientGroupRules.personaId, n: count() })
            .from(clientGroupRules)
            .where(isNotNull(clientGroupRules.personaId))
            .groupBy(clientGroupRules.personaId),
        ])
        return { rows: personaRows, ruleCounts: ruleRows }
      })
      const countByPersona = new Map(
        ruleCounts.filter((r) => r.personaId).map((r) => [r.personaId!, r.n]),
      )
      return c.json(
        rows.map((r) => toInfo(r, countByPersona.get(r.id) ?? 0)),
        200,
      )
    })
    .openapi(create, async (c) => {
      const { circleId } = c.req.valid('param')
      if (!(await canManage(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const { traits, ...body } = c.req.valid('json')
      if (traits && new Set(traits.map((t) => t.traitKey)).size !== traits.length) {
        return c.json({ error: '同一人格下设定键不能重复' }, 400)
      }
      const result = await withCircle(deps.db, circleId, async (tx) => {
        if (body.extendsId) {
          await lockPersonaGraph(tx, circleId)
          const problem = await inheritanceProblem(tx, null, body.extendsId)
          if (problem) return problem
        }
        const [row] = await tx
          .insert(personas)
          .values({ circleId, ...body })
          .onConflictDoNothing()
          .returning()
        if (!row) return 'taken' as const
        if (traits?.length) {
          await tx.insert(personaTraits).values(
            traits.map((t) => ({
              circleId,
              personaId: row.id,
              traitKey: t.traitKey,
              title: t.title,
              content: t.content,
              sortOrder: t.sortOrder,
            })),
          )
        }
        return row
      })
      if (result === 'missing') return c.json({ error: '被继承的人格不存在' }, 404)
      if (result === 'taken') return c.json({ error: '人格标识已被占用' }, 409)
      if (typeof result === 'string') return c.json({ error: result }, 400)
      return c.json(toInfo(result), 201)
    })
    .openapi(detail, async (c) => {
      const { circleId, personaId } = c.req.valid('param')
      await consoleRoleFor(deps, c.get('console').accountId, circleId)
      const [[overrideRow], result] = await Promise.all([
        deps.db
          .select({ n: count() })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.circleId, circleId),
              eq(apiKeys.personaOverrideId, personaId),
              isNull(apiKeys.revokedAt),
            ),
          ),
        withCircle(deps.db, circleId, async (tx) => {
          const [row] = await tx.select().from(personas).where(eq(personas.id, personaId))
          if (!row) return null
          const chain = await personaChain(tx, personaId)
          const [related, children, userClients, groupRuleRows, traitRows] = await Promise.all([
            tx.select().from(personas).where(inArray(personas.id, chain)),
            tx
              .select()
              .from(personas)
              .where(eq(personas.extendsId, personaId))
              .orderBy(asc(personas.createdAt)),
            tx
              .select({ id: clients.id, slug: clients.slug, name: clients.name })
              .from(clients)
              .where(eq(clients.defaultPersonaId, personaId))
              .orderBy(asc(clients.createdAt)),
            tx
              .select({
                clientId: clients.id,
                clientName: clients.name,
                groupSubjectId: subjects.id,
                groupName: subjects.displayName,
              })
              .from(clientGroupRules)
              .innerJoin(clients, eq(clients.id, clientGroupRules.clientId))
              .innerJoin(subjects, eq(subjects.id, clientGroupRules.groupSubjectId))
              .where(eq(clientGroupRules.personaId, personaId))
              .orderBy(asc(clients.name), asc(subjects.displayName)),
            tx
              .select()
              .from(personaTraits)
              .where(inArray(personaTraits.personaId, chain))
              .orderBy(asc(personaTraits.sortOrder), asc(personaTraits.traitKey)),
          ])
          const byId = new Map(related.map((p) => [p.id, p]))
          const rank = (id: string) => {
            const idx = chain.indexOf(id)
            return idx < 0 ? 999 : idx
          }
          // 每个 traitKey 在继承链上最近的提供者（index 最小）即为生效覆盖者
          const winnerByKey = new Map<string, string>()
          for (const t of traitRows) {
            const cur = winnerByKey.get(t.traitKey)
            if (!cur || rank(t.personaId) < rank(cur)) {
              winnerByKey.set(t.traitKey, t.personaId)
            }
          }
          const ownTraits: ResolvedPersonaTrait[] = traitRows
            .filter((t) => t.personaId === personaId)
            .map((t) => ({
              ...toTrait(t),
              personaId: t.personaId,
              overriddenBy: null,
            }))
          const inheritedTraits: ResolvedPersonaTrait[] = traitRows
            .filter((t) => t.personaId !== personaId)
            .sort(
              (a, b) =>
                rank(a.personaId) - rank(b.personaId) ||
                a.sortOrder - b.sortOrder ||
                a.traitKey.localeCompare(b.traitKey),
            )
            .map((t) => {
              const winner = winnerByKey.get(t.traitKey)
              return {
                ...toTrait(t),
                personaId: t.personaId,
                overriddenBy: winner && rank(winner) < rank(t.personaId) ? winner : null,
              }
            })
          return {
            ...toInfo(row, groupRuleRows.length),
            ancestors: chain
              .slice(1)
              .flatMap((id) => (byId.has(id) ? [toInfo(byId.get(id)!)] : [])),
            children: children.map((child) => toInfo(child)),
            ownTraits,
            inheritedTraits,
            clients: userClients,
            groupRules: groupRuleRows,
          }
        }),
      ])
      if (!result) return c.json({ error: '人格不存在' }, 404)
      return c.json({ ...result, overrideKeyCount: overrideRow?.n ?? 0 }, 200)
    })
    .openapi(update, async (c) => {
      const { circleId, personaId } = c.req.valid('param')
      if (!(await canManage(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const body = c.req.valid('json')
      const result = await withCircle(deps.db, circleId, async (tx) => {
        if (body.extendsId !== undefined) await lockPersonaGraph(tx, circleId)
        const [row] = await tx.select().from(personas).where(eq(personas.id, personaId))
        if (!row) return 'missing' as const
        if (body.extendsId && body.extendsId !== row.extendsId) {
          const problem = await inheritanceProblem(tx, personaId, body.extendsId)
          if (problem === 'missing') return 'missing-parent' as const
          if (problem) return problem
        }
        const [updated] = await tx
          .update(personas)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(personas.id, personaId))
          .returning()
        return updated ?? ('missing' as const)
      })
      if (result === 'missing') return c.json({ error: '人格不存在' }, 404)
      if (result === 'missing-parent') return c.json({ error: '被继承的人格不存在' }, 404)
      if (typeof result === 'string') return c.json({ error: result }, 400)
      return c.json(toInfo(result), 200)
    })
    .openapi(remove, async (c) => {
      const { circleId, personaId } = c.req.valid('param')
      if (!(await canManage(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const result = await withCircle(deps.db, circleId, async (tx) => {
        await lockPersonaGraph(tx, circleId)
        const [row] = await tx
          .select({ id: personas.id })
          .from(personas)
          .where(eq(personas.id, personaId))
          .for('update')
        if (!row) return null
        const [[users], [rules], [heirs]] = await Promise.all([
          tx.select({ n: count() }).from(clients).where(eq(clients.defaultPersonaId, personaId)),
          tx
            .select({ n: count() })
            .from(clientGroupRules)
            .where(eq(clientGroupRules.personaId, personaId)),
          tx.select({ n: count() }).from(personas).where(eq(personas.extendsId, personaId)),
        ])
        const reasons = [
          users!.n ? `${users!.n} 个接入实例将其设为默认人格` : '',
          rules!.n ? `${rules!.n} 条按群规则使用此人格` : '',
          heirs!.n ? `${heirs!.n} 个人格继承此人格` : '',
        ].filter(Boolean)
        if (reasons.length) return reasons
        await tx.delete(personas).where(eq(personas.id, personaId))
        return []
      })
      if (!result) return c.json({ error: '人格不存在' }, 404)
      if (result.length) return c.json({ error: `无法删除：${result.join('；')}` }, 409)
      return c.body(null, 204)
    })
    .openapi(upsertTrait, async (c) => {
      const { circleId, personaId } = c.req.valid('param')
      if (!(await canManage(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const body = c.req.valid('json')
      const saved = await withCircle(deps.db, circleId, async (tx) => {
        const [persona] = await tx
          .select({ id: personas.id })
          .from(personas)
          .where(eq(personas.id, personaId))
          .limit(1)
        if (!persona) return null
        const [row] = await tx
          .insert(personaTraits)
          .values({
            circleId,
            personaId,
            traitKey: body.traitKey,
            title: body.title,
            content: body.content,
            sortOrder: body.sortOrder,
          })
          .onConflictDoUpdate({
            target: [personaTraits.personaId, personaTraits.traitKey],
            set: {
              title: body.title,
              content: body.content,
              sortOrder: body.sortOrder,
              updatedAt: new Date(),
            },
          })
          .returning()
        return row ?? null
      })
      if (!saved) return c.json({ error: '人格不存在' }, 404)
      return c.json(toTrait(saved), 200)
    })
    .openapi(deleteTrait, async (c) => {
      const { circleId, personaId, traitKey } = c.req.valid('param')
      if (!(await canManage(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const outcome = await withCircle(deps.db, circleId, async (tx) => {
        const [persona] = await tx
          .select({ id: personas.id })
          .from(personas)
          .where(eq(personas.id, personaId))
          .limit(1)
        if (!persona) return 'no-persona' as const
        const gone = await tx
          .delete(personaTraits)
          .where(and(eq(personaTraits.personaId, personaId), eq(personaTraits.traitKey, traitKey)))
          .returning({ traitKey: personaTraits.traitKey })
        return gone.length ? ('deleted' as const) : ('no-trait' as const)
      })
      if (outcome === 'no-persona') return c.json({ error: '人格不存在' }, 404)
      if (outcome === 'no-trait') return c.json({ error: '未找到该人格设定' }, 404)
      return c.body(null, 204)
    })
}
