import { and, asc, eq, lte } from 'drizzle-orm'

import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { apiKeys, turnBuffer } from '../db/schema'
import type { EntryService } from '../memory/service'
import { chatComplete } from '../models/client'
import { CHAT_LLM_SETTING_KEY, loadResolvedModel } from '../models/store'
import type { BufferedBucket } from './buffer'
import { buildEpisodeMessages, evaluateEpisodeResponse } from './prompt'
import { buildSemanticRepairMessages } from './dreamPrompt'

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
  signal?: AbortSignal,
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
  // 按原密钥 ID 读取终端名、环境与场域边界（不过滤 revokedAt），避免密钥在去抖窗口内轮换或吊销时丢失终端身份与场域隔离
  const [keyRow] = await db
    .select({ name: apiKeys.name, envs: apiKeys.envs, allowedRealms: apiKeys.allowedRealms })
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

  const deviceName = keyRow.name?.trim() ?? ''
  const messages = buildEpisodeMessages(rows, {
    ...(bucket.projectSlug ? { projectSlug: bucket.projectSlug } : {}),
    ...(bucket.deviceKey ? { deviceKey: bucket.deviceKey } : {}),
    ...(deviceName ? { deviceName } : {}),
  })

  const result = await chatComplete(conn, messages, {
    temperature: 0.2,
    jsonMode: true,
    maxTokens: 600,
    timeoutMs: 90_000,
    taskKind: 'fast',
    maxRetries: 1,
    ...(signal ? { signal } : {}),
  })
  let evaluated = evaluateEpisodeResponse(result.content)
  if (evaluated.status === 'invalid' && !signal?.aborted) {
    const repairMessages = buildSemanticRepairMessages(
      messages,
      `上次输出解析失败（${evaluated.reason}）。请严格只输出单个合法 JSON 对象：{"title":"简短标题","summary":"摘要"}；若无可记录结论则输出 {"title":"","summary":""}。`,
    )
    const retryResult = await chatComplete(conn, repairMessages, {
      temperature: 0,
      jsonMode: true,
      maxTokens: 600,
      timeoutMs: 90_000,
      taskKind: 'fast',
      maxRetries: 0,
      ...(signal ? { signal } : {}),
    })
    evaluated = evaluateEpisodeResponse(retryResult.content)
  }

  // 解析仍失败时保留 turn_buffer 并抛错交由队列重试，避免丢弃未消费对话轮次
  if (evaluated.status === 'invalid') {
    throw new Error(`会话摘要模型输出无效：${evaluated.reason}`)
  }

  await db
    .delete(turnBuffer)
    .where(
      and(
        eq(turnBuffer.deviceKey, bucket.deviceKey),
        eq(turnBuffer.projectSlug, bucket.projectSlug),
        lte(turnBuffer.id, lastRow.id),
      ),
    )

  if (evaluated.status === 'empty') {
    return { turns: rows.length, createdShortId: null, skippedReason: 'no_summary' }
  }

  const created = await entryService.writeEpisode({
    title: evaluated.data.title,
    content: evaluated.data.summary,
    deviceKey: bucket.deviceKey,
    projectSlug: bucket.projectSlug,
    envs: keyRow.envs,
    realms: keyRow.allowedRealms ?? [],
    projects: bucket.projectSlug ? [bucket.projectSlug] : [],
  })

  return { turns: rows.length, createdShortId: created.shortId }
}
