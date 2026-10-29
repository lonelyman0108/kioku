import { DEFAULT_RECALL_RETENTION_DAYS, RecallSettings } from '@kioku/contracts'
import { eq, inArray, sql } from 'drizzle-orm'

import { withSpace, type Db } from '../db/client'
import { recallEvents, settings, spaces } from '../db/schema'

const KEY = 'recall'
const STARTED_KEY = 'recall-started'

export async function loadRecallSettings(db: Db): Promise<RecallSettings> {
  return (await loadRecallWindow(db)).settings
}

// 召回设置与开始记录召回事件的时间，一次查出。开始记录的时间由 0015 迁移写入；这一行缺了或读不出日期时
// 当作刚开始记录：宁可暂时不列「从没被召回」，也不把之前没机会被记下召回的旧记忆一下子全算进来。
// 给了空间时，空间建立之前不算开始记录：从别的实例导入的空间保留着记忆原来的建立时间，召回统计却没有带过来
export async function loadRecallWindow(
  db: Db,
  spaceId?: string,
): Promise<{ settings: RecallSettings; recordingSince: Date }> {
  const [rows, space] = await Promise.all([
    db
      .select()
      .from(settings)
      .where(inArray(settings.key, [KEY, STARTED_KEY])),
    spaceId
      ? db.select({ createdAt: spaces.createdAt }).from(spaces).where(eq(spaces.id, spaceId))
      : [],
  ])
  const stored = RecallSettings.safeParse(rows.find((r) => r.key === KEY)?.value)
  const started = rows.find((r) => r.key === STARTED_KEY)?.value
  const since = typeof started === 'string' ? new Date(started) : null
  const recording = since && !Number.isNaN(since.getTime()) ? since : new Date()
  const created = space[0]?.createdAt
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

// 删掉超过保留天数的召回事件明细，删之前把每条记忆被召回的次数与最后一次的时间并入累计统计，
// 同一个事务里做完。内容表开了 RLS，逐个空间处理
export async function pruneRecallEvents(db: Db, retentionDays: number): Promise<number> {
  const all = await db.select({ id: spaces.id }).from(spaces)
  let removed = 0
  for (const space of all) {
    removed += await withSpace(db, space.id, async (tx) => {
      const cutoff = sql`now() - make_interval(days => ${retentionDays}::int)`
      // 删除与并入在同一条语句里：两次清理同时跑时，后一条要等前一条删掉的行，删不到也就不会再并入一次。
      // 命中随事件级联删除，同一条语句里还读得到它们
      const [row] = await tx.execute<{ removed: number }>(sql`
        with gone as (
          delete from ${recallEvents} where ${recallEvents.createdAt} < ${cutoff}
          returning id, created_at
        ),
        merged as (
          insert into memory_recall_stats (memory_id, space_id, count, last_recalled_at)
          select h.memory_id, h.space_id, count(*)::int, max(g.created_at)
          from recall_event_hits h join gone g on g.id = h.event_id
          group by h.memory_id, h.space_id
          on conflict (memory_id) do update
            set count = memory_recall_stats.count + excluded.count,
              last_recalled_at = greatest(memory_recall_stats.last_recalled_at, excluded.last_recalled_at)
          returning 1
        )
        select count(*)::int as removed from gone`)
      return row?.removed ?? 0
    })
  }
  return removed
}
