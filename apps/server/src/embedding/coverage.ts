import { and, count, eq, isNull, ne, sql } from 'drizzle-orm'

import { withSpace, type Db } from '../db/client'
import { memories, memoryEmbeddings, spaces } from '../db/schema'

// 整个实例的向量覆盖率，给实例设置页看补齐进度。应当有向量的记忆与后台任务的口径一致：
// 没删除、不是 secret、有正文（空字符串不算）的策展记忆。逐个空间统计，内容表只能在空间事务里读
export async function embeddingCoverage(
  db: Db,
  model: string | null,
): Promise<{ eligible: number; embedded: number }> {
  let eligible = 0
  let embedded = 0
  const embeddable = and(
    isNull(memories.deletedAt),
    ne(memories.sensitivity, 'secret'),
    eq(memories.form, 'curated'),
    sql`(${memories.content} is not null and ${memories.content} <> '')`,
  )
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    // 每条记忆在一个模型下至多一条向量（主键），左连接计数不会重复；没配置模型时一条也连不上
    const [row] = await withSpace(db, spaceId, (tx) =>
      tx
        .select({ eligible: count(), embedded: count(memoryEmbeddings.memoryId) })
        .from(memories)
        .leftJoin(
          memoryEmbeddings,
          and(eq(memoryEmbeddings.memoryId, memories.id), eq(memoryEmbeddings.model, model ?? '')),
        )
        .where(embeddable),
    )
    eligible += row?.eligible ?? 0
    embedded += row?.embedded ?? 0
  }
  return { eligible, embedded }
}
