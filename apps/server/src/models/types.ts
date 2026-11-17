import type {
  BenchAgentMessage,
  BenchAgentTurnResult,
  ModelFormat,
  ThinkingLevel,
  ThinkingStyle,
} from '@kioku/contracts'

export interface ResolvedChatProfile {
  profileId: string
  providerId: string
  providerName: string
  format: ModelFormat
  baseUrl: string
  apiKey: string | null
  model: string
  label: string | null
  thinking: ThinkingLevel
  thinkingStyle: ThinkingStyle
  maxTokens: number | null
}

export interface ResolvedEmbeddingProfile {
  profileId: string
  providerId: string
  providerName: string
  format: ModelFormat
  baseUrl: string
  apiKey: string | null
  model: string
  label: string | null
}

export interface AgentToolDefinition {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

export interface ChatTurnInput {
  messages: readonly BenchAgentMessage[]
  tools?: readonly AgentToolDefinition[]
  signal?: AbortSignal
  timeoutMs?: number
  what?: string
  timeoutWhat?: string
  includeExcerptOnJsonError?: boolean
}

export interface ChatTurnOutput extends BenchAgentTurnResult {
  profileId: string
  providerName: string
}

export class ModelCallError extends Error {}
