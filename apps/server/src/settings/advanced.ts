import {
  APP_PROMPT_KEYS,
  APP_TUNING_KEYS,
  AppAdvanced,
  INSTANCE_PROMPT_KEYS,
  InstanceAdvanced,
  SPACE_PROMPT_KEYS,
  SPACE_TUNING_KEYS,
  SpaceAdvanced,
  TUNING_DEFAULTS,
  TUNING_KEYS,
  TuningValues,
  type SettingSource,
  type TuningKey,
  type TuningSources,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import type { z } from 'zod'

import type { Db, Tx } from '../db/client'
import { apps, settings, spaces } from '../db/schema'

// 高级设置的取值：内置（contracts 的 TUNING_DEFAULTS）→ 实例（settings 表的一项）→ 空间（spaces.advanced）
// → 应用（apps.config 里的 advanced）。每一级只存覆盖了的项，逐项往下覆盖；提示词的补充不覆盖，按级叠加。
// 读的时候逐项检查，存下的某一项不成立（例如之前的版本留下的）时当作没有覆盖，不让整个召回失败

export const INSTANCE_ADVANCED_KEY = 'advanced'
// 应用的覆盖存在 apps.config 的这一项下。AppConfig 的契约里没有它：AppConfig 随 whoami 交给访问密钥的持有者，
// 也随应用的修改整个替换（见 routes/apps.ts，修改应用时保留这一项）
export const APP_ADVANCED_FIELD = 'advanced'

export interface AdvancedLayers {
  instance?: InstanceAdvanced
  space?: SpaceAdvanced
  app?: AppAdvanced
}

export interface ResolvedTuning {
  values: TuningValues
  sources: TuningSources
}

// 逐项取值：后面的级覆盖前面的
export function resolveTuning(layers: AdvancedLayers): ResolvedTuning {
  const values = { ...TUNING_DEFAULTS } as Record<TuningKey, unknown>
  const sources = Object.fromEntries(TUNING_KEYS.map((k) => [k, 'builtin'])) as Record<
    TuningKey,
    SettingSource
  >
  const levels = [
    ['instance', layers.instance],
    ['space', layers.space],
    ['app', layers.app],
  ] as const
  for (const [source, overrides] of levels) {
    if (!overrides) continue
    for (const key of TUNING_KEYS) {
      const value = (overrides as Partial<Record<TuningKey, unknown>>)[key]
      if (value === undefined) continue
      values[key] = value
      sources[key] = source
    }
  }
  return { values: values as TuningValues, sources }
}

// 提示词的补充，按叠加的顺序：实例的在前，空间或应用的在后。没有补充的级不列
export interface PromptSupplements {
  agentGuidance: string[]
  chatGuidance: string[]
  extractionRules: string[]
  dreamRules: string[]
}

export interface EffectiveSettings {
  values: TuningValues
  prompts: PromptSupplements
}

const present = (...texts: (string | undefined)[]) =>
  texts.filter((t): t is string => t !== undefined && t.trim() !== '')

// chat 是应用的运行时是不是群聊机器人：应用只有一段使用指引，接在它实际用的那一种后面
export function effectiveSettings(layers: AdvancedLayers, chat = false): EffectiveSettings {
  const { instance = {}, space = {}, app = {} } = layers
  const appGuidance = app['prompts.guidance']
  return {
    values: resolveTuning(layers).values,
    prompts: {
      agentGuidance: present(instance['prompts.agentGuidance'], chat ? undefined : appGuidance),
      chatGuidance: present(instance['prompts.chatGuidance'], chat ? appGuidance : undefined),
      extractionRules: present(
        instance['prompts.extractionRules'],
        space['prompts.extractionRules'],
      ),
      dreamRules: present(instance['prompts.dreamRules'], space['prompts.dreamRules']),
    },
  }
}

// 召回各路的权重
export interface RecallWeights {
  semantic: number
  fulltext: number
  glossaryFirst: number
  glossaryMore: number
  priority: number
}

export const weightsOf = (values: TuningValues): RecallWeights => ({
  semantic: values['recallWeights.semantic'],
  fulltext: values['recallWeights.fulltext'],
  glossaryFirst: values['recallWeights.glossaryFirst'],
  glossaryMore: values['recallWeights.glossaryMore'],
  priority: values['recallWeights.priority'],
})

// 固定部分在前，补充接在后面，每段另起一行
export function withSupplements(fixed: string, supplements: readonly string[]): string {
  return [fixed, ...supplements].join('\n')
}

// 存下的覆盖逐项检查，不成立的项去掉
function parseLevel<T>(schema: z.ZodObject, stored: unknown): T {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {} as T
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    const value = (stored as Record<string, unknown>)[key]
    if (value === undefined) continue
    const parsed = (field as z.ZodType).safeParse(value)
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data
  }
  return out as T
}

export const parseInstanceAdvanced = (stored: unknown) =>
  parseLevel<InstanceAdvanced>(InstanceAdvanced, stored)
export const parseSpaceAdvanced = (stored: unknown) =>
  parseLevel<SpaceAdvanced>(SpaceAdvanced, stored)
export const parseAppAdvanced = (stored: unknown) => parseLevel<AppAdvanced>(AppAdvanced, stored)

// 各级能存的键，存储时只认这些
export const INSTANCE_KEYS: readonly string[] = [...TUNING_KEYS, ...INSTANCE_PROMPT_KEYS]
export const SPACE_KEYS: readonly string[] = [...SPACE_TUNING_KEYS, ...SPACE_PROMPT_KEYS]
export const APP_KEYS: readonly string[] = [...APP_TUNING_KEYS, ...APP_PROMPT_KEYS]

// 修改：给了值的项写上，null 的项去掉；补充只有空白时也去掉（空的补充和没有一样）
export function splitPatch(patch: Record<string, unknown>): {
  set: Record<string, unknown>
  remove: string[]
} {
  const set: Record<string, unknown> = {}
  const remove: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const blank = typeof value === 'string' && !value.trim()
    if (value === null || blank) remove.push(key)
    else set[key] = value
  }
  return { set, remove }
}

// jsonb 的合并：先并上要写的，再去掉要恢复的；在一条语句里做，同时改不同项的两个请求不会互相盖掉
const merged = (current: unknown, patch: Record<string, unknown>) => {
  const { set, remove } = splitPatch(patch)
  return sql`(coalesce(${current}, '{}'::jsonb) || ${JSON.stringify(set)}::jsonb) - ${sql.param(remove)}::text[]`
}

export async function loadInstanceAdvanced(db: Db | Tx): Promise<InstanceAdvanced> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, INSTANCE_ADVANCED_KEY))
  return parseInstanceAdvanced(row?.value)
}

export async function saveInstanceAdvanced(
  db: Db | Tx,
  patch: Record<string, unknown>,
): Promise<void> {
  const { set } = splitPatch(patch)
  await db
    .insert(settings)
    .values({ key: INSTANCE_ADVANCED_KEY, value: set })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: merged(settings.value, patch), updatedAt: new Date() },
    })
}

// 空间不是内容表（不受 RLS 限制），不必在 withSpace 里读
export async function loadSpaceAdvanced(db: Db | Tx, spaceId: string): Promise<SpaceAdvanced> {
  const [row] = await db
    .select({ advanced: spaces.advanced })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
  return parseSpaceAdvanced(row?.advanced)
}

export async function saveSpaceAdvanced(
  db: Db | Tx,
  spaceId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db
    .update(spaces)
    .set({ advanced: merged(spaces.advanced, patch) })
    .where(eq(spaces.id, spaceId))
}

// 应用是内容表，tx 要在 withSpace 里
export async function saveAppAdvanced(
  tx: Tx,
  appId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const current = sql`${apps.config} -> ${APP_ADVANCED_FIELD}::text`
  await tx
    .update(apps)
    .set({
      config: sql`jsonb_set(${apps.config}, ${sql.param([APP_ADVANCED_FIELD])}::text[], ${merged(current, patch)})`,
      updatedAt: new Date(),
    })
    .where(eq(apps.id, appId))
}

// 实例的覆盖，作为子查询和空间、应用一起读。原样的 sql 片段不经过列的解码，jsonb 回来是文本：按 jsonb 列解码
const instanceValue =
  sql<unknown>`(select ${settings.value} from ${settings} where ${settings.key} = ${INSTANCE_ADVANCED_KEY})`.mapWith(
    settings.value,
  )

// 只按实例一级取值：没有空间与应用的地方用，例如管理界面的搜索（召回权重只在实例）
export async function loadInstanceSettings(db: Db | Tx): Promise<EffectiveSettings> {
  return effectiveSettings({ instance: await loadInstanceAdvanced(db) })
}

// 按空间取值（抽取与整理）：实例与空间两级，一条语句读出
export async function loadSpaceSettings(db: Db | Tx, spaceId: string): Promise<EffectiveSettings> {
  const [row] = await db
    .select({
      instance: instanceValue,
      space: spaces.advanced,
    })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
  return effectiveSettings({
    instance: parseInstanceAdvanced(row?.instance),
    space: parseSpaceAdvanced(row?.space),
  })
}

// 访问密钥的请求：实例、空间与这个应用三级，一条语句读出。应用是内容表，tx 要在 withSpace 里
export async function loadAppSettings(
  tx: Tx,
  spaceId: string,
  appId: string,
  chat: boolean,
): Promise<EffectiveSettings> {
  return effectiveSettings(await loadAppLayers(tx, spaceId, appId), chat)
}

export async function loadAppLayers(
  tx: Tx,
  spaceId: string,
  appId: string,
): Promise<Required<AdvancedLayers>> {
  // 子查询里的空间按参数比，不和外层的 spaces 关联：单表查询里 drizzle 写出的列名不带表名，关联会指到 apps 自己的列
  const [row] = await tx
    .select({
      instance: instanceValue,
      space: spaces.advanced,
      app: sql<unknown>`(select ${apps.config} -> ${APP_ADVANCED_FIELD}::text from ${apps} where ${apps.id} = ${appId} and ${apps.spaceId} = ${spaceId})`.mapWith(
        apps.config,
      ),
    })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
  return {
    instance: parseInstanceAdvanced(row?.instance),
    space: parseSpaceAdvanced(row?.space),
    app: parseAppAdvanced(row?.app),
  }
}
