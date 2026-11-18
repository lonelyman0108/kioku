import type { BackupRunStatus, DreamRunStatus, DreamTrigger } from '@kioku/contracts'
import { PgBoss, type JobResult } from 'pg-boss'
import postgres from 'postgres'

import { backupJob } from '../backup/storage'
import { rescanAllCirclesSensitive, rescanCircleSensitive } from '../credential/rescan'
import type { MasterKey } from '../crypto/keyring'
import { keyringOf } from '../crypto/keyring'
import { recordMasterKeyError, rotationPass } from '../crypto/rotation'
import { errorText, loggableError, postgresOptions, type Db } from '../db/client'
import { backfillJob, embedJobs, pruneJob, switchJob, type EmbedTarget } from '../embedding/jobs'
import type { EmbedderSource } from '../embedding/source'
import { EMBED_BATCH } from '../embedding/worker'
import type { BufferedSession } from '../extraction/buffer'
import { dreamCircle, dreamsDue, type DreamOutcome } from '../extraction/dream'
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
const RESCAN_SENSITIVE = 'rescan-sensitive'
const DREAM_CRON = '41 * * * *'
const CLEANUP_CRON = '17 * * * *'
const RETRY_AFTER_SECONDS = 10
const EMBED_BUDGET_MS = 2 * 60_000
const EMBED_EXPIRE_SECONDS = 5 * 60
const SWITCH_AGAIN_SECONDS = 30
const SWITCH_CRON = '*/10 * * * *'
const ROTATE_AGAIN_SECONDS = 60
const ROTATE_CRON = '*/10 * * * *'
const BACKUP_CRON = '7 * * * *'
const PRUNE_AFTER_SECONDS = 30

export type PostgresSsl = false | string | boolean | object

export function pgBossSsl(ssl: PostgresSsl, serverUsesSsl: boolean): boolean | object {
  if (ssl === false || ssl === 'disable' || ssl === 'false') return false
  if (ssl === 'require' || ssl === 'no-verify') return { rejectUnauthorized: false }
  if (ssl === 'prefer' || ssl === 'allow')
    return serverUsesSsl ? { rejectUnauthorized: false } : false
  if (ssl === 'verify-ca' || ssl === 'verify-full' || ssl === true) return {}
  if (typeof ssl === 'object') return ssl
  return {}
}

export interface PgBossConnection {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean | object
}

export async function pgBossConnection(url: string): Promise<PgBossConnection> {
  const { options } = postgres(url, postgresOptions({ max: 1 }))
  const ssl = options.ssl as PostgresSsl
  let serverUsesSsl = false
  if (ssl === 'prefer' || ssl === 'allow') {
    const client = postgres(url, postgresOptions({ max: 1 }))
    try {
      const [row] = await client<{ ssl: boolean }[]>`
        select coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false) as ssl`
      serverUsesSsl = row?.ssl === true
    } finally {
      await client.end({ timeout: 1 })
    }
  }
  return {
    host: String(options.host[0] ?? 'localhost'),
    port: Number(options.port[0] ?? 5432),
    database: String(options.database ?? ''),
    user: String(options.user ?? ''),
    password: typeof options.pass === 'string' ? options.pass : '',
    ssl: pgBossSsl(ssl, serverUsesSsl),
  }
}

export interface Jobs {
  enqueueEmbed(circleId: string, entryId: string): void
  enqueueExtraction(target: BufferedSession, delaySeconds: number): Promise<void>
  enqueueBackfill(): Promise<boolean>
  enqueueSwitch(): Promise<boolean>
  enqueuePrune(): Promise<boolean>
  enqueueBackup(): Promise<string | null>
  backupRun(id: string): Promise<BackupRunStatus | null>
  enqueueCleanup(): Promise<boolean>
  enqueueDream(circleId: string): Promise<string | null>
  dreamRun(circleId: string, id: string): Promise<DreamRunStatus | null>
  enqueueSensitiveRescan?: (circleId?: string) => Promise<boolean>
}

interface DreamJob {
  circleId: string
  trigger: DreamTrigger
}

export async function startJobs(options: {
  connectionString: string
  db: Db
  embedder: EmbedderSource
  masterKey: MasterKey | null
  embedBudgetMs?: number
}): Promise<Jobs & { stop: () => Promise<void> }> {
  const boss = new PgBoss({
    ...(await pgBossConnection(options.connectionString)),
    schema: 'pgboss',
  })
  boss.on('error', (err) => console.error('后台任务出错', err))
  await boss.start()

  const embedQueue = { expireInSeconds: EMBED_EXPIRE_SECONDS }
  await boss.createQueue(EMBED, embedQueue)
  await boss.updateQueue(EMBED, embedQueue)
  await boss.createQueue(BACKFILL, { policy: 'singleton' })
  await boss.createQueue(SWITCH, { policy: 'singleton' })
  await boss.createQueue(PRUNE, { policy: 'singleton' })
  await boss.createQueue(ROTATE, { policy: 'singleton' })

  const cleanupQueue = { expireInSeconds: 3600 }
  await boss.createQueue(CLEANUP, { policy: 'singleton', ...cleanupQueue })
  await boss.updateQueue(CLEANUP, cleanupQueue)

  await boss.createQueue(EXTRACT, { policy: 'stately' })

  const backupQueue = { expireInSeconds: 3600, retryLimit: 0 }
  await boss.createQueue(BACKUP, { policy: 'singleton', ...backupQueue })
  await boss.updateQueue(BACKUP, backupQueue)

  const dreamQueue = { expireInSeconds: 3600, retryLimit: 0 }
  await boss.createQueue(DREAM, { policy: 'stately', ...dreamQueue })
  await boss.updateQueue(DREAM, dreamQueue)
  await boss.createQueue(DREAM_TICK, { policy: 'singleton' })
  await boss.createQueue(RESCAN_SENSITIVE, { policy: 'stately' })

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

  const retry = async (circleId: string, ids: string[]): Promise<string[]> => {
    const sent = await Promise.all(
      ids.map((entryId) => send(EMBED, { circleId, entryId }, RETRY_AFTER_SECONDS)),
    )
    return ids.filter((_, i) => sent[i] === undefined)
  }

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

  const masterKey = options.masterKey
  await boss.work(ROTATE, async () => {
    if (!masterKey || !keyringOf(masterKey).previous) return
    try {
      const pass = await rotationPass(options.db, masterKey)
      if (!pass) return
      const { rewrapped, remaining } = pass
      console.log(`主密钥轮换：这次换了 ${rewrapped} 条，还剩 ${remaining} 条`)
      if (remaining) void send(ROTATE, {}, ROTATE_AGAIN_SECONDS)
    } catch (err) {
      console.error('主密钥轮换出错，定时任务会再试', loggableError(err))
      await recordMasterKeyError(options.db, errorText(err)).catch(() => {})
    }
  })
  if (masterKey && keyringOf(masterKey).previous) void send(ROTATE, {})

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

  await boss.work<{ force?: boolean }>(BACKUP, async ([job]) => {
    const outcome = await backupJob(options.db, options.masterKey, Boolean(job?.data?.force))
    if (outcome === 'failed') console.error('备份没做成，原因见实例设置里的备份')
    return { outcome }
  })

  const sendDream = async (circleId: string, trigger: DreamTrigger): Promise<string | null> => {
    try {
      const id = await boss.send(DREAM, { circleId, trigger } satisfies DreamJob, {
        singletonKey: circleId,
      })
      if (id) return id
      const [queued] = await boss.findJobs<DreamJob>(DREAM, { key: circleId, queued: true })
      return queued?.id ?? null
    } catch (err) {
      console.error('入队失败', err)
      return null
    }
  }

  await boss.work<DreamJob>(DREAM, async ([job]) => {
    if (!job) return
    const outcome = await dreamCircle(options.db, options.masterKey, {
      circleId: job.data.circleId,
      runId: job.id,
      trigger: job.data.trigger,
    })
    if (outcome.outcome === 'failed') console.error('Dream 整理出错，原因见待处理页的运行记录')
    return outcome
  })

  await boss.work(DREAM_TICK, async () => {
    for (const circleId of await dreamsDue(options.db)) await sendDream(circleId, 'scheduled')
  })

  await boss.work<{ circleId?: string }>(RESCAN_SENSITIVE, async ([job]) => {
    if (!job) return
    if (job.data?.circleId) {
      await rescanCircleSensitive(options.db, options.masterKey, job.data.circleId)
    } else {
      await rescanAllCirclesSensitive(options.db, options.masterKey)
    }
  })

  await boss.schedule(CLEANUP, CLEANUP_CRON)
  await boss.schedule(BACKUP, BACKUP_CRON)
  await boss.schedule(SWITCH, SWITCH_CRON)
  await boss.schedule(ROTATE, ROTATE_CRON)
  await boss.schedule(DREAM_TICK, DREAM_CRON)

  return {
    enqueueEmbed: (circleId, entryId) => void send(EMBED, { circleId, entryId }),
    enqueueExtraction: (target, delaySeconds) =>
      boss
        .upsert(EXTRACT, target, {
          singletonKey: `${target.circleId}|${target.clientId}|${target.scope}`,
          startAfter: delaySeconds,
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
    enqueueDream: (circleId) => sendDream(circleId, 'manual'),
    dreamRun: async (circleId, id) => {
      const [job] = await boss.findJobs<DreamJob>(DREAM, { id }).catch(() => [])
      if (!job || job.data?.circleId !== circleId) return null
      if (job.state === 'created' || job.state === 'retry') {
        return { state: 'queued', outcome: null, reason: null }
      }
      if (job.state === 'active') return { state: 'running', outcome: null, reason: null }
      const output = job.output as Partial<DreamOutcome> | null
      return job.state === 'completed' && output?.outcome
        ? { state: 'finished', outcome: output.outcome, reason: output.reason ?? null }
        : { state: 'finished', outcome: 'failed', reason: null }
    },
    enqueueSensitiveRescan: (circleId) =>
      boss
        .upsert(RESCAN_SENSITIVE, circleId ? { circleId } : {}, {
          singletonKey: circleId ?? 'all',
          retryLimit: 3,
          retryBackoff: true,
        })
        .then(
          () => true,
          (err: unknown) => {
            console.error('敏感内容回扫入队失败', err)
            return false
          },
        ),
    stop: () => boss.stop({ graceful: true }),
  }
}

export async function requestBackfill(connectionString: string): Promise<void> {
  const boss = new PgBoss({
    ...(await pgBossConnection(connectionString)),
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
