import { randomUUID } from 'node:crypto'

import {
  bootModeToPinned,
  buildSearchTags,
  deriveEntryTitle,
  detectSecretPrefixes,
  KIOKU_EXPORT_FORMAT,
  KIOKU_EXPORT_SCHEMA_VERSION,
  LEGACY_LORE_URI_REGEX,
  NON_SHORT_ID_WIKI_LINK_REGEX,
  normalizeSlugList,
  resolveBootMode,
  WIKI_LINK_REGEX,
  type BootMode,
  type ExportDataRequest,
  type ExportedCredentialRecord,
  type ImportApplyRequest,
  type ImportApplyResponse,
  type ImportPreviewCredential,
  type ImportPreviewItem,
  type ImportPreviewResponse,
  type ImportSource,
  type KiokuExportBundle,
} from '@kioku/contracts'
import { asc, desc, eq, isNull } from 'drizzle-orm'

import { openCredentialPayload, prepareCredentialWrite } from '../credential/service'
import { encryptSecret } from '../crypto/envelope'
import { encryptionKey, type MasterKey } from '../crypto/keyring'
import { credentialAad } from '../crypto/rotation'
import { withTx, type Db } from '../db/client'
import { credentials, entries, entryEvents } from '../db/schema'
import type { Jobs } from '../jobs/queue'
import { MemoryError } from '../memory/errors'
import { syncEntryLinks } from '../memory/links'
import { insertWithAllocatedShortId } from '../memory/shortId'
import { clipChars } from '../recall/text'
import { decryptExportCredentials, encryptExportCredentials } from './crypto'
import { fetchLoreBackup } from './loreFetch'
import { parseLoreToEntries } from './loreParse'

interface ImportCandidate {
  key: string
  sourceRef: string
  shortId: string | null
  kind: 'entry' | 'episode'
  title: string
  summary: string | null
  content: string
  disclosure: string | null
  isPinned: boolean
  bootMode: BootMode
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  topics: string[]
  deviceKey: string
  projectSlug: string
  validTo: Date | null
  verifiedAt: Date | null
  lastChangeSummary: string | null
  createdAt: Date | null
  updatedAt: Date | null
  skippedReason: string | null
}

function previewText(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

function rewriteWikiLinks(content: string, remap: ReadonlyMap<string, string>): string {
  if (!remap.size) return content
  const re = new RegExp(WIKI_LINK_REGEX.source, 'gi')
  return content.replace(re, (full, rawId: string, display?: string) => {
    const next = remap.get(rawId.toLowerCase())
    if (!next) return full
    return display !== undefined ? `[[${next}|${display}]]` : `[[${next}]]`
  })
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const INLINE_CODE_SPLIT_RE = /(`+[^`\r\n]*?`+)/g

function sanitizeLoreWikiAlias(raw: string): string {
  const cleaned = raw
    .replace(/[[\]|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clipChars(cleaned, 28)
}

function rewriteLoreReferences(
  content: string,
  selfShortId: string,
  uriMap: ReadonlyMap<string, { shortId: string; title: string }>,
  slugMap: ReadonlyMap<string, { shortId: string; title: string } | null>,
): string {
  if (!uriMap.size && !slugMap.size) return content
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let fence: string | null = null
  const out: string[] = []

  const replaceSegment = (segment: string): string => {
    let next = segment.replace(new RegExp(LEGACY_LORE_URI_REGEX.source, 'gi'), (raw) => {
      const trimmed = raw.replace(/[.,;:]+$/, '')
      const trailing = raw.slice(trimmed.length)
      const hit = uriMap.get(trimmed.toLowerCase())
      if (!hit || hit.shortId === selfShortId) return raw
      const label = sanitizeLoreWikiAlias(hit.title)
      return label ? `[[${hit.shortId}|${label}]]${trailing}` : `[[${hit.shortId}]]${trailing}`
    })
    next = next.replace(
      new RegExp(NON_SHORT_ID_WIKI_LINK_REGEX.source, 'gi'),
      (full, slug: string, alias?: string) => {
        const hit = slugMap.get(slug.trim().toLowerCase())
        if (!hit || hit.shortId === selfShortId) return full
        const label = sanitizeLoreWikiAlias(alias ?? '') || sanitizeLoreWikiAlias(hit.title)
        return label ? `[[${hit.shortId}|${label}]]` : `[[${hit.shortId}]]`
      },
    )
    return next
  }

  for (const line of lines) {
    const [, marker, info = ''] = FENCE_RE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      out.push(line)
      continue
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      out.push(line)
      continue
    }
    const parts = line.split(INLINE_CODE_SPLIT_RE)
    out.push(parts.map((part, idx) => (idx % 2 === 1 ? part : replaceSegment(part))).join(''))
  }
  return out.join('\n')
}

function openCredentialForExport(
  masterKey: MasterKey,
  row: typeof credentials.$inferSelect,
): ExportedCredentialRecord {
  const payload = openCredentialPayload(masterKey, row)
  return {
    slug: row.slug,
    label: row.label,
    description: row.description,
    kind: row.kind,
    primaryField: row.primaryField,
    ...(row.fieldMeta.length ? { fieldMeta: row.fieldMeta } : {}),
    ...(row.passkeyManualOnly ? { passkeyManualOnly: true } : {}),
    allowedRealms: row.allowedRealms,
    value: payload.value,
    ...(Object.keys(payload.fields).length ? { fields: payload.fields } : {}),
  }
}

export async function exportTransferBundle(
  db: Db,
  masterKey: MasterKey | null,
  request: ExportDataRequest,
): Promise<{ contentType: string; filename: string; body: string }> {
  const rows = await db
    .select()
    .from(entries)
    .where(isNull(entries.deletedAt))
    .orderBy(asc(entries.kind), desc(entries.isPinned), asc(entries.createdAt))

  const exportedAt = new Date().toISOString()
  const stamp = exportedAt.slice(0, 10)

  if (request.format === 'markdown') {
    const sections: string[] = [`# Kioku 记忆导出（${stamp}）`, '', `共 ${rows.length} 条。`, '']
    for (const row of rows) {
      const meta: string[] = [
        `短 ID：\`${row.shortId}\``,
        `类型：${row.kind === 'episode' ? '会话摘要' : row.bootMode === 'full' ? '全文常驻' : row.bootMode === 'index' ? '目录常驻' : '正式记忆'}`,
      ]
      if (row.projects.length) meta.push(`项目：${row.projects.join(', ')}`)
      if (row.envs.length) meta.push(`环境：${row.envs.join(', ')}`)
      if (row.realms.length) meta.push(`场域：${row.realms.join(', ')}`)
      if (row.runtimes.length) meta.push(`客户端：${row.runtimes.join(', ')}`)
      if (row.topics.length) meta.push(`主题：${row.topics.join(', ')}`)
      if (row.disclosure) {
        meta.push(`${row.kind === 'episode' ? '信号要点' : '召回时机'}：${row.disclosure}`)
      }
      if (row.validTo) meta.push(`有效期至：${row.validTo.toISOString()}`)
      sections.push(`## ${row.title} (${row.shortId})`)
      sections.push('')
      sections.push(`> ${meta.join(' · ')}`)
      sections.push('')
      sections.push(row.content)
      sections.push('')
      sections.push('---')
      sections.push('')
    }
    return {
      contentType: 'text/markdown; charset=utf-8',
      filename: `kioku-export-${stamp}.md`,
      body: sections.join('\n'),
    }
  }

  let encryptedCredentials: KiokuExportBundle['encryptedCredentials'] = null
  if (request.includeCredentials) {
    if (!masterKey) {
      throw new MemoryError(400, '尚未配置 KIOKU_MASTER_KEY，无法导出加密凭据')
    }
    if (!request.passphrase) {
      throw new MemoryError(400, '导出加密凭据必须填写加密口令')
    }
    const credRows = await db.select().from(credentials).orderBy(asc(credentials.slug))
    const records = credRows.map((row) => openCredentialForExport(masterKey, row))
    encryptedCredentials = await encryptExportCredentials(records, request.passphrase)
  }

  const payload: KiokuExportBundle = {
    format: KIOKU_EXPORT_FORMAT,
    schemaVersion: KIOKU_EXPORT_SCHEMA_VERSION,
    exportedAt,
    count: rows.length,
    entries: rows.map((row) => ({
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
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    ...(encryptedCredentials ? { encryptedCredentials } : {}),
  }

  return {
    contentType: 'application/json; charset=utf-8',
    filename: request.includeCredentials
      ? `kioku-backup-${stamp}.json`
      : `kioku-export-${stamp}.json`,
    body: JSON.stringify(payload, null, 2),
  }
}

async function resolveSource(
  source: ImportSource,
  signal?: AbortSignal,
): Promise<{
  sourceKind: 'kioku' | 'lore'
  exportedAt: string | null
  candidates: ImportCandidate[]
  hasEncryptedCredentials: boolean
  credentials: ExportedCredentialRecord[]
  credentialsDecrypted: boolean
}> {
  if (source.kind === 'kioku') {
    const { bundle } = source
    const hasEncryptedCredentials = Boolean(bundle.encryptedCredentials)
    let creds: ExportedCredentialRecord[] = []
    let credentialsDecrypted = false

    if (hasEncryptedCredentials && source.includeCredentials) {
      if (!source.passphrase) {
        throw new MemoryError(400, '请输入备份文件的解密口令以预览或导入托管凭据')
      }
      creds = await decryptExportCredentials(bundle.encryptedCredentials!, source.passphrase)
      credentialsDecrypted = true
    }

    const seenKeys = new Set<string>()
    const candidates: ImportCandidate[] = bundle.entries.map((item, idx) => {
      const baseKey = item.shortId
      const key = seenKeys.has(baseKey) ? `${baseKey}#${idx}` : baseKey
      seenKeys.add(key)
      const bootMode: BootMode =
        item.kind === 'episode'
          ? 'none'
          : resolveBootMode({ bootMode: item.bootMode, isPinned: item.isPinned })
      return {
        key,
        sourceRef: item.shortId,
        shortId: item.shortId,
        kind: item.kind,
        title: item.title,
        summary: item.summary ?? null,
        content: item.content,
        disclosure: item.disclosure ?? null,
        isPinned: bootModeToPinned(bootMode),
        bootMode,
        envs: normalizeSlugList(item.envs),
        realms: normalizeSlugList(item.realms),
        projects: normalizeSlugList(item.projects),
        runtimes: normalizeSlugList(item.runtimes),
        topics: normalizeSlugList(item.topics),
        deviceKey: item.deviceKey ?? '',
        projectSlug: item.projectSlug ?? '',
        validTo: item.validTo ? new Date(item.validTo) : null,
        verifiedAt: item.verifiedAt ? new Date(item.verifiedAt) : null,
        lastChangeSummary: item.lastChangeSummary ?? null,
        createdAt: item.createdAt ? new Date(item.createdAt) : null,
        updatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
        skippedReason: null,
      }
    })

    return {
      sourceKind: 'kioku',
      exportedAt: bundle.exportedAt,
      candidates,
      hasEncryptedCredentials,
      credentials: creds,
      credentialsDecrypted,
    }
  }

  const rawBackup =
    source.kind === 'lore-file'
      ? source.backup
      : await fetchLoreBackup({ url: source.url, token: source.token }, signal)
  const parsed = parseLoreToEntries(rawBackup)

  return {
    sourceKind: 'lore',
    exportedAt: parsed.exportedAt,
    candidates: parsed.entries.map((item) => ({
      key: item.key,
      sourceRef: item.uri,
      shortId: null,
      kind: 'entry',
      title: item.title,
      summary: null,
      content: item.content,
      disclosure: item.disclosure,
      isPinned: item.isPinned,
      bootMode: item.bootMode,
      envs: item.envs,
      realms: item.realms,
      projects: item.projects,
      runtimes: item.runtimes,
      topics: item.topics,
      deviceKey: '',
      projectSlug: '',
      validTo: null,
      verifiedAt: null,
      lastChangeSummary: null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      skippedReason: item.skippedReason,
    })),
    hasEncryptedCredentials: false,
    credentials: [],
    credentialsDecrypted: false,
  }
}

export async function previewTransferImport(
  db: Db,
  masterKey: MasterKey | null,
  source: ImportSource,
  signal?: AbortSignal,
): Promise<ImportPreviewResponse> {
  const resolved = await resolveSource(source, signal)

  const [existingEntries, existingCreds] = await Promise.all([
    db
      .select({ shortId: entries.shortId, title: entries.title, deletedAt: entries.deletedAt })
      .from(entries),
    db.select({ slug: credentials.slug }).from(credentials),
  ])

  const existingShortIds = new Set(existingEntries.map((e) => e.shortId))
  const existingActiveTitles = new Set(
    existingEntries.filter((e) => e.deletedAt === null).map((e) => e.title.trim().toLowerCase()),
  )
  const existingCredSlugs = new Set(existingCreds.map((c) => c.slug))

  const seenBatchShortIds = new Set<string>()
  const items: ImportPreviewItem[] = resolved.candidates.map((c) => {
    let conflict: ImportPreviewItem['conflict'] = 'none'
    if (!c.skippedReason) {
      if (c.shortId) {
        if (existingShortIds.has(c.shortId) || seenBatchShortIds.has(c.shortId)) {
          conflict = 'short_id_exists'
        } else {
          seenBatchShortIds.add(c.shortId)
        }
      } else if (existingActiveTitles.has(c.title.trim().toLowerCase())) {
        conflict = 'same_title_exists'
      }
    }
    const hints = c.skippedReason ? [] : detectSecretPrefixes(c.content).map((m) => m.label)
    return {
      key: c.key,
      sourceRef: c.sourceRef,
      shortId: c.shortId,
      kind: c.kind,
      title: c.title,
      contentPreview: c.skippedReason ? '' : previewText(c.content),
      secretHintLabels: hints,
      isPinned: c.isPinned,
      bootMode: c.bootMode,
      envs: c.envs,
      realms: c.realms,
      projects: c.projects,
      runtimes: c.runtimes,
      topics: c.topics,
      disclosure: c.disclosure,
      conflict,
      skippedReason: c.skippedReason,
    }
  })

  // 预览绝不返回凭据明文，仅返回元数据与冲突状态
  const previewCredentials: ImportPreviewCredential[] = resolved.credentials.map((cred) => {
    const fieldCount = cred.fieldMeta?.length
      ? cred.fieldMeta.length
      : cred.fields
        ? Object.keys(cred.fields).length
        : 1
    return {
      slug: cred.slug,
      label: cred.label,
      description: cred.description ?? null,
      kind: cred.kind ?? 'secret',
      fieldCount,
      allowedRealms: cred.allowedRealms ?? null,
      exists: existingCredSlugs.has(cred.slug),
    }
  })

  const skipped = items.filter((i) => i.skippedReason !== null).length
  const conflicts = items.filter((i) => i.skippedReason === null && i.conflict !== 'none').length
  const ready = items.length - skipped - conflicts
  const credentialConflicts = previewCredentials.filter((c) => c.exists).length

  return {
    sourceKind: resolved.sourceKind,
    exportedAt: resolved.exportedAt,
    items,
    credentials: previewCredentials,
    hasEncryptedCredentials: resolved.hasEncryptedCredentials,
    credentialsDecrypted: resolved.credentialsDecrypted,
    hasMasterKey: Boolean(masterKey),
    summary: {
      total: items.length,
      ready,
      conflicts,
      skipped,
      credentialTotal: previewCredentials.length,
      credentialReady: previewCredentials.length - credentialConflicts,
      credentialConflicts,
    },
  }
}

export async function applyTransferImport(
  db: Db,
  masterKey: MasterKey | null,
  jobs: Jobs | null | undefined,
  request: ImportApplyRequest,
  signal?: AbortSignal,
): Promise<ImportApplyResponse> {
  const resolved = await resolveSource(request.source, signal)
  const excludedKeys = new Set(request.excludeKeys)
  const excludedCreds = new Set(request.excludeCredentialSlugs)

  const wantsCredentials =
    request.source.kind === 'kioku' &&
    request.source.includeCredentials &&
    resolved.credentials.length > 0

  if (wantsCredentials && !masterKey) {
    throw new MemoryError(400, '当前实例未配置 KIOKU_MASTER_KEY，无法写入导入的加密凭据')
  }

  const outcome = await withTx(db, async (tx, now) => {
    const existingEntries = await tx.select({ shortId: entries.shortId }).from(entries)
    const takenShortIds = new Set(existingEntries.map((r) => r.shortId))

    let createdEntries = 0
    let reallocatedEntries = 0
    let skippedEntries = 0

    const selected = resolved.candidates.filter((c) => {
      if (c.skippedReason !== null || excludedKeys.has(c.key)) {
        skippedEntries++
        return false
      }
      return true
    })

    // 第一遍：分配短 ID 并记录旧短 ID -> 新短 ID 映射（供双链重写）
    const remap = new Map<string, string>()
    const planned: Array<{ candidate: ImportCandidate; assignedShortId: string | null }> = []

    for (const candidate of selected) {
      if (candidate.shortId) {
        if (takenShortIds.has(candidate.shortId)) {
          if (request.conflictStrategy === 'skip') {
            skippedEntries++
            continue
          }
          // 冲突且选择重新分配，延后由数据库分配器分配并在写入后重写双链
          planned.push({ candidate, assignedShortId: null })
          continue
        }
        takenShortIds.add(candidate.shortId)
        planned.push({ candidate, assignedShortId: candidate.shortId })
      } else {
        planned.push({ candidate, assignedShortId: null })
      }
    }

    const insertedRows: Array<{
      id: string
      shortId: string
      title: string
      sourceRef: string
      content: string
      needsRewrite: boolean
    }> = []

    const actor = resolved.sourceKind === 'lore' ? 'import:lore' : 'import:kioku'
    const loreUriMap = new Map<string, { shortId: string; title: string }>()
    const loreSlugMap = new Map<string, { shortId: string; title: string } | null>()

    for (const item of planned) {
      const c = item.candidate
      const createdAt = c.createdAt ?? now
      const updatedAt = c.updatedAt ?? now

      if (item.assignedShortId) {
        const shortId = item.assignedShortId
        const title = deriveEntryTitle(c.title, c.content, shortId)
        const searchTags = buildSearchTags({
          shortId,
          topics: c.topics,
          envs: c.envs,
          realms: c.realms,
          projects: c.projects,
          runtimes: c.runtimes,
        })
        const [row] = await tx
          .insert(entries)
          .values({
            shortId,
            kind: c.kind,
            title,
            summary: c.summary,
            content: c.content,
            disclosure: c.disclosure,
            isPinned: c.kind === 'episode' ? false : c.isPinned,
            bootMode: c.kind === 'episode' ? 'none' : c.bootMode,
            envs: c.envs,
            realms: c.realms,
            projects: c.projects,
            runtimes: c.runtimes,
            topics: c.topics,
            deviceKey: c.kind === 'episode' ? c.deviceKey : null,
            projectSlug: c.kind === 'episode' ? c.projectSlug : null,
            searchTags,
            validTo: c.validTo,
            verifiedAt: c.verifiedAt ?? updatedAt,
            lastChangeSummary: c.lastChangeSummary,
            version: 1,
            createdAt,
            updatedAt,
          })
          .returning()
        insertedRows.push({
          id: row!.id,
          shortId: row!.shortId,
          title: row!.title,
          sourceRef: c.sourceRef,
          content: row!.content,
          needsRewrite: resolved.sourceKind === 'kioku',
        })
        createdEntries++
      } else {
        const { shortId, value: row } = await insertWithAllocatedShortId(tx, async (sp, sid) => {
          const title = deriveEntryTitle(c.title, c.content, sid)
          const searchTags = buildSearchTags({
            shortId: sid,
            topics: c.topics,
            envs: c.envs,
            realms: c.realms,
            projects: c.projects,
            runtimes: c.runtimes,
          })
          const [created] = await sp
            .insert(entries)
            .values({
              shortId: sid,
              kind: c.kind,
              title,
              summary: c.summary,
              content: c.content,
              disclosure: c.disclosure,
              isPinned: c.kind === 'episode' ? false : c.isPinned,
              bootMode: c.kind === 'episode' ? 'none' : c.bootMode,
              envs: c.envs,
              realms: c.realms,
              projects: c.projects,
              runtimes: c.runtimes,
              topics: c.topics,
              deviceKey: c.kind === 'episode' ? c.deviceKey : null,
              projectSlug: c.kind === 'episode' ? c.projectSlug : null,
              searchTags,
              validTo: c.validTo,
              verifiedAt: c.verifiedAt ?? updatedAt,
              lastChangeSummary: c.lastChangeSummary,
              version: 1,
              createdAt,
              updatedAt,
            })
            .returning()
          return created!
        })
        takenShortIds.add(shortId)
        if (c.shortId) {
          remap.set(c.shortId, shortId)
          reallocatedEntries++
        }
        if (resolved.sourceKind === 'lore' && c.sourceRef) {
          const refInfo = { shortId, title: row.title }
          loreUriMap.set(c.sourceRef.toLowerCase(), refInfo)
          const lastSeg = c.sourceRef
            .replace(/^[a-z]+:\/\//i, '')
            .split('/')
            .filter(Boolean)
            .at(-1)
          if (lastSeg) {
            const slugKey = lastSeg.toLowerCase()
            // 仅在批次内尾段唯一无歧义时映射，冲突标记为 null 避免静默指错目标
            loreSlugMap.set(slugKey, loreSlugMap.has(slugKey) ? null : refInfo)
          }
        }
        insertedRows.push({
          id: row.id,
          shortId,
          title: row.title,
          sourceRef: c.sourceRef,
          content: row.content,
          needsRewrite: resolved.sourceKind === 'kioku',
        })
        createdEntries++
      }
    }

    // 第二遍：如有重分配短 ID 或 Lore 内部路径引用，统一重写本批词条正文的双链，再写入出链与版本历史
    for (const inserted of insertedRows) {
      let finalContent = inserted.content
      if (inserted.needsRewrite && remap.size) {
        finalContent = rewriteWikiLinks(finalContent, remap)
      }
      if (resolved.sourceKind === 'lore' && (loreUriMap.size || loreSlugMap.size)) {
        finalContent = rewriteLoreReferences(
          finalContent,
          inserted.shortId,
          loreUriMap,
          loreSlugMap,
        )
      }
      if (finalContent !== inserted.content) {
        await tx.update(entries).set({ content: finalContent }).where(eq(entries.id, inserted.id))
      }
      await syncEntryLinks(tx, inserted.id, inserted.shortId, finalContent)
      const [fresh] = await tx.select().from(entries).where(eq(entries.id, inserted.id)).limit(1)
      if (fresh) {
        await tx.insert(entryEvents).values({
          entryId: fresh.id,
          eventType: 'create',
          actor,
          changeSummary: resolved.sourceKind === 'lore' ? '从 Lore 导入' : '从 Kioku 备份导入',
          snapshot: {
            kind: fresh.kind,
            title: fresh.title,
            summary: fresh.summary,
            content: fresh.content,
            disclosure: fresh.disclosure,
            isPinned: fresh.isPinned,
            bootMode: fresh.bootMode,
            envs: fresh.envs,
            realms: fresh.realms,
            projects: fresh.projects,
            runtimes: fresh.runtimes,
            topics: fresh.topics,
            validTo: fresh.validTo ? fresh.validTo.toISOString() : null,
            verifiedAt: fresh.verifiedAt ? fresh.verifiedAt.toISOString() : null,
            version: fresh.version,
          },
          createdAt: now,
        })
      }
    }

    // 写入加密凭据（遇到已存在 slug 仅跳过、不覆盖）
    let createdCredentials = 0
    let skippedCredentials = 0

    if (wantsCredentials && masterKey) {
      const existingCreds = await tx.select({ slug: credentials.slug }).from(credentials)
      const takenSlugs = new Set(existingCreds.map((c) => c.slug))
      const { key, id: keyId } = encryptionKey(masterKey)

      for (const cred of resolved.credentials) {
        if (excludedCreds.has(cred.slug) || takenSlugs.has(cred.slug)) {
          skippedCredentials++
          continue
        }
        const id = randomUUID()
        const prepared = prepareCredentialWrite({
          kind: cred.kind,
          primaryField: cred.primaryField,
          fieldMeta: cred.fieldMeta,
          value: cred.value,
          fields: cred.fields,
          passkeyManualOnly: cred.passkeyManualOnly,
        })
        const sealed = encryptSecret(key, JSON.stringify(prepared.payload), credentialAad(id))
        await tx.insert(credentials).values({
          id,
          slug: cred.slug,
          label: cred.label,
          description: cred.description ?? null,
          kind: prepared.kind,
          primaryField: prepared.primaryField,
          fieldMeta: prepared.fieldMeta,
          passkeyManualOnly: prepared.passkeyManualOnly,
          provider: 'builtin',
          externalRef: null,
          allowedRealms: cred.allowedRealms ?? null,
          ciphertext: sealed.ciphertext,
          wrappedKey: sealed.wrappedKey,
          keyId,
          createdAt: now,
          updatedAt: now,
        })
        takenSlugs.add(cred.slug)
        createdCredentials++
      }
    }

    return {
      createdEntries,
      reallocatedEntries,
      skippedEntries,
      createdCredentials,
      skippedCredentials,
    }
  })

  if (outcome.createdEntries > 0) {
    void jobs?.enqueueBackfill()
  }

  return outcome
}
