import type { DreamScope, OriginScope, SubjectKind } from '@kioku/contracts'
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'

import type { Tx } from '../db/client'
import { UUID } from '../db/paging'
import { apps, memories, personas, subjects } from '../db/schema'

// 对象自己的来源作用域：群里的，或和这个人的私聊里的
export function subjectScope(kind: SubjectKind, id: string): string {
  return `${kind === 'group' ? 'group' : 'direct'}:${id}`
}

// 来源作用域（global、app:<id>、group:<对象>、direct:<对象>）换成带名字的形式；应用或对象删掉了时名字为空
export async function scopeNames(
  tx: Tx,
  scopes: string[],
): Promise<(scope: string) => OriginScope> {
  const parse = (scope: string) => {
    const [kind, id] = scope.split(':', 2) as [string, string | undefined]
    return { kind, id: id && UUID.test(id) ? id : null }
  }
  const parsed = scopes.map(parse)
  const appIds = [...new Set(parsed.filter((p) => p.kind === 'app' && p.id).map((p) => p.id!))]
  const subjectIds = [
    ...new Set(
      parsed.filter((p) => (p.kind === 'group' || p.kind === 'direct') && p.id).map((p) => p.id!),
    ),
  ]
  const [appRows, subjectRows] = await Promise.all([
    appIds.length
      ? tx.select({ id: apps.id, name: apps.name }).from(apps).where(inArray(apps.id, appIds))
      : [],
    subjectIds.length
      ? tx
          .select({ id: subjects.id, name: subjects.displayName })
          .from(subjects)
          .where(inArray(subjects.id, subjectIds))
      : [],
  ])
  const names = new Map([...appRows, ...subjectRows].map((r) => [r.id, r.name]))
  return (scope) => {
    const { kind, id } = parse(scope)
    if (kind === 'app' || kind === 'group' || kind === 'direct') {
      return { kind, id, name: id ? (names.get(id) ?? null) : null }
    }
    return { kind: 'global', id: null, name: null }
  }
}

// ---- Dream 的范围 ----
// 一次模型调用、一条建议里只放同一个范围的记忆，不把不同成员的私人内容混在一起：
// 共享的归属按类分开（core、各人格 persona:<id>、各应用 app:<id>）；每个成员的本人一个（user:<成员>），
// 连同他不带会话上下文的会话摘要（同样归这个成员），关于它们的建议只有本人看得到；
// 联系人的事实与群聊、私聊的会话摘要按来源作用域分（talk:<来源作用域>，同一个群、同一个人的私聊里记下的），
// 合并不会把私聊里的事带进群里

// 来自对话的两类：不归某个成员的按来源作用域分范围，范围是 talk:<来源作用域>
export const TALK_LAYERS = ['subject', 'episode'] as const

// 一条记忆所在的范围；dreamScopeCondition 是反过来按范围取记忆的条件，两边要对得上。每一类都写明，
// 没列出的（以后新加的）没有范围（为空），Dream 不整理它们，不会悄悄并进哪个范围
export const DREAM_SCOPE_KEY = sql<string>`(case
  when ${memories.layer} = 'core' then 'core'
  when ${memories.layer} = 'persona' then 'persona:' || ${memories.personaId}::text
  when ${memories.layer} = 'app' then 'app:' || ${memories.appId}::text
  when ${memories.layer} in ('user', 'episode') and ${memories.ownerAccountId} is not null
    then 'user:' || ${memories.ownerAccountId}::text
  when ${inArray(memories.layer, [...TALK_LAYERS])} then 'talk:' || ${memories.originScope} end)`

export type DreamScopeKind = DreamScope['kind']

export interface ParsedDreamScope {
  kind: DreamScopeKind
  // 人格、应用与成员的 id
  id: string | null
  // 联系人的事实与会话摘要的来源作用域
  origin: string | null
}

// 认不出的为 null
export function parseDreamScope(key: string): ParsedDreamScope | null {
  if (key === 'core') return { kind: 'core', id: null, origin: null }
  const at = key.indexOf(':')
  if (at < 0) return null
  const kind = key.slice(0, at)
  const rest = key.slice(at + 1)
  if (kind === 'talk') return rest ? { kind, id: null, origin: rest } : null
  if (kind === 'persona' || kind === 'app' || kind === 'user') {
    return UUID.test(rest) ? { kind, id: rest, origin: null } : null
  }
  return null
}

// 范围属于哪个成员：本人的范围是那个成员的，别的范围为 null
export function dreamScopeOwner(key: string): string | null {
  const parsed = parseDreamScope(key)
  return parsed?.kind === 'user' ? parsed.id : null
}

// 范围里的记忆（只按层与归属，有效与否、敏感级由调用方另加）
export function dreamScopeCondition(scope: ParsedDreamScope): SQL {
  switch (scope.kind) {
    case 'core':
      return eq(memories.layer, 'core')
    case 'persona':
      return and(eq(memories.layer, 'persona'), eq(memories.personaId, scope.id!))!
    case 'app':
      return and(eq(memories.layer, 'app'), eq(memories.appId, scope.id!))!
    case 'user':
      return and(
        inArray(memories.layer, ['user', 'episode']),
        eq(memories.ownerAccountId, scope.id!),
      )!
    case 'talk':
      return and(
        inArray(memories.layer, [...TALK_LAYERS]),
        isNull(memories.ownerAccountId),
        eq(memories.originScope, scope.origin!),
      )!
  }
}

// 范围换成界面上显示的形式：人格与应用带上现在的名字，对象与情节带上来源作用域的名字
export async function dreamScopeNames(
  tx: Tx,
  keys: string[],
): Promise<(key: string) => DreamScope> {
  const parsed = keys.map(parseDreamScope).filter((p): p is ParsedDreamScope => p !== null)
  const ids = (kind: DreamScopeKind) => [
    ...new Set(parsed.filter((p) => p.kind === kind).map((p) => p.id!)),
  ]
  const [personaRows, appRows, origins] = await Promise.all([
    ids('persona').length
      ? tx
          .select({ id: personas.id, name: personas.name })
          .from(personas)
          .where(inArray(personas.id, ids('persona')))
      : [],
    ids('app').length
      ? tx
          .select({ id: apps.id, name: apps.name })
          .from(apps)
          .where(inArray(apps.id, ids('app')))
      : [],
    scopeNames(
      tx,
      parsed.filter((p) => p.kind === 'talk').map((p) => p.origin!),
    ),
  ])
  const names = new Map([...personaRows, ...appRows].map((r) => [r.id, r.name]))
  return (key) => {
    const scope = parseDreamScope(key)
    if (!scope) return { kind: 'core', id: null, name: null, origin: null }
    if (scope.kind === 'talk') {
      return { kind: 'talk', id: null, name: null, origin: origins(scope.origin!) }
    }
    if (scope.kind === 'persona' || scope.kind === 'app') {
      return { kind: scope.kind, id: scope.id, name: names.get(scope.id!) ?? null, origin: null }
    }
    // 本人的范围只给本人看，不用带名字
    return { kind: scope.kind, id: null, name: null, origin: null }
  }
}
