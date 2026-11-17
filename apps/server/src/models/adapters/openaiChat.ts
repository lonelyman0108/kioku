import type { BenchAgentMessage } from '@kioku/contracts'

import { EMBEDDING_DIMENSIONS } from '../../db/schema'
import {
  buildAssistantMessage,
  excerptUpstream,
  isRecord,
  normalizeFinishReason,
  normalizeToolCalls,
  numOrZero,
  parseToolCalls,
  postModelJson,
  trimBase,
} from '../common'
import {
  ModelCallError,
  type ChatTurnInput,
  type ChatTurnOutput,
  type ResolvedChatProfile,
  type ResolvedEmbeddingProfile,
} from '../types'

function sanitizeMessages(messages: readonly BenchAgentMessage[]) {
  return messages.map((msg) => {
    if (!('reasoning_blocks' in msg)) return msg
    const copy = { ...msg }
    delete (copy as Record<string, unknown>).reasoning_blocks
    return copy
  })
}

function thinkingFields(profile: ResolvedChatProfile): Record<string, unknown> {
  if (profile.thinking === 'default' || profile.thinkingStyle === 'none') return {}
  if (profile.thinkingStyle === 'enable_thinking') {
    return { enable_thinking: profile.thinking !== 'off' }
  }
  return { reasoning_effort: profile.thinking === 'off' ? 'none' : profile.thinking }
}

export async function callOpenAiChat(
  profile: ResolvedChatProfile,
  input: ChatTurnInput,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatTurnOutput> {
  const started = Date.now()
  const tools = input.tools ?? []
  const what = input.what ?? '模型接口'
  const { raw, parsed } = await postModelJson(
    `${trimBase(profile.baseUrl)}/chat/completions`,
    {
      headers: profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {},
      body: {
        model: profile.model,
        messages: sanitizeMessages(input.messages),
        ...(tools.length ? { tools } : {}),
        ...(profile.maxTokens != null ? { max_tokens: profile.maxTokens } : {}),
        ...thinkingFields(profile),
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

  const { choices, usage } = (isRecord(parsed) ? parsed : {}) as {
    choices?: { message?: unknown; finish_reason?: unknown }[]
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  }
  const choice = choices?.[0]
  const message = choice?.message
  if (!isRecord(message)) {
    throw new ModelCallError(`${what}的响应里没有助手消息：${excerptUpstream(raw, profile.apiKey)}`)
  }
  const calls = normalizeToolCalls(message.tool_calls)
  return {
    profileId: profile.profileId,
    providerName: profile.providerName,
    message: buildAssistantMessage(message, calls),
    toolCalls: parseToolCalls(calls),
    finishReason: normalizeFinishReason('openai-chat', choice?.finish_reason, calls.length > 0),
    usage: {
      promptTokens: numOrZero(usage?.prompt_tokens),
      completionTokens: numOrZero(usage?.completion_tokens),
    },
    ms: Date.now() - started,
    model: profile.model,
  }
}

export async function callOpenAiEmbedding(
  profile: ResolvedEmbeddingProfile,
  texts: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  if (!texts.length) return []
  const { parsed } = await postModelJson(
    `${trimBase(profile.baseUrl)}/embeddings`,
    {
      headers: profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {},
      body: {
        model: profile.model,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: 'float',
      },
      apiKey: profile.apiKey,
      timeoutMs,
      signal,
      what: '嵌入接口',
    },
    fetchImpl,
  )
  const body = (isRecord(parsed) ? parsed : {}) as {
    data?: { index: number; embedding: number[] }[]
  }
  const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index)
  if (data.length !== texts.length) {
    throw new ModelCallError(`嵌入接口返回 ${data.length} 条，期望 ${texts.length} 条`)
  }
  for (const d of data) {
    if (!Array.isArray(d.embedding) || d.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new ModelCallError(
        `嵌入维度是 ${Array.isArray(d.embedding) ? d.embedding.length : 0}，需要 ${EMBEDDING_DIMENSIONS}；请确认模型支持 dimensions 参数`,
      )
    }
  }
  return data.map((d) => d.embedding)
}
