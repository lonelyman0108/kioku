import { eq } from 'drizzle-orm'

import { decryptSecret, encryptSecret, type Sealed } from '../crypto/envelope'
import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'
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

// 加密保存的 Key，JSON 里按 base64 存；keyId 是包装数据密钥用的主密钥的标识（加上标识之前保存的没有）
export interface SealedJson {
  ciphertext: string
  wrappedKey: string
  keyId?: string
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
  masterKey: MasterKey | null,
  sealed: SealedJson,
  aad: string,
  label: string,
): string {
  if (!masterKey) throw new Error(`${label}的 Key 已加密保存，但服务端没有配置 KIOKU_MASTER_KEY`)
  return decryptSecret(decryptionKey(masterKey, sealed.keyId), unsealJson(sealed), aad)
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
// 而不是悄悄清掉，否则之后的请求会一直失败。报错的话照管理界面上的说法（重新填写，或者清除已保存的），
// 不提 null 这类接口细节。where 是报错时的称呼，例如「第 2 个渠道的」；name 是这个密钥叫什么；
// required 时一定要有密钥（例如对象存储的 Secret），不能清除
export function resolveApiKey(
  previous: { baseUrl: string; apiKey: SealedJson | null } | undefined,
  input: { baseUrl: string; apiKey?: string | null | undefined },
  masterKey: MasterKey | null,
  aad: string,
  label: string,
  options: { where?: string; name?: string; required?: boolean } = {},
): SealedJson | null {
  const { where = '', name = 'Key', required = false } = options
  const keep = previous ? sameOrigin(previous.baseUrl, input.baseUrl) : false
  if (!keep && previous?.apiKey && input.apiKey === undefined) {
    throw new SettingsInputError(
      `${where}接口主机变了，已保存的 ${name} 不会发给新的主机：请重新填写${
        required ? '' : `；新接口不需要 ${name} 时，清除已保存的 ${name}`
      }`,
    )
  }
  let result: SealedJson | null = keep ? (previous?.apiKey ?? null) : null
  if (input.apiKey === null) result = null
  if (typeof input.apiKey === 'string') {
    if (!masterKey)
      throw new SettingsInputError(`保存${label}的 ${name} 需要先配置 KIOKU_MASTER_KEY`)
    const { key, id } = encryptionKey(masterKey)
    const sealed = encryptSecret(key, input.apiKey, aad)
    result = {
      ciphertext: sealed.ciphertext.toString('base64'),
      wrappedKey: sealed.wrappedKey.toString('base64'),
      keyId: id,
    }
  }
  if (required && !result) throw new SettingsInputError(`请填写 ${name}`)
  return result
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
): Promise<{ sealed: Sealed; aad: string; keyId: string | null } | null> {
  const stored = await loadStored(db, endpoint)
  if (!stored?.apiKey) return null
  return {
    sealed: unsealJson(stored.apiKey),
    aad: aadOf(endpoint),
    keyId: stored.apiKey.keyId ?? null,
  }
}

// 改写保存着的 Key（轮换主密钥时补上标识、换成新密钥的包装）：change 原样返回就不写回。返回改了几个
export async function mapEndpointKey(
  db: Db,
  endpoint: ModelEndpoint,
  change: (sealed: SealedJson, aad: string) => SealedJson,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, endpoint.key))
      .for('update')
    const stored = row?.value as Stored | undefined
    if (!stored?.apiKey) return 0
    const apiKey = change(stored.apiKey, aadOf(endpoint))
    if (apiKey === stored.apiKey) return 0
    await tx
      .update(settings)
      .set({ value: { ...stored, apiKey }, updatedAt: new Date() })
      .where(eq(settings.key, endpoint.key))
    return 1
  })
}

export async function loadEndpointConfig(
  db: Db,
  masterKey: MasterKey | null,
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
  masterKey: MasterKey | null,
  endpoint: ModelEndpoint,
  input: EndpointInput,
): Promise<EndpointSettingsView> {
  // 读出、改、写回在一个事务里并锁住这一行：沿用的 Key 不会把轮换主密钥刚换好的包装覆盖回去
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, endpoint.key))
      .for('update')
    const stored = row?.value as Stored | undefined
    const apiKey = resolveApiKey(stored, input, masterKey, aadOf(endpoint), endpoint.label)
    const value: Stored = { baseUrl: input.baseUrl, model: input.model, apiKey }
    await tx
      .insert(settings)
      .values({ key: endpoint.key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    return viewOf(value)
  })
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
