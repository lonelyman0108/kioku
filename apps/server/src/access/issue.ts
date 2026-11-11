import type { KeyScopes, MemberRole } from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'

import { generateApiKey } from '../auth/keys'
import type { Tx } from '../db/client'
import { accounts, apiKeys, apps, spaceMembers } from '../db/schema'

// 签发 Key 的规则，管理界面的签发与浏览器授权共用，只写这一份

// 这个角色不能签发这样的 Key 时返回原因，可以时为 null。
// viewer 不能签发；admin、secret 级与凭据能力只有空间 owner 能给：
// editor 签发的 Key 仍能读写应用所有者（也就是 editor 自己）的本人记忆，以及 secret 以下的共享内容
export function issueDenial(role: MemberRole | null, scopes: KeyScopes): string | null {
  if (role !== 'owner' && role !== 'editor') return '需要空间所有者或编辑者角色'
  if (
    role !== 'owner' &&
    (scopes.admin || scopes.maxSensitivity === 'secret' || scopes.credentials !== 'none')
  ) {
    return '仅空间所有者可签发「跨人格 / 应用写入」、机密级或可使用凭据的访问密钥'
  }
  return null
}

// 应用的所有者；lock 为 true 时锁住应用这一行直到事务结束：签发 Key 与转移所有权都先拿这把锁，
// 保证「检查所有者 → 写 Key」与「吊销 Key → 换所有者」不会交错，转移之后不会冒出前任所有者的新 Key
export async function appOwnerOf(tx: Tx, appId: string, lock = false): Promise<string | null> {
  const query = tx.select({ owner: apps.ownerAccountId }).from(apps).where(eq(apps.id, appId))
  const [row] = lock ? await query.for('update') : await query
  return row?.owner ?? null
}

// 账号现在在空间里的角色、加入时间与停用时间；不在空间里时为 undefined。Key 的当前有效上限按它算
export async function membershipOf(tx: Tx, spaceId: string, accountId: string) {
  const [row] = await tx
    .select({
      role: spaceMembers.role,
      memberSince: spaceMembers.createdAt,
      disabledAt: accounts.disabledAt,
    })
    .from(spaceMembers)
    .innerJoin(accounts, eq(accounts.id, spaceMembers.accountId))
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, accountId)))
    .limit(1)
  return row
}

export type IssuedKey =
  | { ok: true; row: typeof apiKeys.$inferSelect; plaintext: string }
  | { ok: false; reason: 'missing' | 'not-owner' }

// 在 withSpace 的事务里给应用签发一个 Key：只有应用的所有者能签。明文只在返回值里，库里只有哈希
export async function issueAppKey(
  tx: Tx,
  input: { spaceId: string; appId: string; accountId: string; name: string; scopes: KeyScopes },
): Promise<IssuedKey> {
  const owner = await appOwnerOf(tx, input.appId, true)
  if (!owner) return { ok: false, reason: 'missing' }
  if (owner !== input.accountId) return { ok: false, reason: 'not-owner' }
  const generated = generateApiKey()
  const [row] = await tx
    .insert(apiKeys)
    .values({
      spaceId: input.spaceId,
      appId: input.appId,
      name: input.name,
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      scopes: input.scopes,
    })
    .returning()
  return { ok: true, row: row!, plaintext: generated.plaintext }
}
