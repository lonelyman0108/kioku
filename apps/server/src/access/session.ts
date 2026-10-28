import type { PlatformRef, SessionContextInput, SubjectKind } from '@kioku/contracts'
import { and, eq, sql } from 'drizzle-orm'

import { withSpace, type Tx } from '../db/client'
import { appGroupPersonas, subjectIdentities, subjects } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import type { SessionContext } from './access'

// 平台上的名字最多记这么多字（按字符算），超出的截掉：契约只拒绝离谱的长度，
// 不能因为某个人的名字长就拒掉整轮召回
const PLATFORM_NAME_CHARS = 128

// 一次请求的会话：会话上下文、这次用的人格，以及对象直连要用的当前发言人与本群
export interface KeySession {
  context: SessionContext
  personaId: string | null
  subjects: SessionSubject[]
}

export interface SessionSubject {
  id: string
  role: 'sender' | 'group'
  // 平台上的名字：这次上报的，没报时取上次记下的。主人在管理界面给对象起的名字可能是私下的备注，不往对话里放
  name: string
}

interface ResolvedSubject {
  id: string
  name: string
  accountId: string | null
}

// 不带会话上下文：Key 自己就是全部授权，用应用的默认人格
export function defaultSession(key: KeyPrincipal): KeySession {
  return { context: {}, personaId: key.app.defaultPersonaId, subjects: [] }
}

// 把接入方上报的会话上下文解析成对象与授权要用的会话：平台账号按（平台、种类、账号）找对象，没见过的就新建。
// 对象关联了应用主人的账号时，这个人的私聊算主人私聊；群有按群换人格的规则时用规则里的人格。
// 上报的内容不可信，所以这里只决定收紧到哪一种上下文，放宽不了 Key 的上限（见 resolveAccess）
export async function resolveKeySession(
  deps: Deps,
  key: KeyPrincipal,
  input: SessionContextInput | undefined,
): Promise<KeySession> {
  if (!input) return defaultSession(key)
  const { chatType } = input
  if (chatType === 'cron' || chatType === 'subagent') {
    return { ...defaultSession(key), context: { chatType } }
  }
  // 带了群或发言人时契约要求带上平台
  const platform = input.platform!
  return withSpace(deps.db, key.spaceId, async (tx) => {
    // 群里报的发言人名字可能是群名片，每个群不一样，跟着它改会来回变：只在第一次见到这个人时记下，
    // 之后只按私聊里报的名字更新
    const sender = input.sender
      ? await resolveSubject(tx, key.spaceId, platform, 'person', input.sender, {
          refresh: chatType === 'direct',
        })
      : null
    if (chatType === 'direct') {
      return {
        context: {
          chatType,
          senderSubjectId: sender!.id,
          senderIsOwner: sender!.accountId === key.app.ownerAccountId,
        },
        personaId: key.app.defaultPersonaId,
        subjects: [{ id: sender!.id, role: 'sender', name: sender!.name }],
      }
    }
    const group = await resolveSubject(tx, key.spaceId, platform, 'group', input.group!, {
      refresh: true,
    })
    const [rule] = await tx
      .select({ personaId: appGroupPersonas.personaId })
      .from(appGroupPersonas)
      .where(and(eq(appGroupPersonas.appId, key.app.id), eq(appGroupPersonas.subjectId, group.id)))
    return {
      context: {
        chatType,
        groupSubjectId: group.id,
        ...(sender ? { senderSubjectId: sender.id } : {}),
      },
      personaId: rule?.personaId ?? key.app.defaultPersonaId,
      subjects: [
        ...(sender ? [{ id: sender.id, role: 'sender' as const, name: sender.name }] : []),
        { id: group.id, role: 'group', name: group.name },
      ],
    }
  })
}

async function resolveSubject(
  tx: Tx,
  spaceId: string,
  platform: string,
  kind: SubjectKind,
  ref: PlatformRef,
  options: { refresh: boolean },
): Promise<ResolvedSubject> {
  // 平台上没设名字时插件可能报空字符串，当作没带
  const reported = ref.name ? clip(ref.name, PLATFORM_NAME_CHARS) : undefined
  const known = async () => {
    const found = await findIdentity(tx, platform, kind, ref.id)
    if (!found) return undefined
    return options.refresh ? refreshName(tx, found, reported) : resolvedFrom(found, reported)
  }
  const existing = await known()
  if (existing) return existing
  // 第一次见到这个账号：按账号加事务级的咨询锁再查一次，同一个账号的并发请求排队，只建出一个对象
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`subject:${spaceId}:${platform}:${kind}:${ref.id}`}, 0))`,
  )
  const raced = await known()
  if (raced) return raced
  const name = reported ?? ref.id
  const [subject] = await tx
    .insert(subjects)
    .values({ spaceId, kind, displayName: name })
    .returning({ id: subjects.id })
  await tx.insert(subjectIdentities).values({
    spaceId,
    subjectId: subject!.id,
    kind,
    platform,
    externalId: ref.id,
    displayName: reported ?? null,
  })
  return { id: subject!.id, name, accountId: null }
}

interface FoundIdentity {
  identityId: string
  externalId: string
  identityName: string | null
  subjectId: string
  subjectName: string
  accountId: string | null
}

async function findIdentity(
  tx: Tx,
  platform: string,
  kind: SubjectKind,
  externalId: string,
): Promise<FoundIdentity | undefined> {
  const [row] = await tx
    .select({
      identityId: subjectIdentities.id,
      externalId: subjectIdentities.externalId,
      identityName: subjectIdentities.displayName,
      subjectId: subjects.id,
      subjectName: subjects.displayName,
      accountId: subjects.accountId,
    })
    .from(subjectIdentities)
    .innerJoin(subjects, eq(subjects.id, subjectIdentities.subjectId))
    .where(
      and(
        eq(subjectIdentities.platform, platform),
        eq(subjectIdentities.kind, kind),
        eq(subjectIdentities.externalId, externalId),
      ),
    )
  return row
}

function resolvedFrom(found: FoundIdentity, reported: string | undefined): ResolvedSubject {
  return {
    id: found.subjectId,
    name: reported ?? found.identityName ?? found.externalId,
    accountId: found.accountId,
  }
}

// 平台上的显示名变了就记下来。对象的名字还是从这个账号带过来的（等于它之前的显示名，主人没改过）时一起改；
// 主人改过名字，或名字来自合并进来的别的账号时不动
async function refreshName(
  tx: Tx,
  found: FoundIdentity,
  name: string | undefined,
): Promise<ResolvedSubject> {
  const resolved = resolvedFrom(found, name)
  if (name === undefined || name === found.identityName) return resolved
  await tx
    .update(subjectIdentities)
    .set({ displayName: name })
    .where(eq(subjectIdentities.id, found.identityId))
  const previous = found.identityName ?? found.externalId
  if (found.subjectName === previous) {
    await tx
      .update(subjects)
      .set({ displayName: name, updatedAt: new Date() })
      .where(and(eq(subjects.id, found.subjectId), eq(subjects.displayName, previous)))
  }
  return resolved
}

// 按字符（不是 UTF-16 码元）截断，免得切开表情符号
function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join('') : text
}
