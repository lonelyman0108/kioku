import { and, eq, inArray, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { Access } from '../access/access'
import { withSpace, type Db, type Tx } from '../db/client'
import { memories, personas } from '../db/schema'
import { readableConditions } from './filter'

// 继承链（含自己）最多这么多层：新建与修改继承时检查，读的时候超出的部分不再往上找
export const MAX_PERSONA_DEPTH = 8

// 人格及其继承链，从自己到最远的祖先；遇到环或超过深度就停
export async function personaChain(tx: Tx, personaId: string | null): Promise<string[]> {
  const chain: string[] = []
  let current = personaId
  while (current && chain.length < MAX_PERSONA_DEPTH && !chain.includes(current)) {
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
// 覆盖之后这个路径就是子人格的那条，priority 也按它的：它进不了 boot 时，boot 里就没有这个路径。
// 人格层的节点都来自受信来源（数据库约束 memories_untrusted_layers），覆盖不用再看来源。
// 这是挑选规则，不是权限：按 URI 读取和树浏览照样看得到祖先的节点
const NEARER = 'nearer'
const nearer = alias(memories, NEARER)

// boot、召回与近期列表按哪些人格挑选：personaIds 决定读得到哪些人格的节点；inheritance 为 true 时
// personaIds 是当前人格到最远祖先的继承链，按它覆盖。管理界面传的是空间里的全部人格，没有先后，不能覆盖
export interface PersonaSelection {
  personaIds: string[]
  inheritance?: boolean
}

export function personaOverride(access: Access, selection: PersonaSelection): SQL | undefined {
  const chain = selection.personaIds
  if (!selection.inheritance || chain.length < 2) return undefined
  return or(
    ne(memories.layer, 'persona'),
    // 别名表在 sql 模板里只渲染出别名本身，FROM 要自己写全
    sql`not exists (select 1 from ${memories} as ${sql.identifier(NEARER)} where ${overrides(access, chain)})`,
  )
}

// 覆盖这一行的节点的 URI（继承链上最近的人格的那条），没被覆盖时为 null。人格详情用，规则与 personaOverride 相同
export function overriddenBy(access: Access, chain: readonly string[]): SQL<string | null> {
  return sql<string | null>`(select ${nearer.domain} || '://' || ${nearer.path}
    from ${memories} as ${sql.identifier(NEARER)} where ${overrides(access, chain)}
    order by array_position(${chainArray(chain)}, ${nearer.personaId}) limit 1)`
}

// nearer 覆盖 memories 的这一行：同一相对路径、继承链上更近的人格、这次请求读得到
function overrides(access: Access, chain: readonly string[]): SQL {
  const ids = chainArray(chain)
  const relative = (path: SQLWrapper) => sql`regexp_replace(${path}, '^[^/]+', '')`
  return and(
    eq(nearer.layer, 'persona'),
    readableConditions(access, { personaIds: chain }, nearer),
    sql`array_position(${ids}, ${nearer.personaId}) < array_position(${ids}, ${memories.personaId})`,
    sql`${relative(nearer.path)} = ${relative(memories.path)}`,
  )!
}

function chainArray(chain: readonly string[]): SQL {
  return sql`array[${sql.join(
    chain.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
}
