import { createHash, randomBytes } from 'node:crypto'

import type {
  BenchAgentModelOption,
  DreamBindingMode,
  DreamBindingView,
  EmbeddingChannelView,
  EmbeddingSetupView,
  ExtractionBindingView,
  ModelBindingsView,
  ModelFormat,
  ModelProfileKind,
  ModelProfileView,
  ModelProviderView,
  ModelRegistryView,
  PrivacyBindingMode,
  PrivacyBindingView,
  ThinkingLevel,
  ThinkingStyle,
  UpdateDreamBinding,
  UpdateEmbeddingSettings,
  UpdateExtractionBinding,
  UpdatePrivacyBinding,
  UpsertModelProvider,
} from '@kioku/contracts'
import { eq, inArray } from 'drizzle-orm'

import type { Sealed } from '../crypto/envelope'
import type { MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import { settings } from '../db/schema'
import {
  ApiKeyLockedError,
  openApiKey,
  resolveApiKey,
  SettingsInputError,
  unsealJson,
  type SealedJson,
} from '../settings/endpoint'
import { endpointAddress } from './common'
import type { ResolvedChatProfile, ResolvedEmbeddingProfile } from './types'

export const MODEL_PROVIDERS_KEY = 'model-providers'
export const MODEL_BINDINGS_KEY = 'model-bindings'
export const MODEL_PROVIDERS_AAD = `settings:${MODEL_PROVIDERS_KEY}`
export const PRIVACY_HTTP_AAD = 'settings:model-bindings:privacy-http'

const LEGACY_KEYS = ['embedding', 'extraction', 'privacy_model'] as const
const ALL_KEYS = [
  'embedding',
  'extraction',
  MODEL_BINDINGS_KEY,
  MODEL_PROVIDERS_KEY,
  'privacy_model',
] as const

export interface StoredProfile {
  id: string
  kind: ModelProfileKind
  label: string | null
  model: string
  thinking?: ThinkingLevel
  thinkingStyle?: ThinkingStyle
  maxTokens?: number | null
}

export interface StoredProvider {
  id: string
  name: string
  format: ModelFormat
  baseUrl: string
  apiKey: SealedJson | null
  profiles: StoredProfile[]
}

export interface StoredProviders {
  providers: StoredProvider[]
}

export interface StoredEmbeddingSetup {
  model: string
  profileIds: string[]
}

export interface StoredBindings {
  extraction: { profileIds: string[] }
  dream: { mode: DreamBindingMode; profileIds: string[] }
  privacy: {
    mode: PrivacyBindingMode
    baseUrl: string | null
    apiKey: SealedJson | null
    profileIds: string[]
    minScore: number
  }
  embedding: {
    active: StoredEmbeddingSetup | null
    next: StoredEmbeddingSetup | null
  }
}

const emptyBindings = (): StoredBindings => ({
  extraction: { profileIds: [] },
  dream: { mode: 'inherit', profileIds: [] },
  privacy: { mode: 'off', baseUrl: null, apiKey: null, profileIds: [], minScore: 0.6 },
  embedding: { active: null, next: null },
})

const newId = () => randomBytes(6).toString('base64url')

function normalizeProviders(value: unknown): StoredProviders {
  if (!value || typeof value !== 'object') return { providers: [] }
  const raw = (value as Partial<StoredProviders>).providers
  return { providers: Array.isArray(raw) ? raw : [] }
}

function normalizeBindings(value: unknown): StoredBindings {
  const base = emptyBindings()
  if (!value || typeof value !== 'object') return base
  const raw = value as Partial<StoredBindings>
  return {
    extraction: {
      profileIds: Array.isArray(raw.extraction?.profileIds) ? raw.extraction.profileIds : [],
    },
    dream: {
      mode: raw.dream?.mode === 'custom' ? 'custom' : 'inherit',
      profileIds: Array.isArray(raw.dream?.profileIds) ? raw.dream.profileIds : [],
    },
    privacy: {
      mode:
        raw.privacy?.mode === 'http' || raw.privacy?.mode === 'model' ? raw.privacy.mode : 'off',
      baseUrl: typeof raw.privacy?.baseUrl === 'string' ? raw.privacy.baseUrl : null,
      apiKey: raw.privacy?.apiKey ?? null,
      profileIds: Array.isArray(raw.privacy?.profileIds) ? raw.privacy.profileIds : [],
      minScore:
        typeof raw.privacy?.minScore === 'number'
          ? Math.min(1, Math.max(0, raw.privacy.minScore))
          : 0.6,
    },
    embedding: {
      active: raw.embedding?.active ?? null,
      next: raw.embedding?.next ?? null,
    },
  }
}

function withLegacyAad(sealed: SealedJson | null | undefined, aad: string): SealedJson | null {
  if (!sealed) return null
  return sealed.aad ? sealed : { ...sealed, aad }
}

function normalizeLegacyEmbedding(value: unknown): {
  active: {
    model: string
    channels: { id?: string; baseUrl: string; model: string; apiKey?: SealedJson | null }[]
  } | null
  next: {
    model: string
    channels: { id?: string; baseUrl: string; model: string; apiKey?: SealedJson | null }[]
  } | null
} {
  if (!value || typeof value !== 'object') return { active: null, next: null }
  const legacy = value as { baseUrl?: unknown; model?: unknown; apiKey?: SealedJson | null }
  if (typeof legacy.baseUrl === 'string' && typeof legacy.model === 'string') {
    return {
      active: {
        model: legacy.model,
        channels: [
          { id: 'c1', baseUrl: legacy.baseUrl, model: legacy.model, apiKey: legacy.apiKey ?? null },
        ],
      },
      next: null,
    }
  }
  const stored = value as {
    active?: {
      model: string
      channels: { id?: string; baseUrl: string; model: string; apiKey?: SealedJson | null }[]
    } | null
    next?: {
      model: string
      channels: { id?: string; baseUrl: string; model: string; apiKey?: SealedJson | null }[]
    } | null
  }
  return { active: stored.active ?? null, next: stored.next ?? null }
}

async function upsertSetting(tx: Tx, key: string, value: unknown): Promise<void> {
  await tx
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

// 把旧版的 embedding / extraction / privacy_model 配置幂等迁移为 model-providers 与 model-bindings；
// 保留原密文的 aad，保证不依赖 KIOKU_MASTER_KEY 也能完成迁移与旧备份恢复
export async function migrateLegacyModelSettings(db: Db | Tx): Promise<void> {
  const run = async (tx: Tx) => {
    const rows = await tx
      .select()
      .from(settings)
      .where(inArray(settings.key, [...ALL_KEYS]))
      .orderBy(settings.key)
      .for('update')
    const byKey = new Map(rows.map((r) => [r.key, r.value]))
    const hasLegacy = LEGACY_KEYS.some((k) => byKey.has(k))
    if (!hasLegacy) return
    if (byKey.has(MODEL_PROVIDERS_KEY) || byKey.has(MODEL_BINDINGS_KEY)) {
      await tx.delete(settings).where(inArray(settings.key, [...LEGACY_KEYS]))
      return
    }

    const providers: StoredProvider[] = []
    const bindings = emptyBindings()

    const legacyExtraction = byKey.get('extraction') as
      { baseUrl?: string; model?: string; apiKey?: SealedJson | null } | undefined
    if (legacyExtraction?.baseUrl && legacyExtraction?.model) {
      const profileId = newId()
      providers.push({
        id: newId(),
        name: '抽取模型（迁移）',
        format: 'openai-chat',
        baseUrl: legacyExtraction.baseUrl,
        apiKey: withLegacyAad(legacyExtraction.apiKey, 'settings:extraction'),
        profiles: [
          {
            id: profileId,
            kind: 'chat',
            label: null,
            model: legacyExtraction.model,
            thinking: 'default',
            thinkingStyle: 'auto',
            maxTokens: null,
          },
        ],
      })
      bindings.extraction = { profileIds: [profileId] }
    }

    const legacyEmbedding = normalizeLegacyEmbedding(byKey.get('embedding'))
    const migrateSetup = (
      setup: {
        model: string
        channels: { baseUrl: string; model: string; apiKey?: SealedJson | null }[]
      } | null,
      prefix: string,
    ): StoredEmbeddingSetup | null => {
      if (!setup) return null
      const profileIds: string[] = []
      for (const [i, ch] of setup.channels.entries()) {
        const profileId = newId()
        providers.push({
          id: newId(),
          name: setup.channels.length > 1 ? `${prefix} ${i + 1}` : prefix,
          format: 'openai-chat',
          baseUrl: ch.baseUrl,
          apiKey: withLegacyAad(ch.apiKey, 'settings:embedding'),
          profiles: [{ id: profileId, kind: 'embedding', label: null, model: ch.model }],
        })
        profileIds.push(profileId)
      }
      return { model: setup.model, profileIds }
    }
    bindings.embedding = {
      active: migrateSetup(legacyEmbedding.active, '嵌入渠道（迁移）'),
      next: migrateSetup(legacyEmbedding.next, '新嵌入渠道（迁移）'),
    }

    const legacyPrivacy = byKey.get('privacy_model') as
      | {
          mode?: string
          baseUrl?: string | null
          model?: string | null
          apiKey?: SealedJson | null
          minScore?: number
        }
      | undefined
    if (legacyPrivacy && (legacyPrivacy.mode === 'http' || legacyPrivacy.mode === 'openai')) {
      const minScore =
        typeof legacyPrivacy.minScore === 'number'
          ? Math.min(1, Math.max(0, legacyPrivacy.minScore))
          : 0.6
      if (legacyPrivacy.mode === 'http' && legacyPrivacy.baseUrl) {
        bindings.privacy = {
          mode: 'http',
          baseUrl: legacyPrivacy.baseUrl,
          apiKey: withLegacyAad(legacyPrivacy.apiKey, 'settings:privacy_model'),
          profileIds: [],
          minScore,
        }
      } else if (legacyPrivacy.mode === 'openai' && legacyPrivacy.baseUrl && legacyPrivacy.model) {
        const profileId = newId()
        providers.push({
          id: newId(),
          name: '隐私识别模型（迁移）',
          format: 'openai-chat',
          baseUrl: legacyPrivacy.baseUrl,
          apiKey: withLegacyAad(legacyPrivacy.apiKey, 'settings:privacy_model'),
          profiles: [
            {
              id: profileId,
              kind: 'chat',
              label: null,
              model: legacyPrivacy.model,
              thinking: 'default',
              thinkingStyle: 'auto',
              maxTokens: null,
            },
          ],
        })
        bindings.privacy = {
          mode: 'model',
          baseUrl: null,
          apiKey: null,
          profileIds: [profileId],
          minScore,
        }
      }
    }

    await upsertSetting(tx, MODEL_PROVIDERS_KEY, { providers })
    await upsertSetting(tx, MODEL_BINDINGS_KEY, bindings)
    await tx.delete(settings).where(inArray(settings.key, [...LEGACY_KEYS]))
  }

  if ('transaction' in db && typeof db.transaction === 'function') {
    await db.transaction(run)
  } else {
    await run(db as Tx)
  }
}

async function ensureMigratedIfNeeded(db: Db | Tx): Promise<void> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [...LEGACY_KEYS]))
    .limit(1)
  if (rows.length) await migrateLegacyModelSettings(db)
}

async function loadState(db: Db | Tx): Promise<{
  providers: StoredProviders
  bindings: StoredBindings
}> {
  await ensureMigratedIfNeeded(db)
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [MODEL_PROVIDERS_KEY, MODEL_BINDINGS_KEY]))
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    providers: normalizeProviders(map.get(MODEL_PROVIDERS_KEY)),
    bindings: normalizeBindings(map.get(MODEL_BINDINGS_KEY)),
  }
}

// 统一加锁顺序：永远先锁 model-providers 再锁 model-bindings，防止交叉修改产生死锁；
// 行还不存在时先幂等建行再重新加锁，避免首次并发写入丢失更新
async function lockOrdered(
  tx: Tx,
  providersLock: 'share' | 'update',
  bindingsLock: 'share' | 'update',
): Promise<{ providers: StoredProviders; bindings: StoredBindings }> {
  let [pRow] = await tx
    .select()
    .from(settings)
    .where(eq(settings.key, MODEL_PROVIDERS_KEY))
    .for(providersLock)
  let [bRow] = await tx
    .select()
    .from(settings)
    .where(eq(settings.key, MODEL_BINDINGS_KEY))
    .for(bindingsLock)
  if (!pRow || !bRow) {
    await tx
      .insert(settings)
      .values([
        { key: MODEL_PROVIDERS_KEY, value: { providers: [] } },
        { key: MODEL_BINDINGS_KEY, value: emptyBindings() },
      ])
      .onConflictDoNothing()
    ;[pRow] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, MODEL_PROVIDERS_KEY))
      .for(providersLock)
    ;[bRow] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, MODEL_BINDINGS_KEY))
      .for(bindingsLock)
  }
  return {
    providers: normalizeProviders(pRow?.value),
    bindings: normalizeBindings(bRow?.value),
  }
}

export async function lockEmbeddingBindings(tx: Tx): Promise<{
  active: StoredEmbeddingSetup | null
  next: StoredEmbeddingSetup | null
}> {
  await ensureMigratedIfNeeded(tx)
  const [row] = await tx
    .select()
    .from(settings)
    .where(eq(settings.key, MODEL_BINDINGS_KEY))
    .for('share')
  return normalizeBindings(row?.value).embedding
}

const profileViewOf = (p: StoredProfile): ModelProfileView =>
  p.kind === 'chat'
    ? {
        id: p.id,
        kind: 'chat',
        label: p.label ?? null,
        model: p.model,
        thinking: p.thinking ?? 'default',
        thinkingStyle: p.thinkingStyle ?? 'auto',
        maxTokens: p.maxTokens ?? null,
      }
    : {
        id: p.id,
        kind: 'embedding',
        label: p.label ?? null,
        model: p.model,
      }

const providerViewOf = (p: StoredProvider): ModelProviderView => ({
  id: p.id,
  name: p.name,
  format: p.format,
  baseUrl: p.baseUrl,
  hasApiKey: Boolean(p.apiKey),
  profiles: p.profiles.map(profileViewOf),
})

function indexProfiles(stored: StoredProviders) {
  const byId = new Map<string, { provider: StoredProvider; profile: StoredProfile }>()
  for (const provider of stored.providers) {
    for (const profile of provider.profiles) {
      byId.set(profile.id, { provider, profile })
    }
  }
  return byId
}

export function buildEmbeddingSetupView(
  stored: StoredProviders,
  setup: StoredEmbeddingSetup | null,
): EmbeddingSetupView | null {
  if (!setup) return null
  const byId = indexProfiles(stored)
  const channels: EmbeddingChannelView[] = []
  for (const id of setup.profileIds) {
    const found = byId.get(id)
    if (!found) continue
    channels.push({
      id: found.profile.id,
      profileId: found.profile.id,
      providerId: found.provider.id,
      providerName: found.provider.name,
      format: found.provider.format,
      baseUrl: found.provider.baseUrl,
      model: found.profile.model,
      label: found.profile.label ?? null,
      hasApiKey: Boolean(found.provider.apiKey),
    })
  }
  return {
    model: setup.model,
    profileIds: setup.profileIds,
    channels,
  }
}

export function buildBindingsView(
  providers: StoredProviders,
  bindings: StoredBindings,
): ModelBindingsView {
  const byId = indexProfiles(providers)
  const validChat = (ids: string[]) => ids.filter((id) => byId.get(id)?.profile.kind === 'chat')
  const extractionIds = validChat(bindings.extraction.profileIds)
  const dreamIds = validChat(bindings.dream.profileIds)
  const privacyIds = validChat(bindings.privacy.profileIds)

  const extraction: ExtractionBindingView = {
    configured: extractionIds.length > 0,
    profileIds: extractionIds,
  }
  const dream: DreamBindingView = {
    configured: bindings.dream.mode === 'custom' ? dreamIds.length > 0 : extractionIds.length > 0,
    mode: bindings.dream.mode,
    profileIds: dreamIds,
  }
  const privacy: PrivacyBindingView = {
    mode: bindings.privacy.mode,
    configured:
      bindings.privacy.mode === 'http'
        ? Boolean(bindings.privacy.baseUrl)
        : bindings.privacy.mode === 'model'
          ? privacyIds.length > 0
          : false,
    baseUrl: bindings.privacy.baseUrl,
    hasApiKey: Boolean(bindings.privacy.apiKey),
    profileIds: privacyIds,
    minScore: bindings.privacy.minScore,
  }
  return { extraction, dream, privacy }
}

export async function loadModelRegistryView(db: Db | Tx): Promise<ModelRegistryView> {
  const { providers, bindings } = await loadState(db)
  return {
    providers: providers.providers.map(providerViewOf),
    bindings: buildBindingsView(providers, bindings),
  }
}

export async function loadEmbeddingSettingsState(db: Db | Tx): Promise<{
  active: EmbeddingSetupView | null
  next: EmbeddingSetupView | null
}> {
  const { providers, bindings } = await loadState(db)
  return {
    active: buildEmbeddingSetupView(providers, bindings.embedding.active),
    next: buildEmbeddingSetupView(providers, bindings.embedding.next),
  }
}

export async function loadStoredEmbeddingSetups(db: Db | Tx) {
  const { bindings } = await loadState(db)
  return bindings.embedding
}

// 给换模型任务判断设置与渠道是否改动：包含展开后的服务商格式、地址、模型名及密钥密文指纹，不解密、不泄露密钥
export async function embeddingNextSnapshot(db: Db | Tx): Promise<string | null> {
  const { providers, bindings } = await loadState(db)
  const next = bindings.embedding.next
  if (!next) return null
  const byId = indexProfiles(providers)
  const channels = next.profileIds.map((id) => {
    const found = byId.get(id)
    if (!found) return { id, missing: true }
    const keyHash = found.provider.apiKey
      ? createHash('sha256').update(found.provider.apiKey.ciphertext).digest('hex').slice(0, 12)
      : null
    return {
      id: found.profile.id,
      format: found.provider.format,
      baseUrl: found.provider.baseUrl,
      model: found.profile.model,
      keyHash,
    }
  })
  return JSON.stringify({ model: next.model, channels })
}

function referencedUsages(bindings: StoredBindings): Map<string, string[]> {
  const usages = new Map<string, string[]>()
  const add = (ids: readonly string[], label: string) => {
    for (const id of ids) {
      const list = usages.get(id) ?? []
      list.push(label)
      usages.set(id, list)
    }
  }
  add(bindings.extraction.profileIds, '抽取模型')
  if (bindings.dream.mode === 'custom') add(bindings.dream.profileIds, '整理模型')
  if (bindings.privacy.mode === 'model') add(bindings.privacy.profileIds, '隐私识别模型')
  if (bindings.embedding.active) add(bindings.embedding.active.profileIds, '当前嵌入模型')
  if (bindings.embedding.next) add(bindings.embedding.next.profileIds, '正在切换的新嵌入模型')
  return usages
}

function toStoredProfiles(input: UpsertModelProvider, existing: StoredProfile[]): StoredProfile[] {
  const seen = new Set(existing.map((p) => p.id))
  return input.profiles.map((p) => {
    const id = p.id && seen.has(p.id) ? p.id : (p.id ?? newId())
    if (p.kind === 'chat') {
      return {
        id,
        kind: 'chat',
        label: p.label?.trim() || null,
        model: p.model,
        thinking: p.thinking,
        thinkingStyle: p.thinkingStyle,
        maxTokens: p.maxTokens ?? null,
      }
    }
    return {
      id,
      kind: 'embedding',
      label: p.label?.trim() || null,
      model: p.model,
    }
  })
}

export async function createModelProvider(
  db: Db,
  masterKey: MasterKey | null,
  input: UpsertModelProvider,
): Promise<{ provider: ModelProviderView; affectsEmbedding: boolean }> {
  return db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { providers } = await lockOrdered(tx, 'update', 'share')
    const apiKey = resolveApiKey(undefined, input, masterKey, MODEL_PROVIDERS_AAD, '模型服务商')
    const created: StoredProvider = {
      id: newId(),
      name: input.name,
      format: input.format,
      baseUrl: input.baseUrl,
      apiKey,
      profiles: toStoredProfiles(input, []),
    }
    const next: StoredProviders = { providers: [...providers.providers, created] }
    await upsertSetting(tx, MODEL_PROVIDERS_KEY, next)
    return { provider: providerViewOf(created), affectsEmbedding: false }
  })
}

export async function updateModelProvider(
  db: Db,
  masterKey: MasterKey | null,
  providerId: string,
  input: UpsertModelProvider,
): Promise<{ provider: ModelProviderView; affectsEmbedding: boolean }> {
  return db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { providers, bindings } = await lockOrdered(tx, 'update', 'share')
    const index = providers.providers.findIndex((p) => p.id === providerId)
    if (index < 0) throw new SettingsInputError('找不到这个模型服务商')
    const prev = providers.providers[index]!
    const nextProfiles = toStoredProfiles(input, prev.profiles)
    const nextById = new Map(nextProfiles.map((p) => [p.id, p]))

    const usages = referencedUsages(bindings)
    for (const old of prev.profiles) {
      const usedBy = usages.get(old.id)
      if (!usedBy?.length) continue
      const updated = nextById.get(old.id)
      if (!updated) {
        throw new SettingsInputError(
          `模型「${old.label || old.model}」正在被${usedBy.join('、')}使用，请先解除绑定后再删除`,
        )
      }
      if (updated.kind !== old.kind) {
        throw new SettingsInputError(
          `模型「${old.label || old.model}」正在被${usedBy.join('、')}使用，不能更改类型`,
        )
      }
    }

    const apiKey = resolveApiKey(prev, input, masterKey, MODEL_PROVIDERS_AAD, '模型服务商')
    const updatedProvider: StoredProvider = {
      id: prev.id,
      name: input.name,
      format: input.format,
      baseUrl: input.baseUrl,
      apiKey,
      profiles: nextProfiles,
    }
    const nextProviders = [...providers.providers]
    nextProviders[index] = updatedProvider
    await upsertSetting(tx, MODEL_PROVIDERS_KEY, { providers: nextProviders })

    const embeddedIds = new Set([
      ...(bindings.embedding.active?.profileIds ?? []),
      ...(bindings.embedding.next?.profileIds ?? []),
    ])
    const affectsEmbedding = prev.profiles.some((p) => embeddedIds.has(p.id))
    return { provider: providerViewOf(updatedProvider), affectsEmbedding }
  })
}

export async function deleteModelProvider(db: Db, providerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { providers, bindings } = await lockOrdered(tx, 'update', 'share')
    const target = providers.providers.find((p) => p.id === providerId)
    if (!target) throw new SettingsInputError('找不到这个模型服务商')

    const usages = referencedUsages(bindings)
    for (const profile of target.profiles) {
      const usedBy = usages.get(profile.id)
      if (usedBy?.length) {
        throw new SettingsInputError(
          `服务商下的模型「${profile.label || profile.model}」正在被${usedBy.join('、')}使用，请先解除绑定后再删除`,
        )
      }
    }

    await upsertSetting(tx, MODEL_PROVIDERS_KEY, {
      providers: providers.providers.filter((p) => p.id !== providerId),
    })
  })
}

function assertProfilesExist(
  providers: StoredProviders,
  profileIds: readonly string[],
  expectedKind: ModelProfileKind,
) {
  const byId = indexProfiles(providers)
  for (const id of profileIds) {
    const found = byId.get(id)
    if (!found) throw new SettingsInputError(`找不到选中的模型条目（${id}）`)
    if (found.profile.kind !== expectedKind) {
      throw new SettingsInputError(
        `模型「${found.profile.label || found.profile.model}」不是${expectedKind === 'chat' ? '对话' : '嵌入'}模型`,
      )
    }
  }
}

export async function saveExtractionBinding(
  db: Db,
  input: UpdateExtractionBinding,
): Promise<ExtractionBindingView> {
  return db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { providers, bindings } = await lockOrdered(tx, 'share', 'update')
    assertProfilesExist(providers, input.profileIds, 'chat')
    const next: StoredBindings = { ...bindings, extraction: { profileIds: [...input.profileIds] } }
    await upsertSetting(tx, MODEL_BINDINGS_KEY, next)
    return buildBindingsView(providers, next).extraction
  })
}

export async function saveDreamBinding(
  db: Db,
  input: UpdateDreamBinding,
): Promise<DreamBindingView> {
  return db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { providers, bindings } = await lockOrdered(tx, 'share', 'update')
    const ids = input.mode === 'custom' ? input.profileIds : []
    assertProfilesExist(providers, ids, 'chat')
    const next: StoredBindings = {
      ...bindings,
      dream: { mode: input.mode, profileIds: [...ids] },
    }
    await upsertSetting(tx, MODEL_BINDINGS_KEY, next)
    return buildBindingsView(providers, next).dream
  })
}

export async function savePrivacyBinding(
  db: Db,
  masterKey: MasterKey | null,
  input: UpdatePrivacyBinding,
): Promise<PrivacyBindingView> {
  return db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { providers, bindings } = await lockOrdered(tx, 'share', 'update')
    const minScore = Math.min(1, Math.max(0, input.minScore ?? 0.6))

    let privacy: StoredBindings['privacy']
    if (input.mode === 'off') {
      privacy = { mode: 'off', baseUrl: null, apiKey: null, profileIds: [], minScore }
    } else if (input.mode === 'http') {
      const baseUrl = input.baseUrl?.trim().replace(/\/+$/, '') || null
      if (!baseUrl) throw new SettingsInputError('请填写隐私识别模型服务地址')
      let parsed: URL
      try {
        parsed = new URL(baseUrl)
      } catch {
        throw new SettingsInputError('服务地址格式不正确')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SettingsInputError('服务地址只能使用 http 或 https')
      }
      const previous = bindings.privacy.baseUrl
        ? { baseUrl: bindings.privacy.baseUrl, apiKey: bindings.privacy.apiKey }
        : undefined
      const apiKey = resolveApiKey(
        previous,
        { baseUrl, apiKey: input.apiKey },
        masterKey,
        PRIVACY_HTTP_AAD,
        '隐私识别模型',
        { name: 'API Key' },
      )
      privacy = { mode: 'http', baseUrl, apiKey, profileIds: [], minScore }
    } else {
      assertProfilesExist(providers, input.profileIds, 'chat')
      if (!input.profileIds.length) throw new SettingsInputError('请至少选择一个对话模型')
      privacy = {
        mode: 'model',
        baseUrl: null,
        apiKey: null,
        profileIds: [...input.profileIds],
        minScore,
      }
    }

    const next: StoredBindings = { ...bindings, privacy }
    await upsertSetting(tx, MODEL_BINDINGS_KEY, next)
    return buildBindingsView(providers, next).privacy
  })
}

export async function saveActiveEmbeddingBinding(
  db: Db,
  input: UpdateEmbeddingSettings,
): Promise<{ active: EmbeddingSetupView | null; next: EmbeddingSetupView | null }> {
  return db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { providers, bindings } = await lockOrdered(tx, 'share', 'update')
    if (bindings.embedding.active && bindings.embedding.active.model !== input.model) {
      throw new SettingsInputError('如需更换模型，请使用「更换模型」：新模型的向量补齐后才切换')
    }
    assertProfilesExist(providers, input.profileIds, 'embedding')
    const next: StoredBindings = {
      ...bindings,
      embedding: {
        ...bindings.embedding,
        active: { model: input.model, profileIds: [...input.profileIds] },
      },
    }
    await upsertSetting(tx, MODEL_BINDINGS_KEY, next)
    return {
      active: buildEmbeddingSetupView(providers, next.embedding.active),
      next: buildEmbeddingSetupView(providers, next.embedding.next),
    }
  })
}

export async function saveNextEmbeddingBinding(
  db: Db,
  input: UpdateEmbeddingSettings,
): Promise<{
  active: EmbeddingSetupView | null
  next: EmbeddingSetupView | null
  replaced: string | null
}> {
  return db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { providers, bindings } = await lockOrdered(tx, 'share', 'update')
    if (!bindings.embedding.active) {
      throw new SettingsInputError('尚未配置嵌入模型，请先配置要使用的模型')
    }
    if (bindings.embedding.active.model === input.model) {
      throw new SettingsInputError('新模型的标识与当前相同。如只需更换渠道，修改当前嵌入配置即可。')
    }
    assertProfilesExist(providers, input.profileIds, 'embedding')
    const replaced =
      bindings.embedding.next && bindings.embedding.next.model !== input.model
        ? bindings.embedding.next.model
        : null
    const next: StoredBindings = {
      ...bindings,
      embedding: {
        ...bindings.embedding,
        next: { model: input.model, profileIds: [...input.profileIds] },
      },
    }
    await upsertSetting(tx, MODEL_BINDINGS_KEY, next)
    return {
      active: buildEmbeddingSetupView(providers, next.embedding.active),
      next: buildEmbeddingSetupView(providers, next.embedding.next),
      replaced,
    }
  })
}

export async function clearNextEmbeddingBinding(db: Db): Promise<string | null> {
  return db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { bindings } = await lockOrdered(tx, 'share', 'update')
    const abandoned = bindings.embedding.next?.model ?? null
    if (!abandoned) return null
    const next: StoredBindings = {
      ...bindings,
      embedding: { ...bindings.embedding, next: null },
    }
    await upsertSetting(tx, MODEL_BINDINGS_KEY, next)
    return abandoned
  })
}

export async function switchEmbeddingBinding(db: Db, expected: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    await ensureMigratedIfNeeded(tx)
    const { bindings } = await lockOrdered(tx, 'share', 'update')
    if (!bindings.embedding.next || bindings.embedding.next.model !== expected) return null
    const oldModel = bindings.embedding.active?.model ?? null
    const next: StoredBindings = {
      ...bindings,
      embedding: { active: bindings.embedding.next, next: null },
    }
    await upsertSetting(tx, MODEL_BINDINGS_KEY, next)
    return oldModel
  })
}

function decryptProviderKey(provider: StoredProvider, masterKey: MasterKey | null): string | null {
  if (!provider.apiKey) return null
  return openApiKey(
    masterKey,
    provider.apiKey,
    MODEL_PROVIDERS_AAD,
    `模型服务商「${provider.name}」`,
  )
}

function resolveChatList(
  providers: StoredProviders,
  masterKey: MasterKey | null,
  profileIds: readonly string[],
): ResolvedChatProfile[] {
  const byId = indexProfiles(providers)
  const out: ResolvedChatProfile[] = []
  for (const id of profileIds) {
    const found = byId.get(id)
    if (!found || found.profile.kind !== 'chat') continue
    out.push({
      profileId: found.profile.id,
      providerId: found.provider.id,
      providerName: found.provider.name,
      format: found.provider.format,
      baseUrl: found.provider.baseUrl,
      apiKey: decryptProviderKey(found.provider, masterKey),
      model: found.profile.model,
      label: found.profile.label ?? null,
      thinking: found.profile.thinking ?? 'default',
      thinkingStyle: found.profile.thinkingStyle ?? 'auto',
      maxTokens: found.profile.maxTokens ?? null,
    })
  }
  return out
}

export async function resolveChatProfileById(
  db: Db | Tx,
  masterKey: MasterKey | null,
  profileId: string,
): Promise<ResolvedChatProfile | null> {
  const { providers } = await loadState(db)
  return resolveChatList(providers, masterKey, [profileId])[0] ?? null
}

export async function resolveProfileById(
  db: Db | Tx,
  masterKey: MasterKey | null,
  profileId: string,
): Promise<
  | { kind: 'chat'; profile: ResolvedChatProfile }
  | { kind: 'embedding'; profile: ResolvedEmbeddingProfile }
  | null
> {
  const { providers } = await loadState(db)
  const found = indexProfiles(providers).get(profileId)
  if (!found) return null
  const apiKey = decryptProviderKey(found.provider, masterKey)
  if (found.profile.kind === 'chat') {
    return {
      kind: 'chat',
      profile: {
        profileId: found.profile.id,
        providerId: found.provider.id,
        providerName: found.provider.name,
        format: found.provider.format,
        baseUrl: found.provider.baseUrl,
        apiKey,
        model: found.profile.model,
        label: found.profile.label ?? null,
        thinking: found.profile.thinking ?? 'default',
        thinkingStyle: found.profile.thinkingStyle ?? 'auto',
        maxTokens: found.profile.maxTokens ?? null,
      },
    }
  }
  return {
    kind: 'embedding',
    profile: {
      profileId: found.profile.id,
      providerId: found.provider.id,
      providerName: found.provider.name,
      format: found.provider.format,
      baseUrl: found.provider.baseUrl,
      apiKey,
      model: found.profile.model,
      label: found.profile.label ?? null,
    },
  }
}

export async function loadExtractionProfiles(
  db: Db | Tx,
  masterKey: MasterKey | null,
): Promise<ResolvedChatProfile[]> {
  const { providers, bindings } = await loadState(db)
  return resolveChatList(providers, masterKey, bindings.extraction.profileIds)
}

export async function loadDreamProfiles(
  db: Db | Tx,
  masterKey: MasterKey | null,
): Promise<ResolvedChatProfile[]> {
  const { providers, bindings } = await loadState(db)
  const ids =
    bindings.dream.mode === 'custom' ? bindings.dream.profileIds : bindings.extraction.profileIds
  return resolveChatList(providers, masterKey, ids)
}

export async function loadPrivacyBindingResolved(
  db: Db | Tx,
  masterKey: MasterKey | null,
): Promise<
  | { mode: 'off' }
  | { mode: 'http'; baseUrl: string; apiKey: string | null; minScore: number }
  | { mode: 'model'; profiles: ResolvedChatProfile[]; minScore: number }
> {
  const { providers, bindings } = await loadState(db)
  const p = bindings.privacy
  if (p.mode === 'http' && p.baseUrl) {
    return {
      mode: 'http',
      baseUrl: p.baseUrl,
      apiKey: p.apiKey
        ? openApiKey(masterKey, p.apiKey, PRIVACY_HTTP_AAD, '隐私识别模型', 'API Key')
        : null,
      minScore: p.minScore,
    }
  }
  if (p.mode === 'model') {
    const profiles = resolveChatList(providers, masterKey, p.profileIds)
    if (profiles.length) return { mode: 'model', profiles, minScore: p.minScore }
  }
  return { mode: 'off' }
}

export async function loadResolvedEmbeddingSetups(
  db: Db | Tx,
  masterKey: MasterKey | null,
): Promise<{
  active: { model: string; channels: ResolvedEmbeddingProfile[] } | null
  next: { model: string; channels: ResolvedEmbeddingProfile[] } | null
}> {
  const { providers, bindings } = await loadState(db)
  const byId = indexProfiles(providers)
  const resolveSetup = (setup: StoredEmbeddingSetup | null) => {
    if (!setup) return null
    const channels: ResolvedEmbeddingProfile[] = []
    for (const id of setup.profileIds) {
      const found = byId.get(id)
      if (!found || found.profile.kind !== 'embedding') continue
      channels.push({
        profileId: found.profile.id,
        providerId: found.provider.id,
        providerName: found.provider.name,
        format: found.provider.format,
        baseUrl: found.provider.baseUrl,
        apiKey: decryptProviderKey(found.provider, masterKey),
        model: found.profile.model,
        label: found.profile.label ?? null,
      })
    }
    return channels.length ? { model: setup.model, channels } : null
  }
  return {
    active: resolveSetup(bindings.embedding.active),
    next: resolveSetup(bindings.embedding.next),
  }
}

export async function loadBenchAgentModelState(
  db: Db | Tx,
  masterKey: MasterKey | null,
): Promise<{
  defaultProfileId: string | null
  models: BenchAgentModelOption[]
  anyLocked: boolean
  firstLockedError: string | null
}> {
  const { providers, bindings } = await loadState(db)
  const options: BenchAgentModelOption[] = []
  let anyLocked = false
  let firstLockedError: string | null = null

  for (const provider of providers.providers) {
    let unlockedOk = true
    try {
      decryptProviderKey(provider, masterKey)
    } catch (err) {
      unlockedOk = false
      anyLocked = true
      if (err instanceof ApiKeyLockedError && !firstLockedError) {
        firstLockedError = err.message
      }
    }
    for (const profile of provider.profiles) {
      if (profile.kind !== 'chat') continue
      options.push({
        profileId: profile.id,
        providerId: provider.id,
        providerName: provider.name,
        format: provider.format,
        model: profile.model,
        label: profile.label ?? null,
        thinking: profile.thinking ?? 'default',
        endpoint: endpointAddress(provider.baseUrl),
        available: unlockedOk,
      })
    }
  }

  const extractionPrimary = bindings.extraction.profileIds[0]
  const preferred =
    (extractionPrimary && options.find((o) => o.profileId === extractionPrimary)) ||
    options.find((o) => o.available) ||
    options[0] ||
    null

  return {
    defaultProfileId: preferred?.profileId ?? null,
    models: options,
    anyLocked,
    firstLockedError,
  }
}

// ---- 主密钥核对与轮换 ----

export async function sealedProviderKeys(
  db: Db,
): Promise<{ sealed: Sealed; aad: string; keyId: string | null }[]> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, MODEL_PROVIDERS_KEY))
    .limit(1)
  if (!row) return []
  const out: { sealed: Sealed; aad: string; keyId: string | null }[] = []
  for (const p of normalizeProviders(row.value).providers) {
    if (!p.apiKey) continue
    out.push({
      sealed: unsealJson(p.apiKey),
      aad: p.apiKey.aad ?? MODEL_PROVIDERS_AAD,
      keyId: p.apiKey.keyId ?? null,
    })
  }
  return out
}

export async function sealedPrivacyHttpKey(
  db: Db,
): Promise<{ sealed: Sealed; aad: string; keyId: string | null }[]> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, MODEL_BINDINGS_KEY))
    .limit(1)
  if (!row) return []
  const b = normalizeBindings(row.value)
  if (!b.privacy.apiKey) return []
  return [
    {
      sealed: unsealJson(b.privacy.apiKey),
      aad: b.privacy.apiKey.aad ?? PRIVACY_HTTP_AAD,
      keyId: b.privacy.apiKey.keyId ?? null,
    },
  ]
}

export async function sealedLegacyModelKeys(
  db: Db,
): Promise<{ sealed: Sealed; aad: string; keyId: string | null }[]> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [...LEGACY_KEYS]))
  const out: { sealed: Sealed; aad: string; keyId: string | null }[] = []
  for (const row of rows) {
    if (row.key === 'embedding') {
      const legacy = normalizeLegacyEmbedding(row.value)
      for (const ch of [...(legacy.active?.channels ?? []), ...(legacy.next?.channels ?? [])]) {
        if (!ch.apiKey) continue
        out.push({
          sealed: unsealJson(ch.apiKey),
          aad: ch.apiKey.aad ?? 'settings:embedding',
          keyId: ch.apiKey.keyId ?? null,
        })
      }
    } else if (row.key === 'extraction') {
      const ext = row.value as { apiKey?: SealedJson | null } | null
      if (ext?.apiKey) {
        out.push({
          sealed: unsealJson(ext.apiKey),
          aad: ext.apiKey.aad ?? 'settings:extraction',
          keyId: ext.apiKey.keyId ?? null,
        })
      }
    } else if (row.key === 'privacy_model') {
      const pm = row.value as { apiKey?: SealedJson | null } | null
      if (pm?.apiKey) {
        out.push({
          sealed: unsealJson(pm.apiKey),
          aad: pm.apiKey.aad ?? 'settings:privacy_model',
          keyId: pm.apiKey.keyId ?? null,
        })
      }
    }
  }
  return out
}

export async function mapModelProviderKeys(
  db: Db,
  change: (sealed: SealedJson, aad: string) => SealedJson,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, MODEL_PROVIDERS_KEY))
      .for('update')
    if (!row) return 0
    const stored = normalizeProviders(row.value)
    let changed = 0
    const nextProviders = stored.providers.map((p) => {
      if (!p.apiKey) return p
      const nextKey = change(p.apiKey, p.apiKey.aad ?? MODEL_PROVIDERS_AAD)
      if (nextKey === p.apiKey) return p
      changed++
      return { ...p, apiKey: nextKey }
    })
    if (changed) {
      await tx
        .update(settings)
        .set({ value: { providers: nextProviders }, updatedAt: new Date() })
        .where(eq(settings.key, MODEL_PROVIDERS_KEY))
    }
    return changed
  })
}

export async function mapPrivacyHttpKey(
  db: Db,
  change: (sealed: SealedJson, aad: string) => SealedJson,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, MODEL_BINDINGS_KEY))
      .for('update')
    if (!row) return 0
    const stored = normalizeBindings(row.value)
    if (!stored.privacy.apiKey) return 0
    const nextKey = change(stored.privacy.apiKey, stored.privacy.apiKey.aad ?? PRIVACY_HTTP_AAD)
    if (nextKey === stored.privacy.apiKey) return 0
    await tx
      .update(settings)
      .set({
        value: { ...stored, privacy: { ...stored.privacy, apiKey: nextKey } },
        updatedAt: new Date(),
      })
      .where(eq(settings.key, MODEL_BINDINGS_KEY))
    return 1
  })
}
