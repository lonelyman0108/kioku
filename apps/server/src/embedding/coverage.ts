import { and, count, eq, isNull, ne, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { eachSpace, type Db, type Tx } from '../db/client'
import { memories, memoryEmbeddings } from '../db/schema'
import { STILL_VALID } from '../memory/filter'

// 应当有向量的记忆：现在有效（没删除、没过期、没被推翻）、不是 secret、有正文（空字符串不算）的策展记忆。
// 规则只在这里：生成向量的后台任务（写入之后、补齐、换模型）只给这些生成，处理到的别的记忆有向量就删掉；
// 按时间过期的没有写入、不会触发向量任务，它们的向量由每小时的清理删掉（dropIneligibleEmbeddings）。
// 实例设置的向量卡片、换模型时判断补没补齐与概览的覆盖率都按它数。过期的不再召回、不进 boot，Dream 也不看，
// 所以不生成；重新生效、撤销删除之后重新排队生成。抽取的记忆不生成向量（召回与 Dream 都不用）
export const EMBEDDABLE = and(
  eq(memories.form, 'curated'),
  isNull(memories.deletedAt),
  STILL_VALID,
  ne(memories.sensitivity, 'secret'),
  sql`(${memories.content} is not null and ${memories.content} <> '')`,
)!

// 一个空间里应当有向量的记忆有多少，以及其中各模型已经生成了多少（与 models 按下标对应）。
// where 是调用方另加的条件，例如概览只数成员读得到的。内容表只能在空间的事务里读
export async function countEmbeddable(
  tx: Tx,
  models: string[],
  where?: SQL,
): Promise<{ eligible: number; embedded: number[] }> {
  // 每个模型左连接一次：每条记忆在一个模型下至多一条向量（主键），计数不会重复
  const joined = models.map((model, i) => ({ model, table: alias(memoryEmbeddings, `e${i}`) }))
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
  const [row] = await query.where(and(EMBEDDABLE, where))
  const counts = row as Record<string, number> | undefined
  return {
    eligible: counts?.total ?? 0,
    embedded: joined.map((_, i) => counts?.[`m${i}`] ?? 0),
  }
}

// 整个实例的向量覆盖率，给实例设置页看补齐进度、给换模型判断补没补齐。
// 每个空间一条查询，几个空间同时数（eachSpace），不逐个排队：换模型时页面会一直刷新进度
export async function embeddingCoverage(
  db: Db,
  models: string[],
): Promise<{ eligible: number; embedded: Map<string, number> }> {
  let eligible = 0
  const embedded = new Map(models.map((m) => [m, 0]))
  await eachSpace(db, async (tx) => {
    const counts = await countEmbeddable(tx, models)
    eligible += counts.eligible
    models.forEach((m, i) => embedded.set(m, embedded.get(m)! + counts.embedded[i]!))
  })
  return { eligible, embedded }
}
