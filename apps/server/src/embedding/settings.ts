import type { EmbeddingChannelInput, UpdateEmbeddingSettings } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'

import { decryptSecret, encryptSecret, type Sealed } from '../crypto/envelope'
import type { Db, Tx } from '../db/client'
import { settings } from '../db/schema'
import { sameOrigin, type EndpointConfig } from '../settings/endpoint'

// 嵌入设置：召回与写入正在用的模型（active），和正在换过去的模型（next），各带一组按顺序回退的渠道。
// 向量按模型标识存；各渠道请求时用的模型名可以不同，服务商改名只改渠道，不用重新生成向量。
// 渠道的 Key 用主密钥加密后存库，aad 绑定设置项名。存在 settings 表的一行里
const KEY = 'embedding'
const AAD = `settings:${KEY}`
const LABEL = '嵌入接口'

interface SealedJson {
  ciphertext: string
  wrappedKey: string
}

interface StoredChannel {
  id: string
  baseUrl: string
  model: string
  apiKey: SealedJson | null
}

interface StoredSetup {
  model: string
  channels: StoredChannel[]
}

export interface StoredEmbedding {
  active: StoredSetup | null
  next: StoredSetup | null
}

// 只有一个接口时的旧格式：读出来当作只有一个渠道的设置，下次保存时换成新格式
interface LegacyStored {
  baseUrl: string
  model: string
  apiKey: SealedJson | null
}

export interface EmbeddingSetup {
  model: string
  channels: EndpointConfig[]
}

// 管理员填的设置不成立，原因可以直接给管理员看
export class EmbeddingSettingsError extends Error {}

function normalize(value: unknown): StoredEmbedding {
  if (!value) return { active: null, next: null }
  const legacy = value as Partial<LegacyStored>
  if (typeof legacy.baseUrl === 'string' && typeof legacy.model === 'string') {
    const channel = {
      id: 'c1',
      baseUrl: legacy.baseUrl,
      model: legacy.model,
      apiKey: legacy.apiKey ?? null,
    }
    return { active: { model: legacy.model, channels: [channel] }, next: null }
  }
  return value as StoredEmbedding
}

async function loadStored(db: Db | Tx): Promise<StoredEmbedding> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  return normalize(row?.value)
}

// 只读模型标识与渠道，不解密 Key
export const loadEmbeddingModels = loadStored

const setupView = (setup: StoredSetup | null) =>
  setup && {
    model: setup.model,
    channels: setup.channels.map((c) => ({
      id: c.id,
      baseUrl: c.baseUrl,
      model: c.model,
      hasApiKey: Boolean(c.apiKey),
    })),
  }

export function embeddingView(stored: StoredEmbedding) {
  return { active: setupView(stored.active), next: setupView(stored.next) }
}

export async function embeddingSettingsView(db: Db) {
  return embeddingView(await loadStored(db))
}

const unseal = (sealed: SealedJson): Sealed => ({
  ciphertext: Buffer.from(sealed.ciphertext, 'base64'),
  wrappedKey: Buffer.from(sealed.wrappedKey, 'base64'),
})

function openSetup(masterKey: Buffer | null, setup: StoredSetup | null): EmbeddingSetup | null {
  if (!setup) return null
  return {
    model: setup.model,
    channels: setup.channels.map((c) => {
      if (c.apiKey && !masterKey) {
        throw new Error(`${LABEL}的 Key 已加密保存，但服务端没有配置 KIOKU_MASTER_KEY`)
      }
      return {
        baseUrl: c.baseUrl,
        model: c.model,
        apiKey: c.apiKey ? decryptSecret(masterKey!, unseal(c.apiKey), AAD) : null,
      }
    }),
  }
}

// 解密出两组渠道，给请求嵌入接口用
export async function loadEmbeddingSetups(db: Db, masterKey: Buffer | null) {
  const stored = await loadStored(db)
  return { active: openSetup(masterKey, stored.active), next: openSetup(masterKey, stored.next) }
}

// 只读出加密保存的各渠道 Key，不解密。用来核对主密钥是否一致
export async function sealedEmbeddingKeys(db: Db): Promise<{ sealed: Sealed; aad: string }[]> {
  const stored = await loadStored(db)
  return [...(stored.active?.channels ?? []), ...(stored.next?.channels ?? [])]
    .filter((c) => c.apiKey)
    .map((c) => ({ sealed: unseal(c.apiKey!), aad: AAD }))
}

const newId = () => randomBytes(6).toString('base64url')

// 按填的渠道建出要保存的渠道。带了 id 的沿用那个渠道保存的 Key（另一组里的也行，例如换模型时照抄现在的渠道），
// 但接口主机变了就不能沿用：否则改个地址，服务端就会把 Key 发给新主机。主机变了又没说 Key 怎么处理时报错让管理员重填，
// 而不是悄悄清掉，否则之后的后台任务会一直失败
function buildChannels(
  inputs: EmbeddingChannelInput[],
  own: StoredChannel[],
  others: StoredChannel[],
  masterKey: Buffer | null,
): StoredChannel[] {
  const ids = inputs.flatMap((c) => (c.id ? [c.id] : []))
  if (new Set(ids).size !== ids.length) throw new EmbeddingSettingsError('同一个渠道填了两次')
  return inputs.map((input, i) => {
    const mine = input.id ? own.find((c) => c.id === input.id) : undefined
    const previous = mine ?? (input.id ? others.find((c) => c.id === input.id) : undefined)
    const keep = previous ? sameOrigin(previous.baseUrl, input.baseUrl) : false
    if (!keep && previous?.apiKey && input.apiKey === undefined) {
      throw new EmbeddingSettingsError(
        `第 ${i + 1} 个渠道的接口主机变了，请重新填写 Key；不需要 Key 时填 null`,
      )
    }
    let apiKey = keep ? previous!.apiKey : null
    if (input.apiKey === null) apiKey = null
    if (typeof input.apiKey === 'string') {
      if (!masterKey) {
        throw new EmbeddingSettingsError(`保存${LABEL}的 Key 需要先配置 KIOKU_MASTER_KEY`)
      }
      const sealed = encryptSecret(masterKey, input.apiKey, AAD)
      apiKey = {
        ciphertext: sealed.ciphertext.toString('base64'),
        wrappedKey: sealed.wrappedKey.toString('base64'),
      }
    }
    return { id: mine?.id ?? newId(), baseUrl: input.baseUrl, model: input.model, apiKey }
  })
}

// 读出、改、写回在一个事务里，并锁住这一行：管理员的保存和后台任务的切换不会互相覆盖
async function mutate<T>(
  db: Db,
  change: (stored: StoredEmbedding) => { value: StoredEmbedding; result: T },
): Promise<T> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.key, KEY)).for('update')
    const { value, result } = change(normalize(row?.value))
    await tx
      .insert(settings)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    return result
  })
}

const channelsOf = (setup: StoredSetup | null) => setup?.channels ?? []

// 改正在用的模型的渠道；还没配置时就是第一次配置。模型标识变了要走换模型
export async function saveActiveEmbedding(
  db: Db,
  masterKey: Buffer | null,
  input: UpdateEmbeddingSettings,
): Promise<StoredEmbedding> {
  return mutate(db, (stored) => {
    if (stored.active && stored.active.model !== input.model) {
      throw new EmbeddingSettingsError('要换模型请用「换模型」：新模型的向量补齐之后才切过去')
    }
    const channels = buildChannels(
      input.channels,
      channelsOf(stored.active),
      channelsOf(stored.next),
      masterKey,
    )
    const value = { ...stored, active: { model: input.model, channels } }
    return { value, result: value }
  })
}

// 开始换模型，或改正在换过去的模型的渠道。换成另一个新模型时，原来那个的向量要清掉，返回它的标识
export async function saveNextEmbedding(
  db: Db,
  masterKey: Buffer | null,
  input: UpdateEmbeddingSettings,
): Promise<{ stored: StoredEmbedding; replaced: string | null }> {
  return mutate(db, (stored) => {
    if (!stored.active) throw new EmbeddingSettingsError('还没有配置嵌入模型，先配好要用的模型')
    if (stored.active.model === input.model) {
      throw new EmbeddingSettingsError(
        '新模型的标识和现在的一样；只是换接口或改请求用的模型名，改现在的渠道就行',
      )
    }
    const own = stored.next?.model === input.model ? channelsOf(stored.next) : []
    const channels = buildChannels(input.channels, own, channelsOf(stored.active), masterKey)
    const replaced = stored.next && stored.next.model !== input.model ? stored.next.model : null
    const value = { ...stored, next: { model: input.model, channels } }
    return { value, result: { stored: value, replaced } }
  })
}

// 放弃换模型，返回放弃的模型标识；没在换时返回 null
export async function clearNextEmbedding(db: Db): Promise<string | null> {
  return mutate(db, (stored) => ({
    value: { ...stored, next: null },
    result: stored.next?.model ?? null,
  }))
}

// 切到正在换过去的模型。只有它还是 expected 时才切（期间可能被放弃或换成了别的），返回原来的模型标识；没切时返回 null
export async function switchEmbedding(db: Db, expected: string): Promise<string | null> {
  return mutate(db, (stored) => {
    if (!stored.next || stored.next.model !== expected) return { value: stored, result: null }
    return {
      value: { active: stored.next, next: null },
      result: stored.active?.model ?? null,
    }
  })
}
