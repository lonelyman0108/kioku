import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'

import type { Access, SessionContext } from '../access/access'
import { groupPersona, type KeySession } from '../access/session'
import { principalForKeyId } from '../auth/middleware'
import {
  looksLikePlaintextCredential,
  maskPlaintextCredentials,
  mentionsPlaceholder,
} from '../credential/placeholders'
import { withSpace, type Db, type Tx } from '../db/client'
import { conversationTurns, extractionRuns, memories, subjectIdentities } from '../db/schema'
import type { KeyPrincipal } from '../http/env'
import { accessForKey } from '../memory/context'
import { readableConditions } from '../memory/filter'
import { MemoryService, type ExtractedWrite } from '../memory/service'
import { oneLine } from '../recall/recall'
import { readableSubjectFacts } from '../recall/subjects'
import type { BufferedSession } from './buffer'
import { extractionUsage, writesToday } from './budget'
import { extractionMessages, parseExtraction, summaryMessages, type PromptSubject } from './prompt'
import type { ChatModel } from './provider'

// 会话摘要在情节层留这么多天
export const EPISODE_TTL_DAYS = 30
// 每个对象给模型看最近这么多条已有事实，用来判断是新的、更新还是已经记过
const EXISTING_FACTS_PER_SUBJECT = 30
// 一条事实、一段摘要最多这么多字：更长的不像一条事实，多半是模型把原话抄了进来
const MAX_FACT_CHARS = 200
const MAX_SUMMARY_CHARS = 500

type RunFields = Omit<
  typeof extractionRuns.$inferInsert,
  'id' | 'spaceId' | 'appId' | 'scope' | 'subjectIds' | 'turns' | 'createdAt'
>

// 抽取一批缓冲：让模型按 JSON 给出候选事实，与相关对象已有的事实比对后写进对象层，会话摘要写进情节层，
// 记一条抽取记录，删掉用过的缓冲（抽取期间新进来的留着，由它们排的任务处理）。写入、抽取记录与删缓冲
// 在同一个事务里，中途失败整批回滚，重试不会重复写入。
// 每一轮按写入它的 Key 现在的上限与这一批的会话上下文重新确认：Key 吊销、作废，或写不了对象层与情节层的那几轮
// 不给模型看，随这一批删掉；一轮都不剩时不请求模型。写入用最后一轮还有效的 Key。
// 请求模型失败时记下原因并抛出，交给后台任务重试，缓冲留着；模型的输出解析不了时记下原因、丢掉这一批：
// 同样的输入多半还是解析不了，重试只会白花 token
export async function extractBatch(
  db: Db,
  masterKey: Buffer | null,
  model: ChatModel,
  target: BufferedSession,
): Promise<void> {
  const all = await withSpace(db, target.spaceId, (tx) =>
    tx
      .select()
      .from(conversationTurns)
      .where(
        and(eq(conversationTurns.appId, target.appId), eq(conversationTurns.scope, target.scope)),
      )
      .orderBy(asc(conversationTurns.id)),
  )
  const last = all.at(-1)
  if (!last) return
  const groupId = last.groupSubjectId
  const context: SessionContext = groupId
    ? { chatType: last.chatType === 'channel' ? 'channel' : 'group', groupSubjectId: groupId }
    : { chatType: 'direct', senderSubjectId: last.senderSubjectId }

  const keyIds = [...new Set(all.map((t) => t.keyId))]
  const principals = (await Promise.all(keyIds.map((id) => principalForKeyId(db, id)))).filter(
    (key): key is KeyPrincipal => key !== null,
  )
  // 同一批的 Key 都属于这个应用，按群换人格的规则只用查一次
  const personaId = !principals[0]
    ? null
    : groupId
      ? await withSpace(db, target.spaceId, (tx) => groupPersona(tx, principals[0]!, groupId))
      : principals[0].app.defaultPersonaId
  const writers = new Map<string, { key: KeyPrincipal; session: KeySession; access: Access }>()
  for (const key of principals) {
    const session: KeySession = { context, personaId, subjects: [] }
    const access = accessForKey(key, session)
    // 来源作用域由会话上下文算出，和缓冲分批用的是同一个
    const writable = access.writeLayers.has('subject') || access.writeLayers.has('episode')
    if (access.writeOriginScope === target.scope && writable) {
      writers.set(key.keyId, { key, session, access })
    }
  }
  const turns = all.filter((t) => writers.has(t.keyId))
  // 这一批的内容只写进每一轮的 Key 都写得了的层：只能写情节层的 Key 说的话，不能借别的 Key 进对象层
  const used = [...new Set(turns.map((t) => t.keyId))].map((id) => writers.get(id)!.access)
  const layers = {
    subject: used.every((a) => a.writeLayers.has('subject')),
    episode: used.every((a) => a.writeLayers.has('episode')),
  }
  const senderIds = [...new Set(turns.map((t) => t.senderSubjectId))]
  const subjectIds = groupId ? [...senderIds, groupId] : senderIds
  const runOf = (fields: RunFields): typeof extractionRuns.$inferInsert => ({
    spaceId: target.spaceId,
    appId: target.appId,
    scope: target.scope,
    subjectIds,
    turns: turns.length,
    skippedTurns: all.length - turns.length,
    ...fields,
  })
  // 记一条抽取记录，并删掉这一批用过的缓冲
  const close = async (tx: Tx, fields: RunFields) => {
    await tx.insert(extractionRuns).values(runOf(fields))
    await tx
      .delete(conversationTurns)
      .where(
        and(
          eq(conversationTurns.appId, target.appId),
          eq(conversationTurns.scope, target.scope),
          lte(conversationTurns.id, last.id),
        ),
      )
  }
  const writer = turns.length ? writers.get(turns.at(-1)!.keyId) : undefined
  if (!writer || (!layers.subject && !layers.episode)) {
    await withSpace(db, target.spaceId, (tx) =>
      close(tx, { error: '写入这一批的 Key 都已吊销、作废或写不了对象层与情节层' }),
    )
    return
  }
  // 本月的 token 预算用完了就只要会话摘要，不再抽取事实，下个月恢复；连摘要也写不了时不请求模型
  const budget = await extractionUsage(db, target.spaceId)
  const summaryOnly = budget.usedTokens >= budget.monthlyTokens
  if (summaryOnly && !layers.episode) {
    await withSpace(db, target.spaceId, (tx) =>
      close(tx, {
        summaryOnly,
        error: '本月的抽取预算用完了，这一批的 Key 又写不了会话摘要',
      }),
    )
    return
  }

  // 对象与它们读得到的、最近的几条有效事实（给模型看；只要摘要时不用）。
  // 发言人用这一批里最后报上来的名字，群用平台上的名字
  const { facts, groupName } = await withSpace(db, target.spaceId, async (tx) => {
    if (summaryOnly) return { facts: [], groupName: null }
    const facts = await readableSubjectFacts(
      tx,
      writer.access,
      subjectIds,
      EXISTING_FACTS_PER_SUBJECT,
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
  const subjects: (PromptSubject & { id: string })[] = [
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
  const shown = new Map<string, { id: string; subjectId: string }>()
  for (const subject of subjects) {
    for (const fact of facts.filter((f) => f.subjectId === subject.id)) {
      const handle = `F${shown.size + 1}`
      shown.set(handle, { id: fact.id, subjectId: subject.id })
      subject.facts.push({ handle, content: fact.content })
    }
  }
  const handleOf = new Map(subjects.map((s) => [s.id, s.handle]))
  const transcript = turns.map((t) => ({
    speaker: handleOf.get(t.senderSubjectId)!,
    speakerName: t.senderName,
    user: t.userText,
    reply: t.replyText,
  }))
  const messages = summaryOnly
    ? summaryMessages(transcript)
    : extractionMessages(subjects, transcript)

  let completion
  try {
    completion = await model.complete(messages)
  } catch (err) {
    await withSpace(db, target.spaceId, (tx) =>
      tx
        .insert(extractionRuns)
        .values(runOf({ model: model.model, error: (err as Error).message })),
    )
    throw err
  }
  const usage = {
    model: model.model,
    promptTokens: completion.usage.promptTokens,
    completionTokens: completion.usage.completionTokens,
  }
  let parsed
  try {
    parsed = parseExtraction(completion.content)
  } catch (err) {
    await withSpace(db, target.spaceId, (tx) =>
      close(tx, { ...usage, error: (err as Error).message }),
    )
    return
  }

  // 挑出要写的候选：对象不对、格式不对、太长、像明文凭据、带凭据占位符的丢掉；这一批的 Key 写不了对象层时
  // 事实一条都不写，写不了情节层时不写摘要。和这一批里已经要写的一字不差的（不计大小写与空白）算已经记过
  const counts = { unchanged: 0, dropped: 0, limited: 0 }
  const proposed: Extract<ExtractedWrite, { layer: 'subject' }>[] = []
  const bySubjectHandle = new Map(subjects.map((s) => [s.handle, s]))
  const pending = new Set<string>()
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
    if (
      !layers.subject ||
      (op !== 'add' && op !== 'update') ||
      !content ||
      [...content].length > MAX_FACT_CHARS ||
      looksLikePlaintextCredential(content) ||
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
    // 要推翻的那条不属于这个对象时当作新的事实，免得把别人的事实改掉
    const old =
      op === 'update' && candidate.replaces
        ? shown.get(candidate.replaces.trim().toUpperCase())
        : undefined
    proposed.push({
      layer: 'subject',
      subjectId: subject.id,
      content,
      replaces: old && old.subjectId === subject.id ? old.id : undefined,
    })
  }
  // 和这个对象已有的有效事实一字不差的（不只是给模型看的那些）也算已经记过：按正文去库里查，不必把全部事实读出来
  // 每个对象每天最多写这么多条（推翻旧事实写下的新一条也算），写满了的这次不写
  const { existing, today } = await withSpace(db, target.spaceId, async (tx) => ({
    existing: await knownFacts(tx, writer.access, proposed),
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
  const summary = maskPlaintextCredentials(oneLine(parsed.summary))
  if (
    layers.episode &&
    summary &&
    [...summary].length <= MAX_SUMMARY_CHARS &&
    !mentionsPlaceholder(summary)
  ) {
    writes.push({
      layer: 'episode',
      content: summary,
      expiresAt: new Date(Date.now() + EPISODE_TTL_DAYS * 86_400_000),
    })
  }

  const service = new MemoryService({
    db,
    spaceId: target.spaceId,
    access: writer.access,
    personaId: writer.session.personaId,
    masterKey,
    actor: { keyId: writer.key.keyId },
  })
  try {
    await service.writeExtraction(writes, { source: 'extraction' }, (tx, outcomes) => {
      const count = (layer: ExtractedWrite['layer'], outcome: string) =>
        outcomes.filter((o, i) => writes[i]!.layer === layer && o === outcome).length
      return close(tx, {
        ...usage,
        added: count('subject', 'added'),
        updated: count('subject', 'updated'),
        unchanged: counts.unchanged,
        dropped: counts.dropped + count('subject', 'skipped'),
        summarized: count('episode', 'added') > 0,
        summaryOnly,
        limited: counts.limited,
      })
    })
  } catch (err) {
    // 整批已经回滚：单独记下原因再抛出，交给后台任务重试，缓冲留着
    await withSpace(db, target.spaceId, (tx) =>
      tx
        .insert(extractionRuns)
        .values(runOf({ ...usage, error: `写入失败：${(err as Error).message}` })),
    )
    throw err
  }
}

// 候选里哪些和对象已有的有效事实一字不差（不计大小写；正文写入时已经压过空白），返回「对象|小写正文」
async function knownFacts(
  tx: Tx,
  access: Access,
  facts: readonly { subjectId: string; content: string }[],
): Promise<Set<string>> {
  if (!facts.length) return new Set()
  const rows = await tx
    .select({ subjectId: memories.subjectId, content: sql<string>`lower(${memories.content})` })
    .from(memories)
    .where(
      and(
        readableConditions(access, { personaIds: [] }),
        eq(memories.layer, 'subject'),
        eq(memories.form, 'extracted'),
        inArray(memories.subjectId, [...new Set(facts.map((f) => f.subjectId))]),
        inArray(sql`lower(${memories.content})`, [
          ...new Set(facts.map((f) => f.content.toLowerCase())),
        ]),
      ),
    )
  return new Set(rows.map((r) => `${r.subjectId}|${r.content}`))
}
