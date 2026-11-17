import type { UpdateEmbeddingSettings } from '@kioku/contracts'

import type { Db } from '../db/client'
import {
  clearNextEmbeddingBinding,
  loadEmbeddingSettingsState,
  loadResolvedEmbeddingSetups,
  loadStoredEmbeddingSetups,
  lockEmbeddingBindings,
  saveActiveEmbeddingBinding,
  saveNextEmbeddingBinding,
  switchEmbeddingBinding,
} from '../models/store'
import type { ResolvedEmbeddingProfile } from '../models/types'

export interface EmbeddingSetup {
  model: string
  channels: ResolvedEmbeddingProfile[]
}

export const loadEmbeddingModels = loadStoredEmbeddingSetups
export const lockEmbeddingModels = lockEmbeddingBindings
export const embeddingSettingsView = loadEmbeddingSettingsState
export const loadEmbeddingSetups = loadResolvedEmbeddingSetups

export const saveActiveEmbedding = (db: Db, input: UpdateEmbeddingSettings) =>
  saveActiveEmbeddingBinding(db, input)

export const saveNextEmbedding = (db: Db, input: UpdateEmbeddingSettings) =>
  saveNextEmbeddingBinding(db, input)

export const clearNextEmbedding = clearNextEmbeddingBinding
export const switchEmbedding = switchEmbeddingBinding
