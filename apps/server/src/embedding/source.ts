import type { Db } from '../db/client'
import { openAiEmbedder, type Embedder } from './provider'
import { loadEmbeddingConfig } from './settings'

export interface EmbedderSource {
  get(): Promise<Embedder | null>
  // 设置变更后调用，下次 get 重新读库
  invalidate(): void
}

export function settingsEmbedderSource(db: Db, masterKey: Buffer | null): EmbedderSource {
  let cached: Promise<Embedder | null> | null = null
  return {
    get() {
      cached ??= loadEmbeddingConfig(db, masterKey).then((c) => (c ? openAiEmbedder(c) : null))
      return cached
    },
    invalidate() {
      cached = null
    },
  }
}

export function staticEmbedderSource(embedder: Embedder | null): EmbedderSource {
  return { get: async () => embedder, invalidate() {} }
}
