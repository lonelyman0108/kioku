import { and, asc, eq, isNotNull, isNull, lt, ne } from 'drizzle-orm'

import type { MasterKey } from '../crypto/keyring'
import { withSpace, type Db } from '../db/client'
import { memories, spaces } from '../db/schema'
import {
  detectWithPrivacyModel,
  evaluateSensitiveContent,
  loadPrivacyModelConfig,
  loadSpacePrivacy,
  type ModelEntitySpan,
  type PrivacyModelConfig,
} from './privacy'

const RESCAN_BATCH = 100

// 按空间分批异步回扫非机密记忆的敏感命中结果：先读正文，外部模型调用在事务外完成，写回时核对正文未变
export async function rescanSpaceSensitive(
  db: Db,
  masterKey: MasterKey | null,
  spaceId: string,
): Promise<number> {
  const { settings, revision } = await loadSpacePrivacy(db, spaceId)
  let modelConfig: PrivacyModelConfig | null = null
  if (settings.pii && settings.usePrivacyModel) {
    try {
      modelConfig = await loadPrivacyModelConfig(db, masterKey)
    } catch {
      modelConfig = null
    }
  }

  let updated = 0
  for (;;) {
    const batch = await withSpace(db, spaceId, (tx) =>
      tx
        .select({
          id: memories.id,
          content: memories.content,
          version: memories.version,
        })
        .from(memories)
        .where(
          and(
            isNull(memories.deletedAt),
            isNotNull(memories.content),
            ne(memories.sensitivity, 'secret'),
            lt(memories.sensitiveRevision, revision),
          ),
        )
        .orderBy(asc(memories.id))
        .limit(RESCAN_BATCH),
    )
    if (!batch.length) break

    const results: {
      id: string
      version: number
      hasCredential: boolean
      hasPii: boolean
      findings: ReturnType<typeof evaluateSensitiveContent>['findings']
    }[] = []

    for (const row of batch) {
      const text = row.content ?? ''
      let modelSpans: ModelEntitySpan[] = []
      if (modelConfig && settings.pii && settings.usePrivacyModel) {
        try {
          modelSpans = await detectWithPrivacyModel(modelConfig, text)
        } catch {
          modelSpans = []
        }
      }
      const outcome = evaluateSensitiveContent(text, settings, modelSpans)
      results.push({
        id: row.id,
        version: row.version,
        hasCredential: outcome.hasCredential,
        hasPii: outcome.hasPii,
        findings: outcome.findings,
      })
    }

    await withSpace(db, spaceId, async (tx) => {
      for (const r of results) {
        await tx
          .update(memories)
          .set({
            sensitiveRevision: revision,
            sensitiveCredential: r.hasCredential,
            sensitivePii: r.hasPii,
            sensitiveFindings: r.findings,
          })
          .where(
            and(
              eq(memories.id, r.id),
              eq(memories.version, r.version),
              lt(memories.sensitiveRevision, revision),
            ),
          )
      }
    })
    updated += results.length
  }
  return updated
}

// 引擎升级后回扫所有空间
export async function rescanAllSpacesSensitive(
  db: Db,
  masterKey: MasterKey | null,
): Promise<number> {
  const all = await db.select({ id: spaces.id }).from(spaces)
  let total = 0
  for (const { id } of all) {
    total += await rescanSpaceSensitive(db, masterKey, id)
  }
  return total
}
