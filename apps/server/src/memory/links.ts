import {
  extractEntryLinksWithContext,
  type EntryKind,
  type EntryLinkNeighbor,
} from '@kioku/contracts'
import { and, eq, inArray } from 'drizzle-orm'

import {
  hasExclusiveSceneConflict,
  readableEntrySql,
  type AccessScope,
  type SceneFocus,
} from '../access/scope'
import type { Db, Tx } from '../db/client'
import { entries, entryLinks } from '../db/schema'

// 同步单条词条正文中 [[m-xxxxxx]] 与 [[m-xxxxxx|语境]] 出链（排除指向自身）
export async function syncEntryLinks(
  tx: Tx,
  sourceEntryId: string,
  sourceShortId: string,
  content: string,
): Promise<void> {
  const links = extractEntryLinksWithContext(content).filter(
    (item) => item.targetShortId !== sourceShortId,
  )
  await tx.delete(entryLinks).where(eq(entryLinks.sourceEntryId, sourceEntryId))
  if (!links.length) return
  await tx
    .insert(entryLinks)
    .values(
      links.map((item) => ({
        sourceEntryId,
        targetShortId: item.targetShortId,
        relation: item.relation,
        contextSnippet: item.contextSnippet,
      })),
    )
    .onConflictDoNothing()
}

// 读取词条可见的出链与反向链接（受静态 allowed_realms 过滤，不泄露不可见场域）
export async function loadEntryLinks(
  db: Db | Tx,
  scope: AccessScope,
  entryId: string,
  shortId: string,
): Promise<{ outboundLinks: EntryLinkNeighbor[]; backlinks: EntryLinkNeighbor[] }> {
  const [outRows, inRows] = await Promise.all([
    db
      .select({
        shortId: entries.shortId,
        title: entries.title,
        kind: entries.kind,
        relation: entryLinks.relation,
        contextSnippet: entryLinks.contextSnippet,
      })
      .from(entryLinks)
      .innerJoin(entries, eq(entries.shortId, entryLinks.targetShortId))
      .where(and(eq(entryLinks.sourceEntryId, entryId), readableEntrySql(scope))),
    db
      .select({
        shortId: entries.shortId,
        title: entries.title,
        kind: entries.kind,
        relation: entryLinks.relation,
        contextSnippet: entryLinks.contextSnippet,
      })
      .from(entryLinks)
      .innerJoin(entries, eq(entries.id, entryLinks.sourceEntryId))
      .where(and(eq(entryLinks.targetShortId, shortId), readableEntrySql(scope))),
  ])

  const dedupe = (
    rows: {
      shortId: string
      title: string
      kind: EntryKind
      relation: string | null
      contextSnippet: string | null
    }[],
    direction: 'outgoing' | 'incoming',
  ): EntryLinkNeighbor[] => {
    const seen = new Set<string>()
    const out: EntryLinkNeighbor[] = []
    for (const r of rows) {
      if (r.shortId === shortId || seen.has(r.shortId)) continue
      seen.add(r.shortId)
      out.push({
        shortId: r.shortId,
        title: r.title,
        kind: r.kind,
        direction,
        ...(r.relation ? { relation: r.relation } : {}),
        ...(r.contextSnippet ? { contextSnippet: r.contextSnippet } : {}),
      })
    }
    return out
  }

  return {
    outboundLinks: dedupe(outRows, 'outgoing'),
    backlinks: dedupe(inRows, 'incoming'),
  }
}

export interface OneHopSeed {
  entryId: string
  shortId: string
  score: number
}

export interface OneHopNeighbor {
  entryId: string
  shortId: string
  title: string
  summary: string | null
  kind: EntryKind
  isPinned: boolean
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  disclosure: string | null
  updatedAt: string
  lastChangeSummary: string | null
  linkRelation: string | null
  score: number
  viaSeedShortId: string
}

// 一跳双向双链扩散：受静态 allowed_realms 硬边界约束，并剔除独占场景冲突的邻居
export async function expandOneHopNeighbors(
  tx: Db | Tx,
  scope: AccessScope,
  focus: SceneFocus,
  seeds: readonly OneHopSeed[],
  decay = 0.55,
): Promise<OneHopNeighbor[]> {
  if (!seeds.length) return []
  const seedIds = seeds.map((s) => s.entryId)
  const seedShortIds = seeds.map((s) => s.shortId)
  const seedById = new Map(seeds.map((s) => [s.entryId, s]))
  const seedByShort = new Map(seeds.map((s) => [s.shortId, s]))

  const [outEdges, inEdges] = await Promise.all([
    tx
      .select({
        sourceEntryId: entryLinks.sourceEntryId,
        targetShortId: entryLinks.targetShortId,
        relation: entryLinks.relation,
      })
      .from(entryLinks)
      .where(inArray(entryLinks.sourceEntryId, seedIds)),
    tx
      .select({
        sourceEntryId: entryLinks.sourceEntryId,
        targetShortId: entryLinks.targetShortId,
        relation: entryLinks.relation,
      })
      .from(entryLinks)
      .where(inArray(entryLinks.targetShortId, seedShortIds)),
  ])

  const bestTargetByShort = new Map<string, { seed: OneHopSeed; relation: string | null }>()
  for (const edge of outEdges) {
    const seed = seedById.get(edge.sourceEntryId)
    if (!seed || seedByShort.has(edge.targetShortId)) continue
    const prev = bestTargetByShort.get(edge.targetShortId)
    if (!prev || seed.score > prev.seed.score) {
      bestTargetByShort.set(edge.targetShortId, { seed, relation: edge.relation })
    }
  }

  const bestSourceById = new Map<string, { seed: OneHopSeed; relation: string | null }>()
  for (const edge of inEdges) {
    const seed = seedByShort.get(edge.targetShortId)
    if (!seed || seedById.has(edge.sourceEntryId)) continue
    const prev = bestSourceById.get(edge.sourceEntryId)
    if (!prev || seed.score > prev.seed.score) {
      bestSourceById.set(edge.sourceEntryId, { seed, relation: edge.relation })
    }
  }

  const targetShorts = [...bestTargetByShort.keys()]
  const sourceIds = [...bestSourceById.keys()]
  if (!targetShorts.length && !sourceIds.length) return []

  const fields = {
    id: entries.id,
    shortId: entries.shortId,
    title: entries.title,
    summary: entries.summary,
    kind: entries.kind,
    isPinned: entries.isPinned,
    envs: entries.envs,
    realms: entries.realms,
    projects: entries.projects,
    runtimes: entries.runtimes,
    disclosure: entries.disclosure,
    updatedAt: entries.updatedAt,
    lastChangeSummary: entries.lastChangeSummary,
  }

  const [outRows, inRows] = await Promise.all([
    targetShorts.length
      ? tx
          .select(fields)
          .from(entries)
          .where(
            and(
              readableEntrySql(scope),
              eq(entries.kind, 'entry'),
              inArray(entries.shortId, targetShorts),
            ),
          )
      : Promise.resolve([]),
    sourceIds.length
      ? tx
          .select(fields)
          .from(entries)
          .where(
            and(readableEntrySql(scope), eq(entries.kind, 'entry'), inArray(entries.id, sourceIds)),
          )
      : Promise.resolve([]),
  ])

  const merged = new Map<string, OneHopNeighbor>()
  const consider = (
    row: (typeof outRows)[number],
    edgeInfo: { seed: OneHopSeed; relation: string | null } | undefined,
  ) => {
    if (!edgeInfo || seedById.has(row.id)) return
    if (hasExclusiveSceneConflict(row, focus)) return
    const score = edgeInfo.seed.score * decay
    const existing = merged.get(row.id)
    if (!existing || score > existing.score) {
      merged.set(row.id, {
        entryId: row.id,
        shortId: row.shortId,
        title: row.title,
        summary: row.summary,
        kind: row.kind,
        isPinned: row.isPinned,
        envs: row.envs,
        realms: row.realms,
        projects: row.projects,
        runtimes: row.runtimes,
        disclosure: row.disclosure,
        updatedAt: row.updatedAt.toISOString(),
        lastChangeSummary: row.lastChangeSummary,
        linkRelation: edgeInfo.relation,
        score,
        viaSeedShortId: edgeInfo.seed.shortId,
      })
    }
  }

  for (const row of outRows) consider(row, bestTargetByShort.get(row.shortId))
  for (const row of inRows) consider(row, bestSourceById.get(row.id))

  return [...merged.values()]
}
