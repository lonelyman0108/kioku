import type { BackupRunStatus, DreamRunStatus, DreamTrigger } from '@kioku/contracts'
import { PgBoss, type JobResult } from 'pg-boss'

import { backupJob } from '../backup/storage'
import type { MasterKey } from '../crypto/keyring'
import { keyringOf } from '../crypto/keyring'
import { masterKeyStatus, recordMasterKeyError, rotateMasterKey } from '../crypto/rotation'
import { loggableError, type Db } from '../db/client'
import { backfillJob, embedJobs, pruneJob, switchJob, type EmbedTarget } from '../embedding/jobs'
import type { EmbedderSource } from '../embedding/source'
import { EMBED_BATCH } from '../embedding/worker'
import type { BufferedSession } from '../extraction/buffer'
import { dreamsDue, dreamSpace, type DreamOutcome } from '../extraction/dream'
import { processSession } from '../extraction/worker'
import { cleanupExpired } from './cleanup'
import { retentionJob } from './retention'

const EMBED = 'embed-memory'
const BACKFILL = 'embed-backfill'
const SWITCH = 'embed-switch'
const PRUNE = 'embed-prune'
const ROTATE = 'rotate-master-key'
const CLEANUP = 'cleanup-expired'
const EXTRACT = 'extract-session'
const BACKUP = 'backup'
const DREAM = 'dream'
const DREAM_TICK = 'dream-tick'
// 每小时看一次哪些空间今天（UTC）还没做过定时的 Dream 整理，排上（见 dreamsDue）
const DREAM_CRON = '41 * * * *'
// 每小时清一次过期的数据（见 cleanupExpired）；保留期的硬删除跟在后面，一天做一次（见 retentionJob）
const CLEANUP_CRON = '17 * * * *'
// 写回向量时记忆正被别的事务锁着，隔这么久另排一个新任务再试
const RETRY_AFTER_SECONDS = 10
// 写入之后的向量任务一批最多处理这么久：嵌入接口卡住时（每个渠道最多等 30 秒），到点还没生成的不再请求、
// 正在请求的取消，已经拿到的照常写回，剩下的算失败、按任务的重试次数再试（有退避）。
// 正常时一批（最多 32 个空间、两个模型）几十秒内做完
const EMBED_BUDGET_MS = 2 * 60_000
// 向量任务的过期时间，比一批的处理时间长出一截：一批守着时限做完，pg-boss 不会把它当成卡住、
// 整批算失败再和还没停的那一批同时做
const EMBED_EXPIRE_SECONDS = 5 * 60
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
  // 立即做一份备份传到存储桶（管理员点了「立即备份」），不看钟点。返回任务编号，没排进去时为 null
  enqueueBackup(): Promise<string | null>
  // 按编号查一次立即备份的状态；编号不对、或者早就清理掉了时为 null
  backupRun(id: string): Promise<BackupRunStatus | null>
  // 马上做一次定时清理（例如提前结束了从备份恢复之后的保留期暂停）；返回是否入队成功
  enqueueCleanup(): Promise<boolean>
  // 马上整理一次这个空间（成员点了「现在整理一次」）。返回任务编号：这个空间已经有一次排着的整理时给那一次的；
  // 没排进去时为 null
  enqueueDream(spaceId: string): Promise<string | null>
  // 按编号查这个空间的一次整理的状态；编号不对、不是这个空间的、或者早就清理掉了时为 null
  dreamRun(spaceId: string, id: string): Promise<DreamRunStatus | null>
}

interface DreamJob {
  spaceId: string
  trigger: DreamTrigger
}

// 后台任务都放在 PostgreSQL 里（pg-boss，schema 为 pgboss），不需要 Redis。
// 入队失败只记录日志：向量稍后会由全量补齐任务补上，不能因此让写入失败
export async function startJobs(options: {
  connectionString: string
  db: Db
  embedder: EmbedderSource
  // 解密实例设置里抽取模型的 Key
  masterKey: MasterKey | null
  // 写入之后的向量任务一批最多处理多久，不设时 EMBED_BUDGET_MS；测试里调小
  embedBudgetMs?: number
}): Promise<Jobs & { stop: () => Promise<void> }> {
  const boss = new PgBoss({ connectionString: options.connectionString, schema: 'pgboss' })
  boss.on('error', (err) => console.error('后台任务出错', err))
  await boss.start()
  // 队列已经存在时建队列不改选项，所以再更新一遍
  const embedQueue = { expireInSeconds: EMBED_EXPIRE_SECONDS }
  await boss.createQueue(EMBED, embedQueue)
  await boss.updateQueue(EMBED, embedQueue)
  await boss.createQueue(BACKFILL, { policy: 'singleton' })
  // singleton：同时只跑一个，排着的可以有几个（定时的、补到一半隔一会儿再排的、管理员重试的），每一遍都可以重复做。
  // 不能用只留一个排队位的策略：先排上的延迟任务会把管理员的重试挤掉
  await boss.createQueue(SWITCH, { policy: 'singleton' })
  await boss.createQueue(PRUNE, { policy: 'singleton' })
  await boss.createQueue(ROTATE, { policy: 'singleton' })
  // 定时清理里有保留期的硬删除，积压多时（例如升级之后的第一次）一次最多做半小时（见 retentionJob）。
  // pg-boss 默认 15 分钟就当作卡住、另排一次，会和还在跑的那次同时做，所以和备份一样放宽到一小时。
  // 队列一直是 singleton（同时只跑一个）；队列已经存在时建队列不改选项，所以再更新一遍
  const cleanupQueue = { expireInSeconds: 3600 }
  await boss.createQueue(CLEANUP, { policy: 'singleton', ...cleanupQueue })
  await boss.updateQueue(CLEANUP, cleanupQueue)
  // stately：每个会话（singletonKey）排队的与正在跑的各最多一个
  await boss.createQueue(EXTRACT, { policy: 'stately' })
  // 一份备份要读库、加密、上传（上传最长 10 分钟），可能超过 pg-boss 默认的 15 分钟过期时限：过期会被当成卡住、
  // 另排一次，和还在跑的那次同时做。所以放宽到一小时；出错不重试，结果记在设置里，下一个小时的检查会补做。
  // 队列已经存在时建队列不改选项，所以再更新一遍
  const backupQueue = { expireInSeconds: 3600, retryLimit: 0 }
  await boss.createQueue(BACKUP, { policy: 'singleton', ...backupQueue })
  await boss.updateQueue(BACKUP, backupQueue)
  // Dream：stately 加上按空间的 singletonKey，同一个空间排着的、正在整理的各最多一个。一次整理可能请求好几次模型，
  // 和备份一样一小时过期、出错不重试：结果记在运行记录里，第二天的定时整理或者手动再来
  const dreamQueue = { expireInSeconds: 3600, retryLimit: 0 }
  await boss.createQueue(DREAM, { policy: 'stately', ...dreamQueue })
  await boss.updateQueue(DREAM, dreamQueue)
  await boss.createQueue(DREAM_TICK, { policy: 'singleton' })

  // 入队，返回任务编号（队列的策略挡下、没有建新任务时为 null）；入队失败时返回 undefined，只记日志。
  // 失败后默认重试几次；retry 为 false 时用队列上的选项（例如备份不重试）
  const send = (
    name: string,
    data: object,
    startAfter?: number,
    retry = true,
  ): Promise<string | null | undefined> =>
    boss
      .send(name, data, {
        ...(retry ? { retryLimit: 5, retryBackoff: true } : {}),
        ...(startAfter ? { startAfter } : {}),
      })
      .then(
        (id) => id,
        (err: unknown) => {
          console.error('入队失败', err)
          return undefined
        },
      )
  const queued = (id: string | null | undefined) => id !== undefined
  // 写回时被别的事务锁着的记忆另排新任务，稍后逐条再来。等它们排进去，返回没排进去的
  const retry = async (spaceId: string, ids: string[]): Promise<string[]> => {
    const sent = await Promise.all(
      ids.map((memoryId) => send(EMBED, { spaceId, memoryId }, RETRY_AFTER_SECONDS)),
    )
    return ids.filter((_, i) => sent[i] === undefined)
  }

  // 写入之后的向量：一次取一批，同一个空间的合起来请求嵌入接口；一批取满了说明还有积压，马上接着取，不等轮询间隔。
  // 逐个任务记成功或失败（按下标对回任务）：失败的各自按任务的重试次数再试（retryLimit 5、退避，见 send），
  // 不连累同一批的别的任务；被锁着跳过的另排一个新任务、过一会儿再来（RETRY_AFTER_SECONDS），原任务算完成。
  // pg-boss 给每个任务的中止信号（服务停下、任务过期时断开）和处理时间分开传：信号全都断开才算停机，停机时不记也不清错误
  const embedBudgetMs = options.embedBudgetMs ?? EMBED_BUDGET_MS
  await boss.work<EmbedTarget>(
    EMBED,
    { batchSize: EMBED_BATCH, burstWhenBatchFull: true, perJobResults: true },
    async (jobs) => {
      const failed = await embedJobs(
        options.db,
        options.embedder,
        jobs.map((job) => job.data),
        retry,
        {
          budget: AbortSignal.timeout(embedBudgetMs),
          jobs: jobs.map((job) => job.signal),
        },
      )
      return jobs.map((job, index): JobResult => {
        const error = failed.get(index)
        return error
          ? { id: job.id, status: 'failed', output: error }
          : { id: job.id, status: 'completed' }
      })
    },
  )
  await boss.work(BACKFILL, async () => {
    const total = await backfillJob(options.db, options.embedder, retry)
    if (total !== null) console.log(`向量补齐完成：更新 ${total} 条`)
  })
  // 出错时不交给 pg-boss 重试（错误已经记下给管理员看），由定时任务再试
  await boss.work(SWITCH, async () => {
    const outcome = await switchJob(options.db, options.embedder, retry).catch((err: unknown) => {
      console.error('换模型时补向量出错', loggableError(err))
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
      console.error('主密钥轮换出错，定时任务会再试', loggableError(err))
      await recordMasterKeyError(options.db, (err as Error).message).catch(() => {})
    }
  })
  if (masterKey && keyringOf(masterKey).previous) void send(ROTATE, {})
  // 保留期的硬删除放在同一个任务里、清完过期的数据之后再做：和召回明细的清理不会同时跑、互相等锁。
  // 两步各做各的，前一步出错不挡住后一步
  await boss.work(CLEANUP, async () => {
    const expired = await cleanupExpired(options.db).then(
      () => null,
      (err: unknown) => err,
    )
    const retained = await retentionJob(options.db)
    if (retained) {
      const total = Object.values(retained.counts).reduce((a, b) => a + b, 0)
      if (total) console.log(`保留期清理：删掉或抹掉了 ${total} 条`)
      for (const error of retained.errors) console.error(`保留期清理出错：${error}`)
      if (!retained.complete && !retained.errors.length) {
        console.log('保留期清理这次没做完，下一个小时接着做')
      }
    }
    if (expired) throw expired
  })
  await boss.work<BufferedSession>(EXTRACT, async (jobs) => {
    for (const { data } of jobs) await processSession(options.db, options.masterKey, data)
  })
  // 一次取一个任务；结果存成任务的输出，管理界面按任务编号查「立即备份」做得怎么样
  await boss.work<{ force?: boolean }>(BACKUP, async ([job]) => {
    const outcome = await backupJob(options.db, options.masterKey, Boolean(job?.data?.force))
    if (outcome === 'failed') console.error('备份没做成，原因见实例设置里的备份')
    return { outcome }
  })
  // 排一次整理；这个空间已经有一次排着的（stately 不收第二个）就给那一次的编号。失败只记日志
  const sendDream = async (spaceId: string, trigger: DreamTrigger): Promise<string | null> => {
    try {
      const id = await boss.send(DREAM, { spaceId, trigger } satisfies DreamJob, {
        singletonKey: spaceId,
      })
      if (id) return id
      const [queued] = await boss.findJobs<DreamJob>(DREAM, { key: spaceId, queued: true })
      return queued?.id ?? null
    } catch (err) {
      console.error('入队失败', err)
      return null
    }
  }
  // 一次取一个任务；结果存成任务的输出，管理界面按任务编号查「现在整理一次」做得怎么样
  await boss.work<DreamJob>(DREAM, async ([job]) => {
    if (!job) return
    const outcome = await dreamSpace(options.db, options.masterKey, {
      spaceId: job.data.spaceId,
      runId: job.id,
      trigger: job.data.trigger,
    })
    if (outcome.outcome === 'failed') console.error('Dream 整理出错，原因见待审页的运行记录')
    return outcome
  })
  await boss.work(DREAM_TICK, async () => {
    for (const spaceId of await dreamsDue(options.db)) await sendDream(spaceId, 'scheduled')
  })
  await boss.schedule(CLEANUP, CLEANUP_CRON)
  await boss.schedule(BACKUP, BACKUP_CRON)
  await boss.schedule(SWITCH, SWITCH_CRON)
  await boss.schedule(ROTATE, ROTATE_CRON)
  await boss.schedule(DREAM_TICK, DREAM_CRON)

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
    enqueueBackfill: () => send(BACKFILL, {}).then(queued),
    enqueueSwitch: () => send(SWITCH, {}).then(queued),
    enqueuePrune: () => send(PRUNE, {}, PRUNE_AFTER_SECONDS).then(queued),
    enqueueBackup: () => send(BACKUP, { force: true }, undefined, false).then((id) => id ?? null),
    enqueueCleanup: () => send(CLEANUP, {}).then(queued),
    backupRun: async (id) => {
      const job = await boss.getJobById<{ force?: boolean }>(BACKUP, id).catch(() => null)
      if (!job) return null
      if (job.state === 'created' || job.state === 'retry')
        return { state: 'queued', outcome: null }
      if (job.state === 'active') return { state: 'running', outcome: null }
      const outcome = (job.output as { outcome?: BackupRunStatus['outcome'] } | null)?.outcome
      return {
        state: 'finished',
        outcome: job.state === 'completed' && outcome ? outcome : 'failed',
      }
    },
    enqueueDream: (spaceId) => sendDream(spaceId, 'manual'),
    dreamRun: async (spaceId, id) => {
      const [job] = await boss.findJobs<DreamJob>(DREAM, { id }).catch(() => [])
      if (!job || job.data?.spaceId !== spaceId) return null
      if (job.state === 'created' || job.state === 'retry') {
        return { state: 'queued', outcome: null, reason: null }
      }
      if (job.state === 'active') return { state: 'running', outcome: null, reason: null }
      const output = job.output as Partial<DreamOutcome> | null
      return job.state === 'completed' && output?.outcome
        ? { state: 'finished', outcome: output.outcome, reason: output.reason ?? null }
        : { state: 'finished', outcome: 'failed', reason: null }
    },
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
