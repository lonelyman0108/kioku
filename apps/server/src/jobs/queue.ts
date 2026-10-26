import { PgBoss } from 'pg-boss'

import type { Db } from '../db/client'
import type { Embedder } from '../embedding/provider'
import { backfillEmbeddings, embedMemory } from '../embedding/worker'
import { cleanupExpired } from './cleanup'

const EMBED = 'embed-memory'
const BACKFILL = 'embed-backfill'
const CLEANUP = 'cleanup-expired'
// 每小时清一次过期的会话与登录失败计数
const CLEANUP_CRON = '17 * * * *'
// 写回向量时记忆正被别的事务锁着，隔这么久再试
const RETRY_AFTER_SECONDS = 10

export interface Jobs {
  enqueueEmbed(spaceId: string, memoryId: string): void
  enqueueBackfill(): void
}

// 后台任务都放在 PostgreSQL 里（pg-boss，schema 为 pgboss），不需要 Redis。
// 入队失败只记录日志：向量稍后会由全量补齐任务补上，不能因此让写入失败
export async function startJobs(options: {
  connectionString: string
  db: Db
  embedder: () => Promise<Embedder | null>
}): Promise<Jobs & { stop: () => Promise<void> }> {
  const boss = new PgBoss({ connectionString: options.connectionString, schema: 'pgboss' })
  boss.on('error', (err) => console.error('后台任务出错', err))
  await boss.start()
  await boss.createQueue(EMBED)
  await boss.createQueue(BACKFILL, { policy: 'singleton' })
  await boss.createQueue(CLEANUP, { policy: 'singleton' })

  const send = (name: string, data: object, startAfter?: number) => {
    boss
      .send(name, data, {
        retryLimit: 5,
        retryBackoff: true,
        ...(startAfter ? { startAfter } : {}),
      })
      .catch((err) => console.error('入队失败', err))
  }
  // 写回时被别的事务锁着而跳过的记忆，稍后逐条重试
  const retry = (spaceId: string, ids: string[]) => {
    for (const memoryId of ids) send(EMBED, { spaceId, memoryId }, RETRY_AFTER_SECONDS)
  }

  await boss.work<{ spaceId: string; memoryId: string }>(EMBED, async (jobs) => {
    const embedder = await options.embedder()
    if (!embedder) return
    for (const { data } of jobs) {
      await embedMemory(options.db, embedder, data.spaceId, data.memoryId, (ids) =>
        retry(data.spaceId, ids),
      )
    }
  })
  await boss.work(BACKFILL, async () => {
    const embedder = await options.embedder()
    if (embedder) {
      const total = await backfillEmbeddings(options.db, embedder, retry)
      console.log(`向量补齐完成：更新 ${total} 条`)
    }
  })
  await boss.work(CLEANUP, async () => {
    await cleanupExpired(options.db)
  })
  await boss.schedule(CLEANUP, CLEANUP_CRON)

  return {
    enqueueEmbed: (spaceId, memoryId) => send(EMBED, { spaceId, memoryId }),
    enqueueBackfill: () => send(BACKFILL, {}),
    stop: () => boss.stop({ graceful: true }),
  }
}
