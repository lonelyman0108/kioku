import type { EndpointConfig } from '../embedding/settings'

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

// 推理模型想得久，抽取一批对话可能要一两分钟
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
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, messages }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
      if (!res.ok) {
        throw new Error(`抽取模型返回 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`)
      }
      const body = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const choice = body.choices?.[0]
      if (!choice) throw new Error('抽取模型的响应里没有 choices')
      return {
        content: choice.message?.content ?? '',
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? 0,
          completionTokens: body.usage?.completion_tokens ?? 0,
        },
      }
    },
  }
}
