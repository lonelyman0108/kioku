import { and, asc, eq, isNotNull, isNull, lt, ne } from 'drizzle-orm'

import type { MasterKey } from '../crypto/keyring'
import { withCircle, type Db } from '../db/client'
import { circles, entries, entryVariants } from '../db/schema'
import {
  detectWithPrivacyModel,
  evaluateSensitiveContent,
  loadCirclePrivacy,
  loadPrivacyModelConfig,
  type ModelEntitySpan,
  type PrivacyModelConfig,
} from './privacy'

const RESCAN_BATCH = 100

// 按记忆圈分批异步回扫非机密变体切片的敏感命中结果；外部模型调用在事务外完成，写回时核对切片正文未变
export async function rescanCircleSensitive(
  db: Db,
  masterKey: MasterKey | null,
  circleId: string,
): Promise<number> {
  const { settings, revision } = await loadCirclePrivacy(db, circleId)
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
    const batch = await withCircle(db, circleId, (tx) =>
      tx
        .select({
          variantId: entryVariants.id,
          content: entryVariants.content,
        })
        .from(entryVariants)
        .innerJoin(entries, eq(entries.id, entryVariants.entryId))
        .where(
          and(
            isNull(entries.deletedAt),
            isNotNull(entryVariants.content),
            ne(entryVariants.sensitivity, 'secret'),
            lt(entryVariants.sensitiveRevision, revision),
          ),
        )
        .orderBy(asc(entryVariants.id))
        .limit(RESCAN_BATCH),
    )
    if (!batch.length) break

    const results: {
      variantId: string
      content: string
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
        variantId: row.variantId,
        content: text,
        hasCredential: outcome.hasCredential,
        hasPii: outcome.hasPii,
        findings: outcome.findings,
      })
    }

    await withCircle(db, circleId, async (tx) => {
      for (const r of results) {
        await tx
          .update(entryVariants)
          .set({
            sensitiveRevision: revision,
            sensitiveCredential: r.hasCredential,
            sensitivePii: r.hasPii,
            sensitiveFindings: r.findings,
          })
          .where(
            and(
              eq(entryVariants.id, r.variantId),
              eq(entryVariants.content, r.content),
              lt(entryVariants.sensitiveRevision, revision),
            ),
          )
      }
    })
    updated += results.length
  }
  return updated
}

// 引擎升级后回扫所有记忆圈
export async function rescanAllCirclesSensitive(
  db: Db,
  masterKey: MasterKey | null,
): Promise<number> {
  const all = await db.select({ id: circles.id }).from(circles)
  let total = 0
  for (const { id } of all) {
    total += await rescanCircleSensitive(db, masterKey, id)
  }
  return total
}
