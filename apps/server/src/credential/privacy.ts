import {
  DEFAULT_SPACE_PRIVACY,
  resolveSpacePrivacy,
  scanSensitiveContent,
  toStoredFindings,
  validateCustomRules,
  type PiiKind,
  type PrivacyModelMode,
  type PrivacyModelSettingsView,
  type PrivacyModelTestResult,
  type SensitiveMatch,
  type SpacePrivacySettings,
  type StoredSensitiveFinding,
  type ToggleablePiiKind,
  type UpdatePrivacyModelSettings,
  type UpdateSpacePrivacySettings,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'

import type { Sealed } from '../crypto/envelope'
import type { MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import { settings, spaces } from '../db/schema'
import {
  fetchFailure,
  openApiKey,
  resolveApiKey,
  SettingsInputError,
  unsealJson,
  withoutKey,
  type SealedJson,
} from '../settings/endpoint'

// 内置识别引擎版本号：每次内置规则或反误报逻辑调整时递增，配合空间 privacyRevision 判定存量记忆是否需要回扫
export const SENSITIVE_ENGINE_VERSION = 1

export const PRIVACY_MODEL_KEY = 'privacy_model'
const PRIVACY_MODEL_AAD = `settings:${PRIVACY_MODEL_KEY}`
const MODEL_TIMEOUT_MS = 10_000

interface StoredPrivacyModel {
  mode: PrivacyModelMode
  baseUrl: string | null
  model: string | null
  apiKey: SealedJson | null
  minScore: number
}

export interface PrivacyModelConfig {
  mode: Exclude<PrivacyModelMode, 'off'>
  baseUrl: string
  model: string | null
  apiKey: string | null
  minScore: number
}

function normalizeUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new SettingsInputError('服务地址格式不正确')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SettingsInputError('服务地址只能使用 http 或 https')
  }
  return trimmed.replace(/\/+$/, '')
}

async function readStoredPrivacyModel(db: Db | Tx): Promise<StoredPrivacyModel> {
  const [row] = await db.select().from(settings).where(eq(settings.key, PRIVACY_MODEL_KEY))
  const v = (row?.value ?? {}) as Partial<StoredPrivacyModel>
  return {
    mode: v.mode === 'http' || v.mode === 'openai' ? v.mode : 'off',
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : null,
    model: typeof v.model === 'string' ? v.model : null,
    apiKey: v.apiKey ?? null,
    minScore: typeof v.minScore === 'number' ? Math.min(1, Math.max(0, v.minScore)) : 0.6,
  }
}

export async function privacyModelSettingsView(db: Db | Tx): Promise<PrivacyModelSettingsView> {
  const stored = await readStoredPrivacyModel(db)
  return {
    mode: stored.mode,
    configured:
      stored.mode !== 'off' &&
      Boolean(stored.baseUrl) &&
      (stored.mode === 'http' || Boolean(stored.model)),
    baseUrl: stored.baseUrl,
    model: stored.model,
    hasApiKey: stored.apiKey !== null,
    minScore: stored.minScore,
  }
}

export async function loadPrivacyModelConfig(
  db: Db | Tx,
  masterKey: MasterKey | null,
): Promise<PrivacyModelConfig | null> {
  const stored = await readStoredPrivacyModel(db)
  if (stored.mode === 'off' || !stored.baseUrl) return null
  if (stored.mode === 'openai' && !stored.model) return null
  const apiKey = stored.apiKey
    ? openApiKey(masterKey, stored.apiKey, PRIVACY_MODEL_AAD, '隐私识别模型', 'API Key')
    : null
  return {
    mode: stored.mode,
    baseUrl: stored.baseUrl,
    model: stored.model,
    apiKey,
    minScore: stored.minScore,
  }
}

export async function savePrivacyModelConfig(
  db: Db,
  masterKey: MasterKey | null,
  input: UpdatePrivacyModelSettings,
): Promise<PrivacyModelSettingsView> {
  if (input.mode === 'off') {
    await db.delete(settings).where(eq(settings.key, PRIVACY_MODEL_KEY))
    return privacyModelSettingsView(db)
  }
  const baseUrl = normalizeUrl(input.baseUrl)
  if (!baseUrl) {
    throw new SettingsInputError('请填写隐私识别模型服务地址')
  }
  const model = input.model?.trim() || null
  if (input.mode === 'openai' && !model) {
    throw new SettingsInputError('OpenAI 兼容模式需要填写模型名称')
  }
  // 读出、校验同源沿用与写回放在同一事务里并加行锁，避免和主密钥轮换竞态覆盖
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, PRIVACY_MODEL_KEY))
      .for('update')
    const prevRaw = (row?.value ?? {}) as Partial<StoredPrivacyModel>
    const previous =
      typeof prevRaw.baseUrl === 'string' && prevRaw.baseUrl
        ? { baseUrl: prevRaw.baseUrl, apiKey: prevRaw.apiKey ?? null }
        : undefined
    const trimmedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : input.apiKey
    const normalizedKey = trimmedKey === '' ? undefined : trimmedKey
    const apiKey = resolveApiKey(
      previous,
      { baseUrl, apiKey: normalizedKey },
      masterKey,
      PRIVACY_MODEL_AAD,
      '隐私识别模型',
      { name: 'API Key' },
    )
    const next: StoredPrivacyModel = {
      mode: input.mode,
      baseUrl,
      model,
      apiKey,
      minScore: Math.min(1, Math.max(0, input.minScore ?? 0.6)),
    }
    await tx
      .insert(settings)
      .values({ key: PRIVACY_MODEL_KEY, value: next })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedAt: new Date() },
      })
    return privacyModelSettingsView(tx)
  })
}

export async function clearPrivacyModelConfig(db: Db): Promise<void> {
  await db.delete(settings).where(eq(settings.key, PRIVACY_MODEL_KEY))
}

export async function sealedPrivacyModelKey(
  db: Db,
): Promise<{ sealed: Sealed; aad: string; keyId: string | null } | null> {
  const stored = await readStoredPrivacyModel(db)
  if (!stored.apiKey) return null
  return {
    sealed: unsealJson(stored.apiKey),
    aad: PRIVACY_MODEL_AAD,
    keyId: stored.apiKey.keyId ?? null,
  }
}

export async function mapPrivacyModelKey(
  db: Db,
  change: (sealed: SealedJson, aad: string) => SealedJson,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, PRIVACY_MODEL_KEY))
      .for('update')
    if (!row) return 0
    const stored = row.value as StoredPrivacyModel
    if (!stored.apiKey) return 0
    const after = change(stored.apiKey, PRIVACY_MODEL_AAD)
    if (after === stored.apiKey) return 0
    await tx
      .update(settings)
      .set({ value: { ...stored, apiKey: after }, updatedAt: new Date() })
      .where(eq(settings.key, PRIVACY_MODEL_KEY))
    return 1
  })
}

const MODEL_LABEL_MAP: Record<string, PiiKind> = {
  person: 'person',
  private_person: 'person',
  name: 'person',
  address: 'address',
  private_address: 'address',
  location: 'address',
  account: 'account',
  account_number: 'account',
  phone: 'phone',
  private_phone: 'phone',
  email: 'email',
  private_email: 'email',
}

export interface ModelEntitySpan {
  start: number
  end: number
  kind: PiiKind
}

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

// 调用实例配置的本地 HTTP NER 服务（兼容 pf-serve / Presidio 风格）或 OpenAI 兼容小模型抽取人名/住址/账号
export async function detectWithPrivacyModel(
  config: PrivacyModelConfig,
  text: string,
): Promise<ModelEntitySpan[]> {
  if (!text.trim()) return []
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  if (config.mode === 'http') {
    const endpoint = config.baseUrl.endsWith('/detect')
      ? config.baseUrl
      : `${config.baseUrl}/detect`
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ texts: [text], min_score: config.minScore }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const body = (await res.json()) as {
      spans?: { start?: number; end?: number; label?: string; score?: number }[]
      results?: { start?: number; end?: number; label?: string; score?: number }[][]
    }
    const items = body.results?.[0] ?? body.spans ?? []
    const out: ModelEntitySpan[] = []
    for (const item of items) {
      if (typeof item.start !== 'number' || typeof item.end !== 'number') continue
      if (item.start < 0 || item.end > text.length || item.start >= item.end) continue
      if (typeof item.score === 'number' && item.score < config.minScore) continue
      const mapped = MODEL_LABEL_MAP[String(item.label ?? '').toLowerCase()]
      if (!mapped) continue
      out.push({ start: item.start, end: item.end, kind: mapped })
    }
    return out
  }

  // OpenAI 兼容小模型模式：要求输出严格 JSON 实体文本，再在原文定位下标
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Extract personal names (person), physical addresses (address), and private account numbers (account) from the text. ' +
            'Return JSON only: {"entities":[{"text":"exact substring","label":"person|address|account","score":0.9}]}. ' +
            'Return {"entities":[]} if none.',
        },
        { role: 'user', content: text.slice(0, 8000) },
      ],
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[]
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  const first = content.indexOf('{')
  const last = content.lastIndexOf('}')
  if (first < 0 || last <= first) return []
  let parsed: { entities?: { text?: string; label?: string; score?: number }[] }
  try {
    parsed = JSON.parse(content.slice(first, last + 1)) as typeof parsed
  } catch {
    return []
  }
  const out: ModelEntitySpan[] = []
  for (const ent of parsed.entities ?? []) {
    const snippet = typeof ent.text === 'string' ? ent.text.trim() : ''
    if (snippet.length < 2) continue
    if (typeof ent.score === 'number' && ent.score < config.minScore) continue
    const mapped = MODEL_LABEL_MAP[String(ent.label ?? '').toLowerCase()]
    if (!mapped) continue
    let from = 0
    for (;;) {
      const idx = text.indexOf(snippet, from)
      if (idx < 0) break
      out.push({ start: idx, end: idx + snippet.length, kind: mapped })
      from = idx + snippet.length
    }
  }
  return out
}

export async function testPrivacyModel(
  db: Db,
  masterKey: MasterKey | null,
): Promise<PrivacyModelTestResult> {
  let config: PrivacyModelConfig | null
  try {
    config = await loadPrivacyModelConfig(db, masterKey)
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
  if (!config) {
    return { ok: false, message: '隐私识别模型尚未启用或配置不完整' }
  }
  const started = Date.now()
  try {
    const spans = await detectWithPrivacyModel(config, '联系人张三住在北京市朝阳区建国路88号')
    return {
      ok: true,
      message: '连接成功',
      latencyMs: Date.now() - started,
      findings: spans.length,
    }
  } catch (err) {
    const raw = (err as Error).message
    const safe = raw
      ? withoutKey(raw, config.apiKey)
      : fetchFailure('隐私识别模型', err, '服务地址与认证信息')
    return {
      ok: false,
      message: raw.startsWith('HTTP ')
        ? `接口返回错误（${safe}）`
        : fetchFailure('隐私识别模型', err, '服务地址、模型名与 API Key'),
      latencyMs: Date.now() - started,
    }
  }
}

// ---- 空间级隐私设置与内容扫描 ----

export async function loadSpacePrivacy(
  db: Db | Tx,
  spaceId: string,
): Promise<{ settings: SpacePrivacySettings; revision: number }> {
  const [row] = await db
    .select({ privacy: spaces.privacy, revision: spaces.privacyRevision })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
  if (!row) {
    return { settings: { ...DEFAULT_SPACE_PRIVACY }, revision: SENSITIVE_ENGINE_VERSION }
  }
  const settings = resolveSpacePrivacy(row.privacy as Partial<SpacePrivacySettings>)
  return { settings, revision: currentRevision(row.revision) }
}

export function currentRevision(spacePrivacyRevision: number): number {
  return spacePrivacyRevision * 1000 + SENSITIVE_ENGINE_VERSION
}

export async function bumpSpacePrivacyRevision(db: Db, spaceId: string): Promise<void> {
  await db
    .update(spaces)
    .set({ privacyRevision: sql`${spaces.privacyRevision} + 1` })
    .where(eq(spaces.id, spaceId))
}

export async function bumpPrivacyModelRevisions(db: Db): Promise<void> {
  await db
    .update(spaces)
    .set({ privacyRevision: sql`${spaces.privacyRevision} + 1` })
    .where(sql`coalesce((${spaces.privacy}->>'usePrivacyModel')::boolean, false)`)
}

export async function saveSpacePrivacy(
  db: Db,
  spaceId: string,
  input: UpdateSpacePrivacySettings,
): Promise<{ settings: SpacePrivacySettings; revision: number }> {
  const current = await loadSpacePrivacy(db, spaceId)
  const piiKinds = { ...current.settings.piiKinds }
  if (input.piiKinds) {
    for (const [k, v] of Object.entries(input.piiKinds)) {
      if (v !== undefined) piiKinds[k as ToggleablePiiKind] = v
    }
  }
  const merged = resolveSpacePrivacy({
    ...current.settings,
    ...(input.credentials !== undefined ? { credentials: input.credentials } : {}),
    ...(input.pii !== undefined ? { pii: input.pii } : {}),
    piiKinds,
    ...(input.customRules !== undefined ? { customRules: input.customRules } : {}),
    ...(input.allowlist !== undefined ? { allowlist: input.allowlist } : {}),
    ...(input.usePrivacyModel !== undefined ? { usePrivacyModel: input.usePrivacyModel } : {}),
  })
  const checked = validateCustomRules(merged.customRules)
  if (!checked.ok) {
    throw new SettingsInputError(checked.error)
  }
  const allowlist = [
    ...new Set(merged.allowlist.map((w) => w.trim()).filter((w) => w.length >= 2)),
  ].slice(0, 200)
  const next: SpacePrivacySettings = {
    ...merged,
    customRules: checked.rules,
    allowlist,
  }
  const [updated] = await db
    .update(spaces)
    .set({
      privacy: next,
      privacyRevision: sql`${spaces.privacyRevision} + 1`,
    })
    .where(eq(spaces.id, spaceId))
    .returning({ revision: spaces.privacyRevision })
  return {
    settings: next,
    revision: currentRevision(updated?.revision ?? 1),
  }
}

export interface SensitiveScanOutcome {
  matches: SensitiveMatch[]
  modelSpans: ModelEntitySpan[]
  hasCredential: boolean
  hasPii: boolean
  findings: StoredSensitiveFinding[]
}

export function evaluateSensitiveContent(
  text: string,
  privacy: SpacePrivacySettings,
  modelSpans: readonly ModelEntitySpan[] = [],
): SensitiveScanOutcome {
  const matches = scanSensitiveContent(text, {
    credentials: privacy.credentials,
    pii: privacy.pii,
    piiKinds: privacy.piiKinds,
    customRules: privacy.customRules,
    allowlist: privacy.allowlist,
  })

  const allowSet = new Set(
    privacy.allowlist.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2),
  )
  const mergedFindings: StoredSensitiveFinding[] = toStoredFindings(matches)
  const keptModelSpans: ModelEntitySpan[] = []

  if (privacy.pii && privacy.usePrivacyModel && modelSpans.length) {
    for (const sp of modelSpans) {
      const val = text.slice(sp.start, sp.end).trim().toLowerCase()
      if (allowSet.has(val)) continue
      if (matches.some((m) => !(sp.end <= m.start || sp.start >= m.end))) continue
      keptModelSpans.push(sp)
      mergedFindings.push({
        category: 'pii',
        kind: sp.kind,
        line: lineNumberAt(text, sp.start),
      })
    }
  }

  const hasCredential = mergedFindings.some((f) => f.category === 'credential')
  const hasPii = mergedFindings.some((f) => f.category === 'pii')
  return {
    matches,
    modelSpans: keptModelSpans,
    hasCredential,
    hasPii,
    findings: mergedFindings,
  }
}
