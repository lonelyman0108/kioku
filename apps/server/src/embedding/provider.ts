import { EMBEDDING_DIMENSIONS } from '../db/schema'
import { fetchFailure, withoutKey, type EndpointConfig } from '../settings/endpoint'

// signal 是调用方的总时限（例如召回不能等太久）；timeoutMs 是每个接口最多等多久，不填时 30 秒
export interface EmbedOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface Embedder {
  model: string
  embed(texts: string[], options?: EmbedOptions): Promise<number[][]>
}

export type EmbeddingConfig = EndpointConfig

const TIMEOUT_MS = 30_000

// OpenAI 兼容的 /embeddings 接口；要求服务端支持 dimensions 参数（例如 Qwen3-Embedding、text-embedding-3）。
// model 是请求时用的模型名
export function openAiEmbedder(config: EmbeddingConfig, fetchImpl: typeof fetch = fetch): Embedder {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`
  return {
    model: config.model,
    async embed(texts, { signal, timeoutMs = TIMEOUT_MS } = {}) {
      if (!texts.length) return []
      const timeout = AbortSignal.timeout(timeoutMs)
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
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }).catch((err: unknown) => {
        // 取消了也不照原样抛：请求头不合法的错误比取消先报出来，文字里带着 Key（见 fetchFailure）
        if (timeout.aborted) throw new Error(`嵌入接口 ${Math.ceil(timeoutMs / 1000)} 秒内没有返回`)
        if (signal?.aborted) throw new Error('调用方的总时限到了，或者服务要停了')
        throw new Error(fetchFailure('嵌入接口', err))
      })
      if (!res.ok) {
        // 先去掉 Key 再截断：先截断的话，截在 Key 中间时留下的半截就换不掉了
        const text = withoutKey(await res.text(), config.apiKey).slice(0, 300)
        throw new Error(`嵌入接口返回 HTTP ${res.status}：${text}`)
      }
      const body = (await res.json()) as { data?: { index: number; embedding: number[] }[] }
      const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index)
      if (data.length !== texts.length) {
        throw new Error(`嵌入接口返回 ${data.length} 条，期望 ${texts.length} 条`)
      }
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

// 同一个模型的一组渠道，按顺序请求，出什么错都换下一个：OpenAI 兼容的网关里 400、422 也常常只是这个渠道的问题
// （模型名对不上、不支持 dimensions 参数），多试几次的代价很小。都失败时把各个渠道的错误一起报出来；
// 调用方的总时限到了就不再试。model 是向量按它存的模型标识
export function channelEmbedder(
  model: string,
  channels: EmbeddingConfig[],
  fetchImpl: typeof fetch = fetch,
): Embedder {
  const embedders = channels.map((c) => openAiEmbedder(c, fetchImpl))
  return {
    model,
    async embed(texts, options = {}) {
      const { signal } = options
      const errors: string[] = []
      for (const [i, embedder] of embedders.entries()) {
        if (signal?.aborted) break
        try {
          return await embedder.embed(texts, options)
        } catch (err) {
          errors.push(`渠道 ${i + 1}：${(err as Error).message}`)
        }
      }
      if (signal?.aborted && errors.length < embedders.length) {
        errors.push('等待时间用完了，后面的渠道没有再试')
      }
      throw new Error(errors.length === 1 ? errors[0] : `所有渠道都失败了。${errors.join('；')}`)
    },
  }
}
