import { EMBEDDING_DIMENSIONS } from '../db/schema'

export interface Embedder {
  model: string
  embed(texts: string[]): Promise<number[][]>
}

export interface EmbeddingConfig {
  baseUrl: string
  model: string
  apiKey: string | null
}

const TIMEOUT_MS = 30_000

// OpenAI 兼容的 /embeddings 接口；要求服务端支持 dimensions 参数（例如 Qwen3-Embedding、text-embedding-3）
export function openAiEmbedder(config: EmbeddingConfig, fetchImpl: typeof fetch = fetch): Embedder {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`
  return {
    model: config.model,
    async embed(texts) {
      if (!texts.length) return []
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          input: texts,
          dimensions: EMBEDDING_DIMENSIONS,
          encoding_format: 'float',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        throw new Error(`嵌入接口返回 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`)
      }
      const body = (await res.json()) as { data?: { index: number; embedding: number[] }[] }
      const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index)
      if (data.length !== texts.length)
        throw new Error(`嵌入接口返回 ${data.length} 条，期望 ${texts.length} 条`)
      for (const d of data) {
        if (d.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `嵌入维度是 ${d.embedding.length}，需要 ${EMBEDDING_DIMENSIONS}；请确认模型支持 dimensions 参数`,
          )
        }
      }
      return data.map((d) => d.embedding)
    },
  }
}
