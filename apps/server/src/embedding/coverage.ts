import { and, count, eq, isNotNull, isNull, ne } from 'drizzle-orm'

import { withSpace, type Db } from '../db/client'
import { memories, memoryEmbeddings, spaces } from '../db/schema'

// 整个实例的向量覆盖率，给实例设置页看补齐进度。应当有向量的记忆与后台任务的口径一致：
// 没删除、不是 secret、有正文的策展记忆。逐个空间统计，内容表只能在空间事务里读
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
    isNotNull(memories.content),
  )
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    await withSpace(db, spaceId, async (tx) => {
      const [all] = await tx.select({ n: count() }).from(memories).where(embeddable)
      eligible += all?.n ?? 0
      if (!model) return
      const [done] = await tx
        .select({ n: count() })
        .from(memories)
        .innerJoin(
          memoryEmbeddings,
          and(eq(memoryEmbeddings.memoryId, memories.id), eq(memoryEmbeddings.model, model)),
        )
        .where(embeddable)
      embedded += done?.n ?? 0
    })
  }
  return { eligible, embedded }
}
