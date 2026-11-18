import { DEFAULT_RECALL_RETENTION_DAYS, RecallSettings } from '@kioku/contracts'
import { eq, inArray, sql, type SQL } from 'drizzle-orm'

import { withCircle, type Db, type Tx } from '../db/client'
import { circles, recallEvents, settings } from '../db/schema'

const KEY = 'recall'
const STARTED_KEY = 'recall-started'

export async function loadRecallSettings(db: Db): Promise<RecallSettings> {
  return (await loadRecallWindow(db)).settings
}

// 召回设置与开始记录召回事件的时间，一次查出；指定记忆圈时起始时间不早于该记忆圈建立时间
export async function loadRecallWindow(
  db: Db,
  circleId?: string,
): Promise<{ settings: RecallSettings; recordingSince: Date }> {
  const [rows, circle] = await Promise.all([
    db
      .select()
      .from(settings)
      .where(inArray(settings.key, [KEY, STARTED_KEY])),
    circleId
      ? db.select({ createdAt: circles.createdAt }).from(circles).where(eq(circles.id, circleId))
      : [],
  ])
  const stored = RecallSettings.safeParse(rows.find((r) => r.key === KEY)?.value)
  const started = rows.find((r) => r.key === STARTED_KEY)?.value
  const since = typeof started === 'string' ? new Date(started) : null
  const recording = since && !Number.isNaN(since.getTime()) ? since : new Date()
  const created = circle[0]?.createdAt
  return {
    settings: stored.success ? stored.data : { retentionDays: DEFAULT_RECALL_RETENTION_DAYS },
    recordingSince: created && created > recording ? created : recording,
  }
}

export async function saveRecallSettings(db: Db, value: RecallSettings): Promise<void> {
  await db
    .insert(settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

// 清理超过保留天数的召回事件明细（recall_event_hits 随 recall_events 级联删除，累计次数已实时记入 entry_recall_stats）
export async function pruneRecallEvents(db: Db, retentionDays: number): Promise<number> {
  const all = await db.select({ id: circles.id }).from(circles)
  let removed = 0
  for (const circle of all) {
    removed += await withCircle(db, circle.id, (tx) =>
      dropRecallEvents(
        tx,
        sql`${recallEvents.createdAt} < now() - make_interval(days => ${retentionDays}::int)`,
      ),
    )
  }
  return removed
}

// 删除符合条件的召回事件明细，关联的 recall_event_hits 由外键 ON DELETE CASCADE 一并清除
export async function dropRecallEvents(tx: Tx, where: SQL): Promise<number> {
  const gone = await tx.execute(sql`delete from ${recallEvents} where ${where} returning 1`)
  return gone.length
}
