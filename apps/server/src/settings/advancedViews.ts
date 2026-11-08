import {
  APP_TUNING_KEYS,
  SPACE_TUNING_KEYS,
  TUNING_DEFAULTS,
  TUNING_KEYS,
  type AppAdvancedSummary,
  type AppAdvancedView,
  type InstanceAdvancedView,
  type SpaceAdvancedView,
  type TuningKey,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'

import { withSpace, type Db } from '../db/client'
import { apps, spaces } from '../db/schema'
import { system as dreamSystem } from '../extraction/dreamPrompt'
import { SUMMARY_SYSTEM, SYSTEM as EXTRACTION_SYSTEM } from '../extraction/prompt'
import { CHAT_FAMILIES, CHAT_GUIDANCE, GUIDANCE } from '../lifecycle/lifecycle'
import {
  APP_ADVANCED_FIELD,
  loadAppLayers,
  loadInstanceAdvanced,
  parseAppAdvanced,
  parseSpaceAdvanced,
  resolveTuning,
} from './advanced'

// 管理界面看的高级设置：各级的覆盖、生效值与来源

// 原样的 sql 片段不经过列的解码，jsonb 回来是文本：按 jsonb 列解码
const appAdvanced = sql<unknown>`${apps.config} -> ${APP_ADVANCED_FIELD}::text`.mapWith(apps.config)

// 实例：每项被几个空间、几个应用覆盖。应用是内容表，逐个空间读
async function overriddenBy(db: Db): Promise<InstanceAdvancedView['overriddenBy']> {
  const counts = Object.fromEntries(TUNING_KEYS.map((k) => [k, { spaces: 0, apps: 0 }])) as Record<
    TuningKey,
    { spaces: number; apps: number }
  >
  const all = await db.select({ id: spaces.id, advanced: spaces.advanced }).from(spaces)
  for (const space of all) {
    const overrides = parseSpaceAdvanced(space.advanced)
    for (const key of SPACE_TUNING_KEYS) if (overrides[key] !== undefined) counts[key].spaces++
    const rows = await withSpace(db, space.id, (tx) =>
      tx.select({ advanced: appAdvanced }).from(apps),
    )
    for (const row of rows) {
      const app = parseAppAdvanced(row.advanced)
      for (const key of APP_TUNING_KEYS) if (app[key] !== undefined) counts[key].apps++
    }
  }
  return counts
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
      'prompts.extractionRules': [EXTRACTION_SYSTEM, SUMMARY_SYSTEM],
      'prompts.dreamRules': [dreamSystem({ talk: false }), dreamSystem({ talk: true })],
    },
  }
}

export async function spaceAdvancedView(
  db: Db,
  spaceId: string,
  canEdit: boolean,
): Promise<SpaceAdvancedView> {
  const [instance, [space], appRows] = await Promise.all([
    loadInstanceAdvanced(db),
    db.select({ advanced: spaces.advanced }).from(spaces).where(eq(spaces.id, spaceId)),
    withSpace(db, spaceId, (tx) =>
      tx
        .select({ id: apps.id, name: apps.name, advanced: appAdvanced })
        .from(apps)
        .orderBy(apps.name, apps.id),
    ),
  ])
  const overrides = parseSpaceAdvanced(space?.advanced)
  const resolved = resolveTuning({ instance, space: overrides })
  const summaries: AppAdvancedSummary[] = appRows.flatMap((row) => {
    const { 'prompts.guidance': guidance, ...tuning } = parseAppAdvanced(row.advanced)
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
    apps: summaries,
    canEdit,
  }
}

export async function appAdvancedView(
  db: Db,
  spaceId: string,
  app: { id: string; runtimeFamily: string },
  canEdit: boolean,
): Promise<AppAdvancedView> {
  const layers = await withSpace(db, spaceId, (tx) => loadAppLayers(tx, spaceId, app.id))
  const resolved = resolveTuning(layers)
  const chat = CHAT_FAMILIES.has(app.runtimeFamily)
  const instanceGuidance = layers.instance[chat ? 'prompts.chatGuidance' : 'prompts.agentGuidance']
  return {
    overrides: layers.app,
    effective: resolved.values,
    sources: resolved.sources,
    inherited: resolveTuning({ instance: layers.instance, space: layers.space }).values,
    guidance: {
      kind: chat ? 'chat' : 'agent',
      fixed: chat ? CHAT_GUIDANCE : GUIDANCE,
      instance: instanceGuidance ?? null,
    },
    canEdit,
  }
}
