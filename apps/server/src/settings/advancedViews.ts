import {
  CIRCLE_TUNING_KEYS,
  CLIENT_TUNING_KEYS,
  TUNING_DEFAULTS,
  TUNING_KEYS,
  type CircleAdvancedView,
  type ClientAdvancedSummary,
  type ClientAdvancedView,
  type InstanceAdvancedView,
  type TuningKey,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'

import { eachCircle, withCircle, type Db } from '../db/client'
import { circles, clients } from '../db/schema'
import { system as dreamSystem } from '../extraction/dreamPrompt'
import { SUMMARY_SYSTEM, SYSTEM as EXTRACTION_SYSTEM } from '../extraction/prompt'
import { CHAT_FAMILIES, CHAT_GUIDANCE, GUIDANCE, HOST_CONTEXT_LIMIT } from '../lifecycle/lifecycle'
import {
  CLIENT_ADVANCED_FIELD,
  loadClientLayers,
  loadInstanceAdvanced,
  parseCircleAdvanced,
  parseClientAdvanced,
  resolveTuning,
} from './advanced'

// 管理界面看的高级设置：各级的覆盖、生效值与来源

const clientAdvanced = sql<unknown>`${clients.config} -> ${CLIENT_ADVANCED_FIELD}::text`.mapWith(
  clients.config,
)

// 实例：每项被几个记忆圈、几个接入实例覆盖
async function overriddenBy(db: Db): Promise<InstanceAdvancedView['overriddenBy']> {
  const counts = Object.fromEntries(
    TUNING_KEYS.map((k) => [k, { circles: 0, clients: 0 }]),
  ) as Record<TuningKey, { circles: number; clients: number }>
  const all = await db.select({ advanced: circles.advanced }).from(circles)
  for (const circle of all) {
    const overrides = parseCircleAdvanced(circle.advanced)
    for (const key of CIRCLE_TUNING_KEYS) if (overrides[key] !== undefined) counts[key].circles++
  }
  await eachCircle(db, async (tx) => {
    const rows = await tx.select({ advanced: clientAdvanced }).from(clients)
    for (const row of rows) {
      const client = parseClientAdvanced(row.advanced)
      for (const key of CLIENT_TUNING_KEYS) if (client[key] !== undefined) counts[key].clients++
    }
  })
  return counts
}

const FIXED_RULES = {
  'prompts.extractionRules': [EXTRACTION_SYSTEM, SUMMARY_SYSTEM],
  'prompts.dreamRules': [
    dreamSystem({ mode: 'entry' }),
    dreamSystem({ mode: 'talk' }),
    dreamSystem({ mode: 'local_session' }),
  ],
}

export async function instanceAdvancedView(db: Db): Promise<InstanceAdvancedView> {
  const overrides = await loadInstanceAdvanced(db)
  return {
    builtin: TUNING_DEFAULTS,
    overrides,
    effective: resolveTuning({ instance: overrides }).values,
    overriddenBy: await overriddenBy(db),
    fixedPrompts: {
      'prompts.agentGuidance': [GUIDANCE],
      'prompts.chatGuidance': [CHAT_GUIDANCE],
      ...FIXED_RULES,
    },
  }
}

export async function circleAdvancedView(
  db: Db,
  circleId: string,
  canEdit: boolean,
): Promise<CircleAdvancedView> {
  const [instance, [circle], clientRows] = await Promise.all([
    loadInstanceAdvanced(db),
    db.select({ advanced: circles.advanced }).from(circles).where(eq(circles.id, circleId)),
    withCircle(db, circleId, (tx) =>
      tx
        .select({ id: clients.id, name: clients.name, advanced: clientAdvanced })
        .from(clients)
        .orderBy(clients.name, clients.id),
    ),
  ])
  const overrides = parseCircleAdvanced(circle?.advanced)
  const resolved = resolveTuning({ instance, circle: overrides })
  const summaries: ClientAdvancedSummary[] = clientRows.flatMap((row) => {
    const { 'prompts.guidance': guidance, ...tuning } = parseClientAdvanced(row.advanced)
    const hasGuidance = guidance !== undefined && guidance.trim() !== ''
    return Object.keys(tuning).length || hasGuidance
      ? [{ id: row.id, name: row.name, overrides: tuning, hasGuidance }]
      : []
  })
  return {
    overrides,
    effective: resolved.values,
    sources: resolved.sources,
    instance: resolveTuning({ instance }).values,
    instancePrompts: {
      'prompts.extractionRules': instance['prompts.extractionRules'] ?? null,
      'prompts.dreamRules': instance['prompts.dreamRules'] ?? null,
    },
    fixedPrompts: FIXED_RULES,
    clients: summaries,
    clientLimits: Object.entries(HOST_CONTEXT_LIMIT).map(([runtimeFamily, chars]) => ({
      runtimeFamily,
      chars,
    })),
    canEdit,
  }
}

export async function clientAdvancedView(
  db: Db,
  circleId: string,
  client: { id: string; runtimeFamily: string },
  canEdit: boolean,
): Promise<ClientAdvancedView> {
  const layers = await withCircle(db, circleId, (tx) => loadClientLayers(tx, circleId, client.id))
  const resolved = resolveTuning(layers)
  const chat = CHAT_FAMILIES.has(client.runtimeFamily)
  const instanceGuidance = layers.instance[chat ? 'prompts.chatGuidance' : 'prompts.agentGuidance']
  return {
    overrides: layers.client,
    effective: resolved.values,
    sources: resolved.sources,
    inherited: resolveTuning({ instance: layers.instance, circle: layers.circle }).values,
    guidance: {
      kind: chat ? 'chat' : 'agent',
      fixed: chat ? CHAT_GUIDANCE : GUIDANCE,
      instance: instanceGuidance ?? null,
    },
    canEdit,
  }
}
