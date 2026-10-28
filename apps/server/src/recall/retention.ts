import { DEFAULT_RECALL_RETENTION_DAYS, RecallSettings } from '@kioku/contracts'
import { eq, lt, sql } from 'drizzle-orm'

import { withSpace, type Db } from '../db/client'
import { recallEvents, settings, spaces } from '../db/schema'

const KEY = 'recall'

export async function loadRecallSettings(db: Db): Promise<RecallSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const parsed = RecallSettings.safeParse(row?.value)
  return parsed.success ? parsed.data : { retentionDays: DEFAULT_RECALL_RETENTION_DAYS }
}

export async function saveRecallSettings(db: Db, value: RecallSettings): Promise<void> {
  await db
    .insert(settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

// 删掉超过保留天数的召回事件明细，删之前把每条记忆被召回的次数与最后一次的时间并入累计统计，
// 同一个事务里做完。内容表开了 RLS，逐个空间处理
export async function pruneRecallEvents(db: Db, retentionDays: number): Promise<number> {
  const all = await db.select({ id: spaces.id }).from(spaces)
  let removed = 0
  for (const space of all) {
    removed += await withSpace(db, space.id, async (tx) => {
      const cutoff = sql`now() - make_interval(days => ${retentionDays}::int)`
      await tx.execute(sql`
        insert into memory_recall_stats (memory_id, space_id, count, last_recalled_at)
        select h.memory_id, h.space_id, count(*)::int, max(e.created_at)
        from recall_event_hits h join recall_events e on e.id = h.event_id
        where e.created_at < ${cutoff}
        group by h.memory_id, h.space_id
        on conflict (memory_id) do update
          set count = memory_recall_stats.count + excluded.count,
            last_recalled_at = greatest(memory_recall_stats.last_recalled_at, excluded.last_recalled_at)`)
      const gone = await tx
        .delete(recallEvents)
        .where(lt(recallEvents.createdAt, cutoff))
        .returning({ id: recallEvents.id })
      return gone.length
    })
  }
  return removed
}
