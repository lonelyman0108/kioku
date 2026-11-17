import type { BenchAgentReasoningBlock } from '@kioku/contracts'

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
  readReasoningBlocks,
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

const GEMINI_BUDGETS = {
  off: 0,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
} as const

function geminiRoot(baseUrl: string): string {
  const base = trimBase(baseUrl)
  return base.endsWith('/v1beta') || base.endsWith('/v1') ? base : `${base}/v1beta`
}

function geminiModelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`
}

function thinkingConfig(profile: ResolvedChatProfile): Record<string, unknown> | undefined {
  if (profile.thinking === 'default') return undefined
  if (/^gemini-3/i.test(profile.model) || /-3[-.]/i.test(profile.model)) {
    const level = profile.thinking === 'off' ? 'minimal' : profile.thinking
    return {
      thinkingLevel: level,
      ...(profile.thinking !== 'off' ? { includeThoughts: true } : {}),
    }
  }
  return {
    thinkingBudget: GEMINI_BUDGETS[profile.thinking],
    ...(profile.thinking !== 'off' ? { includeThoughts: true } : {}),
  }
}

export async function callGemini(
  profile: ResolvedChatProfile,
  input: ChatTurnInput,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatTurnOutput> {
  const started = Date.now()
  const what = input.what ?? '模型接口'
  const systemParts: string[] = []
  const contents: { role: 'user' | 'model'; parts: unknown[] }[] = []
  const toolNames = new Map<string, string>()

  const pushUserPart = (part: unknown) => {
    const prev = contents.at(-1)
    if (prev?.role === 'user') prev.parts.push(part)
    else contents.push({ role: 'user', parts: [part] })
  }

  for (const msg of input.messages) {
    if (msg.role === 'system') {
      const text = textOfContent(msg.content).trim()
      if (text) systemParts.push(text)
      continue
    }
    if (msg.role === 'user') {
      pushUserPart({ text: textOfContent(msg.content) })
      continue
    }
    if (msg.role === 'tool') {
      const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
      pushUserPart({
        functionResponse: {
          name: toolNames.get(callId) ?? 'unknown_tool',
          response: { result: textOfContent(msg.content) },
        },
      })
      continue
    }
    if (msg.role === 'assistant') {
      const parts: unknown[] = []
      const sigByCall = new Map<string, string>()
      for (const block of readReasoningBlocks(msg, 'gemini')) {
        if (block.kind === 'thought_signature' && block.toolCallId && block.signature) {
          sigByCall.set(block.toolCallId, block.signature)
        }
      }
      const text = textOfContent(msg.content)
      if (text) parts.push({ text })
      for (const call of normalizeToolCalls(msg.tool_calls)) {
        const fn = isRecord(call.function) ? call.function : null
        const name = typeof fn?.name === 'string' ? fn.name : 'unknown_tool'
        toolNames.set(call.id, name)
        const sig = sigByCall.get(call.id)
        parts.push({
          functionCall: { name, args: parseObjectArguments(fn?.arguments) },
          ...(sig ? { thoughtSignature: sig } : {}),
        })
      }
      if (!parts.length) parts.push({ text: '' })
      contents.push({ role: 'model', parts })
    }
  }

  const thinking = thinkingConfig(profile)
  const generationConfig: Record<string, unknown> = {
    ...(profile.maxTokens != null ? { maxOutputTokens: profile.maxTokens } : {}),
    ...(thinking ? { thinkingConfig: thinking } : {}),
  }

  const tools = (input.tools ?? []).map((t) => ({
    name: t.function.name,
    ...(t.function.description !== undefined ? { description: t.function.description } : {}),
    parameters: t.function.parameters,
  }))

  const url = `${geminiRoot(profile.baseUrl)}/${geminiModelPath(profile.model)}:generateContent`
  const { raw, parsed } = await postModelJson(
    url,
    {
      headers: profile.apiKey ? { 'x-goog-api-key': profile.apiKey } : {},
      body: {
        ...(systemParts.length
          ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } }
          : {}),
        contents,
        ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
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

  const candidates = isRecord(parsed) && Array.isArray(parsed.candidates) ? parsed.candidates : null
  const candidate = candidates && isRecord(candidates[0]) ? candidates[0] : null
  const contentObj = candidate && isRecord(candidate.content) ? candidate.content : null
  const parts = contentObj && Array.isArray(contentObj.parts) ? contentObj.parts : null
  if (!parts) {
    throw new ModelCallError(
      `${what}的响应里没有 candidates 内容：${excerptUpstream(raw, profile.apiKey)}`,
    )
  }

  let contentText = ''
  let reasoningText = ''
  const rawCalls: Record<string, unknown>[] = []
  const signatures: (string | undefined)[] = []

  for (const part of parts) {
    if (!isRecord(part)) continue
    if (part.thought === true && typeof part.text === 'string') {
      reasoningText += (reasoningText ? '\n' : '') + part.text
      continue
    }
    if (typeof part.text === 'string') {
      contentText += part.text
    }
    if (isRecord(part.functionCall)) {
      rawCalls.push({
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(isRecord(part.functionCall.args) ? part.functionCall.args : {}),
        },
      })
      signatures.push(typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined)
    }
  }

  const calls = normalizeToolCalls(rawCalls)
  const reasoningBlocks: BenchAgentReasoningBlock[] = []
  calls.forEach((call, idx) => {
    const sig = signatures[idx]
    if (sig) {
      reasoningBlocks.push({
        format: 'gemini',
        kind: 'thought_signature',
        signature: sig,
        toolCallId: call.id,
      })
    }
  })

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: contentText,
    ...(reasoningText ? { reasoning_content: reasoningText } : {}),
    ...(reasoningBlocks.length ? { reasoning_blocks: reasoningBlocks } : {}),
  }
  const usage = isRecord(parsed) && isRecord(parsed.usageMetadata) ? parsed.usageMetadata : {}

  return {
    profileId: profile.profileId,
    providerName: profile.providerName,
    message: buildAssistantMessage(message, calls),
    toolCalls: parseToolCalls(calls),
    finishReason: normalizeFinishReason('gemini', candidate?.finishReason, calls.length > 0),
    usage: {
      promptTokens: numOrZero(usage.promptTokenCount),
      completionTokens: numOrZero(usage.candidatesTokenCount) + numOrZero(usage.thoughtsTokenCount),
    },
    ms: Date.now() - started,
    model: profile.model,
  }
}

export async function callGeminiEmbedding(
  profile: ResolvedEmbeddingProfile,
  texts: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  if (!texts.length) return []
  const modelPath = geminiModelPath(profile.model)
  const url = `${geminiRoot(profile.baseUrl)}/${modelPath}:batchEmbedContents`
  const { parsed } = await postModelJson(
    url,
    {
      headers: profile.apiKey ? { 'x-goog-api-key': profile.apiKey } : {},
      body: {
        requests: texts.map((text) => ({
          model: modelPath,
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
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
  return embeddings.map((item) => {
    const values = isRecord(item) && Array.isArray(item.values) ? (item.values as number[]) : []
    if (values.length !== EMBEDDING_DIMENSIONS) {
      throw new ModelCallError(
        `嵌入维度是 ${values.length}，需要 ${EMBEDDING_DIMENSIONS}；请确认模型支持 outputDimensionality 参数`,
      )
    }
    return values
  })
}
