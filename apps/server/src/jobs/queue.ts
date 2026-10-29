import { PgBoss } from 'pg-boss'

import { backupJob } from '../backup/storage'
import type { MasterKey } from '../crypto/keyring'
import { keyringOf } from '../crypto/keyring'
import { masterKeyStatus, recordMasterKeyError, rotateMasterKey } from '../crypto/rotation'
import type { Db } from '../db/client'
import { backfillJob, embedJob, pruneJob, switchJob } from '../embedding/jobs'
import type { EmbedderSource } from '../embedding/source'
import type { BufferedSession } from '../extraction/buffer'
import { processSession } from '../extraction/worker'
import { cleanupExpired } from './cleanup'

const EMBED = 'embed-memory'
const BACKFILL = 'embed-backfill'
const SWITCH = 'embed-switch'
const PRUNE = 'embed-prune'
const ROTATE = 'rotate-master-key'
const CLEANUP = 'cleanup-expired'
const EXTRACT = 'extract-session'
const BACKUP = 'backup'
// 每小时清一次过期的数据（见 cleanupExpired）
const CLEANUP_CRON = '17 * * * *'
// 写回向量时记忆正被别的事务锁着，隔这么久再试
const RETRY_AFTER_SECONDS = 10
// 换模型时补了一遍还有缺的（期间新写入的、被锁着跳过的），隔这么久再补一遍
const SWITCH_AGAIN_SECONDS = 30
// 换模型补了一遍一条都没补上、或者出了错时不自己再排，由定时任务每十分钟再试一遍：接口恢复了能自己补完，
// 出错时也不会一直请求；没在换模型时这个任务读一下设置就结束
const SWITCH_CRON = '*/10 * * * *'
// 轮换主密钥时有正被别的事务锁着、这次没换的行，隔这么久再来；出了错由每十分钟一次的定时任务再试
// （没配旧主密钥时这个任务什么都不做）
const ROTATE_AGAIN_SECONDS = 60
const ROTATE_CRON = '*/10 * * * *'
// 每小时看一次要不要做备份：到了设定的钟点、那之后还没做成就做（服务停过、做失败了，下一个小时接着补）
const BACKUP_CRON = '7 * * * *'
// 切换或放弃之后等一会儿再清向量：写向量时会锁住设置、按当时的设置决定写不写，这里只是多留一点余量
const PRUNE_AFTER_SECONDS = 30

export interface Jobs {
  enqueueEmbed(spaceId: string, memoryId: string): void
  // 排一批缓冲的抽取，delaySeconds 秒之后开始。同一批只排一个：已经排着的就把开始时间改成这次的，
  // 所以空闲计时从最后一轮算起；正在抽取时另排一个，等它做完再接着处理新进来的。
  // 入队失败只记录日志，不抛错：缓冲还在，下一轮或清理会处理它
  enqueueExtraction(target: BufferedSession, delaySeconds: number): Promise<void>
  // 返回是否入队成功；失败只记录日志，不抛错
  enqueueBackfill(): Promise<boolean>
  // 换模型：补齐新模型的向量，补齐后切过去；没在换模型时什么都不做
  enqueueSwitch(): Promise<boolean>
  // 删掉既不是正在用、也不是正在换过去的模型的向量（切换或放弃换模型之后）
  enqueuePrune(): Promise<boolean>
  // 立即做一份备份传到存储桶（管理员点了「立即备份」），不看钟点
  enqueueBackup(): Promise<boolean>
}

// 后台任务都放在 PostgreSQL 里（pg-boss，schema 为 pgboss），不需要 Redis。
// 入队失败只记录日志：向量稍后会由全量补齐任务补上，不能因此让写入失败
export async function startJobs(options: {
  connectionString: string
  db: Db
  embedder: EmbedderSource
  // 解密实例设置里抽取模型的 Key
  masterKey: MasterKey | null
}): Promise<Jobs & { stop: () => Promise<void> }> {
  const boss = new PgBoss({ connectionString: options.connectionString, schema: 'pgboss' })
  boss.on('error', (err) => console.error('后台任务出错', err))
  await boss.start()
  await boss.createQueue(EMBED)
  await boss.createQueue(BACKFILL, { policy: 'singleton' })
  // singleton：同时只跑一个，排着的可以有几个（定时的、补到一半隔一会儿再排的、管理员重试的），每一遍都可以重复做。
  // 不能用只留一个排队位的策略：先排上的延迟任务会把管理员的重试挤掉
  await boss.createQueue(SWITCH, { policy: 'singleton' })
  await boss.createQueue(PRUNE, { policy: 'singleton' })
  await boss.createQueue(ROTATE, { policy: 'singleton' })
  await boss.createQueue(CLEANUP, { policy: 'singleton' })
  // stately：每个会话（singletonKey）排队的与正在跑的各最多一个
  await boss.createQueue(EXTRACT, { policy: 'stately' })
  await boss.createQueue(BACKUP, { policy: 'singleton' })

  const send = (name: string, data: object, startAfter?: number): Promise<boolean> =>
    boss
      .send(name, data, {
        retryLimit: 5,
        retryBackoff: true,
        ...(startAfter ? { startAfter } : {}),
      })
      .then(
        () => true,
        (err: unknown) => {
          console.error('入队失败', err)
          return false
        },
      )
  // 写回时被别的事务锁着而跳过的记忆，稍后逐条重试
  const retry = (spaceId: string, ids: string[]) => {
    for (const memoryId of ids) void send(EMBED, { spaceId, memoryId }, RETRY_AFTER_SECONDS)
  }

  await boss.work<{ spaceId: string; memoryId: string }>(EMBED, async (jobs) => {
    for (const { data } of jobs) {
      await embedJob(options.db, options.embedder, data.spaceId, data.memoryId, retry)
    }
  })
  await boss.work(BACKFILL, async () => {
    const total = await backfillJob(options.db, options.embedder, retry)
    if (total !== null) console.log(`向量补齐完成：更新 ${total} 条`)
  })
  // 出错时不交给 pg-boss 重试（错误已经记下给管理员看），由定时任务再试
  await boss.work(SWITCH, async () => {
    const outcome = await switchJob(options.db, options.embedder, retry).catch((err: unknown) => {
      console.error('换模型时补向量出错', err)
      return 'stuck' as const
    })
    if (outcome === 'switched' || outcome === 'cancelled') void send(PRUNE, {}, PRUNE_AFTER_SECONDS)
    if (outcome === 'changed') void send(SWITCH, {})
    if (outcome === 'again') void send(SWITCH, {}, SWITCH_AGAIN_SECONDS)
  })
  await boss.work(PRUNE, async () => {
    const removed = await pruneJob(options.db)
    if (removed) console.log(`删掉了 ${removed} 条不再用的向量`)
  })
  // 配了旧主密钥时把还是旧密钥包装的数据密钥换成新的；有被锁着没换的，过一会儿再来
  const masterKey = options.masterKey
  await boss.work(ROTATE, async () => {
    if (!masterKey || !keyringOf(masterKey).previous) return
    try {
      // 先数一数：已经换完（旧的那把还没从配置里去掉）就不用再扫一遍、锁设置
      const { remaining: left } = await masterKeyStatus(options.db, masterKey)
      if (!(left.memories + left.credentials + left.settings)) return
      const { rewrapped, remaining } = await rotateMasterKey(options.db, masterKey)
      console.log(`主密钥轮换：这次换了 ${rewrapped} 条，还剩 ${remaining} 条`)
      if (remaining) void send(ROTATE, {}, ROTATE_AGAIN_SECONDS)
    } catch (err) {
      console.error('主密钥轮换出错，定时任务会再试', err)
      await recordMasterKeyError(options.db, (err as Error).message).catch(() => {})
    }
  })
  if (masterKey && keyringOf(masterKey).previous) void send(ROTATE, {})
  await boss.work(CLEANUP, async () => {
    await cleanupExpired(options.db)
  })
  await boss.work<BufferedSession>(EXTRACT, async (jobs) => {
    for (const { data } of jobs) await processSession(options.db, options.masterKey, data)
  })
  // 备份的结果（含出错）记在设置里给管理员看，不交给 pg-boss 重试：下一个小时的检查会补做
  await boss.work<{ force?: boolean }>(BACKUP, async (jobs) => {
    for (const { data } of jobs) {
      const outcome = await backupJob(options.db, options.masterKey, Boolean(data?.force))
      if (outcome === 'failed') console.error('备份没做成，原因见实例设置里的备份')
    }
  })
  await boss.schedule(CLEANUP, CLEANUP_CRON)
  await boss.schedule(BACKUP, BACKUP_CRON)
  await boss.schedule(SWITCH, SWITCH_CRON)
  await boss.schedule(ROTATE, ROTATE_CRON)

  return {
    enqueueEmbed: (spaceId, memoryId) => void send(EMBED, { spaceId, memoryId }),
    enqueueExtraction: (target, delaySeconds) =>
      boss
        .upsert(EXTRACT, target, {
          singletonKey: `${target.appId}|${target.scope}`,
          startAfter: delaySeconds,
          // 每次重试都要再请求一次模型，比向量任务少试几次
          retryLimit: 3,
          retryBackoff: true,
        })
        .then(
          () => {},
          (err: unknown) => console.error('入队失败', err),
        ),
    enqueueBackfill: () => send(BACKFILL, {}),
    enqueueSwitch: () => send(SWITCH, {}),
    enqueuePrune: () => send(PRUNE, {}, PRUNE_AFTER_SECONDS),
    enqueueBackup: () => send(BACKUP, { force: true }),
    stop: () => boss.stop({ graceful: true }),
  }
}

// 给命令行工具用：只投递一次全量补齐，不启动 worker，也不做 pg-boss 的定时维护。
// 服务正在运行时由它的 worker 接手；没在运行时，下次启动也会补齐
export async function requestBackfill(connectionString: string): Promise<void> {
  // 不做 pg-boss 自己的迁移：工具与服务版本不一致时，不能让工具替服务升级任务表
  const boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    migrate: false,
  })
  boss.on('error', (err) => console.error('后台任务出错', err))
  await boss.start()
  try {
    await boss.createQueue(BACKFILL, { policy: 'singleton' })
    await boss.send(BACKFILL, {}, { retryLimit: 5, retryBackoff: true })
  } finally {
    await boss.stop({ graceful: false })
  }
}
