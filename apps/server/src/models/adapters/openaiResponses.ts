import type { BenchAgentReasoningBlock } from '@kioku/contracts'

import {
  buildAssistantMessage,
  excerptUpstream,
  isRecord,
  normalizeFinishReason,
  normalizeToolCalls,
  numOrZero,
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

export async function callOpenAiResponses(
  profile: ResolvedChatProfile,
  input: ChatTurnInput,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatTurnOutput> {
  const started = Date.now()
  const what = input.what ?? '模型接口'
  const systemParts: string[] = []
  const items: Record<string, unknown>[] = []

  for (const msg of input.messages) {
    if (msg.role === 'system') {
      const text = textOfContent(msg.content).trim()
      if (text) systemParts.push(text)
      continue
    }
    if (msg.role === 'user') {
      items.push({ type: 'message', role: 'user', content: textOfContent(msg.content) })
      continue
    }
    if (msg.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '',
        output: textOfContent(msg.content),
      })
      continue
    }
    if (msg.role === 'assistant') {
      for (const block of readReasoningBlocks(msg, 'openai-responses')) {
        if (block.kind !== 'responses_reasoning') continue
        items.push({
          type: 'reasoning',
          ...(block.id ? { id: block.id } : {}),
          ...(block.encryptedContent ? { encrypted_content: block.encryptedContent } : {}),
          summary: block.text ? [{ type: 'summary_text', text: block.text }] : [],
        })
      }
      const text = textOfContent(msg.content)
      if (text) {
        items.push({ type: 'message', role: 'assistant', content: text })
      }
      const calls = normalizeToolCalls(msg.tool_calls)
      for (const call of calls) {
        const fn = isRecord(call.function) ? call.function : null
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: typeof fn?.name === 'string' ? fn.name : 'unknown_tool',
          arguments: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
        })
      }
    }
  }

  const tools = (input.tools ?? []).map((t) => ({
    type: 'function',
    name: t.function.name,
    ...(t.function.description !== undefined ? { description: t.function.description } : {}),
    parameters: t.function.parameters,
  }))

  const { raw, parsed } = await postModelJson(
    `${trimBase(profile.baseUrl)}/responses`,
    {
      headers: profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {},
      body: {
        model: profile.model,
        ...(systemParts.length ? { instructions: systemParts.join('\n\n') } : {}),
        input: items,
        ...(tools.length ? { tools } : {}),
        ...(profile.maxTokens != null ? { max_output_tokens: profile.maxTokens } : {}),
        ...(profile.thinking !== 'default'
          ? { reasoning: { effort: profile.thinking === 'off' ? 'none' : profile.thinking } }
          : {}),
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

  if (!isRecord(parsed) || !Array.isArray(parsed.output)) {
    throw new ModelCallError(
      `${what}的响应里没有 output 列表：${excerptUpstream(raw, profile.apiKey)}`,
    )
  }

  let contentText = ''
  let reasoningText = ''
  let refusalText = ''
  const reasoningBlocks: BenchAgentReasoningBlock[] = []
  const rawCalls: Record<string, unknown>[] = []

  for (const item of parsed.output) {
    if (!isRecord(item)) continue
    if (item.type === 'reasoning') {
      const summaries = Array.isArray(item.summary)
        ? item.summary
            .filter(isRecord)
            .map((s) => (typeof s.text === 'string' ? s.text : ''))
            .filter(Boolean)
            .join('\n')
        : ''
      if (summaries) reasoningText += (reasoningText ? '\n' : '') + summaries
      reasoningBlocks.push({
        format: 'openai-responses',
        kind: 'responses_reasoning',
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(typeof item.encrypted_content === 'string'
          ? { encryptedContent: item.encrypted_content }
          : {}),
        ...(summaries ? { text: summaries } : {}),
      })
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isRecord(part)) continue
        if (part.type === 'output_text' && typeof part.text === 'string') {
          contentText += part.text
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          refusalText += part.refusal
        }
      }
    } else if (item.type === 'function_call') {
      rawCalls.push({
        id: typeof item.call_id === 'string' && item.call_id ? item.call_id : item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        },
      })
    }
  }

  const calls = normalizeToolCalls(rawCalls)
  if (
    !contentText &&
    !refusalText &&
    !calls.length &&
    (parsed.status === 'failed' || isRecord(parsed.error))
  ) {
    throw new ModelCallError(`${what}返回失败状态：${excerptUpstream(raw, profile.apiKey)}`)
  }
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: contentText,
    ...(reasoningText ? { reasoning_content: reasoningText } : {}),
    ...(refusalText ? { refusal: refusalText } : {}),
    ...(reasoningBlocks.length ? { reasoning_blocks: reasoningBlocks } : {}),
  }
  const usage = isRecord(parsed.usage) ? parsed.usage : {}

  return {
    profileId: profile.profileId,
    providerName: profile.providerName,
    message: buildAssistantMessage(message, calls),
    toolCalls: parseToolCalls(calls),
    finishReason: normalizeFinishReason('openai-responses', parsed.status, calls.length > 0),
    usage: {
      promptTokens: numOrZero(usage.input_tokens),
      completionTokens: numOrZero(usage.output_tokens),
    },
    ms: Date.now() - started,
    model: profile.model,
  }
}
