import type { MasterKeyStatus } from '@kioku/contracts'
import { and, asc, count, eq, gt, isNotNull, isNull, notInArray, sql } from 'drizzle-orm'

import { BACKUP_LABEL, mapBackupKey, sealedBackupKey } from '../backup/settings'
import { credentialAad } from '../credential/service'
import { withSpace, type Db } from '../db/client'
import { credentials, memories, settings, spaces } from '../db/schema'
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
  { field: 'memories', label: 'secret 记忆', table: memories, aad: (id: string) => id },
  { field: 'credentials', label: '托管的凭据', table: credentials, aad: credentialAad },
] as const

// 实例设置里加密保存的接口 Key：怎么读出（不解密）、怎么逐个改写（change 原样返回就不写回）。
// 新加了加密的设置项只要加在这里，启动检查、轮换、状态与导入工具核对主密钥都按它
type SealedSetting = { sealed: Sealed; aad: string; keyId: string | null }
type Change = (sealed: SealedJson, aad: string) => SealedJson
const SETTINGS: {
  label: string
  read: (db: Db) => Promise<SealedSetting[]>
  map: (db: Db, change: Change) => Promise<number>
}[] = [
  { label: '嵌入接口', read: sealedEmbeddingKeys, map: mapEmbeddingKeys },
  {
    label: EXTRACTION_ENDPOINT.label,
    read: async (db) => {
      const key = await sealedExtractionKey(db)
      return key ? [key] : []
    },
    map: (db, change) => mapEndpointKey(db, EXTRACTION_ENDPOINT, change),
  },
  {
    label: BACKUP_LABEL,
    read: async (db) => {
      const key = await sealedBackupKey(db)
      return key ? [key] : []
    },
    map: mapBackupKey,
  },
]

export async function sealedSettingsKeys(db: Db): Promise<(SealedSetting & { label: string })[]> {
  const lists = await Promise.all(
    SETTINGS.map(async (s) => (await s.read(db)).map((k) => ({ ...k, label: s.label }))),
  )
  return lists.flat()
}

async function mapSettingsKeys(db: Db, change: Change): Promise<number> {
  let changed = 0
  for (const s of SETTINGS) changed += await s.map(db, change)
  return changed
}

// 一批处理多少行：每批一个短事务
const BATCH = 100

const knownIds = (ring: Keyring) =>
  [ring.current, ring.previous].flatMap((k) => (k ? [keyIdOf(k)] : []))

// 没记标识的记录（加上标识之前写下的）是哪把主密钥包装的：当前的与旧的挨个试，认不出时返回 null
function identify(ring: Keyring, wrappedKey: Buffer, aad: string): string | null {
  const key = [ring.current, ring.previous].find((k) => k && canUnwrap(k, wrappedKey, aad))
  return key ? keyIdOf(key) : null
}

// 启动时调用：给还没记标识的加密记录补上标识，并确认每一条都解得开。有认不出的（主密钥配错了，
// 或者轮换没换完就去掉了旧的那把），或者库里有加密的数据却没配主密钥时，拒绝启动：带病启动只会让这些数据都读不出来，
// 新写下的又用了另一把，越来越乱。每个空间先在一个事务里数：标识对不上的只数一数；有没记标识的才一批批认，
// 不把加密的行一次全读进内存
export async function prepareMasterKey(db: Db, masterKey: MasterKey | null): Promise<void> {
  await inspectMasterKey(db, masterKey, true)
}

// 按启动检查的规则核对主密钥，但不补标识、不写库：服务运行时命令行工具（例如备份）用
export async function checkMasterKey(db: Db, masterKey: MasterKey | null): Promise<void> {
  await inspectMasterKey(db, masterKey, false)
}

async function inspectMasterKey(db: Db, masterKey: MasterKey | null, fill: boolean): Promise<void> {
  const ring = masterKey ? keyringOf(masterKey) : null
  const known = ring ? knownIds(ring) : []
  const problems = new Map<string, number>()
  const problem = (label: string, n = 1) => {
    if (n) problems.set(label, (problems.get(label) ?? 0) + n)
  }

  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    const counts = await withSpace(db, spaceId, async (tx) => {
      const result = []
      for (const t of TABLES) {
        const encrypted = isNotNull(t.table.wrappedKey)
        const [row] = await tx
          .select({
            unknown: ring
              ? sql<number>`count(*) filter (where ${t.table.keyId} is not null and ${notInArray(t.table.keyId, known)})::int`
              : sql<number>`count(*)::int`,
            legacy: sql<number>`count(*) filter (where ${t.table.keyId} is null)::int`,
          })
          .from(t.table)
          .where(encrypted)
        result.push({ ...t, unknown: row?.unknown ?? 0, legacy: row?.legacy ?? 0 })
      }
      return result
    })
    for (const { label, table, aad, unknown, legacy } of counts) {
      problem(label, unknown)
      if (!ring || !legacy) continue
      let after: string | null = null
      for (;;) {
        const cursor: string | null = after
        const rows: { id: string }[] = await withSpace(db, spaceId, async (tx) => {
          const batch = await tx
            .select({ id: table.id, wrappedKey: table.wrappedKey })
            .from(table)
            .where(
              and(
                isNotNull(table.wrappedKey),
                isNull(table.keyId),
                cursor ? gt(table.id, cursor) : undefined,
              ),
            )
            .orderBy(asc(table.id))
            .limit(BATCH)
          for (const row of batch) {
            const id = identify(ring, row.wrappedKey!, aad(row.id))
            if (!id) problem(label)
            else if (fill) await tx.update(table).set({ keyId: id }).where(eq(table.id, row.id))
          }
          return batch
        })
        if (rows.length < BATCH) break
        after = rows[rows.length - 1]!.id
      }
    }
  }
  const settingsLabel = '实例设置里的接口 Key'
  if (!ring) {
    problem(settingsLabel, (await sealedSettingsKeys(db)).length)
  } else if (!fill) {
    for (const { sealed, aad, keyId } of await sealedSettingsKeys(db)) {
      if (keyId ? !known.includes(keyId) : !identify(ring, sealed.wrappedKey, aad)) {
        problem(settingsLabel)
      }
    }
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

// 轮换出的错，给实例设置页看（只有实例管理员看得到）
const ERROR_KEY = 'master-key-error'

export async function recordMasterKeyError(db: Db, message: string): Promise<void> {
  const value = { message: message.slice(0, 500), at: new Date().toISOString() }
  await db
    .insert(settings)
    .values({ key: ERROR_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

async function clearMasterKeyError(db: Db): Promise<void> {
  await db.delete(settings).where(eq(settings.key, ERROR_KEY))
}

// 把还是旧主密钥包装的数据密钥换成新的包装：逐个空间、按 id 往后一批一个短事务，正被别的事务锁着的行跳过（之后再来），
// 已删除、已过期的也换；最后是实例设置里的接口 Key。旧主密钥解不开的（记错了标识、或者已经坏了）跳过、记下来，
// 不拦住别的。返回这次换了多少条、还剩多少条
export async function rotateMasterKey(
  db: Db,
  masterKey: MasterKey,
): Promise<{ rewrapped: number; remaining: number }> {
  const { current, previous } = keyringOf(masterKey)
  if (!previous) return { rewrapped: 0, remaining: 0 }
  const currentId = keyIdOf(current)
  const previousId = keyIdOf(previous)
  let rewrapped = 0
  const failures: string[] = []
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    for (const { label, table, aad } of TABLES) {
      let after: string | null = null
      for (;;) {
        const cursor: string | null = after
        const rows: { id: string }[] = await withSpace(db, spaceId, async (tx) => {
          const batch = await tx
            .select({ id: table.id, wrappedKey: table.wrappedKey })
            .from(table)
            .where(
              and(
                isNotNull(table.wrappedKey),
                eq(table.keyId, previousId),
                cursor ? gt(table.id, cursor) : undefined,
              ),
            )
            .orderBy(asc(table.id))
            .limit(BATCH)
            .for('update', { skipLocked: true })
          for (const row of batch) {
            let wrappedKey: Buffer
            try {
              wrappedKey = rewrapKey(previous, current, row.wrappedKey!, aad(row.id))
            } catch {
              failures.push(`${label} ${row.id}`)
              continue
            }
            await tx.update(table).set({ wrappedKey, keyId: currentId }).where(eq(table.id, row.id))
            rewrapped++
          }
          return batch
        })
        if (rows.length < BATCH) break
        after = rows[rows.length - 1]!.id
      }
    }
  }
  rewrapped += await mapSettingsKeys(db, (sealed, aad) => {
    if (sealed.keyId !== previousId) return sealed
    try {
      const wrappedKey = rewrapKey(previous, current, Buffer.from(sealed.wrappedKey, 'base64'), aad)
      return { ...sealed, wrappedKey: wrappedKey.toString('base64'), keyId: currentId }
    } catch {
      failures.push('实例设置里的接口 Key')
      return sealed
    }
  })
  if (failures.length) {
    await recordMasterKeyError(
      db,
      `${failures.length} 条用旧主密钥也解不开，没有换成新的包装：${failures.slice(0, 5).join('、')}`,
    )
  }
  const { remaining } = await masterKeyStatus(db, masterKey)
  const left = remaining.memories + remaining.credentials + remaining.settings
  if (!left) await clearMasterKeyError(db)
  return { rewrapped, remaining: left }
}

export async function masterKeyStatus(
  db: Db,
  masterKey: MasterKey | null,
): Promise<MasterKeyStatus> {
  const ring = masterKey ? keyringOf(masterKey) : null
  const previousId = ring?.previous ? keyIdOf(ring.previous) : null
  const remaining = { memories: 0, credentials: 0, settings: 0 }
  let lastError: MasterKeyStatus['lastError'] = null
  if (previousId) {
    for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
      await withSpace(db, spaceId, async (tx) => {
        for (const { field, table } of TABLES) {
          const [row] = await tx
            .select({ n: count() })
            .from(table)
            .where(and(isNotNull(table.wrappedKey), eq(table.keyId, previousId)))
          remaining[field] += row?.n ?? 0
        }
      })
    }
    remaining.settings = (await sealedSettingsKeys(db)).filter((k) => k.keyId === previousId).length
    const [row] = await db.select().from(settings).where(eq(settings.key, ERROR_KEY)).limit(1)
    lastError = (row?.value as MasterKeyStatus['lastError'] | undefined) ?? null
  }
  return {
    configured: ring !== null,
    currentId: ring ? keyIdOf(ring.current) : null,
    previousId,
    remaining,
    lastError,
  }
}
