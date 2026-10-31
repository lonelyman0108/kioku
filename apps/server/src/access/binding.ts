import { createHash, createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto'

import type { BindingStatus, MemberRole, SubjectBinding } from '@kioku/contracts'
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { keyringOf, type MasterKey } from '../crypto/keyring'
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
// 把那个平台账号的对象并进申请的对象。规则同合并对象（同种类、标记的限制）。
// 收码的人先看到要并到谁那里，再确认一次才合并；申请的对象标记了成员（收码的对象没标记成同一个成员）时，
// 还要那个成员本人在管理界面确认

// 8 位，字符集去掉了容易看混的 0、O、1、I、L；10 分钟有效，只能用一次
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_FORMAT = new RegExp(`^[${CODE_ALPHABET}]{8}$`)
export const CODE_TTL_SECONDS = 600
// 等成员确认的绑定这么多天内有效
export const PENDING_TTL_DAYS = 7
// 一个码最多记这么多个预览过的收码对象。记满了就不再记新的，已经记下的不会被挤掉：
// 拿到码的人换着账号预览，挤不走真正的用户；预览本身受码的 10 分钟有效期限制
export const PREVIEWERS = 1000
// 输错上限，一小时一个窗口：同一个收码的平台账号 5 次；同一个应用合计 1000 次，挡住换着账号猜。
// 应用的上限放得宽，几十个小号也挡不住别人正常绑定：码有 31^8（约 8.5×10^11）种、只活 10 分钟，
// 照每小时 1000 次猜，一个码活着的 10 分钟里最多被猜约 170 次，猜中的概率约 2×10^-10，可以忽略
export const ATTEMPT_WINDOW_SECONDS = 3600
export const ACCOUNT_ATTEMPTS = 5
export const APP_ATTEMPTS = 1000
// 在群里作废公开了的码：结果总是一样，探不出码，所以不占上面的输错名额，只按发言人限制请求的次数
export const VOID_REQUESTS = 30

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

// 算码的 HMAC 用的密钥：从当前的主密钥派生，用途标签写明是绑定码，和备份等别的用途分开。
// 派生出的密钥按主密钥的 Buffer 缓存，不用每次用码都重跑 HKDF；换了主密钥就是另一个键
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

// 库里只存哈希，带上应用：码只在同一个应用里用得了。配了主密钥时算 HMAC，密钥从主密钥派生：
// 读得到库、拿不到主密钥的人，没法在码的 10 分钟有效期里把它暴力算出来。没配主密钥时只能用不带密钥的 SHA-256，
// 这种情况更弱：码只有 31^8 种，读得到库的人用 GPU 几分钟就能算出来。换了主密钥之后之前申请的码对不上，重新申请就行
export function hashCode(master: MasterKey | null, appId: string, code: string): string {
  const input = `kioku-bind-code\u0000${appId}\u0000${code}`
  return master
    ? createHmac('sha256', codeKey(master)).update(input).digest('hex')
    : createHash('sha256').update(input).digest('hex')
}

// 平台账号只露出头尾几位，露出的不超过三分之一，开头多露一位：码落到别人手里也不把账号给出去。
// 收码的人主要靠平台上的名字认出是不是自己的另一个账号，露出的几位只是帮着核对
export function maskAccount(id: string): string {
  const chars = [...id]
  const shown = Math.floor(chars.length / 3)
  const head = Math.ceil(shown / 2)
  const tail = shown - head
  return `${chars.slice(0, head).join('')}***${tail ? chars.slice(-tail).join('') : ''}`
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
const voidKey = (platform: string, externalId: string) =>
  JSON.stringify(['void', platform, externalId])

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
  // 哪一级超了：这个平台账号输错的次数、整个应用输错的次数，或者这个平台账号作废码的请求次数
  scope: 'account' | 'app' | 'void'
  // 多久之后能再试
  waitSeconds: number
}

// 核对绑定码之前先占一次名额，超限时返回哪一级超了；只有码不对时这次才算输错，别的结果由调用方退回（refundAttempt）。
// 和登录的失败计数一样逐级计数：这个账号已经超限就停下，不再推高整个应用的计数（否则一个被挡住的账号还能把整个应用的名额耗光）；
// 被应用的上限挡下时退回这个账号的这一次。在一个事务里按「这个账号 → 整个应用」的顺序锁计数行，
// 同一个账号的并发请求排队，不会互相等成死锁。只看发来的平台账号，不建对象：超限的请求不解析会话
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

// 码是对的，只是预览、绑成了或者因为别的原因没绑成：退回这一次占的名额，两级各减一。
// 只退这一次，之前输错的不清：否则拿一个自己的码反复预览，就能把输错的次数清零、接着猜别人的码
export async function refundAttempt(
  db: Db,
  key: KeyPrincipal,
  platform: string,
  externalId: string,
): Promise<void> {
  await withSpace(db, key.spaceId, async (tx) => {
    await bump(tx, key, accountKey(platform, externalId), -1)
    await bump(tx, key, APP_KEY, -1)
  })
}

// 在群里作废码的请求先占一次名额，按发言人计、不退：作废的结果总是一样，探不出码，所以不碰输错的名额，
// 只限制请求的次数，免得在群里刷命令
export async function reserveVoid(
  db: Db,
  key: KeyPrincipal,
  platform: string,
  externalId: string,
): Promise<AttemptLimit | null> {
  return withSpace(db, key.spaceId, async (tx) => {
    const row = await bump(tx, key, voidKey(platform, externalId), 1)
    return row.count > VOID_REQUESTS ? { scope: 'void', waitSeconds: row.waitSeconds } : null
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

// 申请绑定码：锁住发码的对象（同一个对象同时申请两次时排队），让它之前还有效的码马上过期（旧码作废），换一个新的。
// 旧码留到每小时的清理再删：有人发来旧码时认得出是作废了的码，不算输错。
// 码在同一个应用里不重复，撞上了（概率极小）就重新生成。发言人的对象在解析之后刚好被合并掉时返回 null
export async function issueCode(
  db: Db,
  master: MasterKey | null,
  key: KeyPrincipal,
  session: KeySession,
  platform: string,
  externalId: string,
): Promise<{ code: string; expiresAt: Date } | null> {
  const subjectId = session.context.senderSubjectId!
  return withSpace(db, key.spaceId, async (tx) => {
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
          spaceId: key.spaceId,
          appId: key.app.id,
          keyId: key.keyId,
          subjectId,
          platform,
          externalId,
          codeHash: hashCode(master, key.app.id, code),
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
  // 码是对的，还没合并：告诉收码的人要并到谁那里；needsApproval 时确认之后还要那边标记的成员同意
  | { kind: 'preview'; target: BindTarget; needsApproval: boolean }
  | { kind: 'merged'; outcome: MergeOutcome }
  | { kind: 'pending'; expiresAt: Date }
  // 码不对、过期了、用过了、作废了或被新码换掉了，或是别的应用的：一律这样说，不透露是哪种。
  // wrong：对不上任何一条记录，算一次输错；对得上、只是已经失效的不算
  | { kind: 'invalid'; wrong: boolean }
  // 收码的就是发码的对象（同一个账号，或者已经并在一起）
  | { kind: 'same' }
  // 收码的对象标记成了别的成员；issuerLinked：发码的对象也标记了成员（两边是不同的成员）
  | { kind: 'linked'; issuerLinked: boolean }
  // 不是同种类（都在私聊里认出来的，按理都是人）
  | { kind: 'kind' }
  // 收码的对象在解析之后刚好被合并掉了，再试一次就行
  | { kind: 'busy' }

// 这个应用还留着的码，连同现在还能不能用：用过、过期与作废的留到每小时的清理才删，对得上它们的不算输错。
// 只认这个应用的，别的空间的码在 RLS 之外，根本读不到
function appCodes(tx: Tx, appId: string) {
  return tx
    .select({
      id: subjectBindCodes.id,
      subjectId: subjectBindCodes.subjectId,
      codeHash: subjectBindCodes.codeHash,
      live: sql<boolean>`${subjectBindCodes.usedAt} is null and ${subjectBindCodes.expiresAt} > now()`,
    })
    .from(subjectBindCodes)
    .where(eq(subjectBindCodes.appId, appId))
}

// 使用绑定码，全部检查与合并在一个事务里。session 是收码的这次私聊。
// 不带 confirm、或者这个收码的对象还没预览过这个码时只预览：记下是谁预览的，码不用掉。
// 预览过的对象带上 confirm 再来才用掉码、合并（或等那边标记的成员确认）
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
  const hash = hashCode(master, key.app.id, code)
  return withSpace(db, key.spaceId, async (tx) => {
    const match = matchCode(await appCodes(tx, key.app.id), hash)
    if (!match) return { kind: 'invalid', wrong: true }
    if (!match.live) return { kind: 'invalid', wrong: false }
    if (match.subjectId === fromId) return { kind: 'same' }
    // 先按 id 的顺序锁住两个对象，再锁码：和合并对象的加锁顺序一致（合并删掉对象时连带删它的码）
    const rows = await lockSubjects(tx, [match.subjectId, fromId])
    // 锁住之后再核对一次：等锁期间码可能被别人用掉、作废、被新码换掉，或者随发码的对象被合并掉而删了
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
    // 收码的对象只能是没标记的，或者和发码的对象标记成同一个成员：否则这个平台账号会被挂到别人的标记下
    if (linkedToOthers([from], into.accountId)) {
      return { kind: 'linked', issuerLinked: into.accountId !== null }
    }
    // 发码的对象标记了成员、收码的对象没标记成同一个成员时，要那个成员本人确认：这个对象的私聊算那个成员的主人私聊，
    // 码泄露了别人就能把自己的账号挂过来。两边标记成同一个成员时不用：只有本人能把对象标记成自己，别人冒充不了
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
    if (approver === null) {
      await tx
        .insert(subjectBindings)
        .values({ ...record, status: 'merged', decidedAt: sql`now()` })
      return { kind: 'merged', outcome: await mergeSubjects(tx, from, into) }
    }
    // 同一对对象已经有一条在等同一个成员的，沿用那一条
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

// 群里发出来的码大家都看得到：作废它（让它马上过期），不合并。码不对、已经用过、过期或者已经作废时什么也不做，
// 调用方不管哪种都给同样的结果，不透露码存不存在
export async function voidCode(
  db: Db,
  master: MasterKey | null,
  key: KeyPrincipal,
  code: string,
): Promise<void> {
  const hash = hashCode(master, key.app.id, code)
  await withSpace(db, key.spaceId, async (tx) => {
    const match = matchCode(await appCodes(tx, key.app.id), hash)
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

// 等查看者本人确认的：还没到期限、发码的对象现在仍标记成他
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

// 上面那个列表一共多少条（待处理总数用）
export async function pendingBindingCount(tx: Tx, viewer: BindingViewer): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(subjectBindings)
    .innerJoin(target, eq(target.id, subjectBindings.subjectId))
    .where(pendingFor(viewer))
  return row?.n ?? 0
}
