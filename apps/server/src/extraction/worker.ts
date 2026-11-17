import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import type { ResolvedChatProfile } from '../models/types'
import { dropBuffered, type BufferedSession } from './buffer'
import { extractBatch } from './extract'
import { profilesChatModel, type ChatModel } from './provider'
import { loadExtractionConfig } from './settings'

// 一批缓冲的抽取任务。抽取模型的设置在缓冲之后被清掉了，就把这一批丢掉：不抽取就没有理由留着别人的话。
// modelFor 只在测试里换成假的模型
export async function processSession(
  db: Db,
  masterKey: MasterKey | null,
  target: BufferedSession,
  modelFor: (profiles: readonly ResolvedChatProfile[]) => ChatModel = profilesChatModel,
): Promise<void> {
  const profiles = await loadExtractionConfig(db, masterKey)
  if (!profiles?.length) {
    await dropBuffered(db, target)
    return
  }
  await extractBatch(db, masterKey, modelFor(profiles), target)
}
