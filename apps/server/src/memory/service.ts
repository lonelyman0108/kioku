import {
  buildSearchTags,
  deriveEntryTitle,
  normalizeSlugList,
  type ApplySuggestionRequest,
  type ApplySuggestionResponse,
  type BrowseEntriesQuery,
  type CreateEntryRequest,
  type EntryBrowseGroup,
  type EntryBrowseItem,
  type EntryBrowseResponse,
  type EntryDetailResponse,
  type EntryFacetsSummary,
  type EntryHistoryItem,
  type EntryHistoryResponse,
  type EntryListItem,
  type EntryListQuery,
  type EntryListResponse,
  type EntrySnapshot,
  type EntryTabCounts,
  type EntryView,
  type RestoreEntryRequest,
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
import { dreamSuggestions, entries, entryEmbeddings, entryEvents } from '../db/schema'
import type { Jobs } from '../jobs/queue'
import { recallEntries } from '../recall/recall'
import { MemoryError } from './errors'
import { loadEntryLinks, syncEntryLinks } from './links'
import { insertWithAllocatedShortId, parseShortId } from './shortId'

type EntryRow = typeof entries.$inferSelect

const VALID_TO_MIN_AHEAD_MS = 60_000
const HISTORY_LIMIT = 200
const EPISODE_TTL_DAYS = 14

function toEntryView(row: EntryRow): EntryView {
  return {
    id: row.id,
    shortId: row.shortId,
    kind: row.kind,
    title: row.title,
    content: row.content,
    disclosure: row.disclosure,
    isPinned: row.isPinned,
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
    deviceKey: row.deviceKey,
    projectSlug: row.projectSlug,
    validTo: row.validTo ? row.validTo.toISOString() : null,
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
    disclosure: row.disclosure,
    isPinned: row.isPinned,
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
    validTo: row.validTo ? row.validTo.toISOString() : null,
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
    content: row.content,
    disclosure: row.disclosure,
    isPinned: row.isPinned,
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
    validTo: row.validTo ? row.validTo.toISOString() : null,
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

export class EntryService {
  constructor(
    private readonly db: Db,
    private readonly masterKey: MasterKey | null,
    private readonly credentials: CredentialService,
    private readonly jobs: Jobs | null,
  ) {}

  private async hydrateDetail(
    tx: Db | Tx,
    scope: AccessScope,
    row: EntryRow,
  ): Promise<EntryDetailResponse> {
    const [{ outboundLinks, backlinks }, credentialRefs] = await Promise.all([
      loadEntryLinks(tx, scope, row.id, row.shortId),
      this.credentials.placeholderStatuses(tx, scope, row.content),
    ])
    return {
      entry: toEntryView(row),
      outboundLinks,
      backlinks,
      credentialRefs,
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
    assertEntryWriteAllowed(scope, input.realms)
    const detail = await withTx(this.db, async (tx, now) => {
      const validTo = parseValidTo(input.validTo, now)
      const { value: row } = await insertWithAllocatedShortId(tx, async (sp, shortId) => {
        const title = deriveEntryTitle(input.title, input.content, shortId)
        const searchTags = buildSearchTags({
          shortId,
          topics: input.topics,
          envs: input.envs,
          realms: input.realms,
          projects: input.projects,
          runtimes: input.runtimes,
        })
        const [inserted] = await sp
          .insert(entries)
          .values({
            shortId,
            kind: 'entry',
            title,
            content: input.content,
            disclosure: input.disclosure ?? null,
            isPinned: input.isPinned,
            envs: input.envs,
            realms: input.realms,
            projects: input.projects,
            runtimes: input.runtimes,
            topics: input.topics,
            searchTags,
            validTo,
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
        snapshot: toSnapshot(row),
        createdAt: now,
      })
      return this.hydrateDetail(tx, scope, row)
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
      if (nextKind === 'episode' && input.isPinned === true) {
        throw new MemoryError(400, '会话摘要不能直接标为常驻，请先提炼为正式记忆')
      }
      const nextContent = input.content ?? existing.content
      const nextTitle =
        input.title !== undefined
          ? deriveEntryTitle(input.title, nextContent, existing.shortId)
          : existing.title
      const nextDisclosure = input.disclosure !== undefined ? input.disclosure : existing.disclosure
      const nextIsPinned = nextKind === 'episode' ? false : (input.isPinned ?? existing.isPinned)
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

      const [updated] = await tx
        .update(entries)
        .set({
          kind: nextKind,
          title: nextTitle,
          content: nextContent,
          disclosure: nextDisclosure,
          isPinned: nextIsPinned,
          envs: nextEnvs,
          realms: nextRealms,
          projects: nextProjects,
          runtimes: nextRuntimes,
          topics: nextTopics,
          deviceKey: nextDeviceKey,
          projectSlug: nextProjectSlug,
          searchTags,
          validTo: nextValidTo,
          version: nextVersion,
          updatedAt: now,
        })
        .where(and(eq(entries.id, existing.id), eq(entries.version, existing.version)))
        .returning()
      if (!updated) {
        throw new MemoryError(409, '版本冲突：词条已被并发修改，请刷新后再保存', 'version_conflict')
      }

      await syncEntryLinks(tx, updated.id, updated.shortId, updated.content)
      await tx.insert(entryEvents).values({
        entryId: updated.id,
        eventType: 'update',
        actor: actorLabel(scope),
        snapshot: toSnapshot(updated),
        createdAt: now,
      })
      return this.hydrateDetail(tx, scope, updated)
    })

    if (detail.entry.kind === 'entry') {
      this.jobs?.enqueueEmbed(detail.entry.id)
    }
    return detail
  }

  async remove(
    scope: AccessScope,
    idOrShortId: string,
    options: { expectedVersion?: number; permanent?: boolean } = {},
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

      const [deleted] = await tx
        .update(entries)
        .set({
          deletedAt: now,
          updatedAt: now,
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

      if (input.version === undefined) {
        if (!existing.deletedAt) throw new MemoryError(409, '该词条未在回收站中')
        const [restored] = await tx
          .update(entries)
          .set({
            deletedAt: null,
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(eq(entries.id, existing.id))
          .returning()
        await tx.insert(entryEvents).values({
          entryId: restored!.id,
          eventType: 'undelete',
          actor: actorLabel(scope),
          snapshot: toSnapshot(restored!),
          createdAt: now,
        })
        return this.hydrateDetail(tx, scope, restored!)
      }

      const historyRows = await tx
        .select()
        .from(entryEvents)
        .where(eq(entryEvents.entryId, existing.id))
        .orderBy(desc(entryEvents.id))
      const targetEvent = historyRows.find((ev) => ev.snapshot.version === input.version)
      if (!targetEvent) throw new MemoryError(404, `未找到版本 ${input.version} 的历史记录`)
      const snap = targetEvent.snapshot

      const nextKind = snap.kind
      const nextIsPinned = nextKind === 'episode' ? false : snap.isPinned
      const searchTags = buildSearchTags({
        shortId: existing.shortId,
        topics: snap.topics,
        envs: snap.envs,
        realms: snap.realms,
        projects: snap.projects,
        runtimes: snap.runtimes,
      })
      const [restored] = await tx
        .update(entries)
        .set({
          kind: nextKind,
          title: snap.title,
          content: snap.content,
          disclosure: snap.disclosure,
          isPinned: nextIsPinned,
          envs: snap.envs,
          realms: snap.realms,
          projects: snap.projects,
          runtimes: snap.runtimes,
          topics: snap.topics,
          searchTags,
          validTo: snap.validTo ? new Date(snap.validTo) : null,
          deletedAt: null,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(eq(entries.id, existing.id))
        .returning()

      await syncEntryLinks(tx, restored!.id, restored!.shortId, restored!.content)
      await tx.insert(entryEvents).values({
        entryId: restored!.id,
        eventType: 'restore',
        actor: actorLabel(scope),
        snapshot: toSnapshot(restored!),
        createdAt: now,
      })
      return this.hydrateDetail(tx, scope, restored!)
    })

    if (detail.entry.kind === 'entry') {
      this.jobs?.enqueueEmbed(detail.entry.id)
    }
    return detail
  }

  async history(shortId: string): Promise<EntryHistoryResponse> {
    const parsed = parseShortId(shortId)
    if (!parsed) throw new MemoryError(400, '短 ID 格式不正确')
    const [entry] = await this.db
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.shortId, parsed))
      .limit(1)
    if (!entry) throw new MemoryError(404, '词条不存在')

    const rows = await this.db
      .select()
      .from(entryEvents)
      .where(eq(entryEvents.entryId, entry.id))
      .orderBy(desc(entryEvents.id))
      .limit(HISTORY_LIMIT)

    const items: EntryHistoryItem[] = rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      actor: r.actor,
      snapshot: r.snapshot,
      createdAt: r.createdAt.toISOString(),
    }))
    return { items }
  }

  private async loadCountsAndFacets(): Promise<{
    counts: EntryTabCounts
    facets: EntryFacetsSummary
  }> {
    const [countRow] = await this.db
      .select({
        all: sql<number>`count(*) filter (where ${entries.kind} = 'entry' and ${entries.deletedAt} is null)::int`,
        pinned: sql<number>`count(*) filter (where ${entries.kind} = 'entry' and ${entries.isPinned} = true and ${entries.deletedAt} is null)::int`,
        episodes: sql<number>`count(*) filter (where ${entries.kind} = 'episode' and ${entries.deletedAt} is null)::int`,
        trash: sql<number>`count(*) filter (where ${entries.deletedAt} is not null)::int`,
      })
      .from(entries)

    const [facetRow] = await this.db.execute<{
      projects: string[] | null
      envs: string[] | null
      realms: string[] | null
      topics: string[] | null
    }>(sql`
      select
        (select array_agg(distinct v order by v) from entries, unnest(projects) v where deleted_at is null) as projects,
        (select array_agg(distinct v order by v) from entries, unnest(envs) v where deleted_at is null) as envs,
        (select array_agg(distinct v order by v) from entries, unnest(realms) v where deleted_at is null) as realms,
        (select array_agg(distinct v order by v) from entries, unnest(topics) v where deleted_at is null) as topics
    `)

    return {
      counts: {
        all: countRow?.all ?? 0,
        pinned: countRow?.pinned ?? 0,
        episodes: countRow?.episodes ?? 0,
        trash: countRow?.trash ?? 0,
      },
      facets: {
        projects: facetRow?.projects ?? [],
        envs: facetRow?.envs ?? [],
        realms: facetRow?.realms ?? [],
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

    const q = query.q?.trim() ?? ''
    if (q && query.tab !== 'trash' && query.tab !== 'episodes') {
      const focus = synthesizeFocus(scope, {
        env: query.env,
        realm: query.realm,
        project: query.project,
        runtime: query.runtime,
      })
      const recalled = await recallEntries(this.db, this.masterKey, scope, q, {
        focus,
        limit: query.limit,
        minScore: 0.1,
      })
      const like = `%${escapeLike(q)}%`
      const directRows = await this.db
        .select()
        .from(entries)
        .where(
          and(
            isNull(entries.deletedAt),
            eq(entries.kind, 'entry'),
            query.tab === 'pinned' ? eq(entries.isPinned, true) : undefined,
            ...filters,
            or(
              ilike(entries.shortId, like),
              ilike(entries.title, like),
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
                query.tab === 'pinned' ? eq(entries.isPinned, true) : undefined,
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

      return {
        items: items.slice(0, query.limit),
        nextCursor: null,
        facets,
        counts,
      }
    }

    if (query.tab === 'trash') {
      filters.push(isNotNull(entries.deletedAt))
    } else if (query.tab === 'episodes') {
      filters.push(isNull(entries.deletedAt), eq(entries.kind, 'episode'))
    } else if (query.tab === 'pinned') {
      filters.push(isNull(entries.deletedAt), eq(entries.kind, 'entry'), eq(entries.isPinned, true))
    } else {
      filters.push(isNull(entries.deletedAt), eq(entries.kind, 'entry'))
    }

    if (q) {
      const like = `%${escapeLike(q)}%`
      filters.push(
        or(ilike(entries.shortId, like), ilike(entries.title, like), ilike(entries.content, like))!,
      )
    }

    const decoded = decodeTimeCursor(query.cursor, UUID)
    if (decoded === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
    const timeCol = query.tab === 'trash' ? entries.deletedAt : entries.updatedAt
    if (decoded) {
      const [cursorMicros, cursorId] = decoded
      const cursorTs = fromMicros(cursorMicros)
      filters.push(or(lt(timeCol, cursorTs), and(eq(timeCol, cursorTs), lt(entries.id, cursorId)))!)
    }

    const rows = await this.db
      .select({
        row: entries,
        micros: microsOf(timeCol).mapWith(String),
      })
      .from(entries)
      .where(and(...filters))
      .orderBy(desc(timeCol), desc(entries.id))
      .limit(query.limit + 1)

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      items: page.map((item) => toListItem(item.row)),
      nextCursor: hasMore && last ? encodeTimeCursor(last.micros, last.row.id) : null,
      facets,
      counts,
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
        kind: row.kind,
        isPinned: row.isPinned,
        topics: row.topics,
        envs: row.envs,
        realms: row.realms,
        projects: row.projects,
        runtimes: row.runtimes,
        disclosure: row.disclosure,
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
            content: input.content,
            disclosure: null,
            isPinned: false,
            envs,
            realms,
            projects,
            runtimes: [],
            topics: [],
            deviceKey,
            projectSlug,
            searchTags,
            validTo,
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
        snapshot: toSnapshot(inserted),
        createdAt: now,
      })
      return inserted
    })

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

      let resulting: { id: string; shortId: string; title: string } | null
      let embedId: string | null = null

      if (suggestion.kind === 'distill_episode') {
        const firstSource = byId.get(suggestion.entryIds[0]!)!
        const content = overrides.content ?? suggestion.proposedContent ?? firstSource.content
        const envs = overrides.envs ?? suggestion.proposedEnvs ?? firstSource.envs
        const realms = overrides.realms ?? suggestion.proposedRealms ?? firstSource.realms
        const projects = overrides.projects ?? suggestion.proposedProjects ?? firstSource.projects
        const runtimes = overrides.runtimes ?? suggestion.proposedRuntimes ?? []
        const topics = overrides.topics ?? suggestion.proposedTopics ?? []
        const disclosure =
          overrides.disclosure !== undefined
            ? overrides.disclosure
            : (suggestion.proposedDisclosure ?? null)
        const isPinned = overrides.isPinned ?? false

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
              content,
              disclosure,
              isPinned,
              envs,
              realms,
              projects,
              runtimes,
              topics,
              searchTags,
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
          snapshot: toSnapshot(created),
          createdAt: now,
        })

        for (const source of targetRows) {
          const [removed] = await tx
            .update(entries)
            .set({ deletedAt: now, updatedAt: now, version: source.version + 1 })
            .where(eq(entries.id, source.id))
            .returning()
          await tx.insert(entryEvents).values({
            entryId: source.id,
            eventType: 'delete',
            actor: 'dream',
            snapshot: toSnapshot(removed!),
            createdAt: now,
          })
        }

        resulting = { id: created.id, shortId: created.shortId, title: created.title }
        embedId = created.id
      } else if (suggestion.kind === 'merge_duplicates') {
        const keepId =
          suggestion.keepId && byId.has(suggestion.keepId)
            ? suggestion.keepId
            : suggestion.entryIds[0]!
        const keep = byId.get(keepId)!
        const content = overrides.content ?? suggestion.proposedContent ?? keep.content
        const title = deriveEntryTitle(
          overrides.title ?? suggestion.proposedTitle ?? keep.title,
          content,
          keep.shortId,
        )
        const disclosure =
          overrides.disclosure !== undefined
            ? overrides.disclosure
            : (suggestion.proposedDisclosure ?? keep.disclosure)
        const topics = overrides.topics ?? suggestion.proposedTopics ?? keep.topics
        const envs = overrides.envs ?? suggestion.proposedEnvs ?? keep.envs
        const realms = overrides.realms ?? suggestion.proposedRealms ?? keep.realms
        const projects = overrides.projects ?? suggestion.proposedProjects ?? keep.projects
        const runtimes = overrides.runtimes ?? suggestion.proposedRuntimes ?? keep.runtimes
        const isPinned = overrides.isPinned ?? keep.isPinned
        const searchTags = buildSearchTags({
          shortId: keep.shortId,
          topics,
          envs,
          realms,
          projects,
          runtimes,
        })

        const [updated] = await tx
          .update(entries)
          .set({
            title,
            content,
            disclosure,
            topics,
            envs,
            realms,
            projects,
            runtimes,
            isPinned,
            searchTags,
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
          snapshot: toSnapshot(updated!),
          createdAt: now,
        })

        for (const other of targetRows) {
          if (other.id === keep.id) continue
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
            snapshot: toSnapshot(removed!),
            createdAt: now,
          })
        }

        resulting = { id: updated!.id, shortId: updated!.shortId, title: updated!.title }
        embedId = updated!.id
      } else if (suggestion.kind === 'mark_stale') {
        const target = byId.get(suggestion.entryIds[0]!)!
        const [removed] = await tx
          .update(entries)
          .set({ deletedAt: now, updatedAt: now, version: target.version + 1 })
          .where(eq(entries.id, target.id))
          .returning()
        await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, target.id))
        await tx.insert(entryEvents).values({
          entryId: target.id,
          eventType: 'delete',
          actor: 'dream',
          snapshot: toSnapshot(removed!),
          createdAt: now,
        })
        resulting = null
      } else {
        const target = byId.get(suggestion.entryIds[0]!)!
        const content = overrides.content ?? suggestion.proposedContent ?? target.content
        const title = deriveEntryTitle(
          overrides.title ?? suggestion.proposedTitle ?? target.title,
          content,
          target.shortId,
        )
        const disclosure =
          overrides.disclosure !== undefined
            ? overrides.disclosure
            : (suggestion.proposedDisclosure ?? target.disclosure)
        const topics = overrides.topics ?? suggestion.proposedTopics ?? target.topics
        const envs = overrides.envs ?? suggestion.proposedEnvs ?? target.envs
        const realms = overrides.realms ?? suggestion.proposedRealms ?? target.realms
        const projects = overrides.projects ?? suggestion.proposedProjects ?? target.projects
        const runtimes = overrides.runtimes ?? suggestion.proposedRuntimes ?? target.runtimes
        const isPinned = target.kind === 'episode' ? false : (overrides.isPinned ?? target.isPinned)
        const searchTags = buildSearchTags({
          shortId: target.shortId,
          topics,
          envs,
          realms,
          projects,
          runtimes,
        })

        const [updated] = await tx
          .update(entries)
          .set({
            title,
            content,
            disclosure,
            topics,
            envs,
            realms,
            projects,
            runtimes,
            isPinned,
            searchTags,
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
          snapshot: toSnapshot(updated!),
          createdAt: now,
        })

        resulting = { id: updated!.id, shortId: updated!.shortId, title: updated!.title }
        embedId = updated!.kind === 'entry' ? updated!.id : null
      }

      await tx
        .update(dreamSuggestions)
        .set({ status: 'applied', decidedAt: now })
        .where(eq(dreamSuggestions.id, suggestion.id))

      return { response: { entry: resulting }, embedId }
    })

    if (result.embedId) {
      this.jobs?.enqueueEmbed(result.embedId)
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
}
