import type { BenchAgentMessage, BenchAgentTurnResult } from '@kioku/contracts'

import {
  endpointAddress,
  escapeControlChars,
  normalizeToolCalls,
  parseModelJson,
  parseToolCalls,
  toolDefinitions,
  type NormalizedToolCall,
} from '../models/common'
import { callChatProfile } from '../models/execute'
import { ModelCallError, type AgentToolDefinition, type ResolvedChatProfile } from '../models/types'
import type { EndpointConfig } from '../settings/endpoint'

export {
  endpointAddress,
  escapeControlChars,
  normalizeToolCalls,
  parseModelJson,
  parseToolCalls,
  toolDefinitions,
  type AgentToolDefinition,
  type NormalizedToolCall,
}

export class AgentModelError extends Error {}

export interface AgentTurnInput {
  messages: readonly BenchAgentMessage[]
  tools: readonly AgentToolDefinition[]
  signal?: AbortSignal
  timeoutMs?: number
}

function toChatProfile(config: ResolvedChatProfile | EndpointConfig): ResolvedChatProfile {
  if ('format' in config) return config
  return {
    profileId: 'endpoint',
    providerId: 'endpoint',
    providerName: 'endpoint',
    format: 'openai-chat',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    label: null,
    thinking: 'default',
    thinkingStyle: 'auto',
    maxTokens: null,
  }
}

export async function requestAgentTurn(
  config: ResolvedChatProfile | EndpointConfig,
  { messages, tools, signal, timeoutMs }: AgentTurnInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BenchAgentTurnResult> {
  try {
    const out = await callChatProfile(
      toChatProfile(config),
      {
        messages,
        tools,
        ...(signal !== undefined ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        what: '模型接口',
        timeoutWhat: '模型',
        includeExcerptOnJsonError: true,
      },
      fetchImpl,
    )
    return {
      message: out.message,
      toolCalls: out.toolCalls,
      finishReason: out.finishReason,
      usage: out.usage,
      ms: out.ms,
      model: out.model,
    }
  } catch (err) {
    if (err instanceof ModelCallError) {
      throw new AgentModelError(err.message, { cause: err })
    }
    throw err
  }
}
