import type { BenchAgentReasoningBlock } from '@kioku/contracts'

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
  readReasoningBlocks,
  textOfContent,
  trimBase,
} from '../common'
import {
  ModelCallError,
  type ChatTurnInput,
  type ChatTurnOutput,
  type ResolvedChatProfile,
} from '../types'

const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192
const ANTHROPIC_BUDGETS = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
} as const

function anthropicEndpoint(baseUrl: string): string {
  const base = trimBase(baseUrl)
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

export async function callAnthropic(
  profile: ResolvedChatProfile,
  input: ChatTurnInput,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatTurnOutput> {
  const started = Date.now()
  const what = input.what ?? '模型接口'
  const systemParts: string[] = []
  const turns: { role: 'user' | 'assistant'; content: unknown[] }[] = []

  const pushUserBlock = (block: unknown) => {
    const prev = turns.at(-1)
    if (prev?.role === 'user') prev.content.push(block)
    else turns.push({ role: 'user', content: [block] })
  }

  for (const msg of input.messages) {
    if (msg.role === 'system') {
      const text = textOfContent(msg.content).trim()
      if (text) systemParts.push(text)
      continue
    }
    if (msg.role === 'user') {
      pushUserBlock({ type: 'text', text: textOfContent(msg.content) })
      continue
    }
    if (msg.role === 'tool') {
      pushUserBlock({
        type: 'tool_result',
        tool_use_id: typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '',
        content: textOfContent(msg.content),
      })
      continue
    }
    if (msg.role === 'assistant') {
      const blocks: unknown[] = []
      for (const b of readReasoningBlocks(msg, 'anthropic')) {
        if (b.kind === 'thinking' && b.signature) {
          blocks.push({ type: 'thinking', thinking: b.text ?? '', signature: b.signature })
        } else if (b.kind === 'redacted_thinking' && b.data) {
          blocks.push({ type: 'redacted_thinking', data: b.data })
        }
      }
      const text = textOfContent(msg.content)
      if (text) blocks.push({ type: 'text', text })
      for (const call of normalizeToolCalls(msg.tool_calls)) {
        const fn = isRecord(call.function) ? call.function : null
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: typeof fn?.name === 'string' ? fn.name : 'unknown_tool',
          input: parseObjectArguments(fn?.arguments),
        })
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' })
      turns.push({ role: 'assistant', content: blocks })
    }
  }

  let maxTokens = profile.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS
  let thinkingBody: Record<string, unknown> | undefined
  if (profile.thinking === 'off') {
    thinkingBody = { type: 'disabled' }
  } else if (profile.thinking !== 'default') {
    const budget = ANTHROPIC_BUDGETS[profile.thinking]
    maxTokens = Math.max(maxTokens, budget + 4096)
    thinkingBody = { type: 'enabled', budget_tokens: budget }
  }

  const tools = (input.tools ?? []).map((t) => ({
    name: t.function.name,
    ...(t.function.description !== undefined ? { description: t.function.description } : {}),
    input_schema: t.function.parameters,
  }))

  const { raw, parsed } = await postModelJson(
    anthropicEndpoint(profile.baseUrl),
    {
      headers: {
        'anthropic-version': '2023-06-01',
        ...(profile.apiKey ? { 'x-api-key': profile.apiKey } : {}),
      },
      body: {
        model: profile.model,
        max_tokens: maxTokens,
        ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
        messages: turns,
        ...(tools.length ? { tools } : {}),
        ...(thinkingBody ? { thinking: thinkingBody } : {}),
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

  if (!isRecord(parsed) || !Array.isArray(parsed.content)) {
    throw new ModelCallError(
      `${what}的响应里没有 content 列表：${excerptUpstream(raw, profile.apiKey)}`,
    )
  }

  let contentText = ''
  let reasoningText = ''
  const reasoningBlocks: BenchAgentReasoningBlock[] = []
  const rawCalls: Record<string, unknown>[] = []

  for (const block of parsed.content) {
    if (!isRecord(block)) continue
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      reasoningText += (reasoningText ? '\n' : '') + block.thinking
      reasoningBlocks.push({
        format: 'anthropic',
        kind: 'thinking',
        text: block.thinking,
        ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
      })
    } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
      reasoningBlocks.push({
        format: 'anthropic',
        kind: 'redacted_thinking',
        data: block.data,
      })
    } else if (block.type === 'text' && typeof block.text === 'string') {
      contentText += block.text
    } else if (block.type === 'tool_use') {
      rawCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
        },
      })
    }
  }

  const calls = normalizeToolCalls(rawCalls)
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: contentText,
    ...(reasoningText ? { reasoning_content: reasoningText } : {}),
    ...(reasoningBlocks.length ? { reasoning_blocks: reasoningBlocks } : {}),
  }
  const usage = isRecord(parsed.usage) ? parsed.usage : {}

  return {
    profileId: profile.profileId,
    providerName: profile.providerName,
    message: buildAssistantMessage(message, calls),
    toolCalls: parseToolCalls(calls),
    finishReason: normalizeFinishReason('anthropic', parsed.stop_reason, calls.length > 0),
    usage: {
      promptTokens: numOrZero(usage.input_tokens),
      completionTokens: numOrZero(usage.output_tokens),
    },
    ms: Date.now() - started,
    model: profile.model,
  }
}
