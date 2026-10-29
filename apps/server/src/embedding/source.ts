import type { Db } from '../db/client'
import { channelEmbedder, type Embedder } from './provider'
import { loadEmbeddingSetups, type EmbeddingSetup } from './settings'

export interface EmbedderSource {
  // 召回与写入正在用的模型；没配置时为 null
  get(): Promise<Embedder | null>
  // 正在换过去的模型；没在换时为 null
  next(): Promise<Embedder | null>
  // 设置变更后调用，下次读取时重新读库
  invalidate(): void
}

const embedderOf = (setup: EmbeddingSetup | null) =>
  setup && channelEmbedder(setup.model, setup.channels)

export function settingsEmbedderSource(db: Db, masterKey: Buffer | null): EmbedderSource {
  let cached: Promise<{ active: Embedder | null; next: Embedder | null }> | null = null
  const load = () => {
    // 读取失败不缓存，下次召回会重试，避免一次数据库抖动让向量召回在整个进程里失效
    cached ??= loadEmbeddingSetups(db, masterKey)
      .then((s) => ({ active: embedderOf(s.active), next: embedderOf(s.next) }))
      .catch((err: unknown) => {
        cached = null
        throw err
      })
    return cached
  }
  return {
    get: async () => (await load()).active,
    next: async () => (await load()).next,
    invalidate() {
      cached = null
    },
  }
}

export function staticEmbedderSource(
  embedder: Embedder | null,
  next: Embedder | null = null,
): EmbedderSource {
  return { get: async () => embedder, next: async () => next, invalidate() {} }
}
