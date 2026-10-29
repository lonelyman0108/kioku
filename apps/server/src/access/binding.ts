import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

import type { BindingStatus, MemberRole, SubjectBinding } from '@kioku/contracts'
import { and, asc, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { withSpace, type Db, type Tx } from '../db/client'
import {
  accounts,
  apps,
  spaces,
  subjectBindAttempts,
  subjectBindCodes,
  subjectBindings,
  subjectIdentities,
  subjects,
} from '../db/schema'
import type { KeyPrincipal } from '../http/env'
import { accessForKey } from '../memory/context'
import { canWrite } from './access'
import type { KeySession } from './session'
import { linkedToOthers, lockSubjects, mergeSubjects, type MergeOutcome } from './subjects'

// 验证码自助绑定：在一个平台的私聊里用 Key 申请绑定码，到另一个平台的私聊里带上码，
// 把那个平台账号的对象并进申请的对象。规则同合并对象（同种类、标记的限制）；
// 申请的对象标记了成员时，要那个成员本人在管理界面确认后才合并

// 8 位，字符集去掉了容易看混的 0、O、1、I、L；10 分钟有效，只能用一次
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_FORMAT = new RegExp(`^[${CODE_ALPHABET}]{8}$`)
export const CODE_TTL_SECONDS = 600
// 等成员确认的绑定这么多天内有效
export const PENDING_TTL_DAYS = 7
// 输错上限，一小时一个窗口：同一个收码的平台账号 5 次；同一个应用合计 100 次，挡住换着账号猜
export const ATTEMPT_WINDOW_SECONDS = 3600
export const ACCOUNT_ATTEMPTS = 5
export const APP_ATTEMPTS = 100

export function generateCode(): string {
  let code = ''
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

// 用户发来的码：不分大小写，空格与连字符不算。格式不对时为 null
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  return CODE_FORMAT.test(code) ? code : null
}

// 库里只存哈希。带上应用：码只在同一个应用里用得了
export function hashCode(appId: string, code: string): string {
  return createHash('sha256').update(`kioku-bind-code\u0000${appId}\u0000${code}`).digest('hex')
}

// 在这个应用现在有效的码里找：逐条用常量时间比较、每条都比完，不按哈希去库里查，
// 耗时不随发来的码和哪一条有几位相同而变
function matchCode<T extends { codeHash: string }>(rows: T[], hash: string): T | null {
  const wanted = Buffer.from(hash, 'hex')
  let found: T | null = null
  for (const row of rows) {
    const stored = Buffer.from(row.codeHash, 'hex')
    if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) found ??= row
  }
  return found
}

// 绑定会把两个对象并成一个、改对象层记忆的归属，所以要求这把 Key 在私聊里写得了对象层
// （应用主人是 viewer 时 Key 什么都写不了）。按私聊的规则判断，不用先解析会话：解析会建对象
export function canBindWithKey(key: KeyPrincipal): boolean {
  const access = accessForKey(key, {
    context: { chatType: 'direct', senderSubjectId: 'sender' },
    personaId: key.app.defaultPersonaId,
    subjects: [],
  })
  return canWrite(access, { layer: 'subject', sensitivity: 'public', appId: null, personaId: null })
}

// ---- 输错计数 ----

// 计数键用 JSON 数组编码，平台账号里带什么字符都拼不出别的键
const accountKey = (platform: string, externalId: string) =>
  JSON.stringify(['account', platform, externalId])
const APP_KEY = JSON.stringify(['app'])

async function bump(tx: Tx, key: KeyPrincipal, counter: string, delta: number) {
  const fresh = Math.max(delta, 0)
  const [row] = await tx
    .insert(subjectBindAttempts)
    .values({
      spaceId: key.spaceId,
      appId: key.app.id,
      key: counter,
      count: fresh,
      resetAt: sql`now() + make_interval(secs => ${ATTEMPT_WINDOW_SECONDS})`,
    })
    .onConflictDoUpdate({
      target: [subjectBindAttempts.appId, subjectBindAttempts.key],
      set: {
        count: sql`case when ${subjectBindAttempts.resetAt} <= now() then ${fresh} else greatest(${subjectBindAttempts.count} + ${delta}, 0) end`,
        resetAt: sql`case when ${subjectBindAttempts.resetAt} <= now() then now() + make_interval(secs => ${ATTEMPT_WINDOW_SECONDS}) else ${subjectBindAttempts.resetAt} end`,
      },
    })
    .returning({
      count: subjectBindAttempts.count,
      waitSeconds: sql<number>`greatest(ceil(extract(epoch from ${subjectBindAttempts.resetAt} - now())), 1)::int`,
    })
  return row!
}

export interface AttemptLimit {
  // 哪一级超了：这个平台账号，或者整个应用
  scope: 'account' | 'app'
  // 多久之后能再试
  waitSeconds: number
}

// 核对绑定码之前先占一次名额，超限时返回哪一级超了。和登录的失败计数一样逐级计数：这个账号已经超限就停下，
// 不再推高整个应用的计数（否则一个被挡住的账号还能把整个应用的名额耗光）；被应用的上限挡下时退回这个账号的这一次。
// 在一个事务里按「这个账号 → 整个应用」的顺序锁计数行，同一个账号的并发请求排队，不会互相等成死锁。
// 只看发来的平台账号，不建对象：超限的请求不解析会话
export async function reserveAttempt(
  db: Db,
  key: KeyPrincipal,
  platform: string,
  externalId: string,
): Promise<AttemptLimit | null> {
  return withSpace(db, key.spaceId, async (tx) => {
    const own = accountKey(platform, externalId)
    const mine = await bump(tx, key, own, 1)
    if (mine.count > ACCOUNT_ATTEMPTS) return { scope: 'account', waitSeconds: mine.waitSeconds }
    const all = await bump(tx, key, APP_KEY, 1)
    if (all.count > APP_ATTEMPTS) {
      await bump(tx, key, own, -1)
      return { scope: 'app', waitSeconds: all.waitSeconds }
    }
    return null
  })
}

// 绑定成了（合并或等确认）：清掉这个平台账号的计数，退回这次在整个应用的计数里占的名额；别人输错的不清
export async function clearAttempts(
  db: Db,
  key: KeyPrincipal,
  platform: string,
  externalId: string,
): Promise<void> {
  await withSpace(db, key.spaceId, async (tx) => {
    await tx
      .delete(subjectBindAttempts)
      .where(
        and(
          eq(subjectBindAttempts.appId, key.app.id),
          eq(subjectBindAttempts.key, accountKey(platform, externalId)),
        ),
      )
    await bump(tx, key, APP_KEY, -1)
  })
}

// 每小时的清理：过期的绑定码（用过的也是到期就删）与过了窗口的输错计数。内容表开了 RLS，逐个空间处理。
// 正被锁着的行跳过、下次再清：用码的请求按「这个账号 → 整个应用」的顺序锁计数行，这里按别的顺序等锁会互相等成死锁
export async function pruneBindingData(db: Db): Promise<{ codes: number; attempts: number }> {
  let codes = 0
  let attempts = 0
  for (const { id } of await db.select({ id: spaces.id }).from(spaces)) {
    const done = await withSpace(db, id, async (tx) => {
      const gone = await tx.execute(sql`
        delete from ${subjectBindCodes} where ${subjectBindCodes.id} in (
          select ${subjectBindCodes.id} from ${subjectBindCodes}
          where ${subjectBindCodes.expiresAt} <= now() for update skip locked
        ) returning 1`)
      const reset = await tx.execute(sql`
        delete from ${subjectBindAttempts}
        where (${subjectBindAttempts.appId}, ${subjectBindAttempts.key}) in (
          select ${subjectBindAttempts.appId}, ${subjectBindAttempts.key} from ${subjectBindAttempts}
          where ${subjectBindAttempts.resetAt} <= now() for update skip locked
        ) returning 1`)
      return { codes: gone.length, attempts: reset.length }
    })
    codes += done.codes
    attempts += done.attempts
  }
  return { codes, attempts }
}

// ---- 申请与使用绑定码 ----

// 申请绑定码：锁住发码的对象（同一个对象同时申请两次时排队），删掉它之前的码（旧码作废），换一个新的。
// 码在同一个应用里不重复，撞上了（概率极小）就重新生成。发言人的对象在解析之后刚好被合并掉时返回 null
export async function issueCode(
  db: Db,
  key: KeyPrincipal,
  session: KeySession,
  platform: string,
  externalId: string,
): Promise<{ code: string; expiresAt: Date } | null> {
  const subjectId = session.context.senderSubjectId!
  return withSpace(db, key.spaceId, async (tx) => {
    const [subject] = await lockSubjects(tx, [subjectId])
    if (!subject) return null
    await tx.delete(subjectBindCodes).where(eq(subjectBindCodes.subjectId, subjectId))
    for (let tries = 0; tries < 5; tries++) {
      const code = generateCode()
      const [row] = await tx
        .insert(subjectBindCodes)
        .values({
          spaceId: key.spaceId,
          appId: key.app.id,
          keyId: key.keyId,
          subjectId,
          platform,
          externalId,
          codeHash: hashCode(key.app.id, code),
          expiresAt: sql`now() + make_interval(secs => ${CODE_TTL_SECONDS})`,
        })
        .onConflictDoNothing()
        .returning({ expiresAt: subjectBindCodes.expiresAt })
      if (row) return { code, expiresAt: row.expiresAt }
    }
    throw new Error('生成不出不重复的绑定码')
  })
}

export interface Redeemer {
  platform: string
  externalId: string
  displayName: string | null
}

export type RedeemResult =
  | { kind: 'merged'; outcome: MergeOutcome }
  | { kind: 'pending'; expiresAt: Date }
  // 码不对、过期了、用过了或被新码换掉了：一律这样说，不透露是哪种
  | { kind: 'invalid' }
  // 收码的就是发码的对象（同一个账号，或者已经并在一起）
  | { kind: 'same' }
  // 收码的对象标记成了别的成员
  | { kind: 'linked' }
  // 不是同种类（都在私聊里认出来的，按理都是人）
  | { kind: 'kind' }
  // 收码的对象在解析之后刚好被合并掉了，再试一次就行
  | { kind: 'busy' }

// 使用绑定码，全部检查与合并在一个事务里。session 是收码的这次私聊
export async function redeemCode(
  db: Db,
  key: KeyPrincipal,
  session: KeySession,
  code: string,
  redeemer: Redeemer,
): Promise<RedeemResult> {
  const fromId = session.context.senderSubjectId!
  const hash = hashCode(key.app.id, code)
  return withSpace(db, key.spaceId, async (tx) => {
    // 只认这个应用的码；别的空间的码在 RLS 之外，根本读不到
    const live = await tx
      .select({
        id: subjectBindCodes.id,
        subjectId: subjectBindCodes.subjectId,
        codeHash: subjectBindCodes.codeHash,
      })
      .from(subjectBindCodes)
      .where(
        and(
          eq(subjectBindCodes.appId, key.app.id),
          isNull(subjectBindCodes.usedAt),
          gt(subjectBindCodes.expiresAt, sql`now()`),
        ),
      )
    const match = matchCode(live, hash)
    if (!match) return { kind: 'invalid' }
    if (match.subjectId === fromId) return { kind: 'same' }
    // 先按 id 的顺序锁住两个对象，再锁码：和合并对象的加锁顺序一致（合并删掉对象时连带删它的码）
    const rows = await lockSubjects(tx, [match.subjectId, fromId])
    // 锁住之后再核对一次：等锁期间码可能被别人用掉、被新码换掉，或者随发码的对象被合并掉而删了
    const [held] = await tx
      .select()
      .from(subjectBindCodes)
      .where(
        and(
          eq(subjectBindCodes.id, match.id),
          isNull(subjectBindCodes.usedAt),
          gt(subjectBindCodes.expiresAt, sql`now()`),
        ),
      )
      .for('update')
    const into = rows.find((r) => r.id === match.subjectId)
    const from = rows.find((r) => r.id === fromId)
    if (!held || !into) return { kind: 'invalid' }
    if (!from) return { kind: 'busy' }
    if (into.kind !== from.kind) return { kind: 'kind' }
    // 收码的对象只能是没标记的，或者和发码的对象标记成同一个成员：否则这个平台账号会被挂到别人的标记下
    if (linkedToOthers([from], into.accountId)) return { kind: 'linked' }

    await tx
      .update(subjectBindCodes)
      .set({ usedAt: sql`now()` })
      .where(eq(subjectBindCodes.id, held.id))
    const record = {
      spaceId: key.spaceId,
      appId: key.app.id,
      keyId: key.keyId,
      subjectId: into.id,
      fromSubjectId: from.id,
      platform: redeemer.platform,
      externalId: redeemer.externalId,
      displayName: redeemer.displayName,
      issuedPlatform: held.platform,
      issuedExternalId: held.externalId,
      issuedAt: held.createdAt,
    }
    if (into.accountId === null) {
      await tx
        .insert(subjectBindings)
        .values({ ...record, status: 'merged', decidedAt: sql`now()` })
      return { kind: 'merged', outcome: await mergeSubjects(tx, from, into) }
    }
    // 发码的对象标记了成员：这个对象的私聊算那个成员的主人私聊，码泄露了别人就能把自己的账号挂过来，
    // 所以等那个成员本人确认。同一对对象已经有一条在等同一个成员的，沿用那一条
    const [waiting] = await tx
      .select({ expiresAt: subjectBindings.expiresAt })
      .from(subjectBindings)
      .where(
        and(
          eq(subjectBindings.subjectId, into.id),
          eq(subjectBindings.fromSubjectId, from.id),
          eq(subjectBindings.accountId, into.accountId),
          eq(subjectBindings.status, 'pending'),
          gt(subjectBindings.expiresAt, sql`now()`),
        ),
      )
    if (waiting) return { kind: 'pending', expiresAt: waiting.expiresAt! }
    const [created] = await tx
      .insert(subjectBindings)
      .values({
        ...record,
        status: 'pending',
        accountId: into.accountId,
        expiresAt: sql`now() + make_interval(days => ${PENDING_TTL_DAYS})`,
      })
      .returning({ expiresAt: subjectBindings.expiresAt })
    return { kind: 'pending', expiresAt: created!.expiresAt! }
  })
}

// ---- 管理界面里确认、拒绝 ----

export type DecideResult =
  | { ok: true; subjectId: string; outcome: MergeOutcome | null }
  | { ok: false; status: 403 | 404 | 409; error: string }

const ONLY_CONFIRMER = '只有这个对象标记成的成员本人能处理这次绑定'

type BindingRow = typeof subjectBindings.$inferSelect

// 已经处理过、或者过了期限的不能再处理；还能处理时为 null。live 是按数据库的时间算的「还没到期限」
function closedReason(binding: BindingRow, live: boolean): string | null {
  switch (binding.status) {
    case 'pending':
      return live ? null : '已经过了确认期限，这次绑定作废了'
    case 'merged':
    case 'confirmed':
      return '已经合并了'
    case 'rejected':
      return '已经拒绝了'
    case 'cancelled':
      return `这次绑定已经作废：${binding.note ?? '情况变了'}`
  }
}

async function lockBinding(tx: Tx, id: string) {
  const [row] = await tx
    .select({ binding: subjectBindings, live: sql<boolean>`${subjectBindings.expiresAt} > now()` })
    .from(subjectBindings)
    .where(eq(subjectBindings.id, id))
    .for('update')
  return row
}

// 作废并说明原因：两边的情况和收码时不一样了，确认不了
async function cancel(tx: Tx, id: string, note: string) {
  await tx
    .update(subjectBindings)
    .set({ status: 'cancelled', decidedAt: sql`now()`, note })
    .where(eq(subjectBindings.id, id))
  return { ok: false as const, status: 409 as const, error: `${note}，这次绑定作废了` }
}

// 确认：只有发码的对象标记成的成员本人能确认（空间 owner 也不行），还要 owner 或 editor 角色（合并对象要写权限）。
// 按合并对象执行，在同一个事务里重新做合并时的检查：期间两边被合并、标记变了就作废并说明
export async function confirmBinding(
  db: Db,
  spaceId: string,
  bindingId: string,
  me: string,
  role: MemberRole,
): Promise<DecideResult> {
  return withSpace(db, spaceId, async (tx) => {
    // 先不加锁读出两边，按 id 的顺序锁住两个对象，再锁这一条：和用码、合并对象的加锁顺序一致。
    // 两边在这期间被合并的话，这一条已经作废（合并时做的），下面按锁住之后的状态判断
    const [seen] = await tx.select().from(subjectBindings).where(eq(subjectBindings.id, bindingId))
    if (!seen) return { ok: false, status: 404, error: '这次绑定不存在' }
    if (seen.accountId !== me) return { ok: false, status: 403, error: ONLY_CONFIRMER }
    if (role === 'viewer') return { ok: false, status: 403, error: '需要 owner 或 editor 角色' }
    const rows = await lockSubjects(tx, [seen.subjectId, seen.fromSubjectId])
    const held = await lockBinding(tx, bindingId)
    if (!held) return { ok: false, status: 404, error: '这次绑定不存在' }
    const { binding } = held
    const closed = closedReason(binding, held.live)
    if (closed) return { ok: false, status: 409, error: closed }
    const into = rows.find((r) => r.id === binding.subjectId)
    const from = rows.find((r) => r.id === binding.fromSubjectId)
    if (!into || !from || into.id === from.id) return cancel(tx, binding.id, '对象已经不在了')
    if (into.kind !== from.kind) return cancel(tx, binding.id, '两边不是同一种对象')
    if (into.accountId !== me) return cancel(tx, binding.id, '这个对象已经不再标记成你')
    if (linkedToOthers([from], me)) {
      return cancel(tx, binding.id, '要并进来的对象标记成了别的成员')
    }
    await tx
      .update(subjectBindings)
      .set({ status: 'confirmed', decidedAt: sql`now()`, decidedBy: me })
      .where(eq(subjectBindings.id, binding.id))
    return { ok: true, subjectId: into.id, outcome: await mergeSubjects(tx, from, into) }
  })
}

// 拒绝：只有发码的对象标记成的成员本人能拒绝，什么角色都可以（拒绝不改别的东西）
export async function rejectBinding(
  db: Db,
  spaceId: string,
  bindingId: string,
  me: string,
): Promise<DecideResult> {
  return withSpace(db, spaceId, async (tx) => {
    const held = await lockBinding(tx, bindingId)
    if (!held) return { ok: false, status: 404, error: '这次绑定不存在' }
    const { binding } = held
    if (binding.accountId !== me) return { ok: false, status: 403, error: ONLY_CONFIRMER }
    const closed = closedReason(binding, held.live)
    if (closed) return { ok: false, status: 409, error: closed }
    await tx
      .update(subjectBindings)
      .set({ status: 'rejected', decidedAt: sql`now()`, decidedBy: me })
      .where(eq(subjectBindings.id, binding.id))
    return { ok: true, subjectId: binding.subjectId, outcome: null }
  })
}

// ---- 管理界面里列出 ----

export interface BindingViewer {
  accountId: string
  role: MemberRole
}

const target = alias(subjects, 'binding_target')
const confirmer = alias(accounts, 'binding_confirmer')
const decider = alias(accounts, 'binding_decider')

// 绑定记录：对象、应用与成员的名字一次查出；还在等确认的，再带上收码的对象现在的名字与全部平台账号
async function bindingViews(
  tx: Tx,
  where: SQL,
  viewer: BindingViewer,
  limit: number,
): Promise<SubjectBinding[]> {
  const rows = await tx
    .select({
      binding: subjectBindings,
      live: sql<boolean>`coalesce(${subjectBindings.expiresAt} > now(), false)`,
      subjectName: target.displayName,
      subjectAccountId: target.accountId,
      appName: apps.name,
      confirmerName: confirmer.displayName,
      deciderName: decider.displayName,
    })
    .from(subjectBindings)
    .innerJoin(target, eq(target.id, subjectBindings.subjectId))
    .innerJoin(apps, eq(apps.id, subjectBindings.appId))
    .leftJoin(confirmer, eq(confirmer.id, subjectBindings.accountId))
    .leftJoin(decider, eq(decider.id, subjectBindings.decidedBy))
    .where(where)
    .orderBy(desc(subjectBindings.createdAt), desc(subjectBindings.id))
    .limit(limit)
  const statusOf = (r: (typeof rows)[number]): BindingStatus =>
    r.binding.status === 'pending' && !r.live ? 'expired' : r.binding.status
  const waiting = [
    ...new Set(rows.filter((r) => statusOf(r) === 'pending').map((r) => r.binding.fromSubjectId)),
  ]
  const [incoming, identities] = waiting.length
    ? await Promise.all([
        tx
          .select({ id: subjects.id, displayName: subjects.displayName })
          .from(subjects)
          .where(inArray(subjects.id, waiting)),
        tx
          .select()
          .from(subjectIdentities)
          .where(inArray(subjectIdentities.subjectId, waiting))
          .orderBy(asc(subjectIdentities.platform), asc(subjectIdentities.externalId)),
      ])
    : [[], []]
  return rows.map((r) => {
    const { binding: b } = r
    const status = statusOf(r)
    const source = status === 'pending' ? incoming.find((s) => s.id === b.fromSubjectId) : undefined
    const canReject = status === 'pending' && b.accountId === viewer.accountId
    return {
      id: b.id,
      status,
      subject: { id: b.subjectId, displayName: r.subjectName },
      incoming: source
        ? {
            ...source,
            identities: identities
              .filter((i) => i.subjectId === source.id)
              .map((i) => ({
                platform: i.platform,
                externalId: i.externalId,
                displayName: i.displayName,
              })),
          }
        : null,
      redeemedBy: { platform: b.platform, externalId: b.externalId, displayName: b.displayName },
      issuedBy: { platform: b.issuedPlatform, externalId: b.issuedExternalId },
      issuedAt: b.issuedAt.toISOString(),
      app: { id: b.appId, name: r.appName },
      confirmer:
        b.accountId && r.confirmerName !== null
          ? { id: b.accountId, displayName: r.confirmerName }
          : null,
      decidedBy:
        b.decidedBy && r.deciderName !== null
          ? { id: b.decidedBy, displayName: r.deciderName }
          : null,
      createdAt: b.createdAt.toISOString(),
      expiresAt: b.expiresAt?.toISOString() ?? null,
      decidedAt: (status === 'expired' ? b.expiresAt : b.decidedAt)?.toISOString() ?? null,
      note: b.note,
      canReject,
      // 确认时还会重新检查；这里先按现在的标记与角色给出能不能点
      canConfirm: canReject && viewer.role !== 'viewer' && r.subjectAccountId === viewer.accountId,
    }
  })
}

// 对象页的绑定记录：绑到这个对象的，以及这个对象申请绑到别处的
export function subjectBindingHistory(
  tx: Tx,
  subjectId: string,
  viewer: BindingViewer,
  limit: number,
): Promise<SubjectBinding[]> {
  return bindingViews(
    tx,
    or(eq(subjectBindings.subjectId, subjectId), eq(subjectBindings.fromSubjectId, subjectId))!,
    viewer,
    limit,
  )
}

// 概览里等查看者本人确认的：还没到期限、发码的对象现在仍标记成他
export function pendingBindingsFor(
  tx: Tx,
  viewer: BindingViewer,
  limit: number,
): Promise<SubjectBinding[]> {
  return bindingViews(
    tx,
    and(
      eq(subjectBindings.accountId, viewer.accountId),
      eq(subjectBindings.status, 'pending'),
      gt(subjectBindings.expiresAt, sql`now()`),
      eq(target.accountId, viewer.accountId),
    )!,
    viewer,
    limit,
  )
}
