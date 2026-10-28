import { and, eq, inArray, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { Access } from '../access/access'
import { withSpace, type Db, type Tx } from '../db/client'
import { memories, personas } from '../db/schema'
import { readableConditions } from './filter'

const MAX_DEPTH = 8

// 人格及其继承链，从自己到最远的祖先；遇到环或超过深度就停
export async function personaChain(tx: Tx, personaId: string | null): Promise<string[]> {
  const chain: string[] = []
  let current = personaId
  while (current && chain.length < MAX_DEPTH && !chain.includes(current)) {
    chain.push(current)
    const [row] = await tx
      .select({ extendsId: personas.extendsId })
      .from(personas)
      .where(eq(personas.id, current))
      .limit(1)
    current = row?.extendsId ?? null
  }
  return chain
}

export async function personaIdsBySlug(tx: Tx, slugs: string[]): Promise<Map<string, string>> {
  if (!slugs.length) return new Map()
  const rows = await tx
    .select({ id: personas.id, slug: personas.slug })
    .from(personas)
    .where(inArray(personas.slug, slugs))
  return new Map(rows.map((r) => [r.slug, r.id]))
}

// 在空间事务里执行，并带上当前人格链；记忆服务与召回都经由这里访问内容表
// persona 为 'all' 时（管理界面）人格链是空间里的全部人格
export function runInSpace<T>(
  db: Db,
  spaceId: string,
  persona: string | null | 'all',
  fn: (tx: Tx, personaIds: string[]) => Promise<T>,
): Promise<T> {
  return withSpace(db, spaceId, async (tx) => {
    const personaIds =
      persona === 'all'
        ? (await tx.select({ id: personas.id }).from(personas)).map((r) => r.id)
        : await personaChain(tx, persona)
    return fn(tx, personaIds)
  })
}

// 人格继承的覆盖：子人格有同一相对路径（persona://<人格>/ 之后的部分）的节点时，boot、召回与近期列表里
// 不再放祖先的那条。只在这次请求读得到的节点之间比较，子人格的那条读不到时照常用祖先的。
// 这是挑选规则，不是权限：按 URI 读取和树浏览照样看得到祖先的节点。chain 是从当前人格到最远祖先的继承链
const NEARER = 'nearer'
const nearer = alias(memories, NEARER)

export function personaOverride(access: Access, chain: readonly string[]): SQL | undefined {
  if (chain.length < 2) return undefined
  const ids = sql`array[${sql.join(
    chain.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
  const relative = (path: SQLWrapper) => sql`regexp_replace(${path}, '^[^/]+', '')`
  const overriding = and(
    eq(nearer.layer, 'persona'),
    readableConditions(access, { personaIds: chain }, nearer),
    sql`array_position(${ids}, ${nearer.personaId}) < array_position(${ids}, ${memories.personaId})`,
    sql`${relative(nearer.path)} = ${relative(memories.path)}`,
  )
  return or(
    ne(memories.layer, 'persona'),
    // 别名表在 sql 模板里只渲染出别名本身，FROM 要自己写全
    sql`not exists (select 1 from ${memories} as ${sql.identifier(NEARER)} where ${overriding})`,
  )
}
