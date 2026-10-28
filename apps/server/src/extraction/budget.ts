import type { ExtractionBudget, ExtractionUsage } from '@kioku/contracts'
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm'

import { withSpace, type Db, type Tx } from '../db/client'
import { extractionRuns, memories, spaces } from '../db/schema'

// 预算按 UTC 的自然月、自然日算，和服务器所在的时区无关
const MONTH_START = sql`date_trunc('month', now(), 'UTC')`
const DAY_START = sql`date_trunc('day', now(), 'UTC')`

// 这个空间的抽取预算与本月用掉的 token（抽取记录里的用量之和，失败的那几次也算：token 已经花出去了）
export async function extractionUsage(db: Db, spaceId: string): Promise<ExtractionUsage> {
  const [space] = await db
    .select({
      monthlyTokens: spaces.extractionMonthlyTokens,
      dailyWritesPerSubject: spaces.extractionDailyWrites,
    })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
  const [row] = await withSpace(db, spaceId, (tx) =>
    tx
      .select({
        used: sql<string>`coalesce(sum(${extractionRuns.promptTokens} + ${extractionRuns.completionTokens}), 0)::bigint`,
        periodStart: sql<string>`${MONTH_START}::text`,
      })
      .from(extractionRuns)
      .where(gte(extractionRuns.createdAt, MONTH_START)),
  )
  return {
    monthlyTokens: space!.monthlyTokens,
    dailyWritesPerSubject: space!.dailyWritesPerSubject,
    usedTokens: Number(row?.used ?? 0),
    periodStart: new Date(row!.periodStart).toISOString(),
  }
}

export async function saveExtractionBudget(
  db: Db,
  spaceId: string,
  budget: ExtractionBudget,
): Promise<void> {
  await db
    .update(spaces)
    .set({
      extractionMonthlyTokens: budget.monthlyTokens,
      extractionDailyWrites: budget.dailyWritesPerSubject,
    })
    .where(eq(spaces.id, spaceId))
}

// 这些对象今天已经由抽取写下了几条事实（推翻旧事实写下的新一条也算）
export async function writesToday(
  tx: Tx,
  subjectIds: readonly string[],
): Promise<Map<string, number>> {
  if (!subjectIds.length) return new Map()
  const rows = await tx
    .select({ subjectId: memories.subjectId, n: count() })
    .from(memories)
    .where(
      and(
        eq(memories.form, 'extracted'),
        eq(memories.layer, 'subject'),
        inArray(memories.subjectId, [...subjectIds]),
        gte(memories.createdAt, DAY_START),
      ),
    )
    .groupBy(memories.subjectId)
  return new Map(rows.map((r) => [r.subjectId!, r.n]))
}
