import type { Db } from '../db/client'
import {
  endpointSettingsView,
  loadEndpointConfig,
  saveEndpointConfig,
  sealedEndpointKey,
  type EndpointInput,
  type ModelEndpoint,
} from '../settings/endpoint'

export const EMBEDDING_ENDPOINT: ModelEndpoint = { key: 'embedding', label: '嵌入接口' }

// 只读出加密保存的嵌入接口 Key，不解密；没有保存 Key 时返回 null。用来核对主密钥是否一致
export const sealedEmbeddingKey = (db: Db) => sealedEndpointKey(db, EMBEDDING_ENDPOINT)

export const loadEmbeddingConfig = (db: Db, masterKey: Buffer | null) =>
  loadEndpointConfig(db, masterKey, EMBEDDING_ENDPOINT)

export const saveEmbeddingConfig = (db: Db, masterKey: Buffer | null, input: EndpointInput) =>
  saveEndpointConfig(db, masterKey, EMBEDDING_ENDPOINT, input)

export const embeddingSettingsView = (db: Db) => endpointSettingsView(db, EMBEDDING_ENDPOINT)
