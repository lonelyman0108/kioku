import { ClientConfig, type CircleImportCounts, type WhenCondition } from '@kioku/contracts'
import { and, asc, eq, isNull } from 'drizzle-orm'

import { consoleAccess } from '../access/access'
import { memberRole } from '../auth/middleware'
import { openCredentialValues } from '../credential/service'
import { withCircle } from '../db/client'
import {
  accounts,
  circleMembers,
  circles,
  clientGroupRules,
  clients,
  credentialEvents,
  credentials,
  entries,
  entryEvents,
  entryGlossary,
  entryLinks,
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
import { readableConditions } from '../memory/filter'
import { ACCESS_EVENT, openVariantContent } from '../memory/service'
import { DEFAULT_KDF, sealCircleExport, type KdfParams } from './circleFormat'
import {
  CIRCLE_EXPORT_FORMAT,
  CIRCLE_EXPORT_MAX_PLAIN_BYTES,
  CIRCLE_EXPORT_VERSION,
  type CircleExportHeader,
  type CircleExportRecord,
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

export interface CircleExportResult {
  buffer: Buffer
  filename: string
  header: CircleExportHeader
  counts: CircleImportCounts
}

function portableOriginScope(
  originScope: string,
  clientSlugById: Map<string, string>,
  subjectKeyById: Map<string, string>,
): string {
  const at = originScope.indexOf(':')
  if (at < 0) return originScope
  const kind = originScope.slice(0, at)
  const rest = originScope.slice(at + 1)
  if (kind === 'client') {
    const slug = clientSlugById.get(rest)
    return slug ? `client:${slug}` : 'global'
  }
  if (kind === 'group' || kind === 'direct') {
    const key = subjectKeyById.get(rest)
    return key ? `${kind}:${key}` : 'global'
  }
  return originScope
}

export async function exportCircle(
  deps: Pick<Deps, 'db' | 'masterKey'>,
  circleId: string,
  accountId: string,
  passphrase: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<CircleExportResult> {
  const role = await memberRole(deps as Deps, circleId, accountId)
  if (role !== 'owner') {
    throw new MemoryError(403, '只有记忆圈所有者可以导出记忆圈')
  }

  const payload = await withCircle(deps.db, circleId, async (tx, now) => {
    const [circleRows, memberRows, accountRows] = await Promise.all([
      tx.select().from(circles).where(eq(circles.id, circleId)).limit(1),
      tx
        .select()
        .from(circleMembers)
        .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, accountId)))
        .limit(1),
      tx
        .select({ displayName: accounts.displayName })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1),
    ])
    const circle = circleRows[0]
    const member = memberRows[0]
    const account = accountRows[0]
    if (!circle || !member || !account) {
      throw new MemoryError(404, '记忆圈或成员不存在')
    }

    const access = consoleAccess(
      circle.id,
      circle.kind,
      'owner',
      accountId,
      circle.defaultFacets?.realm ?? [],
    )

    const [
      personaRows,
      traitRows,
      clientRows,
      groupRuleRows,
      dimensionRows,
      termRows,
      subjectRows,
      identityRows,
      vaultRows,
      credentialRows,
      entryRows,
    ] = await Promise.all([
      tx.select().from(personas).orderBy(asc(personas.createdAt), asc(personas.slug)),
      tx
        .select()
        .from(personaTraits)
        .orderBy(asc(personaTraits.sortOrder), asc(personaTraits.traitKey)),
      tx.select().from(clients).orderBy(asc(clients.createdAt), asc(clients.slug)),
      tx.select().from(clientGroupRules),
      tx.select().from(facetDimensions).orderBy(asc(facetDimensions.key)),
      tx.select().from(facetTerms).orderBy(asc(facetTerms.dimensionKey), asc(facetTerms.slug)),
      tx.select().from(subjects).orderBy(asc(subjects.createdAt), asc(subjects.id)),
      tx
        .select()
        .from(subjectIdentities)
        .orderBy(asc(subjectIdentities.createdAt), asc(subjectIdentities.id)),
      tx
        .select()
        .from(vaultConnections)
        .where(eq(vaultConnections.ownerAccountId, accountId))
        .orderBy(asc(vaultConnections.createdAt), asc(vaultConnections.id)),
      tx
        .select()
        .from(credentials)
        .where(and(eq(credentials.ownerAccountId, accountId), isNull(credentials.deletedAt)))
        .orderBy(asc(credentials.identifier)),
      tx
        .select()
        .from(entries)
        .where(
          and(
            isNull(entries.deletedAt),
            isNull(entries.conversationId),
            readableConditions(access, { now, explicit: true }),
          ),
        )
        .orderBy(asc(entries.createdAt), asc(entries.shortId)),
    ])

    const personaSlugById = new Map(personaRows.map((p) => [p.id, p.slug]))
    const traitsByPersona = new Map<string, typeof traitRows>()
    for (const t of traitRows) {
      const list = traitsByPersona.get(t.personaId) ?? []
      list.push(t)
      traitsByPersona.set(t.personaId, list)
    }

    const clientSlugById = new Map(clientRows.map((c) => [c.id, c.slug]))
    const subjectKeyById = new Map(subjectRows.map((s, i) => [s.id, `s:${i + 1}`]))
    const vaultKeyById = new Map(vaultRows.map((v, i) => [v.id, `v:${i + 1}`]))

    const identityBySubject = new Map<string, (typeof identityRows)[number]>()
    for (const ident of identityRows) {
      if (!identityBySubject.has(ident.subjectId)) identityBySubject.set(ident.subjectId, ident)
    }

    const header: CircleExportHeader = {
      type: 'header',
      format: CIRCLE_EXPORT_FORMAT,
      version: CIRCLE_EXPORT_VERSION,
      exportedAt: now.toISOString(),
      circle: {
        kind: circle.kind,
        slug: circle.slug,
        name: circle.name,
        defaultFacets: (circle.defaultFacets ?? {}) as WhenCondition,
      },
      exporter: {
        displayName: account.displayName,
        dreamPrivate: member.dreamPrivate,
      },
    }

    const records: CircleExportRecord[] = [header]

    for (const p of personaRows) {
      const rec: PersonaRecord = {
        type: 'persona',
        slug: p.slug,
        name: p.name,
        description: p.description,
        extendsSlug: p.extendsId ? (personaSlugById.get(p.extendsId) ?? null) : null,
        traits: (traitsByPersona.get(p.id) ?? []).map((t) => ({
          traitKey: t.traitKey,
          title: t.title,
          content: t.content,
          sortOrder: t.sortOrder,
        })),
      }
      records.push(rec)
    }

    for (const c of clientRows) {
      const rules = groupRuleRows.filter((r) => r.clientId === c.id)
      const rec: ClientRecord = {
        type: 'client',
        slug: c.slug,
        name: c.name,
        runtimeFamily: c.runtimeFamily,
        defaultPersonaSlug: c.defaultPersonaId
          ? (personaSlugById.get(c.defaultPersonaId) ?? null)
          : null,
        config: ClientConfig.parse(c.config),
        groupRules: rules.flatMap((r) => {
          const ident = identityBySubject.get(r.groupSubjectId)
          if (!ident) return []
          return [
            {
              groupPlatform: ident.platform,
              groupExternalId: ident.externalId,
              groupName: ident.displayName,
              personaSlug: r.personaId ? (personaSlugById.get(r.personaId) ?? null) : null,
              isolateGroupMemory: r.isolateGroupMemory,
            },
          ]
        }),
      }
      records.push(rec)
    }

    for (const d of dimensionRows) {
      const rec: FacetDimensionRecord = {
        type: 'facet_dimension',
        key: d.key,
        name: d.name,
        matchMode: d.matchMode,
        description: d.description,
      }
      records.push(rec)
    }

    for (const t of termRows) {
      const rec: FacetTermRecord = {
        type: 'facet_term',
        dimensionKey: t.dimensionKey,
        slug: t.slug,
        label: t.label,
        implies: t.implies,
        aliases: [...t.aliases],
        autoRegistered: t.autoRegistered,
      }
      records.push(rec)
    }

    for (const s of subjectRows) {
      const rec: SubjectRecord = {
        type: 'subject',
        key: subjectKeyById.get(s.id)!,
        kind: s.kind,
        displayName: s.displayName,
        nameLocked: s.nameLocked,
      }
      records.push(rec)
    }

    for (const ident of identityRows) {
      const subjectKey = subjectKeyById.get(ident.subjectId)
      if (!subjectKey) continue
      const rec: IdentityRecord = {
        type: 'identity',
        subjectKey,
        kind: ident.kind,
        platform: ident.platform,
        externalId: ident.externalId,
        displayName: ident.displayName,
      }
      records.push(rec)
    }

    for (const v of vaultRows) {
      const rec: VaultConnectionRecord = {
        type: 'vault_connection',
        key: vaultKeyById.get(v.id)!,
        serverUrl: v.serverUrl,
        email: v.email,
        vaultUserId: v.vaultUserId,
        deviceId: v.deviceId,
        status: v.status,
        disabledReason: v.disabledReason,
        lastErrorKind: v.lastErrorKind,
        lastErrorAt: v.lastErrorAt ? v.lastErrorAt.toISOString() : null,
        lastCheckedAt: v.lastCheckedAt ? v.lastCheckedAt.toISOString() : null,
        disconnectedAt: v.disconnectedAt ? v.disconnectedAt.toISOString() : null,
        defaultOrganizationId: v.defaultOrganizationId,
        defaultCollectionId: v.defaultCollectionId,
        defaultCollectionName: v.defaultCollectionName,
      }
      records.push(rec)
    }

    for (const c of credentialRows) {
      let values: Record<string, string> | null = null
      if (c.source === 'hosted') {
        if (!deps.masterKey) {
          throw new MemoryError(400, '服务端未配置主密钥，无法导出托管的凭据')
        }
        values = openCredentialValues(deps.masterKey, {
          id: c.id,
          ciphertext: c.ciphertext!,
          wrappedKey: c.wrappedKey!,
          keyId: c.keyId,
        })
        await tx.insert(credentialEvents).values({
          circleId,
          credentialId: c.id,
          eventType: 'access',
          actorAccountId: accountId,
          context: { via: 'circle_export', result: 'ok', fields: c.fields.map((f) => f.name) },
        })
      }
      const rec: CredentialRecord = {
        type: 'credential',
        identifier: c.identifier,
        name: c.name,
        description: c.description,
        source: c.source,
        fields: c.fields,
        values,
        vaultConnectionKey: c.vaultConnectionId
          ? (vaultKeyById.get(c.vaultConnectionId) ?? null)
          : null,
        vaultItemId: c.vaultItemId,
        vaultRevision: c.vaultRevision,
        clientSlugs: c.clientIds
          ? c.clientIds.map((id) => clientSlugById.get(id)).filter((s): s is string => Boolean(s))
          : null,
        allowedRealms: c.allowedRealms,
        expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
        rotationRequestedAt: c.rotationRequestedAt ? c.rotationRequestedAt.toISOString() : null,
        valueVersion: c.valueVersion,
        valueChangedAt: c.valueChangedAt ? c.valueChangedAt.toISOString() : null,
      }
      records.push(rec)
    }

    const entryIds = entryRows.map((e) => e.id)
    const [allVariants, allGlossary, allLegacyUris, allLinks] = entryIds.length
      ? await Promise.all([
          tx
            .select()
            .from(entryVariants)
            .where(eq(entryVariants.circleId, circleId))
            .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.createdAt)),
          tx.select().from(entryGlossary).where(eq(entryGlossary.circleId, circleId)),
          tx.select().from(legacyUris).where(eq(legacyUris.circleId, circleId)),
          tx.select().from(entryLinks).where(eq(entryLinks.circleId, circleId)),
        ])
      : [[], [], [], []]

    const variantsByEntry = new Map<string, (typeof allVariants)[number][]>()
    const variantById = new Map<string, (typeof allVariants)[number]>()
    for (const v of allVariants) {
      variantById.set(v.id, v)
      const list = variantsByEntry.get(v.entryId) ?? []
      list.push(v)
      variantsByEntry.set(v.entryId, list)
    }
    const glossaryByEntry = new Map<string, string[]>()
    for (const g of allGlossary) {
      const list = glossaryByEntry.get(g.entryId) ?? []
      list.push(g.keyword)
      glossaryByEntry.set(g.entryId, list)
    }
    const legacyByEntry = new Map<string, { legacyUri: string; source: string }[]>()
    for (const l of allLegacyUris) {
      const list = legacyByEntry.get(l.entryId) ?? []
      list.push({ legacyUri: l.legacyUri, source: l.source })
      legacyByEntry.set(l.entryId, list)
    }

    const entryById = new Map(entryRows.map((e) => [e.id, e]))
    let variantCount = 0
    let secretCount = 0

    for (const e of entryRows) {
      const vList = variantsByEntry.get(e.id) ?? []
      if (!vList.length) continue
      if (e.sensitivity === 'secret') {
        if (!deps.masterKey) {
          throw new MemoryError(400, '服务端未配置主密钥，无法导出机密词条')
        }
        secretCount++
        await tx.insert(entryEvents).values({
          circleId,
          entryId: e.id,
          shortId: e.shortId,
          eventType: ACCESS_EVENT,
          provenance: 'owner',
          actorAccountId: accountId,
          before: null,
          after: null,
          context: { via: 'export' },
        })
      }
      variantCount += vList.length
      const rec: EntryRecord = {
        type: 'entry',
        shortId: e.shortId,
        kind: e.kind,
        originScope: portableOriginScope(e.originScope, clientSlugById, subjectKeyById),
        subjectKey: e.subjectId ? (subjectKeyById.get(e.subjectId) ?? null) : null,
        clientSlug: e.clientId ? (clientSlugById.get(e.clientId) ?? null) : null,
        title: e.title,
        sensitivity: e.sensitivity,
        provenance: e.provenance,
        priority: e.priority,
        disclosure: e.disclosure,
        topics: [...e.topics],
        realms: [...e.realms],
        glossary: (glossaryByEntry.get(e.id) ?? []).sort(),
        legacyUris: (legacyByEntry.get(e.id) ?? []).sort((a, b) =>
          a.legacyUri.localeCompare(b.legacyUri),
        ),
        validFrom: e.validFrom.toISOString(),
        validTo: e.validTo ? e.validTo.toISOString() : null,
        expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
        variants: vList.map((v) => ({
          when: v.when,
          sortOrder: v.sortOrder,
          content:
            e.sensitivity === 'secret'
              ? openVariantContent(deps.masterKey!, v.id, v)
              : (v.content ?? ''),
          createdAt: v.createdAt.toISOString(),
          updatedAt: v.updatedAt.toISOString(),
        })),
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      }
      records.push(rec)
    }

    let linkCount = 0
    for (const l of allLinks) {
      const src = entryById.get(l.sourceEntryId)
      const v = variantById.get(l.sourceVariantId)
      if (!src || !v) continue
      linkCount++
      const rec: EntryLinkRecord = {
        type: 'link',
        sourceShortId: src.shortId,
        sourceWhen: v.when,
        targetShortId: l.targetShortId,
      }
      records.push(rec)
    }

    const counts: CircleImportCounts = {
      personas: personaRows.length,
      clients: clientRows.length,
      facetDimensions: dimensionRows.length,
      facetTerms: termRows.length,
      subjects: subjectRows.length,
      linkedSubjects: 0,
      entries: entryRows.length,
      variants: variantCount,
      links: linkCount,
      secrets: secretCount,
      credentials: credentialRows.length,
      vaultConnections: vaultRows.length,
    }

    return { header, records, counts, slug: circle.slug }
  })

  const ndjson = Buffer.from(
    payload.records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  )
  if (ndjson.byteLength > CIRCLE_EXPORT_MAX_PLAIN_BYTES) {
    throw new MemoryError(400, '导出内容解压体积超出上限')
  }

  const buffer = await sealCircleExport(ndjson, passphrase, kdf)
  const stamp = payload.header.exportedAt.slice(0, 10)
  return {
    buffer,
    filename: `kioku-${payload.slug}-${stamp}.kioku-circle`,
    header: payload.header,
    counts: payload.counts,
  }
}
