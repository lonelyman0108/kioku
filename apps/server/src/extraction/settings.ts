import type { Db } from '../db/client'
import {
  clearEndpointConfig,
  endpointSettingsView,
  loadEndpointConfig,
  saveEndpointConfig,
  sealedEndpointKey,
  type EndpointInput,
  type ModelEndpoint,
} from '../settings/endpoint'

// 抽取模型和嵌入接口一样在实例设置里配（OpenAI 兼容接口、模型与 Key）。没配时不抽取，
// 对话缓冲到期后直接丢弃；清掉设置，抽取随即停止
export const EXTRACTION_ENDPOINT: ModelEndpoint = { key: 'extraction', label: '抽取模型' }

export const sealedExtractionKey = (db: Db) => sealedEndpointKey(db, EXTRACTION_ENDPOINT)

export const loadExtractionConfig = (db: Db, masterKey: Buffer | null) =>
  loadEndpointConfig(db, masterKey, EXTRACTION_ENDPOINT)

export const saveExtractionConfig = (db: Db, masterKey: Buffer | null, input: EndpointInput) =>
  saveEndpointConfig(db, masterKey, EXTRACTION_ENDPOINT, input)

export const extractionSettingsView = (db: Db) => endpointSettingsView(db, EXTRACTION_ENDPOINT)

export const clearExtractionConfig = (db: Db) => clearEndpointConfig(db, EXTRACTION_ENDPOINT)
