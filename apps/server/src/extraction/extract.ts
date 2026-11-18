import { maskSensitiveContent, normalizeWhen, TUNING_DEFAULTS } from '@kioku/contracts'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import type { Access, SessionContext } from '../access/access'
import { ensureConversation, findConversation, type ConversationRef } from '../access/conversations'
import { accessForKey, groupPersona, type KeySession } from '../access/session'
import { principalForKeyId } from '../auth/middleware'
import { mentionsPlaceholder } from '../credential/placeholders'
import {
  evaluateSensitiveContent,
  loadCirclePrivacy,
  loadOutboundRedactor,
} from '../credential/privacy'
import type { MasterKey } from '../crypto/keyring'
import { errorText, withCircle, type Db, type Tx } from '../db/client'
import {
  conversationTurns,
  entries,
  entryVariants,
  extractionRuns,
  subjectIdentities,
  subjects as subjectTable,
} from '../db/schema'
import type { KeyPrincipal } from '../http/env'
import { readableConditions } from '../memory/filter'
import { EntryService, type ExtractedWrite } from '../memory/service'
import { oneLine } from '../recall/recall'
import { readableSubjectFacts } from '../recall/subjects'
import { loadCircleSettings } from '../settings/advanced'
import { canWriteTurns, parseNoContextScope, type BufferedSession } from './buffer'
import { extractionUsage, writesToday } from './budget'
import {
  extractionMessages,
  parseExtraction,
  quoteMatchesSpeaker,
  summaryMessages,
  type PromptSubject,
} from './prompt'
import type { ChatModel } from './provider'

export const NO_USABLE_KEY = '写入这一批的访问密钥均已吊销、作废或无权写入联系人的事实与会话摘要'
export const BUDGET_NO_SUMMARY = '本月的抽取预算已用完，这一批的访问密钥也无权写入会话摘要'
export const BATCH_MOVED = '抽取期间联系人已被合并，这一批将由合并后的批次重新抽取'
class BatchMoved extends Error {}

export const RUN_ERROR_WORDINGS: readonly (readonly [string, ...string[]])[] = [
  [
    NO_USABLE_KEY,
    '写入这一批的访问密钥均已吊销、作废或无权写入联系人层与情节层',
    '写入这一批的 Key 均已吊销、作废或无权写入联系人层与情节层',
    '写入这一批的 Key 都已吊销、作废或写不了对象层与情节层',
  ],
  [
    BUDGET_NO_SUMMARY,
    '本月的抽取预算已用完，这一批的 Key 也无权写入会话摘要',
    '本月的抽取预算用完了，这一批的 Key 又写不了会话摘要',
  ],
  [BATCH_MOVED, '抽取期间对象被合并，这一批交给合并后的批次重新抽取'],
]

export function plainRunError(stored: string): string | null {
  return RUN_ERROR_WORDINGS.find((wordings) => wordings.includes(stored))?.[0] ?? null
}

export const EPISODE_TTL_DAYS = TUNING_DEFAULTS['extraction.episodeTtlDays']
const EXISTING_FACTS_PER_SUBJECT = 30
export const MAX_FACT_CHARS = 200
export const MAX_SUMMARY_CHARS = 500

type RunFields = Omit<
  typeof extractionRuns.$inferInsert,
  'id' | 'circleId' | 'clientId' | 'scope' | 'subjectIds' | 'turns' | 'createdAt'
>

const placeColumns = {
  id: conversationTurns.id,
  scope: conversationTurns.scope,
  senderSubjectId: conversationTurns.senderSubjectId,
  groupSubjectId: conversationTurns.groupSubjectId,
  ownerAccountId: conversationTurns.ownerAccountId,
}
type Place = Pick<
  typeof conversationTurns.$inferSelect,
  'id' | 'scope' | 'senderSubjectId' | 'groupSubjectId' | 'ownerAccountId'
>

function conversationOfTurn(turn: Place): ConversationRef {
  if (turn.groupSubjectId) return { kind: 'group', subjectId: turn.groupSubjectId }
  if (turn.senderSubjectId) return { kind: 'direct', subjectId: turn.senderSubjectId }
  const decoded = parseNoContextScope(turn.scope)
  return decoded
    ? {
        kind: 'none',
        ownerAccountId: decoded.ownerAccountId,
        deviceKey: decoded.deviceKey,
        projectSlug: decoded.projectSlug,
      }
    : {
        kind: 'none',
        ownerAccountId: turn.ownerAccountId!,
        deviceKey: '',
        projectSlug: '',
      }
}

export async function extractBatch(
  db: Db,
  masterKey: MasterKey | null,
  model: ChatModel,
  target: BufferedSession,
  onFactCreated?: (circleId: string, entryId: string) => void,
): Promise<void> {
  const all = await withCircle(db, target.circleId, (tx) =>
    tx
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.clientId, target.clientId),
          eq(conversationTurns.scope, target.scope),
        ),
      )
      .orderBy(asc(conversationTurns.id)),
  )
  const last = all.at(-1)
  if (!last) return
  const groupId = last.groupSubjectId
  const noContext = last.chatType === 'none'
  const owner = noContext ? last.ownerAccountId! : null
  const context: SessionContext = noContext
    ? {}
    : groupId
      ? { chatType: last.chatType === 'channel' ? 'channel' : 'group', groupSubjectId: groupId }
      : { chatType: 'direct', senderSubjectId: last.senderSubjectId! }

  const keyIds = [...new Set(all.map((t) => t.keyId))]
  const principals = (await Promise.all(keyIds.map((id) => principalForKeyId(db, id)))).filter(
    (key): key is KeyPrincipal => key !== null,
  )
  const personaId = !principals[0]
    ? null
    : groupId
      ? await withCircle(db, target.circleId, (tx) => groupPersona(tx, principals[0]!, groupId))
      : (principals[0].personaOverrideId ?? principals[0].client.defaultPersonaId)

  const writers = new Map<string, { key: KeyPrincipal; session: KeySession; access: Access }>()
  for (const key of principals) {
    const session: KeySession = { context, personaId, subjects: [] }
    const access = accessForKey(key, session)
    const primaryGrant = access.circles.get(target.circleId)
    const writable =
      Boolean(primaryGrant && canWriteTurns(primaryGrant, !noContext)) &&
      (!noContext || key.client.ownerAccountId === owner)
    if (writable && (noContext || access.writeOriginScope === target.scope)) {
      writers.set(key.keyId, { key, session, access })
    }
  }
  const turns = all.filter(
    (t) => writers.has(t.keyId) && (!noContext || t.ownerAccountId === owner),
  )

  const usedGrants = [...new Set(turns.map((t) => t.keyId))].map((id) =>
    writers.get(id)!.access.circles.get(target.circleId)!,
  )
  const layers = {
    fact: !noContext && usedGrants.every((c) => c.writeKinds.has('fact')),
    episode: usedGrants.every((c) => c.writeKinds.has('episode')),
  }
  const senderIds = noContext ? [] : [...new Set(turns.map((t) => t.senderSubjectId!))]
  const subjectIds = groupId ? [...senderIds, groupId] : senderIds
  const before = new Map(all.map((t) => [t.id, t]))

  const runOf = (
    fields: RunFields,
    now: Place[],
    conversationId: string | null,
  ): typeof extractionRuns.$inferInsert => {
    const moved = new Map<string, string>()
    for (const row of now) {
      const turn = before.get(row.id)!
      if (turn.senderSubjectId && row.senderSubjectId) {
        moved.set(turn.senderSubjectId, row.senderSubjectId)
      }
      if (turn.groupSubjectId && row.groupSubjectId) {
        moved.set(turn.groupSubjectId, row.groupSubjectId)
      }
    }
    return {
      circleId: target.circleId,
      clientId: target.clientId,
      scope: now[0]?.scope ?? target.scope,
      conversationId,
      subjectIds: [...new Set(subjectIds.map((id) => moved.get(id) ?? id))],
      turns: turns.length,
      skippedTurns: all.length - turns.length,
      ...fields,
    }
  }

  const batch = and(
    eq(conversationTurns.clientId, target.clientId),
    inArray(conversationTurns.id, [...before.keys()]),
  )
  const conversationNow = (tx: Tx, now: Place[]) =>
    findConversation(tx, target.clientId, conversationOfTurn(now[0] ?? last))
  const record = async (tx: Tx, fields: RunFields) => {
    const now = await tx.select(placeColumns).from(conversationTurns).where(batch)
    await tx.insert(extractionRuns).values(runOf(fields, now, await conversationNow(tx, now)))
  }
  const close = async (tx: Tx, fields: RunFields) => {
    const now = await tx.delete(conversationTurns).where(batch).returning(placeColumns)
    await tx.insert(extractionRuns).values(runOf(fields, now, await conversationNow(tx, now)))
  }
  const stillHere = async (tx: Tx) => {
    if (!subjectIds.length) return
    const rows = await tx
      .select({ id: subjectTable.id })
      .from(subjectTable)
      .where(inArray(subjectTable.id, subjectIds))
      .orderBy(asc(subjectTable.id))
      .for('key share')
    if (rows.length < subjectIds.length) throw new BatchMoved()
  }

  const writer = turns.length ? writers.get(turns.at(-1)!.keyId) : undefined
  if (!writer || (!layers.fact && !layers.episode)) {
    await withCircle(db, target.circleId, (tx) => close(tx, { error: NO_USABLE_KEY }))
    return
  }

  const budget = await extractionUsage(db, target.circleId)
  const overBudget = budget.usedTokens >= budget.monthlyTokens
  const summaryOnly = noContext || overBudget
  if (summaryOnly && !layers.episode) {
    await withCircle(db, target.circleId, (tx) =>
      close(tx, {
        summaryOnly: overBudget,
        error: BUDGET_NO_SUMMARY,
      }),
    )
    return
  }

  // 自动抽取读取已有事实一律锁死当前本 origin_scope，绝不跨群混入或被跨群事实覆写
  const { facts, groupName } = await withCircle(db, target.circleId, async (tx) => {
    if (summaryOnly) return { facts: [], groupName: null }
    const facts = await readableSubjectFacts(
      tx,
      writer.access,
      subjectIds,
      EXISTING_FACTS_PER_SUBJECT,
      { localOriginScope: target.scope },
    )
    const [identity] = groupId
      ? await tx
          .select({ name: subjectIdentities.displayName })
          .from(subjectIdentities)
          .where(eq(subjectIdentities.subjectId, groupId))
          .orderBy(asc(subjectIdentities.createdAt))
          .limit(1)
      : []
    return { facts, groupName: identity?.name ?? null }
  })

  const promptSubjects: (PromptSubject & { id: string })[] = [
    ...senderIds.map((id, i) => ({
      id,
      handle: `M${i + 1}`,
      role: 'sender' as const,
      name: turns.findLast((t) => t.senderSubjectId === id && t.senderName)?.senderName ?? null,
      facts: [],
    })),
    ...(groupId
      ? [{ id: groupId, handle: 'G', role: 'group' as const, name: groupName, facts: [] }]
      : []),
  ]
  const { settings: circlePrivacy } = await loadCirclePrivacy(db, target.circleId)
  const redactForLlm = await loadOutboundRedactor(db, masterKey, target.circleId)

  const shown = new Map<string, { id: string; subjectId: string; version: number }>()
  for (const subject of promptSubjects) {
    for (const fact of facts.filter((f) => f.subjectId === subject.id)) {
      const handle = `F${shown.size + 1}`
      shown.set(handle, { id: fact.id, subjectId: subject.id, version: fact.version })
      subject.facts.push({ handle, content: await redactForLlm(fact.content) })
    }
  }
  const handleOf = new Map(promptSubjects.map((s) => [s.id, s.handle]))
  const speakerTexts = new Map<string, string[]>()
  const allUserTexts: string[] = []
  const transcript = await Promise.all(
    turns.map(async (t) => {
      const speaker = noContext ? '本人' : handleOf.get(t.senderSubjectId!)!
      const redactedUser = await redactForLlm(t.userText)
      const redactedReply = await redactForLlm(t.replyText)
      const list = speakerTexts.get(speaker) ?? []
      list.push(t.userText, redactedUser)
      speakerTexts.set(speaker, list)
      allUserTexts.push(t.userText, redactedUser)
      return {
        speaker,
        speakerName: t.senderName,
        user: redactedUser,
        reply: redactedReply,
      }
    }),
  )
  if (groupId) speakerTexts.set('G', allUserTexts)

  const settings = await loadCircleSettings(db, target.circleId)
  const rules = settings.prompts.extractionRules
  const messages = summaryOnly
    ? summaryMessages(transcript, rules)
    : extractionMessages(promptSubjects, transcript, rules)

  let completion
  try {
    completion = await model.complete(messages)
  } catch (err) {
    await withCircle(db, target.circleId, (tx) =>
      record(tx, { model: model.model, error: (err as Error).message }),
    )
    throw err
  }
  const usage = {
    model: completion.model ?? model.model,
    promptTokens: completion.usage.promptTokens,
    completionTokens: completion.usage.completionTokens,
  }
  let parsed
  try {
    parsed = parseExtraction(completion.content)
  } catch (err) {
    await withCircle(db, target.circleId, (tx) =>
      close(tx, { ...usage, error: (err as Error).message }),
    )
    return
  }

  const counts = { unchanged: 0, dropped: 0, limited: 0 }
  const proposed: Extract<ExtractedWrite, { kind: 'fact' }>[] = []
  const bySubjectHandle = new Map(promptSubjects.map((s) => [s.handle, s]))
  const pending = new Set<string>()
  const factFacets = normalizeWhen(writer.key.contextFacets)

  for (const candidate of summaryOnly ? [] : parsed.candidates) {
    const subject = candidate && bySubjectHandle.get(candidate.subject.trim().toUpperCase())
    const op = candidate?.op.trim().toLowerCase()
    if (!candidate || !subject || !op) {
      counts.dropped++
      continue
    }
    if (op === 'none') {
      counts.unchanged++
      continue
    }
    const content = oneLine(candidate.content ?? '')
    const sensitive = evaluateSensitiveContent(content, circlePrivacy)
    const quotedOk = quoteMatchesSpeaker(candidate.quote, speakerTexts.get(subject.handle) ?? [])
    if (
      !layers.fact ||
      (op !== 'add' && op !== 'update') ||
      !content ||
      [...content].length > MAX_FACT_CHARS ||
      !quotedOk ||
      content.includes('[REDACTED:') ||
      sensitive.hasCredential ||
      sensitive.hasPii ||
      mentionsPlaceholder(content)
    ) {
      counts.dropped++
      continue
    }
    const key = `${subject.id}|${content.toLowerCase()}`
    if (pending.has(key)) {
      counts.unchanged++
      continue
    }
    pending.add(key)
    const old =
      op === 'update' && candidate.replaces
        ? shown.get(candidate.replaces.trim().toUpperCase())
        : undefined
    proposed.push({
      kind: 'fact',
      subjectId: subject.id,
      subjectKind: subject.role === 'group' ? 'group' : 'person',
      originScope: target.scope,
      content,
      when: factFacets,
      replaces:
        old && old.subjectId === subject.id ? { id: old.id, version: old.version } : undefined,
    })
  }

  const { existing, today } = await withCircle(db, target.circleId, async (tx) => ({
    existing: await knownFacts(tx, writer.access, proposed, target.scope),
    today: await writesToday(tx, subjectIds),
  }))

  const writes: ExtractedWrite[] = proposed.filter((f) => {
    if (existing.has(`${f.subjectId}|${f.content.toLowerCase()}`)) {
      counts.unchanged++
      return false
    }
    const written = today.get(f.subjectId) ?? 0
    if (written >= budget.dailyWritesPerSubject) {
      counts.limited++
      return false
    }
    today.set(f.subjectId, written + 1)
    return true
  })

  const summary = maskSensitiveContent(
    oneLine(parsed.summary),
    {
      credentials: circlePrivacy.credentials,
      pii: circlePrivacy.pii,
      piiKinds: circlePrivacy.piiKinds,
      customRules: circlePrivacy.customRules,
      allowlist: circlePrivacy.allowlist,
    },
    'stars',
  )
  if (
    layers.episode &&
    summary &&
    [...summary].length <= MAX_SUMMARY_CHARS &&
    !mentionsPlaceholder(summary)
  ) {
    writes.push({
      kind: 'episode',
      originScope: target.scope,
      content: summary,
      ttlDays: settings.values['extraction.episodeTtlDays'],
      ownerAccountId: owner,
    })
  }

  const service = new EntryService({
    db,
    access: writer.access,
    masterKey,
    actor: { keyId: writer.key.keyId },
    ...(onFactCreated ? { onChanged: onFactCreated } : {}),
  })

  try {
    await service.writeExtraction(
      writes,
      { source: 'extraction' },
      (tx, outcomes) => {
        const countOf = (kind: ExtractedWrite['kind'], outcome: string) =>
          outcomes.filter((o, i) => writes[i]!.kind === kind && o === outcome).length
        return close(tx, {
          ...usage,
          added: countOf('fact', 'added'),
          updated: countOf('fact', 'updated'),
          unchanged: counts.unchanged,
          dropped: counts.dropped + countOf('fact', 'skipped'),
          summarized: countOf('episode', 'added') > 0,
          summaryOnly: overBudget,
          limited: counts.limited,
        })
      },
      async (tx) => {
        await stillHere(tx)
        return ensureConversation(tx, target.circleId, target.clientId, conversationOfTurn(last))
      },
    )
  } catch (err) {
    if (err instanceof BatchMoved) {
      await withCircle(db, target.circleId, (tx) => record(tx, { ...usage, error: BATCH_MOVED }))
      return
    }
    await withCircle(db, target.circleId, (tx) =>
      record(tx, { ...usage, error: `写入失败：${errorText(err)}` }),
    )
    throw err
  }
}

async function knownFacts(
  tx: Tx,
  access: Access,
  facts: readonly { subjectId: string; content: string }[],
  originScope: string,
): Promise<Set<string>> {
  if (!facts.length) return new Set()
  const rows = await tx
    .select({ subjectId: entries.subjectId, content: sql<string>`lower(${entryVariants.content})` })
    .from(entries)
    .innerJoin(entryVariants, eq(entryVariants.entryId, entries.id))
    .where(
      and(
        readableConditions(access),
        eq(entries.kind, 'fact'),
        eq(entries.originScope, originScope),
        inArray(entries.subjectId, [...new Set(facts.map((f) => f.subjectId))]),
        inArray(sql`lower(${entryVariants.content})`, [
          ...new Set(facts.map((f) => f.content.toLowerCase())),
        ]),
      ),
    )
  return new Set(rows.map((r) => `${r.subjectId}|${r.content}`))
}
