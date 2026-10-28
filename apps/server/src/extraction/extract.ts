import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'

import type { SessionContext } from '../access/access'
import type { KeySession } from '../access/session'
import { principalForKeyId } from '../auth/middleware'
import {
  looksLikePlaintextCredential,
  maskPlaintextCredentials,
  mentionsPlaceholder,
} from '../credential/placeholders'
import { withSpace, type Db } from '../db/client'
import { conversationTurns, extractionRuns, memories, subjectIdentities } from '../db/schema'
import { accessForKey } from '../memory/context'
import { readableConditions } from '../memory/filter'
import { MemoryService } from '../memory/service'
import { dropBuffered, type BufferedSession } from './buffer'
import { extractionMessages, parseExtraction, type PromptSubject } from './prompt'
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
// 记一条抽取记录，再删掉用过的缓冲（抽取期间新进来的留着，由它们排的任务处理）。
// 权限按写入最后一轮的 Key 现在的上限与这一批的会话上下文重新算：Key 吊销、作废，或写不了对象层与情节层时
// 不请求模型，这一批直接丢掉。请求模型失败时记下原因并抛出，交给后台任务重试，缓冲留着；
// 模型的输出解析不了时记下原因、丢掉这一批：同样的输入多半还是解析不了，重试只会白花 token
export async function extractBatch(
  db: Db,
  masterKey: Buffer | null,
  model: ChatModel,
  target: BufferedSession,
): Promise<void> {
  const turns = await withSpace(db, target.spaceId, (tx) =>
    tx
      .select()
      .from(conversationTurns)
      .where(
        and(eq(conversationTurns.appId, target.appId), eq(conversationTurns.scope, target.scope)),
      )
      .orderBy(asc(conversationTurns.id)),
  )
  const last = turns.at(-1)
  if (!last) return
  const groupId = last.groupSubjectId
  const senderIds = [...new Set(turns.map((t) => t.senderSubjectId))]
  const subjectIds = groupId ? [...senderIds, groupId] : senderIds
  const record = (fields: RunFields) =>
    withSpace(db, target.spaceId, (tx) =>
      tx.insert(extractionRuns).values({
        spaceId: target.spaceId,
        appId: target.appId,
        scope: target.scope,
        subjectIds,
        turns: turns.length,
        ...fields,
      }),
    )
  const finish = async (fields: RunFields) => {
    await record(fields)
    await dropBuffered(db, target, last.id)
  }

  const key = await principalForKeyId(db, last.keyId)
  if (!key) return finish({ error: '写入这一批的 Key 已吊销或作废' })
  const context: SessionContext = groupId
    ? { chatType: last.chatType === 'channel' ? 'channel' : 'group', groupSubjectId: groupId }
    : { chatType: 'direct', senderSubjectId: last.senderSubjectId }
  const session: KeySession = { context, personaId: key.app.defaultPersonaId, subjects: [] }
  const access = accessForKey(key, session)
  // 来源作用域由会话上下文算出，和缓冲分批用的是同一个
  if (access.writeOriginScope !== target.scope) {
    return finish({ error: '这一批的会话上下文对不上' })
  }
  if (!access.writeLayers.has('subject') && !access.writeLayers.has('episode')) {
    return finish({ error: '写入这一批的 Key 写不了对象层与情节层' })
  }

  // 对象与它们读得到的已有事实；发言人用这一批里最后报上来的名字，群用平台上的名字
  const existing = await withSpace(db, target.spaceId, async (tx) => {
    const ranked = tx
      .select({
        id: memories.id,
        subjectId: memories.subjectId,
        content: memories.content,
        rank: sql<number>`row_number() over (partition by ${memories.subjectId} order by ${memories.updatedAt} desc, ${memories.id})`.as(
          'rank',
        ),
      })
      .from(memories)
      .where(
        and(
          readableConditions(access, { personaIds: [] }),
          eq(memories.layer, 'subject'),
          eq(memories.form, 'extracted'),
          inArray(memories.subjectId, subjectIds),
        ),
      )
      .as('ranked')
    const facts = await tx
      .select()
      .from(ranked)
      .where(lte(ranked.rank, EXISTING_FACTS_PER_SUBJECT))
      .orderBy(asc(ranked.rank))
    const [groupName] = groupId
      ? await tx
          .select({ name: subjectIdentities.displayName })
          .from(subjectIdentities)
          .where(eq(subjectIdentities.subjectId, groupId))
          .orderBy(asc(subjectIdentities.createdAt))
          .limit(1)
      : []
    return { facts, groupName: groupName?.name ?? null }
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
      ? [{ id: groupId, handle: 'G', role: 'group' as const, name: existing.groupName, facts: [] }]
      : []),
  ]
  const factsByHandle = new Map<string, { id: string; subjectId: string; content: string }>()
  for (const subject of subjects) {
    for (const fact of existing.facts.filter((f) => f.subjectId === subject.id)) {
      const handle = `F${factsByHandle.size + 1}`
      factsByHandle.set(handle, { id: fact.id, subjectId: subject.id, content: fact.content ?? '' })
      subject.facts.push({ handle, content: fact.content ?? '' })
    }
  }
  const handleOf = new Map(subjects.map((s) => [s.id, s.handle]))
  const messages = extractionMessages(
    subjects,
    turns.map((t) => ({
      speaker: handleOf.get(t.senderSubjectId)!,
      speakerName: t.senderName,
      user: t.userText,
      reply: t.replyText,
    })),
  )

  let completion
  try {
    completion = await model.complete(messages)
  } catch (err) {
    await record({ model: model.model, error: (err as Error).message })
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
    return finish({ ...usage, error: (err as Error).message })
  }

  const service = new MemoryService({
    db,
    spaceId: target.spaceId,
    access,
    personaId: session.personaId,
    masterKey,
    actor: { keyId: key.keyId },
  })
  const eventContext = { source: 'extraction' }
  const counts = { added: 0, updated: 0, unchanged: 0, dropped: 0 }
  const bySubjectHandle = new Map(subjects.map((s) => [s.handle, s]))
  for (const candidate of parsed.candidates) {
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
    const content = candidate.content?.replace(/\s+/g, ' ').trim() ?? ''
    if (
      (op !== 'add' && op !== 'update') ||
      !content ||
      [...content].length > MAX_FACT_CHARS ||
      looksLikePlaintextCredential(content) ||
      mentionsPlaceholder(content)
    ) {
      counts.dropped++
      continue
    }
    // 和这个对象已有的某条一字不差（不计大小写与空白），就是已经记过
    const known = [...factsByHandle.values()].some(
      (f) => f.subjectId === subject.id && sameText(f.content, content),
    )
    if (known) {
      counts.unchanged++
      continue
    }
    const replaced = op === 'update' && candidate.replaces
    const old = replaced ? factsByHandle.get(candidate.replaces!.trim().toUpperCase()) : undefined
    try {
      // 要推翻的那条找不到、或不属于这个对象时当作新的事实，免得把别人的事实改掉
      if (old && old.subjectId === subject.id) {
        await service.supersedeExtracted(old.id, content, eventContext)
        counts.updated++
      } else {
        await service.addExtracted(
          { layer: 'subject', subjectId: subject.id, content },
          eventContext,
        )
        counts.added++
      }
    } catch (err) {
      console.warn('写入抽取的事实失败', err)
      counts.dropped++
    }
  }

  let summarized = false
  const summary = maskPlaintextCredentials(parsed.summary.replace(/\s+/g, ' ').trim())
  if (summary && [...summary].length <= MAX_SUMMARY_CHARS && !mentionsPlaceholder(summary)) {
    try {
      await service.addExtracted(
        {
          layer: 'episode',
          subjectId: null,
          content: summary,
          expiresAt: new Date(Date.now() + EPISODE_TTL_DAYS * 86_400_000),
        },
        eventContext,
      )
      summarized = true
    } catch (err) {
      console.warn('写入会话摘要失败', err)
    }
  }
  await finish({ ...usage, ...counts, summarized })
}

function sameText(a: string, b: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()
  return normalize(a) === normalize(b)
}
