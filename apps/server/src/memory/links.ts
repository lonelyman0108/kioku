import {
  extractTargetShortIds,
  type DefaultFacets,
  type EntryKind,
  type EntryLinkNeighbor,
  type Provenance,
  type Sensitivity,
  type WhenCondition,
} from '@kioku/contracts'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'

import type { Access } from '../access/access'
import type { Tx } from '../db/client'
import { circles, entries, entryLinks, entryVariants } from '../db/schema'
import { readableConditions } from './filter'
import { normalizeShortId } from './shortId'

// 群聊、频道与非提权外人私聊上下文视为受限会话，对外隐藏关联客场圈名称（circleSlug 置空）
export function isRestrictedChatAccess(access: Access): boolean {
  if (access.baseOriginScopes === null) return false
  for (const scope of access.baseOriginScopes) {
    if (scope.startsWith('group:')) return true
    if (scope.startsWith('direct:')) {
      return [...access.circles.values()].every((c) => c.maxSensitivity === 'public')
    }
  }
  return false
}

export function visibleCircleSlug(access: Access, circleId: string, slug: string): string | null {
  if (circleId === access.primaryCircleId) return slug
  return isRestrictedChatAccess(access) ? null : slug
}

// 同步单条词条各切片的双链出链索引（secret 与未确认来源不建明文出链；保留指向未解析、已软删除或跨圈目标的悬空边）
export async function syncEntryLinks(
  tx: Tx,
  input: {
    circleId: string
    entryId: string
    shortId: string
    sensitivity: Sensitivity
    provenance: Provenance
    variants: readonly { id: string; content: string | null }[]
  },
): Promise<void> {
  await tx.delete(entryLinks).where(eq(entryLinks.sourceEntryId, input.entryId))
  if (input.sensitivity === 'secret' || input.provenance === 'untrusted') return

  const self = input.shortId.toLowerCase()
  const rows: {
    circleId: string
    sourceVariantId: string
    sourceEntryId: string
    targetShortId: string
  }[] = []
  for (const v of input.variants) {
    if (!v.content) continue
    for (const targetShortId of extractTargetShortIds(v.content)) {
      if (targetShortId === self) continue
      rows.push({
        circleId: input.circleId,
        sourceVariantId: v.id,
        sourceEntryId: input.entryId,
        targetShortId,
      })
    }
  }
  if (!rows.length) return
  await tx.insert(entryLinks).values(rows).onConflictDoNothing()
}

// 按调用方当前权限解析正文中出现的一批双链短 ID 目标标题；无权查看、机密或不存在的一律略过，防泄露存在性
export async function resolveReadableLinkTitles(
  tx: Tx,
  access: Access,
  shortIds: readonly string[],
  now?: Date,
): Promise<Map<string, { title: string; circleId: string; circleSlug: string | null }>> {
  const unique = [...new Set(shortIds.map(normalizeShortId).filter((s): s is string => s !== null))]
  if (!unique.length) return new Map()
  const rows = await tx
    .select({
      shortId: entries.shortId,
      title: entries.title,
      circleId: entries.circleId,
      circleSlug: circles.slug,
    })
    .from(entries)
    .innerJoin(circles, eq(circles.id, entries.circleId))
    .where(
      and(
        inArray(entries.shortId, unique),
        ne(entries.sensitivity, 'secret'),
        readableConditions(access, { ...(now ? { now } : {}) }),
      ),
    )
  return new Map(
    rows.map((r) => [
      r.shortId,
      {
        title: r.title,
        circleId: r.circleId,
        circleSlug: visibleCircleSlug(access, r.circleId, r.circleSlug),
      },
    ]),
  )
}

// 查询单条词条当前可读的双向 1 跳双链邻居（正向可限定到当前未发生切面互斥的源切片；机密与未确认源不产生可读邻居）
export async function resolveEntryNeighbors(
  tx: Tx,
  access: Access,
  entry: { id: string; shortId: string; circleId: string },
  options: { allowedSourceVariantIds?: ReadonlySet<string>; now?: Date } = {},
): Promise<EntryLinkNeighbor[]> {
  const readable = and(
    ne(entries.sensitivity, 'secret'),
    readableConditions(access, { ...(options.now ? { now: options.now } : {}) }),
  )!
  const results: EntryLinkNeighbor[] = []
  const seenOut = new Set<string>()

  const wantOut = !options.allowedSourceVariantIds || options.allowedSourceVariantIds.size > 0
  if (wantOut) {
    const outLinks = await tx
      .select({
        sourceVariantId: entryLinks.sourceVariantId,
        targetShortId: entryLinks.targetShortId,
      })
      .from(entryLinks)
      .where(
        and(
          eq(entryLinks.sourceEntryId, entry.id),
          options.allowedSourceVariantIds
            ? inArray(entryLinks.sourceVariantId, [...options.allowedSourceVariantIds])
            : undefined,
        ),
      )
      .orderBy(asc(entryLinks.targetShortId), asc(entryLinks.sourceVariantId))

    if (outLinks.length) {
      const targetIds = [...new Set(outLinks.map((l) => l.targetShortId))]
      const targets = await tx
        .select({
          shortId: entries.shortId,
          title: entries.title,
          circleId: entries.circleId,
          circleSlug: circles.slug,
          kind: entries.kind,
          sensitivity: entries.sensitivity,
        })
        .from(entries)
        .innerJoin(circles, eq(circles.id, entries.circleId))
        .where(and(inArray(entries.shortId, targetIds), ne(entries.id, entry.id), readable))
      const byShort = new Map(targets.map((t) => [t.shortId, t]))
      for (const link of outLinks) {
        if (seenOut.has(link.targetShortId)) continue
        const target = byShort.get(link.targetShortId)
        if (!target) continue
        seenOut.add(link.targetShortId)
        results.push({
          shortId: target.shortId,
          title: target.title,
          circleId: target.circleId,
          circleSlug: visibleCircleSlug(access, target.circleId, target.circleSlug) ?? '',
          kind: target.kind,
          sensitivity: target.sensitivity,
          direction: 'outgoing',
          sourceVariantId: link.sourceVariantId,
        })
      }
    }
  }

  const incoming = await tx
    .select({
      shortId: entries.shortId,
      title: entries.title,
      circleId: entries.circleId,
      circleSlug: circles.slug,
      kind: entries.kind,
      sensitivity: entries.sensitivity,
      sourceVariantId: entryLinks.sourceVariantId,
    })
    .from(entryLinks)
    .innerJoin(entries, eq(entries.id, entryLinks.sourceEntryId))
    .innerJoin(circles, eq(circles.id, entries.circleId))
    .where(
      and(
        eq(entryLinks.targetShortId, entry.shortId.toLowerCase()),
        ne(entries.id, entry.id),
        ne(entries.provenance, 'untrusted'),
        readable,
      ),
    )
    .orderBy(asc(entries.shortId), asc(entryLinks.sourceVariantId))

  const seenIn = new Set<string>()
  for (const row of incoming) {
    if (seenIn.has(row.shortId)) continue
    seenIn.add(row.shortId)
    results.push({
      shortId: row.shortId,
      title: row.title,
      circleId: row.circleId,
      circleSlug: visibleCircleSlug(access, row.circleId, row.circleSlug) ?? '',
      kind: row.kind,
      sensitivity: row.sensitivity,
      direction: 'incoming',
      sourceVariantId: row.sourceVariantId,
    })
  }

  return results
}

export interface OneHopSeed {
  entryId: string
  shortId: string
  activeVariantIds: readonly string[]
  score: number
}

export interface OneHopNeighborHit {
  entryId: string
  shortId: string
  circleId: string
  circleSlug: string | null
  title: string
  kind: EntryKind
  sensitivity: Sensitivity
  originScope: string
  clientId: string | null
  priority: number
  disclosure: string | null
  topics: string[]
  realms: string[]
  validFrom: Date
  createdAt: Date
  updatedAt: Date
  score: number
  seedShortId: string
  direction: 'outgoing' | 'incoming'
}

// 对高分种子词条做 1 跳双向可读邻域扩散：正向仅从传入无冲突的源切片出发，反向校验源切片无互斥冲突
export async function expandOneHopNeighbors(
  tx: Tx,
  access: Access,
  seeds: readonly OneHopSeed[],
  options: {
    decay?: number
    now?: Date
    variantAllowed?: (when: WhenCondition, circleDefaults: DefaultFacets) => boolean
  } = {},
): Promise<OneHopNeighborHit[]> {
  if (!seeds.length) return []
  const decay = options.decay ?? 0.55
  const seedIds = new Set(seeds.map((s) => s.entryId))
  const seedByEntry = new Map(seeds.map((s) => [s.entryId, s]))
  const seedByShort = new Map(seeds.map((s) => [s.shortId.toLowerCase(), s]))
  const activeVariantIds = [...new Set(seeds.flatMap((s) => s.activeVariantIds))]
  const seedShortIds = [...new Set(seeds.map((s) => s.shortId.toLowerCase()))]
  const readable = and(
    ne(entries.sensitivity, 'secret'),
    readableConditions(access, { ...(options.now ? { now: options.now } : {}) }),
  )!

  const best = new Map<string, OneHopNeighborHit>()
  const consider = (
    row: Omit<OneHopNeighborHit, 'score' | 'seedShortId' | 'direction'>,
    seed: OneHopSeed,
    direction: 'outgoing' | 'incoming',
  ) => {
    if (seedIds.has(row.entryId)) return
    const nextScore = decay * seed.score
    const prev = best.get(row.entryId)
    if (
      !prev ||
      nextScore > prev.score ||
      (nextScore === prev.score && seed.shortId < prev.seedShortId)
    ) {
      best.set(row.entryId, {
        ...row,
        score: nextScore,
        seedShortId: seed.shortId,
        direction,
      })
    }
  }

  if (activeVariantIds.length) {
    const outLinks = await tx
      .select({
        sourceEntryId: entryLinks.sourceEntryId,
        targetShortId: entryLinks.targetShortId,
      })
      .from(entryLinks)
      .where(
        and(
          inArray(entryLinks.sourceEntryId, [...seedIds]),
          inArray(entryLinks.sourceVariantId, activeVariantIds),
        ),
      )

    if (outLinks.length) {
      const targetShorts = [...new Set(outLinks.map((l) => l.targetShortId))]
      const targets = await tx
        .select({
          entryId: entries.id,
          shortId: entries.shortId,
          circleId: entries.circleId,
          circleSlug: circles.slug,
          title: entries.title,
          kind: entries.kind,
          sensitivity: entries.sensitivity,
          originScope: entries.originScope,
          clientId: entries.clientId,
          priority: entries.priority,
          disclosure: entries.disclosure,
          topics: entries.topics,
          realms: entries.realms,
          validFrom: entries.validFrom,
          createdAt: entries.createdAt,
          updatedAt: entries.updatedAt,
        })
        .from(entries)
        .innerJoin(circles, eq(circles.id, entries.circleId))
        .where(and(inArray(entries.shortId, targetShorts), readable))
      const byShort = new Map(targets.map((t) => [t.shortId, t]))
      for (const link of outLinks) {
        const seed = seedByEntry.get(link.sourceEntryId)
        const target = byShort.get(link.targetShortId)
        if (!seed || !target) continue
        consider(
          {
            ...target,
            circleSlug: visibleCircleSlug(access, target.circleId, target.circleSlug),
          },
          seed,
          'outgoing',
        )
      }
    }
  }

  if (seedShortIds.length) {
    const inLinks = await tx
      .select({
        targetShortId: entryLinks.targetShortId,
        when: entryVariants.when,
        defaultFacets: circles.defaultFacets,
        entryId: entries.id,
        shortId: entries.shortId,
        circleId: entries.circleId,
        circleSlug: circles.slug,
        title: entries.title,
        kind: entries.kind,
        sensitivity: entries.sensitivity,
        originScope: entries.originScope,
        clientId: entries.clientId,
        priority: entries.priority,
        disclosure: entries.disclosure,
        topics: entries.topics,
        realms: entries.realms,
        validFrom: entries.validFrom,
        createdAt: entries.createdAt,
        updatedAt: entries.updatedAt,
      })
      .from(entryLinks)
      .innerJoin(entries, eq(entries.id, entryLinks.sourceEntryId))
      .innerJoin(entryVariants, eq(entryVariants.id, entryLinks.sourceVariantId))
      .innerJoin(circles, eq(circles.id, entries.circleId))
      .where(
        and(
          inArray(entryLinks.targetShortId, seedShortIds),
          ne(entries.provenance, 'untrusted'),
          sql`${entries.id} is not null`,
          readable,
        ),
      )

    for (const row of inLinks) {
      if (options.variantAllowed && !options.variantAllowed(row.when, row.defaultFacets)) continue
      const seed = seedByShort.get(row.targetShortId)
      if (!seed) continue
      consider(
        {
          entryId: row.entryId,
          shortId: row.shortId,
          circleId: row.circleId,
          circleSlug: visibleCircleSlug(access, row.circleId, row.circleSlug),
          title: row.title,
          kind: row.kind,
          sensitivity: row.sensitivity,
          originScope: row.originScope,
          clientId: row.clientId,
          priority: row.priority,
          disclosure: row.disclosure,
          topics: row.topics,
          realms: row.realms,
          validFrom: row.validFrom,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        seed,
        'incoming',
      )
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score || a.shortId.localeCompare(b.shortId))
}
