import type { Db } from '../db/client'
import { dropBuffered, type BufferedSession } from './buffer'
import { loadExtractionConfig } from './settings'

// 一个会话的抽取任务。没配抽取模型时缓冲到期直接丢弃（设计 6.4 节）：对话缓冲只是抽取的输入，
// 不抽取就没有理由留着别人的话。配了模型时缓冲留给抽取
export async function processSession(
  db: Db,
  masterKey: Buffer | null,
  target: BufferedSession,
): Promise<void> {
  const config = await loadExtractionConfig(db, masterKey)
  if (!config) {
    await dropBuffered(db, target)
    return
  }
}
