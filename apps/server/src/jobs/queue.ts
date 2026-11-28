import {
  DREAM_QUEUE_LIMIT,
  dreamTaskSignature,
  normalizeDreamRunParams,
  type DreamEnqueueStatus,
  type DreamMode,
  type DreamProgress,
  type DreamRunParams,
  type DreamScope,
  type DreamTrigger,
  type EmbeddingBackfillRunSummary,
  type EmbeddingBackfillState,
  type QueuedDreamTask,
} from '@kioku/contracts'
import { PgBoss } from 'pg-boss'
import postgres from 'postgres'

import { CredentialService } from '../credential/service'
import type { MasterKey } from '../crypto/keyring'
import { loggableError, postgresOptions, type Db } from '../db/client'
import { runBackfillEmbeddings, runEmbedBatch, type EmbedJobTarget } from '../embedding/jobs'
import { EMBED_BATCH } from '../embedding/worker'
import type { BufferedBucket } from '../extraction/buffer'
import { getDueScheduledDreamModes, runDream } from '../extraction/dream'
import { extractEpisodeBatch } from '../extraction/extract'
import { EntryService } from '../memory/service'
import { CHAT_LLM_SETTING_KEY, loadStoredModel, recordDreamRun } from '../models/store'
import { cleanupExpired } from './cleanup'

const EMBED_ENTRY = 'embed-entry'
const EMBED_BACKFILL = 'embed-backfill'
const EXTRACT_EPISODE = 'extract-episode'
const DREAM = 'dream'
const DREAM_CRON_QUEUE = 'dream-cron'
const CLEANUP_EXPIRED = 'cleanup-expired'

const DREAM_CRON = '41 * * * *'
const CLEANUP_CRON = '17 * * * *'
const EMBED_EXPIRE_SECONDS = 5 * 60
const DREAM_SINGLETON_KEY = 'dream'
const DREAM_PENDING_WINDOW_MS = 15_000

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
  mode?: DreamMode | undefined
  scope?: DreamScope | undefined
  limit?: number | undefined
  all?: boolean | undefined
  pinnedFirst?: boolean | undefined
  targetShortIds?: string[] | undefined
  targetCount?: number | undefined
}

export interface DreamEnqueueResult {
  started: boolean
  status: DreamEnqueueStatus
  position: number
  jobId: string | null
  runId: string | null
  reason?: string | null | undefined
}

export interface DreamQueueSnapshot {
  running: boolean
  activeJobId: string | null
  activeTask: QueuedDreamTask | null
  progress: DreamProgress | null
  queued: QueuedDreamTask[]
  queueLimit: number
}

export interface BackfillEnqueueOptions {
  total?: number | undefined
  model?: string | null | undefined
}

export interface Jobs {
  enqueueEmbed(entryId: string): void
  enqueueBackfill(options?: BackfillEnqueueOptions): Promise<boolean>
  getEmbeddingBackfillState?(): EmbeddingBackfillState
  cancelEmbeddingBackfill?(): Promise<boolean>
  enqueueExtraction(target: BufferedBucket, delaySeconds: number): Promise<void>
  enqueueDream(options?: DreamEnqueueOptions): Promise<DreamEnqueueResult>
  isDreamRunning(): Promise<boolean>
  getDreamProgress?(): Promise<DreamProgress | null>
  getDreamQueueSnapshot?(): DreamQueueSnapshot
  cancelDream?(): Promise<boolean>
  removeQueuedDream?(jobId: string): Promise<boolean>
  clearDreamQueue?(): Promise<number>
  triggerScheduledDreamProbe?(): Promise<number>
  enqueueCleanup(): Promise<boolean>
}

interface DreamJobData {
  trigger: DreamTrigger
  mode?: DreamMode | undefined
  scope?: DreamScope | undefined
  limit?: number | undefined
  all?: boolean | undefined
  pinnedFirst?: boolean | undefined
  targetShortIds?: string[] | undefined
  targetCount?: number | undefined
}

interface TrackedDreamTask {
  id: string
  mode: DreamMode
  trigger: DreamTrigger
  params?: DreamRunParams | undefined
  targetCount?: number | undefined
  enqueuedAt: string
  signature: string
}

function toQueuedDreamTask(task: TrackedDreamTask): QueuedDreamTask {
  return {
    id: task.id,
    mode: task.mode,
    trigger: task.trigger,
    ...(task.params ? { params: task.params } : {}),
    ...(task.targetCount !== undefined ? { targetCount: task.targetCount } : {}),
    enqueuedAt: task.enqueuedAt,
  }
}

function resolveTargetCount(
  mode: DreamMode,
  params: DreamRunParams | undefined,
  explicit?: number,
): number | undefined {
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit >= 0) {
    return explicit
  }
  if (params?.targetShortIds?.length) return params.targetShortIds.length
  if (mode === 'tidy' && !params?.all && params?.limit !== undefined) return params.limit
  return undefined
}

function trackedTaskFromJobData(
  id: string,
  data: DreamJobData | null | undefined,
  enqueuedAt: string,
): TrackedDreamTask {
  const mode: DreamMode =
    data?.mode === 'tidy' || data?.mode === 'cross_memory' ? data.mode : 'standard'
  const trigger: DreamTrigger = data?.trigger === 'scheduled' ? 'scheduled' : 'manual'
  const params = normalizeDreamRunParams(data)
  const targetCount = resolveTargetCount(mode, params, data?.targetCount)
  return {
    id,
    mode,
    trigger,
    ...(params ? { params } : {}),
    ...(targetCount !== undefined ? { targetCount } : {}),
    enqueuedAt,
    signature: dreamTaskSignature({ mode, ...params }),
  }
}

function scheduledOptionsForMode(mode: DreamMode): DreamEnqueueOptions {
  if (mode === 'cross_memory') return { mode: 'cross_memory', scope: 'full_corpus' }
  if (mode === 'tidy') return { mode: 'tidy', limit: 20, pinnedFirst: true }
  return { mode: 'standard' }
}

export async function startJobs(options: {
  connectionString: string
  db: Db
  masterKey: MasterKey | null
  dreamPollingIntervalSeconds?: number | undefined
}): Promise<Jobs & { stop: () => Promise<void> }> {
  const boss = new PgBoss({
    ...(await pgBossConnection(options.connectionString)),
    schema: 'pgboss',
  })
  boss.on('error', (err) => console.error('后台任务出错', err))
  await boss.start()

  await boss.createQueue(EMBED_ENTRY, { expireInSeconds: EMBED_EXPIRE_SECONDS })
  await boss.createQueue(EMBED_BACKFILL, {
    policy: 'singleton',
    expireInSeconds: 3600,
    retryLimit: 0,
  })
  await boss.createQueue(EXTRACT_EPISODE, { policy: 'stately' })
  await boss.createQueue(DREAM, { policy: 'singleton', expireInSeconds: 3600, retryLimit: 0 })
  await boss.createQueue(DREAM_CRON_QUEUE, {
    policy: 'singleton',
    expireInSeconds: 300,
    retryLimit: 0,
  })
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
  let activeDream: TrackedDreamTask | null = null
  let activePendingUntil = 0
  const dreamQueue: TrackedDreamTask[] = []
  let dreamProgress: DreamProgress | null = null
  let dreamAbortController: AbortController | null = null
  let dreamRunPromise: Promise<void> | null = null
  const handledDreamIds = new Set<string>()
  const cancelledDreamIds = new Set<string>()

  let dreamLockTail: Promise<void> = Promise.resolve()
  const withDreamLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = dreamLockTail
    let release!: () => void
    dreamLockTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return prev.then(fn).finally(release)
  }

  const pruneStalePendingActive = () => {
    if (
      !dreamRunning &&
      activeDream !== null &&
      activePendingUntil > 0 &&
      Date.now() >= activePendingUntil &&
      dreamQueue.length === 0
    ) {
      activeDream = null
      activePendingUntil = 0
    }
  }

  const RECENT_BACKFILL_RUNS_LIMIT = 20
  let backfillRunning = false
  let backfillPendingId: string | null = null
  let backfillPendingUntil = 0
  let backfillAbortController: AbortController | null = null
  let backfillRunPromise: Promise<void> | null = null
  const handledBackfillIds = new Set<string>()
  const cancelledBackfillIds = new Set<string>()
  let backfillProgress: { processed: number; total: number; model: string | null } = {
    processed: 0,
    total: 0,
    model: null,
  }
  let backfillLast: {
    finishedAt: string | null
    outcome: 'ok' | 'cancelled' | 'failed' | null
    updatedCount: number
    error: string | null
  } = {
    finishedAt: null,
    outcome: null,
    updatedCount: 0,
    error: null,
  }
  const backfillRecentRuns: EmbeddingBackfillRunSummary[] = []

  const recordBackfillRun = (run: EmbeddingBackfillRunSummary) => {
    backfillLast = {
      finishedAt: run.finishedAt,
      outcome: run.outcome,
      updatedCount: run.updated,
      error: run.error,
    }
    backfillRecentRuns.unshift(run)
    if (backfillRecentRuns.length > RECENT_BACKFILL_RUNS_LIMIT) {
      backfillRecentRuns.length = RECENT_BACKFILL_RUNS_LIMIT
    }
  }

  const stopController = new AbortController()

  const trackIdSet = (set: Set<string>, id: string) => {
    set.add(id)
    if (set.size > 64) {
      const oldest = set.values().next().value
      if (oldest) set.delete(oldest)
    }
  }

  const waitBriefly = (promise: Promise<void> | null, ms = 500) =>
    promise
      ? Promise.race([
          promise.catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, ms)),
        ])
      : Promise.resolve()

  // 启动时从 pg-boss 恢复未开始执行的整理队列镜像，避免日常轮询反复扫描任务表
  const existingDreamJobs = await boss
    .findJobs<DreamJobData>(DREAM, { queued: true, limit: 100 })
    .catch(() => [])
  for (const job of existingDreamJobs) {
    if (job.state !== 'created' && job.state !== 'retry') continue
    const enqueuedAt =
      job.createdOn instanceof Date
        ? job.createdOn.toISOString()
        : new Date(job.createdOn).toISOString()
    const tracked = trackedTaskFromJobData(job.id, job.data, enqueuedAt)
    if (!activeDream) {
      activeDream = tracked
      activePendingUntil = Date.now() + DREAM_PENDING_WINDOW_MS
    } else {
      dreamQueue.push(tracked)
    }
  }

  const enqueueDreamInternal = (
    opts: DreamEnqueueOptions | undefined,
    trigger: DreamTrigger,
    guardOptions: { deferIfManualActive?: boolean } = {},
  ): Promise<DreamEnqueueResult> =>
    withDreamLock(async () => {
      pruneStalePendingActive()
      if (
        guardOptions.deferIfManualActive &&
        (activeDream?.trigger === 'manual' || dreamQueue.some((item) => item.trigger === 'manual'))
      ) {
        return {
          started: false,
          status: 'rejected',
          position: 0,
          jobId: null,
          runId: null,
          reason: '已有手动整理任务在排队或执行中，已顺延定时整理',
        }
      }

      const mode: DreamMode =
        opts?.mode === 'tidy' || opts?.mode === 'cross_memory' ? opts.mode : 'standard'
      const params = normalizeDreamRunParams(opts)
      const signature = dreamTaskSignature({ mode, ...params })

      const isDuplicate =
        activeDream?.signature === signature ||
        dreamQueue.some((item) => item.signature === signature)
      if (isDuplicate) {
        return {
          started: false,
          status: 'rejected',
          position: 0,
          jobId: null,
          runId: null,
          reason: '已有相同的整理任务正在执行或排队中',
        }
      }

      const hasActive = activeDream !== null
      if (hasActive && dreamQueue.length >= DREAM_QUEUE_LIMIT) {
        return {
          started: false,
          status: 'rejected',
          position: 0,
          jobId: null,
          runId: null,
          reason: `整理等待队列已满（最多 ${DREAM_QUEUE_LIMIT} 项），请稍后再试`,
        }
      }

      const targetCount = resolveTargetCount(mode, params, opts?.targetCount)
      const data: DreamJobData = {
        trigger,
        mode,
        ...(params?.scope !== undefined ? { scope: params.scope } : {}),
        ...(params?.limit !== undefined ? { limit: params.limit } : {}),
        ...(params?.all !== undefined ? { all: params.all } : {}),
        ...(params?.pinnedFirst !== undefined ? { pinnedFirst: params.pinnedFirst } : {}),
        ...(params?.targetShortIds?.length ? { targetShortIds: params.targetShortIds } : {}),
        ...(targetCount !== undefined ? { targetCount } : {}),
      }

      let id: string | null
      try {
        id = await boss.send(DREAM, data, { singletonKey: DREAM_SINGLETON_KEY })
      } catch (err) {
        console.error('整理任务入队失败', loggableError(err))
        return {
          started: false,
          status: 'rejected',
          position: 0,
          jobId: null,
          runId: null,
          reason: '整理任务入队失败，请稍后重试',
        }
      }

      if (id === null) {
        return {
          started: false,
          status: 'rejected',
          position: 0,
          jobId: null,
          runId: null,
          reason: '整理任务入队失败，请稍后重试',
        }
      }

      const tracked: TrackedDreamTask = {
        id,
        mode,
        trigger,
        ...(params ? { params } : {}),
        ...(targetCount !== undefined ? { targetCount } : {}),
        enqueuedAt: new Date().toISOString(),
        signature,
      }

      if (!handledDreamIds.has(id)) {
        if (!hasActive) {
          activeDream = tracked
          activePendingUntil = Date.now() + DREAM_PENDING_WINDOW_MS
          return {
            started: true,
            status: 'started',
            position: 0,
            jobId: id,
            runId: id,
          }
        }
        dreamQueue.push(tracked)
        return {
          started: true,
          status: 'queued',
          position: dreamQueue.length,
          jobId: id,
          runId: id,
        }
      }

      return {
        started: true,
        status: hasActive ? 'queued' : 'started',
        position: hasActive ? Math.max(1, dreamQueue.length) : 0,
        jobId: id,
        runId: id,
      }
    })

  // 独立周期探测：已有整理任务运行或排队时自动顺延至下一周期，避免定时任务插队或污染等待队列
  const runScheduledDreamProbe = async (): Promise<number> => {
    if (stopController.signal.aborted) return 0
    const busy = await withDreamLock(async () => {
      pruneStalePendingActive()
      return dreamRunning || activeDream !== null || dreamQueue.length > 0
    })
    if (busy) return 0

    const chat = await loadStoredModel(options.db, CHAT_LLM_SETTING_KEY)
    if (!chat?.enabled) return 0

    const dueModes = await getDueScheduledDreamModes(options.db)
    if (!dueModes.length) return 0

    let enqueued = 0
    for (const mode of dueModes) {
      if (stopController.signal.aborted) break
      const res = await enqueueDreamInternal(scheduledOptionsForMode(mode), 'scheduled', {
        deferIfManualActive: true,
      })
      if (res.started) enqueued++
      else break
    }
    return enqueued
  }

  const getDreamQueueSnapshot = (): DreamQueueSnapshot => {
    pruneStalePendingActive()
    const running =
      dreamRunning ||
      (activeDream !== null && (activePendingUntil === 0 || Date.now() < activePendingUntil))
    return {
      running,
      activeJobId: running && activeDream ? activeDream.id : null,
      activeTask: running && activeDream ? toQueuedDreamTask(activeDream) : null,
      progress: dreamRunning ? dreamProgress : null,
      queued: dreamQueue.map(toQueuedDreamTask),
      queueLimit: DREAM_QUEUE_LIMIT,
    }
  }

  const credentialService = new CredentialService(options.db, options.masterKey)
  const jobsApi: Jobs = {
    enqueueEmbed: (entryId) => void send(EMBED_ENTRY, { entryId } satisfies EmbedJobTarget),
    enqueueBackfill: async (opts) => {
      if (backfillRunning || backfillPendingUntil > Date.now()) return false
      const id = await boss.send(EMBED_BACKFILL, {}, { singletonKey: 'embed-backfill' }).then(
        (jobId) => jobId,
        (err: unknown) => {
          console.error('向量补齐入队失败', loggableError(err))
          return null
        },
      )
      if (id !== null && !handledBackfillIds.has(id)) {
        backfillPendingId = id
        backfillPendingUntil = Date.now() + 15_000
        backfillProgress = {
          processed: 0,
          total: Math.max(0, opts?.total ?? 0),
          model: opts?.model ?? null,
        }
      }
      return id !== null
    },
    getEmbeddingBackfillState: () => {
      const running = backfillRunning || backfillPendingUntil > Date.now()
      return {
        running,
        processed: running ? backfillProgress.processed : 0,
        total: running ? backfillProgress.total : 0,
        model: running ? backfillProgress.model : null,
        lastFinishedAt: backfillLast.finishedAt,
        lastOutcome: backfillLast.outcome,
        lastUpdatedCount: backfillLast.updatedCount,
        lastError: backfillLast.error,
        recentRuns: [...backfillRecentRuns],
      }
    },
    cancelEmbeddingBackfill: async () => {
      if (backfillRunning && backfillAbortController) {
        backfillAbortController.abort('user_cancelled')
        await waitBriefly(backfillRunPromise)
        return true
      }
      if (backfillPendingId !== null && !handledBackfillIds.has(backfillPendingId)) {
        const pendingId = backfillPendingId
        const pendingTotal = backfillProgress.total
        const pendingModel = backfillProgress.model
        trackIdSet(cancelledBackfillIds, pendingId)
        backfillPendingId = null
        backfillPendingUntil = 0
        await boss.cancel(EMBED_BACKFILL, pendingId).catch(() => undefined)
        const nowIso = new Date().toISOString()
        recordBackfillRun({
          id: pendingId,
          outcome: 'cancelled',
          processed: 0,
          total: pendingTotal,
          updated: 0,
          model: pendingModel,
          error: null,
          startedAt: nowIso,
          finishedAt: nowIso,
        })
        return true
      }
      return false
    },
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
    enqueueDream: (opts) => enqueueDreamInternal(opts, 'manual'),
    isDreamRunning: async () => getDreamQueueSnapshot().running,
    getDreamProgress: async () => (dreamRunning ? dreamProgress : null),
    getDreamQueueSnapshot,
    cancelDream: async () => {
      if (dreamRunning && dreamAbortController) {
        dreamAbortController.abort('user_cancelled')
        await waitBriefly(dreamRunPromise)
        return true
      }
      return withDreamLock(async () => {
        pruneStalePendingActive()
        if (activeDream !== null && !dreamRunning && !handledDreamIds.has(activeDream.id)) {
          const pending = activeDream
          trackIdSet(cancelledDreamIds, pending.id)
          const next = dreamQueue.shift() ?? null
          activeDream = next
          activePendingUntil = next ? Date.now() + DREAM_PENDING_WINDOW_MS : 0
          await boss.cancel(DREAM, pending.id).catch(() => undefined)
          await recordDreamRun(options.db, {
            id: pending.id,
            trigger: pending.trigger,
            mode: pending.mode,
            outcome: 'cancelled',
            considered: 0,
            suggested: 0,
            error: null,
            abortedReason: '已手动取消',
            ...(pending.params ? { params: pending.params } : {}),
            createdAt: new Date().toISOString(),
          }).catch(() => undefined)
          return true
        }
        return false
      })
    },
    removeQueuedDream: (jobId) =>
      withDreamLock(async () => {
        const idx = dreamQueue.findIndex((item) => item.id === jobId)
        if (idx === -1) return false
        const [removed] = dreamQueue.splice(idx, 1)
        trackIdSet(cancelledDreamIds, removed!.id)
        await boss.cancel(DREAM, removed!.id).catch(() => undefined)
        return true
      }),
    clearDreamQueue: () =>
      withDreamLock(async () => {
        if (!dreamQueue.length) return 0
        const removedItems = dreamQueue.splice(0, dreamQueue.length)
        const ids = removedItems.map((item) => item.id)
        for (const id of ids) trackIdSet(cancelledDreamIds, id)
        await boss.cancel(DREAM, ids).catch(() => undefined)
        return ids.length
      }),
    triggerScheduledDreamProbe: runScheduledDreamProbe,
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

  await boss.work(EMBED_BACKFILL, async ([job]) => {
    if (!job) return
    trackIdSet(handledBackfillIds, job.id)
    if (cancelledBackfillIds.delete(job.id)) return
    if (backfillPendingId === job.id || backfillPendingId === null) {
      backfillPendingId = null
      backfillPendingUntil = 0
    }
    const runAbort = new AbortController()
    backfillAbortController = runAbort
    const combinedSignal = AbortSignal.any([stopController.signal, runAbort.signal])
    backfillRunning = true
    backfillProgress = {
      processed: 0,
      total: backfillProgress.total,
      model: backfillProgress.model,
    }
    let reportedProgress = false
    const startedAt = new Date().toISOString()
    const run = (async () => {
      try {
        const updated = await runBackfillEmbeddings(
          options.db,
          options.masterKey,
          combinedSignal,
          (progress) => {
            reportedProgress = true
            backfillProgress = progress
          },
        )
        if (updated > 0) console.log(`向量补齐完成：更新 ${updated} 条`)
        recordBackfillRun({
          id: job.id,
          outcome: runAbort.signal.aborted ? 'cancelled' : 'ok',
          processed: reportedProgress ? backfillProgress.processed : updated,
          total: reportedProgress ? backfillProgress.total : updated,
          updated,
          model: backfillProgress.model,
          error: null,
          startedAt,
          finishedAt: new Date().toISOString(),
        })
      } catch (err) {
        if (runAbort.signal.aborted) {
          recordBackfillRun({
            id: job.id,
            outcome: 'cancelled',
            processed: reportedProgress ? backfillProgress.processed : 0,
            total: reportedProgress ? backfillProgress.total : 0,
            updated: reportedProgress ? backfillProgress.processed : 0,
            model: backfillProgress.model,
            error: null,
            startedAt,
            finishedAt: new Date().toISOString(),
          })
        } else {
          const message = err instanceof Error ? err.message : String(err)
          console.error('向量补齐失败', loggableError(err))
          recordBackfillRun({
            id: job.id,
            outcome: 'failed',
            processed: reportedProgress ? backfillProgress.processed : 0,
            total: reportedProgress ? backfillProgress.total : 0,
            updated: reportedProgress ? backfillProgress.processed : 0,
            model: backfillProgress.model,
            error: message.slice(0, 300),
            startedAt,
            finishedAt: new Date().toISOString(),
          })
        }
      } finally {
        backfillRunning = false
        backfillAbortController = null
        backfillRunPromise = null
        backfillPendingId = null
        backfillPendingUntil = 0
      }
    })()
    backfillRunPromise = run
    await run
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

  await boss.work<DreamJobData>(
    DREAM,
    { pollingIntervalSeconds: options.dreamPollingIntervalSeconds ?? 1 },
    async ([job]) => {
      if (!job) return
      const claimed = await withDreamLock(async () => {
        trackIdSet(handledDreamIds, job.id)
        if (cancelledDreamIds.delete(job.id)) {
          if (activeDream?.id === job.id) {
            const next = dreamQueue.shift() ?? null
            activeDream = next
            activePendingUntil = next ? Date.now() + DREAM_PENDING_WINDOW_MS : 0
          }
          return null
        }

        const qIdx = dreamQueue.findIndex((item) => item.id === job.id)
        let task: TrackedDreamTask
        if (activeDream?.id === job.id) {
          task = activeDream
        } else if (qIdx >= 0) {
          task = dreamQueue.splice(qIdx, 1)[0]!
          activeDream = task
        } else {
          task = trackedTaskFromJobData(job.id, job.data, new Date().toISOString())
          activeDream = task
        }
        activePendingUntil = 0
        dreamRunning = true
        dreamProgress = null
        const runAbort = new AbortController()
        dreamAbortController = runAbort
        return { task, runAbort }
      })

      if (!claimed) return

      const { task, runAbort } = claimed
      const combinedSignal = AbortSignal.any([stopController.signal, runAbort.signal])
      const isLegacyAggregateScheduled =
        job.data?.trigger === 'scheduled' && job.data?.mode === undefined
      let fatalReason: string | null = null

      const run = (async () => {
        try {
          if (isLegacyAggregateScheduled) {
            const scheduledModes = await getDueScheduledDreamModes(options.db)
            for (const mode of scheduledModes) {
              if (combinedSignal.aborted) break
              const modeOpts = scheduledOptionsForMode(mode)
              const result = await runDream(options.db, options.masterKey, {
                runId: `${job.id}:${mode}`,
                trigger: 'scheduled',
                mode,
                ...(modeOpts.scope ? { scope: modeOpts.scope } : {}),
                ...(modeOpts.limit !== undefined ? { limit: modeOpts.limit } : {}),
                ...(modeOpts.pinnedFirst !== undefined
                  ? { pinnedFirst: modeOpts.pinnedFirst }
                  : {}),
                signal: combinedSignal,
                onProgress: (progress) => {
                  dreamProgress = progress
                },
              })
              if (result.outcome === 'failed' || result.outcome === 'partial') {
                console.error(`定时记忆整理（${mode}）出错`, result.error)
              }
              if (result.fatalAbort) {
                fatalReason = result.abortedReason ?? result.error ?? '上游模型服务不可用'
                break
              }
            }
          } else {
            const result = await runDream(options.db, options.masterKey, {
              runId: job.id,
              trigger: task.trigger,
              mode: task.mode,
              scope: task.params?.scope,
              limit: task.params?.limit,
              all: task.params?.all,
              pinnedFirst: task.params?.pinnedFirst,
              targetShortIds: task.params?.targetShortIds,
              signal: combinedSignal,
              onProgress: (progress) => {
                dreamProgress = progress
              },
            })
            if (result.outcome === 'failed' || result.outcome === 'partial') {
              console.error('记忆整理出错', result.error)
            }
            if (result.fatalAbort) {
              fatalReason = result.abortedReason ?? result.error ?? '上游模型服务不可用'
            }
          }
        } finally {
          await withDreamLock(async () => {
            dreamAbortController = null
            dreamRunPromise = null
            dreamRunning = false
            dreamProgress = null

            if (fatalReason && dreamQueue.length > 0) {
              const abortedItems = dreamQueue.splice(0, dreamQueue.length)
              const ids = abortedItems.map((item) => item.id)
              for (const id of ids) trackIdSet(cancelledDreamIds, id)
              await boss.cancel(DREAM, ids).catch(() => undefined)
              const nowIso = new Date().toISOString()
              const abortText = `因前序任务触发上游故障已中止：${fatalReason}`.slice(0, 300)
              for (const item of abortedItems) {
                await recordDreamRun(
                  options.db,
                  {
                    id: item.id,
                    trigger: item.trigger,
                    mode: item.mode,
                    outcome: 'cancelled',
                    considered: 0,
                    suggested: 0,
                    error: null,
                    abortedReason: abortText,
                    ...(item.params ? { params: item.params } : {}),
                    createdAt: nowIso,
                  },
                  { preserveLastOutcome: true },
                ).catch(() => undefined)
              }
              console.error(
                `整理队列触发上游故障熔断，已中止剩余 ${abortedItems.length} 项等待任务：${fatalReason}`,
              )
              activeDream = null
              activePendingUntil = 0
              return
            }

            if (activeDream?.id === job.id) {
              if (!stopController.signal.aborted && dreamQueue.length > 0) {
                activeDream = dreamQueue.shift()!
                activePendingUntil = Date.now() + DREAM_PENDING_WINDOW_MS
              } else {
                activeDream = null
                activePendingUntil = 0
              }
            }
          })
        }
      })()
      dreamRunPromise = run
      await run
    },
  )

  await boss.work(DREAM_CRON_QUEUE, async () => {
    await runScheduledDreamProbe()
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

  // 清除旧版直接挂在 dream 队列上的定时计划，改由独立的轻量探测队列按需入队
  await boss.unschedule(DREAM).catch(() => undefined)
  await boss.schedule(DREAM_CRON_QUEUE, DREAM_CRON, {})
  await boss.schedule(CLEANUP_EXPIRED, CLEANUP_CRON)

  return {
    ...jobsApi,
    stop: async () => {
      stopController.abort()
      await boss.stop({ graceful: true })
    },
  }
}
