import {
  DEFAULT_SPACE_PRIVACY,
  maskSensitiveContent,
  resolveSpacePrivacy,
  scanSensitiveContent,
  toStoredFindings,
  validateCustomRules,
  type ModelChainTestResult,
  type ModelProfileTestResult,
  type PiiKind,
  type SensitiveMatch,
  type SpacePrivacySettings,
  type StoredSensitiveFinding,
  type ToggleablePiiKind,
  type UpdateSpacePrivacySettings,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'

import type { MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import { spaces } from '../db/schema'
import { textOfContent } from '../models/common'
import { callChatFallback, callChatProfile } from '../models/execute'
import { loadPrivacyBindingResolved } from '../models/store'
import type { ResolvedChatProfile } from '../models/types'
import { fetchFailure, SettingsInputError, withoutKey } from '../settings/endpoint'

// 内置识别引擎版本号：每次内置规则或反误报逻辑调整时递增，配合空间 privacyRevision 判定存量记忆是否需要回扫
export const SENSITIVE_ENGINE_VERSION = 1

const MODEL_TIMEOUT_MS = 10_000

export type PrivacyModelConfig =
  | { mode: 'http'; baseUrl: string; apiKey: string | null; minScore: number }
  | { mode: 'model'; profiles: ResolvedChatProfile[]; minScore: number }

export async function loadPrivacyModelConfig(
  db: Db | Tx,
  masterKey: MasterKey | null,
): Promise<PrivacyModelConfig | null> {
  const resolved = await loadPrivacyBindingResolved(db, masterKey)
  return resolved.mode === 'off' ? null : resolved
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

function parseEntitySpans(text: string, content: string, minScore: number): ModelEntitySpan[] {
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
    if (typeof ent.score === 'number' && ent.score < minScore) continue
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

const PRIVACY_PROMPT_SYSTEM =
  'Extract personal names (person), physical addresses (address), and private account numbers (account) from the text. ' +
  'Return JSON only: {"entities":[{"text":"exact substring","label":"person|address|account","score":0.9}]}. ' +
  'Return {"entities":[]} if none.'

// 调用实例配置的本地 HTTP NER 服务（兼容 pf-serve / Presidio 风格）或已配置对话模型辅助抽取人名/住址/账号
export async function detectWithPrivacyModel(
  config: PrivacyModelConfig,
  text: string,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
): Promise<ModelEntitySpan[]> {
  if (!text.trim()) return []
  const timeoutMs = options.timeoutMs ?? MODEL_TIMEOUT_MS
  const totalSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)

  if (config.mode === 'http') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    const endpoint = config.baseUrl.endsWith('/detect')
      ? config.baseUrl
      : `${config.baseUrl}/detect`
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ texts: [text], min_score: config.minScore }),
      signal: totalSignal,
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

  const result = await callChatFallback(config.profiles, {
    messages: [
      { role: 'system', content: PRIVACY_PROMPT_SYSTEM },
      { role: 'user', content: text.slice(0, 8000) },
    ],
    signal: totalSignal,
    timeoutMs,
    what: '隐私识别模型',
  })
  return parseEntitySpans(text, textOfContent(result.message.content), config.minScore)
}

export async function testPrivacyModel(
  db: Db,
  masterKey: MasterKey | null,
): Promise<ModelChainTestResult> {
  const sample = '联系人张三住在北京市朝阳区建国路88号'
  let config: PrivacyModelConfig | null
  try {
    config = await loadPrivacyModelConfig(db, masterKey)
  } catch (err) {
    return {
      ok: false,
      results: [
        {
          profileId: null,
          providerName: null,
          model: null,
          ok: false,
          latencyMs: 0,
          error: (err as Error).message,
        },
      ],
    }
  }
  if (!config) {
    return {
      ok: false,
      results: [
        {
          profileId: null,
          providerName: null,
          model: null,
          ok: false,
          latencyMs: 0,
          error: '隐私识别模型尚未启用或配置不完整',
        },
      ],
    }
  }
  if (config.mode === 'http') {
    const started = Date.now()
    try {
      const spans = await detectWithPrivacyModel(config, sample)
      return {
        ok: true,
        results: [
          {
            profileId: null,
            providerName: 'HTTP 识别接口',
            model: config.baseUrl,
            ok: true,
            latencyMs: Date.now() - started,
            error: null,
            findings: spans.length,
          },
        ],
      }
    } catch (err) {
      const raw = (err as Error).message
      const safe = raw
        ? withoutKey(raw, config.apiKey)
        : fetchFailure('隐私识别模型', err, '服务地址与认证信息')
      return {
        ok: false,
        results: [
          {
            profileId: null,
            providerName: 'HTTP 识别接口',
            model: config.baseUrl,
            ok: false,
            latencyMs: Date.now() - started,
            error: raw.startsWith('HTTP ')
              ? `接口返回错误（${safe}）`
              : fetchFailure('隐私识别模型', err, '服务地址、模型名与 API Key'),
          },
        ],
      }
    }
  }

  const results: ModelProfileTestResult[] = []
  for (const profile of config.profiles) {
    const started = Date.now()
    try {
      const reply = await callChatProfile(profile, {
        messages: [
          { role: 'system', content: PRIVACY_PROMPT_SYSTEM },
          { role: 'user', content: sample },
        ],
        timeoutMs: MODEL_TIMEOUT_MS,
        what: '隐私识别模型',
      })
      const spans = parseEntitySpans(sample, textOfContent(reply.message.content), config.minScore)
      results.push({
        profileId: profile.profileId,
        providerName: profile.providerName,
        model: profile.model,
        ok: true,
        latencyMs: Date.now() - started,
        error: null,
        findings: spans.length,
      })
    } catch (err) {
      results.push({
        profileId: profile.profileId,
        providerName: profile.providerName,
        model: profile.model,
        ok: false,
        latencyMs: Date.now() - started,
        error: (err as Error).message,
      })
    }
  }
  return { ok: results.some((r) => r.ok), results }
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

// 发往外部模型或向量服务前的同步脱敏（仅替换命中片段，不修改本地原文）
export function maskForOutbound(
  text: string,
  privacy: SpacePrivacySettings,
  modelSpans: readonly ModelEntitySpan[] = [],
): string {
  if (!text) return text
  return maskSensitiveContent(
    text,
    {
      credentials: privacy.credentials,
      pii: privacy.pii,
      piiKinds: privacy.piiKinds,
      customRules: privacy.customRules,
      allowlist: privacy.allowlist,
    },
    'tag',
    modelSpans,
  )
}

// 构建空间级出站脱敏器：按空间隐私策略脱敏，并在启用隐私识别模型时附加模型实体检测
export async function loadOutboundRedactor(
  db: Db,
  masterKey: MasterKey | null,
  spaceId: string,
  signal?: AbortSignal,
): Promise<(text: string) => Promise<string>> {
  const { settings: privacy } = await loadSpacePrivacy(db, spaceId)
  let modelConfig: PrivacyModelConfig | null = null
  if (privacy.pii && privacy.usePrivacyModel) {
    try {
      modelConfig = await loadPrivacyModelConfig(db, masterKey)
    } catch {
      modelConfig = null
    }
  }
  return async (text: string): Promise<string> => {
    if (!text) return text
    let modelSpans: ModelEntitySpan[] = []
    if (modelConfig && privacy.pii && privacy.usePrivacyModel) {
      try {
        modelSpans = await detectWithPrivacyModel(modelConfig, text, { signal })
      } catch {
        modelSpans = []
      }
    }
    return maskForOutbound(text, privacy, modelSpans)
  }
}
