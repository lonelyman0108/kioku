import type { MasterKeyStatus } from '@kioku/contracts'
import { and, asc, count, eq, gt, isNotNull, isNull, notInArray } from 'drizzle-orm'

import { credentialAad } from '../credential/service'
import { withSpace, type Db } from '../db/client'
import { credentials, memories, spaces } from '../db/schema'
import { mapEmbeddingKeys, sealedEmbeddingKeys } from '../embedding/settings'
import { EXTRACTION_ENDPOINT, sealedExtractionKey } from '../extraction/settings'
import { mapEndpointKey, type SealedJson } from '../settings/endpoint'
import { canUnwrap, rewrapKey, type Sealed } from './envelope'
import { keyIdOf, keyringOf, type Keyring, type MasterKey } from './keyring'

// 主密钥的准备与轮换。加密的数据有三处：secret 记忆、托管的凭据值、实例设置里的接口 Key，
// 都是信封加密：正文用各自的数据密钥加密，数据密钥再由主密钥包装，旁边记着主密钥的标识。
// 轮换只换数据密钥的包装，正文的密文不动

// 记忆与凭据：加密的行、aad 怎么算。查询都带上 wrapped_key 不为空：key_id 的索引只建在加密的行上
const TABLES = [
  { label: 'secret 记忆', table: memories, aad: (id: string) => id },
  { label: '托管的凭据', table: credentials, aad: credentialAad },
] as const

// 一批处理多少行：每批一个短事务
const BATCH = 100

// 实例设置里加密保存的接口 Key，只读不解密。新加了加密的设置项要加在这里，轮换、启动检查与核对主密钥都按它
export async function sealedSettingsKeys(
  db: Db,
): Promise<{ sealed: Sealed; aad: string; keyId: string | null; label: string }[]> {
  const extraction = await sealedExtractionKey(db)
  return [
    ...(await sealedEmbeddingKeys(db)).map((k) => ({ ...k, label: '嵌入接口' })),
    ...(extraction ? [{ ...extraction, label: EXTRACTION_ENDPOINT.label }] : []),
  ]
}

// 同上，逐个改写：change 原样返回就不写回
async function mapSettingsKeys(
  db: Db,
  change: (sealed: SealedJson, aad: string) => SealedJson,
): Promise<number> {
  return (
    (await mapEmbeddingKeys(db, change)) + (await mapEndpointKey(db, EXTRACTION_ENDPOINT, change))
  )
}

const knownIds = (ring: Keyring) =>
  [ring.current, ring.previous].flatMap((k) => (k ? [keyIdOf(k)] : []))

// 没记标识的记录（加上标识之前写下的）是哪把主密钥包装的：当前的与旧的挨个试，认不出时返回 null
function identify(ring: Keyring, wrappedKey: Buffer, aad: string): string | null {
  const key = [ring.current, ring.previous].find((k) => k && canUnwrap(k, wrappedKey, aad))
  return key ? keyIdOf(key) : null
}

// 启动时调用：给还没记标识的加密记录补上标识，并确认每一条都解得开。有认不出的（主密钥配错了，
// 或者轮换没换完就去掉了旧的那把），或者库里有加密的数据却没配主密钥时，拒绝启动：带病启动只会让这些数据都读不出来，
// 新写下的又用了另一把，越来越乱。标识对不上的只数一数；没记标识的一批批认，不把加密的行一次全读进内存
export async function prepareMasterKey(db: Db, masterKey: MasterKey | null): Promise<void> {
  const ring = masterKey ? keyringOf(masterKey) : null
  const known = ring ? knownIds(ring) : []
  const problems = new Map<string, number>()
  const problem = (label: string, n = 1) => {
    if (n) problems.set(label, (problems.get(label) ?? 0) + n)
  }

  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    for (const { label, table, aad } of TABLES) {
      const encrypted = isNotNull(table.wrappedKey)
      const [unknown] = await withSpace(db, spaceId, (tx) =>
        tx
          .select({ n: count() })
          .from(table)
          .where(
            ring
              ? and(encrypted, isNotNull(table.keyId), notInArray(table.keyId, known))
              : encrypted,
          ),
      )
      problem(label, unknown?.n ?? 0)
      if (!ring) continue
      let after: string | null = null
      for (;;) {
        const cursor: string | null = after
        const rows: { id: string }[] = await withSpace(db, spaceId, async (tx) => {
          const legacy = await tx
            .select({ id: table.id, wrappedKey: table.wrappedKey })
            .from(table)
            .where(and(encrypted, isNull(table.keyId), cursor ? gt(table.id, cursor) : undefined))
            .orderBy(asc(table.id))
            .limit(BATCH)
          for (const row of legacy) {
            const id = identify(ring, row.wrappedKey!, aad(row.id))
            if (!id) problem(label)
            else await tx.update(table).set({ keyId: id }).where(eq(table.id, row.id))
          }
          return legacy
        })
        if (rows.length < BATCH) break
        after = rows[rows.length - 1]!.id
      }
    }
  }
  const settingsLabel = '实例设置里的接口 Key'
  if (!ring) {
    problem(settingsLabel, (await sealedSettingsKeys(db)).length)
  } else {
    await mapSettingsKeys(db, (sealed, aad) => {
      if (sealed.keyId) {
        if (!known.includes(sealed.keyId)) problem(settingsLabel)
        return sealed
      }
      const id = identify(ring, Buffer.from(sealed.wrappedKey, 'base64'), aad)
      if (!id) {
        problem(settingsLabel)
        return sealed
      }
      return { ...sealed, keyId: id }
    })
  }

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
            .where(and(isNotNull(table.wrappedKey), eq(table.keyId, previousId)))
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
          wrappedKey: rewrapKey(
            previous,
            current,
            Buffer.from(sealed.wrappedKey, 'base64'),
            aad,
          ).toString('base64'),
          keyId: currentId,
        }
      : sealed,
  )
  const { remaining } = await masterKeyStatus(db, masterKey)
  return { rewrapped, remaining: remaining.memories + remaining.credentials + remaining.settings }
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
        for (const [field, { table }] of [
          ['memories', TABLES[0]],
          ['credentials', TABLES[1]],
        ] as const) {
          const [row] = await tx
            .select({ n: count() })
            .from(table)
            .where(and(isNotNull(table.wrappedKey), eq(table.keyId, previousId)))
          remaining[field] += row?.n ?? 0
        }
      })
    }
    remaining.settings = (await sealedSettingsKeys(db)).filter((k) => k.keyId === previousId).length
  }
  return {
    configured: ring !== null,
    currentId: ring ? keyIdOf(ring.current) : null,
    previousId,
    remaining,
  }
}
