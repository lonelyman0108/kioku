import { eq } from 'drizzle-orm'

import { decryptSecret, encryptSecret, type Sealed } from '../crypto/envelope'
import type { Db } from '../db/client'
import { settings } from '../db/schema'

// OpenAI 兼容接口的设置：根地址、模型与 Key，存在 settings 表里。Key 用主密钥加密后存库，aad 绑定设置项名。
// 抽取模型用这里的单接口设置；嵌入接口有几个渠道（embedding/settings.ts），Key 的加密与沿用规则共用这里的
export interface ModelEndpoint {
  key: string
  // 出错时的称呼，例如「抽取模型」
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

// 加密保存的 Key，JSON 里按 base64 存
export interface SealedJson {
  ciphertext: string
  wrappedKey: string
}

// 管理员填的设置不成立，原因可以直接给管理员看
export class SettingsInputError extends Error {}

interface Stored {
  baseUrl: string
  model: string
  apiKey: SealedJson | null
}

const aadOf = (endpoint: ModelEndpoint) => `settings:${endpoint.key}`

export const unsealJson = (sealed: SealedJson): Sealed => ({
  ciphertext: Buffer.from(sealed.ciphertext, 'base64'),
  wrappedKey: Buffer.from(sealed.wrappedKey, 'base64'),
})

// 解开加密保存的 Key；没配主密钥时说清是哪一项
export function openApiKey(
  masterKey: Buffer | null,
  sealed: SealedJson,
  aad: string,
  label: string,
): string {
  if (!masterKey) throw new Error(`${label}的 Key 已加密保存，但服务端没有配置 KIOKU_MASTER_KEY`)
  return decryptSecret(masterKey, unsealJson(sealed), aad)
}

// 同一个主机（协议、主机名与端口都相同）才能沿用已保存的 Key。只认 http 与 https：
// 别的协议的 origin 都是 "null"，按字符串比较会把不同的主机当成同一个
export function sameOrigin(a: string, b: string): boolean {
  const left = new URL(a)
  const right = new URL(b)
  const web = (u: URL) => u.protocol === 'http:' || u.protocol === 'https:'
  return web(left) && web(right) && left.origin === right.origin
}

// 保存时这个接口用哪个 Key：新填的就加密保存，null 是不用 Key，不填是沿用之前的。
// 换了接口的主机就不能沿用：否则改个地址，服务端就会把 Key 发给新主机。主机变了又没说 Key 怎么处理时报错让管理员重填，
// 而不是悄悄清掉，否则之后的请求会一直失败。where 是报错时的称呼，例如「第 2 个渠道的」
export function resolveApiKey(
  previous: { baseUrl: string; apiKey: SealedJson | null } | undefined,
  input: { baseUrl: string; apiKey?: string | null | undefined },
  masterKey: Buffer | null,
  aad: string,
  label: string,
  where = '',
): SealedJson | null {
  const keep = previous ? sameOrigin(previous.baseUrl, input.baseUrl) : false
  if (!keep && previous?.apiKey && input.apiKey === undefined) {
    throw new SettingsInputError(`${where}接口主机变了，请重新填写 Key；不需要 Key 时填 null`)
  }
  if (input.apiKey === null) return null
  if (typeof input.apiKey === 'string') {
    if (!masterKey) throw new SettingsInputError(`保存${label}的 Key 需要先配置 KIOKU_MASTER_KEY`)
    const sealed = encryptSecret(masterKey, input.apiKey, aad)
    return {
      ciphertext: sealed.ciphertext.toString('base64'),
      wrappedKey: sealed.wrappedKey.toString('base64'),
    }
  }
  return keep ? (previous?.apiKey ?? null) : null
}

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
  return { sealed: unsealJson(stored.apiKey), aad: aadOf(endpoint) }
}

export async function loadEndpointConfig(
  db: Db,
  masterKey: Buffer | null,
  endpoint: ModelEndpoint,
): Promise<EndpointConfig | null> {
  const stored = await loadStored(db, endpoint)
  if (!stored) return null
  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    apiKey: stored.apiKey
      ? openApiKey(masterKey, stored.apiKey, aadOf(endpoint), endpoint.label)
      : null,
  }
}

// 保存并返回保存后的视图
export async function saveEndpointConfig(
  db: Db,
  masterKey: Buffer | null,
  endpoint: ModelEndpoint,
  input: EndpointInput,
): Promise<EndpointSettingsView> {
  const stored = await loadStored(db, endpoint)
  const apiKey = resolveApiKey(stored, input, masterKey, aadOf(endpoint), endpoint.label)
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
