import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm'

import { withSpace, type Db } from '../db/client'
import { memories, memoryEmbeddings, spaces } from '../db/schema'

// 整个实例的向量覆盖率，给实例设置页看补齐进度：应当有向量的记忆，以及其中各模型已经生成了多少。
// 应当有向量的记忆与后台任务的口径一致：没删除、不是 secret、有正文（空字符串不算）的策展记忆。
// 逐个空间统计，内容表只能在空间事务里读
export async function embeddingCoverage(
  db: Db,
  models: string[],
): Promise<{ eligible: number; embedded: Map<string, number> }> {
  let eligible = 0
  const embedded = new Map(models.map((m) => [m, 0]))
  const embeddable = and(
    isNull(memories.deletedAt),
    ne(memories.sensitivity, 'secret'),
    eq(memories.form, 'curated'),
    sql`(${memories.content} is not null and ${memories.content} <> '')`,
  )
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    const { total, perModel } = await withSpace(db, spaceId, async (tx) => {
      const [row] = await tx.select({ total: count() }).from(memories).where(embeddable)
      // 每条记忆在一个模型下至多一条向量（主键），按模型分组计数不会重复
      const perModel = models.length
        ? await tx
            .select({ model: memoryEmbeddings.model, embedded: count() })
            .from(memoryEmbeddings)
            .innerJoin(memories, eq(memories.id, memoryEmbeddings.memoryId))
            .where(and(embeddable, inArray(memoryEmbeddings.model, models)))
            .groupBy(memoryEmbeddings.model)
        : []
      return { total: row?.total ?? 0, perModel }
    })
    eligible += total
    for (const r of perModel) embedded.set(r.model, (embedded.get(r.model) ?? 0) + r.embedded)
  }
  return { eligible, embedded }
}
