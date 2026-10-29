import { and, count, eq, isNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { withSpace, type Db } from '../db/client'
import { memories, memoryEmbeddings, spaces } from '../db/schema'

// 整个实例的向量覆盖率，给实例设置页看补齐进度：应当有向量的记忆，以及其中各模型已经生成了多少。
// 应当有向量的记忆与后台任务的口径一致：没删除、不是 secret、有正文（空字符串不算）的策展记忆。
// 逐个空间统计（内容表只能在空间事务里读），每个空间一条查询：换模型时页面会一直刷新进度
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
  // 每个模型左连接一次：每条记忆在一个模型下至多一条向量（主键），计数不会重复
  const joined = models.map((model, i) => ({ model, table: alias(memoryEmbeddings, `e${i}`) }))
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    const [row] = await withSpace(db, spaceId, (tx) => {
      let query = tx
        .select({
          total: count(),
          ...Object.fromEntries(joined.map((j, i) => [`m${i}`, count(j.table.memoryId)])),
        })
        .from(memories)
        .$dynamic()
      for (const j of joined) {
        query = query.leftJoin(
          j.table,
          and(eq(j.table.memoryId, memories.id), eq(j.table.model, j.model)),
        )
      }
      return query.where(embeddable)
    })
    const counts = row as Record<string, number> | undefined
    eligible += counts?.total ?? 0
    joined.forEach((j, i) =>
      embedded.set(j.model, embedded.get(j.model)! + (counts?.[`m${i}`] ?? 0)),
    )
  }
  return { eligible, embedded }
}
