import {
  CREDENTIAL_PLACEHOLDER_PREFIX,
  ENTRY_CONTENT_MAX,
  extractLegacyRefs,
  hasDuplicateLeadingHeading,
  isTitleDirty,
  LEGACY_LORE_URI_REGEX,
  NON_SHORT_ID_WIKI_LINK_REGEX,
  stripDuplicateLeadingHeading,
  stripLegacyGlossaryLines,
  type EntryDiffMeta,
  type EntrySnapshot,
  type HygieneSweepApplyRequest,
  type HygieneSweepApplyResponse,
  type HygieneSweepBrokenLink,
  type HygieneSweepCandidate,
  type HygieneSweepFixKind,
  type HygieneSweepFlag,
  type HygieneSweepPreviewResponse,
  type HygieneSweepRewrite,
} from '@kioku/contracts'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import { withTx, type Db } from '../db/client'
import { entries, entryEvents, entryLinks } from '../db/schema'
import type { Jobs } from '../jobs/queue'
import { clipChars } from '../recall/text'
import { syncEntryLinks } from './links'

type EntryRow = typeof entries.$inferSelect

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const INLINE_CODE_SPLIT_RE = /(`+[^`\r\n]*?`+)/g

export interface TargetEntry {
  id: string
  shortId: string
  title: string
  realms: string[]
  topics: string[]
  projects: string[]
}

function normalizeLookupKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
}

function sanitizeWikiAlias(raw: string): string {
  const cleaned = raw
    .replace(/[[\]|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clipChars(cleaned, 28)
}

function shortAliasForLink(title: string): string {
  const clean = title
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[—–-]{2,}.*$/, '')
    .trim()
  const base = sanitizeWikiAlias(clean || title.trim())
  return base
}

// 防止自动把更受限场域的目标标题写入更宽场域的正文（避免跨场域标题渗漏）
function canRewriteTargetIntoSource(
  sourceRealms: readonly string[],
  targetRealms: readonly string[],
): boolean {
  if (!targetRealms.length) return true
  if (!sourceRealms.length) return false
  return sourceRealms.every((r) => targetRealms.includes(r))
}

// 为旧路径最后一段或非短 ID 双链建立无歧义映射（仅命中唯一目标时才允许自动替换）
export function buildUniqueSlugIndex(rows: readonly TargetEntry[]): Map<string, TargetEntry> {
  const buckets = new Map<string, Map<string, TargetEntry>>()
  const register = (rawKey: string, entry: TargetEntry) => {
    const key = normalizeLookupKey(rawKey)
    if (!key || key.length < 2) return
    let set = buckets.get(key)
    if (!set) {
      set = new Map()
      buckets.set(key, set)
    }
    set.set(entry.shortId, entry)
  }

  for (const row of rows) {
    for (const topic of row.topics) register(topic, row)
    register(shortAliasForLink(row.title), row)
  }

  const unique = new Map<string, TargetEntry>()
  for (const [key, map] of buckets.entries()) {
    if (map.size === 1) {
      unique.set(key, [...map.values()][0]!)
    }
  }
  return unique
}

function resolveLegacyUri(
  uri: string,
  selfShortId: string,
  index: ReadonlyMap<string, TargetEntry>,
): TargetEntry | null {
  const stripped = uri.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '')
  const segments = stripped.split('/').filter(Boolean)
  if (!segments.length) return null

  const candidates = [segments.at(-1)!, segments.join('-'), segments.join('_')]
  for (const cand of candidates) {
    const hit = index.get(normalizeLookupKey(cand))
    if (hit && hit.shortId !== selfShortId) return hit
  }
  return null
}

function rewriteLegacyRefsInContent(
  content: string,
  selfShortId: string,
  sourceRealms: readonly string[],
  index: ReadonlyMap<string, TargetEntry>,
): { content: string; rewrites: HygieneSweepRewrite[]; unresolved: string[] } {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let fence: string | null = null
  const rewrites: HygieneSweepRewrite[] = []
  const seenRewrites = new Set<string>()
  const unresolved = new Set<string>()
  const outLines: string[] = []

  const replaceSegment = (segment: string): string => {
    let updated = segment.replace(
      new RegExp(NON_SHORT_ID_WIKI_LINK_REGEX.source, 'gi'),
      (full, rawSlug: string, alias?: string) => {
        if (rawSlug.includes(CREDENTIAL_PLACEHOLDER_PREFIX)) return full
        const hit = index.get(normalizeLookupKey(rawSlug))
        if (
          !hit ||
          hit.shortId === selfShortId ||
          !canRewriteTargetIntoSource(sourceRealms, hit.realms)
        ) {
          unresolved.add(full)
          return full
        }
        const label = sanitizeWikiAlias(alias ?? '') || shortAliasForLink(hit.title)
        const replacement = label ? `[[${hit.shortId}|${label}]]` : `[[${hit.shortId}]]`
        const key = `${full}=>${replacement}`
        if (!seenRewrites.has(key)) {
          seenRewrites.add(key)
          rewrites.push({
            raw: full,
            replacement,
            targetShortId: hit.shortId,
            targetTitle: hit.title,
          })
        }
        return replacement
      },
    )

    updated = updated.replace(new RegExp(LEGACY_LORE_URI_REGEX.source, 'gi'), (rawMatch) => {
      const trimmedMatch = rawMatch.replace(/[.,;:]+$/, '')
      const trailing = rawMatch.slice(trimmedMatch.length)
      const hit = resolveLegacyUri(trimmedMatch, selfShortId, index)
      if (!hit || !canRewriteTargetIntoSource(sourceRealms, hit.realms)) {
        unresolved.add(trimmedMatch)
        return rawMatch
      }
      const label = shortAliasForLink(hit.title)
      const replacement = label ? `[[${hit.shortId}|${label}]]` : `[[${hit.shortId}]]`
      const key = `${trimmedMatch}=>${replacement}`
      if (!seenRewrites.has(key)) {
        seenRewrites.add(key)
        rewrites.push({
          raw: trimmedMatch,
          replacement,
          targetShortId: hit.shortId,
          targetTitle: hit.title,
        })
      }
      return `${replacement}${trailing}`
    })

    return updated
  }

  for (const line of lines) {
    const [, marker, info = ''] = FENCE_RE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      outLines.push(line)
      continue
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      outLines.push(line)
      continue
    }

    // 跳过反引号行内代码片段，避免误改代码或命令示例
    const parts = line.split(INLINE_CODE_SPLIT_RE)
    const rebuilt = parts.map((part, idx) => (idx % 2 === 1 ? part : replaceSegment(part))).join('')
    outLines.push(rebuilt)
  }

  return {
    content: outLines.join('\n'),
    rewrites,
    unresolved: [...unresolved],
  }
}

export interface ComputedSweep {
  candidate: HygieneSweepCandidate
  nextContent: string
}

export function computeDeterministicFixes(
  row: EntryRow,
  index: ReadonlyMap<string, TargetEntry>,
): ComputedSweep | null {
  const fixes: HygieneSweepFixKind[] = []
  let content = row.content

  if (hasDuplicateLeadingHeading(row.title, content)) {
    const stripped = stripDuplicateLeadingHeading(row.title, content)
    if (stripped !== content) {
      content = stripped
      fixes.push('strip_duplicate_heading')
    }
  }

  const glossaryRes = stripLegacyGlossaryLines(content)
  if (glossaryRes.removed) {
    content = glossaryRes.content
    fixes.push('strip_legacy_glossary')
  }

  const legacyBefore = extractLegacyRefs(content)
  let rewrites: HygieneSweepRewrite[] = []
  let unresolved: string[] = []
  if (legacyBefore.uris.length || legacyBefore.slugLinks.length) {
    const rw = rewriteLegacyRefsInContent(content, row.shortId, row.realms, index)
    unresolved = rw.unresolved
    if (
      rw.rewrites.length > 0 &&
      rw.content !== content &&
      rw.content.length <= ENTRY_CONTENT_MAX
    ) {
      content = rw.content
      rewrites = rw.rewrites
      fixes.push('rewrite_legacy_links')
    }
  }

  if (!fixes.length || content.length > ENTRY_CONTENT_MAX) return null

  return {
    nextContent: content,
    candidate: {
      id: row.id,
      shortId: row.shortId,
      title: row.title,
      isPinned: row.isPinned,
      version: row.version,
      fixes,
      rewrites,
      unresolvedRefs: unresolved,
      beforeChars: row.content.length,
      afterChars: content.length,
    },
  }
}

function toSnapshot(row: EntryRow): EntrySnapshot {
  return {
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    content: row.content,
    disclosure: row.disclosure,
    isPinned: row.isPinned,
    bootMode: row.bootMode,
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
    validTo: row.validTo ? row.validTo.toISOString() : null,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    version: row.version,
  }
}

export async function previewHygieneSweep(db: Db): Promise<HygieneSweepPreviewResponse> {
  const rows = await db
    .select()
    .from(entries)
    .where(and(eq(entries.kind, 'entry'), isNull(entries.deletedAt)))
    .orderBy(asc(entries.shortId))

  const index = buildUniqueSlugIndex(rows)
  let dirtyTitleCount = 0
  const deterministicCandidates: HygieneSweepCandidate[] = []
  const suspectTruncated: HygieneSweepFlag[] = []
  const suspectObsolete: HygieneSweepFlag[] = []

  for (const row of rows) {
    if (isTitleDirty(row.title)) dirtyTitleCount++

    const fix = computeDeterministicFixes(row, index)
    if (fix) deterministicCandidates.push(fix.candidate)

    if (row.title.length >= 40 && isTitleDirty(row.title) && row.content.trim().length < 220) {
      suspectTruncated.push({
        id: row.id,
        shortId: row.shortId,
        title: row.title,
        isPinned: row.isPinned,
        charCount: row.content.length,
        reason: '标题较长但正文不足 220 字，疑似曾被单次简短更新覆盖主体，建议人工核对',
      })
    }
  }

  // 零 LLM 扫描全库悬空断链：出链目标不存在或已被移入回收站
  const activeIds = rows.map((r) => r.id)
  const brokenLinks: HygieneSweepBrokenLink[] = []
  if (activeIds.length) {
    const linkRows = await db
      .select({
        sourceEntryId: entryLinks.sourceEntryId,
        targetShortId: entryLinks.targetShortId,
      })
      .from(entryLinks)
      .where(inArray(entryLinks.sourceEntryId, activeIds))

    if (linkRows.length) {
      const targetShorts = [...new Set(linkRows.map((l) => l.targetShortId))]
      const targetRows = await db
        .select({
          shortId: entries.shortId,
          title: entries.title,
          deletedAt: entries.deletedAt,
        })
        .from(entries)
        .where(inArray(entries.shortId, targetShorts))
      const targetByShort = new Map(targetRows.map((t) => [t.shortId, t]))
      const rowById = new Map(rows.map((r) => [r.id, r]))
      const brokenBySource = new Map<string, HygieneSweepBrokenLink['targets']>()

      for (const link of linkRows) {
        const target = targetByShort.get(link.targetShortId)
        if (target && target.deletedAt === null) continue
        const list = brokenBySource.get(link.sourceEntryId) ?? []
        list.push({
          targetShortId: link.targetShortId,
          status: target ? 'deleted' : 'missing',
          targetTitle: target ? target.title : null,
        })
        brokenBySource.set(link.sourceEntryId, list)
      }

      for (const [sourceId, targets] of brokenBySource.entries()) {
        const src = rowById.get(sourceId)
        if (!src) continue
        brokenLinks.push({
          id: src.id,
          shortId: src.shortId,
          title: src.title,
          isPinned: src.isPinned,
          targets: targets.sort((a, b) => a.targetShortId.localeCompare(b.targetShortId)),
        })
      }
      brokenLinks.sort((a, b) => a.shortId.localeCompare(b.shortId))
    }
  }

  return {
    totalScanned: rows.length,
    dirtyTitleCount,
    deterministicCandidates,
    suspectTruncated,
    suspectObsolete,
    brokenLinks,
  }
}

export async function applyHygieneSweep(
  db: Db,
  jobs: Jobs | null | undefined,
  request: HygieneSweepApplyRequest = {},
): Promise<HygieneSweepApplyResponse> {
  const allowSet = request.shortIds?.length
    ? new Set(request.shortIds.map((s) => s.toLowerCase()))
    : null

  const { appliedIds, appliedShortIds, skipped } = await withTx(db, async (tx, now) => {
    const rows = await tx
      .select()
      .from(entries)
      .where(and(eq(entries.kind, 'entry'), isNull(entries.deletedAt)))
      .orderBy(asc(entries.shortId))

    const index = buildUniqueSlugIndex(rows)
    const updatedIds: string[] = []
    const updatedShorts: string[] = []
    let skippedCount = 0

    for (const row of rows) {
      if (allowSet && !allowSet.has(row.shortId)) continue
      const plan = computeDeterministicFixes(row, index)
      if (!plan) {
        if (allowSet) skippedCount++
        continue
      }

      const labels: string[] = []
      if (plan.candidate.fixes.includes('strip_duplicate_heading')) labels.push('去除重复首行标题')
      if (plan.candidate.fixes.includes('strip_legacy_glossary')) labels.push('清理旧关键词汇总行')
      if (plan.candidate.fixes.includes('rewrite_legacy_links')) {
        labels.push(`转换 ${plan.candidate.rewrites.length} 处旧路径为双链`)
      }
      const changeSummary = `结构检查：${labels.join('、')}`
      const diffMeta: EntryDiffMeta = {
        changedFields: ['content'],
        contentCharsBefore: row.content.length,
        contentCharsAfter: plan.nextContent.length,
      }

      // 纯排版/链接清洗不刷新 verifiedAt，避免掩盖正文事实陈旧度
      const [updated] = await tx
        .update(entries)
        .set({
          content: plan.nextContent,
          lastChangeSummary: changeSummary,
          version: row.version + 1,
          updatedAt: now,
        })
        .where(and(eq(entries.id, row.id), eq(entries.version, row.version)))
        .returning()

      if (!updated) {
        skippedCount++
        continue
      }

      await syncEntryLinks(tx, updated.id, updated.shortId, updated.content)
      await tx.insert(entryEvents).values({
        entryId: updated.id,
        eventType: 'update',
        actor: 'hygiene:sweep',
        changeSummary,
        diffMeta,
        snapshot: toSnapshot(updated),
        createdAt: now,
      })

      updatedIds.push(updated.id)
      updatedShorts.push(updated.shortId)
    }

    return { appliedIds: updatedIds, appliedShortIds: updatedShorts, skipped: skippedCount }
  })

  for (const id of appliedIds) {
    jobs?.enqueueEmbed(id)
  }

  return {
    applied: appliedShortIds.length,
    skipped,
    appliedShortIds,
  }
}
