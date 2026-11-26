import { and, asc, eq, lte } from 'drizzle-orm'

import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { apiKeys, turnBuffer } from '../db/schema'
import type { EntryService } from '../memory/service'
import { chatComplete } from '../models/client'
import { CHAT_LLM_SETTING_KEY, loadResolvedModel } from '../models/store'
import type { BufferedBucket } from './buffer'
import { buildEpisodeMessages, parseEpisodeSummary } from './prompt'

export interface ExtractionOutcome {
  turns: number
  createdShortId: string | null
  skippedReason?: string
}

// 从指定 (device_key, project_slug) 缓冲桶生成一条会话摘要（episode），并清理已消费轮次
export async function extractEpisodeBatch(
  db: Db,
  masterKey: MasterKey | null,
  entryService: EntryService,
  bucket: BufferedBucket,
): Promise<ExtractionOutcome> {
  const conn = await loadResolvedModel(db, masterKey, CHAT_LLM_SETTING_KEY)
  if (!conn) return { turns: 0, createdShortId: null, skippedReason: 'no_chat_model' }

  const rows = await db
    .select()
    .from(turnBuffer)
    .where(
      and(
        eq(turnBuffer.deviceKey, bucket.deviceKey),
        eq(turnBuffer.projectSlug, bucket.projectSlug),
      ),
    )
    .orderBy(asc(turnBuffer.id))

  if (!rows.length) return { turns: 0, createdShortId: null, skippedReason: 'empty' }

  const lastRow = rows.at(-1)!
  // 按原密钥 ID 读取环境与场域边界（不过滤 revokedAt），避免密钥在去抖窗口内轮换或吊销时丢失场域隔离
  const [keyRow] = await db
    .select({ envs: apiKeys.envs, allowedRealms: apiKeys.allowedRealms })
    .from(apiKeys)
    .where(eq(apiKeys.id, lastRow.keyId))
    .limit(1)

  if (!keyRow) {
    await db
      .delete(turnBuffer)
      .where(
        and(
          eq(turnBuffer.deviceKey, bucket.deviceKey),
          eq(turnBuffer.projectSlug, bucket.projectSlug),
          lte(turnBuffer.id, lastRow.id),
        ),
      )
    return { turns: rows.length, createdShortId: null, skippedReason: 'key_missing' }
  }

  const messages = buildEpisodeMessages(rows, {
    ...(bucket.projectSlug ? { projectSlug: bucket.projectSlug } : {}),
    ...(bucket.deviceKey ? { deviceKey: bucket.deviceKey } : {}),
  })

  const result = await chatComplete(conn, messages, {
    temperature: 0.2,
    jsonMode: true,
    maxTokens: 600,
    timeoutMs: 90_000,
  })
  const parsed = parseEpisodeSummary(result.content)

  await db
    .delete(turnBuffer)
    .where(
      and(
        eq(turnBuffer.deviceKey, bucket.deviceKey),
        eq(turnBuffer.projectSlug, bucket.projectSlug),
        lte(turnBuffer.id, lastRow.id),
      ),
    )

  if (!parsed) {
    return { turns: rows.length, createdShortId: null, skippedReason: 'no_summary' }
  }

  const created = await entryService.writeEpisode({
    title: parsed.title,
    content: parsed.summary,
    deviceKey: bucket.deviceKey,
    projectSlug: bucket.projectSlug,
    envs: keyRow.envs,
    realms: keyRow.allowedRealms ?? [],
    projects: bucket.projectSlug ? [bucket.projectSlug] : [],
  })

  return { turns: rows.length, createdShortId: created.shortId }
}
