import { z } from 'zod'

import { LensKeyScopes, WhoAmI } from './auth'
import { ShortId } from './links'
import { CredentialCapability, EntryKind, Sensitivity, SubjectKind } from './memory'
import { ModelFormat, ThinkingLevel } from './models'
import { SessionExtra, TurnEndEvent } from './recall'

// 测试台：不连真实客户端，按一个访问密钥模拟接入方调用 Kioku，步骤结果与真实接入方一致

export const BENCH_MODES = ['rollback', 'real'] as const
export const BenchMode = z.enum(BENCH_MODES)
export type BenchMode = z.infer<typeof BenchMode>

export const BENCH_WRITE_TOOLS = [
  'kioku_create',
  'kioku_update',
  'kioku_delete',
  'kioku_transfer',
  'kioku_credential_save',
  'kioku_credential_delete',
] as const
export const BENCH_READ_TOOLS = ['kioku_boot', 'kioku_search', 'kioku_get', 'kioku_browse'] as const
export const BENCH_TOOLS = [...BENCH_READ_TOOLS, 'kioku_credential', ...BENCH_WRITE_TOOLS] as const

export const BENCH_MAX_STEPS = 50
export const BENCH_MAX_REPLAY_STEPS = 100
export const BENCH_MAX_REPLAY_BYTES = 512 * 1024
export const BENCH_MAX_REQUEST_BYTES = 2 * 1024 * 1024

const AssertedText = z.string().min(1).max(2000)
export const BenchExpect = z.strictObject({
  error: z.boolean().optional(),
  contains: z.array(AssertedText).max(20).optional(),
  notContains: z.array(AssertedText).max(20).optional(),
  shortIds: z.array(ShortId).max(50).optional(),
  notShortIds: z.array(ShortId).max(50).optional(),
})
export type BenchExpect = z.infer<typeof BenchExpect>

export const CaptureName = z
  .string()
  .regex(
    /^(?!(?:run|expires)$)[A-Za-z_][A-Za-z0-9_]{0,63}$/,
    '变量名只能包含字母、数字和下划线，不能以数字开头，也不能是 run 或 expires',
  )
export const BenchCapture = z.record(CaptureName, z.string().min(1).max(200))
export type BenchCapture = z.infer<typeof BenchCapture>

export const BenchRequires = z.strictObject({
  readKinds: z.array(EntryKind).optional(),
  writeKinds: z.array(EntryKind).optional(),
  maxSensitivity: Sensitivity.optional(),
  credentials: CredentialCapability.optional(),
})
export type BenchRequires = z.infer<typeof BenchRequires>

const stepFields = {
  label: z.string().min(1).max(200).optional(),
  expect: BenchExpect.optional(),
  capture: BenchCapture.optional(),
  requires: BenchRequires.optional(),
}

const ToolArguments = z.record(z.string(), z.unknown())

export const BenchToolStep = z.strictObject({
  kind: z.literal('tool'),
  tool: z.string().min(1).max(64),
  arguments: ToolArguments.default({}),
  ...stepFields,
})

export const BenchLifecycleStep = z.strictObject({
  kind: z.literal('lifecycle'),
  body: z.unknown(),
  ...stepFields,
})
export const BenchRecallStep = z.strictObject({
  kind: z.literal('recall'),
  body: z.unknown(),
  ...stepFields,
})
export const BenchBootStep = z.strictObject({ kind: z.literal('boot'), ...stepFields })
export const BenchWhoamiStep = z.strictObject({ kind: z.literal('whoami'), ...stepFields })

export const BenchStep = z.discriminatedUnion('kind', [
  BenchToolStep,
  BenchLifecycleStep,
  BenchRecallStep,
  BenchBootStep,
  BenchWhoamiStep,
])
export type BenchStep = z.infer<typeof BenchStep>

export const BenchReplayStep = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tool'),
    tool: z.enum(BENCH_WRITE_TOOLS),
    arguments: ToolArguments,
  }),
  z.strictObject({ kind: z.literal('lifecycle'), body: TurnEndEvent }),
])
export type BenchReplayStep = z.infer<typeof BenchReplayStep>

function utf8Bytes(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

export const BenchRunRequest = z
  .strictObject({
    mode: BenchMode.default('rollback'),
    steps: z.array(BenchStep).min(1).max(BENCH_MAX_STEPS),
    replay: z
      .array(BenchReplayStep)
      .max(BENCH_MAX_REPLAY_STEPS, '重放步骤过多，请清空后重试')
      .default([]),
  })
  .superRefine((request, ctx) => {
    if (request.mode === 'real' && request.replay.length) {
      ctx.addIssue({ code: 'custom', path: ['replay'], message: '真实模式不支持重放' })
    }
    if (utf8Bytes(JSON.stringify(request.replay)) > BENCH_MAX_REPLAY_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['replay'], message: '重放内容过多，请清空后重试' })
    }
  })
export type BenchRunRequest = z.infer<typeof BenchRunRequest>

export const BenchScenario = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, '场景 id 只能包含小写字母、数字和 -'),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  runtimes: z.array(z.string().min(1).max(64)).optional(),
  probe: z.boolean().optional(),
  steps: z.array(BenchStep).min(1).max(BENCH_MAX_STEPS),
})
export type BenchScenario = z.infer<typeof BenchScenario>
export type BenchScenarioInput = z.input<typeof BenchScenario>

export const BenchScenarioList = z.object({ scenarios: z.array(BenchScenario) })
export type BenchScenarioList = z.infer<typeof BenchScenarioList>

export const BenchTool = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown(),
})
export type BenchTool = z.infer<typeof BenchTool>

export const BenchToolList = z.object({ tools: z.array(BenchTool) })
export type BenchToolList = z.infer<typeof BenchToolList>

export const BenchChanges = z.object({
  entries: z.array(
    z.object({
      type: z.string(),
      shortId: ShortId,
      title: z.string(),
      fields: z.array(z.string()),
      left: z.boolean(),
      becameSecret: z.boolean(),
    }),
  ),
  hiddenOther: z.number().int(),
  credentials: z.array(
    z.object({
      type: z.string(),
      identifier: z.string(),
      fields: z.array(z.string()),
      changes: z.array(z.string()),
    }),
  ),
  subjects: z.number().int().nullable(),
  identities: z.array(z.object({ kind: SubjectKind, platform: z.string() })).nullable(),
  turns: z.number().int().nullable(),
  turn: z.object({ sessionId: z.string(), user: z.string(), reply: z.string() }).nullable(),
})
export type BenchChanges = z.infer<typeof BenchChanges>

export const BENCH_INTERNAL_DETAILS = [
  'lock_timeout',
  'statement_timeout',
  'run_timeout',
  'aborted',
] as const
export const BenchInternalDetail = z.enum(BENCH_INTERNAL_DETAILS)
export type BenchInternalDetail = z.infer<typeof BenchInternalDetail>

export const BENCH_STEP_STATUSES = ['passed', 'failed', 'skipped', 'notRun'] as const
export const BenchStepStatus = z.enum(BENCH_STEP_STATUSES)
export type BenchStepStatus = z.infer<typeof BenchStepStatus>

export const BenchAssertion = z.object({
  message: z.string(),
  ok: z.boolean(),
})
export type BenchAssertion = z.infer<typeof BenchAssertion>

export const BenchSessionStart = z.object({
  limit: z.number().int().nullable(),
  omitted: z.array(ShortId),
  dropped: z.array(SessionExtra),
})
export type BenchSessionStart = z.infer<typeof BenchSessionStart>

export const BenchStepResult = z.object({
  index: z.number().int(),
  label: z.string(),
  kind: z.enum(['tool', 'lifecycle', 'recall', 'boot', 'whoami']),
  status: BenchStepStatus,
  reason: z.string().nullable(),
  isError: z.boolean(),
  internalError: z.boolean(),
  internalDetail: BenchInternalDetail.nullable(),
  httpStatus: z.number().int().nullable(),
  text: z.string(),
  raw: z.unknown(),
  ms: z.number(),
  shortIds: z.array(ShortId).nullable(),
  session: BenchSessionStart.nullable(),
  vectorSkipped: z.boolean(),
  assertions: z.array(BenchAssertion),
  captured: z.record(z.string(), z.string()),
  changes: BenchChanges.nullable(),
  replay: BenchReplayStep.nullable(),
})
export type BenchStepResult = z.infer<typeof BenchStepResult>

export const BenchRunResult = z.object({
  run: z.string(),
  mode: BenchMode,
  ok: z.boolean(),
  whoami: WhoAmI,
  scopes: LensKeyScopes,
  counts: z.object({
    passed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    notRun: z.number().int(),
  }),
  steps: z.array(BenchStepResult),
  replayDiverged: z
    .object({ index: z.number().int(), text: z.string(), internalError: z.boolean() })
    .nullable(),
})
export type BenchRunResult = z.infer<typeof BenchRunResult>

// 模型代理：按客户端运行时模拟对话循环，不存服务端历史
export const BENCH_AGENT_LOOPS = ['hook', 'chat', 'tools', 'approximate'] as const
export const BenchAgentLoop = z.enum(BENCH_AGENT_LOOPS)
export type BenchAgentLoop = z.infer<typeof BenchAgentLoop>

export const BENCH_AGENT_UNAVAILABLE = ['notAdmin', 'noModel', 'keyLocked'] as const
export const BenchAgentUnavailable = z.enum(BENCH_AGENT_UNAVAILABLE)
export type BenchAgentUnavailable = z.infer<typeof BenchAgentUnavailable>

export const BenchAgentModelOption = z.object({
  profileId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  format: ModelFormat,
  model: z.string(),
  label: z.string().nullable(),
  thinking: ThinkingLevel,
  endpoint: z.string(),
  available: z.boolean(),
})
export type BenchAgentModelOption = z.infer<typeof BenchAgentModelOption>

export const BenchAgentInfo = z.object({
  available: z.boolean(),
  reason: BenchAgentUnavailable.nullable(),
  defaultProfileId: z.string().nullable(),
  defaultModel: z.string().nullable(),
  endpoint: z.string().nullable(),
  models: z.array(BenchAgentModelOption),
  loop: BenchAgentLoop,
  tools: z.boolean(),
  turnEnd: z.boolean(),
})
export type BenchAgentInfo = z.infer<typeof BenchAgentInfo>

export const BenchAgentReasoningBlock = z.object({
  format: ModelFormat,
  kind: z.enum(['thinking', 'redacted_thinking', 'responses_reasoning', 'thought_signature']),
  text: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
  id: z.string().optional(),
  encryptedContent: z.string().optional(),
  toolCallId: z.string().optional(),
})
export type BenchAgentReasoningBlock = z.infer<typeof BenchAgentReasoningBlock>

export const BENCH_AGENT_MAX_MESSAGES = 1000
export const BENCH_AGENT_MAX_BYTES = 4 * 1024 * 1024

export const BenchAgentMessage = z.looseObject({ role: z.string().min(1).max(64) })
export type BenchAgentMessage = z.infer<typeof BenchAgentMessage>

export const BenchAgentTurnRequest = z
  .strictObject({
    profileId: z.string().trim().min(1).max(32).optional(),
    messages: z
      .array(BenchAgentMessage)
      .min(1)
      .max(BENCH_AGENT_MAX_MESSAGES, '对话过长，请清空后重试'),
  })
  .superRefine((request, ctx) => {
    if (utf8Bytes(JSON.stringify(request.messages)) > BENCH_AGENT_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['messages'], message: '对话过长，请清空后重试' })
    }
  })
export type BenchAgentTurnRequest = z.infer<typeof BenchAgentTurnRequest>

export const BenchAgentToolCall = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).nullable(),
  parseError: z.string().nullable(),
  rawArguments: z.string().optional(),
})
export type BenchAgentToolCall = z.infer<typeof BenchAgentToolCall>

export const BenchAgentTurnResult = z.object({
  message: BenchAgentMessage,
  toolCalls: z.array(BenchAgentToolCall),
  finishReason: z.string().nullable(),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }),
  ms: z.number(),
  model: z.string(),
})
export type BenchAgentTurnResult = z.infer<typeof BenchAgentTurnResult>

const WRITE_TOOLS: ReadonlySet<string> = new Set(BENCH_WRITE_TOOLS)
const READ_TOOLS: ReadonlySet<string> = new Set(BENCH_READ_TOOLS)
const WRITING_CHATS: ReadonlySet<unknown> = new Set(['direct', 'group', 'channel'])

const eventOf = (body: unknown) => (body as { event?: unknown } | null | undefined)?.event
const chatOf = (body: unknown) =>
  (body as { context?: { chatType?: unknown } } | null | undefined)?.context?.chatType

export function isReplayStep(step: BenchStep | BenchReplayStep): boolean {
  if (step.kind === 'tool') return WRITE_TOOLS.has(step.tool)
  return step.kind === 'lifecycle' && eventOf(step.body) === 'turn.end'
}

export function mayWrite(step: BenchStep): boolean {
  if (isReplayStep(step)) return true
  switch (step.kind) {
    case 'tool':
      if (step.tool === 'kioku_credential') return step.arguments.identifier !== undefined
      return !READ_TOOLS.has(step.tool)
    case 'lifecycle':
    case 'recall':
      return WRITING_CHATS.has(chatOf(step.body))
    default:
      return false
  }
}
