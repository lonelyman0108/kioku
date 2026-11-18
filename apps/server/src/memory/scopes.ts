import type { DreamScope, OriginScope, SubjectKind } from '@kioku/contracts'
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'

import type { Tx } from '../db/client'
import { UUID } from '../db/paging'
import { clients, conversations, entries, subjects } from '../db/schema'

// 对象自己的来源作用域：群里的，或和这个人的私聊里的
export function subjectScope(kind: SubjectKind, id: string): string {
  return `${kind === 'group' ? 'group' : 'direct'}:${id}`
}

// 来源作用域（global、client:<id>、group:<对象>、direct:<对象>）换成带名字的形式
export async function scopeNames(
  tx: Tx,
  scopes: string[],
): Promise<(scope: string) => OriginScope> {
  const parse = (scope: string) => {
    const [kind, id] = scope.split(':', 2) as [string, string | undefined]
    return { kind, id: id && UUID.test(id) ? id : null }
  }
  const parsed = scopes.map(parse)
  const clientIds = [
    ...new Set(parsed.filter((p) => p.kind === 'client' && p.id).map((p) => p.id!)),
  ]
  const subjectIds = [
    ...new Set(
      parsed.filter((p) => (p.kind === 'group' || p.kind === 'direct') && p.id).map((p) => p.id!),
    ),
  ]
  const [clientRows, subjectRows] = await Promise.all([
    clientIds.length
      ? tx
          .select({ id: clients.id, name: clients.name })
          .from(clients)
          .where(inArray(clients.id, clientIds))
      : [],
    subjectIds.length
      ? tx
          .select({ id: subjects.id, name: subjects.displayName })
          .from(subjects)
          .where(inArray(subjects.id, subjectIds))
      : [],
  ])
  const names = new Map([...clientRows, ...subjectRows].map((r) => [r.id, r.name]))
  return (scope) => {
    const { kind, id } = parse(scope)
    if (kind === 'client' || kind === 'group' || kind === 'direct') {
      return { kind, id, name: id ? (names.get(id) ?? null) : null }
    }
    return { kind: 'global', id: null, name: null }
  }
}

export const TALK_KINDS = ['fact', 'episode'] as const

// Dream 整理作用域键：共享圈共享组、个人圈私有组、各群/私聊对话组、本机无上下文会话摘要组
export const DREAM_SCOPE_KEY = sql<string>`(case
  when ${entries.kind} = 'entry' and ${entries.circleKind} = 'shared' then 'circle'
  when ${entries.kind} = 'entry' and ${entries.circleKind} = 'personal' and ${entries.ownerAccountId} is not null
    then 'personal:' || ${entries.ownerAccountId}::text
  when ${inArray(entries.kind, [...TALK_KINDS])} and ${entries.ownerAccountId} is null
    then 'talk:' || ${entries.originScope}
  when ${entries.kind} = 'episode' and ${entries.ownerAccountId} is not null and ${entries.conversationId} is not null
    then 'local:' || ${entries.conversationId}::text end)`

export interface ParsedDreamScope {
  kind: DreamScope['kind']
  id: string | null
  origin: string | null
}

export function parseDreamScope(key: string): ParsedDreamScope | null {
  if (key === 'circle') return { kind: 'circle', id: null, origin: null }
  const at = key.indexOf(':')
  if (at < 0) return null
  const kind = key.slice(0, at)
  const rest = key.slice(at + 1)
  if (kind === 'talk') return rest ? { kind: 'talk', id: null, origin: rest } : null
  if (kind === 'personal')
    return UUID.test(rest) ? { kind: 'personal', id: rest, origin: null } : null
  if (kind === 'local')
    return UUID.test(rest) ? { kind: 'local_session', id: rest, origin: null } : null
  return null
}

export function dreamScopeOwner(key: string): string | null {
  const parsed = parseDreamScope(key)
  return parsed?.kind === 'personal' ? parsed.id : null
}

// 解析整理作用域对应的所属成员账号（个人圈取个人账号，共享圈/个人圈下的本机摘要按 conversations 查对应所有者）
export async function resolveDreamScopeOwners(
  tx: Tx,
  keys: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const convIds: string[] = []
  const convKeys = new Map<string, string[]>()

  for (const key of keys) {
    const parsed = parseDreamScope(key)
    if (!parsed) {
      out.set(key, null)
    } else if (parsed.kind === 'personal') {
      out.set(key, parsed.id)
    } else if (parsed.kind === 'local_session' && parsed.id) {
      convIds.push(parsed.id)
      const list = convKeys.get(parsed.id) ?? []
      list.push(key)
      convKeys.set(parsed.id, list)
    } else {
      out.set(key, null)
    }
  }

  if (convIds.length) {
    const rows = await tx
      .select({ id: conversations.id, ownerAccountId: conversations.ownerAccountId })
      .from(conversations)
      .where(inArray(conversations.id, [...new Set(convIds)]))
    const ownerByConv = new Map(rows.map((r) => [r.id, r.ownerAccountId ?? null]))
    for (const [convId, bucket] of convKeys) {
      const owner = ownerByConv.get(convId) ?? null
      for (const k of bucket) out.set(k, owner)
    }
  }

  return out
}

export function dreamScopeCondition(scope: ParsedDreamScope): SQL {
  switch (scope.kind) {
    case 'circle':
      return and(eq(entries.kind, 'entry'), eq(entries.circleKind, 'shared'))!
    case 'personal':
      return and(
        eq(entries.kind, 'entry'),
        eq(entries.circleKind, 'personal'),
        eq(entries.ownerAccountId, scope.id!),
      )!
    case 'talk':
      return and(
        inArray(entries.kind, [...TALK_KINDS]),
        isNull(entries.ownerAccountId),
        eq(entries.originScope, scope.origin!),
      )!
    case 'local_session':
      return and(eq(entries.kind, 'episode'), eq(entries.conversationId, scope.id!))!
  }
}
