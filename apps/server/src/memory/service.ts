import {
  applyCapturePatch,
  applyMarkdownAppend,
  bootModeToPinned,
  buildSearchTags,
  deriveEntryTitle,
  effectiveBootMode,
  ENTRY_CONTENT_MAX,
  extractCredentialPlaceholders,
  extractMarkdownHeadings,
  extractTargetShortIds,
  hasEpisodeSignals,
  lintEntryHygiene,
  mergeFallbackTopics,
  normalizeShortId,
  normalizeSlugList,
  redirectWikiLinksInContent,
  resolveBootMode,
  serializeEpisodeSignals,
  type ApplySuggestionRequest,
  type ApplySuggestionResponse,
  type BootMode,
  type BootPreviewRequest,
  type BootPreviewResponse,
  type BrowseEntriesQuery,
  type CapturePlanRequest,
  type CapturePlanResponse,
  type CreateEntryRequest,
  type EntryBrowseGroup,
  type EntryBrowseItem,
  type EntryBrowseResponse,
  type EntryDetailResponse,
  type EntryDiffMeta,
  type EntryFacetsSummary,
  type EntryHistoryItem,
  type EntryHistoryQuery,
  type EntryHistoryResponse,
  type EntryListItem,
  type EntryListQuery,
  type EntryListResponse,
  type EntryRecentHistoryItem,
  type EntrySnapshot,
  type EntryTabCounts,
  type EntryView,
  type HygieneWarning,
  type PinnedGroup,
  type RestoreEntryRequest,
  type SingleCrossCheckResponse,
  type SingleTidyApplyRequest,
  type SingleTidyApplyResponse,
  type SingleTidyPreviewResponse,
  type UpdateEntryRequest,
} from '@kioku/contracts'
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import {
  actorLabel,
  assertEntryWriteAllowed,
  readableEntrySql,
  resolveCreateRealms,
  synthesizeFocus,
  textArraySql,
  type AccessScope,
} from '../access/scope'
import type { CredentialService } from '../credential/service'
import type { MasterKey } from '../crypto/keyring'
import { withTx, type Db, type Tx } from '../db/client'
import {
  decodeTimeCursor,
  encodeTimeCursor,
  escapeLike,
  fromMicros,
  INVALID_CURSOR,
  microsOf,
  UUID,
} from '../db/paging'
import {
  apiKeys,
  dreamSuggestions,
  entries,
  entryEmbeddings,
  entryEvents,
  entryLinks,
} from '../db/schema'
import { planCapture as planQuickCapture, type PlanCaptureOptions } from '../extraction/capture'
import { runSingleCrossCheck } from '../extraction/crossMemory'
import { suggestionFingerprint } from '../extraction/dream'
import { canFlowRealmInto, sameRealms } from '../extraction/dreamPrompt'
import {
  previewSingleTidy as runPreviewSingleTidy,
  type PreviewSingleTidyOptions,
} from '../extraction/singleTidy'
import type { KeyPrincipal } from '../http/env'
import type { Jobs } from '../jobs/queue'
import { CONTEXT_RESERVE, GUIDANCE, HOST_CONTEXT_LIMIT } from '../lifecycle/lifecycle'
import {
  BOOT_CATALOG_BUDGET,
  BOOT_CHAR_BUDGET,
  compileBootDetailed,
  computeEffectiveCatalogBudget,
  formatBootBlock,
  selectCatalogLines,
} from '../recall/boot'
import { recallEntries } from '../recall/recall'
import { resolveActorMetaMap } from './actorMeta'
import { MemoryError } from './errors'
import {
  applyHygieneSweep as runHygieneSweepApply,
  previewHygieneSweep as runHygieneSweepPreview,
} from './hygieneSweep'
import { loadEntryLinks, syncEntryLinks } from './links'
import { insertWithAllocatedShortId, parseShortId } from './shortId'

type EntryRow = typeof entries.$inferSelect

const VALID_TO_MIN_AHEAD_MS = 60_000
const HISTORY_LIMIT = 200
const RECENT_HISTORY_LIMIT = 5
const EPISODE_TTL_DAYS = 14

function cleanOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function computeDiffMeta(
  before: EntryRow,
  after: {
    title: string
    summary: string | null
    content: string
    disclosure: string | null
    isPinned: boolean
    bootMode: BootMode
    envs: readonly string[]
    realms: readonly string[]
    projects: readonly string[]
    runtimes: readonly string[]
    topics: readonly string[]
    validTo: Date | null
    kind: string
  },
): EntryDiffMeta {
  const changedFields: string[] = []
  if (before.title !== after.title) changedFields.push('title')
  if ((before.summary ?? null) !== (after.summary ?? null)) changedFields.push('summary')
  if (before.content !== after.content) changedFields.push('content')
  if ((before.disclosure ?? null) !== (after.disclosure ?? null)) changedFields.push('disclosure')
  if (before.bootMode !== after.bootMode) changedFields.push('bootMode')
  if (!sameStringList(before.envs, after.envs)) changedFields.push('envs')
  if (!sameStringList(before.realms, after.realms)) changedFields.push('realms')
  if (!sameStringList(before.projects, after.projects)) changedFields.push('projects')
  if (!sameStringList(before.runtimes, after.runtimes)) changedFields.push('runtimes')
  if (!sameStringList(before.topics, after.topics)) changedFields.push('topics')
  if ((before.validTo?.getTime() ?? null) !== (after.validTo?.getTime() ?? null)) {
    changedFields.push('validTo')
  }
  if (before.kind !== after.kind) changedFields.push('kind')
  return {
    changedFields,
    contentCharsBefore: before.content.length,
    contentCharsAfter: after.content.length,
  }
}

function toEntryView(row: EntryRow): EntryView {
  return {
    id: row.id,
    shortId: row.shortId,
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
    deviceKey: row.deviceKey,
    projectSlug: row.projectSlug,
    validTo: row.validTo ? row.validTo.toISOString() : null,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    lastChangeSummary: row.lastChangeSummary,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  }
}

function toListItem(row: EntryRow, extra?: { snippet?: string; score?: number }): EntryListItem {
  return {
    id: row.id,
    shortId: row.shortId,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
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
    lastChangeSummary: row.lastChangeSummary,
    charCount: row.content.length,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    ...(extra?.snippet !== undefined ? { snippet: extra.snippet } : {}),
    ...(extra?.score !== undefined ? { score: extra.score } : {}),
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

function parseValidTo(raw: string | null | undefined, now: Date): Date | null {
  if (raw === null || raw === undefined) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) throw new MemoryError(400, '有效期格式不正确')
  if (date.getTime() < now.getTime() + VALID_TO_MIN_AHEAD_MS) {
    throw new MemoryError(400, '有效期须晚于当前时间至少一分钟')
  }
  return date
}

function pinnedGroupFilterSql(group: PinnedGroup): SQL {
  if (group === 'global_full') {
    return and(
      eq(entries.bootMode, 'full'),
      sql`cardinality(${entries.envs}) = 0 and cardinality(${entries.realms}) = 0 and cardinality(${entries.projects}) = 0 and cardinality(${entries.runtimes}) = 0`,
    )!
  }
  if (group === 'scoped_full') {
    return and(
      eq(entries.bootMode, 'full'),
      sql`(cardinality(${entries.envs}) > 0 or cardinality(${entries.realms}) > 0 or cardinality(${entries.projects}) > 0 or cardinality(${entries.runtimes}) > 0)`,
    )!
  }
  return eq(entries.bootMode, 'index')
}

export class EntryService {
  constructor(
    private readonly db: Db,
    private readonly masterKey: MasterKey | null,
    private readonly credentials: CredentialService,
    private readonly jobs: Jobs | null,
  ) {}

  // 历史事件行同样按快照中的 realms 校验密钥硬边界，防止词条变更场域后泄露旧场域历史内容
  private readableHistoryEventSql(scope: AccessScope): SQL | undefined {
    if (scope.kind === 'console' || scope.allowedRealms === null) return undefined
    if (scope.allowedRealms.length === 0) {
      return sql`coalesce(jsonb_array_length(${entryEvents.snapshot}->'realms'), 0) = 0`
    }
    return sql`(coalesce(jsonb_array_length(${entryEvents.snapshot}->'realms'), 0) = 0 or exists (select 1 from jsonb_array_elements_text(${entryEvents.snapshot}->'realms') r where r = any(${textArraySql(scope.allowedRealms)})))`
  }

  private visibleActorForScope(scope: AccessScope, rawActor: string): string {
    if (scope.kind === 'console') return rawActor
    if (rawActor.startsWith('key:') && rawActor !== `key:${scope.prefix}`) return 'key'
    return rawActor
  }

  private async loadRecentHistory(
    tx: Db | Tx,
    scope: AccessScope,
    entryId: string,
    limit = RECENT_HISTORY_LIMIT,
  ): Promise<EntryRecentHistoryItem[]> {
    const rows = await tx
      .select({
        id: entryEvents.id,
        eventType: entryEvents.eventType,
        actor: entryEvents.actor,
        changeSummary: entryEvents.changeSummary,
        diffMeta: entryEvents.diffMeta,
        occurredAt: entryEvents.occurredAt,
        version: sql<number | null>`(${entryEvents.snapshot}->>'version')::int`,
        createdAt: entryEvents.createdAt,
      })
      .from(entryEvents)
      .where(and(eq(entryEvents.entryId, entryId), this.readableHistoryEventSql(scope)))
      .orderBy(desc(entryEvents.id))
      .limit(limit)

    const actorMap = await resolveActorMetaMap(
      tx,
      rows.map((r) => r.actor),
      scope.kind === 'key' ? { ownKeyPrefix: scope.prefix, redactOtherKeyNames: true } : {},
    )

    return rows.map((r) => {
      const actorMeta = actorMap.get(r.actor)
      return {
        id: r.id,
        version: r.eventType === 'archive_note' ? null : r.version,
        eventType: r.eventType,
        actor: this.visibleActorForScope(scope, r.actor),
        ...(actorMeta ? { actorMeta } : {}),
        changeSummary: r.changeSummary,
        ...(r.diffMeta ? { diffMeta: r.diffMeta } : {}),
        ...(r.occurredAt ? { occurredAt: r.occurredAt.toISOString() } : {}),
        createdAt: r.createdAt.toISOString(),
      }
    })
  }

  // 批量解析文本中 [[m-xxxxxx]] 对应的可见活跃词条标题，严格遵守场域硬边界
  private async resolveLinkedTitles(
    tx: Db | Tx,
    scope: AccessScope,
    texts: readonly (string | null | undefined)[],
  ): Promise<Record<string, string>> {
    const idSet = new Set<string>()
    for (const text of texts) {
      if (!text) continue
      for (const shortId of extractTargetShortIds(text)) {
        idSet.add(shortId)
      }
    }
    if (!idSet.size) return {}

    const rows = await tx
      .select({ shortId: entries.shortId, title: entries.title })
      .from(entries)
      .where(
        and(
          inArray(entries.shortId, [...idSet]),
          isNull(entries.deletedAt),
          readableEntrySql(scope, { includeExpired: scope.kind === 'console' }),
        ),
      )

    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.shortId] = row.title
    }
    return result
  }

  private async hydrateDetail(
    tx: Db | Tx,
    scope: AccessScope,
    row: EntryRow,
    warnings?: HygieneWarning[],
  ): Promise<EntryDetailResponse> {
    const [{ outboundLinks, backlinks }, credentialRefs, recentHistory, pendingCountRow] =
      await Promise.all([
        loadEntryLinks(tx, scope, row.id, row.shortId),
        this.credentials.placeholderStatuses(tx, scope, row.content),
        this.loadRecentHistory(tx, scope, row.id),
        scope.kind === 'console'
          ? tx
              .select({ count: sql<number>`count(*)::int` })
              .from(dreamSuggestions)
              .where(
                and(
                  eq(dreamSuggestions.status, 'pending'),
                  sql`${row.id}::uuid = any(${dreamSuggestions.entryIds})`,
                ),
              )
              .then((rows) => rows[0]?.count ?? 0)
          : Promise.resolve(0),
      ])
    const linkedTitles = await this.resolveLinkedTitles(tx, scope, [
      row.lastChangeSummary,
      row.summary,
      ...recentHistory.map((h) => h.changeSummary),
      ...outboundLinks.map((l) => l.contextSnippet),
      ...backlinks.map((l) => l.contextSnippet),
    ])
    return {
      entry: toEntryView(row),
      outboundLinks,
      backlinks,
      credentialRefs,
      recentHistory,
      ...(warnings?.length ? { warnings } : {}),
      ...(pendingCountRow > 0 ? { pendingSuggestionCount: pendingCountRow } : {}),
      ...(Object.keys(linkedTitles).length ? { linkedTitles } : {}),
    }
  }

  private async findByIdOrTitle(
    tx: Db | Tx,
    scope: AccessScope,
    rawId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<EntryRow | null> {
    const trimmed = rawId.trim()
    if (!trimmed) return null
    const shortId = parseShortId(trimmed)
    const whereBase = shortId
      ? eq(entries.shortId, shortId)
      : UUID.test(trimmed)
        ? eq(entries.id, trimmed)
        : eq(entries.title, trimmed)

    const [row] = await tx
      .select()
      .from(entries)
      .where(
        and(
          whereBase,
          readableEntrySql(scope, {
            includeDeleted: Boolean(options.includeDeleted),
            includeExpired: scope.kind === 'console',
          }),
        ),
      )
      .orderBy(desc(entries.updatedAt))
      .limit(1)

    return row ?? null
  }

  async create(scope: AccessScope, input: CreateEntryRequest): Promise<EntryDetailResponse> {
    const realms = resolveCreateRealms(scope, input.realms)
    assertEntryWriteAllowed(scope, realms)
    const detail = await withTx(this.db, async (tx, now) => {
      const validTo = parseValidTo(input.validTo, now)
      const summary = cleanOptionalText(input.summary)
      const changeSummary = cleanOptionalText(input.changeSummary)
      const bootMode = resolveBootMode({ bootMode: input.bootMode, isPinned: input.isPinned })
      const isPinned = bootModeToPinned(bootMode)
      const { value: row } = await insertWithAllocatedShortId(tx, async (sp, shortId) => {
        const title = deriveEntryTitle(input.title, input.content, shortId)
        const searchTags = buildSearchTags({
          shortId,
          topics: input.topics,
          envs: input.envs,
          realms,
          projects: input.projects,
          runtimes: input.runtimes,
        })
        const [inserted] = await sp
          .insert(entries)
          .values({
            shortId,
            kind: 'entry',
            title,
            summary,
            content: input.content,
            disclosure: cleanOptionalText(input.disclosure),
            isPinned,
            bootMode,
            envs: input.envs,
            realms,
            projects: input.projects,
            runtimes: input.runtimes,
            topics: input.topics,
            searchTags,
            validTo,
            verifiedAt: now,
            lastChangeSummary: changeSummary,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        return inserted!
      })

      await syncEntryLinks(tx, row.id, row.shortId, row.content)
      await tx.insert(entryEvents).values({
        entryId: row.id,
        eventType: 'create',
        actor: actorLabel(scope),
        changeSummary,
        diffMeta: {
          changedFields: ['title', 'content'],
          contentCharsBefore: 0,
          contentCharsAfter: row.content.length,
        },
        snapshot: toSnapshot(row),
        createdAt: now,
      })

      const warnings = lintEntryHygiene({
        title: row.title,
        content: row.content,
        summary: row.summary,
        isPinned: row.isPinned,
        bootMode: row.bootMode,
        envs: row.envs,
        realms: row.realms,
        projects: row.projects,
        runtimes: row.runtimes,
        topics: row.topics,
        isUpdate: false,
      })
      return this.hydrateDetail(tx, scope, row, warnings)
    })

    this.jobs?.enqueueEmbed(detail.entry.id)
    return detail
  }

  async get(
    scope: AccessScope,
    idOrTitle: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<EntryDetailResponse> {
    const row = await this.findByIdOrTitle(this.db, scope, idOrTitle, options)
    if (!row) throw new MemoryError(404, '词条不存在或不可见')
    return this.hydrateDetail(this.db, scope, row)
  }

  async update(
    scope: AccessScope,
    idOrShortId: string,
    input: UpdateEntryRequest,
  ): Promise<EntryDetailResponse> {
    const detail = await withTx(this.db, async (tx, now) => {
      const existing = await this.findByIdOrTitle(tx, scope, idOrShortId)
      if (!existing) throw new MemoryError(404, '词条不存在或不可见')

      assertEntryWriteAllowed(scope, existing.realms)
      const nextRealms = input.realms ?? existing.realms
      assertEntryWriteAllowed(scope, nextRealms)

      if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
        throw new MemoryError(
          409,
          `版本冲突：当前版本为 ${existing.version}，请刷新后再保存`,
          'version_conflict',
        )
      }

      const promoting = input.promoteToEntry === true && existing.kind === 'episode'
      const nextKind = promoting ? 'entry' : existing.kind
      if (
        nextKind === 'episode' &&
        (input.isPinned === true || (input.bootMode !== undefined && input.bootMode !== 'none'))
      ) {
        throw new MemoryError(400, '会话摘要不能直接标为常驻，请先提炼为正式记忆')
      }

      let nextContent = existing.content
      if (input.patch !== undefined) {
        const patched = applyCapturePatch(existing.content, input.patch)
        if (!patched.ok) {
          throw new MemoryError(400, `局部补丁应用失败：${patched.reason}`)
        }
        nextContent = patched.content
      } else if (input.content !== undefined) {
        nextContent = input.content
      }

      const nextTitle =
        input.title !== undefined
          ? deriveEntryTitle(input.title, nextContent, existing.shortId)
          : existing.title
      const nextSummary =
        input.summary !== undefined ? cleanOptionalText(input.summary) : existing.summary
      const nextDisclosure =
        input.disclosure !== undefined
          ? cleanOptionalText(input.disclosure)
          : promoting
            ? null
            : existing.disclosure
      const nextBootMode: BootMode =
        nextKind === 'episode'
          ? 'none'
          : input.bootMode !== undefined
            ? input.bootMode
            : input.isPinned !== undefined
              ? input.isPinned
                ? existing.bootMode === 'none'
                  ? 'full'
                  : existing.bootMode
                : 'none'
              : existing.bootMode
      const nextIsPinned = bootModeToPinned(nextBootMode)
      const nextEnvs = input.envs ?? existing.envs
      const nextProjects = input.projects ?? existing.projects
      const nextRuntimes = input.runtimes ?? existing.runtimes
      const nextTopics = input.topics ?? existing.topics
      const nextValidTo =
        input.validTo !== undefined
          ? parseValidTo(input.validTo, now)
          : promoting
            ? null
            : existing.validTo
      const nextDeviceKey = promoting ? null : existing.deviceKey
      const nextProjectSlug = promoting ? null : existing.projectSlug
      const nextVersion = existing.version + 1
      const searchTags = buildSearchTags({
        shortId: existing.shortId,
        topics: nextTopics,
        envs: nextEnvs,
        realms: nextRealms,
        projects: nextProjects,
        runtimes: nextRuntimes,
      })

      const contentChanged = nextContent !== existing.content
      const titleChanged = nextTitle !== existing.title
      const summaryChanged = (nextSummary ?? null) !== (existing.summary ?? null)
      const realmsChanged = !sameStringList(existing.realms, nextRealms)
      const explicitChangeSummary = cleanOptionalText(input.changeSummary)
      // 显式提交变更说明时更新缓存；实质改动正文/标题/概要或变更场域却未填说明时清空旧缓存，避免张冠李戴或跨场域泄露
      const nextLastChangeSummary =
        explicitChangeSummary !== null
          ? explicitChangeSummary
          : contentChanged || titleChanged || summaryChanged || realmsChanged
            ? null
            : existing.lastChangeSummary
      const nextVerifiedAt = contentChanged || input.verified === true ? now : existing.verifiedAt

      const diffMeta = computeDiffMeta(existing, {
        kind: nextKind,
        title: nextTitle,
        summary: nextSummary,
        content: nextContent,
        disclosure: nextDisclosure,
        isPinned: nextIsPinned,
        bootMode: nextBootMode,
        envs: nextEnvs,
        realms: nextRealms,
        projects: nextProjects,
        runtimes: nextRuntimes,
        topics: nextTopics,
        validTo: nextValidTo,
      })

      const [updated] = await tx
        .update(entries)
        .set({
          kind: nextKind,
          title: nextTitle,
          summary: nextSummary,
          content: nextContent,
          disclosure: nextDisclosure,
          isPinned: nextIsPinned,
          bootMode: nextBootMode,
          envs: nextEnvs,
          realms: nextRealms,
          projects: nextProjects,
          runtimes: nextRuntimes,
          topics: nextTopics,
          deviceKey: nextDeviceKey,
          projectSlug: nextProjectSlug,
          searchTags,
          validTo: nextValidTo,
          verifiedAt: nextVerifiedAt,
          lastChangeSummary: nextLastChangeSummary,
          version: nextVersion,
          updatedAt: now,
        })
        .where(and(eq(entries.id, existing.id), eq(entries.version, existing.version)))
        .returning()
      if (!updated) {
        throw new MemoryError(409, '版本冲突：词条已被并发修改，请刷新后再保存', 'version_conflict')
      }

      await syncEntryLinks(tx, updated.id, updated.shortId, updated.content)
      const shouldEmbed =
        updated.kind === 'entry' ||
        (hasEpisodeSignals(updated.disclosure) &&
          (updated.validTo === null || updated.validTo > now))
      if (updated.kind === 'episode' && !shouldEmbed) {
        await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, updated.id))
      }
      await tx.insert(entryEvents).values({
        entryId: updated.id,
        eventType: 'update',
        actor: actorLabel(scope),
        changeSummary: explicitChangeSummary,
        diffMeta,
        snapshot: toSnapshot(updated),
        createdAt: now,
      })

      const warnings = lintEntryHygiene({
        title: updated.title,
        content: updated.content,
        summary: updated.summary,
        isPinned: updated.isPinned,
        bootMode: updated.bootMode,
        envs: updated.envs,
        realms: updated.realms,
        projects: updated.projects,
        runtimes: updated.runtimes,
        topics: updated.topics,
        isUpdate: true,
        contentChanged,
        changeSummary: explicitChangeSummary,
        previousContent: existing.content,
      })
      return { detail: await this.hydrateDetail(tx, scope, updated, warnings), shouldEmbed }
    })

    if (detail.shouldEmbed) {
      this.jobs?.enqueueEmbed(detail.detail.entry.id)
    }
    return detail.detail
  }

  async remove(
    scope: AccessScope,
    idOrShortId: string,
    options: { expectedVersion?: number; permanent?: boolean; changeSummary?: string | null } = {},
  ): Promise<void> {
    if (options.permanent && scope.kind !== 'console') {
      throw new MemoryError(403, '只有管理界面允许永久删除')
    }
    await withTx(this.db, async (tx, now) => {
      const existing = await this.findByIdOrTitle(tx, scope, idOrShortId, {
        includeDeleted: Boolean(options.permanent),
      })
      if (!existing) throw new MemoryError(404, '词条不存在或不可见')
      assertEntryWriteAllowed(scope, existing.realms)
      if (options.expectedVersion !== undefined && existing.version !== options.expectedVersion) {
        throw new MemoryError(409, `版本冲突：当前版本为 ${existing.version}`, 'version_conflict')
      }

      if (options.permanent) {
        const removed = await tx
          .delete(entries)
          .where(and(eq(entries.id, existing.id), eq(entries.version, existing.version)))
          .returning({ id: entries.id })
        if (!removed.length) {
          throw new MemoryError(409, '版本冲突：词条已被并发修改或删除', 'version_conflict')
        }
        return
      }

      const changeSummary = cleanOptionalText(options.changeSummary)
      const [deleted] = await tx
        .update(entries)
        .set({
          deletedAt: now,
          updatedAt: now,
          ...(changeSummary !== null ? { lastChangeSummary: changeSummary } : {}),
          version: existing.version + 1,
        })
        .where(and(eq(entries.id, existing.id), eq(entries.version, existing.version)))
        .returning()
      if (!deleted) {
        throw new MemoryError(409, '版本冲突：词条已被并发修改，请刷新后再试', 'version_conflict')
      }

      await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, existing.id))
      await tx.insert(entryEvents).values({
        entryId: deleted.id,
        eventType: 'delete',
        actor: actorLabel(scope),
        changeSummary,
        snapshot: toSnapshot(deleted),
        createdAt: now,
      })
    })
  }

  async restore(
    scope: AccessScope,
    shortId: string,
    input: RestoreEntryRequest,
  ): Promise<EntryDetailResponse> {
    const detail = await withTx(this.db, async (tx, now) => {
      const existing = await this.findByIdOrTitle(tx, scope, shortId, { includeDeleted: true })
      if (!existing) throw new MemoryError(404, '词条不存在')
      assertEntryWriteAllowed(scope, existing.realms)

      if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
        throw new MemoryError(
          409,
          `版本冲突：当前版本为 ${existing.version}，请刷新后再试`,
          'version_conflict',
        )
      }

      if (input.version === undefined) {
        if (!existing.deletedAt) throw new MemoryError(409, '该词条未在回收站中')
        const changeSummary = '从回收站恢复生效'
        const [restored] = await tx
          .update(entries)
          .set({
            deletedAt: null,
            lastChangeSummary: changeSummary,
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(and(eq(entries.id, existing.id), eq(entries.version, existing.version)))
          .returning()
        if (!restored) {
          throw new MemoryError(409, '版本冲突：词条已被并发修改，请刷新后再试', 'version_conflict')
        }
        await tx.insert(entryEvents).values({
          entryId: restored.id,
          eventType: 'undelete',
          actor: actorLabel(scope),
          changeSummary,
          snapshot: toSnapshot(restored),
          createdAt: now,
        })
        const shouldEmbed =
          restored.kind === 'entry' ||
          (hasEpisodeSignals(restored.disclosure) &&
            (restored.validTo === null || restored.validTo > now))
        return { detail: await this.hydrateDetail(tx, scope, restored), shouldEmbed }
      }

      const [targetEvent] = await tx
        .select()
        .from(entryEvents)
        .where(
          and(
            eq(entryEvents.entryId, existing.id),
            this.readableHistoryEventSql(scope),
            sql`(${entryEvents.snapshot}->>'version')::int = ${input.version} and ${entryEvents.eventType} <> 'archive_note'`,
          ),
        )
        .orderBy(desc(entryEvents.id))
        .limit(1)
      if (!targetEvent) throw new MemoryError(404, `未找到版本 ${input.version} 的历史记录`)
      const snap = targetEvent.snapshot
      assertEntryWriteAllowed(scope, snap.realms)

      const nextKind = snap.kind
      const nextBootMode: BootMode = nextKind === 'episode' ? 'none' : effectiveBootMode(snap)
      const nextIsPinned = bootModeToPinned(nextBootMode)
      const searchTags = buildSearchTags({
        shortId: existing.shortId,
        topics: snap.topics,
        envs: snap.envs,
        realms: snap.realms,
        projects: snap.projects,
        runtimes: snap.runtimes,
      })
      const changeSummary = `恢复至版本 v${input.version}`
      const nextValidTo = snap.validTo ? new Date(snap.validTo) : null
      const diffMeta = computeDiffMeta(existing, {
        kind: nextKind,
        title: snap.title,
        summary: snap.summary ?? null,
        content: snap.content,
        disclosure: snap.disclosure,
        isPinned: nextIsPinned,
        bootMode: nextBootMode,
        envs: snap.envs,
        realms: snap.realms,
        projects: snap.projects,
        runtimes: snap.runtimes,
        topics: snap.topics,
        validTo: nextValidTo,
      })

      const [restored] = await tx
        .update(entries)
        .set({
          kind: nextKind,
          title: snap.title,
          summary: snap.summary ?? null,
          content: snap.content,
          disclosure: snap.disclosure,
          isPinned: nextIsPinned,
          bootMode: nextBootMode,
          envs: snap.envs,
          realms: snap.realms,
          projects: snap.projects,
          runtimes: snap.runtimes,
          topics: snap.topics,
          searchTags,
          validTo: nextValidTo,
          verifiedAt: snap.verifiedAt ? new Date(snap.verifiedAt) : existing.verifiedAt,
          lastChangeSummary: changeSummary,
          deletedAt: null,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(and(eq(entries.id, existing.id), eq(entries.version, existing.version)))
        .returning()
      if (!restored) {
        throw new MemoryError(409, '版本冲突：词条已被并发修改，请刷新后再试', 'version_conflict')
      }

      await syncEntryLinks(tx, restored.id, restored.shortId, restored.content)
      const shouldEmbed =
        restored.kind === 'entry' ||
        (hasEpisodeSignals(restored.disclosure) &&
          (restored.validTo === null || restored.validTo > now))
      if (restored.kind === 'episode' && !shouldEmbed) {
        await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, restored.id))
      }
      await tx.insert(entryEvents).values({
        entryId: restored.id,
        eventType: 'restore',
        actor: actorLabel(scope),
        changeSummary,
        diffMeta,
        snapshot: toSnapshot(restored),
        createdAt: now,
      })
      return { detail: await this.hydrateDetail(tx, scope, restored), shouldEmbed }
    })

    if (detail.shouldEmbed) {
      this.jobs?.enqueueEmbed(detail.detail.entry.id)
    }
    return detail.detail
  }

  async history(
    scope: AccessScope,
    idOrShortId: string,
    options: EntryHistoryQuery = {},
  ): Promise<EntryHistoryResponse> {
    const entry = await this.findByIdOrTitle(this.db, scope, idOrShortId, {
      includeDeleted: scope.kind === 'console',
    })
    if (!entry) throw new MemoryError(404, '词条不存在或不可见')

    const limit = Math.min(options.limit ?? HISTORY_LIMIT, HISTORY_LIMIT)
    const includeSnapshots =
      options.includeSnapshots ?? (scope.kind === 'console' || options.version !== undefined)

    const rows = await this.db
      .select()
      .from(entryEvents)
      .where(
        and(
          eq(entryEvents.entryId, entry.id),
          this.readableHistoryEventSql(scope),
          options.version !== undefined
            ? sql`(${entryEvents.snapshot}->>'version')::int = ${options.version} and ${entryEvents.eventType} <> 'archive_note'`
            : undefined,
        ),
      )
      .orderBy(desc(entryEvents.id))
      .limit(limit)

    const actorMap = await resolveActorMetaMap(
      this.db,
      rows.map((r) => r.actor),
      scope.kind === 'key' ? { ownKeyPrefix: scope.prefix, redactOtherKeyNames: true } : {},
    )

    const items: EntryHistoryItem[] = rows.map((r) => {
      const actorMeta = actorMap.get(r.actor)
      return {
        id: r.id,
        eventType: r.eventType,
        actor: this.visibleActorForScope(scope, r.actor),
        ...(actorMeta ? { actorMeta } : {}),
        changeSummary: r.changeSummary,
        ...(r.diffMeta ? { diffMeta: r.diffMeta } : {}),
        ...(r.occurredAt ? { occurredAt: r.occurredAt.toISOString() } : {}),
        version: r.eventType === 'archive_note' ? null : r.snapshot.version,
        ...(includeSnapshots && r.eventType !== 'archive_note' ? { snapshot: r.snapshot } : {}),
        createdAt: r.createdAt.toISOString(),
      }
    })
    const linkedTitles = await this.resolveLinkedTitles(
      this.db,
      scope,
      items.flatMap((item) => [
        item.changeSummary,
        ...(item.snapshot ? [item.snapshot.summary, item.snapshot.content] : []),
      ]),
    )
    return {
      items,
      ...(Object.keys(linkedTitles).length ? { linkedTitles } : {}),
    }
  }

  private async loadCountsAndFacets(): Promise<{
    counts: EntryTabCounts
    facets: EntryFacetsSummary
  }> {
    const [countRow] = await this.db
      .select({
        all: sql<number>`count(*) filter (where ${entries.kind} = 'entry' and ${entries.deletedAt} is null)::int`,
        pinned: sql<number>`count(*) filter (where ${entries.kind} = 'entry' and ${entries.isPinned} = true and ${entries.deletedAt} is null)::int`,
        regular: sql<number>`count(*) filter (where ${entries.kind} = 'entry' and ${entries.isPinned} = false and ${entries.deletedAt} is null)::int`,
        episodes: sql<number>`count(*) filter (where ${entries.kind} = 'episode' and ${entries.deletedAt} is null)::int`,
        trash: sql<number>`count(*) filter (where ${entries.deletedAt} is not null)::int`,
        pinnedChars: sql<number>`coalesce(sum(char_length(${entries.content}) + char_length(${entries.title})) filter (where ${entries.kind} = 'entry' and ${entries.isPinned} = true and ${entries.deletedAt} is null), 0)::int`,
        globalFullPinnedCount: sql<number>`count(*) filter (where ${entries.kind} = 'entry' and ${entries.bootMode} = 'full' and ${entries.deletedAt} is null and cardinality(${entries.envs}) = 0 and cardinality(${entries.realms}) = 0 and cardinality(${entries.projects}) = 0 and cardinality(${entries.runtimes}) = 0)::int`,
        globalFullPinnedChars: sql<number>`coalesce(sum(char_length(${entries.content}) + char_length(${entries.title})) filter (where ${entries.kind} = 'entry' and ${entries.bootMode} = 'full' and ${entries.deletedAt} is null and cardinality(${entries.envs}) = 0 and cardinality(${entries.realms}) = 0 and cardinality(${entries.projects}) = 0 and cardinality(${entries.runtimes}) = 0), 0)::int`,
        scopedFullPinnedCount: sql<number>`count(*) filter (where ${entries.kind} = 'entry' and ${entries.bootMode} = 'full' and ${entries.deletedAt} is null and (cardinality(${entries.envs}) > 0 or cardinality(${entries.realms}) > 0 or cardinality(${entries.projects}) > 0 or cardinality(${entries.runtimes}) > 0))::int`,
        indexPinnedCount: sql<number>`count(*) filter (where ${entries.kind} = 'entry' and ${entries.bootMode} = 'index' and ${entries.deletedAt} is null)::int`,
      })
      .from(entries)

    const [facetRow] = await this.db.execute<{
      projects: string[] | null
      envs: string[] | null
      realms: string[] | null
      runtimes: string[] | null
      topics: string[] | null
    }>(sql`
      select
        (select array_agg(distinct v order by v) from entries, unnest(projects) v where deleted_at is null) as projects,
        (select array_agg(distinct v order by v) from entries, unnest(envs) v where deleted_at is null) as envs,
        (select array_agg(distinct v order by v) from entries, unnest(realms) v where deleted_at is null) as realms,
        (select array_agg(distinct v order by v) from entries, unnest(runtimes) v where deleted_at is null) as runtimes,
        (
          select array_agg(t.v order by t.cnt desc, t.v asc)
          from (
            select v, count(distinct id)::int as cnt
            from entries, unnest(topics) v
            where deleted_at is null
            group by v
            order by count(distinct id) desc, v asc
            limit 48
          ) t
        ) as topics
    `)

    return {
      counts: {
        all: countRow?.all ?? 0,
        pinned: countRow?.pinned ?? 0,
        regular: countRow?.regular ?? 0,
        episodes: countRow?.episodes ?? 0,
        trash: countRow?.trash ?? 0,
        pinnedChars: countRow?.pinnedChars ?? 0,
        globalFullPinnedCount: countRow?.globalFullPinnedCount ?? 0,
        globalFullPinnedChars: countRow?.globalFullPinnedChars ?? 0,
        scopedFullPinnedCount: countRow?.scopedFullPinnedCount ?? 0,
        indexPinnedCount: countRow?.indexPinnedCount ?? 0,
      },
      facets: {
        projects: facetRow?.projects ?? [],
        envs: facetRow?.envs ?? [],
        realms: facetRow?.realms ?? [],
        runtimes: facetRow?.runtimes ?? [],
        topics: facetRow?.topics ?? [],
      },
    }
  }

  async listConsole(scope: AccessScope, query: EntryListQuery): Promise<EntryListResponse> {
    const { counts, facets } = await this.loadCountsAndFacets()
    const filters: SQL[] = []

    if (query.env) filters.push(sql`${entries.envs} && ${textArraySql([query.env])}`)
    if (query.realm) filters.push(sql`${entries.realms} && ${textArraySql([query.realm])}`)
    if (query.project) filters.push(sql`${entries.projects} && ${textArraySql([query.project])}`)
    if (query.projectScope === 'unassigned') {
      filters.push(sql`cardinality(${entries.projects}) = 0`)
    } else if (query.projectScope === 'assigned') {
      filters.push(sql`cardinality(${entries.projects}) > 0`)
    }
    if (query.runtime) filters.push(sql`${entries.runtimes} && ${textArraySql([query.runtime])}`)
    if (query.topic) filters.push(sql`${entries.topics} && ${textArraySql([query.topic])}`)

    if (query.mode === 'lookup') {
      const q = query.q?.trim() ?? ''
      const like = q ? `%${escapeLike(q)}%` : null
      const rows = await this.db
        .select()
        .from(entries)
        .where(
          and(
            isNull(entries.deletedAt),
            eq(entries.kind, 'entry'),
            ...filters,
            like ? or(ilike(entries.shortId, like), ilike(entries.title, like)) : undefined,
          ),
        )
        .orderBy(desc(entries.updatedAt), asc(entries.shortId))
        .limit(Math.min(query.limit, 20))
      return {
        items: rows.map((r) => toListItem(r)),
        nextCursor: null,
        facets,
        counts,
      }
    }

    if (query.tab === 'pinned' && query.pinnedGroup) {
      filters.push(pinnedGroupFilterSql(query.pinnedGroup))
    }

    const q = query.q?.trim() ?? ''
    if (q && query.tab !== 'trash' && query.tab !== 'episodes') {
      const focus = synthesizeFocus(scope, {
        env: query.env,
        realm: query.realm,
        project: query.project,
        runtime: query.runtime,
      })
      const hasNarrowFilter =
        query.tab !== 'all' ||
        Boolean(
          query.pinnedGroup ||
          query.env ||
          query.realm ||
          query.project ||
          query.projectScope ||
          query.runtime ||
          query.topic,
        )
      const recallLimit = hasNarrowFilter
        ? Math.min(100, Math.max(query.limit * 2, 40))
        : query.limit
      const recalled = await recallEntries(this.db, this.masterKey, scope, q, {
        focus,
        limit: recallLimit,
        minScore: 0.1,
      })
      const pinnedFilter =
        query.tab === 'pinned'
          ? eq(entries.isPinned, true)
          : query.tab === 'regular'
            ? eq(entries.isPinned, false)
            : undefined
      const like = `%${escapeLike(q)}%`
      const directRows = await this.db
        .select()
        .from(entries)
        .where(
          and(
            isNull(entries.deletedAt),
            eq(entries.kind, 'entry'),
            pinnedFilter,
            ...filters,
            or(
              ilike(entries.shortId, like),
              ilike(entries.title, like),
              ilike(entries.summary, like),
              ilike(entries.disclosure, like),
              ilike(entries.content, like),
            ),
          ),
        )
        .orderBy(desc(entries.updatedAt))
        .limit(query.limit)

      const recalledIds = recalled.map((c) => c.entryId)
      const recalledRows = recalledIds.length
        ? await this.db
            .select()
            .from(entries)
            .where(
              and(
                inArray(entries.id, recalledIds),
                isNull(entries.deletedAt),
                pinnedFilter,
                ...filters,
              ),
            )
        : []
      const rowById = new Map(recalledRows.map((r) => [r.id, r]))

      const items: EntryListItem[] = []
      const seen = new Set<string>()
      for (const r of directRows) {
        const lower = q.toLowerCase()
        if (r.shortId === lower || r.title.toLowerCase() === lower) {
          seen.add(r.id)
          items.push(toListItem(r, { score: 1 }))
        }
      }
      for (const cand of recalled) {
        if (seen.has(cand.entryId)) continue
        const row = rowById.get(cand.entryId)
        if (!row) continue
        seen.add(row.id)
        items.push(toListItem(row, { score: cand.score }))
      }
      for (const r of directRows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        items.push(toListItem(r))
      }

      const pageItems = items.slice(0, query.limit)
      const linkedTitles = await this.resolveLinkedTitles(
        this.db,
        scope,
        pageItems.flatMap((item) => [item.lastChangeSummary, item.summary, item.snippet]),
      )
      return {
        items: pageItems,
        nextCursor: null,
        facets,
        counts,
        ...(Object.keys(linkedTitles).length ? { linkedTitles } : {}),
      }
    }

    if (query.tab === 'trash') {
      filters.push(isNotNull(entries.deletedAt))
    } else if (query.tab === 'episodes') {
      filters.push(isNull(entries.deletedAt), eq(entries.kind, 'episode'))
    } else if (query.tab === 'pinned') {
      filters.push(isNull(entries.deletedAt), eq(entries.kind, 'entry'), eq(entries.isPinned, true))
    } else if (query.tab === 'regular') {
      filters.push(
        isNull(entries.deletedAt),
        eq(entries.kind, 'entry'),
        eq(entries.isPinned, false),
      )
    } else {
      filters.push(isNull(entries.deletedAt), eq(entries.kind, 'entry'))
    }

    if (q) {
      const like = `%${escapeLike(q)}%`
      filters.push(
        or(
          ilike(entries.shortId, like),
          ilike(entries.title, like),
          ilike(entries.summary, like),
          ilike(entries.disclosure, like),
          ilike(entries.content, like),
        )!,
      )
    }

    const decoded = decodeTimeCursor(query.cursor, UUID)
    if (decoded === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
    const sortByBootChars = query.tab === 'pinned' && query.pinnedGroup === 'global_full' && !q
    const bootCharsExpr = sql<number>`(char_length(${entries.content}) + char_length(${entries.title}))::int`
    const timeCol = query.tab === 'trash' ? entries.deletedAt : entries.updatedAt
    if (decoded) {
      const [cursorKey, cursorId] = decoded
      if (sortByBootChars) {
        const cursorChars = Number(cursorKey)
        if (!Number.isSafeInteger(cursorChars) || cursorChars > 0x7fffffff) {
          throw new MemoryError(400, INVALID_CURSOR)
        }
        filters.push(
          or(
            lt(bootCharsExpr, cursorChars),
            and(eq(bootCharsExpr, cursorChars), lt(entries.id, cursorId)),
          )!,
        )
      } else {
        const cursorTs = fromMicros(cursorKey)
        filters.push(
          or(lt(timeCol, cursorTs), and(eq(timeCol, cursorTs), lt(entries.id, cursorId)))!,
        )
      }
    }

    const rows = sortByBootChars
      ? await this.db
          .select({
            row: entries,
            cursorKey: sql<string>`(${bootCharsExpr})::text`,
          })
          .from(entries)
          .where(and(...filters))
          .orderBy(desc(bootCharsExpr), desc(entries.id))
          .limit(query.limit + 1)
      : await this.db
          .select({
            row: entries,
            cursorKey: microsOf(timeCol).mapWith(String),
          })
          .from(entries)
          .where(and(...filters))
          .orderBy(desc(timeCol), desc(entries.id))
          .limit(query.limit + 1)

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    const items = page.map((item) => toListItem(item.row))
    const linkedTitles = await this.resolveLinkedTitles(
      this.db,
      scope,
      items.flatMap((item) => [item.lastChangeSummary, item.summary, item.snippet]),
    )
    return {
      items,
      nextCursor: hasMore && last ? encodeTimeCursor(last.cursorKey, last.row.id) : null,
      facets,
      counts,
      ...(Object.keys(linkedTitles).length ? { linkedTitles } : {}),
    }
  }

  async browse(scope: AccessScope, query: BrowseEntriesQuery): Promise<EntryBrowseResponse> {
    const filters: SQL[] = [readableEntrySql(scope)]
    if (query.kind) filters.push(eq(entries.kind, query.kind))
    if (query.pinnedOnly) filters.push(eq(entries.isPinned, true))
    if (query.topic) filters.push(sql`${entries.topics} && ${textArraySql([query.topic])}`)
    if (query.project) filters.push(sql`${entries.projects} && ${textArraySql([query.project])}`)
    if (query.env) filters.push(sql`${entries.envs} && ${textArraySql([query.env])}`)
    if (query.realm) filters.push(sql`${entries.realms} && ${textArraySql([query.realm])}`)
    if (query.runtime) filters.push(sql`${entries.runtimes} && ${textArraySql([query.runtime])}`)
    if (query.query) {
      const like = `%${escapeLike(query.query)}%`
      filters.push(or(ilike(entries.title, like), ilike(entries.shortId, like))!)
    }

    const rows = await this.db
      .select()
      .from(entries)
      .where(and(...filters))
      .orderBy(desc(entries.isPinned), desc(entries.updatedAt), asc(entries.shortId))
      .limit(query.limit + 1)

    const truncated = rows.length > query.limit
    const sliced = truncated ? rows.slice(0, query.limit) : rows
    const groupsMap = new Map<string, EntryBrowseItem[]>()

    const addTo = (key: string, item: EntryBrowseItem) => {
      const list = groupsMap.get(key) ?? []
      list.push(item)
      groupsMap.set(key, list)
    }

    for (const row of sliced) {
      const item: EntryBrowseItem = {
        shortId: row.shortId,
        title: row.title,
        summary: row.summary,
        kind: row.kind,
        isPinned: row.isPinned,
        bootMode: row.bootMode,
        topics: row.topics,
        envs: row.envs,
        realms: row.realms,
        projects: row.projects,
        runtimes: row.runtimes,
        disclosure: row.disclosure,
        updatedAt: row.updatedAt.toISOString(),
        lastChangeSummary: row.lastChangeSummary,
        contentLength: row.content.length,
      }
      if (query.groupBy === 'kind') {
        addTo(row.kind === 'episode' ? '会话摘要' : '正式记忆', item)
        continue
      }
      const list =
        query.groupBy === 'topic'
          ? row.topics
          : query.groupBy === 'project'
            ? row.projects
            : query.groupBy === 'env'
              ? row.envs
              : query.groupBy === 'realm'
                ? row.realms
                : row.runtimes
      if (!list.length) {
        addTo('通用 / 未分组', item)
      } else {
        for (const tag of list) addTo(tag, item)
      }
    }

    const groups: EntryBrowseGroup[] = [...groupsMap.entries()]
      .sort(([a], [b]) =>
        a === '通用 / 未分组' ? 1 : b === '通用 / 未分组' ? -1 : a.localeCompare(b),
      )
      .map(([key, items]) => ({ key, label: key, count: items.length, items }))

    return { groupBy: query.groupBy, groups, truncated }
  }

  // 写入编码会话摘要：deviceKey 与 projectSlug 统一存空串 '' 而非 NULL，保证部分索引命中
  async writeEpisode(input: {
    title: string
    content: string
    deviceKey?: string
    projectSlug?: string
    envs?: readonly string[]
    realms?: readonly string[]
    projects?: readonly string[]
    facts?: readonly string[]
    directives?: readonly string[]
    ttlDays?: number
  }): Promise<EntryView> {
    const ttlDays = input.ttlDays ?? EPISODE_TTL_DAYS
    const envs = normalizeSlugList(input.envs)
    const realms = normalizeSlugList(input.realms)
    const projectSlug = (input.projectSlug ?? '').trim()
    const deviceKey = (input.deviceKey ?? '').trim()
    const projects = normalizeSlugList([
      ...(input.projects ?? []),
      ...(projectSlug ? [projectSlug] : []),
    ])
    const disclosure = serializeEpisodeSignals({
      facts: input.facts,
      directives: input.directives,
    })

    const row = await withTx(this.db, async (tx, now) => {
      const validTo = new Date(now.getTime() + ttlDays * 86_400_000)
      const { value: inserted } = await insertWithAllocatedShortId(tx, async (sp, shortId) => {
        const title = deriveEntryTitle(input.title, input.content, shortId)
        const searchTags = buildSearchTags({ shortId, envs, realms, projects })
        const [created] = await sp
          .insert(entries)
          .values({
            shortId,
            kind: 'episode',
            title,
            summary: null,
            content: input.content,
            disclosure,
            isPinned: false,
            bootMode: 'none',
            envs,
            realms,
            projects,
            runtimes: [],
            topics: [],
            deviceKey,
            projectSlug,
            searchTags,
            validTo,
            verifiedAt: now,
            lastChangeSummary: null,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        return created!
      })

      await tx.insert(entryEvents).values({
        entryId: inserted.id,
        eventType: 'create',
        actor: 'extraction',
        changeSummary: '自动抽取会话摘要',
        snapshot: toSnapshot(inserted),
        createdAt: now,
      })
      return inserted
    })

    // 仅对包含结构化偏好/事实信号的会话摘要触发信号定向向量化
    if (disclosure) {
      this.jobs?.enqueueEmbed(row.id)
    }

    return toEntryView(row)
  }

  async applySuggestion(
    suggestionId: string,
    overrides: ApplySuggestionRequest = {},
  ): Promise<ApplySuggestionResponse> {
    const result = await withTx(this.db, async (tx, now) => {
      const [suggestion] = await tx
        .select()
        .from(dreamSuggestions)
        .where(eq(dreamSuggestions.id, suggestionId))
        .for('update')
      if (!suggestion) throw new MemoryError(404, '整理建议不存在')
      if (suggestion.status !== 'pending') {
        throw new MemoryError(409, '该整理建议已处理过')
      }

      const targetRows = await tx
        .select()
        .from(entries)
        .where(inArray(entries.id, suggestion.entryIds))
        .orderBy(asc(entries.id))
        .for('update')
      const byId = new Map(targetRows.map((r) => [r.id, r]))

      for (let i = 0; i < suggestion.entryIds.length; i++) {
        const id = suggestion.entryIds[i]!
        const expected = suggestion.entryVersions[i]!
        const current = byId.get(id)
        if (!current || current.deletedAt !== null) {
          throw new MemoryError(409, '关联记忆已被删除，无法应用此建议')
        }
        if (current.version !== expected) {
          throw new MemoryError(409, '关联记忆已在建议生成后被修改，请忽略或重新整理')
        }
      }

      let resulting: ApplySuggestionResponse['entry']
      const embedIds: string[] = []
      let redirectedBacklinkCount = 0

      if (suggestion.kind === 'distill_episode') {
        const firstSource = byId.get(suggestion.entryIds[0]!)!
        const content = overrides.content ?? suggestion.proposedContent ?? firstSource.content
        const summary =
          overrides.summary !== undefined
            ? cleanOptionalText(overrides.summary)
            : cleanOptionalText(suggestion.proposedSummary)
        const envs = overrides.envs ?? suggestion.proposedEnvs ?? firstSource.envs
        const safeProposedRealms =
          suggestion.proposedRealms?.length &&
          targetRows.every((src) => canFlowRealmInto(suggestion.proposedRealms!, src.realms))
            ? suggestion.proposedRealms
            : null
        const fallbackRealms =
          firstSource.realms.length > 0
            ? firstSource.realms
            : normalizeSlugList(targetRows.flatMap((r) => r.realms))
        const realms = overrides.realms ?? safeProposedRealms ?? fallbackRealms
        const projects = overrides.projects ?? suggestion.proposedProjects ?? firstSource.projects
        const runtimes = overrides.runtimes ?? suggestion.proposedRuntimes ?? []
        const topics = overrides.topics ?? suggestion.proposedTopics ?? []
        const disclosure =
          overrides.disclosure !== undefined
            ? cleanOptionalText(overrides.disclosure)
            : cleanOptionalText(suggestion.proposedDisclosure)
        const changeSummary =
          cleanOptionalText(overrides.changeSummary) ??
          cleanOptionalText(suggestion.proposedChangeSummary) ??
          '由会话摘要提炼为正式记忆'
        const bootMode = resolveBootMode(
          { bootMode: overrides.bootMode, isPinned: overrides.isPinned },
          suggestion.proposedBootMode ?? 'none',
        )
        const isPinned = bootModeToPinned(bootMode)

        const { value: created } = await insertWithAllocatedShortId(tx, async (sp, shortId) => {
          const title = deriveEntryTitle(
            overrides.title ?? suggestion.proposedTitle,
            content,
            shortId,
          )
          const searchTags = buildSearchTags({ shortId, topics, envs, realms, projects, runtimes })
          const [row] = await sp
            .insert(entries)
            .values({
              shortId,
              kind: 'entry',
              title,
              summary,
              content,
              disclosure,
              isPinned,
              bootMode,
              envs,
              realms,
              projects,
              runtimes,
              topics,
              searchTags,
              verifiedAt: now,
              lastChangeSummary: changeSummary,
              version: 1,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
          return row!
        })

        await syncEntryLinks(tx, created.id, created.shortId, created.content)
        await tx.insert(entryEvents).values({
          entryId: created.id,
          eventType: 'create',
          actor: 'dream',
          changeSummary,
          snapshot: toSnapshot(created),
          createdAt: now,
        })

        for (const source of targetRows) {
          const [removed] = await tx
            .update(entries)
            .set({ deletedAt: now, updatedAt: now, version: source.version + 1 })
            .where(eq(entries.id, source.id))
            .returning()
          await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, source.id))
          await tx.insert(entryEvents).values({
            entryId: source.id,
            eventType: 'delete',
            actor: 'dream',
            changeSummary: `已提炼至 [[${created.shortId}]]`,
            snapshot: toSnapshot(removed!),
            createdAt: now,
          })
        }

        resulting = {
          id: created.id,
          shortId: created.shortId,
          title: created.title,
          version: created.version,
        }
        embedIds.push(created.id)
      } else if (suggestion.kind === 'merge_duplicates') {
        if (targetRows.length < 2) {
          throw new MemoryError(400, '合并重复建议至少需要两条活跃记忆')
        }
        if (targetRows.some((r) => r.kind !== 'entry')) {
          throw new MemoryError(400, '会话摘要不支持合并重复操作')
        }
        const keepId =
          suggestion.keepId && byId.has(suggestion.keepId)
            ? suggestion.keepId
            : suggestion.entryIds[0]!
        const keep = byId.get(keepId)!
        if (targetRows.some((r) => !sameRealms(r.realms, keep.realms))) {
          throw new MemoryError(400, '不同场域的记忆禁止合并，请分别维护')
        }
        const content = overrides.content ?? suggestion.proposedContent ?? keep.content

        // 合并完整性强校验：确认合并后正文保留了全部被合并词条中的外部双链与凭据占位符并集
        const mergedShortIds = new Set(targetRows.map((r) => r.shortId))
        const requiredLinks = new Set<string>()
        const requiredCreds = new Set<string>()
        const credKey = (p: { slug: string; field: string | null }) =>
          p.field ? `${p.slug}#${p.field}` : p.slug
        for (const row of targetRows) {
          for (const sid of extractTargetShortIds(row.content)) {
            if (!mergedShortIds.has(sid)) requiredLinks.add(sid)
          }
          for (const cred of extractCredentialPlaceholders(row.content)) {
            requiredCreds.add(credKey(cred))
          }
        }
        const afterLinks = new Set(extractTargetShortIds(content))
        const afterCreds = new Set(extractCredentialPlaceholders(content).map(credKey))
        const missingLinks = [...requiredLinks].filter((id) => !afterLinks.has(id))
        const missingCreds = [...requiredCreds].filter((k) => !afterCreds.has(k))
        if (missingLinks.length > 0 || missingCreds.length > 0) {
          const parts: string[] = []
          if (missingLinks.length) parts.push(`双链 ${missingLinks.join('、')}`)
          if (missingCreds.length) parts.push(`凭据占位符 ${missingCreds.join('、')}`)
          throw new MemoryError(
            400,
            `合并后正文遗漏了原有引用（${parts.join('；')}），请编辑补回后再应用`,
          )
        }

        const summary =
          overrides.summary !== undefined
            ? cleanOptionalText(overrides.summary)
            : (cleanOptionalText(suggestion.proposedSummary) ?? keep.summary)
        const title = deriveEntryTitle(
          overrides.title ?? suggestion.proposedTitle ?? keep.title,
          content,
          keep.shortId,
        )
        const disclosure =
          overrides.disclosure !== undefined
            ? cleanOptionalText(overrides.disclosure)
            : (cleanOptionalText(suggestion.proposedDisclosure) ?? keep.disclosure)
        const changeSummary =
          cleanOptionalText(overrides.changeSummary) ??
          cleanOptionalText(suggestion.proposedChangeSummary) ??
          '合并重复记忆'
        const topics =
          overrides.topics ??
          suggestion.proposedTopics ??
          mergeFallbackTopics(
            keep.topics,
            targetRows.map((r) => r.topics),
          )
        const envs =
          overrides.envs ??
          suggestion.proposedEnvs ??
          normalizeSlugList(targetRows.flatMap((r) => r.envs))
        // 合并重复若无人工显式覆盖，严格沿用已校验一致的 keep.realms，防止模型静默放宽场域边界
        const realms = overrides.realms ?? keep.realms
        const projects =
          overrides.projects ??
          suggestion.proposedProjects ??
          normalizeSlugList(targetRows.flatMap((r) => r.projects))
        const runtimes =
          overrides.runtimes ??
          suggestion.proposedRuntimes ??
          normalizeSlugList(targetRows.flatMap((r) => r.runtimes))
        const bootRank: Record<BootMode, number> = { none: 0, index: 1, full: 2 }
        const highestMergedBoot = targetRows.reduce<BootMode>(
          (best, r) => (bootRank[r.bootMode] > bootRank[best] ? r.bootMode : best),
          keep.bootMode,
        )
        const bootMode: BootMode =
          keep.kind === 'episode'
            ? 'none'
            : overrides.bootMode !== undefined
              ? overrides.bootMode
              : overrides.isPinned !== undefined
                ? overrides.isPinned
                  ? highestMergedBoot === 'none'
                    ? 'full'
                    : highestMergedBoot
                  : 'none'
                : highestMergedBoot
        const isPinned = bootModeToPinned(bootMode)
        const searchTags = buildSearchTags({
          shortId: keep.shortId,
          topics,
          envs,
          realms,
          projects,
          runtimes,
        })
        const diffMeta = computeDiffMeta(keep, {
          kind: keep.kind,
          title,
          summary,
          content,
          disclosure,
          isPinned,
          bootMode,
          envs,
          realms,
          projects,
          runtimes,
          topics,
          validTo: keep.validTo,
        })

        const [updated] = await tx
          .update(entries)
          .set({
            title,
            summary,
            content,
            disclosure,
            topics,
            envs,
            realms,
            projects,
            runtimes,
            isPinned,
            bootMode,
            searchTags,
            verifiedAt: now,
            lastChangeSummary: changeSummary,
            version: keep.version + 1,
            updatedAt: now,
          })
          .where(eq(entries.id, keep.id))
          .returning()

        await syncEntryLinks(tx, updated!.id, updated!.shortId, updated!.content)
        await tx.insert(entryEvents).values({
          entryId: updated!.id,
          eventType: 'update',
          actor: 'dream',
          changeSummary,
          diffMeta,
          snapshot: toSnapshot(updated!),
          createdAt: now,
        })

        const deletedShortIds: string[] = []
        for (const other of targetRows) {
          if (other.id === keep.id) continue
          deletedShortIds.push(other.shortId)
          const [removed] = await tx
            .update(entries)
            .set({ deletedAt: now, updatedAt: now, version: other.version + 1 })
            .where(eq(entries.id, other.id))
            .returning()
          await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, other.id))
          await tx.insert(entryEvents).values({
            entryId: other.id,
            eventType: 'delete',
            actor: 'dream',
            changeSummary: `已合并入 [[${keep.shortId}]]`,
            snapshot: toSnapshot(removed!),
            createdAt: now,
          })
        }

        // 事务内反链自动重定向：将全库活跃词条指向被删重复项的 [[old]] 确定性改写为 [[keep]]
        if (deletedShortIds.length) {
          const redirectMap = new Map(deletedShortIds.map((sid) => [sid, keep.shortId]))
          const mergedIdSet = new Set(targetRows.map((r) => r.id))
          const incomingLinks = await tx
            .select({ sourceEntryId: entryLinks.sourceEntryId })
            .from(entryLinks)
            .where(inArray(entryLinks.targetShortId, deletedShortIds))
          const refIds = [
            ...new Set(
              incomingLinks.map((l) => l.sourceEntryId).filter((id) => !mergedIdSet.has(id)),
            ),
          ]
          if (refIds.length) {
            const refRows = await tx
              .select()
              .from(entries)
              .where(
                and(
                  inArray(entries.id, refIds),
                  isNull(entries.deletedAt),
                  eq(entries.kind, 'entry'),
                ),
              )
            for (const refRow of refRows) {
              const rewritten = redirectWikiLinksInContent(refRow.content, redirectMap)
              if (
                rewritten.replacedCount === 0 ||
                rewritten.content === refRow.content ||
                rewritten.content.length > ENTRY_CONTENT_MAX
              ) {
                continue
              }
              const redirectNote = `合并重定向：${rewritten.redirectedTargets.map((s) => `[[${s}]]`).join('、')} → [[${keep.shortId}]]`
              const refDiff: EntryDiffMeta = {
                changedFields: ['content'],
                contentCharsBefore: refRow.content.length,
                contentCharsAfter: rewritten.content.length,
              }
              const [updatedRef] = await tx
                .update(entries)
                .set({
                  content: rewritten.content,
                  lastChangeSummary: redirectNote,
                  version: refRow.version + 1,
                  updatedAt: now,
                })
                .where(and(eq(entries.id, refRow.id), eq(entries.version, refRow.version)))
                .returning()
              if (!updatedRef) continue
              await syncEntryLinks(tx, updatedRef.id, updatedRef.shortId, updatedRef.content)
              await tx.insert(entryEvents).values({
                entryId: updatedRef.id,
                eventType: 'update',
                actor: 'dream',
                changeSummary: redirectNote,
                diffMeta: refDiff,
                snapshot: toSnapshot(updatedRef),
                createdAt: now,
              })
              embedIds.push(updatedRef.id)
              redirectedBacklinkCount++
            }
          }
        }

        resulting = {
          id: updated!.id,
          shortId: updated!.shortId,
          title: updated!.title,
          version: updated!.version,
          previousVersion: keep.version,
        }
        embedIds.push(updated!.id)
      } else if (suggestion.kind === 'mark_stale') {
        const target = byId.get(suggestion.entryIds[0]!)!
        const changeSummary =
          cleanOptionalText(overrides.changeSummary) ??
          cleanOptionalText(suggestion.proposedChangeSummary) ??
          `标记过时并移入回收站：${suggestion.reason.slice(0, 120)}`
        const [removed] = await tx
          .update(entries)
          .set({
            deletedAt: now,
            lastChangeSummary: changeSummary,
            updatedAt: now,
            version: target.version + 1,
          })
          .where(eq(entries.id, target.id))
          .returning()
        await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, target.id))
        await tx.insert(entryEvents).values({
          entryId: target.id,
          eventType: 'delete',
          actor: 'dream',
          changeSummary,
          snapshot: toSnapshot(removed!),
          createdAt: now,
        })
        resulting = null
      } else if (suggestion.kind === 'link_entries') {
        const target = byId.get(suggestion.entryIds[0]!)!
        const rawLinks = overrides.proposedLinks ?? suggestion.proposedLinks ?? []
        if (!rawLinks.length) {
          throw new MemoryError(400, '补全双链建议未包含有效目标链接')
        }
        const targetShorts = [...new Set(rawLinks.map((l) => normalizeShortId(l.targetShortId)))]
        const linkTargetRows = await tx
          .select({
            shortId: entries.shortId,
            title: entries.title,
            realms: entries.realms,
            deletedAt: entries.deletedAt,
            kind: entries.kind,
          })
          .from(entries)
          .where(inArray(entries.shortId, targetShorts))
        const linkTargetMap = new Map(linkTargetRows.map((r) => [r.shortId, r]))

        const existingTargets = new Set(extractTargetShortIds(target.content))
        let nextContent = target.content
        const addedShortIds: string[] = []

        for (const item of rawLinks) {
          const sid = normalizeShortId(item.targetShortId)
          if (!sid || sid === target.shortId || existingTargets.has(sid)) continue
          const linkTarget = linkTargetMap.get(sid)
          if (!linkTarget || linkTarget.deletedAt !== null || linkTarget.kind !== 'entry') continue
          if (!canFlowRealmInto(target.realms, linkTarget.realms)) continue

          const rawLabel = (item.relation?.trim() || linkTarget.title.trim())
            .replace(/[[\]|\r\n]+/g, ' ')
            .trim()
          const wiki = rawLabel ? `[[${sid}|${rawLabel}]]` : `[[${sid}]]`
          const reasonSuffix = item.reason?.trim() ? `：${item.reason.trim()}` : ''
          const line = `- ${wiki}${reasonSuffix}`

          const headings = extractMarkdownHeadings(nextContent)
          const wantedHeading = item.anchorHeading?.replace(/^#{1,6}[ \t]+/, '').trim()
          const matchedExplicit = wantedHeading
            ? headings.find((h) => h.toLowerCase() === wantedHeading.toLowerCase())
            : undefined
          const relatedHeading = headings.find((h) => h === '相关记忆')

          if (matchedExplicit) {
            nextContent = applyMarkdownAppend(nextContent, line, matchedExplicit).content
          } else if (relatedHeading) {
            nextContent = applyMarkdownAppend(nextContent, line, relatedHeading).content
          } else {
            const base = nextContent.trimEnd()
            nextContent = base ? `${base}\n\n## 相关记忆\n${line}` : `## 相关记忆\n${line}`
          }
          existingTargets.add(sid)
          addedShortIds.push(sid)
        }

        if (!addedShortIds.length) {
          throw new MemoryError(409, '建议的双链目标已存在、不可见或已被删除，无需重复追加')
        }
        if (nextContent.length > ENTRY_CONTENT_MAX) {
          throw new MemoryError(400, `追加双链后正文超过 ${ENTRY_CONTENT_MAX} 字符上限`)
        }

        const changeSummary =
          cleanOptionalText(overrides.changeSummary) ??
          cleanOptionalText(suggestion.proposedChangeSummary) ??
          `补全双链：${addedShortIds.map((s) => `[[${s}]]`).join('、')}`
        const diffMeta = computeDiffMeta(target, {
          kind: target.kind,
          title: target.title,
          summary: target.summary,
          content: nextContent,
          disclosure: target.disclosure,
          isPinned: target.isPinned,
          bootMode: target.bootMode,
          envs: target.envs,
          realms: target.realms,
          projects: target.projects,
          runtimes: target.runtimes,
          topics: target.topics,
          validTo: target.validTo,
        })

        const [updated] = await tx
          .update(entries)
          .set({
            content: nextContent,
            lastChangeSummary: changeSummary,
            version: target.version + 1,
            updatedAt: now,
          })
          .where(eq(entries.id, target.id))
          .returning()

        await syncEntryLinks(tx, updated!.id, updated!.shortId, updated!.content)
        await tx.insert(entryEvents).values({
          entryId: updated!.id,
          eventType: 'update',
          actor: 'dream',
          changeSummary,
          diffMeta,
          snapshot: toSnapshot(updated!),
          createdAt: now,
        })

        resulting = {
          id: updated!.id,
          shortId: updated!.shortId,
          title: updated!.title,
          version: updated!.version,
          previousVersion: target.version,
        }
        embedIds.push(updated!.id)
      } else if (suggestion.kind === 'adjust_boot_mode') {
        const target = byId.get(suggestion.entryIds[0]!)!
        const nextBootMode: BootMode =
          target.kind === 'episode'
            ? 'none'
            : overrides.bootMode !== undefined
              ? overrides.bootMode
              : overrides.isPinned !== undefined
                ? overrides.isPinned
                  ? suggestion.proposedBootMode && suggestion.proposedBootMode !== 'none'
                    ? suggestion.proposedBootMode
                    : target.bootMode !== 'none'
                      ? target.bootMode
                      : 'full'
                  : 'none'
                : (suggestion.proposedBootMode ?? target.bootMode)
        const nextIsPinned = bootModeToPinned(nextBootMode)
        const nextContent = overrides.content ?? target.content
        const nextTitle = deriveEntryTitle(
          overrides.title ?? target.title,
          nextContent,
          target.shortId,
        )
        const nextSummary =
          overrides.summary !== undefined
            ? cleanOptionalText(overrides.summary)
            : (cleanOptionalText(suggestion.proposedSummary) ?? target.summary)
        const nextDisclosure =
          overrides.disclosure !== undefined
            ? cleanOptionalText(overrides.disclosure)
            : target.disclosure
        const nextTopics = overrides.topics ?? target.topics
        const nextEnvs = overrides.envs ?? target.envs
        const nextRealms = overrides.realms ?? target.realms
        const nextProjects = overrides.projects ?? target.projects
        const nextRuntimes = overrides.runtimes ?? target.runtimes
        const searchTags = buildSearchTags({
          shortId: target.shortId,
          topics: nextTopics,
          envs: nextEnvs,
          realms: nextRealms,
          projects: nextProjects,
          runtimes: nextRuntimes,
        })
        const modeName: Record<BootMode, string> = {
          none: '按需召回',
          index: '目录常驻',
          full: '全文常驻',
        }
        const changeSummary =
          cleanOptionalText(overrides.changeSummary) ??
          cleanOptionalText(suggestion.proposedChangeSummary) ??
          `调整启动加载为${modeName[nextBootMode]}`
        const diffMeta = computeDiffMeta(target, {
          kind: target.kind,
          title: nextTitle,
          summary: nextSummary,
          content: nextContent,
          disclosure: nextDisclosure,
          isPinned: nextIsPinned,
          bootMode: nextBootMode,
          envs: nextEnvs,
          realms: nextRealms,
          projects: nextProjects,
          runtimes: nextRuntimes,
          topics: nextTopics,
          validTo: target.validTo,
        })

        const [updated] = await tx
          .update(entries)
          .set({
            title: nextTitle,
            summary: nextSummary,
            content: nextContent,
            disclosure: nextDisclosure,
            bootMode: nextBootMode,
            isPinned: nextIsPinned,
            topics: nextTopics,
            envs: nextEnvs,
            realms: nextRealms,
            projects: nextProjects,
            runtimes: nextRuntimes,
            searchTags,
            lastChangeSummary: changeSummary,
            version: target.version + 1,
            updatedAt: now,
          })
          .where(eq(entries.id, target.id))
          .returning()

        if (nextContent !== target.content) {
          await syncEntryLinks(tx, updated!.id, updated!.shortId, updated!.content)
        }
        await tx.insert(entryEvents).values({
          entryId: updated!.id,
          eventType: 'update',
          actor: 'dream',
          changeSummary,
          diffMeta,
          snapshot: toSnapshot(updated!),
          createdAt: now,
        })

        resulting = {
          id: updated!.id,
          shortId: updated!.shortId,
          title: updated!.title,
          version: updated!.version,
          previousVersion: target.version,
        }
        if (
          nextTitle !== target.title ||
          (nextSummary ?? null) !== (target.summary ?? null) ||
          nextContent !== target.content ||
          (nextDisclosure ?? null) !== (target.disclosure ?? null) ||
          searchTags !== target.searchTags
        ) {
          embedIds.push(updated!.id)
        }
      } else {
        // 同时处理 update 与 tidy（规范与精简）
        const target = byId.get(suggestion.entryIds[0]!)!
        const content = overrides.content ?? suggestion.proposedContent ?? target.content
        const summary =
          overrides.summary !== undefined
            ? cleanOptionalText(overrides.summary)
            : (cleanOptionalText(suggestion.proposedSummary) ?? target.summary)
        const title = deriveEntryTitle(
          overrides.title ?? suggestion.proposedTitle ?? target.title,
          content,
          target.shortId,
        )
        const disclosure =
          overrides.disclosure !== undefined
            ? cleanOptionalText(overrides.disclosure)
            : (cleanOptionalText(suggestion.proposedDisclosure) ?? target.disclosure)
        const changeSummary =
          cleanOptionalText(overrides.changeSummary) ??
          cleanOptionalText(suggestion.proposedChangeSummary) ??
          (suggestion.kind === 'tidy' ? '规范标题与结构并归档历史说明' : '根据整理建议更新内容')
        const topics = overrides.topics ?? suggestion.proposedTopics ?? target.topics
        const envs = overrides.envs ?? suggestion.proposedEnvs ?? target.envs
        const safeProposedRealms =
          suggestion.proposedRealms?.length &&
          canFlowRealmInto(suggestion.proposedRealms, target.realms)
            ? suggestion.proposedRealms
            : null
        const realms = overrides.realms ?? safeProposedRealms ?? target.realms
        const projects = overrides.projects ?? suggestion.proposedProjects ?? target.projects
        const runtimes = overrides.runtimes ?? suggestion.proposedRuntimes ?? target.runtimes
        const bootMode: BootMode =
          target.kind === 'episode'
            ? 'none'
            : overrides.bootMode !== undefined
              ? overrides.bootMode
              : overrides.isPinned !== undefined
                ? overrides.isPinned
                  ? target.bootMode === 'none'
                    ? 'full'
                    : target.bootMode
                  : 'none'
                : target.bootMode
        const isPinned = bootModeToPinned(bootMode)
        const searchTags = buildSearchTags({
          shortId: target.shortId,
          topics,
          envs,
          realms,
          projects,
          runtimes,
        })
        const diffMeta = computeDiffMeta(target, {
          kind: target.kind,
          title,
          summary,
          content,
          disclosure,
          isPinned,
          bootMode,
          envs,
          realms,
          projects,
          runtimes,
          topics,
          validTo: target.validTo,
        })

        // tidy 剥离的旧日期流水先按 archive_note 沉淀入 entry_events（保留原始快照与发生时间）
        const archivedNotes = suggestion.archivedNotes ?? []
        if (overrides.applyArchivedNotes !== false && archivedNotes.length) {
          const beforeSnap = toSnapshot(target)
          for (const item of archivedNotes) {
            const noteText = item.note.trim()
            if (!noteText) continue
            const occurredAt = item.occurredAt ? new Date(item.occurredAt) : null
            await tx.insert(entryEvents).values({
              entryId: target.id,
              eventType: 'archive_note',
              actor: 'dream',
              changeSummary: noteText,
              occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
              snapshot: beforeSnap,
              createdAt: now,
            })
          }
        }

        // tidy 仅做格式整理，不伪造新的事实核实时间；update 更新事实则刷新 verifiedAt
        const nextVerifiedAt = suggestion.kind === 'tidy' ? target.verifiedAt : now

        const [updated] = await tx
          .update(entries)
          .set({
            title,
            summary,
            content,
            disclosure,
            topics,
            envs,
            realms,
            projects,
            runtimes,
            isPinned,
            bootMode,
            searchTags,
            verifiedAt: nextVerifiedAt,
            lastChangeSummary: changeSummary,
            version: target.version + 1,
            updatedAt: now,
          })
          .where(eq(entries.id, target.id))
          .returning()

        await syncEntryLinks(tx, updated!.id, updated!.shortId, updated!.content)
        await tx.insert(entryEvents).values({
          entryId: updated!.id,
          eventType: 'update',
          actor: 'dream',
          changeSummary,
          diffMeta,
          snapshot: toSnapshot(updated!),
          createdAt: now,
        })

        resulting = {
          id: updated!.id,
          shortId: updated!.shortId,
          title: updated!.title,
          version: updated!.version,
          previousVersion: target.version,
        }
        if (updated!.kind === 'entry') embedIds.push(updated!.id)
      }

      await tx
        .update(dreamSuggestions)
        .set({ status: 'applied', decidedAt: now })
        .where(eq(dreamSuggestions.id, suggestion.id))

      return {
        response: {
          entry: resulting,
          ...(redirectedBacklinkCount > 0 ? { redirectedBacklinkCount } : {}),
        },
        embedIds,
      }
    })

    for (const id of result.embedIds) {
      this.jobs?.enqueueEmbed(id)
    }
    return result.response
  }

  async dismissSuggestion(suggestionId: string): Promise<void> {
    const updated = await this.db
      .update(dreamSuggestions)
      .set({ status: 'rejected', decidedAt: sql`now()` })
      .where(and(eq(dreamSuggestions.id, suggestionId), eq(dreamSuggestions.status, 'pending')))
      .returning({ id: dreamSuggestions.id })
    if (!updated.length) {
      const [exists] = await this.db
        .select({ status: dreamSuggestions.status })
        .from(dreamSuggestions)
        .where(eq(dreamSuggestions.id, suggestionId))
        .limit(1)
      if (!exists) throw new MemoryError(404, '整理建议不存在')
      throw new MemoryError(409, '该整理建议已处理过')
    }
  }

  async planCapture(
    scope: AccessScope,
    input: CapturePlanRequest,
    options?: PlanCaptureOptions,
  ): Promise<CapturePlanResponse> {
    return planQuickCapture(this.db, this.masterKey, scope, input, options)
  }

  async previewHygieneSweep() {
    return runHygieneSweepPreview(this.db)
  }

  async applyHygieneSweep(request: { shortIds?: string[] | undefined } = {}) {
    return runHygieneSweepApply(this.db, this.jobs, request)
  }

  async previewSingleTidy(
    shortId: string,
    options?: PreviewSingleTidyOptions,
  ): Promise<SingleTidyPreviewResponse> {
    return runPreviewSingleTidy(this.db, this.masterKey, shortId, options)
  }

  async applySingleTidy(
    scope: AccessScope,
    shortId: string,
    input: SingleTidyApplyRequest,
  ): Promise<SingleTidyApplyResponse> {
    const outcome = await withTx(this.db, async (tx, now) => {
      const existing = await this.findByIdOrTitle(tx, scope, shortId)
      if (!existing) throw new MemoryError(404, '词条不存在或不可见')
      if (existing.kind !== 'entry') {
        throw new MemoryError(400, '会话摘要不支持直接规范整理')
      }
      if (existing.version !== input.expectedVersion) {
        throw new MemoryError(
          409,
          `版本冲突：当前版本为 ${existing.version}，请重新生成规范预览后再应用`,
          'version_conflict',
        )
      }

      const nextTitle = deriveEntryTitle(input.title, input.content, existing.shortId)
      const nextSummary = cleanOptionalText(input.summary)
      const nextContent = input.content
      const nextTopics =
        input.topics !== undefined ? normalizeSlugList(input.topics) : existing.topics
      const nextDisclosure =
        input.disclosure !== undefined ? cleanOptionalText(input.disclosure) : existing.disclosure
      const changeSummary =
        cleanOptionalText(input.changeSummary) ?? '主动规范标题与结构并归档历史说明'
      const archivedNotes = input.archivedNotes ?? []

      const existingTopicsNorm = normalizeSlugList(existing.topics)
      const topicsChanged =
        nextTopics.length !== existingTopicsNorm.length ||
        nextTopics.some((v, i) => v !== existingTopicsNorm[i])
      const stagedTopics = topicsChanged ? nextTopics : null
      const stagedDisclosure = nextDisclosure !== existing.disclosure ? nextDisclosure : null

      if (input.stageToInbox) {
        // 复用标准 tidy 指纹并支持同版本重复暂存平滑覆盖，避免唯一键冲突或与批量规范重复入队
        const fingerprint = suggestionFingerprint('tidy', [existing.id], [existing.version])
        const stagedReason = cleanOptionalText(input.reason) ?? '由编辑页主动规范暂存至整理'
        const [staged] = await tx
          .insert(dreamSuggestions)
          .values({
            kind: 'tidy',
            entryIds: [existing.id],
            entryVersions: [existing.version],
            keepId: null,
            proposedTitle: nextTitle,
            proposedSummary: nextSummary,
            proposedContent: nextContent,
            proposedDisclosure: stagedDisclosure,
            proposedChangeSummary: changeSummary,
            archivedNotes: archivedNotes.length ? archivedNotes : null,
            proposedTopics: stagedTopics,
            proposedEnvs: null,
            proposedRealms: null,
            proposedProjects: null,
            proposedRuntimes: null,
            proposedLinks: null,
            proposedBootMode: null,
            reason: stagedReason,
            fingerprint,
            status: 'pending',
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: dreamSuggestions.fingerprint,
            set: {
              proposedTitle: nextTitle,
              proposedSummary: nextSummary,
              proposedContent: nextContent,
              proposedDisclosure: stagedDisclosure,
              proposedChangeSummary: changeSummary,
              archivedNotes: archivedNotes.length ? archivedNotes : null,
              proposedTopics: stagedTopics,
              reason: stagedReason,
              status: 'pending',
              decidedAt: null,
              createdAt: now,
            },
          })
          .returning({ id: dreamSuggestions.id })
        return {
          response: {
            stagedSuggestionId: staged!.id,
            entry: null,
          } satisfies SingleTidyApplyResponse,
          embedId: null as string | null,
        }
      }

      const searchTags = buildSearchTags({
        shortId: existing.shortId,
        topics: nextTopics,
        envs: existing.envs,
        realms: existing.realms,
        projects: existing.projects,
        runtimes: existing.runtimes,
      })

      const diffMeta = computeDiffMeta(existing, {
        kind: existing.kind,
        title: nextTitle,
        summary: nextSummary,
        content: nextContent,
        disclosure: nextDisclosure,
        isPinned: existing.isPinned,
        bootMode: existing.bootMode,
        envs: existing.envs,
        realms: existing.realms,
        projects: existing.projects,
        runtimes: existing.runtimes,
        topics: nextTopics,
        validTo: existing.validTo,
      })

      if (input.applyArchivedNotes !== false && archivedNotes.length) {
        const beforeSnap = toSnapshot(existing)
        for (const item of archivedNotes) {
          const noteText = item.note.trim()
          if (!noteText) continue
          const occurredAt = item.occurredAt ? new Date(item.occurredAt) : null
          await tx.insert(entryEvents).values({
            entryId: existing.id,
            eventType: 'archive_note',
            actor: actorLabel(scope),
            changeSummary: noteText,
            occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
            snapshot: beforeSnap,
            createdAt: now,
          })
        }
      }

      const [updated] = await tx
        .update(entries)
        .set({
          title: nextTitle,
          summary: nextSummary,
          content: nextContent,
          disclosure: nextDisclosure,
          topics: nextTopics,
          searchTags,
          lastChangeSummary: changeSummary,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(and(eq(entries.id, existing.id), eq(entries.version, existing.version)))
        .returning()
      if (!updated) {
        throw new MemoryError(409, '版本冲突：词条已被并发修改，请刷新后再试', 'version_conflict')
      }

      await syncEntryLinks(tx, updated.id, updated.shortId, updated.content)
      await tx.insert(entryEvents).values({
        entryId: updated.id,
        eventType: 'update',
        actor: actorLabel(scope),
        changeSummary,
        diffMeta,
        snapshot: toSnapshot(updated),
        createdAt: now,
      })

      const detail = await this.hydrateDetail(tx, scope, updated)
      return {
        response: { stagedSuggestionId: null, entry: detail } satisfies SingleTidyApplyResponse,
        embedId: updated.id,
      }
    })

    if (outcome.embedId) this.jobs?.enqueueEmbed(outcome.embedId)
    return outcome.response
  }

  async crossCheckEntry(
    shortId: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<SingleCrossCheckResponse> {
    return runSingleCrossCheck(this.db, this.masterKey, shortId, options)
  }

  async previewBoot(input: BootPreviewRequest): Promise<BootPreviewResponse> {
    let targetScope: AccessScope = { kind: 'console', accountId: 'preview', sessionId: 'preview' }
    let keyName: string | null = null
    let keyRuntime: string | null = null

    if (input.keyId) {
      const [keyRow] = await this.db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, input.keyId), isNull(apiKeys.revokedAt)))
        .limit(1)
      if (!keyRow) throw new MemoryError(404, '访问密钥不存在或已吊销')
      const principal: KeyPrincipal = {
        kind: 'key',
        keyId: keyRow.id,
        name: keyRow.name,
        prefix: keyRow.prefix,
        runtimeFamily: keyRow.runtimeFamily,
        envs: keyRow.envs,
        allowedRealms: keyRow.allowedRealms,
        focusRealms: keyRow.focusRealms,
        canWrite: keyRow.canWrite,
        canResolveCredentials: keyRow.canResolveCredentials,
      }
      targetScope = principal
      keyName = keyRow.name
      keyRuntime = keyRow.runtimeFamily
    }

    const focus = synthesizeFocus(targetScope, {
      project: input.project,
      runtime: input.runtime,
      env: input.env,
      realm: input.realm,
    })
    const effectiveRuntime = input.runtime ?? keyRuntime
    const hostLimit =
      (effectiveRuntime ? HOST_CONTEXT_LIMIT[effectiveRuntime] : undefined) ??
      (keyRuntime ? HOST_CONTEXT_LIMIT[keyRuntime] : undefined) ??
      null
    const fullBudget = Math.min(
      BOOT_CHAR_BUDGET,
      hostLimit ? Math.max(hostLimit - GUIDANCE.length - CONTEXT_RESERVE, 1_000) : BOOT_CHAR_BUDGET,
    )

    const detailed = await compileBootDetailed(this.db, targetScope, {
      focus,
      budget: fullBudget,
      catalogBudget: BOOT_CATALOG_BUDGET,
    })
    const effectiveCatalogBudget = computeEffectiveCatalogBudget(
      hostLimit,
      GUIDANCE.length,
      detailed.usedFullChars,
    )
    const { usedChars: usedCatalogChars } = selectCatalogLines(
      detailed.boot.omitted,
      detailed.boot.omittedItems,
      effectiveCatalogBudget,
    )
    const rendered = formatBootBlock(detailed.boot, GUIDANCE, {
      catalogBudget: effectiveCatalogBudget,
    })

    return {
      keyName,
      runtimeFamily: effectiveRuntime,
      focus,
      fullBudget: detailed.fullBudget,
      catalogBudget: effectiveCatalogBudget,
      hostLimit,
      usedFullChars: detailed.usedFullChars,
      usedCatalogChars,
      globalUsedChars: detailed.globalUsedChars,
      globalCapChars: detailed.globalCapChars,
      totalRenderedChars: rendered.length,
      expanded: detailed.expanded,
      indexed: detailed.indexed,
      demoted: detailed.demoted,
      excluded: detailed.excluded,
    }
  }
}
