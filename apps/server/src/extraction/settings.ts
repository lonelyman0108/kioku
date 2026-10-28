import { eq } from 'drizzle-orm'

import type { Db } from '../db/client'
import { settings } from '../db/schema'
import {
  endpointSettingsView,
  loadEndpointConfig,
  saveEndpointConfig,
  type ModelEndpoint,
} from '../embedding/settings'

// 抽取模型和嵌入接口一样在实例设置里配（OpenAI 兼容接口、模型与 Key）。没配时不抽取，
// 对话缓冲到期后直接丢弃；清掉设置，抽取随即停止
export const EXTRACTION_ENDPOINT: ModelEndpoint = { key: 'extraction', label: '抽取模型' }

export const loadExtractionConfig = (db: Db, masterKey: Buffer | null) =>
  loadEndpointConfig(db, masterKey, EXTRACTION_ENDPOINT)

export const saveExtractionConfig = (
  db: Db,
  masterKey: Buffer | null,
  input: { baseUrl: string; model: string; apiKey?: string | null | undefined },
) => saveEndpointConfig(db, masterKey, EXTRACTION_ENDPOINT, input)

export const extractionSettingsView = (db: Db) => endpointSettingsView(db, EXTRACTION_ENDPOINT)

export async function clearExtractionConfig(db: Db): Promise<void> {
  await db.delete(settings).where(eq(settings.key, EXTRACTION_ENDPOINT.key))
}
