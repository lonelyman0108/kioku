import { EMBEDDING_DIMENSIONS } from '../../db/schema'
import {
  buildAssistantMessage,
  excerptUpstream,
  isRecord,
  normalizeFinishReason,
  normalizeToolCalls,
  numOrZero,
  parseObjectArguments,
  parseToolCalls,
  postModelJson,
  textOfContent,
  trimBase,
} from '../common'
import {
  ModelCallError,
  type ChatTurnInput,
  type ChatTurnOutput,
  type ResolvedChatProfile,
  type ResolvedEmbeddingProfile,
} from '../types'

export async function callOllamaChat(
  profile: ResolvedChatProfile,
  input: ChatTurnInput,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatTurnOutput> {
  const started = Date.now()
  const what = input.what ?? '模型接口'
  const tools = input.tools ?? []

  const messages = input.messages.map((msg) => {
    const out: Record<string, unknown> = {
      role: msg.role,
      content: textOfContent(msg.content),
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      out.tool_calls = normalizeToolCalls(msg.tool_calls).map((call) => {
        const fn = isRecord(call.function) ? call.function : null
        return {
          type: 'function',
          function: {
            name: typeof fn?.name === 'string' ? fn.name : 'unknown_tool',
            arguments: parseObjectArguments(fn?.arguments),
          },
        }
      })
    }
    return out
  })

  const { raw, parsed } = await postModelJson(
    `${trimBase(profile.baseUrl)}/api/chat`,
    {
      headers: profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {},
      body: {
        model: profile.model,
        stream: false,
        messages,
        ...(tools.length ? { tools } : {}),
        ...(profile.thinking !== 'default' ? { think: profile.thinking !== 'off' } : {}),
        ...(profile.maxTokens != null ? { options: { num_predict: profile.maxTokens } } : {}),
      },
      apiKey: profile.apiKey,
      timeoutMs,
      signal: input.signal,
      what,
      timeoutWhat: input.timeoutWhat,
      includeExcerptOnJsonError: input.includeExcerptOnJsonError,
    },
    fetchImpl,
  )

  const message = isRecord(parsed) && isRecord(parsed.message) ? parsed.message : null
  if (!message) {
    throw new ModelCallError(`${what}的响应里没有助手消息：${excerptUpstream(raw, profile.apiKey)}`)
  }
  const rawCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => {
        if (!isRecord(call) || !isRecord(call.function)) return call
        return {
          ...call,
          type: 'function',
          function: {
            ...call.function,
            arguments:
              typeof call.function.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function.arguments ?? {}),
          },
        }
      })
    : []
  const calls = normalizeToolCalls(rawCalls)
  const normalized: Record<string, unknown> = {
    role: typeof message.role === 'string' && message.role ? message.role : 'assistant',
    content: typeof message.content === 'string' ? message.content : textOfContent(message.content),
    ...(typeof message.thinking === 'string' && message.thinking
      ? { reasoning_content: message.thinking }
      : {}),
  }

  return {
    profileId: profile.profileId,
    providerName: profile.providerName,
    message: buildAssistantMessage(normalized, calls),
    toolCalls: parseToolCalls(calls),
    finishReason: normalizeFinishReason(
      'ollama',
      isRecord(parsed) ? parsed.done_reason : null,
      calls.length > 0,
    ),
    usage: {
      promptTokens: isRecord(parsed) ? numOrZero(parsed.prompt_eval_count) : 0,
      completionTokens: isRecord(parsed) ? numOrZero(parsed.eval_count) : 0,
    },
    ms: Date.now() - started,
    model: profile.model,
  }
}

export async function callOllamaEmbedding(
  profile: ResolvedEmbeddingProfile,
  texts: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  if (!texts.length) return []
  const { parsed } = await postModelJson(
    `${trimBase(profile.baseUrl)}/api/embed`,
    {
      headers: profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {},
      body: {
        model: profile.model,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      apiKey: profile.apiKey,
      timeoutMs,
      signal,
      what: '嵌入接口',
    },
    fetchImpl,
  )
  const embeddings = isRecord(parsed) && Array.isArray(parsed.embeddings) ? parsed.embeddings : []
  if (embeddings.length !== texts.length) {
    throw new ModelCallError(`嵌入接口返回 ${embeddings.length} 条，期望 ${texts.length} 条`)
  }
  return embeddings.map((vec) => {
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMENSIONS) {
      throw new ModelCallError(
        `嵌入维度是 ${Array.isArray(vec) ? vec.length : 0}，需要 ${EMBEDDING_DIMENSIONS}；请确认 Ollama 模型与 dimensions 参数支持 1024 维`,
      )
    }
    return vec as number[]
  })
}
