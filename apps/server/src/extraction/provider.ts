import { fetchFailure, upstreamJson, withoutKey, type EndpointConfig } from '../settings/endpoint'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletion {
  content: string
  usage: { promptTokens: number; completionTokens: number }
}

export interface ChatModel {
  model: string
  complete(messages: ChatMessage[], options?: { timeoutMs?: number }): Promise<ChatCompletion>
}

// 推理模型想得久，抽取一批对话可能要一两分钟；连通性测试也按这个等，免得慢一点的模型被报成不通
const DEFAULT_TIMEOUT_MS = 120_000

// OpenAI 兼容的 /chat/completions 接口（例如 new-api 转发的模型）。不传 temperature、response_format、
// max_tokens：推理模型常常不接受这些参数，传了会整个请求被拒；要 JSON 时在提示语里说明，再宽松地解析
export function openAiChatModel(
  config: EndpointConfig,
  fetchImpl: typeof fetch = fetch,
): ChatModel {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    model: config.model,
    async complete(messages, options = {}) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err: unknown) => {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`抽取模型 ${Math.ceil(timeoutMs / 1000)} 秒内未返回`)
        }
        throw new Error(fetchFailure('抽取模型', err))
      })
      if (!res.ok) {
        // 先去掉 Key 再截断：先截断的话，截在 Key 中间时留下的半截就换不掉了
        const text = withoutKey(await res.text(), config.apiKey).slice(0, 300)
        throw new Error(`抽取模型返回 HTTP ${res.status}：${text}`)
      }
      const body = (await upstreamJson(res, '抽取模型')) as {
        choices?: { message?: { content?: unknown } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const choice = body.choices?.[0]
      if (!choice) throw new Error('抽取模型的响应里没有 choices')
      return {
        content: textOf(choice.message?.content),
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? 0,
          completionTokens: body.usage?.completion_tokens ?? 0,
        },
      }
    },
  }
}

// 回答的正文：多数接口给字符串；有的给分段数组（[{ type: 'text', text }]），把文字段拼起来；没有时是空字符串
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('')
}
