import { eq, inArray } from 'drizzle-orm'

import { withSpace, type Db, type Tx } from '../db/client'
import { personas } from '../db/schema'

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
