import { and, count, eq, isNotNull, isNull, notInArray, or } from 'drizzle-orm'

import { credentialAad } from '../credential/service'
import { withSpace, type Db } from '../db/client'
import { credentials, memories, spaces } from '../db/schema'
import { mapEmbeddingKeys, sealedEmbeddingKeys } from '../embedding/settings'
import { EXTRACTION_ENDPOINT } from '../extraction/settings'
import { mapEndpointKey, sealedEndpointKey, type SealedJson } from '../settings/endpoint'
import { canUnwrap, rewrapKey } from './envelope'
import { keyIdOf, keyringOf, type Keyring, type MasterKey } from './keyring'

// 主密钥的准备与轮换。加密的数据有三处：secret 记忆、托管的凭据值、实例设置里的接口 Key，
// 都是信封加密：正文用各自的数据密钥加密，数据密钥再由主密钥包装，旁边记着主密钥的标识。
// 轮换只换数据密钥的包装，正文的密文不动

// 记忆与凭据：加密的行、aad 怎么算
const TABLES = [
  { label: 'secret 记忆', table: memories, aad: (id: string) => id },
  { label: '托管的凭据', table: credentials, aad: credentialAad },
] as const

// 一批重新包装多少行：每批一个短事务
const BATCH = 100

// 一条加密记录是哪把主密钥包装的：记了标识的按标识认；没记的（加上标识之前写下的）挨个试当前的与旧的。认不出时返回 null
function identify(
  ring: Keyring,
  wrappedKey: Buffer,
  aad: string,
  keyId: string | null | undefined,
): string | null {
  const known = [ring.current, ring.previous].flatMap((k) => (k ? [k] : []))
  if (keyId) return known.some((k) => keyIdOf(k) === keyId) ? keyId : null
  const key = known.find((k) => canUnwrap(k, wrappedKey, aad))
  return key ? keyIdOf(key) : null
}

const toBuffer = (base64: string) => Buffer.from(base64, 'base64')

// 实例设置里加密保存的接口 Key（嵌入渠道与抽取模型）逐个改写
async function mapSettingsKeys(
  db: Db,
  change: (sealed: SealedJson, aad: string) => SealedJson,
): Promise<number> {
  return (
    (await mapEmbeddingKeys(db, change)) + (await mapEndpointKey(db, EXTRACTION_ENDPOINT, change))
  )
}

// 启动时调用：给还没记标识的加密记录补上标识，并确认每一条都解得开。有认不出的（主密钥配错了，
// 或者轮换没换完就去掉了旧的那把），或者库里有加密的数据却没配主密钥时，拒绝启动：带病启动只会让这些数据都读不出来，
// 新写下的又用了另一把，越来越乱
export async function prepareMasterKey(db: Db, masterKey: MasterKey | null): Promise<void> {
  const ring = masterKey ? keyringOf(masterKey) : null
  const known = ring ? [ring.current, ring.previous].flatMap((k) => (k ? [keyIdOf(k)] : [])) : []
  const problems = new Map<string, number>()
  const problem = (label: string) => problems.set(label, (problems.get(label) ?? 0) + 1)

  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    await withSpace(db, spaceId, async (tx) => {
      for (const { label, table, aad } of TABLES) {
        // 只看没记标识的与标识对不上的；正常情况下一行都没有
        const rows = await tx
          .select({ id: table.id, wrappedKey: table.wrappedKey, keyId: table.keyId })
          .from(table)
          .where(
            and(
              isNotNull(table.wrappedKey),
              known.length ? or(isNull(table.keyId), notInArray(table.keyId, known)) : undefined,
            ),
          )
        for (const row of rows) {
          const id = ring && identify(ring, row.wrappedKey!, aad(row.id), row.keyId)
          if (!id) problem(label)
          else if (!row.keyId) await tx.update(table).set({ keyId: id }).where(eq(table.id, row.id))
        }
      }
    })
  }
  await mapSettingsKeys(db, (sealed, aad) => {
    const id = ring && identify(ring, toBuffer(sealed.wrappedKey), aad, sealed.keyId)
    if (!id) {
      problem('实例设置里的接口 Key')
      return sealed
    }
    return sealed.keyId ? sealed : { ...sealed, keyId: id }
  })

  if (problems.size) {
    const what = [...problems].map(([label, n]) => `${label} ${n} 条`).join('、')
    throw new Error(
      ring
        ? `主密钥对不上：${what}解不开。检查 KIOKU_MASTER_KEY；轮换主密钥期间，旧的那把要配在 KIOKU_MASTER_KEY_PREVIOUS，等实例设置里显示换完再去掉`
        : `库里有加密的数据（${what}），但没有配置 KIOKU_MASTER_KEY`,
    )
  }
}

// 把还是旧主密钥包装的数据密钥换成新的包装：逐个空间、一批一个短事务，正被别的事务锁着的行跳过（之后再来），
// 已删除、已过期的也换；最后是实例设置里的接口 Key。返回这次换了多少条、还剩多少条
export async function rotateMasterKey(
  db: Db,
  masterKey: MasterKey,
): Promise<{ rewrapped: number; remaining: number }> {
  const { current, previous } = keyringOf(masterKey)
  if (!previous) return { rewrapped: 0, remaining: 0 }
  const currentId = keyIdOf(current)
  const previousId = keyIdOf(previous)
  let rewrapped = 0
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    for (const { table, aad } of TABLES) {
      for (;;) {
        const done = await withSpace(db, spaceId, async (tx) => {
          const rows = await tx
            .select({ id: table.id, wrappedKey: table.wrappedKey })
            .from(table)
            .where(eq(table.keyId, previousId))
            .limit(BATCH)
            .for('update', { skipLocked: true })
          for (const row of rows) {
            const wrappedKey = rewrapKey(previous, current, row.wrappedKey!, aad(row.id))
            await tx.update(table).set({ wrappedKey, keyId: currentId }).where(eq(table.id, row.id))
          }
          return rows.length
        })
        rewrapped += done
        if (done < BATCH) break
      }
    }
  }
  rewrapped += await mapSettingsKeys(db, (sealed, aad) =>
    sealed.keyId === previousId
      ? {
          ...sealed,
          wrappedKey: rewrapKey(previous, current, toBuffer(sealed.wrappedKey), aad).toString(
            'base64',
          ),
          keyId: currentId,
        }
      : sealed,
  )
  const status = await masterKeyStatus(db, masterKey)
  const remaining =
    status.remaining.memories + status.remaining.credentials + status.remaining.settings
  return { rewrapped, remaining }
}

export interface MasterKeyStatus {
  configured: boolean
  currentId: string | null
  previousId: string | null
  // 还是旧主密钥包装的：换完之后就可以去掉 KIOKU_MASTER_KEY_PREVIOUS
  remaining: { memories: number; credentials: number; settings: number }
}

export async function masterKeyStatus(
  db: Db,
  masterKey: MasterKey | null,
): Promise<MasterKeyStatus> {
  const ring = masterKey ? keyringOf(masterKey) : null
  const previousId = ring?.previous ? keyIdOf(ring.previous) : null
  const remaining = { memories: 0, credentials: 0, settings: 0 }
  if (previousId) {
    for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
      await withSpace(db, spaceId, async (tx) => {
        const [m] = await tx
          .select({ n: count() })
          .from(memories)
          .where(eq(memories.keyId, previousId))
        const [c] = await tx
          .select({ n: count() })
          .from(credentials)
          .where(eq(credentials.keyId, previousId))
        remaining.memories += m?.n ?? 0
        remaining.credentials += c?.n ?? 0
      })
    }
    const extraction = await sealedEndpointKey(db, EXTRACTION_ENDPOINT)
    const settingsKeys = [...(await sealedEmbeddingKeys(db)), ...(extraction ? [extraction] : [])]
    remaining.settings = settingsKeys.filter((k) => k.keyId === previousId).length
  }
  return {
    configured: ring !== null,
    currentId: ring ? keyIdOf(ring.current) : null,
    previousId,
    remaining,
  }
}
