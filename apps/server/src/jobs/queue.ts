import type { DreamProgress, DreamTrigger } from '@kioku/contracts'
import { PgBoss } from 'pg-boss'
import postgres from 'postgres'

import { CredentialService } from '../credential/service'
import type { MasterKey } from '../crypto/keyring'
import { loggableError, postgresOptions, type Db } from '../db/client'
import { runBackfillEmbeddings, runEmbedBatch, type EmbedJobTarget } from '../embedding/jobs'
import { EMBED_BATCH } from '../embedding/worker'
import type { BufferedBucket } from '../extraction/buffer'
import { isDreamDue, runDream } from '../extraction/dream'
import { extractEpisodeBatch } from '../extraction/extract'
import { EntryService } from '../memory/service'
import { cleanupExpired } from './cleanup'

const EMBED_ENTRY = 'embed-entry'
const EMBED_BACKFILL = 'embed-backfill'
const EXTRACT_EPISODE = 'extract-episode'
const DREAM = 'dream'
const CLEANUP_EXPIRED = 'cleanup-expired'

const DREAM_CRON = '41 * * * *'
const CLEANUP_CRON = '17 * * * *'
const EMBED_EXPIRE_SECONDS = 5 * 60

export type PostgresSsl = false | string | boolean | object

// pg-boss 底层使用 node-postgres，会把 sslmode=require 当作 verify-full，此处统一换算为与 postgres.js 一致的行为
export function pgBossSsl(ssl: PostgresSsl, serverUsesSsl: boolean): boolean | object {
  if (ssl === false || ssl === 'disable' || ssl === 'false') return false
  if (ssl === 'require' || ssl === 'no-verify') return { rejectUnauthorized: false }
  if (ssl === 'prefer' || ssl === 'allow') {
    return serverUsesSsl ? { rejectUnauthorized: false } : false
  }
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

export interface DreamEnqueueOptions {
  mode?: 'standard' | 'tidy' | undefined
  limit?: number | undefined
  all?: boolean | undefined
  pinnedFirst?: boolean | undefined
  targetShortIds?: string[] | undefined
}

export interface Jobs {
  enqueueEmbed(entryId: string): void
  enqueueBackfill(): Promise<boolean>
  enqueueExtraction(target: BufferedBucket, delaySeconds: number): Promise<void>
  enqueueDream(options?: DreamEnqueueOptions): Promise<string | null>
  isDreamRunning(): Promise<boolean>
  getDreamProgress?(): Promise<DreamProgress | null>
  enqueueCleanup(): Promise<boolean>
}

interface DreamJobData {
  trigger: DreamTrigger
  mode?: 'standard' | 'tidy' | undefined
  limit?: number | undefined
  all?: boolean | undefined
  pinnedFirst?: boolean | undefined
  targetShortIds?: string[] | undefined
}

export async function startJobs(options: {
  connectionString: string
  db: Db
  masterKey: MasterKey | null
}): Promise<Jobs & { stop: () => Promise<void> }> {
  const boss = new PgBoss({
    ...(await pgBossConnection(options.connectionString)),
    schema: 'pgboss',
  })
  boss.on('error', (err) => console.error('后台任务出错', err))
  await boss.start()

  await boss.createQueue(EMBED_ENTRY, { expireInSeconds: EMBED_EXPIRE_SECONDS })
  await boss.createQueue(EMBED_BACKFILL, { policy: 'singleton' })
  await boss.createQueue(EXTRACT_EPISODE, { policy: 'stately' })
  await boss.createQueue(DREAM, { policy: 'singleton', expireInSeconds: 3600, retryLimit: 0 })
  await boss.createQueue(CLEANUP_EXPIRED, { policy: 'singleton', expireInSeconds: 3600 })

  const send = (name: string, data: object, startAfter?: number): Promise<string | null> =>
    boss
      .send(name, data, {
        retryLimit: 5,
        retryBackoff: true,
        ...(startAfter ? { startAfter } : {}),
      })
      .then(
        (id) => id,
        (err: unknown) => {
          console.error('任务入队失败', loggableError(err))
          return null
        },
      )

  let dreamRunning = false
  let enqueuingDream = false
  let dreamPendingId: string | null = null
  let dreamPendingUntil = 0
  let dreamProgress: DreamProgress | null = null
  const handledDreamIds = new Set<string>()
  const stopController = new AbortController()

  const credentialService = new CredentialService(options.db, options.masterKey)
  const jobsApi: Jobs = {
    enqueueEmbed: (entryId) => void send(EMBED_ENTRY, { entryId } satisfies EmbedJobTarget),
    enqueueBackfill: () => send(EMBED_BACKFILL, {}).then((id) => id !== null),
    enqueueExtraction: async (target, delaySeconds) => {
      try {
        await boss.upsert(EXTRACT_EPISODE, target, {
          singletonKey: `${target.deviceKey}|${target.projectSlug}`,
          startAfter: delaySeconds,
          retryLimit: 3,
          retryBackoff: true,
        })
      } catch (err) {
        console.error('摘要抽取入队失败', loggableError(err))
      }
    },
    enqueueDream: async (opts) => {
      if (dreamRunning || enqueuingDream || dreamPendingUntil > Date.now()) return null
      enqueuingDream = true
      try {
        const data: DreamJobData = {
          trigger: 'manual',
          ...(opts?.mode ? { mode: opts.mode } : {}),
          ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts?.all !== undefined ? { all: opts.all } : {}),
          ...(opts?.pinnedFirst !== undefined ? { pinnedFirst: opts.pinnedFirst } : {}),
          ...(opts?.targetShortIds?.length ? { targetShortIds: opts.targetShortIds } : {}),
        }
        const id = await boss.send(DREAM, data, {
          singletonKey: 'dream',
        })
        if (id !== null && !handledDreamIds.has(id)) {
          // 刚入队到 pg-boss 拉起之间存在短暂轮询窗口，提前标记运行中以便前端持续轮询进度
          dreamPendingId = id
          dreamPendingUntil = Date.now() + 15_000
        }
        return id
      } catch (err) {
        console.error('整理任务入队失败', loggableError(err))
        return null
      } finally {
        enqueuingDream = false
      }
    },
    isDreamRunning: async () => dreamRunning || dreamPendingUntil > Date.now(),
    getDreamProgress: async () => (dreamRunning ? dreamProgress : null),
    enqueueCleanup: () => send(CLEANUP_EXPIRED, {}).then((id) => id !== null),
  }

  const entryService = new EntryService(options.db, options.masterKey, credentialService, jobsApi)

  await boss.work<EmbedJobTarget>(
    EMBED_ENTRY,
    { batchSize: EMBED_BATCH, burstWhenBatchFull: true },
    async (batch) => {
      await runEmbedBatch(
        options.db,
        options.masterKey,
        batch.map((job) => job.data),
      )
    },
  )

  await boss.work(EMBED_BACKFILL, async () => {
    const updated = await runBackfillEmbeddings(options.db, options.masterKey)
    if (updated > 0) console.log(`向量补齐完成：更新 ${updated} 条`)
  })

  await boss.work<BufferedBucket>(EXTRACT_EPISODE, async (batch) => {
    for (const job of batch) {
      if (stopController.signal.aborted) break
      await extractEpisodeBatch(
        options.db,
        options.masterKey,
        entryService,
        job.data,
        stopController.signal,
      )
    }
  })

  await boss.work<DreamJobData>(DREAM, async ([job]) => {
    if (!job) return
    handledDreamIds.add(job.id)
    if (handledDreamIds.size > 32) {
      const oldest = handledDreamIds.values().next().value
      if (oldest) handledDreamIds.delete(oldest)
    }
    const trigger: DreamTrigger = job.data?.trigger === 'manual' ? 'manual' : 'scheduled'
    if (trigger === 'scheduled' && !(await isDreamDue(options.db))) return
    if (dreamPendingId === job.id || dreamPendingId === null) {
      dreamPendingId = null
      dreamPendingUntil = 0
    }
    dreamRunning = true
    dreamProgress = null
    try {
      const result = await runDream(options.db, options.masterKey, {
        runId: job.id,
        trigger,
        mode: job.data?.mode,
        limit: job.data?.limit,
        all: job.data?.all,
        pinnedFirst: job.data?.pinnedFirst,
        targetShortIds: job.data?.targetShortIds,
        signal: stopController.signal,
        onProgress: (progress) => {
          dreamProgress = progress
        },
      })
      if (result.outcome === 'failed' || result.outcome === 'partial') {
        console.error('记忆整理出错', result.error)
      }
    } finally {
      dreamRunning = false
      dreamProgress = null
      dreamPendingId = null
      dreamPendingUntil = 0
    }
  })

  await boss.work(CLEANUP_EXPIRED, async () => {
    const counts = await cleanupExpired(options.db)
    const total =
      counts.sessions +
      counts.deviceGrants +
      counts.turnBuffer +
      counts.entries +
      counts.suggestions
    if (total > 0) console.log(`定期清理完成：清理 ${total} 条过期记录`)
  })

  await boss.schedule(DREAM, DREAM_CRON, { trigger: 'scheduled' } satisfies DreamJobData)
  await boss.schedule(CLEANUP_EXPIRED, CLEANUP_CRON)

  return {
    ...jobsApi,
    stop: async () => {
      stopController.abort()
      await boss.stop({ graceful: true })
    },
  }
}
