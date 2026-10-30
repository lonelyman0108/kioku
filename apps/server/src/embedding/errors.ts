import { and, eq, sql } from 'drizzle-orm'

import type { Db } from '../db/client'
import { settings } from '../db/schema'

// 最近一次生成向量出错，给实例设置页看（只有实例管理员看得到，可以带接口返回的原文）。
// 和嵌入设置分开存：后台任务记错误时不会和管理员的保存互相覆盖
const KEY = 'embedding-error'
const MAX_MESSAGE = 500

export interface EmbeddingErrorRecord {
  model: string
  message: string
  at: string
}

// 记下与清掉错误都只是给管理员看的：它们自己出错时（例如数据库抖了一下）只记日志、不抛出，
// 不让已经写好的向量、还没处理的模型与要重排的记忆跟着算失败，也不让补齐整个重跑
export async function recordEmbeddingError(db: Db, model: string, message: string): Promise<void> {
  const value: EmbeddingErrorRecord = {
    model,
    message: message.slice(0, MAX_MESSAGE),
    at: new Date().toISOString(),
  }
  try {
    await db
      .insert(settings)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  } catch (err) {
    console.error('记下向量的错误时出错', err)
  }
}

// 这个模型又成功生成过向量，之前记下的它的错误就清掉；别的模型的错误留着
export async function clearEmbeddingError(db: Db, model: string): Promise<void> {
  try {
    await db
      .delete(settings)
      .where(and(eq(settings.key, KEY), sql`${settings.value}->>'model' = ${model}`))
  } catch (err) {
    console.error('清掉向量的错误时出错', err)
  }
}

export async function loadEmbeddingError(db: Db): Promise<EmbeddingErrorRecord | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  return (row?.value as EmbeddingErrorRecord | undefined) ?? null
}
