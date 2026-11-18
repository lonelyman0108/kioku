import { createHash, createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto'

import type { BindingStatus, MemberRole, SubjectBinding } from '@kioku/contracts'
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { keyringOf, type MasterKey } from '../crypto/keyring'
import { withCircle, type Db, type Tx } from '../db/client'
import {
  accounts,
  circles,
  clients,
  subjectBindAttempts,
  subjectBindCodes,
  subjectBindings,
  subjectIdentities,
  subjects,
} from '../db/schema'
import type { KeyPrincipal } from '../http/env'
import { canWrite } from './access'
import { accessForKey, type KeySession } from './session'
import { linkedToOthers, lockSubjects, mergeSubjects, type MergeOutcome } from './subjects'

// 8 位，字符集去掉了容易看混的 0、O、1、I、L；10 分钟有效，只能用一次
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_FORMAT = new RegExp(`^[${CODE_ALPHABET}]{8}$`)
export const CODE_TTL_SECONDS = 600
export const PENDING_TTL_DAYS = 7
export const PREVIEWERS = 1000
export const ATTEMPT_WINDOW_SECONDS = 3600
export const ACCOUNT_ATTEMPTS = 5
export const CLIENT_ATTEMPTS = 1000
export const VOID_REQUESTS = 30

export function generateCode(): string {
  let code = ''
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  return CODE_FORMAT.test(code) ? code : null
}

const derivedKeys = new WeakMap<Buffer, Buffer>()
function codeKey(master: MasterKey): Buffer {
  const { current } = keyringOf(master)
  let derived = derivedKeys.get(current)
  if (!derived) {
    derived = Buffer.from(hkdfSync('sha256', current, Buffer.alloc(0), 'kioku-bind-code-hmac', 32))
    derivedKeys.set(current, derived)
  }
  return derived
}

export function hashCode(master: MasterKey | null, clientId: string, code: string): string {
  const input = `kioku-bind-code\u0000${clientId}\u0000${code}`
  return master
    ? createHmac('sha256', codeKey(master)).update(input).digest('hex')
    : createHash('sha256').update(input).digest('hex')
}

export function maskAccount(id: string): string {
  const chars = [...id]
  const shown = Math.floor(chars.length / 3)
  const head = Math.ceil(shown / 2)
  const tail = shown - head
  return `${chars.slice(0, head).join('')}***${tail ? chars.slice(-tail).join('') : ''}`
}

function matchCode<T extends { codeHash: string }>(rows: T[], hash: string): T | null {
  const wanted = Buffer.from(hash, 'hex')
  let found: T | null = null
  for (const row of rows) {
    const stored = Buffer.from(row.codeHash, 'hex')
    if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) found ??= row
  }
  return found
}

// 绑定会把两个联系人并成一个、改事实归属，所以要求这把密钥在私聊里写得了主场记忆圈的联系人事实
export function canBindWithKey(key: KeyPrincipal): boolean {
  const access = accessForKey(key, {
    context: { chatType: 'direct', senderSubjectId: 'sender' },
    personaId: key.client.defaultPersonaId,
    subjects: [],
  })
  return canWrite(access, { circleId: key.circleId, kind: 'fact', sensitivity: 'public' })
}

// ---- 输错计数 ----

const accountKey = (platform: string, externalId: string) =>
  JSON.stringify(['account', platform, externalId])
const CLIENT_KEY = JSON.stringify(['client'])
const voidKey = (platform: string, externalId: string) =>
  JSON.stringify(['void', platform, externalId])

async function bump(tx: Tx, key: KeyPrincipal, counter: string, delta: number) {
  const fresh = Math.max(delta, 0)
  const [row] = await tx
    .insert(subjectBindAttempts)
    .values({
      circleId: key.circleId,
      clientId: key.client.id,
      key: counter,
      count: fresh,
      resetAt: sql`now() + make_interval(secs => ${ATTEMPT_WINDOW_SECONDS})`,
    })
    .onConflictDoUpdate({
      target: [subjectBindAttempts.clientId, subjectBindAttempts.key],
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
  scope: 'account' | 'client' | 'void'
  waitSeconds: number
}

export async function reserveAttempt(
  db: Db,
  key: KeyPrincipal,
  platform: string,
  externalId: string,
): Promise<AttemptLimit | null> {
  return withCircle(db, key.circleId, async (tx) => {
    const own = accountKey(platform, externalId)
    const mine = await bump(tx, key, own, 1)
    if (mine.count > ACCOUNT_ATTEMPTS) return { scope: 'account', waitSeconds: mine.waitSeconds }
    const all = await bump(tx, key, CLIENT_KEY, 1)
    if (all.count > CLIENT_ATTEMPTS) {
      await bump(tx, key, own, -1)
      return { scope: 'client', waitSeconds: all.waitSeconds }
    }
    return null
  })
}

export async function refundAttempt(
  db: Db,
  key: KeyPrincipal,
  platform: string,
  externalId: string,
): Promise<void> {
  await withCircle(db, key.circleId, async (tx) => {
    await bump(tx, key, accountKey(platform, externalId), -1)
    await bump(tx, key, CLIENT_KEY, -1)
  })
}

export async function reserveVoid(
  db: Db,
  key: KeyPrincipal,
  platform: string,
  externalId: string,
): Promise<AttemptLimit | null> {
  return withCircle(db, key.circleId, async (tx) => {
    const row = await bump(tx, key, voidKey(platform, externalId), 1)
    return row.count > VOID_REQUESTS ? { scope: 'void', waitSeconds: row.waitSeconds } : null
  })
}

export async function pruneBindingData(db: Db): Promise<{ codes: number; attempts: number }> {
  let codes = 0
  let attempts = 0
  for (const { id } of await db.select({ id: circles.id }).from(circles)) {
    const done = await withCircle(db, id, async (tx) => {
      const gone = await tx.execute(sql`
        delete from ${subjectBindCodes} where ${subjectBindCodes.id} in (
          select ${subjectBindCodes.id} from ${subjectBindCodes}
          where ${subjectBindCodes.expiresAt} <= now() for update skip locked
        ) returning 1`)
      const reset = await tx.execute(sql`
        delete from ${subjectBindAttempts}
        where (${subjectBindAttempts.clientId}, ${subjectBindAttempts.key}) in (
          select ${subjectBindAttempts.clientId}, ${subjectBindAttempts.key} from ${subjectBindAttempts}
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

export async function issueCode(
  db: Db,
  master: MasterKey | null,
  key: KeyPrincipal,
  session: KeySession,
  platform: string,
  externalId: string,
): Promise<{ code: string; expiresAt: Date } | null> {
  const subjectId = session.context.senderSubjectId!
  return withCircle(db, key.circleId, async (tx) => {
    const [subject] = await lockSubjects(tx, [subjectId])
    if (!subject) return null
    await tx
      .update(subjectBindCodes)
      .set({ expiresAt: sql`now()` })
      .where(
        and(eq(subjectBindCodes.subjectId, subjectId), gt(subjectBindCodes.expiresAt, sql`now()`)),
      )
    for (let tries = 0; tries < 5; tries++) {
      const code = generateCode()
      const [row] = await tx
        .insert(subjectBindCodes)
        .values({
          circleId: key.circleId,
          clientId: key.client.id,
          keyId: key.keyId,
          subjectId,
          platform,
          externalId,
          codeHash: hashCode(master, key.client.id, code),
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

export interface BindTarget {
  platform: string
  displayName: string | null
  accountHint: string
}

export type RedeemResult =
  | { kind: 'preview'; target: BindTarget; needsApproval: boolean }
  | { kind: 'merged'; outcome: MergeOutcome }
  | { kind: 'pending'; expiresAt: Date }
  | { kind: 'invalid'; wrong: boolean }
  | { kind: 'same' }
  | { kind: 'linked'; issuerLinked: boolean }
  | { kind: 'kind' }
  | { kind: 'busy' }

function clientCodes(tx: Tx, clientId: string) {
  return tx
    .select({
      id: subjectBindCodes.id,
      subjectId: subjectBindCodes.subjectId,
      codeHash: subjectBindCodes.codeHash,
      live: sql<boolean>`${subjectBindCodes.usedAt} is null and ${subjectBindCodes.expiresAt} > now()`,
    })
    .from(subjectBindCodes)
    .where(eq(subjectBindCodes.clientId, clientId))
}

export async function redeemCode(
  db: Db,
  master: MasterKey | null,
  key: KeyPrincipal,
  session: KeySession,
  code: string,
  redeemer: Redeemer,
  confirm: boolean,
): Promise<RedeemResult> {
  const fromId = session.context.senderSubjectId!
  const hash = hashCode(master, key.client.id, code)
  return withCircle(db, key.circleId, async (tx) => {
    const match = matchCode(await clientCodes(tx, key.client.id), hash)
    if (!match) return { kind: 'invalid', wrong: true }
    if (!match.live) return { kind: 'invalid', wrong: false }
    if (match.subjectId === fromId) return { kind: 'same' }

    const rows = await lockSubjects(tx, [match.subjectId, fromId])
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
    if (!held || !into) return { kind: 'invalid', wrong: false }
    if (!from) return { kind: 'busy' }
    if (into.kind !== from.kind) return { kind: 'kind' }
    if (linkedToOthers([from], into.accountId)) {
      return { kind: 'linked', issuerLinked: into.accountId !== null }
    }
    const approver =
      into.accountId !== null && from.accountId !== into.accountId ? into.accountId : null

    const previewed = held.previewedBy.includes(from.id)
    if (!confirm || !previewed) {
      if (!previewed && held.previewedBy.length < PREVIEWERS) {
        await tx
          .update(subjectBindCodes)
          .set({ previewedBy: [...held.previewedBy, from.id] })
          .where(eq(subjectBindCodes.id, held.id))
      }
      const [identity] = await tx
        .select({ displayName: subjectIdentities.displayName })
        .from(subjectIdentities)
        .where(
          and(
            eq(subjectIdentities.platform, held.platform),
            eq(subjectIdentities.kind, 'person'),
            eq(subjectIdentities.externalId, held.externalId),
          ),
        )
      return {
        kind: 'preview',
        target: {
          platform: held.platform,
          displayName: identity?.displayName ?? null,
          accountHint: maskAccount(held.externalId),
        },
        needsApproval: approver !== null,
      }
    }

    await tx
      .update(subjectBindCodes)
      .set({ usedAt: sql`now()` })
      .where(eq(subjectBindCodes.id, held.id))
    const record = {
      circleId: key.circleId,
      clientId: key.client.id,
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
    if (approver === null) {
      await tx
        .insert(subjectBindings)
        .values({ ...record, status: 'merged', decidedAt: sql`now()` })
      return { kind: 'merged', outcome: await mergeSubjects(tx, from, into) }
    }

    const [waiting] = await tx
      .select({ expiresAt: subjectBindings.expiresAt })
      .from(subjectBindings)
      .where(
        and(
          eq(subjectBindings.subjectId, into.id),
          eq(subjectBindings.fromSubjectId, from.id),
          eq(subjectBindings.accountId, approver),
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
        accountId: approver,
        expiresAt: sql`now() + make_interval(days => ${PENDING_TTL_DAYS})`,
      })
      .returning({ expiresAt: subjectBindings.expiresAt })
    return { kind: 'pending', expiresAt: created!.expiresAt! }
  })
}

export async function voidCode(
  db: Db,
  master: MasterKey | null,
  key: KeyPrincipal,
  code: string,
): Promise<void> {
  const hash = hashCode(master, key.client.id, code)
  await withCircle(db, key.circleId, async (tx) => {
    const match = matchCode(await clientCodes(tx, key.client.id), hash)
    if (match?.live) {
      await tx
        .update(subjectBindCodes)
        .set({ expiresAt: sql`now()` })
        .where(and(eq(subjectBindCodes.id, match.id), gt(subjectBindCodes.expiresAt, sql`now()`)))
    }
  })
}

// ---- 管理界面里确认、拒绝 ----

export type DecideResult =
  | { ok: true; subjectId: string; outcome: MergeOutcome | null }
  | { ok: false; status: 403 | 404 | 409; error: string }

const ONLY_CONFIRMER = '仅此联系人标记的成员本人可处理此次绑定'

type BindingRow = typeof subjectBindings.$inferSelect

function closedReason(binding: BindingRow, live: boolean): string | null {
  switch (binding.status) {
    case 'pending':
      return live ? null : '已过确认期限，此次绑定已作废'
    case 'merged':
    case 'confirmed':
      return '已合并'
    case 'rejected':
      return '已拒绝'
    case 'cancelled':
      return `此次绑定已作废：${binding.note ?? '情况已变化'}`
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

async function cancel(tx: Tx, id: string, note: string) {
  await tx
    .update(subjectBindings)
    .set({ status: 'cancelled', decidedAt: sql`now()`, note })
    .where(eq(subjectBindings.id, id))
  return { ok: false as const, status: 409 as const, error: `${note}，此次绑定已作废` }
}

export async function confirmBinding(
  db: Db,
  circleId: string,
  bindingId: string,
  me: string,
  role: MemberRole,
): Promise<DecideResult> {
  return withCircle(db, circleId, async (tx) => {
    const [seen] = await tx.select().from(subjectBindings).where(eq(subjectBindings.id, bindingId))
    if (!seen) return { ok: false, status: 404, error: '此次绑定不存在' }
    if (seen.accountId !== me) return { ok: false, status: 403, error: ONLY_CONFIRMER }
    if (role === 'viewer') return { ok: false, status: 403, error: '需要记忆圈所有者或编辑者角色' }
    const rows = await lockSubjects(tx, [seen.subjectId, seen.fromSubjectId])
    const held = await lockBinding(tx, bindingId)
    if (!held) return { ok: false, status: 404, error: '此次绑定不存在' }
    const { binding } = held
    const closed = closedReason(binding, held.live)
    if (closed) return { ok: false, status: 409, error: closed }
    const into = rows.find((r) => r.id === binding.subjectId)
    const from = rows.find((r) => r.id === binding.fromSubjectId)
    if (!into || !from || into.id === from.id) return cancel(tx, binding.id, '联系人已不存在')
    if (into.kind !== from.kind) return cancel(tx, binding.id, '两边不是同一类型的联系人')
    if (into.accountId !== me) return cancel(tx, binding.id, '此联系人的成员标记已变更')
    if (linkedToOthers([from], me)) {
      return cancel(tx, binding.id, '要并入的联系人已标记为其他成员')
    }
    await tx
      .update(subjectBindings)
      .set({ status: 'confirmed', decidedAt: sql`now()`, decidedBy: me })
      .where(eq(subjectBindings.id, binding.id))
    return { ok: true, subjectId: into.id, outcome: await mergeSubjects(tx, from, into) }
  })
}

export async function rejectBinding(
  db: Db,
  circleId: string,
  bindingId: string,
  me: string,
): Promise<DecideResult> {
  return withCircle(db, circleId, async (tx) => {
    const held = await lockBinding(tx, bindingId)
    if (!held) return { ok: false, status: 404, error: '此次绑定不存在' }
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
      clientName: clients.name,
      confirmerName: confirmer.displayName,
      deciderName: decider.displayName,
    })
    .from(subjectBindings)
    .innerJoin(target, eq(target.id, subjectBindings.subjectId))
    .innerJoin(clients, eq(clients.id, subjectBindings.clientId))
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
      client: { id: b.clientId, name: r.clientName },
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
      canConfirm: canReject && viewer.role !== 'viewer' && r.subjectAccountId === viewer.accountId,
    }
  })
}

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

const pendingFor = (viewer: BindingViewer) =>
  and(
    eq(subjectBindings.accountId, viewer.accountId),
    eq(subjectBindings.status, 'pending'),
    gt(subjectBindings.expiresAt, sql`now()`),
    eq(target.accountId, viewer.accountId),
  )!

export function pendingBindingsFor(
  tx: Tx,
  viewer: BindingViewer,
  limit: number,
): Promise<SubjectBinding[]> {
  return bindingViews(tx, pendingFor(viewer), viewer, limit)
}

export async function pendingBindingCount(tx: Tx, viewer: BindingViewer): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(subjectBindings)
    .innerJoin(target, eq(target.id, subjectBindings.subjectId))
    .where(pendingFor(viewer))
  return row?.n ?? 0
}
