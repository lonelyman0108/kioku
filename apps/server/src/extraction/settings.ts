import type { MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import {
  createModelProvider,
  loadDreamProfiles,
  loadExtractionProfiles,
  loadModelRegistryView,
  saveExtractionBinding,
} from '../models/store'
import type { EndpointInput } from '../settings/endpoint'

export async function hasExtractionModel(db: Db | Tx): Promise<boolean> {
  const view = await loadModelRegistryView(db)
  return view.bindings.extraction.configured
}

export async function loadExtractionConfig(db: Db | Tx, masterKey: MasterKey | null) {
  const profiles = await loadExtractionProfiles(db, masterKey)
  return profiles.length ? profiles : null
}

export async function loadDreamConfig(db: Db | Tx, masterKey: MasterKey | null) {
  const profiles = await loadDreamProfiles(db, masterKey)
  return profiles.length ? profiles : null
}

// 供测试与初始化快捷配置单个抽取模型，底层写入服务商与用途绑定
export async function saveExtractionConfig(
  db: Db,
  masterKey: MasterKey | null,
  input: EndpointInput,
): Promise<void> {
  const { provider } = await createModelProvider(db, masterKey, {
    name: '抽取模型',
    format: 'openai-chat',
    baseUrl: input.baseUrl,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    profiles: [
      {
        kind: 'chat',
        label: null,
        model: input.model,
        thinking: 'default',
        thinkingStyle: 'auto',
      },
    ],
  })
  await saveExtractionBinding(db, { profileIds: [provider.profiles[0]!.id] })
}

export async function clearExtractionConfig(db: Db): Promise<void> {
  await saveExtractionBinding(db, { profileIds: [] })
}
