import { normalizeWhen } from '@kioku/contracts'
import { and, asc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm'

import { loadCirclePrivacy, maskForOutbound } from '../credential/privacy'
import { withCircle, type Db, type Tx } from '../db/client'
import { circles, entries, entryEmbeddings, entryGlossary, entryVariants } from '../db/schema'
import { EMBEDDABLE } from './coverage'
import type { Embedder } from './provider'
import { lockEmbeddingModels } from './settings'
import { embeddingText, textHash } from './text'

// 一次请求嵌入接口最多带这么多条文本
export const EMBED_BATCH = 32
const PAGE = EMBED_BATCH * 4
// 整批失败后逐条再试时，最短的这么多条都失败，就当作接口（或渠道）不可用，不再一条条请求
const GIVE_UP_AFTER = 3

const entryStampSql = sql<string>`${entries}.xmin::text`
const variantStampSql = sql<string>`${entryVariants}.xmin::text`

// 接口不可用（逐条再试时最短的几条都失败）时 syncRows 抛出它：已经拿到的向量写回了，
// unfinished 是这一组里还没生成向量的词条 id
export class EmbedUnavailable extends Error {
  readonly unfinished: string[]
  constructor(cause: Error, unfinished: string[]) {
    super(cause.message, { cause })
    this.unfinished = unfinished
  }
}

export interface SyncHooks {
  // 写回时正被别的事务锁着、这次没处理的词条，交给调用方稍后重试
  onSkipped?: ((ids: string[]) => void | Promise<void>) | undefined
  // 逐条再试时某词条的切片失败（例如正文超过模型长度上限）：跳过它，别的照常写
  onFailed?: ((entryId: string, message: string) => void) | undefined
  // 处理时间用完了、服务要停（signal）：还没请求的不再请求，写回已拿到的向量，其余交 onDeferred
  signal?: AbortSignal | undefined
  onDeferred?: ((ids: string[]) => void) | undefined
}

async function keptModels(tx: Tx, embedder: Embedder): Promise<string[]> {
  const { active, next } = await lockEmbeddingModels(tx)
  const kept = [active, next].flatMap((s) => (s ? [s.model] : []))
  return kept.length ? kept : [embedder.model]
}

async function embedBatch(
  embedder: Embedder,
  batch: { id: string; text: string }[],
  hooks: {
    signal?: AbortSignal | undefined
    onFailed?: ((id: string, message: string) => void) | undefined
  },
): Promise<{ vectors: Map<string, number[]>; broken: Error | null }> {
  const { signal, onFailed } = hooks
  const options = signal ? { signal } : {}
  const vectors = new Map<string, number[]>()
  try {
    const out = await embedder.embed(
      batch.map((p) => p.text),
      options,
    )
    batch.forEach((p, j) => vectors.set(p.id, out[j]!))
    return { vectors, broken: null }
  } catch (err) {
    if (signal?.aborted) return { vectors, broken: null }
    if (batch.length === 1) {
      onFailed?.(batch[0]!.id, (err as Error).message)
      return { vectors, broken: null }
    }
  }
  let probing = batch.length >= GIVE_UP_AFTER
  const held: { id: string; message: string }[] = []
  for (const item of [...batch].sort((a, b) => a.text.length - b.text.length)) {
    if (signal?.aborted) break
    try {
      const [vector] = await embedder.embed([item.text], options)
      vectors.set(item.id, vector!)
      if (probing) {
        probing = false
        for (const f of held) onFailed?.(f.id, f.message)
      }
    } catch (err) {
      if (signal?.aborted) break
      const message = (err as Error).message
      if (!probing) {
        onFailed?.(item.id, message)
        continue
      }
      held.push({ id: item.id, message })
      if (held.length >= GIVE_UP_AFTER) return { vectors, broken: err as Error }
    }
  }
  return { vectors, broken: null }
}

interface PendingVariant {
  variantId: string
  entryId: string
  text: string
  hash: string
}

function variantSignature(stamps: ReadonlyMap<string, string>): string {
  return [...stamps.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, s]) => `${id}:${s}`)
    .join('|')
}

// 为一批词条生成或刷新此模型的所有合资格（entry + fact）变体切片向量；
// 三段式执行：短事务读出 → 事务外请求嵌入接口 → 短事务校验 xmin 后写回并清理无效与过期模型向量
async function syncRows(
  db: Db,
  embedder: Embedder,
  circleId: string,
  entryIds: string[],
  hooks: SyncHooks,
): Promise<number> {
  if (!entryIds.length) return 0

  const { stale, pending, readEntryStamps, readVariantStamps } = await withCircle(
    db,
    circleId,
    async (tx) => {
      const { settings: privacy } = await loadCirclePrivacy(tx, circleId)
      const rows = await tx
        .select({
          entry: entries,
          variant: entryVariants,
          entryStamp: entryStampSql,
          variantStamp: variantStampSql,
          embeddable: sql<boolean>`coalesce(${EMBEDDABLE}, false)`,
        })
        .from(entryVariants)
        .innerJoin(entries, eq(entries.id, entryVariants.entryId))
        .where(inArray(entries.id, entryIds))
        .orderBy(asc(entries.id), asc(entryVariants.id))

      const [glossaryRows, existing] = await Promise.all([
        tx.select().from(entryGlossary).where(inArray(entryGlossary.entryId, entryIds)),
        tx
          .select({
            variantId: entryEmbeddings.variantId,
            entryId: entryEmbeddings.entryId,
            contentHash: entryEmbeddings.contentHash,
          })
          .from(entryEmbeddings)
          .where(
            and(
              inArray(entryEmbeddings.entryId, entryIds),
              eq(entryEmbeddings.model, embedder.model),
            ),
          ),
      ])

      const glossaryByEntry = new Map<string, string[]>()
      for (const g of glossaryRows) {
        const list = glossaryByEntry.get(g.entryId) ?? []
        list.push(maskForOutbound(g.keyword, privacy))
        glossaryByEntry.set(g.entryId, list)
      }
      for (const list of glossaryByEntry.values()) list.sort()

      const existingByVariant = new Map(existing.map((e) => [e.variantId, e]))
      const readEntryStamps = new Map<string, string>()
      const readVariantStamps = new Map<string, Map<string, string>>()
      const seenVariants = new Set<string>()
      const stale: { variantId: string; entryId: string }[] = []
      const pending: PendingVariant[] = []

      for (const { entry, variant, entryStamp, variantStamp, embeddable } of rows) {
        readEntryStamps.set(entry.id, entryStamp)
        let vMap = readVariantStamps.get(entry.id)
        if (!vMap) {
          vMap = new Map()
          readVariantStamps.set(entry.id, vMap)
        }
        vMap.set(variant.id, variantStamp)
        seenVariants.add(variant.id)

        if (!embeddable || !variant.content) {
          if (existingByVariant.has(variant.id)) {
            stale.push({ variantId: variant.id, entryId: entry.id })
          }
          continue
        }

        const text = embeddingText({
          title: maskForOutbound(entry.title, privacy),
          topics: entry.topics.map((t) => maskForOutbound(t, privacy)),
          when: normalizeWhen(variant.when),
          disclosure: entry.disclosure ? maskForOutbound(entry.disclosure, privacy) : null,
          glossary: glossaryByEntry.get(entry.id) ?? [],
          content: maskForOutbound(variant.content, privacy),
        })
        const hash = textHash(embedder.model, text)
        if (existingByVariant.get(variant.id)?.contentHash !== hash) {
          pending.push({ variantId: variant.id, entryId: entry.id, text, hash })
        }
      }

      for (const e of existing) {
        if (!seenVariants.has(e.variantId)) {
          stale.push({ variantId: e.variantId, entryId: e.entryId })
        }
      }

      return { stale, pending, readEntryStamps, readVariantStamps }
    },
  )

  const otherModels = (lockedEntryIds: string[], keep: string[]) =>
    and(inArray(entryEmbeddings.entryId, lockedEntryIds), notInArray(entryEmbeddings.model, keep))

  if (!pending.length && !stale.length) {
    await withCircle(db, circleId, async (tx) => {
      const keep = await keptModels(tx, embedder)
      const locked = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(
          and(
            inArray(entries.id, entryIds),
            sql`exists (select 1 from ${entryEmbeddings} where ${entryEmbeddings.entryId} = ${entries.id} and ${notInArray(entryEmbeddings.model, keep)})`,
          ),
        )
        .for('no key update', { skipLocked: true })
      if (locked.length) {
        await tx.delete(entryEmbeddings).where(
          otherModels(
            locked.map((r) => r.id),
            keep,
          ),
        )
      }
    })
    return 0
  }

  const vectors = new Map<string, number[]>()
  const variantToEntry = new Map(pending.map((p) => [p.variantId, p.entryId]))
  const failedVariants = new Set<string>()
  const failedNotified = new Set<string>()
  let broken: Error | null = null
  for (let i = 0; i < pending.length && !broken; i += EMBED_BATCH) {
    if (hooks.signal?.aborted) break
    const out = await embedBatch(
      embedder,
      pending.slice(i, i + EMBED_BATCH).map((p) => ({ id: p.variantId, text: p.text })),
      {
        signal: hooks.signal,
        onFailed: (variantId, message) => {
          failedVariants.add(variantId)
          const entryId = variantToEntry.get(variantId)
          if (entryId && !failedNotified.has(entryId)) {
            failedNotified.add(entryId)
            hooks.onFailed?.(entryId, message)
          }
        },
      },
    )
    for (const [variantId, vector] of out.vectors) vectors.set(variantId, vector)
    broken = out.broken
  }

  const touchedEntryIds = [
    ...new Set([...stale.map((s) => s.entryId), ...pending.map((p) => p.entryId)]),
  ]

  const { written, skipped } = await withCircle(db, circleId, async (tx) => {
    const keep = await keptModels(tx, embedder)
    const currentEntries = await tx
      .select({ id: entries.id, stamp: entryStampSql })
      .from(entries)
      .where(inArray(entries.id, entryIds))
      .for('no key update', { skipLocked: true })
    const lockedIds = currentEntries.map((c) => c.id)
    const lockedSet = new Set(lockedIds)
    const skipped = touchedEntryIds.filter((id) => !lockedSet.has(id))

    const currentVariants = lockedIds.length
      ? await tx
          .select({
            id: entryVariants.id,
            entryId: entryVariants.entryId,
            stamp: variantStampSql,
          })
          .from(entryVariants)
          .where(inArray(entryVariants.entryId, lockedIds))
      : []

    const currentVariantMap = new Map<string, Map<string, string>>()
    for (const v of currentVariants) {
      let map = currentVariantMap.get(v.entryId)
      if (!map) {
        map = new Map()
        currentVariantMap.set(v.entryId, map)
      }
      map.set(v.id, v.stamp)
    }

    const unchanged = new Set<string>()
    for (const row of currentEntries) {
      if (row.stamp !== readEntryStamps.get(row.id)) continue
      const beforeSig = variantSignature(readVariantStamps.get(row.id) ?? new Map())
      const afterSig = variantSignature(currentVariantMap.get(row.id) ?? new Map())
      if (beforeSig === afterSig) unchanged.add(row.id)
    }

    const staleNow = stale.filter((s) => unchanged.has(s.entryId)).map((s) => s.variantId)
    if (staleNow.length) {
      await tx.delete(entryEmbeddings).where(inArray(entryEmbeddings.variantId, staleNow))
    }

    const writes = keep.includes(embedder.model)
      ? pending
          .filter((item) => unchanged.has(item.entryId) && vectors.has(item.variantId))
          .map((item) => ({ item, vector: vectors.get(item.variantId)! }))
      : []
    if (writes.length) {
      await tx
        .insert(entryEmbeddings)
        .values(
          writes.map(({ item, vector }) => ({
            circleId,
            variantId: item.variantId,
            entryId: item.entryId,
            model: embedder.model,
            contentHash: item.hash,
            embedding: vector,
          })),
        )
        .onConflictDoUpdate({
          target: [entryEmbeddings.variantId, entryEmbeddings.model],
          set: {
            contentHash: sql`excluded.content_hash`,
            embedding: sql`excluded.embedding`,
            updatedAt: new Date(),
          },
        })
    }

    if (lockedIds.length) {
      await tx.delete(entryEmbeddings).where(otherModels(lockedIds, keep))
    }
    return { written: writes.length, skipped }
  })

  if (skipped.length) await hooks.onSkipped?.(skipped)

  const later = new Set(skipped)
  const unfinished = [
    ...new Set(
      pending
        .filter(
          (p) =>
            !vectors.has(p.variantId) && !failedVariants.has(p.variantId) && !later.has(p.entryId),
        )
        .map((p) => p.entryId),
    ),
  ]
  if (broken) throw new EmbedUnavailable(broken, unfinished)
  if (unfinished.length) hooks.onDeferred?.(unfinished)
  return written
}

export async function embedEntries(
  db: Db,
  embedder: Embedder,
  circleId: string,
  entryIds: string[],
  hooks: SyncHooks = {},
): Promise<number> {
  return syncRows(db, embedder, circleId, [...new Set(entryIds)], hooks)
}

export interface BackfillOptions {
  onSkipped?: (circleId: string, entryIds: string[]) => void | Promise<void>
  onFailed?: SyncHooks['onFailed']
  shouldContinue?: () => Promise<boolean>
}

export async function backfillEmbeddings(
  db: Db,
  embedder: Embedder,
  options: BackfillOptions = {},
): Promise<number> {
  const { onSkipped, onFailed, shouldContinue } = options
  let total = 0
  for (const { id: circleId } of await db.select({ id: circles.id }).from(circles)) {
    let after: string | null = null
    for (;;) {
      if (shouldContinue && !(await shouldContinue())) return total
      const cursor: string | null = after
      const page: { id: string }[] = await withCircle(db, circleId, (tx) =>
        tx
          .select({ id: entries.id })
          .from(entries)
          .where(
            and(
              isNull(entries.deletedAt),
              inArray(entries.kind, ['entry', 'fact']),
              cursor ? gt(entries.id, cursor) : undefined,
            ),
          )
          .orderBy(asc(entries.id))
          .limit(PAGE),
      )
      if (!page.length) break
      total += await syncRows(
        db,
        embedder,
        circleId,
        page.map((r) => r.id),
        { onSkipped: onSkipped && ((ids) => onSkipped(circleId, ids)), onFailed },
      )
      after = page[page.length - 1]!.id
    }
  }
  return total
}

export async function pruneEmbeddings(db: Db, keep: string[]): Promise<number> {
  if (!keep.length) return 0
  let total = 0
  for (const { id: circleId } of await db.select({ id: circles.id }).from(circles)) {
    const removed = await withCircle(db, circleId, (tx) =>
      tx
        .delete(entryEmbeddings)
        .where(notInArray(entryEmbeddings.model, keep))
        .returning({ variantId: entryEmbeddings.variantId }),
    )
    total += removed.length
  }
  return total
}

const DROP_BATCH = 500

// 删掉不再符合嵌入条件（已删除、过期、被取代、secret 或空正文）的切片向量，逐圈短事务分批清理
export async function dropIneligibleEmbeddings(db: Db): Promise<number> {
  let total = 0
  for (const { id: circleId } of await db.select({ id: circles.id }).from(circles)) {
    for (;;) {
      const gone = await withCircle(db, circleId, (tx) =>
        tx.execute(sql`
          delete from ${entryEmbeddings}
          where (${entryEmbeddings.variantId}, ${entryEmbeddings.model}) in (
            select ${entryEmbeddings.variantId}, ${entryEmbeddings.model}
            from ${entryEmbeddings}
            join ${entryVariants} on ${entryVariants.id} = ${entryEmbeddings.variantId}
            join ${entries} on ${entries.id} = ${entryVariants.entryId}
            where not coalesce(${EMBEDDABLE}, false)
            limit ${DROP_BATCH}
            for no key update of ${entries} skip locked
            for no key update of ${entryVariants} skip locked
            for update of ${entryEmbeddings} skip locked
          ) returning 1`),
      )
      total += gone.length
      if (gone.length < DROP_BATCH) break
    }
  }
  return total
}
