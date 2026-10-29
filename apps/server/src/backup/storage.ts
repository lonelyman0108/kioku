import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'

import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { createBackup } from './export'
import { s3Client, type S3Client, type S3Location, type S3Object } from './s3'
import {
  loadBackupConfig,
  loadBackupStatus,
  recordBackupError,
  recordBackupSuccess,
  type BackupConfig,
} from './settings'

// 备份在存储桶里的名字：前缀目录下的 kioku-<UTC 时间>.backup，按名字排就是按时间排。
// 列出与删旧的只看这个格式的对象，存储桶里别的文件不动
const NAME = /^kioku-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.backup$/
const dirOf = (prefix: string) => (prefix ? `${prefix}/` : '')
const nameOf = (createdAt: string) => `kioku-${createdAt.slice(0, 19).replaceAll(':', '-')}Z.backup`

// 到了该做的时候：每天 hour 点（UTC）之后要有一份那之后做的；服务停过、做失败了，之后每小时检查时补做
export function isDue(now: Date, hour: number, lastSuccess: Date | null): boolean {
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour))
  if (slot > now) slot.setUTCDate(slot.getUTCDate() - 1)
  return !lastSuccess || lastSuccess < slot
}

// 存储桶里的备份，新的在前
export async function listBackups(client: S3Client, prefix: string): Promise<S3Object[]> {
  const dir = dirOf(prefix)
  return (await client.list(dir))
    .filter((o) => NAME.test(o.key.slice(dir.length)))
    .sort((a, b) => b.key.localeCompare(a.key))
}

// 做一份备份传上去，再删掉超出保留份数的旧备份。整份加密后的备份在内存里攒齐再上传（一次 PUT 要知道长度）；
// 删旧的出错不算这份没做成，作为提醒返回
export async function uploadBackup(
  db: Db,
  masterKey: MasterKey,
  config: BackupConfig,
): Promise<{ run: { at: string; object: string; bytes: number }; warning: string | null }> {
  const chunks: Buffer[] = []
  const summary = await createBackup(
    db,
    masterKey,
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk)
        done()
      },
    }),
  )
  const client = s3Client(config)
  const object = `${dirOf(config.prefix)}${nameOf(summary.createdAt)}`
  await client.put(object, Buffer.concat(chunks))
  let warning: string | null = null
  try {
    for (const stale of (await listBackups(client, config.prefix)).slice(config.keep)) {
      await client.delete(stale.key)
    }
  } catch (err) {
    warning = `备份已经传上去，但删旧备份时出错：${(err as Error).message}`
  }
  return { run: { at: summary.createdAt, object, bytes: summary.bytes }, warning }
}

// 后台任务：每小时检查一次，到了钟点就做；force 是管理员点了「立即备份」，不看钟点。结果记在设置里给管理员看
export async function backupJob(
  db: Db,
  masterKey: MasterKey | null,
  force: boolean,
): Promise<'skipped' | 'done' | 'failed'> {
  try {
    const config = await loadBackupConfig(db, masterKey)
    if (!config) return 'skipped'
    if (!force) {
      const { lastSuccess } = await loadBackupStatus(db)
      if (!isDue(new Date(), config.hour, lastSuccess ? new Date(lastSuccess.at) : null)) {
        return 'skipped'
      }
    }
    if (!masterKey) throw new Error('备份用主密钥加密：服务端没有配置 KIOKU_MASTER_KEY')
    const { run, warning } = await uploadBackup(db, masterKey, config)
    await recordBackupSuccess(db, run, warning)
    return 'done'
  } catch (err) {
    await recordBackupError(db, (err as Error).message)
    return 'failed'
  }
}

// 测试连通：放一个小文件、列一遍、再删掉，读写删的权限都要有（删旧备份要用）。返回出错的原因，没出错返回 null
export async function testBackupStorage(config: BackupConfig): Promise<string | null> {
  const client = s3Client(config)
  const probe = `${dirOf(config.prefix)}.kioku-probe-${randomUUID()}`
  try {
    await client.put(probe, Buffer.from('kioku'))
  } catch (err) {
    return (err as Error).message
  }
  let error: string | null = null
  try {
    await client.list(dirOf(config.prefix))
  } catch (err) {
    error = (err as Error).message
  }
  try {
    await client.delete(probe)
  } catch (err) {
    error ??= (err as Error).message
  }
  return error
}

// 恢复用：从存储桶取一份备份，没指定对象名时取最新的
export async function fetchBackup(
  location: S3Location,
  prefix: string,
  object: string | null,
): Promise<{ object: string; file: Buffer }> {
  const client = s3Client(location)
  const key = object ?? (await listBackups(client, prefix))[0]?.key
  if (!key) throw new Error(`存储桶里 ${dirOf(prefix) || '根目录'}下没有备份`)
  return { object: key, file: await client.get(key) }
}
