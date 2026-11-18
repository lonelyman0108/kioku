import type { ExtractionBudget, ExtractionUsage } from '@kioku/contracts'
import { and, count, eq, gte, inArray, sql, type SQL } from 'drizzle-orm'

import { withCircle, type Db, type Tx } from '../db/client'
import { circles, dreamRuns, entries, extractionRuns } from '../db/schema'

// 预算按 UTC 的自然月、自然日算，与服务器所在时区无关
export const monthStart = (at: SQL): SQL => sql`date_trunc('month', ${at}, 'UTC')`
const MONTH_START = monthStart(sql`now()`)
const DAY_START = sql`date_trunc('day', now(), 'UTC')`

// 读取指定记忆圈的抽取预算与本月 token 累计用量（抽取记录与 Dream 运行记录共用）
export async function extractionUsage(db: Db, circleId: string): Promise<ExtractionUsage> {
  const [circle] = await db
    .select({
      monthlyTokens: circles.extractionMonthlyTokens,
      dailyWritesPerSubject: circles.extractionDailyWrites,
    })
    .from(circles)
    .where(eq(circles.id, circleId))
  const [row] = await withCircle(db, circleId, (tx) =>
    tx
      .select({
        used: sql<string>`coalesce(sum(${extractionRuns.promptTokens} + ${extractionRuns.completionTokens}), 0)::bigint`,
        dream: sql<string>`(select coalesce(sum(${dreamRuns.promptTokens} + ${dreamRuns.completionTokens}), 0)::bigint
          from ${dreamRuns} where ${gte(dreamRuns.createdAt, MONTH_START)})`,
        periodStart: sql<number>`extract(epoch from ${MONTH_START})::float8`,
      })
      .from(extractionRuns)
      .where(gte(extractionRuns.createdAt, MONTH_START)),
  )
  return {
    monthlyTokens: circle!.monthlyTokens,
    dailyWritesPerSubject: circle!.dailyWritesPerSubject,
    usedTokens: Number(row?.used ?? 0) + Number(row?.dream ?? 0),
    periodStart: new Date(Number(row!.periodStart) * 1000).toISOString(),
  }
}

export async function saveExtractionBudget(
  db: Db,
  circleId: string,
  budget: ExtractionBudget,
): Promise<void> {
  await db
    .update(circles)
    .set({
      extractionMonthlyTokens: budget.monthlyTokens,
      extractionDailyWrites: budget.dailyWritesPerSubject,
    })
    .where(eq(circles.id, circleId))
}

// 统计指定联系人今天已由抽取写入的事实条数（包含推翻旧事实写下的新一条）
export async function writesToday(
  tx: Tx,
  subjectIds: readonly string[],
): Promise<Map<string, number>> {
  if (!subjectIds.length) return new Map()
  const rows = await tx
    .select({ subjectId: entries.subjectId, n: count() })
    .from(entries)
    .where(
      and(
        eq(entries.kind, 'fact'),
        inArray(entries.subjectId, [...subjectIds]),
        gte(entries.createdAt, DAY_START),
      ),
    )
    .groupBy(entries.subjectId)
  return new Map(rows.map((r) => [r.subjectId!, r.n]))
}
