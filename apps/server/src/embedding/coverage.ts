import { and, count, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { eachCircle, type Db, type Tx } from '../db/client'
import { entries, entryEmbeddings, entryVariants } from '../db/schema'
import { STILL_VALID } from '../memory/filter'

// 应当有向量的变体切片：现在有效（整条词条未删除、未过期、未被取代）、非机密、有非空正文的 entry 与 fact 切片。
// entry 与 entryVariants 同事务同步保持 sensitivity 与 kind 一致，会话摘要（episode）与机密切片不建立向量
export const EMBEDDABLE = and(
  inArray(entries.kind, ['entry', 'fact']),
  isNull(entries.deletedAt),
  STILL_VALID,
  ne(entries.sensitivity, 'secret'),
  sql`(${entryVariants.content} is not null and ${entryVariants.content} <> '')`,
)!

// 当前事务（一个记忆圈内）应当有向量的切片总数，以及其中各模型已生成多少；where 加在词条层，例如概览只数读得到的词条
export async function countEmbeddable(
  tx: Tx,
  models: string[],
  where?: SQL,
): Promise<{ eligible: number; embedded: number[] }> {
  const joined = models.map((model, i) => ({ model, table: alias(entryEmbeddings, `e${i}`) }))
  let query = tx
    .select({
      total: count(),
      ...Object.fromEntries(joined.map((j, i) => [`m${i}`, count(j.table.variantId)])),
    })
    .from(entryVariants)
    .innerJoin(entries, eq(entries.id, entryVariants.entryId))
    .$dynamic()
  for (const j of joined) {
    query = query.leftJoin(
      j.table,
      and(eq(j.table.variantId, entryVariants.id), eq(j.table.model, j.model)),
    )
  }
  const [row] = await query.where(and(EMBEDDABLE, where))
  const counts = row as Record<string, number> | undefined
  return {
    eligible: counts?.total ?? 0,
    embedded: joined.map((_, i) => counts?.[`m${i}`] ?? 0),
  }
}

// 整个实例的向量覆盖率：按记忆圈并发统计
export async function embeddingCoverage(
  db: Db,
  models: string[],
): Promise<{ eligible: number; embedded: Map<string, number> }> {
  let eligible = 0
  const embedded = new Map(models.map((m) => [m, 0]))
  await eachCircle(db, async (tx) => {
    const counts = await countEmbeddable(tx, models)
    eligible += counts.eligible
    models.forEach((m, i) => embedded.set(m, embedded.get(m)! + counts.embedded[i]!))
  })
  return { eligible, embedded }
}
