import type { BackupSettingsView, BackupStatus, UpdateBackupSettings } from '@kioku/contracts'
import { eq } from 'drizzle-orm'

import type { Sealed } from '../crypto/envelope'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { settings } from '../db/schema'
import {
  openApiKey,
  resolveApiKey,
  sameOrigin,
  SettingsInputError,
  unsealJson,
  type SealedJson,
} from '../settings/endpoint'
import type { S3Location } from './s3'

// 备份存储的设置与最近的结果，存在 settings 表里。Secret Access Key 用主密钥加密，aad 绑定设置项名；
// 结果单独存一项：后台任务记结果不会和管理员保存设置互相覆盖
const KEY = 'backup'
const STATUS_KEY = 'backup-status'
const AAD = `settings:${KEY}`
export const BACKUP_LABEL = '备份存储'

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

async function loadStored(db: Db): Promise<Stored | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  return row?.value as Stored | undefined
}

export async function loadBackupStatus(db: Db): Promise<BackupStatus> {
  const [row] = await db.select().from(settings).where(eq(settings.key, STATUS_KEY)).limit(1)
  return (row?.value as BackupStatus | undefined) ?? { lastSuccess: null, lastError: null }
}

async function saveStatus(db: Db, change: (status: BackupStatus) => BackupStatus): Promise<void> {
  await db.transaction(async (tx) => {
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
  run: NonNullable<BackupStatus['lastSuccess']>,
  warning: string | null = null,
): Promise<void> {
  return saveStatus(db, () => ({
    lastSuccess: run,
    lastError: warning ? { message: warning.slice(0, 500), at: run.at } : null,
  }))
}

export function recordBackupError(db: Db, message: string): Promise<void> {
  return saveStatus(db, (status) => ({
    ...status,
    lastError: { message: message.slice(0, 500), at: new Date().toISOString() },
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
// 读出、改、写回在一个事务里并锁住这一行，沿用的 Secret 不会把轮换主密钥刚换好的包装覆盖回去
export async function saveBackupSettings(
  db: Db,
  masterKey: MasterKey | null,
  input: UpdateBackupSettings,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.key, KEY)).for('update')
    const stored = row?.value as Stored | undefined
    if (
      stored &&
      input.secretAccessKey === undefined &&
      !sameOrigin(stored.endpoint, input.endpoint)
    ) {
      throw new SettingsInputError('接口主机变了，请重新填写 Secret Access Key')
    }
    const secretAccessKey = resolveApiKey(
      stored && { baseUrl: stored.endpoint, apiKey: stored.secretAccessKey },
      { baseUrl: input.endpoint, apiKey: input.secretAccessKey },
      masterKey,
      AAD,
      BACKUP_LABEL,
    )
    if (!secretAccessKey) throw new SettingsInputError('请填写 Secret Access Key')
    const value: Stored = {
      endpoint: input.endpoint,
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
  })
}

// 清掉设置，定时备份随即停止；最近的结果一起清掉。存储桶里已有的备份不动
export async function clearBackupSettings(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(settings).where(eq(settings.key, KEY))
    await tx.delete(settings).where(eq(settings.key, STATUS_KEY))
  })
}

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
    secretAccessKey: openApiKey(masterKey, stored.secretAccessKey, AAD, BACKUP_LABEL),
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
