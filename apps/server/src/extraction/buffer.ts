import { normalizeProjectSlug, type TurnEndEvent } from '@kioku/contracts'
import { and, count, eq, sql } from 'drizzle-orm'

import type { Db, Tx } from '../db/client'
import { turnBuffer } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { CHAT_LLM_SETTING_KEY, loadStoredModel } from '../models/store'

export const BATCH_TURNS = 10
export const IDLE_SECONDS = 10 * 60
export const MAX_BUFFERED_TURNS = 100
export const BUFFER_IDLE_HOURS = 24

export interface BufferedBucket {
  deviceKey: string
  projectSlug: string
}

async function trimBucket(tx: Tx, deviceKey: string, projectSlug: string): Promise<number> {
  const inBucket = and(eq(turnBuffer.deviceKey, deviceKey), eq(turnBuffer.projectSlug, projectSlug))
  await tx.execute(sql`
    delete from ${turnBuffer}
    where ${inBucket} and ${turnBuffer.id} <= (
      select ${turnBuffer.id} from ${turnBuffer}
      where ${inBucket}
      order by ${turnBuffer.id} desc
      offset ${MAX_BUFFERED_TURNS}
      limit 1
    )`)
  const [row] = await tx.select({ n: count() }).from(turnBuffer).where(inBucket)
  return row?.n ?? 0
}

export function extractionDelaySeconds(bufferedCount: number): number {
  return bufferedCount >= BATCH_TURNS ? 0 : IDLE_SECONDS
}

// 缓冲对话轮次供后台摘要抽取；未启用对话模型或 cron/subagent 上下文直接跳过
export async function bufferTurn(
  deps: Deps,
  key: KeyPrincipal,
  input: TurnEndEvent,
): Promise<boolean> {
  const chatType = input.context?.chatType
  if (chatType === 'cron' || chatType === 'subagent') return false
  if (!key.canWrite) return false

  const model = await loadStoredModel(deps.db, CHAT_LLM_SETTING_KEY)
  if (!model?.enabled) return false

  const deviceKey = (input.deviceKey ?? '').trim()
  const projectSlug = normalizeProjectSlug(input.project) ?? ''

  const buffered = await deps.db.transaction(async (tx) => {
    await tx.insert(turnBuffer).values({
      keyId: key.keyId,
      deviceKey,
      projectSlug,
      sessionId: input.sessionId,
      userText: input.user,
      replyText: input.reply,
    })
    return trimBucket(tx, deviceKey, projectSlug)
  })

  await deps.jobs?.enqueueExtraction({ deviceKey, projectSlug }, extractionDelaySeconds(buffered))
  return true
}

export async function pruneIdleTurnBuffers(db: Db): Promise<number> {
  const [row] = await db.execute<{ removed: number }>(sql`
    with idle as (
      select ${turnBuffer.deviceKey} as device_key, ${turnBuffer.projectSlug} as project_slug
      from ${turnBuffer}
      group by ${turnBuffer.deviceKey}, ${turnBuffer.projectSlug}
      having max(${turnBuffer.createdAt}) < now() - make_interval(hours => ${BUFFER_IDLE_HOURS}::int)
    ),
    gone as (
      delete from ${turnBuffer} t using idle
      where t.device_key = idle.device_key and t.project_slug = idle.project_slug
      returning 1
    )
    select count(*)::int as removed from gone`)
  return row?.removed ?? 0
}
