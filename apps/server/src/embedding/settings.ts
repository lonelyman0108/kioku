import { eq } from 'drizzle-orm'

import { decryptSecret, encryptSecret, type Sealed } from '../crypto/envelope'
import type { Db } from '../db/client'
import { settings } from '../db/schema'
import type { EmbeddingConfig } from './provider'

const KEY = 'embedding'
// API Key 用主密钥加密后存库，aad 绑定设置项名
const AAD = 'settings:embedding'

interface Stored {
  baseUrl: string
  model: string
  apiKey: { ciphertext: string; wrappedKey: string } | null
}

// 只读出加密保存的嵌入接口 Key，不解密；没有保存 Key 时返回 null。用来核对主密钥是否一致
export async function sealedEmbeddingKey(db: Db): Promise<{ sealed: Sealed; aad: string } | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const stored = row?.value as Stored | undefined
  if (!stored?.apiKey) return null
  return {
    sealed: {
      ciphertext: Buffer.from(stored.apiKey.ciphertext, 'base64'),
      wrappedKey: Buffer.from(stored.apiKey.wrappedKey, 'base64'),
    },
    aad: AAD,
  }
}

export async function loadEmbeddingConfig(
  db: Db,
  masterKey: Buffer | null,
): Promise<EmbeddingConfig | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  if (!row) return null
  const stored = row.value as Stored
  let apiKey: string | null = null
  if (stored.apiKey) {
    if (!masterKey) throw new Error('嵌入接口的 Key 已加密保存，但服务端没有配置 KIOKU_MASTER_KEY')
    apiKey = decryptSecret(
      masterKey,
      {
        ciphertext: Buffer.from(stored.apiKey.ciphertext, 'base64'),
        wrappedKey: Buffer.from(stored.apiKey.wrappedKey, 'base64'),
      },
      AAD,
    )
  }
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey }
}

export async function saveEmbeddingConfig(
  db: Db,
  masterKey: Buffer | null,
  input: { baseUrl: string; model: string; apiKey?: string | null | undefined },
): Promise<void> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const stored = row?.value as Stored | undefined
  // 换了接口的主机就不能沿用旧 Key：否则改个地址再点测试，服务端就会把 Key 发给新主机
  const sameOrigin = stored
    ? new URL(stored.baseUrl).origin === new URL(input.baseUrl).origin
    : false
  // 主机变了又没说怎么处理 Key：明确报错让管理员重填（或填 null 表示新接口不用 Key），
  // 而不是悄悄清掉，否则之后的向量任务会在后台一直失败
  if (!sameOrigin && stored?.apiKey && input.apiKey === undefined) {
    throw new Error('接口主机变了，请重新填写 Key；新接口不需要 Key 时填 null')
  }
  let apiKey = sameOrigin ? (stored?.apiKey ?? null) : null
  if (input.apiKey === null) apiKey = null
  if (typeof input.apiKey === 'string') {
    if (!masterKey) throw new Error('保存嵌入接口的 Key 需要先配置 KIOKU_MASTER_KEY')
    const sealed = encryptSecret(masterKey, input.apiKey, AAD)
    apiKey = {
      ciphertext: sealed.ciphertext.toString('base64'),
      wrappedKey: sealed.wrappedKey.toString('base64'),
    }
  }
  const value: Stored = { baseUrl: input.baseUrl, model: input.model, apiKey }
  await db
    .insert(settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

export async function embeddingSettingsView(db: Db) {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const stored = row?.value as Stored | undefined
  return {
    configured: Boolean(stored),
    baseUrl: stored?.baseUrl ?? null,
    model: stored?.model ?? null,
    hasApiKey: Boolean(stored?.apiKey),
  }
}
