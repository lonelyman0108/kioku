import type { z } from 'zod'

import { createHash, randomUUID } from 'node:crypto'

import {
  ActivityFieldFilter,
  ActivityType,
  addedSensitiveContent,
  CONVERT_SCOPE_TEXT,
  DEFAULT_SENSITIVITY,
  deriveEntryTitle,
  ENTRY_CONTENT_MAX,
  EntryKind,
  hasHomogeneousRealms,
  isProtectedPersonalEntry,
  markdownHeadingsOf,
  maskSensitiveContent,
  needsSensitiveInboxAlert,
  normalizeWhen,
  PLAINTEXT_KIND_NAMES,
  PLAINTEXT_MASK,
  sensitivityAllowed,
  VARIANTS_MAX,
  whenSignature,
} from '@kioku/contracts'
import type {
  ActivityDays,
  ActivityDaysQuery,
  ActivityEvent,
  ActivityFacets,
  ActivityFilter,
  ActivityItem,
  ActivityList,
  BenchChanges,
  BenchMark,
  BrowseEntriesQuery,
  CircleKind,
  ConsoleCreateEntryRequest,
  ConsoleEntryView,
  ConsoleTransferEntryRequest,
  ConsoleUpdateEntryRequest,
  ConvertToCredentialRequest,
  CreateEntryRequest,
  CredentialStoredIn,
  DeletedEntryList,
  EntryBrowseGroup,
  EntryBrowseItem,
  EntryBrowseResponse,
  EntryHistory,
  EntryList,
  EntryListQuery,
  EntryMatch,
  EntrySnapshot,
  EntryVariantView,
  EntryView,
  ExpiredEntryList,
  GlossaryIndex,
  KindCount,
  OtherVariantHint,
  PlaintextFinding,
  PlaintextIgnoreRequest,
  PlaintextKind,
  ProtectEntryRequest,
  Provenance,
  ReactivateRequest,
  RedactEntryRequest,
  RestoreRequest,
  ReviewList,
  ReviewQuery,
  ReviewRequest,
  ReviewResult,
  Sensitivity,
  StoredSensitiveFinding,
  SubjectKind,
  TransferEntryRequest,
  UndeleteRequest,
  UpdateEntryRequest,
  VariantInput,
  WhenCondition,
} from '@kioku/contracts'
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'

import {
  canModify,
  canRead,
  canUseCredential,
  canWrite,
  lapsed,
  type Access,
  type EntryFacts,
} from '../access/access'
import { checkStaticRealmLock, normalizeRealms } from '../access/realms'
import {
  placeholderAllowed,
  placeholderIdentifiers,
  replaceOutsidePlaceholders,
  scanPlaceholders,
  type PlaceholderRef,
} from '../credential/placeholders'
import {
  detectWithPrivacyModel,
  evaluateSensitiveContent,
  loadCirclePrivacy,
  loadPrivacyModelConfig,
  type ModelEntitySpan,
} from '../credential/privacy'
import { decryptSecret, encryptSecret } from '../crypto/envelope'
import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'
import { isUniqueViolation, withCircle, withCircles, type Tx } from '../db/client'
import {
  decodeTimeCursor,
  encodeTimeCursor,
  escapeLike,
  fromMicros,
  INVALID_CURSOR,
  microsOf,
  parseCursor,
  UUID,
} from '../db/paging'
import {
  accounts,
  apiKeys,
  circleMembers,
  circles,
  clients,
  credentials,
  dreamSuggestions,
  entries,
  entryCredentialRefs,
  entryEmbeddings,
  entryEvents,
  entryGlossary,
  entryLinks,
  entryRecallStats,
  entryVariants,
  legacyUris,
  subjects,
} from '../db/schema'
import { countEmbeddable } from '../embedding/coverage'
import { loadEmbeddingModels } from '../embedding/settings'
import { loadRecallWindow } from '../recall/retention'
import {
  ACTOR_KEY,
  changedFields,
  changedFieldsSql,
  fieldChanges,
  knownTimeZone,
  text as snapshotText,
} from './activity'
import type { EntryContext } from './entryContext'
import { MemoryError, UnknownTimeZoneError, versionConflict } from './errors'
import {
  BOOT_CANDIDATE,
  momentSql,
  pendingReview,
  readableConditions,
  snapshotColumns,
  snapshotFacts,
  stillValid,
} from './filter'
import { evaluateVariantFocus, loadCircleVocabularies } from './facets'
import { resolveEntryNeighbors, syncEntryLinks, visibleCircleSlug } from './links'
import { hasMaskedText } from './masked'
import { kindWithValue, sensitivityWithValue } from './names'
import { scopeNames } from './scopes'
import { insertWithAllocatedShortId, normalizeShortId } from './shortId'

export { MemoryError, UnknownTimeZoneError, versionConflict } from './errors'
export type { EntryContext } from './entryContext'

export type SecretVia =
  | 'console'
  | 'export'
  | 'rest'
  | 'kioku_get'
  | 'kioku_list'
  | 'kioku_browse'
  | 'kioku_update'
  | 'kioku_transfer'

export const UNTOUCHED_PLAINTEXT = Symbol('untouched plaintext')

export type EventChanges = Pick<BenchChanges, 'entries' | 'hiddenOther'> & { lastId: number }

export const ACCESS_EVENT = 'access' as const
const VALID_TO_MIN_AHEAD_MS = 60_000
const HISTORY_LIMIT = 500
const ACCESS_HISTORY_LIMIT = 100
const GLOSSARY_CAP = 500
const SHORT_ID_CURSOR = /^m-[0-9a-z]{6,8}$/
const EVENT_ID = /^\d{1,15}$/
const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647
// drizzle 遇到数字 0 不生成 offset，写成 SQL 防止 PostgreSQL 展开子查询导致重复计算可见性
const OFFSET_ZERO = sql`0` as unknown as number

const detoasted = (snapshot: SQLWrapper) =>
  sql<unknown>`(case when jsonb_typeof(${snapshot}) = 'object' then ${snapshot} || '{}'::jsonb else ${snapshot} end)`.mapWith(
    entryEvents.before,
  )

function fieldCondition(fields: SQL<string[]>, wanted: readonly ActivityFieldFilter[]): SQL {
  const named = wanted.filter((f) => f !== 'none')
  const list = sql.join(
    named.map((f) => sql`${f}::text`),
    sql`, `,
  )
  return or(
    named.length ? sql`(${fields} && array[${list}]::text[])` : undefined,
    wanted.includes('none') ? sql`(cardinality(${fields}) = 0)` : undefined,
  )!
}

type FacetRow = { g: string; k: string | null; n: number }
function sortByCount<T extends { count: number }>(items: T[]): T[] {
  return items.sort((a, b) => b.count - a.count)
}

const IGNORED_NOW = sql`(case when ${entryVariants.plaintextIgnoredHash} is null then false
  else ${entryVariants.plaintextIgnoredHash} = encode(sha256(convert_to(${entryVariants.content}, 'UTF8')), 'hex') end)`

const NEEDS_DISCLOSURE = sql`(${entries.kind} = 'entry' and (${entries.disclosure} is null or btrim(${entries.disclosure}) = '') and not (${BOOT_CANDIDATE}))`

export interface EntryStats {
  counts: KindCount[]
  total: number
  extractedCounts: KindCount[]
  missingDisclosure: number
  plaintextCredentials: number
  neverRecalled: number
  eligible: number
  embedded: number
}

export const variantAad = (variantId: string): string => `variant:${variantId}`

export function sealVariantContent(
  masterKey: MasterKey,
  variantId: string,
  plaintext: string,
): { ciphertext: Buffer; wrappedKey: Buffer; keyId: string } {
  const { key, id: keyId } = encryptionKey(masterKey)
  return { ...encryptSecret(key, plaintext, variantAad(variantId)), keyId }
}

export function openVariantContent(
  masterKey: MasterKey,
  variantId: string,
  row: { ciphertext: Buffer | null; wrappedKey: Buffer | null; keyId: string | null },
): string {
  if (!row.ciphertext || !row.wrappedKey) {
    throw new MemoryError(500, '机密切片的密文不完整，无法解密')
  }
  return decryptSecret(
    decryptionKey(masterKey, row.keyId),
    { ciphertext: row.ciphertext, wrappedKey: row.wrappedKey },
    variantAad(variantId),
  )
}

export type PlaintextFlags = Pick<UpdateEntryRequest, 'plaintextOk'> &
  Pick<ConsoleUpdateEntryRequest, 'ignorePlaintext' | 'allowPlaintext'>

export type CreateInput = (
  z.input<typeof CreateEntryRequest> | z.input<typeof ConsoleCreateEntryRequest>
) &
  PlaintextFlags
export type UpdateInput = (
  z.input<typeof UpdateEntryRequest> | z.input<typeof ConsoleUpdateEntryRequest>
) &
  PlaintextFlags

export type EntryRow = typeof entries.$inferSelect
export type VariantRow = typeof entryVariants.$inferSelect

export type ExtractedWrite =
  | {
      kind: 'fact'
      subjectId: string
      subjectKind: SubjectKind
      originScope: string
      content: string
      when?: WhenCondition
      replaces?: { id: string; version: number } | undefined
    }
  | {
      kind: 'episode'
      originScope: string
      content: string
      ttlDays: number
      ownerAccountId: string | null
    }

export type SuggestionAction =
  | { kind: 'merge'; keepId: string; content: string }
  | { kind: 'merge_variants'; keepId: string; variants: VariantInput[] }
  | { kind: 'facet_tag'; targetId: string; when: WhenCondition }
  | { kind: 'generalize'; targetId: string; variants: VariantInput[] }
  | {
      kind: 'distill' | 'distill_episode'
      draft: {
        title?: string
        content?: string
        variants?: VariantInput[]
        when?: WhenCondition
        topics?: string[]
        disclosure: string | null
        priority?: number
      }
    }
  | { kind: 'stale' }
  | { kind: 'review'; verdict: 'confirm' | 'delete' }
  | { kind: 'promote'; priority: number }

export interface LockedSuggestion {
  entries: { id: string; version: number }[]
  pending: boolean
  action: (sources: readonly (EntryRow & { primaryContent: string | null })[]) => SuggestionAction
}

function contentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function buildSearchHeader(input: {
  sensitivity: Sensitivity
  title: string
  topics: readonly string[]
  disclosure: string | null
  glossary: readonly string[]
}): string {
  if (input.sensitivity === 'secret') return ''
  return [
    input.title,
    ...input.topics,
    ...(input.disclosure ? [input.disclosure] : []),
    ...input.glossary,
  ]
    .filter(Boolean)
    .join(' ')
}

function sameValidTo(raw: string | null, stored: Date | null): boolean {
  if (raw === null || stored === null) return raw === null && stored === null
  return new Date(raw).getTime() === stored.getTime()
}

function updatedAtFor(at: Date): SQL {
  return sql`greatest(${momentSql(at)}, ${entries.updatedAt})`
}

function parseValidTo(
  raw: string | null | undefined,
  now: Date,
  validFrom?: Date,
): Date | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw new MemoryError(400, '有效到（validTo）的日期格式不对')
  }
  if (
    date.getTime() < now.getTime() + VALID_TO_MIN_AHEAD_MS ||
    (validFrom !== undefined && date.getTime() <= validFrom.getTime())
  ) {
    throw new MemoryError(400, '有效到（validTo）要比当前时间至少晚一分钟')
  }
  return date
}

function cleanTopics(topics: readonly string[] | undefined): string[] {
  if (!topics) return []
  return [...new Set(topics.map((t) => t.trim().toLowerCase()).filter(Boolean))]
}

function cleanGlossary(keywords: readonly string[] | undefined): string[] {
  if (!keywords) return []
  return [...new Set(keywords.map((k) => k.trim()).filter(Boolean))]
}

export function variantIgnoredNow(
  v: Pick<VariantRow, 'content' | 'plaintextIgnoredHash'>,
): boolean {
  return Boolean(
    v.plaintextIgnoredHash !== null &&
    v.content !== null &&
    v.plaintextIgnoredHash === contentDigest(v.content),
  )
}

export function plaintextMatch(
  circleKind: string,
  row: Pick<EntryRow, 'sensitivity' | 'provenance'>,
  variants: readonly Pick<
    VariantRow,
    'content' | 'plaintextIgnoredHash' | 'sensitiveCredential' | 'sensitivePii'
  >[],
): boolean {
  return variants.some((v) =>
    needsSensitiveInboxAlert({
      circleKind,
      sensitivity: row.sensitivity,
      provenance: row.provenance,
      sensitiveCredential: v.sensitiveCredential,
      sensitivePii: v.sensitivePii,
      plaintextIgnored: variantIgnoredNow(v),
    }),
  )
}

export function hasUntouchedPlaintext(view: EntryView | ConsoleEntryView): boolean {
  return Boolean((view as { [UNTOUCHED_PLAINTEXT]?: boolean })[UNTOUCHED_PLAINTEXT])
}

// 计算快照 jsonb：保留契约 EntrySnapshot 字段并附带 snapshotColumns / retention 所需头字段
export interface StoredEntrySnapshot extends EntrySnapshot {
  circleId: string
  originScope: string
  clientId: string | null
  ownerAccountId: string | null
  subjectKind: string | null
  deletedAt: string | null
  expiresAt: string | null
}

function toStoredSnapshot(
  entry: EntryRow,
  variants: readonly { when: WhenCondition; content: string | null }[],
  glossary: readonly string[],
): StoredEntrySnapshot {
  const secret = entry.sensitivity === 'secret'
  return {
    shortId: entry.shortId,
    title: entry.title,
    kind: entry.kind,
    sensitivity: entry.sensitivity,
    priority: entry.priority,
    disclosure: entry.disclosure,
    topics: [...entry.topics],
    realms: [...entry.realms],
    glossary: [...glossary],
    variants: variants.map((v) => ({
      when: normalizeWhen(v.when),
      content: secret ? null : v.content,
    })),
    version: entry.version,
    deleted: entry.deletedAt !== null,
    validTo: entry.validTo ? entry.validTo.toISOString() : null,
    circleId: entry.circleId,
    originScope: entry.originScope,
    clientId: entry.clientId,
    ownerAccountId: entry.ownerAccountId,
    subjectKind: entry.subjectKind,
    deletedAt: entry.deletedAt ? entry.deletedAt.toISOString() : null,
    expiresAt: entry.expiresAt ? entry.expiresAt.toISOString() : null,
  }
}

function toPublicSnapshot(raw: Record<string, unknown> | null): EntrySnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const sensitivity = (
    typeof raw.sensitivity === 'string' ? raw.sensitivity : 'internal'
  ) as Sensitivity
  const secret = sensitivity === 'secret'
  const rawVariants = Array.isArray(raw.variants)
    ? (raw.variants as Record<string, unknown>[])
        .filter((v) => v && typeof v === 'object')
        .map((v) => ({
          when: normalizeWhen((v.when as Record<string, string[]>) ?? {}),
          content: secret ? null : typeof v.content === 'string' ? v.content : null,
        }))
    : typeof raw.content === 'string'
      ? [{ when: {}, content: secret ? null : raw.content }]
      : []
  const strList = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    shortId: typeof raw.shortId === 'string' ? raw.shortId : 'm-222222',
    title: typeof raw.title === 'string' ? raw.title : null,
    kind: (typeof raw.kind === 'string' ? raw.kind : 'entry') as EntryKind,
    sensitivity,
    priority: typeof raw.priority === 'number' ? raw.priority : 2,
    disclosure: typeof raw.disclosure === 'string' ? raw.disclosure : null,
    topics: strList(raw.topics),
    realms: strList(raw.realms),
    glossary: strList(raw.glossary),
    variants: rawVariants,
    version: typeof raw.version === 'number' ? raw.version : 1,
    deleted: Boolean(raw.deleted ?? raw.deletedAt),
    validTo: typeof raw.validTo === 'string' ? raw.validTo : null,
  }
}

function snapshotPlaintextContents(snap: Record<string, unknown> | null): string[] {
  if (!snap || typeof snap !== 'object') return []
  const out: string[] = []
  if (typeof snap.content === 'string') out.push(snap.content)
  if (Array.isArray(snap.variants)) {
    for (const item of snap.variants) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { content?: unknown }).content === 'string'
      ) {
        out.push((item as { content: string }).content)
      }
    }
  }
  return out
}

function scrubSnapshotForSecret<T extends object>(
  snap: T | null,
  headings: ReadonlySet<string>,
  fallbackShortId: string,
): { next: T | null; changed: boolean } {
  if (!snap || typeof snap !== 'object') return { next: snap, changed: false }
  let changed = false
  const copy: Record<string, unknown> = { ...(snap as Record<string, unknown>) }
  if ('content' in copy) {
    delete copy.content
    changed = true
  }
  if ('fts' in copy) {
    delete copy.fts
    changed = true
  }
  if (Array.isArray(copy.variants)) {
    let variantsChanged = false
    const nextVariants = copy.variants.map((item) => {
      if (item && typeof item === 'object' && (item as { content?: unknown }).content !== null) {
        variantsChanged = true
        return { ...(item as Record<string, unknown>), content: null }
      }
      return item
    })
    if (variantsChanged) {
      copy.variants = nextVariants
      changed = true
    }
  }
  if (typeof copy.title === 'string' && headings.has(copy.title)) {
    copy.title = typeof copy.shortId === 'string' ? copy.shortId : fallbackShortId
    changed = true
  }
  return { next: copy as unknown as T, changed }
}

export function suggestionCurrent(
  ids: SQLWrapper,
  versions: SQLWrapper,
  options: { at?: Date; extra?: SQL } = {},
): SQL {
  const valid = stillValid(options.at)
  const extra = options.extra ? sql` and ${options.extra}` : sql``
  return sql`(
    coalesce(array_length(${ids}, 1), 0) > 0
    and coalesce(array_length(${ids}, 1), 0) = coalesce(array_length(${versions}, 1), 0)
    and (
      select count(*) from unnest(${ids}, ${versions}) as target(id, ver)
      join ${entries} on ${entries.id} = target.id
      where ${entries.version} = target.ver
        and ${entries.deletedAt} is null
        and ${valid}${extra}
    ) = array_length(${ids}, 1)
  )`
}

function benchMarkOf(context: unknown): { account: string; run: string } | null {
  if (!context || typeof context !== 'object') return null
  const bench = (context as Record<string, unknown>).bench
  if (!bench || typeof bench !== 'object') return null
  const rec = bench as Record<string, unknown>
  if (typeof rec.account !== 'string' || typeof rec.run !== 'string') return null
  return { account: rec.account, run: rec.run }
}

export async function benchMarkReader(
  tx: Tx,
  contexts: readonly unknown[],
): Promise<(context: unknown) => BenchMark | null> {
  const ids = [...new Set(contexts.flatMap((c) => benchMarkOf(c)?.account ?? []))]
  const rows = ids.length
    ? await tx
        .select({ id: accounts.id, displayName: accounts.displayName })
        .from(accounts)
        .where(inArray(accounts.id, ids))
    : []
  const names = new Map(rows.map((r) => [r.id, r.displayName]))
  return (context) => {
    const mark = benchMarkOf(context)
    return mark ? { accountName: names.get(mark.account) ?? null, run: mark.run } : null
  }
}

function checkExpected(before: EntryRow, expectedVersion?: number): void {
  if (expectedVersion !== undefined && before.version !== expectedVersion) {
    throw versionConflict('这条词条已经被其他请求修改，请重新读取后再操作')
  }
}

function checkPlaintextFlags(flags: PlaintextFlags, isConsole: boolean): void {
  if (isConsole && flags.plaintextOk !== undefined) {
    throw new MemoryError(400, '管理界面不能使用 plaintextOk 标记')
  }
  if (!isConsole && (flags.ignorePlaintext !== undefined || flags.allowPlaintext !== undefined)) {
    throw new MemoryError(400, '访问密钥请求不能使用 ignorePlaintext 或 allowPlaintext 标记')
  }
}

function rejectMasked(text: string, maskSecret: boolean | undefined): void {
  if (maskSecret && hasMaskedText(text)) {
    throw new MemoryError(400, '正文包含测试台掩码占位文字，并非真实内容，拒绝写入')
  }
}

const PLAINTEXT_LISTED = 10

function plaintextRejection(found: readonly PlaintextFinding[], viaKey: boolean): string {
  const spots = found
    .slice(0, PLAINTEXT_LISTED)
    .map((m) => `第 ${m.line} 行（${PLAINTEXT_KIND_NAMES[m.kind]}）`)
    .join('、')
  const more = found.length > PLAINTEXT_LISTED ? `等 ${found.length} 处` : ''
  const head = `正文里有新增的疑似明文凭据：${spots}${more}。`
  return viaKey
    ? `${head}凭据请先用 kioku_credential_save 存起来，正文里写成 {{cred:<标识>#<字段>}} 占位符；` +
        '确实不是凭据时带上 plaintext_ok（REST 为 plaintextOk）再写，这条记忆会进待处理，由人看过'
    : `${head}请逐处转存为凭据或标为不是凭据，也可以照样保存，这条记忆会进待处理`
}

function validateCredentialPlaceholders(
  texts: readonly string[],
  circleKind: CircleKind,
  kind: EntryKind,
  sensitivity: Sensitivity,
  hideDetail = false,
): { identifiers: Set<string>; refs: PlaceholderRef[] } {
  const allIdentifiers = new Set<string>()
  const allRefs: PlaceholderRef[] = []
  for (const content of texts) {
    const { refs, malformed } = scanPlaceholders(content)
    if (malformed.length) {
      throw new MemoryError(
        400,
        hideDetail
          ? '凭据占位符格式错误：请使用 {{cred:<标识>}} 或 {{cred:<标识>#<字段>}}'
          : `凭据占位符格式错误：${malformed[0]}，请使用 {{cred:<标识>}} 或 {{cred:<标识>#<字段>}}`,
      )
    }
    if (refs.length && !placeholderAllowed(circleKind, kind, sensitivity)) {
      throw new MemoryError(400, CONVERT_SCOPE_TEXT)
    }
    for (const r of refs) {
      allIdentifiers.add(r.identifier)
      allRefs.push(r)
    }
  }
  return { identifiers: allIdentifiers, refs: allRefs }
}

async function syncCredentialRefs(
  tx: Tx,
  circleId: string,
  entryId: string,
  identifiers: Set<string>,
): Promise<void> {
  await tx.delete(entryCredentialRefs).where(eq(entryCredentialRefs.entryId, entryId))
  if (!identifiers.size) return
  await tx
    .insert(entryCredentialRefs)
    .values([...identifiers].map((identifier) => ({ circleId, entryId, identifier })))
    .onConflictDoNothing()
}

export function parseEntryFacts(row: EntryRow): EntryFacts {
  return {
    circleId: row.circleId,
    kind: row.kind,
    sensitivity: row.sensitivity,
    originScope: row.originScope,
    clientId: row.clientId,
    ownerAccountId: row.ownerAccountId,
    subjectKind: row.subjectKind,
    realms: row.realms,
    validTo: row.validTo,
    expiresAt: row.expiresAt,
    deletedAt: row.deletedAt,
  }
}

interface CircleMeta {
  id: string
  slug: string
  name: string
  kind: CircleKind
  defaultRealms: string[]
}

export class EntryService {
  constructor(private readonly ctx: EntryContext) {}

  get access(): Access {
    return this.ctx.access
  }

  private get isConsole(): boolean {
    return this.ctx.secretRead === 'explicit'
  }

  private addsCredentialRefs(isNonTrusted = false): boolean {
    if (isNonTrusted) return this.ctx.allowCredentialRefs === true
    if (this.ctx.allowCredentialRefs !== undefined) return this.ctx.allowCredentialRefs
    const provenance = this.ctx.access.writeProvenance
    return provenance === 'owner' || provenance === 'agent'
  }

  private async verifyAddedCredentialRefs(
    tx: Tx,
    input: {
      circleId: string
      ownerAccountId: string | null
      refs: readonly PlaceholderRef[]
      baselineIdentifiers: ReadonlySet<string>
      isNonTrusted?: boolean
      hideDetail?: boolean
      access?: Access
    },
  ): Promise<void> {
    const added = input.refs.filter((r) => !input.baselineIdentifiers.has(r.identifier))
    if (!added.length) return
    if (!this.addsCredentialRefs(input.isNonTrusted ?? false)) {
      throw new MemoryError(400, '来自对话或后台任务的写入不能新增凭据引用')
    }
    const identifiers = [...new Set(added.map((r) => r.identifier))]
    if (!input.ownerAccountId) {
      throw new MemoryError(
        400,
        input.hideDetail ? '正文引用的凭据不存在或不可用' : `凭据不存在或不可用：${identifiers[0]}`,
      )
    }
    const rows = await tx
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.circleId, input.circleId),
          eq(credentials.ownerAccountId, input.ownerAccountId),
          inArray(credentials.identifier, identifiers),
          isNull(credentials.deletedAt),
        ),
      )
      .for('share')
    const access = input.access ?? this.ctx.access
    for (const identifier of identifiers) {
      const row = rows.find((r) => r.identifier === identifier)
      if (!row || !canUseCredential(access, row)) {
        throw new MemoryError(
          400,
          input.hideDetail ? '正文引用的凭据不存在或不可用' : `凭据不存在或不可用：${identifier}`,
        )
      }
      for (const ref of added) {
        if (ref.identifier !== identifier || ref.field === null) continue
        if (!row.fields.some((f) => f.name === ref.field)) {
          throw new MemoryError(
            400,
            input.hideDetail
              ? '正文引用的凭据没有此字段'
              : `凭据 ${identifier} 没有字段 ${ref.field}`,
          )
        }
      }
    }
  }

  private async resolveTargetCircle(
    tx: Tx,
    circleIdentifier?: string,
    mode: 'read' | 'write' = 'write',
  ): Promise<CircleMeta> {
    const allowedIds = [...this.ctx.access.circles.keys()]
    if (!allowedIds.length) {
      throw new MemoryError(403, '当前身份没有任何可访问的记忆圈')
    }
    const rows = await tx
      .select({
        id: circles.id,
        slug: circles.slug,
        name: circles.name,
        kind: circles.kind,
        defaultFacets: circles.defaultFacets,
      })
      .from(circles)
      .where(inArray(circles.id, allowedIds))

    let matched: (typeof rows)[number] | undefined
    if (!circleIdentifier) {
      matched = rows.find((r) => r.id === this.ctx.access.primaryCircleId)
    } else if (UUID.test(circleIdentifier)) {
      matched = rows.find((r) => r.id === circleIdentifier)
    } else {
      matched = rows.find((r) => r.slug === circleIdentifier)
    }
    if (!matched) {
      throw new MemoryError(
        mode === 'read' ? 404 : 404,
        circleIdentifier ? `未找到记忆圈：${circleIdentifier}` : '未找到目标记忆圈',
      )
    }
    return {
      id: matched.id,
      slug: matched.slug,
      name: matched.name,
      kind: matched.kind,
      defaultRealms: [...(matched.defaultFacets?.realm ?? [])],
    }
  }

  private async loadCircleMetaMap(tx: Tx): Promise<Map<string, CircleMeta>> {
    const ids = [...this.ctx.access.circles.keys()]
    if (!ids.length) return new Map()
    const rows = await tx
      .select({
        id: circles.id,
        slug: circles.slug,
        name: circles.name,
        kind: circles.kind,
        defaultFacets: circles.defaultFacets,
      })
      .from(circles)
      .where(inArray(circles.id, ids))
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          slug: r.slug,
          name: r.name,
          kind: r.kind,
          defaultRealms: [...(r.defaultFacets?.realm ?? [])],
        },
      ]),
    )
  }

  private async findEntryByRef(tx: Tx, ref: string, circleSlug?: string): Promise<EntryRow | null> {
    const trimmed = ref.trim()
    let scopedCircleId: string | undefined
    if (circleSlug) {
      const target = await this.resolveTargetCircle(tx, circleSlug, 'read')
      scopedCircleId = target.id
    }
    const circleFilter = scopedCircleId ? eq(entries.circleId, scopedCircleId) : undefined

    const short = normalizeShortId(trimmed)
    if (short) {
      const [row] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.shortId, short), circleFilter))
        .limit(1)
      return row ?? null
    }

    if (UUID.test(trimmed)) {
      const [row] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, trimmed), circleFilter))
        .limit(1)
      return row ?? null
    }

    // 尝试 legacy_uris 别名查找
    const [legacyMatch] = await tx
      .select({ entry: entries })
      .from(legacyUris)
      .innerJoin(entries, eq(entries.id, legacyUris.entryId))
      .where(and(eq(legacyUris.legacyUri, trimmed), circleFilter))
      .limit(1)
    if (legacyMatch) return legacyMatch.entry

    // 最后按精确标题兜底（非机密且未删除的同名多条返回 409）
    const titleRows = await tx
      .select()
      .from(entries)
      .where(and(eq(entries.title, trimmed), isNull(entries.deletedAt), circleFilter))
      .limit(5)
    if (titleRows.length === 1) return titleRows[0]!
    if (titleRows.length > 1) {
      throw new MemoryError(
        409,
        `标题「${trimmed}」匹配到多条词条，请改用短 ID（${titleRows.map((r) => r.shortId).join('、')}）访问`,
      )
    }
    return null
  }

  private eventContext(extra?: Record<string, unknown>): Record<string, unknown> {
    return { ...(this.ctx.eventContext ?? {}), ...(extra ?? {}) }
  }

  private async writeEvent(
    tx: Tx,
    input: {
      circleId: string
      entryId: string | null
      shortId?: string
      type: string
      provenance: Provenance
      before: StoredEntrySnapshot | null
      after: StoredEntrySnapshot | null
      context?: Record<string, unknown>
    },
  ): Promise<void> {
    const shortId = input.shortId ?? input.after?.shortId ?? input.before?.shortId
    if (!shortId) throw new Error('entryEvents 缺少 shortId')
    await tx.insert(entryEvents).values({
      circleId: input.circleId,
      entryId: input.entryId,
      shortId,
      eventType: input.type,
      provenance: input.provenance,
      actorAccountId: this.ctx.actor.accountId ?? null,
      actorKeyId: this.ctx.actor.keyId ?? null,
      before: input.before,
      after: input.after,
      context: this.eventContext(input.context),
    })
  }

  private async auditSecretAccess(tx: Tx, row: EntryRow, via: SecretVia): Promise<void> {
    await this.writeEvent(tx, {
      circleId: row.circleId,
      entryId: row.id,
      shortId: row.shortId,
      type: ACCESS_EVENT,
      provenance: this.ctx.access.writeProvenance,
      before: null,
      after: null,
      context: { via },
    })
  }

  private decryptVariant(
    row: Pick<VariantRow, 'id' | 'content' | 'ciphertext' | 'wrappedKey' | 'keyId'>,
    sensitivity: Sensitivity,
  ): string {
    if (sensitivity !== 'secret') return row.content ?? ''
    if (!this.ctx.masterKey) {
      throw new MemoryError(400, '尚未配置 KIOKU_MASTER_KEY，无法解密机密词条')
    }
    return openVariantContent(this.ctx.masterKey, row.id, row)
  }

  private async scanVariantsSensitive(
    tx: Tx,
    circleId: string,
    sensitivity: Sensitivity,
    variants: {
      when: WhenCondition
      whenSignature: string
      sortOrder: number
      content: string
      beforeContent: string | null
      hadPendingBefore: boolean
      existingIgnoredHash: string | null
    }[],
    flags: PlaintextFlags,
  ): Promise<
    {
      when: WhenCondition
      whenSignature: string
      sortOrder: number
      content: string
      sensitiveCredential: boolean
      sensitivePii: boolean
      sensitiveFindings: StoredSensitiveFinding[]
      plaintextIgnoredHash: string | null
      survivingCredential: boolean
    }[]
  > {
    if (sensitivity === 'secret') {
      return variants.map((v) => ({
        when: v.when,
        whenSignature: v.whenSignature,
        sortOrder: v.sortOrder,
        content: v.content,
        sensitiveCredential: false,
        sensitivePii: false,
        sensitiveFindings: [],
        plaintextIgnoredHash: null,
        survivingCredential: false,
      }))
    }

    const { settings: privacy } = await loadCirclePrivacy(tx, circleId)
    const modelConfig = privacy.usePrivacyModel
      ? await loadPrivacyModelConfig(tx, this.ctx.masterKey ?? null).catch(() => null)
      : null

    const addedFindings: PlaintextFinding[] = []
    const bypass = Boolean(flags.plaintextOk || flags.allowPlaintext || flags.ignorePlaintext)
    const credOpts = {
      credentials: true,
      pii: false,
      customRules: privacy.customRules,
      allowlist: privacy.allowlist,
    }
    const pendingOpts = {
      credentials: privacy.credentials,
      pii: privacy.pii,
      piiKinds: privacy.piiKinds,
      customRules: privacy.customRules,
      allowlist: privacy.allowlist,
    }

    const out = []
    for (const v of variants) {
      let survivingCredential = false
      let survivingPending = v.hadPendingBefore && v.beforeContent === v.content
      if (privacy.credentials) {
        const added = addedSensitiveContent(v.beforeContent, v.content, credOpts)
        for (const m of added) {
          addedFindings.push({ line: m.line, kind: m.kind as PlaintextKind })
        }
        if (v.beforeContent !== null) {
          survivingCredential =
            addedSensitiveContent(null, v.content, credOpts).length > added.length
        }
      }
      if (v.hadPendingBefore && v.beforeContent !== null && !survivingPending) {
        survivingPending =
          addedSensitiveContent(null, v.content, pendingOpts).length >
          addedSensitiveContent(v.beforeContent, v.content, pendingOpts).length
      }
      let modelSpans: ModelEntitySpan[] = []
      if (modelConfig && privacy.pii) {
        modelSpans = await detectWithPrivacyModel(modelConfig, v.content).catch(() => [])
      }
      const outcome = evaluateSensitiveContent(v.content, privacy, modelSpans)
      const keepIgnored =
        flags.ignorePlaintext && (outcome.hasCredential || outcome.hasPii) && !survivingPending
          ? contentDigest(v.content)
          : v.beforeContent === v.content
            ? v.existingIgnoredHash
            : null
      out.push({
        when: v.when,
        whenSignature: v.whenSignature,
        sortOrder: v.sortOrder,
        content: v.content,
        sensitiveCredential: outcome.hasCredential,
        sensitivePii: outcome.hasPii,
        sensitiveFindings: outcome.findings,
        plaintextIgnoredHash: keepIgnored,
        survivingCredential,
      })
    }

    if (addedFindings.length && !bypass) {
      throw new MemoryError(400, plaintextRejection(addedFindings, !this.isConsole), addedFindings)
    }

    return out
  }

  private assertSecretPolicy(
    circle: CircleMeta,
    sensitivity: Sensitivity,
    variants: readonly { when: WhenCondition }[],
  ): string[] {
    const realms = normalizeRealms(variants.flatMap((v) => v.when.realm ?? []))
    if (sensitivity !== 'secret') return realms
    if (!this.ctx.masterKey) {
      throw new MemoryError(400, '尚未配置主密钥，无法创建或升级为机密（secret）词条')
    }
    if (!hasHomogeneousRealms(variants)) {
      throw new MemoryError(400, '机密词条下禁止挂载不同场域（realm）的变体切片')
    }
    if (
      this.ctx.access.clientId !== null &&
      !checkStaticRealmLock(
        realms,
        circle.defaultRealms,
        this.ctx.access.allowedRealms,
        this.ctx.access.staticContextRealms,
      )
    ) {
      throw new MemoryError(403, '当前访问密钥的场域锁定范围不允许写入或查看此机密词条')
    }
    return realms
  }

  private async assembleEntryView(
    tx: Tx,
    row: EntryRow,
    variantRows: readonly VariantRow[],
    glossary: readonly string[],
    options: {
      circleSlug: string | null
      circleKind: CircleKind
      revealContent: boolean
      allVariants?: boolean
      otherVariants?: OtherVariantHint[]
      untouchedPlaintext?: boolean
      allowedSourceVariantIds?: ReadonlySet<string>
      now?: Date
    },
  ): Promise<EntryView | ConsoleEntryView> {
    const secret = row.sensitivity === 'secret'
    const mask = Boolean(this.ctx.maskSecret && secret)
    const variants: EntryVariantView[] = []
    const consoleVariants: ConsoleEntryView['variants'] = []

    const activeVariantIds = new Set<string>()
    for (const v of variantRows) {
      activeVariantIds.add(v.id)
      const content = secret
        ? mask
          ? null
          : options.revealContent
            ? this.decryptVariant(v, 'secret')
            : null
        : (v.content ?? '')
      const base: EntryVariantView = {
        id: v.id,
        when: normalizeWhen(v.when),
        whenSignature: v.whenSignature,
        sortOrder: v.sortOrder,
        content,
        updatedAt: v.updatedAt.toISOString(),
      }
      variants.push(base)
      if (this.isConsole) {
        const ignored = variantIgnoredNow(v)
        consoleVariants.push({
          ...base,
          contentHidden: secret && !options.revealContent,
          plaintextIgnored: ignored,
          ...(!secret && v.sensitiveFindings.length
            ? { sensitiveFindings: v.sensitiveFindings }
            : {}),
        })
      }
    }

    const links = await resolveEntryNeighbors(tx, this.ctx.access, row, {
      allowedSourceVariantIds: options.allowedSourceVariantIds ?? activeVariantIds,
      ...(options.now ? { now: options.now } : {}),
    })

    const baseView: EntryView = {
      id: row.id,
      shortId: row.shortId,
      circleId: row.circleId,
      circleSlug: options.circleSlug,
      kind: row.kind,
      title: row.title,
      sensitivity: row.sensitivity,
      provenance: row.provenance,
      originScope: row.originScope,
      topics: [...row.topics],
      realms: [...row.realms],
      priority: row.priority,
      disclosure: row.disclosure,
      glossary: [...glossary],
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo ? row.validTo.toISOString() : null,
      version: row.version,
      variants,
      otherVariants: options.otherVariants ?? [],
      links,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }

    if (this.isConsole) {
      const anyIgnored = variantRows.every((v) => !v.sensitiveCredential && !v.sensitivePii)
        ? false
        : variantRows.some((v) => variantIgnoredNow(v))
      const consoleView: ConsoleEntryView = {
        ...baseView,
        contentHidden: secret && !options.revealContent,
        plaintextIgnored: anyIgnored,
        variants: consoleVariants,
      }
      if (options.untouchedPlaintext) {
        Object.defineProperty(consoleView, UNTOUCHED_PLAINTEXT, { value: true })
      }
      return consoleView
    }
    if (options.untouchedPlaintext) {
      Object.defineProperty(baseView, UNTOUCHED_PLAINTEXT, { value: true })
    }
    return baseView
  }

  async create(raw: CreateInput): Promise<EntryView | ConsoleEntryView> {
    checkPlaintextFlags(raw, this.isConsole)
    const input = raw as CreateInput & { circleId?: string }

    const rawVariants: { when: WhenCondition; content: string; sortOrder: number }[] =
      input.variants !== undefined
        ? input.variants.map((v, i) => ({
            when: normalizeWhen(v.when),
            content: v.content,
            sortOrder: v.sortOrder ?? i,
          }))
        : [
            {
              when: normalizeWhen(input.when),
              content: input.content!,
              sortOrder: 0,
            },
          ]

    for (const v of rawVariants) rejectMasked(v.content, this.ctx.maskSecret)

    const topics = cleanTopics(input.topics)
    const glossary = cleanGlossary(input.glossary)
    const disclosure = input.disclosure?.trim() ? input.disclosure.trim() : null

    const created = await withCircles(
      this.ctx.db,
      { read: [...this.ctx.access.circles.keys()], write: [...this.ctx.access.circles.keys()] },
      async (tx, now) => {
        const circle = await this.resolveTargetCircle(tx, input.circleId ?? input.circle, 'write')
        const kind: EntryKind = 'entry'
        const sensitivity = input.sensitivity ?? DEFAULT_SENSITIVITY[circle.kind]
        if (!canWrite(this.ctx.access, { circleId: circle.id, kind, sensitivity })) {
          throw new MemoryError(403, `当前身份无权在记忆圈「${circle.name}」写入此敏感级词条`)
        }
        const realms = this.assertSecretPolicy(circle, sensitivity, rawVariants)
        const validTo = parseValidTo(input.validTo, now) ?? null
        const ownerAccountId = circle.kind === 'personal' ? this.ctx.access.ownerAccountId : null
        const validated = validateCredentialPlaceholders(
          rawVariants.map((v) => v.content),
          circle.kind,
          kind,
          sensitivity,
        )
        await this.verifyAddedCredentialRefs(tx, {
          circleId: circle.id,
          ownerAccountId,
          refs: validated.refs,
          baselineIdentifiers: new Set(),
          isNonTrusted: this.ctx.access.writeProvenance === 'untrusted',
        })

        const normalizedVariants = rawVariants.map((v) => ({
          when: v.when,
          whenSignature: whenSignature(v.when),
          sortOrder: v.sortOrder,
          content: v.content,
          beforeContent: null,
          hadPendingBefore: false,
          existingIgnoredHash: null,
        }))
        const scanned = await this.scanVariantsSensitive(
          tx,
          circle.id,
          sensitivity,
          normalizedVariants,
          raw,
        )

        const insertAttempt = async (sp: Tx, shortId: string) => {
          const title = deriveEntryTitle(input.title, rawVariants, shortId, sensitivity)
          const [row] = await sp
            .insert(entries)
            .values({
              circleId: circle.id,
              shortId,
              circleKind: circle.kind,
              kind,
              ownerAccountId: circle.kind === 'personal' ? this.ctx.access.ownerAccountId : null,
              clientId:
                circle.id === this.ctx.access.primaryCircleId ? this.ctx.access.clientId : null,
              provenance: this.ctx.access.writeProvenance,
              originScope: this.ctx.access.writeOriginScope,
              title,
              sensitivity,
              priority: input.priority ?? 2,
              disclosure,
              topics,
              realms,
              validFrom: now,
              validTo,
              version: 1,
            })
            .returning()
          const header = buildSearchHeader({ sensitivity, title, topics, disclosure, glossary })
          const insertedVariants: VariantRow[] = []
          for (const v of scanned) {
            const variantId = randomUUID()
            const sealed =
              sensitivity === 'secret'
                ? sealVariantContent(this.ctx.masterKey!, variantId, v.content)
                : null
            const [vRow] = await sp
              .insert(entryVariants)
              .values({
                id: variantId,
                circleId: circle.id,
                entryId: row!.id,
                kind,
                sensitivity,
                when: v.when,
                whenSignature: v.whenSignature,
                sortOrder: v.sortOrder,
                content: sensitivity === 'secret' ? null : v.content,
                searchHeader: header,
                ciphertext: sealed?.ciphertext ?? null,
                wrappedKey: sealed?.wrappedKey ?? null,
                keyId: sealed?.keyId ?? null,
                sensitiveCredential: v.sensitiveCredential,
                sensitivePii: v.sensitivePii,
                sensitiveFindings: v.sensitiveFindings,
                plaintextIgnoredHash: v.plaintextIgnoredHash,
              })
              .returning()
            insertedVariants.push(vRow!)
          }
          return { row: row!, variants: insertedVariants }
        }

        const replayShortId = this.ctx.takeReplayShortId?.()
        let inserted: { row: EntryRow; variants: VariantRow[] }
        if (replayShortId) {
          try {
            inserted = await tx.transaction((sp) => insertAttempt(sp, replayShortId))
          } catch (err) {
            if (isUniqueViolation(err, 'entries_short_id_unique')) {
              throw new MemoryError(409, '重放冲突：短 ID 已被其他词条占用，请清空重放后重试')
            }
            throw err
          }
        } else {
          inserted = (await insertWithAllocatedShortId(tx, insertAttempt)).value
        }

        if (glossary.length) {
          await tx
            .insert(entryGlossary)
            .values(
              glossary.map((keyword) => ({
                circleId: circle.id,
                entryId: inserted.row.id,
                keyword,
              })),
            )
            .onConflictDoNothing()
        }
        await syncCredentialRefs(
          tx,
          circle.id,
          inserted.row.id,
          sensitivity === 'secret' ? new Set() : validated.identifiers,
        )
        await syncEntryLinks(tx, {
          circleId: circle.id,
          entryId: inserted.row.id,
          shortId: inserted.row.shortId,
          sensitivity,
          provenance: inserted.row.provenance,
          variants: scanned.map((v, i) => ({
            id: inserted.variants[i]!.id,
            content: sensitivity === 'secret' ? null : v.content,
          })),
        })

        const snapshot = toStoredSnapshot(
          inserted.row,
          rawVariants.map((v) => ({ when: v.when, content: v.content })),
          glossary,
        )
        await this.writeEvent(tx, {
          circleId: circle.id,
          entryId: inserted.row.id,
          type: 'create',
          provenance: inserted.row.provenance,
          before: null,
          after: snapshot,
        })
        if (raw.ignorePlaintext && scanned.some((v) => v.plaintextIgnoredHash !== null)) {
          await this.writeEvent(tx, {
            circleId: circle.id,
            entryId: inserted.row.id,
            type: 'ignore_plaintext',
            provenance: inserted.row.provenance,
            before: toStoredSnapshot(
              inserted.row,
              rawVariants.map((v) => ({ when: v.when, content: null })),
              glossary,
            ),
            after: null,
          })
        }

        const reveal = !this.isConsole && sensitivity === 'secret'

        return {
          entryId: inserted.row.id,
          circleId: circle.id,
          view: await this.assembleEntryView(tx, inserted.row, inserted.variants, glossary, {
            circleSlug: visibleCircleSlug(this.ctx.access, circle.id, circle.slug),
            circleKind: circle.kind,
            revealContent: reveal,
            now,
          }),
        }
      },
    )

    this.ctx.onChanged?.(created.circleId, created.entryId)
    return created.view
  }

  async get(
    query: {
      id: string
      circle?: string
      allVariants?: boolean
      variantFilter?: WhenCondition
      focus?: WhenCondition
    },
    via: SecretVia = 'kioku_get',
  ): Promise<EntryView | ConsoleEntryView> {
    const canAudit = this.ctx.secretRead === 'audited'
    return withCircles(
      this.ctx.db,
      {
        read: [...this.ctx.access.circles.keys()],
        write: canAudit ? [this.ctx.access.primaryCircleId] : [],
      },
      async (tx, now) => {
        const row = await this.findEntryByRef(tx, query.id, query.circle)
        if (!row || !canRead(this.ctx.access, parseEntryFacts(row), { now, explicit: true })) {
          throw new MemoryError(404, `未找到词条：${query.id}`)
        }
        const [circleMetaMap, variantRows, glossaryRows] = await Promise.all([
          this.loadCircleMetaMap(tx),
          tx
            .select()
            .from(entryVariants)
            .where(eq(entryVariants.entryId, row.id))
            .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.createdAt)),
          tx
            .select({ keyword: entryGlossary.keyword })
            .from(entryGlossary)
            .where(eq(entryGlossary.entryId, row.id))
            .orderBy(asc(entryGlossary.keyword)),
        ])
        const circleMeta = circleMetaMap.get(row.circleId)!
        const cleanFilter = query.variantFilter ? normalizeWhen(query.variantFilter) : undefined
        const hasFilter = cleanFilter !== undefined && Object.keys(cleanFilter).length > 0

        let visibleVariants = variantRows
        let otherVariants: OtherVariantHint[] = []
        if (!query.allVariants && (hasFilter || query.focus !== undefined)) {
          const vocab = hasFilter
            ? undefined
            : (await loadCircleVocabularies(tx, [row.circleId])).get(row.circleId)
          const emptyDims = new Map()
          const kept: VariantRow[] = []
          const excluded: OtherVariantHint[] = []
          for (const v of variantRows) {
            const w = normalizeWhen(v.when)
            let matched: boolean
            if (hasFilter) {
              matched = Object.entries(cleanFilter!).every(([dim, slugs]) =>
                Boolean(w[dim]?.some((s) => slugs.includes(s))),
              )
            } else {
              const ev = evaluateVariantFocus({
                when: w,
                circleDefaults: {},
                focus: query.focus ?? {},
                customDimensions: vocab?.dimensions ?? emptyDims,
                awayCircle: false,
                flippedCircle: false,
                flippedRealms: new Set(),
                crossGroup: false,
              })
              matched = !ev.hasConflict
            }
            if (matched) kept.push(v)
            else excluded.push({ when: w, whenSignature: v.whenSignature })
          }
          visibleVariants = kept
          otherVariants = excluded
        }

        const reveal = this.ctx.secretRead !== 'explicit'
        if (
          row.sensitivity === 'secret' &&
          canAudit &&
          !this.ctx.maskSecret &&
          visibleVariants.length > 0
        ) {
          await this.auditSecretAccess(tx, row, via)
        }
        return this.assembleEntryView(
          tx,
          row,
          visibleVariants,
          glossaryRows.map((g) => g.keyword),
          {
            circleSlug: visibleCircleSlug(this.ctx.access, row.circleId, circleMeta.slug),
            circleKind: circleMeta.kind,
            revealContent: reveal,
            ...(query.allVariants !== undefined ? { allVariants: query.allVariants } : {}),
            otherVariants,
            allowedSourceVariantIds: new Set(visibleVariants.map((v) => v.id)),
            now,
          },
        )
      },
    )
  }

  async reveal(entryId: string, via: SecretVia = 'console'): Promise<ConsoleEntryView> {
    return withCircle(this.ctx.db, this.ctx.access.primaryCircleId, async (tx, now) => {
      const [row] = await tx.select().from(entries).where(eq(entries.id, entryId)).limit(1)
      if (!row || !canRead(this.ctx.access, parseEntryFacts(row), { now, explicit: true })) {
        throw new MemoryError(404, '未找到词条')
      }
      const [circleMetaMap, variantRows, glossaryRows] = await Promise.all([
        this.loadCircleMetaMap(tx),
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, row.id))
          .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.createdAt)),
        tx
          .select({ keyword: entryGlossary.keyword })
          .from(entryGlossary)
          .where(eq(entryGlossary.entryId, row.id))
          .orderBy(asc(entryGlossary.keyword)),
      ])
      const circleMeta = circleMetaMap.get(row.circleId)!
      if (row.sensitivity === 'secret' && !this.ctx.maskSecret) {
        await this.auditSecretAccess(tx, row, via)
      }
      return (await this.assembleEntryView(
        tx,
        row,
        variantRows,
        glossaryRows.map((g) => g.keyword),
        {
          circleSlug: circleMeta.slug,
          circleKind: circleMeta.kind,
          revealContent: true,
          now,
        },
      )) as ConsoleEntryView
    })
  }

  async update(
    raw: UpdateInput,
    via: SecretVia = 'kioku_update',
  ): Promise<EntryView | ConsoleEntryView> {
    checkPlaintextFlags(raw, this.isConsole)
    const writable = [...this.ctx.access.circles.keys()]
    const result = await withCircles(
      this.ctx.db,
      { read: writable, write: writable },
      async (tx, now) => {
        const before = await this.findEntryByRef(tx, raw.id, raw.circle)
        if (
          !before ||
          !canRead(this.ctx.access, parseEntryFacts(before), { now, explicit: true })
        ) {
          throw new MemoryError(404, `未找到词条：${raw.id}`)
        }
        checkExpected(before, raw.expectedVersion)
        if (!canModify(this.ctx.access, before)) {
          throw new MemoryError(403, '当前身份无权修改此词条')
        }

        const nextSensitivity = raw.sensitivity ?? before.sensitivity
        if (nextSensitivity !== before.sensitivity) {
          if (
            !sensitivityAllowed(before.circleKind, before.kind, nextSensitivity, before.provenance)
          ) {
            throw new MemoryError(400, '会话摘要与未确认来源的记录不支持设为机密（secret）')
          }
          if (
            !canWrite(this.ctx.access, {
              circleId: before.circleId,
              kind: before.kind,
              sensitivity: nextSensitivity,
              provenance: before.provenance,
            })
          ) {
            throw new MemoryError(
              403,
              `当前身份无权将词条修改为${sensitivityWithValue(nextSensitivity)}`,
            )
          }
          if (before.sensitivity === 'secret' && !canWrite(this.ctx.access, before)) {
            throw new MemoryError(403, '无权修改机密词条的敏感级')
          }
        }

        if (this.ctx.maskSecret && before.sensitivity === 'secret') {
          if (
            (raw.sensitivity !== undefined && raw.sensitivity !== 'secret') ||
            raw.content !== undefined ||
            raw.variants !== undefined ||
            raw.upsertVariants !== undefined ||
            raw.removeVariantWhens !== undefined
          ) {
            throw new MemoryError(400, '测试台模式下禁止降级或改写机密词条正文')
          }
        }

        const circleMetaMap = await this.loadCircleMetaMap(tx)
        const circle = circleMetaMap.get(before.circleId)!

        const [existingVariants, existingGlossaryRows] = await Promise.all([
          tx
            .select()
            .from(entryVariants)
            .where(eq(entryVariants.entryId, before.id))
            .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.createdAt)),
          tx
            .select({ keyword: entryGlossary.keyword })
            .from(entryGlossary)
            .where(eq(entryGlossary.entryId, before.id))
            .orderBy(asc(entryGlossary.keyword)),
        ])

        const existingGlossary = existingGlossaryRows.map((g) => g.keyword)
        const existingDecrypted = existingVariants.map((v) => ({
          row: v,
          when: normalizeWhen(v.when),
          whenSignature: v.whenSignature,
          sortOrder: v.sortOrder,
          content: this.decryptVariant(v, before.sensitivity),
          hadPending: needsSensitiveInboxAlert({
            circleKind: circle.kind,
            sensitivity: before.sensitivity,
            provenance: before.provenance,
            sensitiveCredential: v.sensitiveCredential,
            sensitivePii: v.sensitivePii,
            plaintextIgnored: variantIgnoredNow(v),
          }),
        }))

        const downgradeFromSecret = before.sensitivity === 'secret' && nextSensitivity !== 'secret'
        if (downgradeFromSecret && raw.allowPlaintext && !this.ctx.circleOwner) {
          throw new MemoryError(403, '仅记忆圈所有者可使用 allowPlaintext 降级机密词条')
        }

        // 计算更新后的变体全集
        interface TargetVariant {
          when: WhenCondition
          whenSignature: string
          sortOrder: number
          content: string
          beforeContent: string | null
          hadPendingBefore: boolean
          existingIgnoredHash: string | null
          existingId: string | null
        }

        const existingBySig = new Map(existingDecrypted.map((ev) => [ev.whenSignature, ev]))
        let targetVariants: TargetVariant[]

        if (raw.variants !== undefined) {
          for (const v of raw.variants) rejectMasked(v.content, this.ctx.maskSecret)
          targetVariants = raw.variants.map((v, i) => {
            const norm = normalizeWhen(v.when)
            const sig = whenSignature(norm)
            const prev = existingBySig.get(sig)
            return {
              when: norm,
              whenSignature: sig,
              sortOrder: v.sortOrder ?? i,
              content: v.content,
              beforeContent: downgradeFromSecret ? null : (prev?.content ?? null),
              hadPendingBefore: prev?.hadPending ?? false,
              existingIgnoredHash: prev?.row.plaintextIgnoredHash ?? null,
              existingId: prev?.row.id ?? null,
            }
          })
        } else {
          const workMap = new Map<string, TargetVariant>(
            existingDecrypted.map((ev) => [
              ev.whenSignature,
              {
                when: ev.when,
                whenSignature: ev.whenSignature,
                sortOrder: ev.sortOrder,
                content: ev.content,
                beforeContent: downgradeFromSecret ? null : ev.content,
                hadPendingBefore: ev.hadPending,
                existingIgnoredHash: ev.row.plaintextIgnoredHash,
                existingId: ev.row.id,
              },
            ]),
          )
          if (raw.removeVariantWhens) {
            for (const w of raw.removeVariantWhens) {
              workMap.delete(whenSignature(w))
            }
          }
          if (raw.upsertVariants) {
            for (const v of raw.upsertVariants) {
              rejectMasked(v.content, this.ctx.maskSecret)
              const norm = normalizeWhen(v.when)
              const sig = whenSignature(norm)
              const prev = existingBySig.get(sig)
              workMap.set(sig, {
                when: norm,
                whenSignature: sig,
                sortOrder: v.sortOrder ?? prev?.sortOrder ?? workMap.size,
                content: v.content,
                beforeContent: downgradeFromSecret ? null : (prev?.content ?? null),
                hadPendingBefore: prev?.hadPending ?? false,
                existingIgnoredHash: prev?.row.plaintextIgnoredHash ?? null,
                existingId: prev?.row.id ?? null,
              })
            }
          }
          if (raw.content !== undefined) {
            rejectMasked(raw.content, this.ctx.maskSecret)
            const norm = normalizeWhen(raw.when ?? {})
            const sig = whenSignature(norm)
            const prev = existingBySig.get(sig)
            workMap.set(sig, {
              when: norm,
              whenSignature: sig,
              sortOrder: prev?.sortOrder ?? workMap.size,
              content: raw.content,
              beforeContent: downgradeFromSecret ? null : (prev?.content ?? null),
              hadPendingBefore: prev?.hadPending ?? false,
              existingIgnoredHash: prev?.row.plaintextIgnoredHash ?? null,
              existingId: prev?.row.id ?? null,
            })
          }
          targetVariants = [...workMap.values()].sort((a, b) => a.sortOrder - b.sortOrder)
        }

        if (!targetVariants.length) {
          throw new MemoryError(400, '词条至少需要保留一个变体切片')
        }
        if (targetVariants.length > VARIANTS_MAX) {
          throw new MemoryError(400, `单条词条最多包含 ${VARIANTS_MAX} 个变体切片`)
        }
        if (
          before.kind === 'episode' &&
          (targetVariants.length > 1 || targetVariants[0]!.whenSignature !== '{}')
        ) {
          throw new MemoryError(400, '会话摘要仅支持单个无条件（when: {}）切片')
        }

        const canBypassDowngrade =
          this.isConsole && Boolean(raw.allowPlaintext && this.ctx.circleOwner)
        if (downgradeFromSecret && !canBypassDowngrade) {
          const { settings: privacy } = await loadCirclePrivacy(tx, before.circleId)
          if (privacy.credentials) {
            for (const tv of targetVariants) {
              const hits = addedSensitiveContent(null, tv.content, {
                credentials: true,
                pii: false,
                customRules: privacy.customRules,
                allowlist: privacy.allowlist,
              })
              if (hits.length) {
                throw new MemoryError(
                  400,
                  '机密词条中含疑似明文凭据，降级前请先把值换成凭据占位符或由记忆圈所有者使用 allowPlaintext 确认',
                  hits.map((m) => ({ line: m.line, kind: m.kind as PlaintextKind })),
                )
              }
            }
          }
        }

        const realms = this.assertSecretPolicy(circle, nextSensitivity, targetVariants)
        const nextTopics = raw.topics !== undefined ? cleanTopics(raw.topics) : before.topics
        const nextDisclosure =
          raw.disclosure === undefined
            ? before.disclosure
            : raw.disclosure?.trim()
              ? raw.disclosure.trim()
              : null
        const nextPriority = raw.priority ?? before.priority
        const nextValidTo =
          raw.validTo === undefined || sameValidTo(raw.validTo, before.validTo)
            ? before.validTo
            : (parseValidTo(raw.validTo, now, before.validFrom) ?? null)

        const glossarySet = new Set(existingGlossary)
        if (raw.glossaryAdd) {
          for (const g of cleanGlossary(raw.glossaryAdd)) glossarySet.add(g)
        }
        if (raw.glossaryRemove) {
          for (const g of raw.glossaryRemove) glossarySet.delete(g.trim())
        }
        const nextGlossary = [...glossarySet].sort()

        const hideDetail =
          before.sensitivity === 'secret' &&
          raw.content === undefined &&
          raw.variants === undefined &&
          raw.upsertVariants === undefined
        const validated = validateCredentialPlaceholders(
          targetVariants.map((v) => v.content),
          circle.kind,
          before.kind,
          nextSensitivity,
          hideDetail,
        )
        const baselineIdentifiers = new Set<string>()
        if (
          circle.kind === 'personal' &&
          before.ownerAccountId === this.ctx.access.ownerAccountId &&
          placeholderAllowed(circle.kind, before.kind, before.sensitivity)
        ) {
          for (const ev of existingDecrypted) {
            for (const id of placeholderIdentifiers(ev.content)) baselineIdentifiers.add(id)
          }
        }
        await this.verifyAddedCredentialRefs(tx, {
          circleId: before.circleId,
          ownerAccountId: before.ownerAccountId,
          refs: validated.refs,
          baselineIdentifiers,
          isNonTrusted:
            before.provenance === 'untrusted' || this.ctx.access.writeProvenance === 'untrusted',
          hideDetail,
        })

        const scanned = await this.scanVariantsSensitive(
          tx,
          before.circleId,
          nextSensitivity,
          targetVariants,
          raw,
        )

        const becameSecret = nextSensitivity === 'secret' && before.sensitivity !== 'secret'
        const secretHeadings =
          nextSensitivity === 'secret'
            ? markdownHeadingsOf([
                ...targetVariants.map((v) => v.content),
                ...existingDecrypted.map((v) => v.content),
                ...(becameSecret ? await this.loadHistoryPlaintextContents(tx, before.id) : []),
              ])
            : null

        const explicitTitle = raw.title === undefined ? before.title : raw.title
        const derivedTitle = deriveEntryTitle(
          explicitTitle,
          targetVariants,
          before.shortId,
          nextSensitivity,
        )
        const nextTitle =
          secretHeadings && secretHeadings.has(derivedTitle) ? before.shortId : derivedTitle

        const [updatedEntry] = await tx
          .update(entries)
          .set({
            title: nextTitle,
            sensitivity: nextSensitivity,
            priority: nextPriority,
            disclosure: nextDisclosure,
            topics: nextTopics,
            realms,
            validTo: nextValidTo,
            version: before.version + 1,
            updatedAt: updatedAtFor(now),
          })
          .where(
            and(
              eq(entries.id, before.id),
              eq(entries.version, before.version),
              isNull(entries.deletedAt),
            ),
          )
          .returning()
        if (!updatedEntry) {
          throw new MemoryError(409, '词条刚被其他请求修改，请重新读取')
        }

        const header = buildSearchHeader({
          sensitivity: nextSensitivity,
          title: nextTitle,
          topics: nextTopics,
          disclosure: nextDisclosure,
          glossary: nextGlossary,
        })

        // 替换或原地更新 entry_variants；统一维护同一事务内的状态外键与加密字段
        const keptIds: string[] = []
        const finalVariants: VariantRow[] = []

        for (let i = 0; i < scanned.length; i++) {
          const item = scanned[i]!
          const existingId = targetVariants[i]!.existingId
          const variantId = existingId ?? randomUUID()
          keptIds.push(variantId)
          const sealed =
            nextSensitivity === 'secret'
              ? sealVariantContent(this.ctx.masterKey!, variantId, item.content)
              : null

          if (existingId) {
            const [uRow] = await tx
              .update(entryVariants)
              .set({
                sensitivity: nextSensitivity,
                when: item.when,
                whenSignature: item.whenSignature,
                sortOrder: item.sortOrder,
                content: nextSensitivity === 'secret' ? null : item.content,
                searchHeader: header,
                ciphertext: sealed?.ciphertext ?? null,
                wrappedKey: sealed?.wrappedKey ?? null,
                keyId: sealed?.keyId ?? null,
                sensitiveCredential: item.sensitiveCredential,
                sensitivePii: item.sensitivePii,
                sensitiveFindings: item.sensitiveFindings,
                plaintextIgnoredHash: item.plaintextIgnoredHash,
                updatedAt: now,
              })
              .where(eq(entryVariants.id, existingId))
              .returning()
            finalVariants.push(uRow!)
          } else {
            const [iRow] = await tx
              .insert(entryVariants)
              .values({
                id: variantId,
                circleId: before.circleId,
                entryId: before.id,
                kind: before.kind,
                sensitivity: nextSensitivity,
                when: item.when,
                whenSignature: item.whenSignature,
                sortOrder: item.sortOrder,
                content: nextSensitivity === 'secret' ? null : item.content,
                searchHeader: header,
                ciphertext: sealed?.ciphertext ?? null,
                wrappedKey: sealed?.wrappedKey ?? null,
                keyId: sealed?.keyId ?? null,
                sensitiveCredential: item.sensitiveCredential,
                sensitivePii: item.sensitivePii,
                sensitiveFindings: item.sensitiveFindings,
                plaintextIgnoredHash: item.plaintextIgnoredHash,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
            finalVariants.push(iRow!)
          }
        }

        const removedVariantIds = existingVariants
          .map((v) => v.id)
          .filter((id) => !keptIds.includes(id))
        if (removedVariantIds.length) {
          await tx.delete(entryVariants).where(inArray(entryVariants.id, removedVariantIds))
        }
        if (nextSensitivity === 'secret') {
          await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, before.id))
        }

        if (raw.glossaryAdd !== undefined || raw.glossaryRemove !== undefined) {
          await tx.delete(entryGlossary).where(eq(entryGlossary.entryId, before.id))
          if (nextGlossary.length) {
            await tx
              .insert(entryGlossary)
              .values(
                nextGlossary.map((keyword) => ({
                  circleId: before.circleId,
                  entryId: before.id,
                  keyword,
                })),
              )
              .onConflictDoNothing()
          }
        }

        await syncCredentialRefs(
          tx,
          before.circleId,
          before.id,
          nextSensitivity === 'secret' ? new Set() : validated.identifiers,
        )
        await syncEntryLinks(tx, {
          circleId: before.circleId,
          entryId: before.id,
          shortId: before.shortId,
          sensitivity: nextSensitivity,
          provenance: updatedEntry!.provenance,
          variants: scanned.map((v, i) => ({
            id: finalVariants[i]!.id,
            content: nextSensitivity === 'secret' ? null : v.content,
          })),
        })

        const beforeSnap = toStoredSnapshot(
          before,
          existingDecrypted.map((ev) => ({ when: ev.when, content: ev.content })),
          existingGlossary,
        )
        const recordedBeforeSnap =
          becameSecret && secretHeadings
            ? scrubSnapshotForSecret(beforeSnap, secretHeadings, before.shortId).next!
            : beforeSnap
        const afterSnap = toStoredSnapshot(
          updatedEntry!,
          scanned.map((v) => ({ when: v.when, content: v.content })),
          nextGlossary,
        )
        if (becameSecret && secretHeadings) {
          await this.scrubEntryHistoryForSecret(tx, before.id, before.shortId, secretHeadings)
        }
        await this.writeEvent(tx, {
          circleId: before.circleId,
          entryId: before.id,
          type: 'update',
          provenance: this.ctx.access.writeProvenance,
          before: recordedBeforeSnap,
          after: afterSnap,
        })
        if (
          raw.ignorePlaintext &&
          scanned.some(
            (v, i) =>
              v.plaintextIgnoredHash !== null &&
              v.plaintextIgnoredHash !== targetVariants[i]!.existingIgnoredHash,
          )
        ) {
          await this.writeEvent(tx, {
            circleId: before.circleId,
            entryId: before.id,
            type: 'ignore_plaintext',
            provenance: updatedEntry!.provenance,
            before: toStoredSnapshot(
              updatedEntry!,
              scanned.map((v) => ({ when: v.when, content: null })),
              nextGlossary,
            ),
            after: null,
          })
        }

        const reveal = this.ctx.secretRead !== 'explicit'
        const hadContentWrite =
          raw.variants !== undefined ||
          raw.upsertVariants !== undefined ||
          raw.content !== undefined

        // 局部写入机密词条切片时，访问密钥调用仅回显本次传入的切片且不把未触碰存量解密回传
        let visibleVariants = finalVariants
        let otherVariants: OtherVariantHint[] = []
        if (
          !this.isConsole &&
          before.sensitivity === 'secret' &&
          nextSensitivity === 'secret' &&
          raw.variants === undefined &&
          (raw.upsertVariants !== undefined || raw.content !== undefined)
        ) {
          const touchedSigs = new Set<string>()
          if (raw.upsertVariants) {
            for (const v of raw.upsertVariants) touchedSigs.add(whenSignature(v.when))
          }
          if (raw.content !== undefined) touchedSigs.add(whenSignature(raw.when ?? {}))
          visibleVariants = finalVariants.filter((v) => touchedSigs.has(v.whenSignature))
          otherVariants = finalVariants
            .filter((v) => !touchedSigs.has(v.whenSignature))
            .map((v) => ({ when: normalizeWhen(v.when), whenSignature: v.whenSignature }))
        }

        const shouldAudit =
          reveal &&
          !this.ctx.maskSecret &&
          before.sensitivity === 'secret' &&
          nextSensitivity === 'secret' &&
          !hadContentWrite &&
          visibleVariants.length > 0
        if (shouldAudit) {
          await this.auditSecretAccess(tx, updatedEntry!, via)
        }

        const untouchedPlaintext = scanned.some(
          (item, i) =>
            item.sensitiveCredential &&
            !item.plaintextIgnoredHash &&
            item.survivingCredential &&
            targetVariants[i]!.hadPendingBefore,
        )

        return {
          entryId: updatedEntry!.id,
          circleId: updatedEntry!.circleId,
          secret: nextSensitivity === 'secret',
          view: await this.assembleEntryView(tx, updatedEntry!, visibleVariants, nextGlossary, {
            circleSlug: visibleCircleSlug(this.ctx.access, before.circleId, circle.slug),
            circleKind: circle.kind,
            revealContent: reveal,
            otherVariants,
            untouchedPlaintext,
            allowedSourceVariantIds: new Set(visibleVariants.map((v) => v.id)),
            now,
          }),
        }
      },
    )

    if (!result.secret) this.ctx.onChanged?.(result.circleId, result.entryId)
    return result.view
  }

  async remove(input: { id: string; circle?: string; expectedVersion?: number }): Promise<{
    id: string
    shortId: string
  }> {
    const writable = [...this.ctx.access.circles.keys()]
    return withCircles(this.ctx.db, { read: writable, write: writable }, async (tx, now) => {
      const before = await this.findEntryByRef(tx, input.id, input.circle)
      if (
        !before ||
        before.deletedAt !== null ||
        !canRead(this.ctx.access, parseEntryFacts(before), { now, explicit: true })
      ) {
        throw new MemoryError(404, `未找到词条：${input.id}`)
      }
      checkExpected(before, input.expectedVersion)
      if (!canModify(this.ctx.access, before)) {
        throw new MemoryError(403, '当前身份无权删除此词条')
      }

      const [variantRows, glossaryRows] = await Promise.all([
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, before.id))
          .orderBy(asc(entryVariants.sortOrder)),
        tx
          .select({ keyword: entryGlossary.keyword })
          .from(entryGlossary)
          .where(eq(entryGlossary.entryId, before.id)),
      ])
      const decodedVariants = variantRows.map((v) => ({
        when: normalizeWhen(v.when),
        content: before.sensitivity === 'secret' ? null : (v.content ?? ''),
      }))

      const [after] = await tx
        .update(entries)
        .set({ deletedAt: now, version: before.version + 1, updatedAt: updatedAtFor(now) })
        .where(
          and(
            eq(entries.id, before.id),
            eq(entries.version, before.version),
            isNull(entries.deletedAt),
          ),
        )
        .returning()
      if (!after) {
        throw new MemoryError(409, '词条刚被其他请求修改，请重新读取')
      }

      await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, before.id))
      await tx.delete(entryLinks).where(eq(entryLinks.sourceEntryId, before.id))

      await this.writeEvent(tx, {
        circleId: before.circleId,
        entryId: before.id,
        type: 'delete',
        provenance: this.ctx.access.writeProvenance,
        before: toStoredSnapshot(
          before,
          decodedVariants,
          glossaryRows.map((g) => g.keyword),
        ),
        after: toStoredSnapshot(
          after!,
          decodedVariants,
          glossaryRows.map((g) => g.keyword),
        ),
      })

      return { id: before.id, shortId: before.shortId }
    })
  }

  async transfer(request: TransferEntryRequest): Promise<EntryView | ConsoleEntryView> {
    const writable = [...this.ctx.access.circles.keys()]
    return withCircles(this.ctx.db, { read: writable, write: writable }, async (tx, now) => {
      const targetCircle = await this.resolveTargetCircle(tx, request.toCircle, 'write')
      const sourceEntry = await this.findEntryByRef(tx, request.id, request.fromCircle)
      if (
        !sourceEntry ||
        sourceEntry.deletedAt !== null ||
        !canRead(this.ctx.access, parseEntryFacts(sourceEntry), { now, explicit: true })
      ) {
        throw new MemoryError(404, `未找到词条：${request.id}`)
      }
      if (sourceEntry.circleKind !== 'shared' || targetCircle.kind !== 'shared') {
        throw new MemoryError(403, '访问密钥只能在有写权限的共享圈之间迁移词条')
      }
      if (sourceEntry.sensitivity === 'secret') {
        throw new MemoryError(403, '访问密钥不能跨圈迁移机密词条，请使用管理界面操作')
      }
      return this.performTransfer(tx, sourceEntry, targetCircle, request.expectedVersion, now)
    })
  }

  async consoleTransfer(
    request: ConsoleTransferEntryRequest,
    toCircleAccess: Access,
  ): Promise<ConsoleEntryView> {
    const readIds = [
      ...new Set([...this.ctx.access.circles.keys(), toCircleAccess.primaryCircleId]),
    ]
    const writeIds = [...new Set([this.ctx.access.primaryCircleId, toCircleAccess.primaryCircleId])]
    return withCircles(this.ctx.db, { read: readIds, write: writeIds }, async (tx, now) => {
      const [sourceEntry] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, request.entryId))
        .for('update')
        .limit(1)
      if (
        !sourceEntry ||
        sourceEntry.deletedAt !== null ||
        !canRead(this.ctx.access, parseEntryFacts(sourceEntry), { now, explicit: true })
      ) {
        throw new MemoryError(404, '未找到词条')
      }
      const [toCircleRow] = await tx
        .select({
          id: circles.id,
          slug: circles.slug,
          name: circles.name,
          kind: circles.kind,
          defaultFacets: circles.defaultFacets,
        })
        .from(circles)
        .where(eq(circles.id, request.toCircleId))
        .limit(1)
      if (!toCircleRow) throw new MemoryError(404, '目标记忆圈不存在')
      const targetCircle: CircleMeta = {
        id: toCircleRow.id,
        slug: toCircleRow.slug,
        name: toCircleRow.name,
        kind: toCircleRow.kind,
        defaultRealms: [...(toCircleRow.defaultFacets?.realm ?? [])],
      }
      if (
        !canWrite(toCircleAccess, {
          circleId: targetCircle.id,
          kind: sourceEntry.kind,
          sensitivity:
            targetCircle.kind === 'personal' && sourceEntry.sensitivity === 'public'
              ? 'private'
              : sourceEntry.sensitivity,
          provenance: sourceEntry.provenance,
        })
      ) {
        throw new MemoryError(403, '当前账号在目标记忆圈无权写入该敏感到或物种的词条')
      }
      return (await this.performTransfer(
        tx,
        sourceEntry,
        targetCircle,
        request.expectedVersion,
        now,
        toCircleAccess,
      )) as ConsoleEntryView
    })
  }

  private async performTransfer(
    tx: Tx,
    lockedSource: EntryRow,
    targetCircle: CircleMeta,
    expectedVersion: number | undefined,
    now: Date,
    targetAccess: Access = this.ctx.access,
  ): Promise<EntryView | ConsoleEntryView> {
    // 若外层尚未加行锁则再锁一次源词条
    const [before] = await tx
      .select()
      .from(entries)
      .where(eq(entries.id, lockedSource.id))
      .for('update')
      .limit(1)
    if (!before || before.deletedAt !== null) {
      throw new MemoryError(404, '词条不存在或已删除')
    }
    if (before.circleId === targetCircle.id) {
      throw new MemoryError(400, '源记忆圈与目标记忆圈不能相同')
    }
    checkExpected(before, expectedVersion)
    if (!canModify(this.ctx.access, before)) {
      throw new MemoryError(403, '当前身份无权迁出该词条')
    }
    if (before.kind !== 'entry') {
      throw new MemoryError(400, '只有正式词条（entry）支持跨圈迁移')
    }

    const nextSensitivity: Sensitivity =
      targetCircle.kind === 'personal' && before.sensitivity === 'public'
        ? 'private'
        : before.sensitivity
    if (
      !sensitivityAllowed(targetCircle.kind, before.kind, nextSensitivity, before.provenance) ||
      !canWrite(targetAccess, {
        circleId: targetCircle.id,
        kind: before.kind,
        sensitivity: nextSensitivity,
        provenance: before.provenance,
      })
    ) {
      throw new MemoryError(403, `当前身份无权迁入记忆圈「${targetCircle.name}」`)
    }

    const [refs, variantRows, glossaryRows, legacyRows] = await Promise.all([
      tx
        .select({ identifier: entryCredentialRefs.identifier })
        .from(entryCredentialRefs)
        .where(eq(entryCredentialRefs.entryId, before.id)),
      tx
        .select()
        .from(entryVariants)
        .where(eq(entryVariants.entryId, before.id))
        .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.createdAt)),
      tx
        .select({ keyword: entryGlossary.keyword })
        .from(entryGlossary)
        .where(eq(entryGlossary.entryId, before.id)),
      tx
        .select({ legacyUri: legacyUris.legacyUri, source: legacyUris.source })
        .from(legacyUris)
        .where(eq(legacyUris.entryId, before.id)),
    ])
    if (refs.length > 0) {
      throw new MemoryError(400, '包含凭据占位符引用的词条暂不支持跨圈迁移，请先移除凭据引用')
    }

    const decoded = variantRows.map((v) => ({
      when: normalizeWhen(v.when),
      whenSignature: v.whenSignature,
      sortOrder: v.sortOrder,
      content: this.decryptVariant(v, before.sensitivity),
      plaintextIgnoredHash: v.plaintextIgnoredHash,
    }))
    const glossary = glossaryRows.map((g) => g.keyword)

    if (nextSensitivity === 'secret') {
      this.assertSecretPolicy(targetCircle, nextSensitivity, decoded)
    }

    const targetOwner = targetCircle.kind === 'personal' ? targetAccess.ownerAccountId : null
    const hideTransferDetail = before.sensitivity === 'secret'
    const transferValidated = validateCredentialPlaceholders(
      decoded.map((v) => v.content),
      targetCircle.kind,
      before.kind,
      nextSensitivity,
      hideTransferDetail,
    )
    await this.verifyAddedCredentialRefs(tx, {
      circleId: targetCircle.id,
      ownerAccountId: targetOwner,
      refs: transferValidated.refs,
      baselineIdentifiers: new Set(),
      isNonTrusted: before.provenance === 'untrusted',
      hideDetail: hideTransferDetail,
      access: targetAccess,
    })

    // 1. 源圈记录 transfer_out（物理删除后 entry_id 会被外键自动置空，before 完整保留）
    await this.writeEvent(tx, {
      circleId: before.circleId,
      entryId: before.id,
      type: 'transfer_out',
      provenance: this.ctx.access.writeProvenance,
      before: toStoredSnapshot(before, decoded, glossary),
      after: null,
      context: { toCircleId: targetCircle.id, shortId: before.shortId },
    })

    // 2. 源圈物理删除释放全局唯一 short_id
    await tx.delete(entries).where(eq(entries.id, before.id))

    // 3. 目标圈以相同 short_id 重建（version = 1）
    const nextTitle = deriveEntryTitle(before.title, decoded, before.shortId, nextSensitivity)
    const [inserted] = await tx
      .insert(entries)
      .values({
        circleId: targetCircle.id,
        shortId: before.shortId,
        circleKind: targetCircle.kind,
        kind: before.kind,
        ownerAccountId: targetOwner,
        clientId: targetCircle.id === targetAccess.primaryCircleId ? targetAccess.clientId : null,
        provenance: before.provenance,
        originScope: before.originScope,
        title: nextTitle,
        sensitivity: nextSensitivity,
        priority: before.priority,
        disclosure: before.disclosure,
        topics: [...before.topics],
        realms: [...before.realms],
        validFrom: before.validFrom,
        validTo: before.validTo,
        version: 1,
      })
      .returning()

    const { settings: privacy } = await loadCirclePrivacy(tx, targetCircle.id)
    const header = buildSearchHeader({
      sensitivity: nextSensitivity,
      title: nextTitle,
      topics: before.topics,
      disclosure: before.disclosure,
      glossary,
    })

    const createdVariants: VariantRow[] = []
    for (const v of decoded) {
      const variantId = randomUUID()
      const sealed =
        nextSensitivity === 'secret'
          ? sealVariantContent(this.ctx.masterKey!, variantId, v.content)
          : null
      const outcome =
        nextSensitivity === 'secret' ? null : evaluateSensitiveContent(v.content, privacy)
      const [vRow] = await tx
        .insert(entryVariants)
        .values({
          id: variantId,
          circleId: targetCircle.id,
          entryId: inserted!.id,
          kind: inserted!.kind,
          sensitivity: nextSensitivity,
          when: v.when,
          whenSignature: v.whenSignature,
          sortOrder: v.sortOrder,
          content: nextSensitivity === 'secret' ? null : v.content,
          searchHeader: header,
          ciphertext: sealed?.ciphertext ?? null,
          wrappedKey: sealed?.wrappedKey ?? null,
          keyId: sealed?.keyId ?? null,
          sensitiveCredential: outcome?.hasCredential ?? false,
          sensitivePii: outcome?.hasPii ?? false,
          sensitiveFindings: outcome?.findings ?? [],
          plaintextIgnoredHash: nextSensitivity === 'secret' ? null : v.plaintextIgnoredHash,
        })
        .returning()
      createdVariants.push(vRow!)
    }

    if (glossary.length) {
      await tx.insert(entryGlossary).values(
        glossary.map((keyword) => ({
          circleId: targetCircle.id,
          entryId: inserted!.id,
          keyword,
        })),
      )
    }
    if (legacyRows.length) {
      await tx
        .insert(legacyUris)
        .values(
          legacyRows.map((l) => ({
            circleId: targetCircle.id,
            entryId: inserted!.id,
            legacyUri: l.legacyUri,
            source: l.source,
          })),
        )
        .onConflictDoNothing()
    }

    if (nextSensitivity !== 'secret' && transferValidated.identifiers.size > 0) {
      await syncCredentialRefs(tx, targetCircle.id, inserted!.id, transferValidated.identifiers)
    }
    await syncEntryLinks(tx, {
      circleId: targetCircle.id,
      entryId: inserted!.id,
      shortId: inserted!.shortId,
      sensitivity: nextSensitivity,
      provenance: inserted!.provenance,
      variants: decoded.map((v, i) => ({
        id: createdVariants[i]!.id,
        content: nextSensitivity === 'secret' ? null : v.content,
      })),
    })

    await this.writeEvent(tx, {
      circleId: targetCircle.id,
      entryId: inserted!.id,
      type: 'transfer_in',
      provenance: this.ctx.access.writeProvenance,
      before: null,
      after: toStoredSnapshot(inserted!, decoded, glossary),
      context: { fromCircleId: before.circleId, shortId: before.shortId },
    })

    if (nextSensitivity !== 'secret') {
      this.ctx.onChanged?.(targetCircle.id, inserted!.id)
    }

    return this.assembleEntryView(tx, inserted!, createdVariants, glossary, {
      circleSlug: visibleCircleSlug(targetAccess, targetCircle.id, targetCircle.slug),
      circleKind: targetCircle.kind,
      revealContent: this.ctx.secretRead !== 'explicit',
      now,
    })
  }

  async browse(query: BrowseEntriesQuery): Promise<EntryBrowseResponse> {
    const readableCircles = [...this.ctx.access.circles.keys()]
    if (!readableCircles.length) {
      return { groupBy: query.groupBy, groups: [], truncated: false }
    }
    return withCircles(
      this.ctx.db,
      { read: readableCircles },
      async (tx, now) => {
        const circleMetaMap = await this.loadCircleMetaMap(tx)
        let scopedCircleId: string | undefined
        if (query.circle) {
          const c = await this.resolveTargetCircle(tx, query.circle, 'read')
          scopedCircleId = c.id
        }

        const q = query.query?.trim()
        const pattern = q ? `%${escapeLike(q)}%` : null
        const rows = await tx
          .select()
          .from(entries)
          .where(
            and(
              readableConditions(this.ctx.access, {
                now,
                explicit: Boolean(this.ctx.listSecret),
              }),
              this.ctx.listSecret ? undefined : ne(entries.sensitivity, 'secret'),
              scopedCircleId ? eq(entries.circleId, scopedCircleId) : undefined,
              query.kind ? eq(entries.kind, query.kind) : undefined,
              query.topic ? sql`${query.topic} = any(${entries.topics})` : undefined,
              pattern
                ? or(ilike(entries.title, pattern), ilike(entries.disclosure, pattern))
                : undefined,
            ),
          )
          .orderBy(asc(entries.priority), desc(entries.updatedAt), asc(entries.shortId))
          .limit(query.limit + 1)

        const truncated = rows.length > query.limit
        const slice = rows.slice(0, query.limit)
        if (!slice.length) {
          return { groupBy: query.groupBy, groups: [], truncated: false }
        }

        const variantRows = await tx
          .select({
            entryId: entryVariants.entryId,
            when: entryVariants.when,
          })
          .from(entryVariants)
          .where(
            inArray(
              entryVariants.entryId,
              slice.map((r) => r.id),
            ),
          )
          .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.createdAt))

        const variantsByEntry = new Map<string, WhenCondition[]>()
        for (const v of variantRows) {
          const list = variantsByEntry.get(v.entryId) ?? []
          list.push(normalizeWhen(v.when))
          variantsByEntry.set(v.entryId, list)
        }

        // 若传入切面筛选，保留至少有一个变体匹配所选切面键的词条
        const filterFacets = query.facets ? normalizeWhen(query.facets) : null
        const filteredRows =
          filterFacets && Object.keys(filterFacets).length
            ? slice.filter((r) => {
                const vList = variantsByEntry.get(r.id) ?? []
                return vList.some((w) =>
                  Object.entries(filterFacets).every(([dim, vals]) =>
                    vals.some((val) => w[dim]?.includes(val)),
                  ),
                )
              })
            : slice

        const groupMap = new Map<string, { label: string; items: EntryBrowseItem[] }>()
        const pushToGroup = (key: string, label: string, item: EntryBrowseItem) => {
          let g = groupMap.get(key)
          if (!g) {
            g = { label, items: [] }
            groupMap.set(key, g)
          }
          g.items.push(item)
        }

        for (const r of filteredRows) {
          const meta = circleMetaMap.get(r.circleId)
          const vWhen = variantsByEntry.get(r.id) ?? []
          const item: EntryBrowseItem = {
            id: r.id,
            shortId: r.shortId,
            title: r.title,
            circleId: r.circleId,
            circleSlug: visibleCircleSlug(this.ctx.access, r.circleId, meta?.slug ?? ''),
            kind: r.kind,
            sensitivity: r.sensitivity,
            priority: r.priority,
            topics: [...r.topics],
            disclosure: r.disclosure,
            variantCount: vWhen.length,
            variantsSummary: vWhen,
          }

          switch (query.groupBy) {
            case 'circle': {
              const slug =
                visibleCircleSlug(this.ctx.access, r.circleId, meta?.slug ?? '') ?? 'other'
              pushToGroup(r.circleId, meta?.name ?? slug, item)
              break
            }
            case 'kind':
              pushToGroup(r.kind, kindWithValue(r.kind), item)
              break
            case 'topic':
              if (!r.topics.length) {
                pushToGroup('__untagged__', '未分类', item)
              } else {
                for (const t of r.topics) pushToGroup(t, t, item)
              }
              break
            case 'realm':
            case 'env':
            case 'runtime':
            case 'project': {
              const dim = query.groupBy
              const vals = [...new Set(vWhen.flatMap((w) => w[dim] ?? []))]
              if (!vals.length) {
                pushToGroup('__default__', '通用（未限定）', item)
              } else {
                for (const v of vals) pushToGroup(v, v, item)
              }
              break
            }
          }
        }

        const groups: EntryBrowseGroup[] = [...groupMap.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([key, g]) => ({ key, label: g.label, count: g.items.length, items: g.items }))

        return { groupBy: query.groupBy, groups, truncated }
      },
      { accessMode: 'read only' },
    )
  }

  async list(query: EntryListQuery): Promise<EntryList> {
    const circleId = this.ctx.access.primaryCircleId
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const [circleRow] = await tx
          .select({ kind: circles.kind })
          .from(circles)
          .where(eq(circles.id, circleId))
          .limit(1)
        const circleKind: CircleKind = circleRow?.kind ?? 'shared'

        const filters: (SQL | undefined)[] = [
          readableConditions(this.ctx.access, { now, explicit: Boolean(this.ctx.listSecret) }),
          this.ctx.listSecret ? undefined : ne(entries.sensitivity, 'secret'),
          query.kind ? eq(entries.kind, query.kind) : undefined,
          query.sensitivity ? eq(entries.sensitivity, query.sensitivity) : undefined,
          query.provenance ? eq(entries.provenance, query.provenance) : undefined,
          query.topic ? sql`${query.topic} = any(${entries.topics})` : undefined,
          query.updatedAfter
            ? sql`${entries.updatedAt} >= ${query.updatedAfter}::timestamptz`
            : undefined,
          query.updatedBefore
            ? sql`${entries.updatedAt} < ${query.updatedBefore}::timestamptz`
            : undefined,
        ]

        if (query.dimensionKey && query.termSlug) {
          filters.push(
            exists(
              tx
                .select({ one: sql`1` })
                .from(entryVariants)
                .where(
                  and(
                    eq(entryVariants.entryId, entries.id),
                    sql`${entryVariants.when} -> ${query.dimensionKey} ? ${query.termSlug}`,
                  ),
                ),
            ),
          )
        }

        if (query.q) {
          const pattern = `%${escapeLike(query.q)}%`
          filters.push(
            or(
              ilike(entries.title, pattern),
              ilike(entries.disclosure, pattern),
              eq(entries.shortId, query.q.toLowerCase()),
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(entryVariants)
                  .where(
                    and(
                      eq(entryVariants.entryId, entries.id),
                      ne(entryVariants.sensitivity, 'secret'),
                      ilike(entryVariants.content, pattern),
                    ),
                  ),
              ),
            ),
          )
        }

        if (query.missingDisclosure === 'true') {
          filters.push(NEEDS_DISCLOSURE)
        } else if (query.missingDisclosure === 'false') {
          filters.push(sql`not ${NEEDS_DISCLOSURE}`)
        }

        const piiProtected =
          circleKind === 'personal'
            ? sql`(${entries.sensitivity} in ('private','secret') and ${entries.provenance} <> 'untrusted')`
            : sql`false`

        const variantHasAlert = exists(
          tx
            .select({ one: sql`1` })
            .from(entryVariants)
            .where(
              and(
                eq(entryVariants.entryId, entries.id),
                ne(entryVariants.sensitivity, 'secret'),
                sql`not ${IGNORED_NOW}`,
                query.sensitiveCategory === 'credential'
                  ? eq(entryVariants.sensitiveCredential, true)
                  : query.sensitiveCategory === 'pii'
                    ? and(eq(entryVariants.sensitivePii, true), sql`not ${piiProtected}`)
                    : or(
                        eq(entryVariants.sensitiveCredential, true),
                        and(eq(entryVariants.sensitivePii, true), sql`not ${piiProtected}`),
                      ),
              ),
            ),
        )

        if (query.plaintext === 'true') filters.push(variantHasAlert)
        else if (query.plaintext === 'ignored') {
          filters.push(
            exists(
              tx
                .select({ one: sql`1` })
                .from(entryVariants)
                .where(
                  and(
                    eq(entryVariants.entryId, entries.id),
                    ne(entryVariants.sensitivity, 'secret'),
                    sql`${IGNORED_NOW}`,
                    or(
                      eq(entryVariants.sensitiveCredential, true),
                      eq(entryVariants.sensitivePii, true),
                    ),
                  ),
                ),
            ),
          )
        } else if (query.plaintext === 'false') {
          filters.push(sql`not ${variantHasAlert}`)
        }

        const sort = query.sort
        let cursorCond: SQL | undefined
        if (query.cursor) {
          if (sort === 'updated') {
            const c = decodeTimeCursor(query.cursor, UUID)
            if (c === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
            if (c)
              cursorCond = sql`(${entries.updatedAt}, ${entries.id}) < (${fromMicros(c[0])}, ${c[1]}::uuid)`
          } else if (sort === 'shortId') {
            const vals = parseCursor(query.cursor)
            if (
              vals === 'invalid' ||
              vals.length !== 1 ||
              typeof vals[0] !== 'string' ||
              !SHORT_ID_CURSOR.test(vals[0])
            ) {
              throw new MemoryError(400, INVALID_CURSOR)
            }
            cursorCond = sql`${entries.shortId} > ${vals[0]}`
          } else {
            const vals = parseCursor(query.cursor)
            if (
              vals === 'invalid' ||
              vals.length !== 3 ||
              typeof vals[0] !== 'number' ||
              !Number.isInteger(vals[0]) ||
              vals[0] < INT32_MIN ||
              vals[0] > INT32_MAX ||
              typeof vals[1] !== 'string' ||
              !SHORT_ID_CURSOR.test(vals[1]) ||
              typeof vals[2] !== 'string' ||
              !UUID.test(vals[2])
            ) {
              throw new MemoryError(400, INVALID_CURSOR)
            }
            cursorCond = sql`(${entries.priority}, ${entries.shortId}, ${entries.id}) > (${vals[0]}, ${vals[1]}, ${vals[2]}::uuid)`
          }
        }

        const orderBy =
          sort === 'updated'
            ? [desc(entries.updatedAt), desc(entries.id)]
            : sort === 'shortId'
              ? [asc(entries.shortId)]
              : [asc(entries.priority), asc(entries.shortId), asc(entries.id)]

        const rows = await tx
          .select({
            row: entries,
            micros: sql<string>`${microsOf(entries.updatedAt)}::text`,
          })
          .from(entries)
          .where(and(...filters, cursorCond))
          .orderBy(...orderBy)
          .limit(query.limit + 1)

        const slice = rows.slice(0, query.limit)
        const vRows = slice.length
          ? await tx
              .select()
              .from(entryVariants)
              .where(
                inArray(
                  entryVariants.entryId,
                  slice.map((r) => r.row.id),
                ),
              )
              .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.createdAt))
          : []

        const byEntry = new Map<string, VariantRow[]>()
        for (const v of vRows) {
          const list = byEntry.get(v.entryId) ?? []
          list.push(v)
          byEntry.set(v.entryId, list)
        }

        const items = slice.map(({ row }) => {
          const variants = byEntry.get(row.id) ?? []
          const activeFindings = variants
            .filter((v) =>
              needsSensitiveInboxAlert({
                circleKind,
                sensitivity: row.sensitivity,
                provenance: row.provenance,
                sensitiveCredential: v.sensitiveCredential,
                sensitivePii: v.sensitivePii,
                plaintextIgnored: variantIgnoredNow(v),
              }),
            )
            .flatMap((v) => v.sensitiveFindings)
          const hasCred = variants.some(
            (v) => !variantIgnoredNow(v) && v.sensitiveCredential && row.sensitivity !== 'secret',
          )
          const hasPii = variants.some(
            (v) =>
              !variantIgnoredNow(v) &&
              v.sensitivePii &&
              row.sensitivity !== 'secret' &&
              !isProtectedPersonalEntry(circleKind, row.sensitivity, row.provenance),
          )
          return {
            id: row.id,
            shortId: row.shortId,
            circleId: row.circleId,
            title: row.title,
            kind: row.kind,
            sensitivity: row.sensitivity,
            provenance: row.provenance,
            topics: [...row.topics],
            realms: [...row.realms],
            priority: row.priority,
            disclosure: row.disclosure,
            variantCount: variants.length,
            variantsWhen: variants.map((v) => normalizeWhen(v.when)),
            version: row.version,
            updatedAt: row.updatedAt.toISOString(),
            validTo: row.validTo ? row.validTo.toISOString() : null,
            ...(hasCred ? { sensitiveCredential: true } : {}),
            ...(hasPii ? { sensitivePii: true } : {}),
            ...(activeFindings.length ? { sensitiveFindings: activeFindings } : {}),
          }
        })

        const last = slice.at(-1)
        const nextCursor =
          rows.length > query.limit && last
            ? sort === 'updated'
              ? encodeTimeCursor(last.micros, last.row.id)
              : sort === 'shortId'
                ? Buffer.from(JSON.stringify([last.row.shortId])).toString('base64url')
                : Buffer.from(
                    JSON.stringify([last.row.priority, last.row.shortId, last.row.id]),
                  ).toString('base64url')
            : null

        return { items, nextCursor }
      },
      { accessMode: 'read only' },
    )
  }

  async plaintextCount(): Promise<number> {
    const circleId = this.ctx.access.primaryCircleId
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const [circleRow] = await tx
          .select({ kind: circles.kind })
          .from(circles)
          .where(eq(circles.id, circleId))
          .limit(1)
        const circleKind = circleRow?.kind ?? 'shared'
        const piiProtected =
          circleKind === 'personal'
            ? sql`(${entries.sensitivity} in ('private','secret') and ${entries.provenance} <> 'untrusted')`
            : sql`false`

        const [row] = await tx
          .select({ n: count() })
          .from(entries)
          .where(
            and(
              readableConditions(this.ctx.access, { now, explicit: Boolean(this.ctx.listSecret) }),
              ne(entries.sensitivity, 'secret'),
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(entryVariants)
                  .where(
                    and(
                      eq(entryVariants.entryId, entries.id),
                      sql`not ${IGNORED_NOW}`,
                      or(
                        eq(entryVariants.sensitiveCredential, true),
                        and(eq(entryVariants.sensitivePii, true), sql`not ${piiProtected}`),
                      ),
                    ),
                  ),
              ),
            ),
          )
        return row?.n ?? 0
      },
      { accessMode: 'read only' },
    )
  }

  private async setIgnoreState(
    request: PlaintextIgnoreRequest,
    ignore: boolean,
  ): Promise<ConsoleEntryView> {
    const circleId = this.ctx.access.primaryCircleId
    const view = await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const [before] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, request.entryId))
        .for('update')
        .limit(1)
      if (
        !before ||
        before.deletedAt !== null ||
        !canRead(this.ctx.access, parseEntryFacts(before), { now, management: true })
      ) {
        throw new MemoryError(404, '未找到词条')
      }
      if (!canModify(this.ctx.access, before)) {
        throw new MemoryError(403, '无权修改此词条')
      }
      checkExpected(before, request.expectedVersion)
      if (before.sensitivity === 'secret') {
        throw new MemoryError(400, '机密词条的正文已加密，没有明文提示')
      }
      const [variantRows, glossaryRows, circleMetaMap, { settings: privacy }] = await Promise.all([
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, before.id))
          .orderBy(asc(entryVariants.sortOrder)),
        tx
          .select({ keyword: entryGlossary.keyword })
          .from(entryGlossary)
          .where(eq(entryGlossary.entryId, before.id)),
        this.loadCircleMetaMap(tx),
        loadCirclePrivacy(tx, circleId),
      ])
      const glossary = glossaryRows.map((g) => g.keyword)
      const meta = circleMetaMap.get(circleId)!
      const targetVariants = request.variantId
        ? variantRows.filter((v) => v.id === request.variantId)
        : variantRows
      if (!targetVariants.length) throw new MemoryError(404, '未找到对应变体切片')

      const outcomes = targetVariants.map((v) => evaluateSensitiveContent(v.content ?? '', privacy))
      if (
        ignore &&
        !targetVariants.some(
          (v, i) =>
            v.sensitiveCredential ||
            v.sensitivePii ||
            outcomes[i]!.hasCredential ||
            outcomes[i]!.hasPii,
        )
      ) {
        throw new MemoryError(400, '这条词条的正文没有疑似敏感内容，无需忽略')
      }
      if (targetVariants.every((v) => variantIgnoredNow(v) === ignore)) {
        return (await this.assembleEntryView(tx, before, variantRows, glossary, {
          circleSlug: meta.slug,
          circleKind: meta.kind,
          revealContent: false,
          now,
        })) as ConsoleEntryView
      }

      for (const [i, v] of targetVariants.entries()) {
        const outcome = outcomes[i]!
        await tx
          .update(entryVariants)
          .set({
            plaintextIgnoredHash: ignore && v.content !== null ? contentDigest(v.content) : null,
            ...(ignore && (outcome.hasCredential || outcome.hasPii)
              ? {
                  sensitiveCredential: outcome.hasCredential || v.sensitiveCredential,
                  sensitivePii: outcome.hasPii || v.sensitivePii,
                  sensitiveFindings: outcome.findings.length
                    ? outcome.findings
                    : v.sensitiveFindings,
                }
              : {}),
          })
          .where(eq(entryVariants.id, v.id))
      }

      const updatedVariants = await tx
        .select()
        .from(entryVariants)
        .where(eq(entryVariants.entryId, before.id))
        .orderBy(asc(entryVariants.sortOrder))
      const snap = toStoredSnapshot(
        before,
        variantRows.map((v) => ({ when: normalizeWhen(v.when), content: null })),
        glossary,
      )

      await this.writeEvent(tx, {
        circleId,
        entryId: before.id,
        type: ignore ? 'ignore_plaintext' : 'unignore_plaintext',
        provenance: this.ctx.access.writeProvenance,
        before: snap,
        after: null,
      })
      return (await this.assembleEntryView(tx, before, updatedVariants, glossary, {
        circleSlug: meta.slug,
        circleKind: meta.kind,
        revealContent: false,
        now,
      })) as ConsoleEntryView
    })
    this.ctx.onChanged?.(circleId, request.entryId)
    return view
  }

  ignorePlaintext(request: PlaintextIgnoreRequest): Promise<ConsoleEntryView> {
    return this.setIgnoreState(request, true)
  }

  unignorePlaintext(request: PlaintextIgnoreRequest): Promise<ConsoleEntryView> {
    return this.setIgnoreState(request, false)
  }

  async redact(request: RedactEntryRequest): Promise<ConsoleEntryView> {
    const circleId = this.ctx.access.primaryCircleId
    const res = await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const [before] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, request.entryId))
        .for('update')
        .limit(1)
      if (
        !before ||
        before.deletedAt !== null ||
        !canRead(this.ctx.access, parseEntryFacts(before), { now, management: true })
      ) {
        throw new MemoryError(404, '未找到词条')
      }
      if (!canModify(this.ctx.access, before)) throw new MemoryError(403, '无权修改此词条')
      if (before.sensitivity === 'secret')
        throw new MemoryError(400, '机密词条已加密保存，无需打码')
      checkExpected(before, request.expectedVersion)

      const [{ settings: privacy }, variantRows, glossaryRows, circleMetaMap] = await Promise.all([
        loadCirclePrivacy(tx, circleId),
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, before.id))
          .orderBy(asc(entryVariants.sortOrder)),
        tx
          .select({ keyword: entryGlossary.keyword })
          .from(entryGlossary)
          .where(eq(entryGlossary.entryId, before.id)),
        this.loadCircleMetaMap(tx),
      ])
      const targets = request.variantId
        ? variantRows.filter((v) => v.id === request.variantId)
        : variantRows
      if (!targets.length) throw new MemoryError(404, '未找到对应变体切片')

      const updatedMap = new Map<string, { content: string; row: VariantRow }>()
      for (const v of variantRows) {
        const plain = v.content ?? ''
        if (!targets.some((t) => t.id === v.id)) {
          updatedMap.set(v.id, { content: plain, row: v })
          continue
        }
        const masked = maskSensitiveContent(
          plain,
          {
            credentials: privacy.credentials,
            pii: privacy.pii,
            piiKinds: privacy.piiKinds,
            customRules: privacy.customRules,
            allowlist: privacy.allowlist,
          },
          request.mode,
        )
        const outcome = evaluateSensitiveContent(masked, privacy)
        const [uRow] = await tx
          .update(entryVariants)
          .set({
            content: masked,
            sensitiveCredential: outcome.hasCredential,
            sensitivePii: outcome.hasPii,
            sensitiveFindings: outcome.findings,
            plaintextIgnoredHash: null,
            updatedAt: now,
          })
          .where(eq(entryVariants.id, v.id))
          .returning()
        updatedMap.set(v.id, { content: masked, row: uRow! })
      }

      const [updated] = await tx
        .update(entries)
        .set({ version: before.version + 1, updatedAt: updatedAtFor(now) })
        .where(eq(entries.id, before.id))
        .returning()

      const glossary = glossaryRows.map((g) => g.keyword)
      const finalRows = variantRows.map((v) => updatedMap.get(v.id)!.row)
      await syncEntryLinks(tx, {
        circleId,
        entryId: before.id,
        shortId: before.shortId,
        sensitivity: before.sensitivity,
        provenance: before.provenance,
        variants: finalRows.map((v) => ({ id: v.id, content: v.content })),
      })

      await this.writeEvent(tx, {
        circleId,
        entryId: before.id,
        type: 'redact',
        provenance: this.ctx.access.writeProvenance,
        before: toStoredSnapshot(
          before,
          variantRows.map((v) => ({ when: normalizeWhen(v.when), content: v.content })),
          glossary,
        ),
        after: toStoredSnapshot(
          updated!,
          finalRows.map((v) => ({ when: normalizeWhen(v.when), content: v.content })),
          glossary,
        ),
      })

      const meta = circleMetaMap.get(circleId)!
      return (await this.assembleEntryView(tx, updated!, finalRows, glossary, {
        circleSlug: meta.slug,
        circleKind: meta.kind,
        revealContent: false,
        now,
      })) as ConsoleEntryView
    })
    this.ctx.onChanged?.(circleId, request.entryId)
    return res
  }

  private async loadHistoryPlaintextContents(tx: Tx, entryId: string): Promise<string[]> {
    const rows = await tx
      .select({ before: entryEvents.before, after: entryEvents.after })
      .from(entryEvents)
      .where(eq(entryEvents.entryId, entryId))
    return rows.flatMap((r) => [
      ...snapshotPlaintextContents(r.before as Record<string, unknown> | null),
      ...snapshotPlaintextContents(r.after as Record<string, unknown> | null),
    ])
  }

  private async scrubEntryHistoryForSecret(
    tx: Tx,
    entryId: string,
    shortId: string,
    headings: ReadonlySet<string>,
  ): Promise<void> {
    const events = await tx
      .select({ id: entryEvents.id, before: entryEvents.before, after: entryEvents.after })
      .from(entryEvents)
      .where(eq(entryEvents.entryId, entryId))
    for (const ev of events) {
      const b = scrubSnapshotForSecret(
        ev.before as Record<string, unknown> | null,
        headings,
        shortId,
      )
      const a = scrubSnapshotForSecret(
        ev.after as Record<string, unknown> | null,
        headings,
        shortId,
      )
      if (!b.changed && !a.changed) continue
      await tx
        .update(entryEvents)
        .set({ before: b.next, after: a.next })
        .where(eq(entryEvents.id, ev.id))
    }
  }

  async protect(request: ProtectEntryRequest): Promise<ConsoleEntryView> {
    const circleId = this.ctx.access.primaryCircleId
    const res = await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const [before] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, request.entryId))
        .for('update')
        .limit(1)
      if (
        !before ||
        before.deletedAt !== null ||
        !canRead(this.ctx.access, parseEntryFacts(before), { now, management: true })
      ) {
        throw new MemoryError(404, '未找到词条')
      }
      checkExpected(before, request.expectedVersion)
      const targetSensitivity: Sensitivity = request.target === 'secret' ? 'secret' : 'private'
      if (
        !sensitivityAllowed(before.circleKind, before.kind, targetSensitivity, before.provenance)
      ) {
        throw new MemoryError(400, '会话摘要与未确认来源的记录不支持设为机密（secret）')
      }
      if (
        !canWrite(this.ctx.access, {
          circleId,
          kind: before.kind,
          sensitivity: targetSensitivity,
          provenance: before.provenance,
        })
      ) {
        throw new MemoryError(
          403,
          `当前身份无权将该词条设为${sensitivityWithValue(targetSensitivity)}`,
        )
      }

      const [variantRows, glossaryRows, circleMetaMap] = await Promise.all([
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, before.id))
          .orderBy(asc(entryVariants.sortOrder)),
        tx
          .select({ keyword: entryGlossary.keyword })
          .from(entryGlossary)
          .where(eq(entryGlossary.entryId, before.id)),
        this.loadCircleMetaMap(tx),
      ])
      const meta = circleMetaMap.get(circleId)!
      if (targetSensitivity === 'private' && meta.kind !== 'personal') {
        throw new MemoryError(400, '只有个人圈词条可以提升至「个人私密」防护边界')
      }
      const decoded = variantRows.map((v) => ({
        row: v,
        when: normalizeWhen(v.when),
        content: this.decryptVariant(v, before.sensitivity),
      }))
      if (targetSensitivity === 'secret') {
        this.assertSecretPolicy(meta, 'secret', decoded)
      }

      const becameSecret = targetSensitivity === 'secret' && before.sensitivity !== 'secret'
      const secretHeadings =
        targetSensitivity === 'secret'
          ? markdownHeadingsOf([
              ...decoded.map((v) => v.content),
              ...(becameSecret ? await this.loadHistoryPlaintextContents(tx, before.id) : []),
            ])
          : null

      const glossary = glossaryRows.map((g) => g.keyword)
      const derivedTitle = deriveEntryTitle(
        before.title,
        decoded,
        before.shortId,
        targetSensitivity,
      )
      const nextTitle =
        secretHeadings && secretHeadings.has(derivedTitle) ? before.shortId : derivedTitle
      const nextHeader = buildSearchHeader({
        sensitivity: targetSensitivity,
        title: nextTitle,
        topics: before.topics,
        disclosure: before.disclosure,
        glossary,
      })

      const [updated] = await tx
        .update(entries)
        .set({
          title: nextTitle,
          sensitivity: targetSensitivity,
          version: before.version + 1,
          updatedAt: updatedAtFor(now),
        })
        .where(eq(entries.id, before.id))
        .returning()

      const finalVariants: VariantRow[] = []
      for (const item of decoded) {
        const sealed =
          targetSensitivity === 'secret'
            ? sealVariantContent(this.ctx.masterKey!, item.row.id, item.content)
            : null
        const [uRow] = await tx
          .update(entryVariants)
          .set({
            sensitivity: targetSensitivity,
            content: targetSensitivity === 'secret' ? null : item.content,
            searchHeader: nextHeader,
            ciphertext: sealed?.ciphertext ?? null,
            wrappedKey: sealed?.wrappedKey ?? null,
            keyId: sealed?.keyId ?? null,
            sensitiveCredential:
              targetSensitivity === 'secret' ? false : item.row.sensitiveCredential,
            sensitivePii: targetSensitivity === 'secret' ? false : item.row.sensitivePii,
            sensitiveFindings: targetSensitivity === 'secret' ? [] : item.row.sensitiveFindings,
            plaintextIgnoredHash:
              targetSensitivity === 'secret' ? null : item.row.plaintextIgnoredHash,
            updatedAt: now,
          })
          .where(eq(entryVariants.id, item.row.id))
          .returning()
        finalVariants.push(uRow!)
      }

      if (targetSensitivity === 'secret') {
        await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, before.id))
        await tx.delete(entryLinks).where(eq(entryLinks.sourceEntryId, before.id))
      }

      if (becameSecret && secretHeadings) {
        await this.scrubEntryHistoryForSecret(tx, before.id, before.shortId, secretHeadings)
      }
      const rawBeforeProtect = toStoredSnapshot(before, decoded, glossary)
      const recordedBeforeProtect =
        becameSecret && secretHeadings
          ? scrubSnapshotForSecret(rawBeforeProtect, secretHeadings, before.shortId).next!
          : rawBeforeProtect
      await this.writeEvent(tx, {
        circleId,
        entryId: before.id,
        type: 'protect',
        provenance: this.ctx.access.writeProvenance,
        before: recordedBeforeProtect,
        after: toStoredSnapshot(updated!, decoded, glossary),
      })

      return (await this.assembleEntryView(tx, updated!, finalVariants, glossary, {
        circleSlug: meta.slug,
        circleKind: meta.kind,
        revealContent: false,
        now,
      })) as ConsoleEntryView
    })
    if (request.target !== 'secret') this.ctx.onChanged?.(circleId, request.entryId)
    return res
  }

  private async verifyConvertible(
    tx: Tx,
    now: Date,
    request: Pick<ConvertToCredentialRequest, 'entryId' | 'expectedVersion' | 'value'>,
    lock: boolean,
  ): Promise<{ before: EntryRow; variantRows: VariantRow[] }> {
    const query = tx.select().from(entries).where(eq(entries.id, request.entryId))
    const [before] = await (lock ? query.for('update') : query).limit(1)
    if (
      !before ||
      before.deletedAt !== null ||
      !canRead(this.ctx.access, parseEntryFacts(before), { now, management: true })
    ) {
      throw new MemoryError(404, '未找到词条')
    }
    if (!canModify(this.ctx.access, before)) throw new MemoryError(403, '无权修改此词条')
    if (before.sensitivity === 'secret') {
      throw new MemoryError(400, '机密词条已加密保存，不能再转存凭据占位符')
    }
    if (!placeholderAllowed(before.circleKind, before.kind, before.sensitivity)) {
      throw new MemoryError(400, CONVERT_SCOPE_TEXT)
    }
    checkExpected(before, request.expectedVersion)

    const [variantRows, glossaryRows] = await Promise.all([
      tx
        .select()
        .from(entryVariants)
        .where(eq(entryVariants.entryId, before.id))
        .orderBy(asc(entryVariants.sortOrder)),
      tx
        .select({ keyword: entryGlossary.keyword })
        .from(entryGlossary)
        .where(eq(entryGlossary.entryId, before.id)),
    ])
    if (
      before.title.includes(request.value) ||
      Boolean(before.disclosure?.includes(request.value)) ||
      glossaryRows.some((g) => g.keyword.includes(request.value))
    ) {
      throw new MemoryError(
        400,
        '标题、触发场景或关键词中也有这段值。这些字段是明文，也不能放占位符。请先从这些字段去掉，再转存。',
      )
    }
    const matchesAny = variantRows.some((v) => (v.content ?? '').includes(request.value))
    if (!matchesAny) {
      throw new MemoryError(400, '词条所有变体正文中都不含这段要转存的值')
    }
    const replaceable = variantRows.some(
      (v) =>
        replaceOutsidePlaceholders(v.content ?? '', request.value, '{{cred:c#f}}').replaced > 0,
    )
    if (!replaceable) {
      throw new MemoryError(400, '该值只出现在已有占位符中，没有可替换的明文片段')
    }
    return { before, variantRows }
  }

  // 转存写入外部密码库之前在短事务内预检查，避免外部密码库留下孤立条目
  async checkConvertible(
    request: Pick<ConvertToCredentialRequest, 'entryId' | 'expectedVersion' | 'value'>,
  ): Promise<void> {
    const circleId = this.ctx.access.primaryCircleId
    await withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        await this.verifyConvertible(tx, now, request, false)
      },
      { accessMode: 'read only' },
    )
  }

  async convertToCredential<TCredential = unknown>(
    request: ConvertToCredentialRequest,
    saveCredential: (
      tx: Tx,
      target: ConvertToCredentialRequest['target'],
      value: string,
    ) => Promise<{
      identifier: string
      field: string
      credential?: TCredential
      loadCredential?: (tx: Tx) => Promise<TCredential>
      created: boolean
      storedIn: CredentialStoredIn | null
    }>,
  ): Promise<{
    entry: ConsoleEntryView
    credential: TCredential
    created: boolean
    storedIn: CredentialStoredIn | null
    field: string
    replaced: number
    scrubbedEvents: number
    plaintextVersions: number
    otherEntries: number
  }> {
    const circleId = this.ctx.access.primaryCircleId
    const memberRows = await this.ctx.db
      .select({ circleId: circleMembers.circleId })
      .from(circleMembers)
      .where(eq(circleMembers.accountId, this.ctx.access.ownerAccountId))
    const memberCircleIds = [...new Set([circleId, ...memberRows.map((r) => r.circleId)])]
    const out = await withCircles(
      this.ctx.db,
      { read: memberCircleIds, write: [circleId] },
      async (tx, now) => {
        const { before, variantRows } = await this.verifyConvertible(tx, now, request, true)

        const saved = await saveCredential(tx, request.target, request.value)
        const placeholder = `{{cred:${saved.identifier}#${saved.field}}}`

        const [{ settings: privacy }, glossaryRows, circleMetaMap] = await Promise.all([
          loadCirclePrivacy(tx, circleId),
          tx
            .select({ keyword: entryGlossary.keyword })
            .from(entryGlossary)
            .where(eq(entryGlossary.entryId, before.id)),
          this.loadCircleMetaMap(tx),
        ])

        let totalReplaced = 0
        const updatedVariants: VariantRow[] = []
        const beforeVariants: { when: WhenCondition; content: string | null }[] = []

        for (const v of variantRows) {
          const plain = v.content ?? ''
          beforeVariants.push({ when: normalizeWhen(v.when), content: plain })
          const rep = replaceOutsidePlaceholders(plain, request.value, placeholder)
          if (rep.text.length > ENTRY_CONTENT_MAX) {
            throw new MemoryError(400, '替换占位符后超出正文长度上限')
          }
          totalReplaced += rep.replaced
          const outcome = evaluateSensitiveContent(rep.text, privacy)
          const [uRow] = await tx
            .update(entryVariants)
            .set({
              content: rep.text,
              sensitiveCredential: outcome.hasCredential,
              sensitivePii: outcome.hasPii,
              sensitiveFindings: outcome.findings,
              plaintextIgnoredHash: null,
              updatedAt: now,
            })
            .where(eq(entryVariants.id, v.id))
            .returning()
          updatedVariants.push(uRow!)
        }

        if (totalReplaced === 0) {
          throw new MemoryError(400, '该值只出现在已有占位符中，没有可替换的明文片段')
        }

        const allCreds = new Set<string>()
        for (const v of updatedVariants) {
          for (const id of placeholderIdentifiers(v.content ?? '')) allCreds.add(id)
        }
        await syncCredentialRefs(tx, circleId, before.id, allCreds)
        await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, before.id))

        const [updated] = await tx
          .update(entries)
          .set({ version: before.version + 1, updatedAt: updatedAtFor(now) })
          .where(eq(entries.id, before.id))
          .returning()

        // 清理本词条所有历史事件快照中的明文值（跳过既有凭据占位符）
        const histEvents = await tx
          .select()
          .from(entryEvents)
          .where(eq(entryEvents.entryId, before.id))
        let scrubbedEvents = 0
        const plaintextVersions = new Set<number>()
        const maskBody = (s: string) =>
          replaceOutsidePlaceholders(s, request.value, PLAINTEXT_MASK).text
        const scrubSnapshot = (
          snap: Record<string, unknown> | null,
        ): { next: Record<string, unknown> | null; changed: boolean } => {
          if (!snap || typeof snap !== 'object') return { next: snap, changed: false }
          let changed = false
          const copy = { ...snap }
          if ('fts' in copy) {
            delete copy.fts
            changed = true
          }
          if (typeof copy.title === 'string' && copy.title.includes(request.value)) {
            copy.title = copy.title.split(request.value).join(PLAINTEXT_MASK)
            changed = true
          }
          if (typeof copy.disclosure === 'string' && copy.disclosure.includes(request.value)) {
            copy.disclosure = copy.disclosure.split(request.value).join(PLAINTEXT_MASK)
            changed = true
          }
          if (Array.isArray(copy.glossary)) {
            const nextGlossary = copy.glossary.filter(
              (item) => !(typeof item === 'string' && item.includes(request.value)),
            )
            if (nextGlossary.length !== copy.glossary.length) {
              copy.glossary = nextGlossary
              changed = true
            }
          }
          if (typeof copy.content === 'string') {
            const masked = maskBody(copy.content)
            if (masked !== copy.content) {
              copy.content = masked
              changed = true
            }
          }
          if (Array.isArray(copy.variants)) {
            copy.variants = copy.variants.map((item) => {
              if (!item || typeof item !== 'object') return item
              const rec = item as Record<string, unknown>
              if (typeof rec.content === 'string') {
                const masked = maskBody(rec.content)
                if (masked !== rec.content) {
                  changed = true
                  return { ...rec, content: masked }
                }
              }
              return item
            })
          }
          if (typeof copy.version === 'number' && copy.version < before.version) {
            const variantTexts: string[] = []
            if (typeof copy.content === 'string') variantTexts.push(copy.content)
            if (Array.isArray(copy.variants)) {
              for (const item of copy.variants) {
                if (item && typeof item === 'object') {
                  const txt = (item as Record<string, unknown>).content
                  if (typeof txt === 'string') variantTexts.push(txt)
                }
              }
            }
            if (variantTexts.some((txt) => evaluateSensitiveContent(txt, privacy).hasCredential)) {
              plaintextVersions.add(copy.version)
            }
          }
          return { next: copy, changed }
        }

        for (const ev of histEvents) {
          const b = scrubSnapshot(ev.before as Record<string, unknown> | null)
          const a = scrubSnapshot(ev.after as Record<string, unknown> | null)
          if (b.changed || a.changed) {
            scrubbedEvents++
            await tx
              .update(entryEvents)
              .set({ before: b.next, after: a.next })
              .where(eq(entryEvents.id, ev.id))
          }
        }

        const optPlainMask = (text: string | null) =>
          text === null || !text.includes(request.value)
            ? text
            : text.split(request.value).join(PLAINTEXT_MASK)
        const optBodyMask = (text: string | null) => (text === null ? null : maskBody(text))
        const suggRows = await tx
          .select({
            id: dreamSuggestions.id,
            title: dreamSuggestions.title,
            content: dreamSuggestions.content,
            variants: dreamSuggestions.variants,
            disclosure: dreamSuggestions.disclosure,
            reason: dreamSuggestions.reason,
          })
          .from(dreamSuggestions)
          .where(
            and(
              eq(dreamSuggestions.circleId, circleId),
              sql`${before.id}::uuid = any(${dreamSuggestions.entryIds})`,
            ),
          )
        for (const s of suggRows) {
          const nextTitleS = optPlainMask(s.title)
          const nextDisclosureS = optPlainMask(s.disclosure)
          const nextReasonS = s.reason.includes(request.value)
            ? s.reason.split(request.value).join(PLAINTEXT_MASK)
            : s.reason
          const nextContentS = optBodyMask(s.content)
          const nextVariantsS = s.variants
            ? s.variants.map((v) => ({ ...v, content: maskBody(v.content) }))
            : null
          if (
            nextTitleS !== s.title ||
            nextDisclosureS !== s.disclosure ||
            nextReasonS !== s.reason ||
            nextContentS !== s.content ||
            JSON.stringify(nextVariantsS) !== JSON.stringify(s.variants)
          ) {
            await tx
              .update(dreamSuggestions)
              .set({
                title: nextTitleS,
                disclosure: nextDisclosureS,
                reason: nextReasonS,
                content: nextContentS,
                variants: nextVariantsS,
              })
              .where(eq(dreamSuggestions.id, s.id))
          }
        }

        const candidateRows = await tx
          .select({
            id: entries.id,
            title: entries.title,
            disclosure: entries.disclosure,
          })
          .from(entries)
          .where(
            and(
              inArray(entries.circleId, memberCircleIds),
              or(
                ne(entries.circleKind, 'personal'),
                eq(entries.ownerAccountId, this.ctx.access.ownerAccountId),
              ),
              ne(entries.id, before.id),
              ne(entries.sensitivity, 'secret'),
              or(
                sql`position(${request.value} in ${entries.title}) > 0`,
                sql`position(${request.value} in coalesce(${entries.disclosure}, '')) > 0`,
                exists(
                  tx
                    .select({ one: sql`1` })
                    .from(entryGlossary)
                    .where(
                      and(
                        eq(entryGlossary.entryId, entries.id),
                        sql`position(${request.value} in ${entryGlossary.keyword}) > 0`,
                      ),
                    ),
                ),
                exists(
                  tx
                    .select({ one: sql`1` })
                    .from(entryVariants)
                    .where(
                      and(
                        eq(entryVariants.entryId, entries.id),
                        sql`position(${request.value} in ${entryVariants.content}) > 0`,
                      ),
                    ),
                ),
              ),
            ),
          )
        const matchedOtherIds = new Set<string>()
        const remainingIds: string[] = []
        for (const c of candidateRows) {
          if (c.title.includes(request.value) || c.disclosure?.includes(request.value)) {
            matchedOtherIds.add(c.id)
          } else {
            remainingIds.push(c.id)
          }
        }
        if (remainingIds.length) {
          const [remGlossary, remVariants] = await Promise.all([
            tx
              .select({ entryId: entryGlossary.entryId, keyword: entryGlossary.keyword })
              .from(entryGlossary)
              .where(inArray(entryGlossary.entryId, remainingIds)),
            tx
              .select({ entryId: entryVariants.entryId, content: entryVariants.content })
              .from(entryVariants)
              .where(inArray(entryVariants.entryId, remainingIds)),
          ])
          for (const g of remGlossary) {
            if (g.keyword.includes(request.value)) matchedOtherIds.add(g.entryId)
          }
          for (const v of remVariants) {
            if (replaceOutsidePlaceholders(v.content ?? '', request.value, '').replaced > 0) {
              matchedOtherIds.add(v.entryId)
            }
          }
        }

        const glossary = glossaryRows.map((g) => g.keyword)
        await syncEntryLinks(tx, {
          circleId,
          entryId: before.id,
          shortId: before.shortId,
          sensitivity: before.sensitivity,
          provenance: before.provenance,
          variants: updatedVariants.map((v) => ({ id: v.id, content: v.content })),
        })

        await this.writeEvent(tx, {
          circleId,
          entryId: before.id,
          type: 'convert_credential',
          provenance: this.ctx.access.writeProvenance,
          before: toStoredSnapshot(
            before,
            beforeVariants.map((v) => ({
              when: v.when,
              content: v.content === null ? null : maskBody(v.content),
            })),
            glossary,
          ),
          after: toStoredSnapshot(
            updated!,
            updatedVariants.map((v) => ({ when: normalizeWhen(v.when), content: v.content })),
            glossary,
          ),
          context: { identifier: saved.identifier, field: saved.field },
        })

        const meta = circleMetaMap.get(circleId)!
        const view = (await this.assembleEntryView(tx, updated!, updatedVariants, glossary, {
          circleSlug: meta.slug,
          circleKind: meta.kind,
          revealContent: false,
          now,
        })) as ConsoleEntryView

        const credential = saved.loadCredential
          ? await saved.loadCredential(tx)
          : (saved.credential as TCredential)
        return {
          entry: view,
          credential,
          created: saved.created,
          storedIn: saved.storedIn,
          field: saved.field,
          replaced: totalReplaced,
          scrubbedEvents,
          plaintextVersions: plaintextVersions.size,
          otherEntries: matchedOtherIds.size,
        }
      },
    )
    this.ctx.onChanged?.(circleId, request.entryId)
    return out
  }

  async reviewList(query: ReviewQuery): Promise<ReviewList> {
    const circleId = this.ctx.access.primaryCircleId
    const after = decodeTimeCursor(query.cursor, UUID)
    if (after === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const cond = and(
          pendingReview(this.ctx.access, now),
          query.kind ? eq(entries.kind, query.kind) : undefined,
        )
        const page = tx.$with('page').as(
          tx
            .select({
              id: entries.id,
              createdAt: entries.createdAt,
              micros: sql<string>`${microsOf(entries.createdAt)}::text`.as('micros'),
              total: sql<number>`count(*) over ()`.mapWith(Number).as('total'),
            })
            .from(entries)
            .where(
              and(
                cond,
                after
                  ? sql`(${entries.createdAt}, ${entries.id}) < (${fromMicros(after[0])}, ${after[1]}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(desc(entries.createdAt), desc(entries.id))
            .limit(51),
        )
        const rows = await tx
          .with(page)
          .select({
            entry: entries,
            micros: page.micros,
            total: page.total,
            subjectName: subjects.displayName,
            subjectKind: subjects.kind,
          })
          .from(page)
          .innerJoin(entries, eq(entries.id, page.id))
          .leftJoin(subjects, eq(subjects.id, entries.subjectId))
          .orderBy(desc(page.createdAt), desc(page.id))

        const shown = rows.slice(0, 50)
        const variantRows = shown.length
          ? await tx
              .select()
              .from(entryVariants)
              .where(
                inArray(
                  entryVariants.entryId,
                  shown.map((r) => r.entry.id),
                ),
              )
              .orderBy(asc(entryVariants.sortOrder))
          : []
        const primaryContent = new Map<string, string>()
        for (const v of variantRows) {
          if (!primaryContent.has(v.entryId)) primaryContent.set(v.entryId, v.content ?? '')
        }

        const named = await scopeNames(
          tx,
          shown.map((r) => r.entry.originScope),
        )
        const last = shown.at(-1)
        return {
          items: shown.map(({ entry, subjectName, subjectKind }) => ({
            id: entry.id,
            shortId: entry.shortId,
            title: entry.title,
            kind: entry.kind as 'fact' | 'episode',
            content: primaryContent.get(entry.id) ?? '',
            subject:
              entry.subjectId && subjectName && subjectKind
                ? { id: entry.subjectId, kind: subjectKind, displayName: subjectName }
                : null,
            scope: named(entry.originScope),
            version: entry.version,
            createdAt: entry.createdAt.toISOString(),
          })),
          total: after ? null : (rows[0]?.total ?? 0),
          nextCursor:
            rows.length > 50 && last ? encodeTimeCursor(last.micros, last.entry.id) : null,
        }
      },
      { accessMode: 'read only' },
    )
  }

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const circleId = this.ctx.access.primaryCircleId
    const seen = new Map(request.items.map((i) => [i.id, i.version]))
    const changed: string[] = []
    const res = await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const rows = await tx
        .select()
        .from(entries)
        .where(and(inArray(entries.id, [...seen.keys()]), pendingReview(this.ctx.access, now)))
        .orderBy(asc(entries.id))
        .for('no key update', { skipLocked: true })
      const targets = rows.filter((r) => seen.get(r.id) === r.version)
      if (!targets.length) return { done: 0, skipped: seen.size }
      for (const row of targets) {
        if (!canModify(this.ctx.access, row)) {
          throw new MemoryError(403, '无权处理该词条')
        }
      }

      const targetIds = targets.map((r) => r.id)
      const variantsAll = await tx
        .select()
        .from(entryVariants)
        .where(inArray(entryVariants.entryId, targetIds))
        .orderBy(asc(entryVariants.sortOrder))
      const vByEntry = new Map<string, VariantRow[]>()
      for (const v of variantsAll) {
        const list = vByEntry.get(v.entryId) ?? []
        list.push(v)
        vByEntry.set(v.entryId, list)
      }

      for (const before of targets) {
        const vRows = vByEntry.get(before.id) ?? []
        const snapV = vRows.map((v) => ({ when: normalizeWhen(v.when), content: v.content ?? '' }))

        if (request.action === 'delete') {
          const [after] = await tx
            .update(entries)
            .set({ deletedAt: now, version: before.version + 1, updatedAt: updatedAtFor(now) })
            .where(eq(entries.id, before.id))
            .returning()
          await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, before.id))
          await tx.delete(entryLinks).where(eq(entryLinks.sourceEntryId, before.id))
          await this.writeEvent(tx, {
            circleId,
            entryId: before.id,
            type: 'delete',
            provenance: this.ctx.access.writeProvenance,
            before: toStoredSnapshot(before, snapV, []),
            after: toStoredSnapshot(after!, snapV, []),
          })
          changed.push(before.id)
          continue
        }

        const nextProvenance: Provenance = this.isConsole ? 'owner' : 'agent'
        const [after] = await tx
          .update(entries)
          .set({
            provenance: nextProvenance,
            version: before.version + 1,
            updatedAt: updatedAtFor(now),
          })
          .where(eq(entries.id, before.id))
          .returning()
        await syncEntryLinks(tx, {
          circleId,
          entryId: before.id,
          shortId: before.shortId,
          sensitivity: before.sensitivity,
          provenance: nextProvenance,
          variants: vRows.map((v) => ({ id: v.id, content: v.content })),
        })
        await this.writeEvent(tx, {
          circleId,
          entryId: before.id,
          type: 'confirm',
          provenance: this.ctx.access.writeProvenance,
          before: toStoredSnapshot(before, snapV, []),
          after: toStoredSnapshot(after!, snapV, []),
        })
        changed.push(before.id)
      }
      return { done: targets.length, skipped: seen.size - targets.length }
    })
    for (const entryId of changed) this.ctx.onChanged?.(circleId, entryId)
    return res
  }

  async undelete(request: UndeleteRequest): Promise<ConsoleEntryView> {
    const circleId = this.ctx.access.primaryCircleId
    const res = await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const [before] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, request.entryId))
        .for('update')
        .limit(1)
      if (
        !before ||
        !canRead(this.ctx.access, parseEntryFacts(before), { now, management: true })
      ) {
        throw new MemoryError(404, '未找到词条')
      }
      if (before.deletedAt === null) {
        throw new MemoryError(409, '词条未被删除')
      }
      if (!canModify(this.ctx.access, before)) throw new MemoryError(403, '无权恢复此词条')

      const [after] = await tx
        .update(entries)
        .set({ deletedAt: null, version: before.version + 1, updatedAt: updatedAtFor(now) })
        .where(eq(entries.id, before.id))
        .returning()
      const [vRows, glossaryRows, metaMap] = await Promise.all([
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, before.id))
          .orderBy(asc(entryVariants.sortOrder)),
        tx
          .select({ keyword: entryGlossary.keyword })
          .from(entryGlossary)
          .where(eq(entryGlossary.entryId, before.id)),
        this.loadCircleMetaMap(tx),
      ])
      const decoded = vRows.map((v) => ({
        when: normalizeWhen(v.when),
        content: before.sensitivity === 'secret' ? null : (v.content ?? ''),
      }))
      const glossary = glossaryRows.map((g) => g.keyword)

      await syncEntryLinks(tx, {
        circleId,
        entryId: before.id,
        shortId: before.shortId,
        sensitivity: after!.sensitivity,
        provenance: after!.provenance,
        variants: vRows.map((v) => ({ id: v.id, content: v.content })),
      })

      await this.writeEvent(tx, {
        circleId,
        entryId: before.id,
        type: 'undelete',
        provenance: this.ctx.access.writeProvenance,
        before: toStoredSnapshot(before, decoded, glossary),
        after: toStoredSnapshot(after!, decoded, glossary),
      })
      const meta = metaMap.get(circleId)!
      return (await this.assembleEntryView(tx, after!, vRows, glossary, {
        circleSlug: meta.slug,
        circleKind: meta.kind,
        revealContent: false,
        now,
      })) as ConsoleEntryView
    })
    this.ctx.onChanged?.(circleId, request.entryId)
    return res
  }

  async reactivate(request: ReactivateRequest): Promise<ConsoleEntryView> {
    const circleId = this.ctx.access.primaryCircleId
    const res = await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const [before] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, request.entryId))
        .for('update')
        .limit(1)
      if (
        !before ||
        !canRead(this.ctx.access, parseEntryFacts(before), { now, management: true })
      ) {
        throw new MemoryError(404, '未找到词条')
      }
      if (before.deletedAt !== null) throw new MemoryError(409, '请先恢复已删除的词条')
      if (!canModify(this.ctx.access, before)) throw new MemoryError(403, '无权操作此词条')
      checkExpected(before, request.expectedVersion)
      if (
        (before.validTo === null || before.validTo > now) &&
        (before.expiresAt === null || before.expiresAt > now)
      ) {
        throw new MemoryError(409, '词条当前仍有效')
      }

      const [after] = await tx
        .update(entries)
        .set({
          validTo: null,
          ...(before.expiresAt !== null && before.expiresAt <= now ? { expiresAt: null } : {}),
          version: before.version + 1,
          updatedAt: updatedAtFor(now),
        })
        .where(eq(entries.id, before.id))
        .returning()
      const [vRows, glossaryRows, metaMap] = await Promise.all([
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, before.id))
          .orderBy(asc(entryVariants.sortOrder)),
        tx
          .select({ keyword: entryGlossary.keyword })
          .from(entryGlossary)
          .where(eq(entryGlossary.entryId, before.id)),
        this.loadCircleMetaMap(tx),
      ])
      const decoded = vRows.map((v) => ({
        when: normalizeWhen(v.when),
        content: before.sensitivity === 'secret' ? null : (v.content ?? ''),
      }))
      const glossary = glossaryRows.map((g) => g.keyword)

      await this.writeEvent(tx, {
        circleId,
        entryId: before.id,
        type: 'reactivate',
        provenance: this.ctx.access.writeProvenance,
        before: toStoredSnapshot(before, decoded, glossary),
        after: toStoredSnapshot(after!, decoded, glossary),
      })
      const meta = metaMap.get(circleId)!
      return (await this.assembleEntryView(tx, after!, vRows, glossary, {
        circleSlug: meta.slug,
        circleKind: meta.kind,
        revealContent: false,
        now,
      })) as ConsoleEntryView
    })
    this.ctx.onChanged?.(circleId, request.entryId)
    return res
  }

  async deleteFact(subjectId: string, factId: string, expectedVersion: number): Promise<void> {
    const circleId = this.ctx.access.primaryCircleId
    await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const [before] = await tx
        .select()
        .from(entries)
        .where(
          and(eq(entries.id, factId), eq(entries.kind, 'fact'), eq(entries.subjectId, subjectId)),
        )
        .for('update')
        .limit(1)
      if (
        !before ||
        before.deletedAt !== null ||
        !canRead(this.ctx.access, parseEntryFacts(before), { now, management: true })
      ) {
        throw new MemoryError(404, '未找到事实')
      }
      if (!canModify(this.ctx.access, before)) throw new MemoryError(403, '无权删除此事实')
      checkExpected(before, expectedVersion)

      const [vRows, glossaryRows] = await Promise.all([
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, before.id))
          .orderBy(asc(entryVariants.sortOrder)),
        tx
          .select({ keyword: entryGlossary.keyword })
          .from(entryGlossary)
          .where(eq(entryGlossary.entryId, before.id)),
      ])
      const [after] = await tx
        .update(entries)
        .set({ deletedAt: now, version: before.version + 1, updatedAt: updatedAtFor(now) })
        .where(
          and(
            eq(entries.id, before.id),
            eq(entries.version, before.version),
            isNull(entries.deletedAt),
          ),
        )
        .returning()
      if (!after) {
        throw new MemoryError(409, '词条刚被其他请求修改，请重新读取')
      }

      await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, before.id))
      await tx.delete(entryLinks).where(eq(entryLinks.sourceEntryId, before.id))

      const decoded = vRows.map((v) => ({
        when: normalizeWhen(v.when),
        content: before.sensitivity === 'secret' ? null : (v.content ?? ''),
      }))
      const glossary = glossaryRows.map((g) => g.keyword)
      await this.writeEvent(tx, {
        circleId,
        entryId: before.id,
        type: 'delete',
        provenance: this.ctx.access.writeProvenance,
        before: toStoredSnapshot(before, decoded, glossary),
        after: toStoredSnapshot(after!, decoded, glossary),
      })
    })
  }

  async reactivateFact(subjectId: string, factId: string, expectedVersion: number): Promise<void> {
    const circleId = this.ctx.access.primaryCircleId
    await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const [before] = await tx
        .select()
        .from(entries)
        .where(
          and(eq(entries.id, factId), eq(entries.kind, 'fact'), eq(entries.subjectId, subjectId)),
        )
        .for('update')
        .limit(1)
      if (
        !before ||
        before.deletedAt !== null ||
        !canRead(this.ctx.access, parseEntryFacts(before), { now, management: true })
      ) {
        throw new MemoryError(404, '未找到事实')
      }
      if (!canModify(this.ctx.access, before)) throw new MemoryError(403, '无权操作此事实')
      checkExpected(before, expectedVersion)
      if (before.validTo === null || before.validTo > now) {
        throw new MemoryError(409, '该事实当前仍有效')
      }

      const [vRows, glossaryRows] = await Promise.all([
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, before.id))
          .orderBy(asc(entryVariants.sortOrder)),
        tx
          .select({ keyword: entryGlossary.keyword })
          .from(entryGlossary)
          .where(eq(entryGlossary.entryId, before.id)),
      ])
      const [after] = await tx
        .update(entries)
        .set({ validTo: null, version: before.version + 1, updatedAt: updatedAtFor(now) })
        .where(eq(entries.id, before.id))
        .returning()

      const decoded = vRows.map((v) => ({
        when: normalizeWhen(v.when),
        content: before.sensitivity === 'secret' ? null : (v.content ?? ''),
      }))
      const glossary = glossaryRows.map((g) => g.keyword)
      await this.writeEvent(tx, {
        circleId,
        entryId: before.id,
        type: 'reactivate',
        provenance: this.ctx.access.writeProvenance,
        before: toStoredSnapshot(before, decoded, glossary),
        after: toStoredSnapshot(after!, decoded, glossary),
      })
    })
    this.ctx.onChanged?.(circleId, factId)
  }

  async restore(request: RestoreRequest): Promise<ConsoleEntryView> {
    const circleId = this.ctx.access.primaryCircleId
    const res = await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const [before] = await tx
        .select()
        .from(entries)
        .where(eq(entries.id, request.entryId))
        .for('update')
        .limit(1)
      if (
        !before ||
        !canRead(this.ctx.access, parseEntryFacts(before), { now, management: true })
      ) {
        throw new MemoryError(404, '未找到词条')
      }
      if (!canModify(this.ctx.access, before)) throw new MemoryError(403, '无权回滚此词条')
      checkExpected(before, request.expectedVersion)

      const [ev] = await tx
        .select()
        .from(entryEvents)
        .where(
          and(
            eq(entryEvents.entryId, before.id),
            eq(entryEvents.id, request.eventId),
            sql`(${this.eventVisibility(now)} is false)`,
          ),
        )
        .limit(1)
      if (!ev || !ev.after) {
        throw new MemoryError(404, '此版本不存在')
      }
      const targetSnap = toPublicSnapshot(ev.after as Record<string, unknown>)
      if (!targetSnap || targetSnap.sensitivity === 'secret' || before.sensitivity === 'secret') {
        throw new MemoryError(400, '该历史版本不完整或为机密版本，无法回滚恢复')
      }

      const [metaMap, existingVariants, existingGlossaryRows, { settings: privacy }] =
        await Promise.all([
          this.loadCircleMetaMap(tx),
          tx.select().from(entryVariants).where(eq(entryVariants.entryId, before.id)),
          tx
            .select({ keyword: entryGlossary.keyword })
            .from(entryGlossary)
            .where(eq(entryGlossary.entryId, before.id)),
          loadCirclePrivacy(tx, circleId),
        ])
      const meta = metaMap.get(circleId)!
      const targetVariants = targetSnap.variants.filter(
        (v): v is { when: WhenCondition; content: string } => typeof v.content === 'string',
      )
      if (!targetVariants.length) {
        throw new MemoryError(400, '目标版本不含可恢复的明文变体')
      }

      const validatedRestore = validateCredentialPlaceholders(
        targetVariants.map((v) => v.content),
        meta.kind,
        before.kind,
        targetSnap.sensitivity,
      )
      const restoreBaseline =
        meta.kind === 'personal' &&
        before.ownerAccountId === this.ctx.access.ownerAccountId &&
        placeholderAllowed(meta.kind, before.kind, targetSnap.sensitivity)
          ? validatedRestore.identifiers
          : new Set<string>()
      await this.verifyAddedCredentialRefs(tx, {
        circleId,
        ownerAccountId: before.ownerAccountId,
        refs: validatedRestore.refs,
        baselineIdentifiers: restoreBaseline,
        isNonTrusted: before.provenance === 'untrusted',
      })

      const realms = normalizeRealms(targetVariants.flatMap((v) => v.when.realm ?? []))
      const nextGlossary = cleanGlossary(targetSnap.glossary)
      const nextTopics = cleanTopics(targetSnap.topics)
      const nextTitle = deriveEntryTitle(
        targetSnap.title,
        targetVariants,
        before.shortId,
        targetSnap.sensitivity,
      )
      const header = buildSearchHeader({
        sensitivity: targetSnap.sensitivity,
        title: nextTitle,
        topics: nextTopics,
        disclosure: targetSnap.disclosure,
        glossary: nextGlossary,
      })

      const [after] = await tx
        .update(entries)
        .set({
          title: nextTitle,
          sensitivity: targetSnap.sensitivity,
          priority: targetSnap.priority,
          disclosure: targetSnap.disclosure,
          topics: nextTopics,
          realms,
          validTo: targetSnap.validTo ? new Date(targetSnap.validTo) : null,
          deletedAt: null,
          version: before.version + 1,
          updatedAt: updatedAtFor(now),
        })
        .where(eq(entries.id, before.id))
        .returning()

      await tx.delete(entryVariants).where(eq(entryVariants.entryId, before.id))
      const createdVariants: VariantRow[] = []
      const allCreds = new Set<string>()
      for (let i = 0; i < targetVariants.length; i++) {
        const v = targetVariants[i]!
        const outcome = evaluateSensitiveContent(v.content, privacy)
        for (const c of placeholderIdentifiers(v.content)) allCreds.add(c)
        const [iRow] = await tx
          .insert(entryVariants)
          .values({
            circleId,
            entryId: before.id,
            kind: after!.kind,
            sensitivity: after!.sensitivity,
            when: normalizeWhen(v.when),
            whenSignature: whenSignature(v.when),
            sortOrder: i,
            content: v.content,
            searchHeader: header,
            sensitiveCredential: outcome.hasCredential,
            sensitivePii: outcome.hasPii,
            sensitiveFindings: outcome.findings,
          })
          .returning()
        createdVariants.push(iRow!)
      }

      await tx.delete(entryGlossary).where(eq(entryGlossary.entryId, before.id))
      if (nextGlossary.length) {
        await tx
          .insert(entryGlossary)
          .values(nextGlossary.map((keyword) => ({ circleId, entryId: before.id, keyword })))
      }
      await syncCredentialRefs(
        tx,
        circleId,
        before.id,
        after!.sensitivity === 'secret' ? new Set() : allCreds,
      )
      await syncEntryLinks(tx, {
        circleId,
        entryId: before.id,
        shortId: before.shortId,
        sensitivity: after!.sensitivity,
        provenance: after!.provenance,
        variants: createdVariants.map((v) => ({ id: v.id, content: v.content })),
      })

      await this.writeEvent(tx, {
        circleId,
        entryId: before.id,
        type: 'restore',
        provenance: this.ctx.access.writeProvenance,
        before: toStoredSnapshot(
          before,
          existingVariants.map((v) => ({ when: normalizeWhen(v.when), content: v.content })),
          existingGlossaryRows.map((g) => g.keyword),
        ),
        after: toStoredSnapshot(after!, targetVariants, nextGlossary),
        context: { restoredFromEventId: request.eventId },
      })

      return (await this.assembleEntryView(tx, after!, createdVariants, nextGlossary, {
        circleSlug: meta.slug,
        circleKind: meta.kind,
        revealContent: false,
        now,
      })) as ConsoleEntryView
    })
    this.ctx.onChanged?.(circleId, request.entryId)
    return res
  }

  private snapshotShown(snapshot: SQLWrapper, now: Date): SQL {
    return sql`(${snapshot} is not null and coalesce((${readableConditions(this.ctx.access, { now, management: true }, snapshotColumns(snapshot))}), false))`
  }

  private eventVisibility(now: Date, memoryOk?: SQL): SQL<boolean | null> {
    const { before, after } = entryEvents
    const beforeShown = this.snapshotShown(before, now)
    const beforeOk = sql`(${before} is null or ${beforeShown})`
    const afterOk = sql`(${after} is null or ${this.snapshotShown(after, now)})`
    return sql<boolean | null>`(case
      when ${memoryOk ?? sql`true`} then (case when ${afterOk} then (case when ${beforeOk} then false end) when ${beforeShown} then true end)
      when ${beforeShown} and not ${afterOk} then true
    end)`
  }

  private keyVisibleSql(): SQL {
    return this.ctx.access.admin
      ? sql`true`
      : sql`${clients.ownerAccountId} = ${this.ctx.access.ownerAccountId}`
  }

  async history(entryId: string): Promise<EntryHistory> {
    const circleId = this.ctx.access.primaryCircleId
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const [entry] = await tx.select().from(entries).where(eq(entries.id, entryId)).limit(1)
        if (
          !entry ||
          !canRead(this.ctx.access, parseEntryFacts(entry), { now, management: true })
        ) {
          throw new MemoryError(404, '未找到词条')
        }
        const visibility = this.eventVisibility(now)
        const keyVisible = this.keyVisibleSql()
        const selectEvent = () =>
          tx
            .select({
              event: entryEvents,
              accountName: accounts.displayName,
              keyName: sql<string | null>`case when ${keyVisible} then ${apiKeys.name} end`,
              clientName: clients.name,
              left: sql<boolean>`${visibility}`,
            })
            .from(entryEvents)
            .leftJoin(accounts, eq(accounts.id, entryEvents.actorAccountId))
            .leftJoin(apiKeys, eq(apiKeys.id, entryEvents.actorKeyId))
            .leftJoin(clients, eq(clients.id, apiKeys.clientId))

        const [changes, accessRows] = await Promise.all([
          selectEvent()
            .where(
              and(
                eq(entryEvents.entryId, entryId),
                ne(entryEvents.eventType, ACCESS_EVENT),
                sql`${visibility} is not null`,
              ),
            )
            .orderBy(desc(entryEvents.id))
            .limit(HISTORY_LIMIT + 1),
          entry.sensitivity === 'secret'
            ? selectEvent()
                .where(
                  and(
                    eq(entryEvents.entryId, entryId),
                    eq(entryEvents.eventType, ACCESS_EVENT),
                    sql`${visibility} is not null`,
                  ),
                )
                .orderBy(desc(entryEvents.id))
                .limit(ACCESS_HISTORY_LIMIT + 1)
            : [],
        ])

        const truncated = changes.length > HISTORY_LIMIT || accessRows.length > ACCESS_HISTORY_LIMIT
        const combined = [
          ...changes.slice(0, HISTORY_LIMIT),
          ...accessRows.slice(0, ACCESS_HISTORY_LIMIT),
        ].sort((a, b) => b.event.id - a.event.id)

        return {
          entry: {
            id: entry.id,
            shortId: entry.shortId,
            title: entry.title,
            kind: entry.kind,
            sensitivity: entry.sensitivity,
            version: entry.version,
            deletedAt: entry.deletedAt ? entry.deletedAt.toISOString() : null,
            validTo: entry.validTo ? entry.validTo.toISOString() : null,
          },
          events: combined.map((r) => {
            const left = Boolean(r.left)
            const ctxObj = r.event.context as Record<string, unknown> | null
            return {
              id: r.event.id,
              type: r.event.eventType,
              provenance: r.event.provenance,
              createdAt: r.event.createdAt.toISOString(),
              actor: { accountName: r.accountName, keyName: r.keyName, clientName: r.clientName },
              via: typeof ctxObj?.via === 'string' ? ctxObj.via : null,
              before: toPublicSnapshot(r.event.before as Record<string, unknown> | null),
              after: left
                ? null
                : toPublicSnapshot(r.event.after as Record<string, unknown> | null),
              left,
            }
          }),
          truncated,
        }
      },
      { accessMode: 'read only' },
    )
  }

  private activityEvents(
    tx: Tx,
    now: Date,
    filter: Partial<ActivityFilter>,
    options: { inner?: SQL | undefined; ordered?: boolean; eventFilters?: boolean } = {},
  ) {
    const keyVisible = this.keyVisibleSql()
    const eventFilters = options.eventFilters ?? true
    const pattern = filter.q ? `%${escapeLike(filter.q)}%` : undefined
    const visibility = this.eventVisibility(
      now,
      readableConditions(this.ctx.access, { now, management: true }),
    )
    const query = tx
      .select({
        id: entryEvents.id,
        type: entryEvents.eventType,
        entryId: entryEvents.entryId,
        before: detoasted(entryEvents.before).as('before'),
        after: detoasted(entryEvents.after).as('after'),
        context: entryEvents.context,
        createdAt: entryEvents.createdAt,
        createdMicros: sql<string>`${microsOf(entryEvents.createdAt)}::text`.as('created_micros'),
        shortId: entries.shortId,
        title: entries.title,
        entryKind: sql<EntryKind>`${entries.kind}`.as('entry_kind'),
        entrySensitivity: sql<Sensitivity>`${entries.sensitivity}`.as('entry_sensitivity'),
        entryDeleted: sql<boolean>`(${entries.deletedAt} is not null)`.as('entry_deleted'),
        entryExpired: sql<boolean>`(not ${stillValid(now)})`.as('entry_expired'),
        actorKey: sql<string>`${ACTOR_KEY}`.as('actor_key'),
        accountName: sql<string | null>`${accounts.displayName}`.as('account_name'),
        keyName: sql<string | null>`case when ${keyVisible} then ${apiKeys.name} end`.as(
          'key_name',
        ),
        clientName: sql<string | null>`${clients.name}`.as('client_name'),
        vis: sql<boolean | null>`${visibility}`.as('vis'),
      })
      .from(entryEvents)
      .innerJoin(entries, eq(entries.id, entryEvents.entryId))
      .leftJoin(accounts, eq(accounts.id, entryEvents.actorAccountId))
      .leftJoin(apiKeys, eq(apiKeys.id, entryEvents.actorKeyId))
      .leftJoin(clients, eq(clients.id, apiKeys.clientId))
      .where(
        and(
          ne(entryEvents.eventType, ACCESS_EVENT),
          filter.from ? sql`${entryEvents.createdAt} >= ${filter.from}::timestamptz` : undefined,
          filter.to ? sql`${entryEvents.createdAt} < ${filter.to}::timestamptz` : undefined,
          eventFilters && filter.type ? inArray(entryEvents.eventType, filter.type) : undefined,
          eventFilters && filter.actor ? inArray(ACTOR_KEY, filter.actor) : undefined,
          eventFilters && filter.exceptActor
            ? notInArray(ACTOR_KEY, filter.exceptActor)
            : undefined,
          pattern
            ? or(
                ilike(entries.title, pattern),
                ilike(entries.shortId, pattern),
                ilike(snapshotText(entryEvents.before, 'title'), pattern),
                ilike(snapshotText(entryEvents.before, 'shortId'), pattern),
              )
            : undefined,
          options.inner,
        ),
      )

    const sub = (
      options.ordered
        ? query.orderBy(desc(entryEvents.createdAt), desc(entryEvents.id)).offset(OFFSET_ZERO)
        : query.offset(OFFSET_ZERO)
    ).as('activity_events')

    const shown = {
      kind: sql<string>`(case when ${sub.vis} then coalesce(${snapshotText(sub.before, 'kind')}, ${sub.entryKind}::text) else ${sub.entryKind}::text end)`,
      title: sql<string>`(case when ${sub.vis} then coalesce(${snapshotText(sub.before, 'title')}, ${sub.title}) else ${sub.title} end)`,
      shortId: sql<string>`(case when ${sub.vis} then coalesce(${snapshotText(sub.before, 'shortId')}, ${sub.shortId}) else ${sub.shortId} end)`,
      fields: sql<
        string[]
      >`(case when ${sub.vis} is false then ${changedFieldsSql(sub.before, sub.after)} else '{}'::text[] end)`,
    }

    const conditions = {
      visible: sql`(${sub.vis} is not null)`,
      actor: and(
        filter.actor ? inArray(sub.actorKey, filter.actor) : undefined,
        filter.exceptActor ? notInArray(sub.actorKey, filter.exceptActor) : undefined,
      ),
      type: filter.type ? inArray(sub.type, filter.type) : undefined,
      kind: filter.kind ? inArray(shown.kind, filter.kind) : undefined,
      field: filter.field ? fieldCondition(shown.fields, filter.field) : undefined,
      q: pattern ? or(ilike(shown.title, pattern), ilike(shown.shortId, pattern)) : undefined,
    }
    return { sub, shown, conditions }
  }

  private toActivityItem(
    r: {
      id: number
      type: string
      entryId: string | null
      before: unknown
      after: unknown
      context: unknown
      createdAt: Date
      shortId: string
      title: string
      entryKind: EntryKind
      entrySensitivity: Sensitivity
      entryDeleted: boolean
      entryExpired: boolean
      actorKey: string
      accountName: string | null
      keyName: string | null
      clientName: string | null
      vis: boolean | null
    },
    benchReader: (context: unknown) => BenchMark | null,
  ): ActivityItem {
    const left = r.vis === true
    const beforePub = toPublicSnapshot(r.before as Record<string, unknown> | null)
    const afterPub = left ? null : toPublicSnapshot(r.after as Record<string, unknown> | null)
    const fields = !left && beforePub && afterPub ? changedFields(beforePub, afterPub) : []
    const fChanges =
      !left && beforePub && afterPub && fields.length
        ? fieldChanges(beforePub, afterPub, fields)
        : []
    return {
      id: r.id,
      type: r.type,
      entryId: r.entryId!,
      shortId: (left ? beforePub?.shortId : undefined) ?? r.shortId,
      title: (left ? beforePub?.title : undefined) ?? r.title,
      kind: (left ? beforePub?.kind : undefined) ?? r.entryKind,
      sensitivity: (left ? beforePub?.sensitivity : undefined) ?? r.entrySensitivity,
      createdAt: r.createdAt.toISOString(),
      actor: { accountName: r.accountName, keyName: r.keyName, clientName: r.clientName },
      actorKey: r.actorKey,
      changes: fields,
      fieldChanges: fChanges,
      versionBefore: beforePub?.version ?? null,
      versionAfter: afterPub?.version ?? null,
      left,
      deleted: !left && r.entryDeleted,
      expired: !left && r.entryExpired,
      bench: benchReader(r.context),
    }
  }

  async activity(
    query: ActivityFilter & { cursor?: string; limit: number },
  ): Promise<ActivityList> {
    const circleId = this.ctx.access.primaryCircleId
    const after = decodeTimeCursor(query.cursor, EVENT_ID)
    if (after === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const { sub, conditions } = this.activityEvents(tx, now, query, {
          ordered: true,
          inner: after
            ? sql`(${entryEvents.createdAt} < ${fromMicros(after[0])} or (${entryEvents.createdAt} = ${fromMicros(after[0])} and ${entryEvents.id} < ${after[1]}::bigint))`
            : undefined,
        })
        const rows = await tx
          .select()
          .from(sub)
          .where(and(...Object.values(conditions)))
          .orderBy(desc(sub.createdAt), desc(sub.id))
          .limit(query.limit + 1)

        const slice = rows.slice(0, query.limit)
        const benchReader = await benchMarkReader(
          tx,
          slice.map((r) => r.context),
        )
        const last = slice.at(-1)
        return {
          items: slice.map((r) => this.toActivityItem(r, benchReader)),
          nextCursor:
            rows.length > query.limit && last
              ? encodeTimeCursor(last.createdMicros, String(last.id))
              : null,
        }
      },
      { accessMode: 'read only' },
    )
  }

  async activityFacets(filter: ActivityFilter): Promise<ActivityFacets> {
    const circleId = this.ctx.access.primaryCircleId
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const { sub, shown, conditions } = this.activityEvents(tx, now, filter, {
          eventFilters: false,
        })
        const ok = (condition: SQL | undefined) => condition ?? sql`true`
        const base = sql`select ${sub.actorKey} as actor_key, ${sub.type} as type, ${shown.kind} as kind,
          ${shown.fields} as fields, ${ok(conditions.actor)} as actor_ok, ${ok(conditions.type)} as type_ok,
          ${ok(conditions.kind)} as kind_ok, ${ok(conditions.field)} as field_ok
          from ${sub} where ${and(conditions.visible, conditions.q)}`
        const rows = (await tx.execute(sql`with base as materialized (${base})
          select 'total' as g, null::text as k, count(*)::int as n from base
            where actor_ok and type_ok and kind_ok and field_ok
          union all select 'actor', actor_key, count(*)::int from base
            where type_ok and kind_ok and field_ok group by actor_key
          union all select 'type', type, count(*)::int from base
            where actor_ok and kind_ok and field_ok group by type
          union all select 'kind', kind, count(*)::int from base
            where actor_ok and type_ok and field_ok group by kind
          union all select 'field', f.k, count(*)::int from base
            cross join lateral unnest(case when cardinality(fields) = 0 then array['none']::text[] else fields end) as f(k)
            where actor_ok and type_ok and kind_ok group by f.k`)) as unknown as FacetRow[]

        const group = (g: string) =>
          rows.flatMap((r) =>
            r.g === g && r.k !== null && r.n > 0 ? [{ key: r.k, count: r.n }] : [],
          )
        const actorRows = group('actor')
        const ids = (prefix: string) =>
          actorRows.flatMap((r) => (r.key.startsWith(prefix) ? [r.key.slice(prefix.length)] : []))
        const accountIds = ids('account:')
        const clientIds = ids('client:')
        const [accountNames, clientNames] = await Promise.all([
          accountIds.length
            ? tx
                .select({ id: accounts.id, name: accounts.displayName })
                .from(accounts)
                .where(inArray(accounts.id, accountIds))
            : [],
          clientIds.length
            ? tx
                .select({ id: clients.id, name: clients.name })
                .from(clients)
                .where(inArray(clients.id, clientIds))
            : [],
        ])
        const names = new Map<string, string>([
          ...accountNames.map((r) => [`account:${r.id}`, r.name] as const),
          ...clientNames.map((r) => [`client:${r.id}`, r.name] as const),
        ])
        const actorKindOf = (k: string): 'account' | 'client' | 'bench' | 'unknown' =>
          k.startsWith('account:')
            ? 'account'
            : k.startsWith('client:')
              ? 'client'
              : k === 'bench'
                ? 'bench'
                : 'unknown'

        return {
          total: rows.find((r) => r.g === 'total')?.n ?? 0,
          actors: sortByCount(
            actorRows.map((r) => ({
              key: r.key,
              kind: actorKindOf(r.key),
              name: names.get(r.key) ?? null,
              count: r.count,
            })),
          ),
          types: sortByCount(
            group('type').flatMap((r) => {
              const type = ActivityType.safeParse(r.key)
              return type.success ? [{ type: type.data, count: r.count }] : []
            }),
          ),
          kinds: sortByCount(
            group('kind').flatMap((r) => {
              const kind = EntryKind.safeParse(r.key)
              return kind.success ? [{ kind: kind.data, count: r.count }] : []
            }),
          ),
          fields: sortByCount(
            group('field').flatMap((r) => {
              const field = ActivityFieldFilter.safeParse(r.key)
              return field.success ? [{ field: field.data, count: r.count }] : []
            }),
          ),
        }
      },
      { accessMode: 'read only' },
    )
  }

  async activityDays(query: ActivityDaysQuery): Promise<ActivityDays> {
    const circleId = this.ctx.access.primaryCircleId
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        if (!(await knownTimeZone(tx, query.tz))) {
          throw new UnknownTimeZoneError(query.tz)
        }
        const { sub, conditions } = this.activityEvents(tx, now, query)
        const dayExpr = sql`((${sub.createdAt} at time zone ${query.tz}::text)::date)`
        const rows = await tx
          .select({
            day: sql<string>`to_char(${dayExpr}, 'YYYY-MM-DD')`,
            count: count(),
          })
          .from(sub)
          .where(and(...Object.values(conditions)))
          .groupBy(sql`1`)
          .orderBy(sql`1`)
        return { days: rows.map((r) => ({ day: r.day, count: r.count })) }
      },
      { accessMode: 'read only' },
    )
  }

  async activityEvent(eventId: number): Promise<ActivityEvent> {
    const circleId = this.ctx.access.primaryCircleId
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const { sub, conditions } = this.activityEvents(
          tx,
          now,
          {},
          { inner: eq(entryEvents.id, eventId) },
        )
        const [r] = await tx.select().from(sub).where(conditions.visible).limit(1)
        if (!r) {
          throw new MemoryError(404, '未找到变更记录')
        }
        const benchReader = await benchMarkReader(tx, [r.context])
        const beforePub = toPublicSnapshot(r.before as Record<string, unknown> | null)
        const afterPub =
          r.vis === true ? null : toPublicSnapshot(r.after as Record<string, unknown> | null)
        return {
          item: this.toActivityItem(r, benchReader),
          before: beforePub,
          after: afterPub,
        }
      },
      { accessMode: 'read only' },
    )
  }

  async deletedList(query: {
    cursor?: string
    limit: number
  }): Promise<Pick<DeletedEntryList, 'items' | 'nextCursor'>> {
    const circleId = this.ctx.access.primaryCircleId
    const after = decodeTimeCursor(query.cursor, UUID)
    if (after === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const rows = await tx
          .select({ row: entries, micros: sql<string>`${microsOf(entries.deletedAt!)}::text` })
          .from(entries)
          .where(
            and(
              readableConditions(this.ctx.access, { now, management: true }),
              isNotNull(entries.deletedAt),
              after
                ? sql`(${entries.deletedAt}, ${entries.id}) < (${fromMicros(after[0])}, ${after[1]}::uuid)`
                : undefined,
            ),
          )
          .orderBy(desc(entries.deletedAt), desc(entries.id))
          .limit(query.limit + 1)
        const slice = rows.slice(0, query.limit)
        const last = slice.at(-1)
        return {
          items: slice.map(({ row }) => ({
            id: row.id,
            shortId: row.shortId,
            title: row.title,
            kind: row.kind,
            sensitivity: row.sensitivity,
            priority: row.priority,
            disclosure: row.disclosure,
            version: row.version,
            deletedAt: row.deletedAt!.toISOString(),
            validTo: row.validTo ? row.validTo.toISOString() : null,
          })),
          nextCursor:
            rows.length > query.limit && last ? encodeTimeCursor(last.micros, last.row.id) : null,
        }
      },
      { accessMode: 'read only' },
    )
  }

  async expiredList(query: { cursor?: string; limit: number }): Promise<ExpiredEntryList> {
    const circleId = this.ctx.access.primaryCircleId
    const after = decodeTimeCursor(query.cursor, UUID)
    if (after === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const moment = sql`${now.toISOString()}::timestamptz`
        const expiredAtCol = sql<Date>`coalesce(${entries.validTo}, ${entries.expiresAt})`
        const rows = await tx
          .select({
            row: entries,
            expiredAt: expiredAtCol,
            micros: sql<string>`${microsOf(expiredAtCol)}::text`,
          })
          .from(entries)
          .where(
            and(
              readableConditions(this.ctx.access, { now, management: true }),
              isNull(entries.deletedAt),
              or(sql`${entries.validTo} <= ${moment}`, sql`${entries.expiresAt} <= ${moment}`),
              after
                ? sql`(${expiredAtCol}, ${entries.id}) < (${fromMicros(after[0])}, ${after[1]}::uuid)`
                : undefined,
            ),
          )
          .orderBy(desc(expiredAtCol), desc(entries.id))
          .limit(query.limit + 1)
        const slice = rows.slice(0, query.limit)
        const last = slice.at(-1)
        return {
          items: slice.map(({ row, expiredAt }) => ({
            id: row.id,
            shortId: row.shortId,
            title: row.title,
            kind: row.kind,
            sensitivity: row.sensitivity,
            priority: row.priority,
            disclosure: row.disclosure,
            version: row.version,
            expiredAt: new Date(expiredAt).toISOString(),
          })),
          nextCursor:
            rows.length > query.limit && last ? encodeTimeCursor(last.micros, last.row.id) : null,
        }
      },
      { accessMode: 'read only' },
    )
  }

  async glossary(): Promise<GlossaryIndex> {
    const circleId = this.ctx.access.primaryCircleId
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const rows = await tx
          .select({ keyword: entryGlossary.keyword, shortId: entries.shortId })
          .from(entryGlossary)
          .innerJoin(entries, eq(entries.id, entryGlossary.entryId))
          .where(
            and(
              readableConditions(this.ctx.access, { now, explicit: Boolean(this.ctx.listSecret) }),
              this.ctx.listSecret ? undefined : ne(entries.sensitivity, 'secret'),
            ),
          )
          .orderBy(asc(entryGlossary.keyword), asc(entries.shortId))
          .limit(GLOSSARY_CAP + 1)
        const truncated = rows.length > GLOSSARY_CAP
        const byKw = new Map<string, string[]>()
        for (const r of rows.slice(0, GLOSSARY_CAP)) {
          const list = byKw.get(r.keyword) ?? []
          list.push(r.shortId)
          byKw.set(r.keyword, list)
        }
        return {
          entries: [...byKw.entries()].map(([keyword, shortIds]) => ({ keyword, shortIds })),
          truncated,
        }
      },
      { accessMode: 'read only' },
    )
  }

  async searchMatches(queryText: string, limit = 10): Promise<EntryMatch[]> {
    const readable = [...this.ctx.access.circles.keys()]
    if (!readable.length) return []
    const q = queryText.trim()
    if (!q) return []
    const pattern = `%${escapeLike(q)}%`
    return withCircles(
      this.ctx.db,
      { read: readable },
      async (tx, now) => {
        const metaMap = await this.loadCircleMetaMap(tx)
        const rows = await tx
          .select()
          .from(entries)
          .where(
            and(
              readableConditions(this.ctx.access, {
                now,
                explicit: Boolean(this.ctx.listSecret),
              }),
              this.ctx.listSecret ? undefined : ne(entries.sensitivity, 'secret'),
              or(
                eq(entries.shortId, q.toLowerCase()),
                ilike(entries.title, pattern),
                ilike(entries.disclosure, pattern),
              ),
            ),
          )
          .orderBy(asc(entries.priority), desc(entries.updatedAt))
          .limit(limit)
        return rows.map((r) => ({
          shortId: r.shortId,
          title: r.title,
          circleId: r.circleId,
          circleSlug: metaMap.get(r.circleId)?.slug ?? '',
          kind: r.kind,
          sensitivity: r.sensitivity,
          priority: r.priority,
          disclosure: r.disclosure,
          topics: [...r.topics],
        }))
      },
      { accessMode: 'read only' },
    )
  }

  async stats(): Promise<EntryStats> {
    const circleId = this.ctx.access.primaryCircleId
    const {
      settings: { retentionDays },
      recordingSince,
    } = await loadRecallWindow(this.ctx.db, circleId)
    return withCircle(
      this.ctx.db,
      circleId,
      async (tx, now) => {
        const readable = readableConditions(this.ctx.access, { now, explicit: this.isConsole })
        const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)
        const [grouped, missingRow, neverRow, plaintextCredentials, coverage] = await Promise.all([
          tx
            .select({ kind: entries.kind, sensitivity: entries.sensitivity, n: count() })
            .from(entries)
            .where(readable)
            .groupBy(entries.kind, entries.sensitivity),
          tx
            .select({ n: count() })
            .from(entries)
            .where(
              and(
                readable,
                this.ctx.listSecret ? undefined : ne(entries.sensitivity, 'secret'),
                NEEDS_DISCLOSURE,
              ),
            ),
          recordingSince.getTime() <= cutoff.getTime()
            ? tx
                .select({ n: count() })
                .from(entries)
                .leftJoin(entryRecallStats, eq(entryRecallStats.entryId, entries.id))
                .where(
                  and(
                    readable,
                    eq(entries.kind, 'entry'),
                    ne(entries.provenance, 'untrusted'),
                    ne(entries.sensitivity, 'secret'),
                    sql`${entries.priority} > 0`,
                    lte(entries.createdAt, cutoff),
                    or(isNull(entryRecallStats.count), eq(entryRecallStats.count, 0)),
                  ),
                )
                .then((r) => r[0]?.n ?? 0)
            : Promise.resolve(0),
          this.plaintextCount(),
          loadEmbeddingModels(tx).then((models) => {
            const activeModel = models.active?.model
            return countEmbeddable(tx, activeModel ? [activeModel] : [], readable)
          }),
        ])

        const counts: KindCount[] = []
        const extractedCounts: KindCount[] = []
        let total = 0
        for (const g of grouped) {
          const item: KindCount = { kind: g.kind, sensitivity: g.sensitivity, count: g.n }
          if (g.kind === 'entry') {
            counts.push(item)
            total += g.n
          } else {
            extractedCounts.push(item)
          }
        }

        return {
          counts,
          total,
          extractedCounts,
          missingDisclosure: missingRow[0]?.n ?? 0,
          plaintextCredentials,
          neverRecalled: neverRow,
          eligible: coverage.eligible,
          embedded: coverage.embedded[0] ?? 0,
        }
      },
      { accessMode: 'read only' },
    )
  }

  async applySuggestion(
    lock: (tx: Tx) => Promise<LockedSuggestion | null>,
    mark: (tx: Tx) => Promise<void>,
    eventMeta: Record<string, unknown>,
  ): Promise<{ id: string; shortId: string; title: string } | null> {
    if (!this.isConsole) throw new MemoryError(403, '整理建议只能由管理界面的成员处理')
    const circleId = this.ctx.access.primaryCircleId
    const affected: string[] = []
    const createdOrUpdated = await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const suggestion = await lock(tx)
      if (!suggestion) throw new MemoryError(404, '未找到整理建议')
      const ids = suggestion.entries.map((e) => e.id)
      const uniqueIds = [...new Set(ids)]
      const visibleRows = uniqueIds.length
        ? await tx.select().from(entries).where(inArray(entries.id, uniqueIds))
        : []
      if (
        visibleRows.length < uniqueIds.length ||
        visibleRows.some(
          (r) => !canRead(this.ctx.access, parseEntryFacts(r), { now, management: true }),
        )
      ) {
        throw new MemoryError(404, '未找到整理建议')
      }
      if (!suggestion.pending) throw new MemoryError(409, '这条建议已经处理过了')

      const rows = uniqueIds.length
        ? await tx
            .select()
            .from(entries)
            .where(inArray(entries.id, uniqueIds))
            .orderBy(asc(entries.id))
            .for('no key update', { skipLocked: true })
        : []
      if (rows.length < uniqueIds.length) {
        const locked = new Set(rows.map((r) => r.id))
        const missing = uniqueIds.filter((id) => !locked.has(id))
        const [present] = await tx
          .select({ n: count() })
          .from(entries)
          .where(inArray(entries.id, missing))
        throw new MemoryError(
          409,
          (present?.n ?? 0) < missing.length
            ? '涉及的词条已变动或过期，这条建议已作废'
            : '涉及的词条正在被其他请求修改，请稍后再试',
        )
      }
      const byId = new Map(rows.map((r) => [r.id, r]))
      for (const req of suggestion.entries) {
        const row = byId.get(req.id)
        if (
          !row ||
          row.version !== req.version ||
          row.deletedAt !== null ||
          lapsed(row, now) ||
          !canRead(this.ctx.access, parseEntryFacts(row), { now, management: true })
        ) {
          throw new MemoryError(409, '涉及的词条已变动或过期，这条建议已作废')
        }
      }

      const sources = suggestion.entries.map((e) => byId.get(e.id)!)
      for (const row of sources) {
        if (!canModify(this.ctx.access, row)) {
          throw new MemoryError(403, '无权修改该词条')
        }
      }
      const vRows = ids.length
        ? await tx
            .select()
            .from(entryVariants)
            .where(inArray(entryVariants.entryId, ids))
            .orderBy(asc(entryVariants.sortOrder))
        : []
      const vByEntry = new Map<string, VariantRow[]>()
      for (const v of vRows) {
        const list = vByEntry.get(v.entryId) ?? []
        list.push(v)
        vByEntry.set(v.entryId, list)
      }
      const enriched = sources.map((r) => ({
        ...r,
        primaryContent: vByEntry.get(r.id)?.[0]?.content ?? null,
      }))

      const action = suggestion.action(enriched)
      const [circleRow] = await tx.select().from(circles).where(eq(circles.id, circleId)).limit(1)
      const { settings: privacy } = await loadCirclePrivacy(tx, circleId)
      let primaryResult: { id: string; shortId: string; title: string } | null = null

      const snapVariants = (list: readonly { when: unknown; content: string | null }[]) =>
        list.map((v) => ({
          when: normalizeWhen((v.when as Record<string, string[]>) ?? {}),
          content: v.content,
        }))

      const softDeleteOthers = async (keepId: string, mergedInto?: string) => {
        for (const src of sources) {
          if (src.id === keepId) continue
          const srcV = snapVariants(vByEntry.get(src.id) ?? [])
          const [del] = await tx
            .update(entries)
            .set({ deletedAt: now, version: src.version + 1, updatedAt: updatedAtFor(now) })
            .where(eq(entries.id, src.id))
            .returning()
          await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, src.id))
          await tx.delete(entryLinks).where(eq(entryLinks.sourceEntryId, src.id))
          await this.writeEvent(tx, {
            circleId,
            entryId: src.id,
            type: 'delete',
            provenance: this.ctx.access.writeProvenance,
            before: toStoredSnapshot(src, srcV, []),
            after: toStoredSnapshot(del!, srcV, []),
            context: mergedInto ? { ...eventMeta, mergedInto } : eventMeta,
          })
          affected.push(src.id)
        }
      }

      if (action.kind === 'merge') {
        const keep = byId.get(action.keepId)
        if (!keep) throw new MemoryError(409, '保留目标不存在')
        const keepVariants = vByEntry.get(keep.id) ?? []
        const beforeSnap = toStoredSnapshot(keep, snapVariants(keepVariants), [])
        const firstV = keepVariants[0]
        if (firstV) {
          const outcome = evaluateSensitiveContent(action.content, privacy)
          await tx
            .update(entryVariants)
            .set({
              content: action.content,
              sensitiveCredential: outcome.hasCredential,
              sensitivePii: outcome.hasPii,
              sensitiveFindings: outcome.findings,
              plaintextIgnoredHash:
                firstV.content === action.content ? firstV.plaintextIgnoredHash : null,
              updatedAt: now,
            })
            .where(eq(entryVariants.id, firstV.id))
        }
        const [uKeep] = await tx
          .update(entries)
          .set({ provenance: 'owner', version: keep.version + 1, updatedAt: updatedAtFor(now) })
          .where(eq(entries.id, keep.id))
          .returning()
        await syncEntryLinks(tx, {
          circleId,
          entryId: keep.id,
          shortId: keep.shortId,
          sensitivity: keep.sensitivity,
          provenance: 'owner',
          variants: [{ id: firstV?.id ?? keep.id, content: action.content }],
        })
        await softDeleteOthers(keep.id, keep.id)
        const afterV = firstV
          ? [
              { when: normalizeWhen(firstV.when), content: action.content },
              ...snapVariants(keepVariants.slice(1)),
            ]
          : [{ when: {}, content: action.content }]
        await this.writeEvent(tx, {
          circleId,
          entryId: keep.id,
          type: 'update',
          provenance: this.ctx.access.writeProvenance,
          before: beforeSnap,
          after: toStoredSnapshot(uKeep!, afterV, []),
          context: {
            ...eventMeta,
            mergedFrom: sources.filter((s) => s.id !== keep.id).map((s) => s.id),
          },
        })
        affected.push(keep.id)
      } else if (action.kind === 'merge_variants' || action.kind === 'generalize') {
        const targetId = action.kind === 'merge_variants' ? action.keepId : action.targetId
        const keep = byId.get(targetId)
        if (!keep) throw new MemoryError(409, '目标词条不存在')
        const beforeSnap = toStoredSnapshot(keep, snapVariants(vByEntry.get(keep.id) ?? []), [])
        await tx.delete(entryVariants).where(eq(entryVariants.entryId, keep.id))
        const realms = normalizeRealms(
          action.variants.flatMap((v) => normalizeWhen(v.when).realm ?? []),
        )
        const header = buildSearchHeader({
          sensitivity: keep.sensitivity,
          title: keep.title,
          topics: keep.topics,
          disclosure: keep.disclosure,
          glossary: [],
        })
        const createdV: VariantRow[] = []
        for (let i = 0; i < action.variants.length; i++) {
          const v = action.variants[i]!
          const norm = normalizeWhen(v.when)
          const outcome = evaluateSensitiveContent(v.content, privacy)
          const [nv] = await tx
            .insert(entryVariants)
            .values({
              circleId,
              entryId: keep.id,
              kind: keep.kind,
              sensitivity: keep.sensitivity,
              when: norm,
              whenSignature: whenSignature(norm),
              sortOrder: v.sortOrder ?? i,
              content: v.content,
              searchHeader: header,
              sensitiveCredential: outcome.hasCredential,
              sensitivePii: outcome.hasPii,
              sensitiveFindings: outcome.findings,
            })
            .returning()
          createdV.push(nv!)
        }
        const [uKeep] = await tx
          .update(entries)
          .set({
            realms,
            provenance: 'owner',
            version: keep.version + 1,
            updatedAt: updatedAtFor(now),
          })
          .where(eq(entries.id, keep.id))
          .returning()
        await syncEntryLinks(tx, {
          circleId,
          entryId: keep.id,
          shortId: keep.shortId,
          sensitivity: keep.sensitivity,
          provenance: 'owner',
          variants: createdV.map((v) => ({ id: v.id, content: v.content })),
        })
        if (action.kind === 'merge_variants') await softDeleteOthers(keep.id, keep.id)
        await this.writeEvent(tx, {
          circleId,
          entryId: keep.id,
          type: 'update',
          provenance: this.ctx.access.writeProvenance,
          before: beforeSnap,
          after: toStoredSnapshot(uKeep!, snapVariants(createdV), []),
          context:
            action.kind === 'merge_variants'
              ? {
                  ...eventMeta,
                  mergedFrom: sources.filter((s) => s.id !== keep.id).map((s) => s.id),
                }
              : eventMeta,
        })
        affected.push(keep.id)
      } else if (action.kind === 'facet_tag') {
        const target = byId.get(action.targetId)
        if (!target) throw new MemoryError(409, '目标词条不存在')
        const norm = normalizeWhen(action.when)
        const sig = whenSignature(norm)
        const vRowsOf = vByEntry.get(target.id) ?? []
        if (vRowsOf.length === 1) {
          const beforeSnap = toStoredSnapshot(target, snapVariants(vRowsOf), [])
          await tx
            .update(entryVariants)
            .set({ when: norm, whenSignature: sig, updatedAt: now })
            .where(eq(entryVariants.id, vRowsOf[0]!.id))
          const [uTarget] = await tx
            .update(entries)
            .set({
              realms: normalizeRealms(norm.realm ?? []),
              version: target.version + 1,
              updatedAt: updatedAtFor(now),
            })
            .where(eq(entries.id, target.id))
            .returning()
          await this.writeEvent(tx, {
            circleId,
            entryId: target.id,
            type: 'update',
            provenance: this.ctx.access.writeProvenance,
            before: beforeSnap,
            after: toStoredSnapshot(uTarget!, [{ when: norm, content: vRowsOf[0]!.content }], []),
            context: eventMeta,
          })
          affected.push(target.id)
        }
      } else if (action.kind === 'distill' || action.kind === 'distill_episode') {
        const draft = action.draft
        const draftVariants: VariantInput[] = draft.variants ?? [
          { when: normalizeWhen(draft.when ?? {}), content: draft.content ?? '', sortOrder: 0 },
        ]
        const circleKind: CircleKind = circleRow?.kind ?? 'shared'
        const sensitivity = DEFAULT_SENSITIVITY[circleKind]
        const topics = cleanTopics(draft.topics)
        const realms = normalizeRealms(
          draftVariants.flatMap((v) => normalizeWhen(v.when).realm ?? []),
        )
        const { value: inserted } = await insertWithAllocatedShortId(tx, async (sp, shortId) => {
          const title = deriveEntryTitle(draft.title, draftVariants, shortId, sensitivity)
          const [nRow] = await sp
            .insert(entries)
            .values({
              circleId,
              shortId,
              circleKind,
              kind: 'entry',
              ownerAccountId: circleKind === 'personal' ? this.ctx.access.ownerAccountId : null,
              provenance: 'owner',
              originScope: 'global',
              title,
              sensitivity,
              priority: draft.priority ?? 2,
              disclosure: draft.disclosure,
              topics,
              realms,
              validFrom: now,
              version: 1,
            })
            .returning()
          const header = buildSearchHeader({
            sensitivity,
            title,
            topics,
            disclosure: draft.disclosure,
            glossary: [],
          })
          const vCreated: VariantRow[] = []
          for (let i = 0; i < draftVariants.length; i++) {
            const v = draftVariants[i]!
            const norm = normalizeWhen(v.when)
            const outcome = evaluateSensitiveContent(v.content, privacy)
            const [vr] = await sp
              .insert(entryVariants)
              .values({
                circleId,
                entryId: nRow!.id,
                kind: 'entry',
                sensitivity,
                when: norm,
                whenSignature: whenSignature(norm),
                sortOrder: v.sortOrder ?? i,
                content: v.content,
                searchHeader: header,
                sensitiveCredential: outcome.hasCredential,
                sensitivePii: outcome.hasPii,
                sensitiveFindings: outcome.findings,
              })
              .returning()
            vCreated.push(vr!)
          }
          return { row: nRow!, variants: vCreated }
        })
        await syncEntryLinks(tx, {
          circleId,
          entryId: inserted.row.id,
          shortId: inserted.row.shortId,
          sensitivity,
          provenance: 'owner',
          variants: inserted.variants.map((v) => ({ id: v.id, content: v.content })),
        })
        await this.writeEvent(tx, {
          circleId,
          entryId: inserted.row.id,
          type: 'create',
          provenance: 'owner',
          before: null,
          after: toStoredSnapshot(
            inserted.row,
            draftVariants.map((v) => ({ when: normalizeWhen(v.when), content: v.content })),
            [],
          ),
          context: { ...eventMeta, distilledFrom: sources.map((s) => s.id) },
        })
        affected.push(inserted.row.id)
        primaryResult = {
          id: inserted.row.id,
          shortId: inserted.row.shortId,
          title: inserted.row.title,
        }
      } else if (action.kind === 'stale') {
        for (const src of sources) {
          const srcV = snapVariants(vByEntry.get(src.id) ?? [])
          const [uRow] = await tx
            .update(entries)
            .set({ validTo: now, version: src.version + 1, updatedAt: updatedAtFor(now) })
            .where(eq(entries.id, src.id))
            .returning()
          await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, src.id))
          await this.writeEvent(tx, {
            circleId,
            entryId: src.id,
            type: 'update',
            provenance: this.ctx.access.writeProvenance,
            before: toStoredSnapshot(src, srcV, []),
            after: toStoredSnapshot(uRow!, srcV, []),
            context: eventMeta,
          })
          affected.push(src.id)
        }
      } else if (action.kind === 'review') {
        if (sources.some((s) => s.provenance !== 'untrusted')) {
          throw new MemoryError(409, '涉及的词条已变动或过期，这条建议已作废')
        }
        if (action.verdict === 'delete') {
          await softDeleteOthers('__none__')
        } else {
          for (const src of sources) {
            const vRows = vByEntry.get(src.id) ?? []
            const srcV = snapVariants(vRows)
            const [uRow] = await tx
              .update(entries)
              .set({ provenance: 'owner', version: src.version + 1, updatedAt: updatedAtFor(now) })
              .where(eq(entries.id, src.id))
              .returning()
            await syncEntryLinks(tx, {
              circleId,
              entryId: src.id,
              shortId: src.shortId,
              sensitivity: src.sensitivity,
              provenance: 'owner',
              variants: vRows.map((v) => ({ id: v.id, content: v.content })),
            })
            await this.writeEvent(tx, {
              circleId,
              entryId: src.id,
              type: 'confirm',
              provenance: 'owner',
              before: toStoredSnapshot(src, srcV, []),
              after: toStoredSnapshot(uRow!, srcV, []),
              context: eventMeta,
            })
            affected.push(src.id)
          }
        }
      } else if (action.kind === 'promote') {
        for (const src of sources) {
          const srcV = snapVariants(vByEntry.get(src.id) ?? [])
          const [uRow] = await tx
            .update(entries)
            .set({
              priority: action.priority,
              version: src.version + 1,
              updatedAt: updatedAtFor(now),
            })
            .where(eq(entries.id, src.id))
            .returning()
          await this.writeEvent(tx, {
            circleId,
            entryId: src.id,
            type: 'update',
            provenance: this.ctx.access.writeProvenance,
            before: toStoredSnapshot(src, srcV, []),
            after: toStoredSnapshot(uRow!, srcV, []),
            context: eventMeta,
          })
          affected.push(src.id)
        }
      }

      await mark(tx)
      return primaryResult
    })

    for (const id of affected) this.ctx.onChanged?.(circleId, id)
    return createdOrUpdated
  }

  async rejectSuggestion(
    lock: (tx: Tx) => Promise<LockedSuggestion | null>,
    mark: (tx: Tx) => Promise<void>,
  ): Promise<void> {
    if (!this.isConsole) throw new MemoryError(403, '整理建议只能由管理界面的成员处理')
    const circleId = this.ctx.access.primaryCircleId
    await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const suggestion = await lock(tx)
      if (!suggestion) throw new MemoryError(404, '未找到整理建议')
      const uniqueIds = [...new Set(suggestion.entries.map((e) => e.id))]
      const rows = uniqueIds.length
        ? await tx.select().from(entries).where(inArray(entries.id, uniqueIds))
        : []
      if (
        rows.length < uniqueIds.length ||
        rows.some((r) => !canRead(this.ctx.access, parseEntryFacts(r), { now, management: true }))
      ) {
        throw new MemoryError(404, '未找到整理建议')
      }
      if (!suggestion.pending) throw new MemoryError(409, '这条建议已经处理过了')
      for (const row of rows) {
        if (!canModify(this.ctx.access, row)) {
          throw new MemoryError(403, '无权处理该词条')
        }
      }
      await mark(tx)
    })
  }

  async writeExtraction(
    items: readonly ExtractedWrite[],
    eventMeta: Record<string, unknown>,
    onSettled: (tx: Tx, outcomes: ('added' | 'updated' | 'skipped')[]) => Promise<void>,
    resolveConversation: (tx: Tx) => Promise<string>,
  ): Promise<void> {
    const circleId = this.ctx.access.primaryCircleId
    const circleKind: CircleKind = this.ctx.access.circles.get(circleId)?.circleKind ?? 'shared'
    const embedEntryIds: string[] = []

    await withCircle(this.ctx.db, circleId, async (tx, now) => {
      const conversationId = await resolveConversation(tx)
      const { settings: privacy } = await loadCirclePrivacy(tx, circleId)
      const outcomes: ('added' | 'updated' | 'skipped')[] = []

      for (const item of items) {
        if (item.kind === 'fact') {
          const sensitivity: Sensitivity = 'public'
          const provenance: Provenance = 'untrusted'
          if (!canWrite(this.ctx.access, { circleId, kind: 'fact', sensitivity })) {
            outcomes.push('skipped')
            continue
          }

          let supersededInfo: {
            oldRow: EntryRow
            superseded: EntryRow
            storedOldVariants: { when: WhenCondition; content: string | null }[]
          } | null = null
          if (item.replaces) {
            const [oldRow] = await tx
              .select()
              .from(entries)
              .where(
                and(
                  eq(entries.id, item.replaces.id),
                  eq(entries.kind, 'fact'),
                  eq(entries.subjectId, item.subjectId),
                  eq(entries.originScope, item.originScope),
                  isNull(entries.deletedAt),
                  or(isNull(entries.validTo), gt(entries.validTo, now)),
                ),
              )
              .for('update')
              .limit(1)
            if (
              oldRow &&
              oldRow.version === item.replaces.version &&
              canModify(this.ctx.access, oldRow)
            ) {
              const oldVariants = await tx
                .select()
                .from(entryVariants)
                .where(eq(entryVariants.entryId, oldRow.id))
                .orderBy(asc(entryVariants.sortOrder))
              const [superseded] = await tx
                .update(entries)
                .set({ validTo: now, version: oldRow.version + 1, updatedAt: updatedAtFor(now) })
                .where(eq(entries.id, oldRow.id))
                .returning()
              await tx.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, oldRow.id))
              await tx.delete(entryLinks).where(eq(entryLinks.sourceEntryId, oldRow.id))
              const storedOldVariants = oldVariants.map((v) => ({
                when: normalizeWhen(v.when),
                content: v.content,
              }))
              supersededInfo = { oldRow, superseded: superseded!, storedOldVariants }
            }
          }

          const when = normalizeWhen(item.when ?? {})
          const realms = normalizeRealms(when.realm ?? [])
          const { value: inserted } = await insertWithAllocatedShortId(tx, async (sp, shortId) => {
            const title = deriveEntryTitle(
              undefined,
              [{ content: item.content }],
              shortId,
              sensitivity,
            )
            const [row] = await sp
              .insert(entries)
              .values({
                circleId,
                shortId,
                circleKind,
                kind: 'fact',
                ownerAccountId: null,
                clientId: this.ctx.access.clientId,
                subjectId: item.subjectId,
                subjectKind: item.subjectKind,
                conversationId,
                provenance,
                originScope: item.originScope,
                title,
                sensitivity,
                priority: 2,
                disclosure: null,
                topics: [],
                realms,
                validFrom: now,
                version: 1,
              })
              .returning()
            const header = buildSearchHeader({
              sensitivity,
              title,
              topics: [],
              disclosure: null,
              glossary: [],
            })
            const outcome = evaluateSensitiveContent(item.content, privacy)
            await sp.insert(entryVariants).values({
              circleId,
              entryId: row!.id,
              kind: 'fact',
              sensitivity,
              when,
              whenSignature: whenSignature(when),
              sortOrder: 0,
              content: item.content,
              searchHeader: header,
              sensitiveCredential: outcome.hasCredential,
              sensitivePii: outcome.hasPii,
              sensitiveFindings: outcome.findings,
            })
            return row!
          })

          if (supersededInfo) {
            await this.writeEvent(tx, {
              circleId,
              entryId: supersededInfo.oldRow.id,
              type: 'update',
              provenance: this.ctx.access.writeProvenance,
              before: toStoredSnapshot(supersededInfo.oldRow, supersededInfo.storedOldVariants, []),
              after: toStoredSnapshot(
                supersededInfo.superseded,
                supersededInfo.storedOldVariants,
                [],
              ),
              context: { ...eventMeta, supersededBy: inserted.id },
            })
          }
          await this.writeEvent(tx, {
            circleId,
            entryId: inserted.id,
            type: 'create',
            provenance,
            before: null,
            after: toStoredSnapshot(inserted, [{ when, content: item.content }], []),
            context: supersededInfo
              ? { ...eventMeta, supersedes: supersededInfo.oldRow.id }
              : eventMeta,
          })
          embedEntryIds.push(inserted.id)
          outcomes.push(supersededInfo ? 'updated' : 'added')
          continue
        }

        const isNoContext = item.ownerAccountId !== null
        const sensitivity: Sensitivity = isNoContext ? 'private' : 'public'
        const provenance: Provenance = isNoContext ? 'agent' : 'untrusted'
        const originScope = isNoContext ? `client:${this.ctx.access.clientId}` : item.originScope
        if (!canWrite(this.ctx.access, { circleId, kind: 'episode', sensitivity })) {
          outcomes.push('skipped')
          continue
        }

        const expiresAt = new Date(now.getTime() + item.ttlDays * 86_400_000)
        const { value: inserted } = await insertWithAllocatedShortId(tx, async (sp, shortId) => {
          const title = deriveEntryTitle(
            undefined,
            [{ content: item.content }],
            shortId,
            sensitivity,
          )
          const [row] = await sp
            .insert(entries)
            .values({
              circleId,
              shortId,
              circleKind,
              kind: 'episode',
              ownerAccountId: item.ownerAccountId,
              clientId: this.ctx.access.clientId,
              subjectId: null,
              subjectKind: null,
              conversationId,
              provenance,
              originScope,
              title,
              sensitivity,
              priority: 2,
              disclosure: null,
              topics: [],
              realms: [],
              validFrom: now,
              expiresAt,
              version: 1,
            })
            .returning()
          const header = buildSearchHeader({
            sensitivity,
            title,
            topics: [],
            disclosure: null,
            glossary: [],
          })
          const outcome = evaluateSensitiveContent(item.content, privacy)
          await sp.insert(entryVariants).values({
            circleId,
            entryId: row!.id,
            kind: 'episode',
            sensitivity,
            when: {},
            whenSignature: '{}',
            sortOrder: 0,
            content: item.content,
            searchHeader: header,
            sensitiveCredential: outcome.hasCredential,
            sensitivePii: outcome.hasPii,
            sensitiveFindings: outcome.findings,
          })
          return row!
        })

        await this.writeEvent(tx, {
          circleId,
          entryId: inserted.id,
          type: 'create',
          provenance,
          before: null,
          after: toStoredSnapshot(inserted, [{ when: {}, content: item.content }], []),
          context: eventMeta,
        })
        outcomes.push('added')
      }

      await onSettled(tx, outcomes)
    })

    for (const id of embedEntryIds) {
      this.ctx.onChanged?.(circleId, id)
    }
  }

  async eventChanges(where: SQL): Promise<EventChanges> {
    const readIds = [...this.ctx.access.circles.keys()]
    return withCircles(this.ctx.db, { read: readIds }, async (tx, now) => {
      const rows = await tx
        .select({
          id: entryEvents.id,
          shortId: entryEvents.shortId,
          eventType: entryEvents.eventType,
          before: entryEvents.before,
          after: entryEvents.after,
          entry: entries,
        })
        .from(entryEvents)
        .leftJoin(entries, eq(entries.id, entryEvents.entryId))
        .where(where)
        .orderBy(asc(entryEvents.id))

      const out: EventChanges['entries'] = []
      let hiddenOther = 0
      let lastId = 0

      for (const row of rows) {
        if (row.id > lastId) lastId = row.id
        const rawBefore = row.before as Record<string, unknown> | null
        const rawAfter = row.after as Record<string, unknown> | null

        if (row.eventType === ACCESS_EVENT && !rawBefore && !rawAfter) {
          const readable = row.entry
            ? canRead(this.ctx.access, parseEntryFacts(row.entry), { now, management: true })
            : false
          if (!readable) {
            hiddenOther++
            continue
          }
          out.push({
            type: row.eventType,
            shortId: row.shortId,
            title: row.entry?.title ?? row.shortId,
            fields: [],
            left: false,
            becameSecret: false,
          })
          continue
        }

        const beforeFacts = snapshotFacts(rawBefore)
        const afterFacts = snapshotFacts(rawAfter)
        const beforeReadable = beforeFacts
          ? canRead(this.ctx.access, beforeFacts, { now, management: true })
          : false
        const afterReadable = afterFacts
          ? canRead(this.ctx.access, afterFacts, { now, management: true })
          : false

        if (!beforeReadable && !afterReadable) {
          hiddenOther++
          continue
        }

        const beforePub = beforeReadable ? toPublicSnapshot(rawBefore) : null
        const afterPub = afterReadable ? toPublicSnapshot(rawAfter) : null
        const shown = afterPub ?? beforePub
        const becameSecret =
          beforePub?.sensitivity !== 'secret' && afterPub?.sensitivity === 'secret'
        const fields = changedFields(beforePub, afterPub)
        out.push({
          type: row.eventType,
          shortId: shown?.shortId ?? row.shortId,
          title: shown?.title ?? row.shortId,
          fields,
          left: Boolean(beforeReadable && !afterReadable),
          becameSecret,
        })
      }

      return { entries: out, hiddenOther, lastId }
    })
  }
}
