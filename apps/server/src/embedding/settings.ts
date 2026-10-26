import { eq } from 'drizzle-orm'

import { decryptSecret, encryptSecret } from '../crypto/envelope'
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
  const previous = (row?.value as Stored | undefined)?.apiKey ?? null
  let apiKey = previous
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
