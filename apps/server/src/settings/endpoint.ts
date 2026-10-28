import { eq } from 'drizzle-orm'

import { decryptSecret, encryptSecret, type Sealed } from '../crypto/envelope'
import type { Db } from '../db/client'
import { settings } from '../db/schema'

// OpenAI 兼容接口的设置：根地址、模型与 Key，嵌入接口与抽取模型各存一项（settings 表里的一行）。
// Key 用主密钥加密后存库，aad 绑定设置项名
export interface ModelEndpoint {
  key: string
  // 出错时的称呼，例如「嵌入接口」
  label: string
}

export interface EndpointConfig {
  baseUrl: string
  model: string
  apiKey: string | null
}

// apiKey 不填表示沿用已保存的 Key，null 表示清除
export interface EndpointInput {
  baseUrl: string
  model: string
  apiKey?: string | null | undefined
}

export interface EndpointSettingsView {
  configured: boolean
  baseUrl: string | null
  model: string | null
  hasApiKey: boolean
}

interface Stored {
  baseUrl: string
  model: string
  apiKey: { ciphertext: string; wrappedKey: string } | null
}

const aadOf = (endpoint: ModelEndpoint) => `settings:${endpoint.key}`

async function loadStored(db: Db, endpoint: ModelEndpoint): Promise<Stored | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, endpoint.key)).limit(1)
  return row?.value as Stored | undefined
}

function viewOf(stored: Stored | undefined): EndpointSettingsView {
  return {
    configured: Boolean(stored),
    baseUrl: stored?.baseUrl ?? null,
    model: stored?.model ?? null,
    hasApiKey: Boolean(stored?.apiKey),
  }
}

// 只读出加密保存的 Key，不解密；没有保存 Key 时返回 null。用来核对主密钥是否一致
export async function sealedEndpointKey(
  db: Db,
  endpoint: ModelEndpoint,
): Promise<{ sealed: Sealed; aad: string } | null> {
  const stored = await loadStored(db, endpoint)
  if (!stored?.apiKey) return null
  return {
    sealed: {
      ciphertext: Buffer.from(stored.apiKey.ciphertext, 'base64'),
      wrappedKey: Buffer.from(stored.apiKey.wrappedKey, 'base64'),
    },
    aad: aadOf(endpoint),
  }
}

export async function loadEndpointConfig(
  db: Db,
  masterKey: Buffer | null,
  endpoint: ModelEndpoint,
): Promise<EndpointConfig | null> {
  const stored = await loadStored(db, endpoint)
  if (!stored) return null
  let apiKey: string | null = null
  if (stored.apiKey) {
    if (!masterKey) {
      throw new Error(`${endpoint.label}的 Key 已加密保存，但服务端没有配置 KIOKU_MASTER_KEY`)
    }
    apiKey = decryptSecret(
      masterKey,
      {
        ciphertext: Buffer.from(stored.apiKey.ciphertext, 'base64'),
        wrappedKey: Buffer.from(stored.apiKey.wrappedKey, 'base64'),
      },
      aadOf(endpoint),
    )
  }
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey }
}

// 同一个主机（协议、主机名与端口都相同）才能沿用已保存的 Key。只认 http 与 https：
// 别的协议的 origin 都是 "null"，按字符串比较会把不同的主机当成同一个
export function sameOrigin(a: string, b: string): boolean {
  const left = new URL(a)
  const right = new URL(b)
  const web = (u: URL) => u.protocol === 'http:' || u.protocol === 'https:'
  return web(left) && web(right) && left.origin === right.origin
}

// 保存并返回保存后的视图
export async function saveEndpointConfig(
  db: Db,
  masterKey: Buffer | null,
  endpoint: ModelEndpoint,
  input: EndpointInput,
): Promise<EndpointSettingsView> {
  const stored = await loadStored(db, endpoint)
  // 换了接口的主机就不能沿用旧 Key：否则改个地址再点测试，服务端就会把 Key 发给新主机
  const keep = stored ? sameOrigin(stored.baseUrl, input.baseUrl) : false
  // 主机变了又没说怎么处理 Key：明确报错让管理员重填（或填 null 表示新接口不用 Key），
  // 而不是悄悄清掉，否则之后的后台任务会一直失败
  if (!keep && stored?.apiKey && input.apiKey === undefined) {
    throw new Error('接口主机变了，请重新填写 Key；新接口不需要 Key 时填 null')
  }
  let apiKey = keep ? (stored?.apiKey ?? null) : null
  if (input.apiKey === null) apiKey = null
  if (typeof input.apiKey === 'string') {
    if (!masterKey) throw new Error(`保存${endpoint.label}的 Key 需要先配置 KIOKU_MASTER_KEY`)
    const sealed = encryptSecret(masterKey, input.apiKey, aadOf(endpoint))
    apiKey = {
      ciphertext: sealed.ciphertext.toString('base64'),
      wrappedKey: sealed.wrappedKey.toString('base64'),
    }
  }
  const value: Stored = { baseUrl: input.baseUrl, model: input.model, apiKey }
  await db
    .insert(settings)
    .values({ key: endpoint.key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  return viewOf(value)
}

export async function endpointSettingsView(
  db: Db,
  endpoint: ModelEndpoint,
): Promise<EndpointSettingsView> {
  return viewOf(await loadStored(db, endpoint))
}

export async function clearEndpointConfig(db: Db, endpoint: ModelEndpoint): Promise<void> {
  await db.delete(settings).where(eq(settings.key, endpoint.key))
}
