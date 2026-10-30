import { z } from 'zod'

import { WhoAmI } from './auth'
import { Layer, Sensitivity, SubjectKind } from './memory'
import { TurnEndEvent } from './recall'

// 测试台：不接真实客户端，按一把 Key 模拟接入方调用 Kioku，步骤的结果和真实接入方收到的一样。
// 契约只放 zod schema，例外是最后的 isReplayStep 与 mayWrite：只看数据的判定，服务端、命令行与界面要一致

// rollback：全部步骤放进一个事务，结束时回滚；real：步骤各自真实执行
export const BENCH_MODES = ['rollback', 'real'] as const
export const BenchMode = z.enum(BENCH_MODES)
export type BenchMode = z.infer<typeof BenchMode>

// 写工具：改记忆或凭据。重放只放它们（加上 turn.end）
export const BENCH_WRITE_TOOLS = [
  'kioku_create',
  'kioku_update',
  'kioku_delete',
  'kioku_move',
  'kioku_credential_save',
  'kioku_credential_delete',
] as const
// 只读工具：kioku_get 可能给外部凭据记一条访问事件，这里不算写
export const BENCH_READ_TOOLS = ['kioku_boot', 'kioku_search', 'kioku_get', 'kioku_list'] as const
// 真实 MCP 服务端应当有的工具，命令行握手时按它核对
export const BENCH_TOOLS = [...BENCH_READ_TOOLS, 'kioku_credential', ...BENCH_WRITE_TOOLS] as const

// 一次运行的上限：回滚模式下运行占一条连接，步骤数与请求体都不能无限
export const BENCH_MAX_STEPS = 50
export const BENCH_MAX_REPLAY_STEPS = 100
export const BENCH_MAX_REPLAY_BYTES = 512 * 1024
export const BENCH_MAX_REQUEST_BYTES = 2 * 1024 * 1024

// 断言不支持正则：V8 的正则是回溯的，在主线程上执行，一条灾难性回溯的断言能卡死整个实例，而场景可以从别处导入。
// 字符串里的 ${run} 与 capture 取到的变量先展开再比较
const AssertedText = z.string().min(1).max(2000)
export const BenchExpect = z.strictObject({
  // 这一步该不该报错。内部错误一律算失败，不算「按预期报错」
  error: z.boolean().optional(),
  contains: z.array(AssertedText).max(20).optional(),
  notContains: z.array(AssertedText).max(20).optional(),
  // 结果的 URI 列表里要有这些
  uris: z.array(AssertedText).max(50).optional(),
  notUris: z.array(AssertedText).max(50).optional(),
})
export type BenchExpect = z.infer<typeof BenchExpect>

// capture：从结果文本里按固定前缀取到行尾，给后面的步骤用，例如 { version: '版本: ' }。
// run 与 expires 是保留的名字：${run} 是这次运行的标记，${expires} 是几小时后的时间，写记忆时给 valid_to 用
export const CaptureName = z
  .string()
  .regex(
    /^(?!(?:run|expires)$)[A-Za-z_][A-Za-z0-9_]{0,63}$/,
    '变量名只用字母、数字和下划线，不能以数字开头，不能叫 run 或 expires',
  )
export const BenchCapture = z.record(CaptureName, z.string().min(1).max(200))
export type BenchCapture = z.infer<typeof BenchCapture>

// requires：这一步要的层与最高敏感级，运行前按 whoami 判断，不满足的步骤记「跳过」，不算失败
export const BenchRequires = z.strictObject({
  readLayers: z.array(Layer).optional(),
  writeLayers: z.array(Layer).optional(),
  maxSensitivity: Sensitivity.optional(),
})
export type BenchRequires = z.infer<typeof BenchRequires>

const stepFields = {
  label: z.string().min(1).max(200).optional(),
  expect: BenchExpect.optional(),
  capture: BenchCapture.optional(),
  requires: BenchRequires.optional(),
}

const ToolArguments = z.record(z.string(), z.unknown())

// 工具步骤没有 context：真实的 MCP 请求不带会话上下文，按 Key 的全部权限读写
export const BenchToolStep = z.strictObject({
  kind: z.literal('tool'),
  tool: z.string().min(1).max(64),
  arguments: ToolArguments.default({}),
  ...stepFields,
})

// 生命周期事件与 /recall 的请求体不在这里校验：不合法的请求体也是要测的，按步骤校验，返回和 REST 相同的错误
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

// 重放：回滚模式下这次会话已经成功做过的写步骤，先执行，结果不返回。参数是展开之后的
//（${run} 与 capture 不再求值），连同当时的上下文
export const BenchReplayStep = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tool'),
    tool: z.enum(BENCH_WRITE_TOOLS),
    arguments: ToolArguments,
  }),
  z.strictObject({ kind: z.literal('lifecycle'), body: TurnEndEvent }),
])
export type BenchReplayStep = z.infer<typeof BenchReplayStep>

// 按 UTF-8 算的字节数。这个包不带运行环境的类型（浏览器与 Node 都用它），不用 TextEncoder
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
      .max(BENCH_MAX_REPLAY_STEPS, '重放的步骤太多，清空之后再试')
      .default([]),
  })
  .superRefine((request, ctx) => {
    if (request.mode === 'real' && request.replay.length) {
      ctx.addIssue({ code: 'custom', path: ['replay'], message: '真实模式没有重放' })
    }
    if (utf8Bytes(JSON.stringify(request.replay)) > BENCH_MAX_REPLAY_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['replay'], message: '重放的内容太多，清空之后再试' })
    }
  })
export type BenchRunRequest = z.infer<typeof BenchRunRequest>

// 场景：一串步骤，内置预设放在代码里，自己的场景导入导出 JSON，不存库
export const BenchScenario = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, '场景 id 只用小写字母、数字和 -'),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  // 适用的运行时类型；不给时所有运行时都适用
  runtimes: z.array(z.string().min(1).max(64)).optional(),
  // 只列结果，不判通过与失败：例如权限探测，每把 Key 的正确结果都不同
  probe: z.boolean().optional(),
  steps: z.array(BenchStep).min(1).max(BENCH_MAX_STEPS),
})
export type BenchScenario = z.infer<typeof BenchScenario>
// 写场景时的形状：可以省略有默认值的字段
export type BenchScenarioInput = z.input<typeof BenchScenario>

export const BenchScenarioList = z.object({ scenarios: z.array(BenchScenario) })
export type BenchScenarioList = z.infer<typeof BenchScenarioList>

// 真实的 tools/list 给出的一个工具，界面的表单按 inputSchema 生成，发给模型时原样转发
export const BenchTool = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown(),
})
export type BenchTool = z.infer<typeof BenchTool>

export const BenchToolList = z.object({ tools: z.array(BenchTool) })
export type BenchToolList = z.infer<typeof BenchToolList>

// 「真执行会改什么」：只给字段名与个数，不带内容。回滚模式按事务认，真实模式按事件 context 的标记认
export const BenchChanges = z.object({
  memories: z.array(
    z.object({
      type: z.string(),
      uri: z.string(),
      // 改了哪些字段，见 ActivityItem.changes
      fields: z.array(z.string()),
      // 改后这把 Key 看不到了：uri 是改前的，不给改后的任何内容，见 ActivityItem.left
      left: z.boolean(),
      // 改成了 secret：这条记忆历史里的正文会被抹掉，向量会删
      becameSecret: z.boolean(),
    }),
  ),
  // 让出了多少条看不到的过期记录（别的成员的），不给任何字段
  hiddenReleased: z.number().int(),
  // 别的看不到的改动（Key 能写却读不到的层）
  hiddenOther: z.number().int(),
  credentials: z.array(
    z.object({
      type: z.string(),
      identifier: z.string(),
      // 取用了哪些字段，见 CredentialEvent.fields
      fields: z.array(z.string()),
      // 修改了哪些部分，见 CredentialEvent.changes
      changes: z.array(z.string()),
    }),
  ),
  // 新建的对象的个数，与它们的平台账号：一个账号一项，只给种类与平台，不给账号本身。
  // 真实模式下这几张表没有标记，不列，为 null
  subjects: z.number().int().nullable(),
  identities: z.array(z.object({ kind: SubjectKind, platform: z.string() })).nullable(),
  // 写进对话缓冲的轮数，真实模式不列，为 null
  turns: z.number().int().nullable(),
  // 这一步传入的这一轮：只回显步骤本身，不从表里读（缓冲里有群里别人的话，没有读取的接口）
  turn: z.object({ sessionId: z.string(), user: z.string(), reply: z.string() }).nullable(),
})
export type BenchChanges = z.infer<typeof BenchChanges>

// 内部错误的具体原因，只有回滚模式有：等锁超时、语句超时、运行超过总时长、根事务已中止
export const BENCH_INTERNAL_DETAILS = [
  'lock_timeout',
  'statement_timeout',
  'run_timeout',
  'aborted',
] as const
export const BenchInternalDetail = z.enum(BENCH_INTERNAL_DETAILS)
export type BenchInternalDetail = z.infer<typeof BenchInternalDetail>

// passed：通过（没带断言的步骤只要不是内部错误就算通过）；failed：断言不成立或内部错误；
// skipped：不满足 requires，不算失败；notRun：根事务出错、超过总时长或重放分叉之后没有执行，算失败
export const BENCH_STEP_STATUSES = ['passed', 'failed', 'skipped', 'notRun'] as const
export const BenchStepStatus = z.enum(BENCH_STEP_STATUSES)
export type BenchStepStatus = z.infer<typeof BenchStepStatus>

export const BenchAssertion = z.object({
  // 这条断言说的是什么，例如「应包含 x」；不带这一步的实际结果，命令行默认只打印它
  message: z.string(),
  ok: z.boolean(),
})
export type BenchAssertion = z.infer<typeof BenchAssertion>

// session.start 的结果多带的：宿主能完整接收的字数、没展开的节点、放不下的附加块。
// 只有进程内执行有，真实接口的响应（LifecycleResponse）不带
export const BenchSessionStart = z.object({
  limit: z.number().int().nullable(),
  omitted: z.array(z.string()),
  dropped: z.array(z.enum(['recent', 'related'])),
})
export type BenchSessionStart = z.infer<typeof BenchSessionStart>

export const BenchStepResult = z.object({
  index: z.number().int(),
  label: z.string(),
  kind: z.enum(['tool', 'lifecycle', 'recall', 'boot', 'whoami']),
  status: BenchStepStatus,
  // 跳过或没有执行的原因
  reason: z.string().nullable(),
  isError: z.boolean(),
  // 非业务错误：工具步骤是固定文字，别的步骤是 500。断言一律算失败
  internalError: z.boolean(),
  internalDetail: BenchInternalDetail.nullable(),
  // 生命周期事件与 /recall、/boot、/whoami 的状态码；工具步骤为 null
  httpStatus: z.number().int().nullable(),
  // 收到的原文：工具结果的文字；生命周期事件是交给宿主的文字；REST 响应是格式化的 JSON
  text: z.string(),
  // 原始响应，和接入方收到的相同
  raw: z.unknown(),
  ms: z.number(),
  // 结果里的 URI 列表
  uris: z.array(z.string()),
  session: BenchSessionStart.nullable(),
  // 回滚模式下这一步的查询没有算好向量，只走了全文与关键词
  vectorSkipped: z.boolean(),
  assertions: z.array(BenchAssertion),
  captured: z.record(z.string(), z.string()),
  changes: BenchChanges.nullable(),
  // 这一步成功了又是写步骤：界面把它记进重放日志
  replay: BenchReplayStep.nullable(),
})
export type BenchStepResult = z.infer<typeof BenchStepResult>

export const BenchRunResult = z.object({
  // 这次运行的标记：步骤里的 ${run} 就是它，真实模式下事件也带着它
  run: z.string(),
  mode: BenchMode,
  // 没有失败、没有没执行的步骤，重放也没有分叉
  ok: z.boolean(),
  whoami: WhoAmI,
  counts: z.object({
    passed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    notRun: z.number().int(),
  }),
  steps: z.array(BenchStepResult),
  // 重放有步骤报错：第几步（从 0 算）与它的错误，这次的步骤都没有执行，由界面让用户清空或接受
  replayDiverged: z
    .object({ index: z.number().int(), text: z.string(), internalError: z.boolean() })
    .nullable(),
})
export type BenchRunResult = z.infer<typeof BenchRunResult>

const WRITE_TOOLS: ReadonlySet<string> = new Set(BENCH_WRITE_TOOLS)
const READ_TOOLS: ReadonlySet<string> = new Set(BENCH_READ_TOOLS)
// 第一次见到的账号会新建对象：定时任务与子 agent 不带账号，不算
const WRITING_CHATS: ReadonlySet<unknown> = new Set(['direct', 'group', 'channel'])

const eventOf = (body: unknown) => (body as { event?: unknown } | null | undefined)?.event
const chatOf = (body: unknown) =>
  (body as { context?: { chatType?: unknown } } | null | undefined)?.context?.chatType

// 这一步成功之后要不要进重放日志：写工具与 turn.end。别的步骤重放了也没有意义（读的结果不留下）
export function isReplayStep(step: BenchStep | BenchReplayStep): boolean {
  if (step.kind === 'tool') return WRITE_TOOLS.has(step.tool)
  return step.kind === 'lifecycle' && eventOf(step.body) === 'turn.end'
}

// 这一步可能写库（命令行没有回滚，要加 --allow-writes）：重放的那些，取值的 kioku_credential（记访问事件），
// 不认识的工具（按写算），以及带私聊、群聊、频道上下文的生命周期事件与 /recall。
// kioku_get 可能给外部凭据记访问事件，只在说明里写明，不算写：否则读一条记忆也要加参数
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
