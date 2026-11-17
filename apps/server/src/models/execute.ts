import { withoutKey } from '../settings/endpoint'
import { callAnthropic } from './adapters/anthropic'
import { callGemini, callGeminiEmbedding } from './adapters/gemini'
import { callOllamaChat, callOllamaEmbedding } from './adapters/ollama'
import { callOpenAiChat, callOpenAiEmbedding } from './adapters/openaiChat'
import { callOpenAiResponses } from './adapters/openaiResponses'
import {
  ModelCallError,
  type ChatTurnInput,
  type ChatTurnOutput,
  type ResolvedChatProfile,
  type ResolvedEmbeddingProfile,
} from './types'

const DEFAULT_CHAT_TIMEOUT_MS = 120_000
const DEFAULT_EMBED_TIMEOUT_MS = 30_000

export async function callChatProfile(
  profile: ResolvedChatProfile,
  input: ChatTurnInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatTurnOutput> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
  switch (profile.format) {
    case 'openai-chat':
      return callOpenAiChat(profile, input, timeoutMs, fetchImpl)
    case 'openai-responses':
      return callOpenAiResponses(profile, input, timeoutMs, fetchImpl)
    case 'anthropic':
      return callAnthropic(profile, input, timeoutMs, fetchImpl)
    case 'gemini':
      return callGemini(profile, input, timeoutMs, fetchImpl)
    case 'ollama':
      return callOllamaChat(profile, input, timeoutMs, fetchImpl)
  }
}

const redactAll = (text: string, items: readonly { apiKey: string | null }[]) =>
  items.reduce((out, item) => withoutKey(out, item.apiKey), text)

export async function callChatFallback(
  profiles: readonly ResolvedChatProfile[],
  input: ChatTurnInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatTurnOutput> {
  if (!profiles.length) throw new ModelCallError('尚未配置可用的对话模型')
  const errors: string[] = []
  for (const [i, profile] of profiles.entries()) {
    if (input.signal?.aborted) break
    try {
      return await callChatProfile(profile, input, fetchImpl)
    } catch (err) {
      const label = profile.label
        ? `${profile.providerName}/${profile.label}`
        : `${profile.providerName}/${profile.model}`
      errors.push(`模型 ${i + 1}（${label}）：${redactAll((err as Error).message, profiles)}`)
    }
  }
  if (input.signal?.aborted && errors.length < profiles.length) {
    errors.push('等待时间已用完，后续模型未尝试')
  }
  throw new ModelCallError(
    errors.length === 1 ? errors[0]! : `所有备选模型均失败。${errors.join('；')}`,
  )
}

export async function callEmbeddingProfile(
  profile: ResolvedEmbeddingProfile,
  texts: string[],
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS
  switch (profile.format) {
    case 'openai-chat':
    case 'openai-responses':
      return callOpenAiEmbedding(profile, texts, timeoutMs, options.signal, fetchImpl)
    case 'gemini':
      return callGeminiEmbedding(profile, texts, timeoutMs, options.signal, fetchImpl)
    case 'ollama':
      return callOllamaEmbedding(profile, texts, timeoutMs, options.signal, fetchImpl)
    case 'anthropic':
      throw new ModelCallError('Anthropic 接口不支持嵌入模型')
  }
}

export async function callEmbeddingFallback(
  profiles: readonly ResolvedEmbeddingProfile[],
  texts: string[],
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  if (!profiles.length) throw new ModelCallError('尚未配置可用的嵌入模型')
  const errors: string[] = []
  for (const [i, profile] of profiles.entries()) {
    if (options.signal?.aborted) break
    try {
      return await callEmbeddingProfile(profile, texts, options, fetchImpl)
    } catch (err) {
      errors.push(
        `渠道 ${i + 1}（${profile.providerName}/${profile.model}）：${redactAll((err as Error).message, profiles)}`,
      )
    }
  }
  if (options.signal?.aborted && errors.length < profiles.length) {
    errors.push('等待时间已用完，后续渠道未尝试')
  }
  throw new ModelCallError(
    errors.length === 1 ? errors[0]! : `所有渠道均失败。${errors.join('；')}`,
  )
}
