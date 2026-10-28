import type { Db } from '../db/client'
import { dropBuffered, type BufferedSession } from './buffer'
import { loadExtractionConfig } from './settings'

// 一批缓冲的抽取任务。抽取模型的设置在缓冲之后被清掉了，就把这一批丢掉：不抽取就没有理由留着别人的话
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
