import { PgBoss } from 'pg-boss'

import type { Db } from '../db/client'
import type { Embedder } from '../embedding/provider'
import { backfillEmbeddings, embedMemory } from '../embedding/worker'

const EMBED = 'embed-memory'
const BACKFILL = 'embed-backfill'

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

  await boss.work<{ spaceId: string; memoryId: string }>(EMBED, async (jobs) => {
    const embedder = await options.embedder()
    if (!embedder) return
    for (const job of jobs)
      await embedMemory(options.db, embedder, job.data.spaceId, job.data.memoryId)
  })
  await boss.work(BACKFILL, async () => {
    const embedder = await options.embedder()
    if (embedder)
      console.log(`向量补齐完成：更新 ${await backfillEmbeddings(options.db, embedder)} 条`)
  })

  const send = (name: string, data: object) => {
    boss
      .send(name, data, { retryLimit: 5, retryBackoff: true })
      .catch((err) => console.error('入队失败', err))
  }
  return {
    enqueueEmbed: (spaceId, memoryId) => send(EMBED, { spaceId, memoryId }),
    enqueueBackfill: () => send(BACKFILL, {}),
    stop: () => boss.stop({ graceful: true }),
  }
}

// 给命令行工具用：只投递一次全量补齐，不启动 worker，也不做 pg-boss 的定时维护。
// 服务正在运行时由它的 worker 接手；没在运行时，下次启动也会补齐
export async function requestBackfill(connectionString: string): Promise<void> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', supervise: false, schedule: false })
  boss.on('error', (err) => console.error('后台任务出错', err))
  await boss.start()
  try {
    await boss.createQueue(BACKFILL, { policy: 'singleton' })
    await boss.send(BACKFILL, {}, { retryLimit: 5, retryBackoff: true })
  } finally {
    await boss.stop({ graceful: false })
  }
}
