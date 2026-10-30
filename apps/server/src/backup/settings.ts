import type { BackupSettingsView, BackupStatus, UpdateBackupSettings } from '@kioku/contracts'
import { eq } from 'drizzle-orm'

import type { Sealed } from '../crypto/envelope'
import type { MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import { settings } from '../db/schema'
import { openApiKey, resolveApiKey, unsealJson, type SealedJson } from '../settings/endpoint'
import type { S3Location } from './s3'

// 备份存储的设置与最近的结果，存在 settings 表里。Secret Access Key 用主密钥加密，aad 绑定设置项名；
// 结果单独存一项：后台任务记结果不会和管理员保存设置互相覆盖。结果只对一个存储位置（接口、存储桶、前缀）有效：
// 换了位置就清掉；任务记结果时位置已经变了、或者设置清掉了，就不记
const KEY = 'backup'
const STATUS_KEY = 'backup-status'
const AAD = `settings:${KEY}`
export const BACKUP_LABEL = '备份存储'
const SECRET_NAME = 'Secret Access Key'

interface Stored {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: SealedJson
  hour: number
  keep: number
}

export interface BackupConfig extends S3Location {
  prefix: string
  hour: number
  keep: number
}

type Location = Pick<Stored, 'endpoint' | 'bucket' | 'prefix'>
const sameLocation = (a: Location, b: Location) =>
  a.endpoint === b.endpoint && a.bucket === b.bucket && a.prefix === b.prefix

async function loadStored(db: Db): Promise<Stored | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  return row?.value as Stored | undefined
}

// 不用解密就读得到的部分：存储位置与每天的钟点。设置解不开时，后台任务也能把错误记到这个位置上
export async function loadBackupTarget(db: Db): Promise<(Location & { hour: number }) | null> {
  const stored = await loadStored(db)
  return stored
    ? { endpoint: stored.endpoint, bucket: stored.bucket, prefix: stored.prefix, hour: stored.hour }
    : null
}

export async function loadBackupStatus(db: Db): Promise<BackupStatus> {
  const [row] = await db.select().from(settings).where(eq(settings.key, STATUS_KEY)).limit(1)
  return (row?.value as BackupStatus | undefined) ?? { lastSuccess: null, lastError: null }
}

// 记结果：锁住设置，确认还是做备份时的那个位置才写
async function saveStatus(
  db: Db,
  location: Location,
  change: (status: BackupStatus) => BackupStatus,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [config] = await tx.select().from(settings).where(eq(settings.key, KEY)).for('share')
    const stored = config?.value as Stored | undefined
    if (!stored || !sameLocation(stored, location)) return
    const [row] = await tx.select().from(settings).where(eq(settings.key, STATUS_KEY)).for('update')
    const value = change(
      (row?.value as BackupStatus | undefined) ?? { lastSuccess: null, lastError: null },
    )
    await tx
      .insert(settings)
      .values({ key: STATUS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  })
}

// 记下做成的一份；warning 是做成之后的小问题（例如删旧的出错），没有就清掉之前的错误
export function recordBackupSuccess(
  db: Db,
  location: Location,
  run: NonNullable<BackupStatus['lastSuccess']>,
  warning: string | null = null,
): Promise<void> {
  return saveStatus(db, location, () => ({
    lastSuccess: run,
    lastError: warning ? { message: warning.slice(0, 500), at: run.at } : null,
  }))
}

// at 是这次备份开始的时间：比最近一份成功晚，就是那之后的一次没做成；和那份成功同时记下的才是做成之后的提醒
export function recordBackupError(
  db: Db,
  location: Location,
  message: string,
  at: string,
): Promise<void> {
  return saveStatus(db, location, (status) => ({
    ...status,
    lastError: { message: message.slice(0, 500), at },
  }))
}

export async function backupSettingsView(db: Db): Promise<BackupSettingsView> {
  const [stored, status] = await Promise.all([loadStored(db), loadBackupStatus(db)])
  return {
    configured: Boolean(stored),
    endpoint: stored?.endpoint ?? null,
    region: stored?.region ?? null,
    bucket: stored?.bucket ?? null,
    prefix: stored?.prefix ?? null,
    accessKeyId: stored?.accessKeyId ?? null,
    hasSecret: Boolean(stored?.secretAccessKey),
    hour: stored?.hour ?? null,
    keep: stored?.keep ?? null,
    status,
  }
}

// 保存：Secret 不填表示沿用已保存的，规则同模型接口的 Key（换了接口主机就要重填，免得把密钥发给新主机）。
// 读出、改、写回在一个事务里并锁住这一行，沿用的 Secret 不会把轮换主密钥刚换好的包装覆盖回去。
// 换了存储位置，之前的结果不再算数：清掉，下一个小时的检查就往新位置做一份
export async function saveBackupSettings(
  db: Db,
  masterKey: MasterKey | null,
  input: UpdateBackupSettings,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.key, KEY)).for('update')
    const stored = row?.value as Stored | undefined
    const secretAccessKey = resolveApiKey(
      stored && { baseUrl: stored.endpoint, apiKey: stored.secretAccessKey },
      { baseUrl: input.endpoint, apiKey: input.secretAccessKey },
      masterKey,
      AAD,
      BACKUP_LABEL,
      { name: SECRET_NAME, required: true },
    )!
    const value: Stored = {
      // 去掉末尾的 /：同一个地址写法不同，不该算成换了位置
      endpoint: input.endpoint.replace(/\/+$/, ''),
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
      accessKeyId: input.accessKeyId,
      secretAccessKey,
      hour: input.hour,
      keep: input.keep,
    }
    await tx
      .insert(settings)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    if (!stored || !sameLocation(stored, value)) {
      await tx.delete(settings).where(eq(settings.key, STATUS_KEY))
    }
  })
}

// 先删设置、再删结果：和记结果时加锁的顺序一样（先设置、后结果），同时发生也不会互相等成死锁
async function removeSettings(tx: Tx): Promise<boolean> {
  const removed = await tx.delete(settings).where(eq(settings.key, KEY)).returning()
  await tx.delete(settings).where(eq(settings.key, STATUS_KEY))
  return removed.length > 0
}

// 清掉设置，定时备份随即停止；最近的结果一起清掉。存储桶里已有的备份不动
export async function clearBackupSettings(db: Db): Promise<void> {
  await db.transaction(removeSettings)
}

// 恢复出的实例不沿用备份设置：试恢复的实例会和正在用的实例往同一个目录写、互相把对方的备份当旧的删掉。
// 在恢复的事务里清掉，返回之前是否配着
export const forgetBackupSettings = (tx: Tx): Promise<boolean> => removeSettings(tx)

export async function loadBackupConfig(
  db: Db,
  masterKey: MasterKey | null,
): Promise<BackupConfig | null> {
  const stored = await loadStored(db)
  if (!stored) return null
  return {
    endpoint: stored.endpoint,
    region: stored.region,
    bucket: stored.bucket,
    prefix: stored.prefix,
    accessKeyId: stored.accessKeyId,
    secretAccessKey: openApiKey(masterKey, stored.secretAccessKey, AAD, BACKUP_LABEL, SECRET_NAME),
    hour: stored.hour,
    keep: stored.keep,
  }
}

// 只读出加密保存的 Secret，不解密：核对主密钥用
export async function sealedBackupKey(
  db: Db,
): Promise<{ sealed: Sealed; aad: string; keyId: string | null } | null> {
  const stored = await loadStored(db)
  if (!stored) return null
  return {
    sealed: unsealJson(stored.secretAccessKey),
    aad: AAD,
    keyId: stored.secretAccessKey.keyId ?? null,
  }
}

// 改写保存着的 Secret（轮换主密钥时补上标识、换成新密钥的包装）：change 原样返回就不写回。返回改了几个
export async function mapBackupKey(
  db: Db,
  change: (sealed: SealedJson, aad: string) => SealedJson,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.key, KEY)).for('update')
    const stored = row?.value as Stored | undefined
    if (!stored) return 0
    const secretAccessKey = change(stored.secretAccessKey, AAD)
    if (secretAccessKey === stored.secretAccessKey) return 0
    await tx
      .update(settings)
      .set({ value: { ...stored, secretAccessKey }, updatedAt: new Date() })
      .where(eq(settings.key, KEY))
    return 1
  })
}
