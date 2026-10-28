import { createRoute, z } from '@hono/zod-openapi'
import {
  CreatePersonaRequest,
  ErrorResponse,
  PersonaDetail,
  PersonaInfo,
  UpdatePersonaRequest,
} from '@kioku/contracts'
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'

import { memberRole } from '../auth/middleware'
import { withSpace, type Tx } from '../db/client'
import { apps, memories, personas } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
import { readableConditions } from '../memory/filter'
import { MAX_PERSONA_DEPTH, overriddenBy, personaChain } from '../memory/personas'
import { formatUri } from '../memory/uri'

const SpaceParams = z.object({ spaceId: z.uuid() })
const PersonaParams = SpaceParams.extend({ personaId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在', ErrorResponse)

const toInfo = (row: typeof personas.$inferSelect) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  extendsId: row.extendsId,
  description: row.description,
})

const list = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/personas',
  tags: ['personas'],
  summary: '列出空间里的人格',
  request: { params: SpaceParams },
  responses: {
    200: jsonResponse('人格列表', z.array(PersonaInfo)),
    403: forbidden,
  },
})

const create = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/personas',
  tags: ['personas'],
  summary: '新建人格，可以继承另一个人格',
  request: { params: SpaceParams, body: jsonBody(CreatePersonaRequest) },
  responses: {
    201: jsonResponse('已创建', PersonaInfo),
    400: jsonResponse('继承链太长', ErrorResponse),
    403: forbidden,
    404: jsonResponse('被继承的人格不存在', ErrorResponse),
    409: jsonResponse('标识已被占用', ErrorResponse),
  },
})

const detail = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/personas/{personaId}',
  tags: ['personas'],
  summary: '人格详情：继承链、自己的与继承来的节点（标出被覆盖的）、用它的应用',
  request: { params: PersonaParams },
  responses: { 200: jsonResponse('人格详情', PersonaDetail), 403: forbidden, 404: notFound },
})

const update = createRoute({
  method: 'patch',
  path: '/spaces/{spaceId}/personas/{personaId}',
  tags: ['personas'],
  summary: '修改人格的名称、说明或继承；标识不能改',
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
  path: '/spaces/{spaceId}/personas/{personaId}',
  tags: ['personas'],
  summary: '删除人格：有应用在用、被别的人格继承、或还有人格层记忆（含已删除的）时不能删',
  request: { params: PersonaParams },
  responses: {
    204: { description: '已删除' },
    403: forbidden,
    404: notFound,
    409: jsonResponse('人格还在用', ErrorResponse),
  },
})

// 继承关系的改动（新建时指定继承、改继承、删除）在一个空间里串行执行：
// 两个请求各自检查都不成环，合起来却可能成环
async function lockPersonaGraph(tx: Tx, spaceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`personas:${spaceId}`}, 0))`)
}

// 以这个人格为根的子树有几层（只有自己时是 1）；层数上限防止数据里意外出现的环让查询停不下来
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

// 让 personaId 继承 parentId 之后的问题：父人格不存在、成环、或最深的继承链超过上限
async function inheritanceProblem(
  tx: Tx,
  personaId: string | null,
  parentId: string,
): Promise<'missing' | string | null> {
  // 外键检查不受 RLS 约束，被继承的人格必须在 RLS 下可见，也就是同一空间
  const [parent] = await tx
    .select({ id: personas.id })
    .from(personas)
    .where(eq(personas.id, parentId))
  if (!parent) return 'missing'
  const ancestors = await personaChain(tx, parentId)
  if (personaId && ancestors.includes(personaId)) return '不能继承自己或自己的后代：继承关系会成环'
  const height = personaId ? await subtreeHeight(tx, personaId) : 1
  if (ancestors.length + height > MAX_PERSONA_DEPTH) {
    return `继承链最多 ${MAX_PERSONA_DEPTH} 层（含自己与继承它的人格）`
  }
  return null
}

export function personaRoutes(deps: Deps) {
  const app = router()
  const canManage = async (spaceId: string, accountId: string) => {
    const role = await memberRole(deps, spaceId, accountId)
    return role === 'owner' || role === 'editor'
  }
  return app
    .openapi(list, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      const rows = await withSpace(deps.db, spaceId, (tx) =>
        tx.select().from(personas).orderBy(asc(personas.createdAt)),
      )
      return c.json(rows.map(toInfo), 200)
    })
    .openapi(create, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await canManage(spaceId, c.get('console').accountId))) {
        return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      }
      const body = c.req.valid('json')
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        if (body.extendsId) {
          await lockPersonaGraph(tx, spaceId)
          const problem = await inheritanceProblem(tx, null, body.extendsId)
          if (problem) return problem
        }
        const [row] = await tx
          .insert(personas)
          .values({ spaceId, ...body })
          .onConflictDoNothing()
          .returning()
        return row ?? ('taken' as const)
      })
      if (result === 'missing') return c.json({ error: '被继承的人格不存在' }, 404)
      if (result === 'taken') return c.json({ error: '人格标识已被占用' }, 409)
      if (typeof result === 'string') return c.json({ error: result }, 400)
      return c.json(toInfo(result), 201)
    })
    .openapi(detail, async (c) => {
      const { spaceId, personaId } = c.req.valid('param')
      // 节点按查看者在管理界面里的读权限算，与记忆页一致
      const { service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      const access = service.access
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        const [row] = await tx.select().from(personas).where(eq(personas.id, personaId))
        if (!row) return null
        const chain = await personaChain(tx, personaId)
        const [related, children, users, nodes, [stored]] = await Promise.all([
          tx.select().from(personas).where(inArray(personas.id, chain)),
          tx
            .select()
            .from(personas)
            .where(eq(personas.extendsId, personaId))
            .orderBy(asc(personas.createdAt)),
          tx
            .select({ id: apps.id, slug: apps.slug, name: apps.name })
            .from(apps)
            .where(eq(apps.defaultPersonaId, personaId))
            .orderBy(asc(apps.createdAt)),
          tx
            .select({
              domain: memories.domain,
              path: memories.path,
              personaId: memories.personaId,
              priority: memories.priority,
              sensitivity: memories.sensitivity,
              disclosure: memories.disclosure,
              overriddenBy: overriddenBy(access, chain),
            })
            .from(memories)
            .where(
              and(
                eq(memories.layer, 'persona'),
                eq(memories.form, 'curated'),
                readableConditions(access, { personaIds: chain, explicit: true }),
              ),
            )
            .orderBy(asc(memories.path)),
          // 只数查看者用管理读取看得到的（含已删除、已过期的），看不到的 secret 不透露条数
          tx
            .select({ n: count() })
            .from(memories)
            .where(
              and(
                eq(memories.personaId, personaId),
                readableConditions(access, { personaIds: [], management: true }),
              ),
            ),
        ])
        const byId = new Map(related.map((p) => [p.id, p]))
        const toNode = (n: (typeof nodes)[number]) => ({
          uri: formatUri(n.domain!, n.path!),
          personaId: n.personaId!,
          priority: n.priority,
          sensitivity: n.sensitivity,
          disclosure: n.disclosure,
          overriddenBy: n.overriddenBy,
        })
        // 继承来的节点按继承链的远近排：直接继承的那个人格在前
        const rank = (id: string | null) => chain.indexOf(id ?? '')
        return {
          ...toInfo(row),
          ancestors: chain.slice(1).flatMap((id) => (byId.has(id) ? [toInfo(byId.get(id)!)] : [])),
          children: children.map(toInfo),
          own: nodes.filter((n) => n.personaId === personaId).map(toNode),
          inherited: nodes
            .filter((n) => n.personaId !== personaId)
            .sort((a, b) => rank(a.personaId) - rank(b.personaId))
            .map(toNode),
          apps: users,
          storedMemories: stored!.n,
        }
      })
      if (!result) return c.json({ error: '人格不存在' }, 404)
      return c.json(result, 200)
    })
    .openapi(update, async (c) => {
      const { spaceId, personaId } = c.req.valid('param')
      if (!(await canManage(spaceId, c.get('console').accountId))) {
        return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      }
      const body = c.req.valid('json')
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        if (body.extendsId !== undefined) await lockPersonaGraph(tx, spaceId)
        const [row] = await tx.select().from(personas).where(eq(personas.id, personaId))
        if (!row) return 'missing' as const
        // 继承没变时不重新检查：上限加上之前建出的更深的链，照样能改名称与说明
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
        // 只改名称与说明时不加锁，读出之后被并发删除的就当作不存在
        return updated ?? ('missing' as const)
      })
      if (result === 'missing') return c.json({ error: '人格不存在' }, 404)
      if (result === 'missing-parent') return c.json({ error: '被继承的人格不存在' }, 404)
      if (typeof result === 'string') return c.json({ error: result }, 400)
      return c.json(toInfo(result), 200)
    })
    .openapi(remove, async (c) => {
      const { spaceId, personaId } = c.req.valid('param')
      if (!(await canManage(spaceId, c.get('console').accountId))) {
        return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      }
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        await lockPersonaGraph(tx, spaceId)
        // 锁住这一行：把应用、人格或记忆指向它的写入，外键检查都要等这把锁，
        // 检查之后不会再冒出一个被连带清空或删掉的引用
        const [row] = await tx
          .select({ id: personas.id })
          .from(personas)
          .where(eq(personas.id, personaId))
          .for('update')
        if (!row) return null
        const [[users], [heirs], [stored]] = await Promise.all([
          tx.select({ n: count() }).from(apps).where(eq(apps.defaultPersonaId, personaId)),
          tx.select({ n: count() }).from(personas).where(eq(personas.extendsId, personaId)),
          // 人格层记忆会被连带硬删除，已删除、还能撤销删除的也算
          tx.select({ n: count() }).from(memories).where(eq(memories.personaId, personaId)),
        ])
        const reasons = [
          users!.n ? `${users!.n} 个应用以它为默认人格` : '',
          heirs!.n ? `${heirs!.n} 个人格继承它` : '',
          // 不给条数：里面可能有查看者读不到的 secret 记忆
          stored!.n ? '还有人格层记忆（含已删除、还能撤销删除的）' : '',
        ].filter(Boolean)
        if (reasons.length) return reasons
        await tx.delete(personas).where(eq(personas.id, personaId))
        return []
      })
      if (!result) return c.json({ error: '人格不存在' }, 404)
      if (result.length) return c.json({ error: `删不掉：${result.join('；')}` }, 409)
      return c.body(null, 204)
    })
}
