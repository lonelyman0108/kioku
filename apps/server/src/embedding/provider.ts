import { EMBEDDING_DIMENSIONS } from '../db/schema'
import type { EndpointConfig } from '../settings/endpoint'

export interface Embedder {
  model: string
  embed(texts: string[]): Promise<number[][]>
}

export type EmbeddingConfig = EndpointConfig

const TIMEOUT_MS = 30_000

// 嵌入接口给了错误的响应：HTTP 状态码不是 2xx 时带上状态码，条数或维度不对时为 null
export class EmbeddingResponseError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
  }
}

// OpenAI 兼容的 /embeddings 接口；要求服务端支持 dimensions 参数（例如 Qwen3-Embedding、text-embedding-3）。
// model 是请求时用的模型名
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
        throw new EmbeddingResponseError(
          `嵌入接口返回 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`,
          res.status,
        )
      }
      const body = (await res.json()) as { data?: { index: number; embedding: number[] }[] }
      const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index)
      if (data.length !== texts.length) {
        throw new EmbeddingResponseError(`嵌入接口返回 ${data.length} 条，期望 ${texts.length} 条`)
      }
      for (const d of data) {
        if (d.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new EmbeddingResponseError(
            `嵌入维度是 ${d.embedding.length}，需要 ${EMBEDDING_DIMENSIONS}；请确认模型支持 dimensions 参数`,
          )
        }
      }
      return data.map((d) => d.embedding)
    },
  }
}

// 请求本身有问题（格式不对、太长），换哪个渠道都一样错，不再试别的渠道
const REQUEST_PROBLEMS = new Set([400, 413, 422])

// 同一个模型的一组渠道，按顺序请求：网络出错、超时、鉴权失败、限流、5xx、条数或维度不对时换下一个，
// 请求本身有问题时直接报错；都失败时把各个渠道的错误一起报出来。model 是向量按它存的模型标识
export function channelEmbedder(
  model: string,
  channels: EmbeddingConfig[],
  fetchImpl: typeof fetch = fetch,
): Embedder {
  const embedders = channels.map((c) => openAiEmbedder(c, fetchImpl))
  return {
    model,
    async embed(texts) {
      const errors: string[] = []
      for (const [i, embedder] of embedders.entries()) {
        try {
          return await embedder.embed(texts)
        } catch (err) {
          if (err instanceof EmbeddingResponseError && REQUEST_PROBLEMS.has(err.status ?? 0)) {
            throw err
          }
          errors.push(`渠道 ${i + 1}：${(err as Error).message}`)
        }
      }
      throw new Error(errors.length === 1 ? errors[0] : `所有渠道都失败了。${errors.join('；')}`)
    },
  }
}
