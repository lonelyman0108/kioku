import { randomUUID } from 'node:crypto'

import {
  deriveEntryTitle,
  normalizeWhen,
  sensitivityAllowed,
  whenSignature,
  type CircleImportCounts,
  type CircleImportPreview,
  type CircleImportResult,
  type Sensitivity,
} from '@kioku/contracts'
import { and, eq, isNull } from 'drizzle-orm'

import { circleLimitReached, claimOwnerSeat, insertSharedCircle } from '../access/circles'
import { normalizeRealms } from '../access/realms'
import { placeholderIdentifiers } from '../credential/placeholders'
import { evaluateSensitiveContent, loadCirclePrivacy } from '../credential/privacy'
import { sealCredentialValues } from '../credential/service'
import { withCircle } from '../db/client'
import {
  circleMembers,
  circles,
  clientGroupRules,
  clients,
  credentials,
  entries,
  entryCredentialRefs,
  entryEvents,
  entryGlossary,
  entryVariants,
  facetDimensions,
  facetTerms,
  legacyUris,
  personas,
  personaTraits,
  subjectIdentities,
  subjects,
  vaultConnections,
} from '../db/schema'
import type { Deps } from '../http/env'
import { MemoryError } from '../memory/errors'
import { syncEntryLinks } from '../memory/links'
import { sealVariantContent } from '../memory/service'
import { allocateUniqueShortIds, rewriteWikiLinks } from '../memory/shortId'
import { openCircleExport } from './circleFormat'
import {
  CIRCLE_EXPORT_MAX_PLAIN_BYTES,
  CircleExportRecord,
  describeIssue,
  type CircleExportHeader,
  type ClientRecord,
  type CredentialRecord,
  type EntryLinkRecord,
  type EntryRecord,
  type FacetDimensionRecord,
  type FacetTermRecord,
  type IdentityRecord,
  type PersonaRecord,
  type SubjectRecord,
  type VaultConnectionRecord,
} from './circleRecords'

export interface ParsedCircleExport {
  header: CircleExportHeader
  personas: PersonaRecord[]
  clients: ClientRecord[]
  facetDimensions: FacetDimensionRecord[]
  facetTerms: FacetTermRecord[]
  subjects: SubjectRecord[]
  identities: IdentityRecord[]
  vaultConnections: VaultConnectionRecord[]
  credentials: CredentialRecord[]
  entries: EntryRecord[]
  links: EntryLinkRecord[]
}

export function parseCircleExport(plain: Buffer): ParsedCircleExport {
  const lines = plain
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) {
    throw new MemoryError(400, '导出文件为空')
  }

  let header: CircleExportHeader | null = null
  const out: Omit<ParsedCircleExport, 'header'> = {
    personas: [],
    clients: [],
    facetDimensions: [],
    facetTerms: [],
    subjects: [],
    identities: [],
    vaultConnections: [],
    credentials: [],
    entries: [],
    links: [],
  }

  for (let i = 0; i < lines.length; i++) {
    let raw: unknown
    try {
      raw = JSON.parse(lines[i]!)
    } catch {
      throw new MemoryError(400, `导出文件第 ${i + 1} 行不是合法的 JSON`)
    }
    const parsed = CircleExportRecord.safeParse(raw)
    if (!parsed.success) {
      throw new MemoryError(400, `导出文件第 ${i + 1} 行格式有误：${describeIssue(parsed.error)}`)
    }
    const rec = parsed.data
    switch (rec.type) {
      case 'header':
        if (header) throw new MemoryError(400, '导出文件包含重复的文件头')
        header = rec
        break
      case 'persona':
        out.personas.push(rec)
        break
      case 'client':
        out.clients.push(rec)
        break
      case 'facet_dimension':
        out.facetDimensions.push(rec)
        break
      case 'facet_term':
        out.facetTerms.push(rec)
        break
      case 'subject':
        out.subjects.push(rec)
        break
      case 'identity':
        out.identities.push(rec)
        break
      case 'vault_connection':
        out.vaultConnections.push(rec)
        break
      case 'credential':
        out.credentials.push(rec)
        break
      case 'entry':
        out.entries.push(rec)
        break
      case 'link':
        out.links.push(rec)
        break
    }
  }

  if (!header) throw new MemoryError(400, '导出文件缺少文件头')
  return { header, ...out }
}

export function checkCircleExport(x: ParsedCircleExport): CircleImportCounts {
  const personaSlugs = new Set<string>()
  for (const p of x.personas) {
    if (personaSlugs.has(p.slug)) throw new MemoryError(400, `重复的人格标识：${p.slug}`)
    personaSlugs.add(p.slug)
  }
  const clientSlugs = new Set<string>()
  for (const c of x.clients) {
    if (clientSlugs.has(c.slug)) throw new MemoryError(400, `重复的接入实例标识：${c.slug}`)
    clientSlugs.add(c.slug)
  }
  const subjectKeys = new Set<string>()
  for (const s of x.subjects) {
    if (subjectKeys.has(s.key)) throw new MemoryError(400, `重复的对象键：${s.key}`)
    subjectKeys.add(s.key)
  }
  const shortIds = new Set<string>()
  let variantCount = 0
  let secretCount = 0
  for (const e of x.entries) {
    const sid = e.shortId.toLowerCase()
    if (shortIds.has(sid)) throw new MemoryError(400, `包内存在重复的短 ID：${e.shortId}`)
    shortIds.add(sid)
    if (e.sensitivity === 'secret') secretCount++
    variantCount += e.variants.length
  }

  return {
    personas: x.personas.length,
    clients: x.clients.length,
    facetDimensions: x.facetDimensions.length,
    facetTerms: x.facetTerms.length,
    subjects: x.subjects.length,
    linkedSubjects: x.identities.length,
    entries: x.entries.length,
    variants: variantCount,
    links: x.links.length,
    secrets: secretCount,
    credentials: x.credentials.length,
    vaultConnections: x.vaultConnections.length,
  }
}

export async function inspectCircleImport(
  file: Buffer,
  passphrase: string,
): Promise<CircleImportPreview> {
  const plain = await openCircleExport(file, passphrase, CIRCLE_EXPORT_MAX_PLAIN_BYTES)
  const parsed = parseCircleExport(plain)
  const counts = checkCircleExport(parsed)
  return {
    exporter: parsed.header.exporter,
    circleKind: parsed.header.circle.kind,
    circleName: parsed.header.circle.name,
    circleSlug: parsed.header.circle.slug,
    exportedAt: parsed.header.exportedAt,
    counts,
  }
}

export interface ImportCircleOptions {
  file: Buffer
  passphrase: string
  name?: string | undefined
  intoPersonalCircle?: boolean | undefined
}

export async function importCircle(
  deps: Pick<Deps, 'db' | 'masterKey'>,
  accountId: string,
  options: ImportCircleOptions,
): Promise<CircleImportResult> {
  const plain = await openCircleExport(
    options.file,
    options.passphrase,
    CIRCLE_EXPORT_MAX_PLAIN_BYTES,
  )
  const parsed = parseCircleExport(plain)
  const counts = checkCircleExport(parsed)

  const needMasterKey =
    parsed.entries.some((e) => e.sensitivity === 'secret') ||
    parsed.credentials.some((c) => c.source === 'hosted')
  if (needMasterKey && !deps.masterKey) {
    throw new MemoryError(400, '服务端未配置 KIOKU_MASTER_KEY，无法导入机密词条或托管凭据')
  }

  const mergeIntoPersonal =
    parsed.header.circle.kind === 'personal' && options.intoPersonalCircle !== false

  return deps.db.transaction(async (tx) => {
    const { assigned, remapped } = await allocateUniqueShortIds(
      tx,
      parsed.entries.map((e) => e.shortId),
    )

    let targetCircle: { id: string; kind: 'personal' | 'shared'; slug: string; name: string }
    if (mergeIntoPersonal) {
      const [personal] = await tx
        .select({
          id: circles.id,
          kind: circles.kind,
          slug: circles.slug,
          name: circles.name,
        })
        .from(circles)
        .where(and(eq(circles.kind, 'personal'), eq(circles.ownerAccountId, accountId)))
        .limit(1)
      if (!personal) {
        throw new MemoryError(400, '当前账号尚未初始化个人圈')
      }
      targetCircle = personal
    } else {
      const limit = await claimOwnerSeat(tx, accountId)
      if (limit !== null) {
        throw new MemoryError(403, circleLimitReached(limit))
      }
      const created = await insertSharedCircle(tx, {
        name: options.name?.trim() || parsed.header.circle.name,
        defaultFacets: parsed.header.circle.defaultFacets,
        ownerAccountId: accountId,
      })
      if (!created) {
        throw new MemoryError(409, '无法创建目标共享记忆圈，请修改名称后重试')
      }
      await tx
        .update(circleMembers)
        .set({ dreamPrivate: parsed.header.exporter.dreamPrivate })
        .where(and(eq(circleMembers.circleId, created.id), eq(circleMembers.accountId, accountId)))
      targetCircle = {
        id: created.id,
        kind: 'shared',
        slug: created.slug,
        name: created.name,
      }
    }

    await withCircle(tx, targetCircle.id, async (cTx, now) => {
      // 1. 人格及特质
      const existingPersonas = await cTx.select().from(personas)
      const personaIdBySlug = new Map(existingPersonas.map((p) => [p.slug, p.id]))
      for (const p of parsed.personas) {
        if (!personaIdBySlug.has(p.slug)) {
          const [ins] = await cTx
            .insert(personas)
            .values({
              circleId: targetCircle.id,
              slug: p.slug,
              name: p.name,
              description: p.description,
            })
            .returning({ id: personas.id })
          personaIdBySlug.set(p.slug, ins!.id)
        }
      }
      for (const p of parsed.personas) {
        const pid = personaIdBySlug.get(p.slug)!
        if (p.extendsSlug && personaIdBySlug.has(p.extendsSlug)) {
          const parentId = personaIdBySlug.get(p.extendsSlug)!
          if (parentId !== pid) {
            await cTx
              .update(personas)
              .set({ extendsId: parentId })
              .where(and(eq(personas.id, pid), isNull(personas.extendsId)))
          }
        }
        if (p.traits.length) {
          await cTx
            .insert(personaTraits)
            .values(
              p.traits.map((t) => ({
                circleId: targetCircle.id,
                personaId: pid,
                traitKey: t.traitKey,
                title: t.title,
                content: t.content,
                sortOrder: t.sortOrder,
              })),
            )
            .onConflictDoNothing()
        }
      }

      // 2. 联系人与身份（合并导入按平台身份去重关联）
      const [existingSubjects, existingIdentities] = await Promise.all([
        cTx.select().from(subjects),
        cTx.select().from(subjectIdentities),
      ])
      const existingByIdentity = new Map(
        existingIdentities.map((i) => [`${i.platform}\0${i.kind}\0${i.externalId}`, i.subjectId]),
      )
      const subjectIdByKey = new Map<string, string>()
      const subjectKindByKey = new Map(parsed.subjects.map((s) => [s.key, s.kind]))
      const identitiesByKey = new Map<string, IdentityRecord[]>()
      for (const ident of parsed.identities) {
        const list = identitiesByKey.get(ident.subjectKey) ?? []
        list.push(ident)
        identitiesByKey.set(ident.subjectKey, list)
      }

      for (const s of parsed.subjects) {
        const idents = identitiesByKey.get(s.key) ?? []
        const matchedExisting = idents
          .map((i) => existingByIdentity.get(`${i.platform}\0${i.kind}\0${i.externalId}`))
          .find(Boolean)
        if (matchedExisting && existingSubjects.some((es) => es.id === matchedExisting)) {
          subjectIdByKey.set(s.key, matchedExisting)
        } else {
          const [ins] = await cTx
            .insert(subjects)
            .values({
              circleId: targetCircle.id,
              kind: s.kind,
              displayName: s.displayName,
              nameLocked: s.nameLocked,
            })
            .returning({ id: subjects.id })
          subjectIdByKey.set(s.key, ins!.id)
        }
      }
      for (const ident of parsed.identities) {
        const subjectId = subjectIdByKey.get(ident.subjectKey)
        if (!subjectId) continue
        await cTx
          .insert(subjectIdentities)
          .values({
            circleId: targetCircle.id,
            subjectId,
            kind: ident.kind,
            platform: ident.platform,
            externalId: ident.externalId,
            displayName: ident.displayName,
          })
          .onConflictDoNothing()
      }

      // 3. 接入实例与按群规则
      const existingClients = await cTx.select().from(clients)
      const clientIdBySlug = new Map(existingClients.map((c) => [c.slug, c.id]))
      for (const c of parsed.clients) {
        let clientId = clientIdBySlug.get(c.slug)
        if (!clientId) {
          const [ins] = await cTx
            .insert(clients)
            .values({
              circleId: targetCircle.id,
              slug: c.slug,
              name: c.name,
              runtimeFamily: c.runtimeFamily,
              ownerAccountId: accountId,
              defaultPersonaId: c.defaultPersonaSlug
                ? (personaIdBySlug.get(c.defaultPersonaSlug) ?? null)
                : null,
              config: c.config,
            })
            .returning({ id: clients.id })
          clientId = ins!.id
          clientIdBySlug.set(c.slug, clientId)
        }
        for (const r of c.groupRules) {
          const ident = existingIdentities.find(
            (i) =>
              i.platform === r.groupPlatform &&
              i.kind === 'group' &&
              i.externalId === r.groupExternalId,
          )
          let groupSubjectId = ident?.subjectId
          if (!groupSubjectId) {
            const matchedImportIdent = parsed.identities.find(
              (i) =>
                i.platform === r.groupPlatform &&
                i.kind === 'group' &&
                i.externalId === r.groupExternalId,
            )
            if (matchedImportIdent) {
              groupSubjectId = subjectIdByKey.get(matchedImportIdent.subjectKey)
            }
          }
          if (!groupSubjectId) continue
          await cTx
            .insert(clientGroupRules)
            .values({
              circleId: targetCircle.id,
              clientId,
              groupSubjectId,
              personaId: r.personaSlug ? (personaIdBySlug.get(r.personaSlug) ?? null) : null,
              isolateGroupMemory: r.isolateGroupMemory,
            })
            .onConflictDoNothing()
        }
      }

      // 4. 切面维与词表
      for (const d of parsed.facetDimensions) {
        if (d.key === 'realm' || d.key === 'env' || d.key === 'runtime' || d.key === 'project') {
          continue
        }
        await cTx
          .insert(facetDimensions)
          .values({
            circleId: targetCircle.id,
            key: d.key,
            name: d.name,
            matchMode: d.matchMode,
            description: d.description,
          })
          .onConflictDoNothing()
      }
      for (const t of parsed.facetTerms) {
        await cTx
          .insert(facetTerms)
          .values({
            circleId: targetCircle.id,
            dimensionKey: t.dimensionKey,
            slug: t.slug,
            label: t.label,
            implies: t.implies,
            aliases: t.aliases,
            autoRegistered: t.autoRegistered,
          })
          .onConflictDoNothing()
      }

      // 5. 密码库连接与凭据（重封托管密文，合并模式跳过同名有效凭据）
      const existingVaults = await cTx
        .select()
        .from(vaultConnections)
        .where(eq(vaultConnections.ownerAccountId, accountId))
      const vaultIdByKey = new Map<string, string>()
      for (const v of parsed.vaultConnections) {
        const match = existingVaults.find(
          (ev) => ev.serverUrl === v.serverUrl && ev.vaultUserId === v.vaultUserId,
        )
        if (match) {
          vaultIdByKey.set(v.key, match.id)
        } else {
          const [ins] = await cTx
            .insert(vaultConnections)
            .values({
              circleId: targetCircle.id,
              ownerAccountId: accountId,
              serverUrl: v.serverUrl,
              email: v.email,
              vaultUserId: v.vaultUserId,
              deviceId: v.deviceId,
              status: 'disconnected',
              disconnectedAt: now,
              defaultOrganizationId: v.defaultOrganizationId,
              defaultCollectionId: v.defaultCollectionId,
              defaultCollectionName: v.defaultCollectionName,
            })
            .returning({ id: vaultConnections.id })
          vaultIdByKey.set(v.key, ins!.id)
        }
      }

      const liveCredentials = await cTx
        .select({ identifier: credentials.identifier })
        .from(credentials)
        .where(and(eq(credentials.ownerAccountId, accountId), isNull(credentials.deletedAt)))
      const takenCredIdentifiers = new Set(liveCredentials.map((c) => c.identifier))

      for (const c of parsed.credentials) {
        if (takenCredIdentifiers.has(c.identifier)) continue
        takenCredIdentifiers.add(c.identifier)
        const id = randomUUID()
        const clientIds = c.clientSlugs
          ? c.clientSlugs
              .map((slug) => clientIdBySlug.get(slug))
              .filter((x): x is string => Boolean(x))
          : null
        const allowedRealms = c.allowedRealms ? normalizeRealms(c.allowedRealms) : null

        if (c.source === 'hosted') {
          const sealed = sealCredentialValues(deps.masterKey!, id, c.values ?? {})
          await cTx.insert(credentials).values({
            id,
            circleId: targetCircle.id,
            ownerAccountId: accountId,
            identifier: c.identifier,
            name: c.name,
            description: c.description,
            source: 'hosted',
            fields: c.fields,
            ciphertext: sealed.ciphertext,
            wrappedKey: sealed.wrappedKey,
            keyId: sealed.keyId,
            clientIds,
            allowedRealms,
            expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
            rotationRequestedAt: c.rotationRequestedAt ? new Date(c.rotationRequestedAt) : null,
            valueVersion: c.valueVersion,
            valueChangedAt: c.valueChangedAt ? new Date(c.valueChangedAt) : null,
          })
        } else {
          const connId = c.vaultConnectionKey
            ? (vaultIdByKey.get(c.vaultConnectionKey) ?? null)
            : null
          await cTx
            .insert(credentials)
            .values({
              id,
              circleId: targetCircle.id,
              ownerAccountId: accountId,
              identifier: c.identifier,
              name: c.name,
              description: c.description,
              source: 'vault',
              vaultConnectionId: connId,
              vaultItemId: c.vaultItemId,
              vaultRevision: c.vaultRevision,
              fields: c.fields,
              clientIds,
              allowedRealms,
              expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
              rotationRequestedAt: c.rotationRequestedAt ? new Date(c.rotationRequestedAt) : null,
              valueVersion: c.valueVersion,
              valueChangedAt: c.valueChangedAt ? new Date(c.valueChangedAt) : null,
            })
            .onConflictDoNothing()
        }
      }

      // 6. 词条与多变体导入（重写碰撞短 ID 与双链，重新信封加密与敏感扫描）
      const { settings: privacy } = await loadCirclePrivacy(cTx, targetCircle.id)

      const resolveImportedScope = (rawScope: string): string => {
        const at = rawScope.indexOf(':')
        if (at < 0) return rawScope
        const kind = rawScope.slice(0, at)
        const rest = rawScope.slice(at + 1)
        if (kind === 'client') {
          const cid = clientIdBySlug.get(rest)
          return cid ? `client:${cid}` : 'global'
        }
        if (kind === 'group' || kind === 'direct') {
          const sid = subjectIdByKey.get(rest)
          return sid ? `${kind}:${sid}` : 'global'
        }
        return rawScope
      }

      const adjustSensitivity = (kind: EntryRecord['kind'], raw: Sensitivity): Sensitivity => {
        if (sensitivityAllowed(targetCircle.kind, kind, raw)) return raw
        return targetCircle.kind === 'personal' ? 'private' : 'internal'
      }

      for (const e of parsed.entries) {
        const nextShortId = assigned.get(e.shortId.toLowerCase())!
        const nextSensitivity = adjustSensitivity(e.kind, e.sensitivity)
        const subjectId = e.subjectKey ? (subjectIdByKey.get(e.subjectKey) ?? null) : null
        const subjectKind = e.subjectKey ? (subjectKindByKey.get(e.subjectKey) ?? null) : null
        const clientId = e.clientSlug ? (clientIdBySlug.get(e.clientSlug) ?? null) : null
        const ownerAccountId =
          targetCircle.kind === 'personal' && e.kind === 'entry' ? accountId : null

        // 若导入环境改变导致 episode 无上下文也无对象，降格转成 curated entry 保证满足行检查约束
        const finalKind = e.kind === 'episode' && subjectId === null ? ('entry' as const) : e.kind

        const rewrittenVariants = e.variants.map((v, idx) => ({
          when: normalizeWhen(v.when),
          whenSignature: whenSignature(v.when),
          sortOrder: v.sortOrder ?? idx,
          content: rewriteWikiLinks(v.content, assigned),
        }))

        const title = deriveEntryTitle(e.title, rewrittenVariants, nextShortId, nextSensitivity)
        const realms = normalizeRealms([
          ...e.realms,
          ...rewrittenVariants.flatMap((v) => v.when.realm ?? []),
        ])

        const [inserted] = await cTx
          .insert(entries)
          .values({
            circleId: targetCircle.id,
            shortId: nextShortId,
            circleKind: targetCircle.kind,
            kind: finalKind,
            ownerAccountId,
            clientId,
            subjectId: finalKind === 'entry' ? null : subjectId,
            subjectKind: finalKind === 'entry' ? null : subjectKind,
            provenance: e.provenance,
            originScope: resolveImportedScope(e.originScope),
            title,
            sensitivity: adjustSensitivity(finalKind, nextSensitivity),
            priority: e.priority,
            disclosure: e.disclosure,
            topics: e.topics,
            realms,
            validFrom: new Date(e.validFrom),
            validTo: e.validTo ? new Date(e.validTo) : null,
            expiresAt: e.expiresAt ? new Date(e.expiresAt) : null,
            version: 1,
            createdAt: new Date(e.createdAt),
            updatedAt: new Date(e.updatedAt),
          })
          .returning()

        const row = inserted!
        const headerText =
          row.sensitivity === 'secret'
            ? ''
            : [row.title, ...row.topics, ...(row.disclosure ? [row.disclosure] : []), ...e.glossary]
                .filter(Boolean)
                .join(' ')

        const createdVariants: {
          id: string
          content: string | null
          when: Record<string, string[]>
        }[] = []
        const credIds = new Set<string>()

        for (const v of rewrittenVariants) {
          const variantId = randomUUID()
          if (row.sensitivity === 'secret') {
            const sealed = sealVariantContent(deps.masterKey!, variantId, v.content)
            await cTx.insert(entryVariants).values({
              id: variantId,
              circleId: targetCircle.id,
              entryId: row.id,
              kind: row.kind,
              sensitivity: row.sensitivity,
              when: v.when,
              whenSignature: v.whenSignature,
              sortOrder: v.sortOrder,
              content: null,
              searchHeader: '',
              ciphertext: sealed.ciphertext,
              wrappedKey: sealed.wrappedKey,
              keyId: sealed.keyId,
            })
            createdVariants.push({ id: variantId, content: null, when: v.when })
          } else {
            const outcome = evaluateSensitiveContent(v.content, privacy)
            for (const cid of placeholderIdentifiers(v.content)) credIds.add(cid)
            await cTx.insert(entryVariants).values({
              id: variantId,
              circleId: targetCircle.id,
              entryId: row.id,
              kind: row.kind,
              sensitivity: row.sensitivity,
              when: v.when,
              whenSignature: v.whenSignature,
              sortOrder: v.sortOrder,
              content: v.content,
              searchHeader: headerText,
              sensitiveCredential: outcome.hasCredential,
              sensitivePii: outcome.hasPii,
              sensitiveFindings: outcome.findings,
            })
            createdVariants.push({ id: variantId, content: v.content, when: v.when })
          }
        }

        if (e.glossary.length) {
          await cTx
            .insert(entryGlossary)
            .values(
              e.glossary.map((keyword) => ({
                circleId: targetCircle.id,
                entryId: row.id,
                keyword,
              })),
            )
            .onConflictDoNothing()
        }
        if (e.legacyUris.length) {
          await cTx
            .insert(legacyUris)
            .values(
              e.legacyUris.map((l) => ({
                circleId: targetCircle.id,
                entryId: row.id,
                legacyUri: l.legacyUri,
                source: l.source,
              })),
            )
            .onConflictDoNothing()
        }
        if (credIds.size && row.sensitivity !== 'secret') {
          await cTx
            .insert(entryCredentialRefs)
            .values(
              [...credIds].map((identifier) => ({
                circleId: targetCircle.id,
                entryId: row.id,
                identifier,
              })),
            )
            .onConflictDoNothing()
        }

        await syncEntryLinks(cTx, {
          circleId: targetCircle.id,
          entryId: row.id,
          shortId: row.shortId,
          sensitivity: row.sensitivity,
          provenance: row.provenance,
          variants: createdVariants.map((v) => ({ id: v.id, content: v.content })),
        })

        await cTx.insert(entryEvents).values({
          circleId: targetCircle.id,
          entryId: row.id,
          shortId: row.shortId,
          eventType: 'import',
          provenance: row.provenance,
          actorAccountId: accountId,
          before: null,
          after: {
            shortId: row.shortId,
            title: row.title,
            kind: row.kind,
            sensitivity: row.sensitivity,
            priority: row.priority,
            disclosure: row.disclosure,
            topics: row.topics,
            realms: row.realms,
            glossary: e.glossary,
            variants: createdVariants.map((v) => ({ when: v.when, content: v.content })),
            version: 1,
            deleted: false,
            validTo: row.validTo ? row.validTo.toISOString() : null,
            circleId: targetCircle.id,
            originScope: row.originScope,
            clientId: row.clientId,
            ownerAccountId: row.ownerAccountId,
            subjectKind: row.subjectKind,
            deletedAt: null,
            expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          },
          context: { source: 'circle-export' },
        })
      }
    })

    return {
      circleId: targetCircle.id,
      circleKind: targetCircle.kind,
      slug: targetCircle.slug,
      name: targetCircle.name,
      exporter: parsed.header.exporter,
      counts,
      remappedShortIds: remapped,
    }
  })
}
