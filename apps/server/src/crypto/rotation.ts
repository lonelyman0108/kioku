import { eq } from 'drizzle-orm'

import type { Db } from '../db/client'
import { credentials } from '../db/schema'
import {
  fromSealedBuffer,
  listSealedModelSettings,
  updateSealedModelSetting,
} from '../models/store'
import { canUnwrap, rewrapKey } from './envelope'
import { keyIdOf, keyringOf, type Keyring, type MasterKey } from './keyring'

// 主密钥启动校验与同步轮换：覆盖托管凭据（credentials）与加密保存的模型 API Key（settings）。
// 单人实例规模小，配置了 KIOKU_MASTER_KEY_PREVIOUS 时在启动阶段同步完成重封，无需后台轮换队列。

export function credentialAad(id: string): string {
  return `credential:${id}`
}

function identifyKey(
  ring: Keyring,
  wrappedKey: Buffer,
  aad: string,
): 'current' | 'previous' | null {
  if (canUnwrap(ring.current, wrappedKey, aad)) return 'current'
  if (ring.previous && canUnwrap(ring.previous, wrappedKey, aad)) return 'previous'
  return null
}

function formatProblems(problems: Map<string, number>, hasKey: boolean): string {
  const details = [...problems.entries()].map(([label, n]) => `${label} ${n} 条`).join('、')
  return hasKey
    ? `KIOKU_MASTER_KEY 无法解开库中已加密的数据（${details}）；请确认主密钥配置正确，轮换期间保留 KIOKU_MASTER_KEY_PREVIOUS`
    : `库中有加密数据（${details}），但未配置 KIOKU_MASTER_KEY`
}

export interface MasterKeyPrepareResult {
  rewrappedCredentials: number
  rewrappedSettings: number
}

async function inspectAndRotate(
  db: Db,
  masterKey: MasterKey | null,
  write: boolean,
): Promise<MasterKeyPrepareResult> {
  const ring = masterKey ? keyringOf(masterKey) : null
  const currentId = ring ? keyIdOf(ring.current) : null
  const problems = new Map<string, number>()
  const recordProblem = (label: string) => problems.set(label, (problems.get(label) ?? 0) + 1)

  let rewrappedCredentials = 0
  let rewrappedSettings = 0

  const credRows = await db
    .select({
      id: credentials.id,
      wrappedKey: credentials.wrappedKey,
      keyId: credentials.keyId,
    })
    .from(credentials)

  for (const row of credRows) {
    if (!ring || !currentId) {
      recordProblem('托管凭据')
      continue
    }
    const aad = credentialAad(row.id)
    const which = identifyKey(ring, row.wrappedKey, aad)
    if (!which) {
      recordProblem('托管凭据')
      continue
    }
    if (write && which === 'previous' && ring.previous) {
      const nextWrapped = rewrapKey(ring.previous, ring.current, row.wrappedKey, aad)
      await db
        .update(credentials)
        .set({ wrappedKey: nextWrapped, keyId: currentId })
        .where(eq(credentials.id, row.id))
      rewrappedCredentials++
    } else if (write && which === 'current' && row.keyId !== currentId) {
      await db.update(credentials).set({ keyId: currentId }).where(eq(credentials.id, row.id))
    }
  }

  const settingRows = await listSealedModelSettings(db)
  for (const item of settingRows) {
    if (!ring || !currentId) {
      recordProblem(item.label)
      continue
    }
    const which = identifyKey(ring, item.sealed.wrappedKey, item.aad)
    if (!which) {
      recordProblem(item.label)
      continue
    }
    if (write && which === 'previous' && ring.previous) {
      const nextWrapped = rewrapKey(ring.previous, ring.current, item.sealed.wrappedKey, item.aad)
      await updateSealedModelSetting(
        db,
        item.key,
        fromSealedBuffer(
          { ciphertext: item.sealed.ciphertext, wrappedKey: nextWrapped },
          currentId,
        ),
      )
      rewrappedSettings++
    } else if (write && which === 'current' && item.keyId !== currentId) {
      await updateSealedModelSetting(db, item.key, fromSealedBuffer(item.sealed, currentId))
    }
  }

  if (problems.size) {
    throw new Error(formatProblems(problems, Boolean(ring)))
  }

  return { rewrappedCredentials, rewrappedSettings }
}

// 启动时核对全部密文并同步重封旧主密钥包装的记录；无法解密时抛错拒绝启动
export async function prepareMasterKey(
  db: Db,
  masterKey: MasterKey | null,
): Promise<MasterKeyPrepareResult> {
  return inspectAndRotate(db, masterKey, true)
}

// 只读核对（供命令行 status 诊断使用，不改库）
export async function checkMasterKey(db: Db, masterKey: MasterKey | null): Promise<void> {
  await inspectAndRotate(db, masterKey, false)
}
