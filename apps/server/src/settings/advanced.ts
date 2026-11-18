import {
  CIRCLE_PROMPT_KEYS,
  CIRCLE_TUNING_KEYS,
  CLIENT_PROMPT_KEYS,
  CLIENT_TUNING_KEYS,
  CircleAdvanced,
  ClientAdvanced,
  INSTANCE_PROMPT_KEYS,
  InstanceAdvanced,
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
import { circles, clients, settings } from '../db/schema'

// 高级设置的取值：内置（contracts 的 TUNING_DEFAULTS）→ 实例（settings 表的一项）→ 记忆圈（circles.advanced）
// → 接入实例（clients.config 里的 advanced）。每一级只存覆盖了的项，逐项往下覆盖；提示词的补充不覆盖，按级叠加。
// 读的时候逐项检查，存下的某一项不成立（例如之前的版本留下的）时当作没有覆盖，不让整个召回失败

export const INSTANCE_ADVANCED_KEY = 'advanced'
// 接入实例的覆盖存在 clients.config 的这一项下；转让所有者时清掉 prompts.guidance
export const CLIENT_ADVANCED_FIELD = 'advanced'

export const withoutClientGuidance = sql`${clients.config} #- ${sql.param([CLIENT_ADVANCED_FIELD, 'prompts.guidance'])}::text[]`

export interface AdvancedLayers {
  instance?: InstanceAdvanced
  circle?: CircleAdvanced
  client?: ClientAdvanced
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
    ['circle', layers.circle],
    ['client', layers.client],
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

// 提示词的补充，按叠加的顺序：实例的在前，记忆圈或接入实例的在后。没有补充的级不列
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

// chat 是接入实例的运行时是不是聊天机器人：接入实例只有一段使用指引，接在它实际用的那一种后面
export function effectiveSettings(layers: AdvancedLayers, chat = false): EffectiveSettings {
  const { instance = {}, circle = {}, client = {} } = layers
  const clientGuidance = client['prompts.guidance']
  return {
    values: resolveTuning(layers).values,
    prompts: {
      agentGuidance: present(instance['prompts.agentGuidance'], chat ? undefined : clientGuidance),
      chatGuidance: present(instance['prompts.chatGuidance'], chat ? clientGuidance : undefined),
      extractionRules: present(
        instance['prompts.extractionRules'],
        circle['prompts.extractionRules'],
      ),
      dreamRules: present(instance['prompts.dreamRules'], circle['prompts.dreamRules']),
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
export const parseCircleAdvanced = (stored: unknown) =>
  parseLevel<CircleAdvanced>(CircleAdvanced, stored)
export const parseClientAdvanced = (stored: unknown) =>
  parseLevel<ClientAdvanced>(ClientAdvanced, stored)

// 各级能存的键，存储时只认这些
export const INSTANCE_KEYS: readonly string[] = [...TUNING_KEYS, ...INSTANCE_PROMPT_KEYS]
export const CIRCLE_KEYS: readonly string[] = [...CIRCLE_TUNING_KEYS, ...CIRCLE_PROMPT_KEYS]
export const CLIENT_KEYS: readonly string[] = [...CLIENT_TUNING_KEYS, ...CLIENT_PROMPT_KEYS]

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

// 记忆圈不是内容表（不受 RLS 限制），不必在 withCircle 里读
export async function loadCircleAdvanced(db: Db | Tx, circleId: string): Promise<CircleAdvanced> {
  const [row] = await db
    .select({ advanced: circles.advanced })
    .from(circles)
    .where(eq(circles.id, circleId))
  return parseCircleAdvanced(row?.advanced)
}

export async function saveCircleAdvanced(
  db: Db | Tx,
  circleId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db
    .update(circles)
    .set({ advanced: merged(circles.advanced, patch) })
    .where(eq(circles.id, circleId))
}

// 接入实例是内容表，tx 要在 withCircle 里
export async function saveClientAdvanced(
  tx: Tx,
  clientId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const current = sql`${clients.config} -> ${CLIENT_ADVANCED_FIELD}::text`
  await tx
    .update(clients)
    .set({
      config: sql`jsonb_set(${clients.config}, ${sql.param([CLIENT_ADVANCED_FIELD])}::text[], ${merged(current, patch)})`,
      updatedAt: new Date(),
    })
    .where(eq(clients.id, clientId))
}

const instanceValue =
  sql<unknown>`(select ${settings.value} from ${settings} where ${settings.key} = ${INSTANCE_ADVANCED_KEY})`.mapWith(
    settings.value,
  )

// 只按实例一级取值：没有记忆圈与接入实例的地方用，例如管理界面的搜索（召回权重只在实例）
export async function loadInstanceSettings(db: Db | Tx): Promise<EffectiveSettings> {
  return effectiveSettings({ instance: await loadInstanceAdvanced(db) })
}

// 按记忆圈取值（抽取与整理）：实例与记忆圈两级，一条语句读出
export async function loadCircleSettings(
  db: Db | Tx,
  circleId: string,
): Promise<EffectiveSettings> {
  const [row] = await db
    .select({
      instance: instanceValue,
      circle: circles.advanced,
    })
    .from(circles)
    .where(eq(circles.id, circleId))
  return effectiveSettings({
    instance: parseInstanceAdvanced(row?.instance),
    circle: parseCircleAdvanced(row?.circle),
  })
}

// 访问密钥的请求：实例、记忆圈与这个接入实例三级，一条语句读出。接入实例是内容表，tx 要在 withCircle 里
export async function loadClientSettings(
  tx: Tx,
  circleId: string,
  clientId: string,
  chat: boolean,
): Promise<EffectiveSettings> {
  return effectiveSettings(await loadClientLayers(tx, circleId, clientId), chat)
}

export async function loadClientLayers(
  tx: Tx,
  circleId: string,
  clientId: string,
): Promise<Required<AdvancedLayers>> {
  // 子查询里的记忆圈按参数比，不和外层的 circles 关联
  const [row] = await tx
    .select({
      instance: instanceValue,
      circle: circles.advanced,
      client:
        sql<unknown>`(select ${clients.config} -> ${CLIENT_ADVANCED_FIELD}::text from ${clients} where ${clients.id} = ${clientId} and ${clients.circleId} = ${circleId})`.mapWith(
          clients.config,
        ),
    })
    .from(circles)
    .where(eq(circles.id, circleId))
  return {
    instance: parseInstanceAdvanced(row?.instance),
    circle: parseCircleAdvanced(row?.circle),
    client: parseClientAdvanced(row?.client),
  }
}
