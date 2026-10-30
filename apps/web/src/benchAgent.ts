import {
  BENCH_MAX_STEPS,
  BenchStep,
  TurnEndEvent,
  type BenchAgentLoop,
  type BenchAgentMessage,
  type BenchAgentToolCall,
  type BenchAgentTurnRequest,
  type BenchAgentTurnResult,
  type BenchAgentUnavailable,
  type BenchMode,
  type BenchReplayStep,
  type BenchRunResult,
  type BenchStepResult,
  type SessionContextInput,
} from '@kioku/contracts'

import { ApiError } from './api/client'
import { internalErrorText, notExecuted } from './benchResult'
import { parseScenario, type ParsedScenario } from './benchScenarios'
import {
  emptySession,
  NOT_API_FAILURE,
  recordRun,
  replayFor,
  replayStepLabel,
  runBlocker,
  type BenchSession,
  type RunOutcome,
} from './benchSession'

// 测试台的模型对话：一条用户消息的循环、这次对话的状态、发给模型的历史、怎么显示、存成场景。
// 循环由浏览器驱动，一次请求只调一次模型，模型要调工具时走运行接口；请求都是注入的，这里不碰 Vue 和网络。
// 对话只在内存里：内容可能有明文，不存服务端，不进浏览器存储

// 每条用户消息最多请求这么多次模型：Key 是实例的，又不计入抽取预算，模型不能一直调下去
export const AGENT_MAX_ROUNDS = 8

// 系统提示的基础文字，界面上可以改，session.start 的结果接在后面
export const DEFAULT_SYSTEM_PROMPT = '你是一个有长期记忆的助手，用简体中文回答。'

// 宿主的会话标识：这里同时只有一段对话
const AGENT_SESSION_ID = 'bench-agent'
// 生命周期事件的文字上限和契约相同。插件同样先截：超长的话整个事件被拒，这一轮什么都拿不到
const LIFECYCLE_TEXT_MAX = 20_000

export const AGENT_LOOP_NOTES: Record<BenchAgentLoop, string> = {
  hook: '这个运行时有钩子：session.start 的结果进系统提示；每条消息先发 prompt.submit，召回块附在这条消息上、留在历史；给工具；回复后不发 turn.end。',
  approximate:
    '这个运行时这里没有单独模拟，按有钩子的运行时走（session.start 进系统提示，每条消息先发 prompt.submit，给工具，不发 turn.end）：只是近似，和它真实的行为可能不同。',
  chat: '这个运行时是群聊 bot：session.start 的结果进系统提示；每条消息先发 prompt.submit，召回块只附在这一轮的请求上、不留在历史；不给工具；回复后发 turn.end（它要带私聊、群聊或频道的会话上下文，不满足时不发）。',
  tools:
    '这个运行时只接 MCP：不发 session.start 与 prompt.submit，只给工具，kioku_boot 由模型自己调。',
}

export const AGENT_UNAVAILABLE_NOTES: Record<
  BenchAgentUnavailable,
  { title: string; description: string }
> = {
  notAdmin: {
    title: '模型对话只给实例管理员',
    description:
      '它用实例设置里抽取模型的接口与 Key：Key 是实例的，而且不计入抽取预算，不能让别的成员花。',
  },
  noModel: {
    title: '还没有配模型',
    description:
      '去实例设置配好抽取模型之后才能用，模型要支持工具调用。注意：配好之后抽取与 Dream 也会开始跑，Dream 默认把画像层与私人层发给这个模型；不想发的话，先在空间设置里关掉「Dream 与我的私人内容」再配。',
  },
  keyLocked: {
    title: '抽取模型的 Key 解不开',
    description:
      '配了模型，但保存的 Key 解不开：主密钥没配，或者换过。检查 KIOKU_MASTER_KEY（轮换时旧的那把配在 KIOKU_MASTER_KEY_PREVIOUS），或者在实例设置里重新填 Key。',
  },
}

// 开始之前的提示：哪些内容会发给哪个模型。发出去的是操作者自己这把 Key 读得到的内容，打码同样生效；
// 外部凭据源只有回滚模式打码，真实模式照常返回（设计里的规则），所以要说
export function consentText(loop: BenchAgentLoop, model: string, mode: BenchMode): string {
  const what: Record<BenchAgentLoop, string> = {
    hook: '启动上下文、召回块与工具结果',
    approximate: '启动上下文、召回块与工具结果',
    chat: '启动上下文与召回块',
    tools: '工具结果',
  }
  const masked =
    mode === 'real' && loop !== 'chat'
      ? 'secret 的正文与托管凭据的值都打码；真实模式下外部凭据源的条目位置与取法照常返回，也会发过去。'
      : 'secret 的正文与凭据的值都打码。'
  return `${what[loop]}会发给模型「${model}」（实例设置里抽取模型的接口）。发出去的都是这把 Key 读得到的内容；${masked}用量不计入抽取预算。`
}

// 消息的文字。content 可能是 null（只调工具时常见）、空串或分段数组（[{ type: 'text', text }]）
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : (part as { text?: unknown } | null)?.text))
    .filter((text) => typeof text === 'string')
    .join('')
}

const reasoningOf = (message: BenchAgentMessage): string | null => {
  const { reasoning_content: reasoning } = message
  return typeof reasoning === 'string' && reasoning ? reasoning : null
}

// 按 UTF-16 码元截断，和契约的 max 同一个数法。不切开代理对：落单的代理项不是合法的文字
export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const last = text.charCodeAt(limit - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit)
}

export interface AgentUsage {
  promptTokens: number
  completionTokens: number
  // 花在模型上的时间，不含工具（工具的耗时在每一步上）
  ms: number
  // 请求了几次模型
  rounds: number
}

// 一步的结果与它在这次运行里的位置
export interface AgentStepTrace {
  step: BenchStepResult
  // 这次运行的标记：真实模式下事件带着它，到活动里靠它对应
  run: string
  // 这一步的写入在这次对话的重放日志里，后面的调用读得到
  kept: boolean
}

export interface AgentToolTrace {
  id: string
  name: string
  // 发出去的参数；解析不出来时是 null
  arguments: Record<string, unknown> | null
  // 模型写的参数原文，解析不出来时显示它
  rawArguments: string
  // 回给模型的 tool 消息；还在执行时是 null
  reply: string | null
  // 服务端这一步的结果；没有执行时是 null
  trace: AgentStepTrace | null
}

export interface AgentRound {
  text: string
  reasoning: string | null
  finishReason: string | null
  model: string
  usage: BenchAgentTurnResult['usage']
  ms: number
  calls: AgentToolTrace[]
}

// 进行到哪一步，界面显示在等什么
export type AgentPhase = 'lifecycle' | 'model' | 'tools' | 'turnEnd'

export const agentPhaseLabels: Record<AgentPhase, string> = {
  lifecycle: '发生命周期事件…',
  model: '等模型回复…',
  tools: '执行工具…',
  turnEnd: '发 turn.end…',
}

// 这条消息怎么结束的。done：模型给了最终回复；empty：模型没有文字也没有工具调用；stopped：用户停止；limit：到了轮数上限；
// blocked：写入放不进重放日志；toolFailed：工具的运行请求失败；diverged：重放分叉；
// modelFailed：请求模型失败；lifecycleFailed：生命周期事件的运行请求失败；abandoned：换了应用、Key 或模式
export type AgentEnd =
  | 'done'
  | 'empty'
  | 'stopped'
  | 'limit'
  | 'blocked'
  | 'toolFailed'
  | 'diverged'
  | 'modelFailed'
  | 'lifecycleFailed'
  | 'abandoned'

// 一条用户消息的经过，只用来显示：发给模型的是 AgentConversation.messages
export interface AgentExchange {
  id: number
  user: string
  phase: AgentPhase | null
  // 还在进行时是 null
  end: AgentEnd | null
  // 结束时要告诉用户的；正常结束是 null
  notice: string | null
  // 这条消息进了历史，模型之后看得到它。请求模型之前就失败、模型一次都没有回复（或者回复是空的）时不进
  inHistory: boolean
  // session.start、prompt.submit 的结果
  lifecycle: AgentStepTrace[]
  // 附在这条消息上发给模型的内容（prompt.submit 给的）
  attached: string
  rounds: AgentRound[]
  // turn.end 的结果
  turnEnd: AgentStepTrace | null
  // 没发 turn.end 或者发失败了的原因
  turnEndNote: string | null
}

export interface AgentConversation {
  // 发给模型的历史，不含系统提示：系统提示可以改，每次请求时才放到最前面。
  // 始终合法：每个带 tool_calls 的助手消息后面都跟齐了 tool 消息，别的助手消息都有文字
  messages: BenchAgentMessage[]
  // session.start 的结果，接在系统提示后面。还没拿到时是 null：失败了下一条消息再发
  sessionText: string | null
  // 这个结果是按什么会话上下文拿到的：页面上换了上下文（换了群）就不算数了，真实的宿主那也是另一个会话
  sessionContext: string | null
  // 这次对话的重放日志，和调用台的会话分开：带上调用台的写入可能撞 URI，模型读到的也会依赖调用台的历史
  session: BenchSession
  exchanges: AgentExchange[]
  usage: AgentUsage
  // 点过一下、同意发给哪个模型。换了模型名要再问，换一段对话也要再问
  consentedModel: string | null
  nextId: number
}

export const emptyConversation = (): AgentConversation => ({
  messages: [],
  sessionText: null,
  sessionContext: null,
  session: emptySession(),
  exchanges: [],
  usage: { promptTokens: 0, completionTokens: 0, ms: 0, rounds: 0 },
  consentedModel: null,
  nextId: 1,
})

export const consentNeeded = (conversation: AgentConversation, model: string) =>
  conversation.consentedModel !== model

export interface AgentIO {
  // 请求一次模型。失败时 reject，停止时按 signal 取消
  turn(request: BenchAgentTurnRequest, signal: AbortSignal): Promise<BenchAgentTurnResult>
  // 跑一串步骤。replay 是这次对话的重放；label 说明这次运行是什么，真实模式中途作废时靠它说明
  run(steps: BenchStep[], replay: BenchReplayStep[], label: string): Promise<RunOutcome>
}

export interface AgentSendOptions {
  loop: BenchAgentLoop
  mode: BenchMode
  // 系统提示的基础文字
  system: string
  model: string
  // 页面上的会话上下文，一条消息从头到尾用同一份
  context: SessionContextInput | undefined
  signal: AbortSignal
  io: AgentIO
  // 每走一步给出新的状态：换一份新对象，不改旧的
  onChange(conversation: AgentConversation): void
}

// 请求模型时放在最前面的系统提示。两边都空时不带：有的接口不接受空的系统消息
export function systemMessage(base: string, sessionText: string | null): BenchAgentMessage | null {
  const content = [base.trim(), sessionText ?? ''].filter(Boolean).join('\n\n')
  return content ? { role: 'system', content } : null
}

// 这一步服务端没有执行：没有发出去，或者不满足前提
const didNotRun = (step: BenchStepResult) => step.status === 'skipped' || notExecuted(step)

// 工具结果回给模型的文字。不能是空的：内部错误、没有执行、跳过都要说明，模型才知道发生了什么。
// 看 isError 与 internalError，不看 status：没带断言的步骤工具报错也是 passed
export function toolReply(step: BenchStepResult): string {
  if (didNotRun(step)) return step.reason ? `没有执行：${step.reason}` : '没有执行'
  if (step.internalError) return `服务内部错误：${internalErrorText(step)}`
  return step.text || (step.isError ? '工具报错了，没有说明' : '（工具没有返回内容）')
}

// 这个工具调用发不出去的原因，能发时是 null。这些不算失败：作为工具错误回给模型，它可以重试。
// 按契约再校验一次（名字太长之类）：一步不合法的话运行请求会被整个拒绝，同一条消息里别的调用也跟着失败
function callRefusal(call: BenchAgentToolCall, loop: BenchAgentLoop): string | null {
  // 服务端不给这种运行时工具，模型还是自己编了工具调用时也不执行
  if (loop === 'chat') return '这个运行时不给工具，没有执行'
  if (call.parseError) return `没有执行：${call.parseError}`
  const parsed = BenchStep.safeParse({ kind: 'tool', tool: call.name, arguments: call.arguments })
  return parsed.success ? null : `没有执行：工具调用不合法（${parsed.error.issues[0]?.message}）`
}

const toolStep = (call: BenchAgentToolCall): BenchStep => ({
  kind: 'tool',
  tool: call.name,
  arguments: call.arguments ?? {},
})

const withContext = (context: SessionContextInput | undefined) => (context ? { context } : {})

// 工具调用都是一次运行里的步骤，结果和请求一一对应；时间线的最后几条就是这次运行的
function stepTraces(session: BenchSession, result: BenchRunResult): AgentStepTrace[] {
  const entries = session.timeline.slice(-result.steps.length)
  return result.steps.map((step, index) => ({
    step,
    run: result.run,
    kept: entries[index]?.kept ?? false,
  }))
}

// 生命周期事件给的文字。失败时不注入，和真实的插件一样不打断对话：轨迹里看得到这一步报错了
const injected = (step: BenchStepResult | undefined): string | null =>
  !step || step.isError || step.internalError || step.raw === null ? null : step.text

// 重放分叉：现在的数据和对话做这一步时不一样了才会报错。可以清空对话；内部错误多半是暂时的，可以再发一次
function divergedNotice(
  session: BenchSession,
  { index, text, internalError }: NonNullable<BenchRunResult['replayDiverged']>,
): string {
  const step = session.replay[index]
  const which = `第 ${index + 1} 步${step ? `（${replayStepLabel(step)}）` : ''}`
  return internalError
    ? `重放这次对话的写入时${which}报错，这一轮没有执行：${text}。可能是暂时的，可以再发一次；还是不行就清空对话。`
    : `重放这次对话的写入时${which}报错，这一轮没有执行：${text}。现在的数据和对话做这一步时不一样了，可以清空对话再来。`
}

// turn.end 的请求体。契约要求带私聊、群聊或频道的上下文，群里要有发言人
export function turnEndBody(
  context: SessionContextInput | undefined,
  user: string,
  reply: string,
): unknown {
  return {
    event: 'turn.end',
    sessionId: AGENT_SESSION_ID,
    ...withContext(context),
    user: clipText(user, LIFECYCLE_TEXT_MAX),
    reply: clipText(reply, LIFECYCLE_TEXT_MAX),
  }
}

// 页面上的会话上下文发不了 turn.end 的原因，能发时是 null。发不了就不发，轨迹里说明：规则按契约算，不另写一份
export function turnEndRefusal(
  context: SessionContextInput | undefined,
  body: unknown,
): string | null {
  if (!context) {
    return '没有发 turn.end：它要带私聊、群聊或频道的上下文，页面上的会话上下文是「不带」。'
  }
  const parsed = TurnEndEvent.safeParse(body)
  return parsed.success ? null : `没有发 turn.end：${parsed.error.issues[0]?.message}。`
}

// 请求模型失败的说明。502 带的是上游的错误原文（截断过，不带 API Key），只给实例管理员看。
// 504 是模型的时限之外的超时，多半是前面的反向代理等不及了。413 不一定是服务端拦的：反向代理拦下时没有服务端的那句话
export function turnFailureMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return `请求模型失败：${NOT_API_FAILURE}`
  if (err.status === 504) {
    return '请求模型超时（HTTP 504）：可能是反向代理等不及了。模型一次可能要一两分钟，反向代理的读超时要大于 120 秒。'
  }
  if (err.status === 413) return '对话太长，清空之后再试'
  return err.message
}

// 4xx 是确定性的（对话太长、模型名不合法、没有权限）：再发一次还是一样，prompt.submit 还要再跑一遍，
// 所以只给服务端的文字，不说可以再发。5xx 与网络错误才可能是暂时的
const turnRetryable = (err: unknown) => !(err instanceof ApiError && err.status < 500)

const RETRY = '可以再发一次。'
const KEPT_IN_HISTORY = '做过的都留在历史里，可以接着说下一句。'

// 报错原文可能已经带句号，也可能没有
const sentences = (first: string, second: string) =>
  `${first}${first.endsWith('。') ? '' : '。'}${second}`

// 模型没有文字也没有工具调用的说明。length 多半是输出额度都用在了思考上（推理模型常见）
function emptyReplyText(finishReason: string | null): string {
  if (finishReason === 'length') {
    return '模型没有返回文字（结束原因 length：输出额度可能都用在了思考上）'
  }
  return `模型没有返回文字（${finishReason ? `结束原因 ${finishReason}` : '上游没有给结束原因'}）`
}

// 发一条用户消息，走完这条消息的循环。无论怎样结束，历史都是合法的，用户还能接着说下一句：
// - 没完成的 tool_call 都补一条 tool 消息（停止、到上限、工具请求失败、重放分叉）。
// - 请求模型失败或被停止时不留半截。模型回复过的话，做过的都留着：这时每个 tool_call 都有了结果，不用再补，
//   真实模式下工具已经写了，模型要知道。模型一次都没有回复时回到这条消息之前：这时什么都没做，
//   留着的话下一句就成了连着两条用户消息，有的接口不接受，模型也没看过它；界面把文字放回输入框，可以再发一次。
// - 模型没有文字也没有工具调用（推理模型把额度都用在思考上时常见）：这条空的助手消息不进历史，严格的上游不接受，
//   留着的话之后每一轮都 400。没有别的回复时同样回到这条消息之前；调过工具的话历史以 tool 消息结束，下一句照样合法。
// 停止之后不再发新的请求；已经发出去的运行等它回来，结果照样记下（真实模式下它可能已经写了）
export async function sendAgentMessage(
  start: AgentConversation,
  text: string,
  { loop, mode, system, model, context, signal, io, onChange }: AgentSendOptions,
): Promise<AgentConversation> {
  let state: AgentConversation = {
    ...start,
    exchanges: [
      ...start.exchanges,
      {
        id: start.nextId,
        user: text,
        phase: null,
        end: null,
        notice: null,
        inHistory: false,
        lifecycle: [],
        attached: '',
        rounds: [],
        turnEnd: null,
        turnEndNote: null,
      },
    ],
    nextId: start.nextId + 1,
  }
  onChange(state)

  const update = (change: Partial<AgentConversation>) => {
    state = { ...state, ...change }
    onChange(state)
  }
  const updateExchange = (change: Partial<AgentExchange>) => {
    const exchange = { ...state.exchanges.at(-1)!, ...change }
    update({ exchanges: [...state.exchanges.slice(0, -1), exchange] })
  }

  // 这条消息之后的助手消息与 tool 消息
  const working: BenchAgentMessage[] = []
  const plainUser: BenchAgentMessage = { role: 'user', content: text }
  // 留在历史里的用户消息
  let keptUser = plainUser
  const finish = (end: AgentEnd, notice: string | null) => {
    const inHistory = working.length > 0
    updateExchange({ phase: null, end, notice, inHistory })
    if (inHistory) update({ messages: [...state.messages, keptUser, ...working] })
    return state
  }

  // 发一次运行，带上这次对话的重放，结果记进重放日志
  const runSteps = async (steps: BenchStep[], label: string) => {
    const outcome = await io.run(steps, replayFor(state.session, mode), label)
    if (outcome.kind !== 'done') return outcome
    const session = recordRun(state.session, outcome.result)
    update({ session })
    return { ...outcome, traces: stepTraces(session, outcome.result) }
  }

  const blocked = runBlocker(state.session, mode)
  if (blocked) return finish('blocked', blocked)

  let attached = ''
  if (loop !== 'tools') {
    const contextKey = JSON.stringify(context ?? null)
    const starting = state.sessionText === null || state.sessionContext !== contextKey
    const steps: BenchStep[] = [
      {
        kind: 'lifecycle',
        body: {
          event: 'prompt.submit',
          sessionId: AGENT_SESSION_ID,
          ...withContext(context),
          prompt: clipText(text, LIFECYCLE_TEXT_MAX),
        },
      },
    ]
    if (starting) {
      steps.unshift({
        kind: 'lifecycle',
        body: { event: 'session.start', sessionId: AGENT_SESSION_ID, ...withContext(context) },
      })
    }
    updateExchange({ phase: 'lifecycle' })
    const outcome = await runSteps(steps, '模型对话的生命周期事件')
    if (outcome.kind === 'stale') return finish('abandoned', null)
    if (outcome.kind === 'failed') {
      return finish('lifecycleFailed', sentences(outcome.message, `没有请求模型，${RETRY}`))
    }
    updateExchange({ lifecycle: outcome.traces })
    const diverged = outcome.result.replayDiverged
    if (diverged) return finish('diverged', divergedNotice(state.session, diverged))
    if (starting) {
      const sessionText = injected(outcome.result.steps[0])
      update({ sessionText, sessionContext: sessionText === null ? null : contextKey })
    }
    attached = injected(outcome.result.steps.at(-1)) ?? ''
    updateExchange({ attached })
  }

  const sentUser = attached ? { role: 'user', content: `${text}\n\n${attached}` } : plainUser
  // 聊天类的宿主把召回块当临时内容，只附在这一轮的请求上
  if (loop !== 'chat') keptUser = sentUser
  const head = systemMessage(system, state.sessionText)
  const before = [...(head ? [head] : []), ...state.messages, sentUser]
  const afterReply = () => (working.length ? KEPT_IN_HISTORY : RETRY)

  let reply: string
  // 回复是空的、这条消息又留在历史里（之前调过工具）时的说明
  let emptyNotice: string | null = null
  for (let round = 1; ; round++) {
    if (signal.aborted) return finish('stopped', `已停止。${afterReply()}`)
    updateExchange({ phase: 'model' })
    let turn: BenchAgentTurnResult
    try {
      turn = await io.turn({ model, messages: [...before, ...working] }, signal)
    } catch (err) {
      if (signal.aborted) return finish('stopped', `已停止。${afterReply()}`)
      const failure = turnFailureMessage(err)
      return finish('modelFailed', turnRetryable(err) ? sentences(failure, afterReply()) : failure)
    }

    const text = contentText(turn.message.content)
    const empty = !turn.toolCalls.length && !text.trim()
    if (!empty) working.push(turn.message)
    const calls = turn.toolCalls.map((call): AgentToolTrace => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      rawArguments: call.rawArguments ?? '',
      reply: null,
      trace: null,
    }))
    const answered: AgentRound = {
      text: empty ? '' : text,
      reasoning: reasoningOf(turn.message),
      finishReason: turn.finishReason,
      model: turn.model,
      usage: turn.usage,
      ms: turn.ms,
      calls,
    }
    const rounds = state.exchanges.at(-1)!.rounds
    updateExchange({ rounds: [...rounds, answered] })
    update({
      usage: {
        promptTokens: state.usage.promptTokens + turn.usage.promptTokens,
        completionTokens: state.usage.completionTokens + turn.usage.completionTokens,
        ms: state.usage.ms + turn.ms,
        rounds: state.usage.rounds + 1,
      },
    })
    if (!calls.length) {
      reply = answered.text
      if (empty) {
        emptyNotice = sentences(emptyReplyText(turn.finishReason), afterReply())
        // 这条消息回到发之前了，文字要放回输入框：发了 turn.end 的话，再发一次这一轮就进两次对话缓冲
        if (!working.length) {
          if (loop === 'chat') updateExchange({ turnEndNote: '模型没有回复，没有发 turn.end。' })
          return finish('empty', emptyNotice)
        }
      }
      break
    }

    // 把这一轮的工具调用都答上：按原来的顺序，一个 tool_call 一条 tool 消息
    const answer = (
      replyOf: (index: number) => string,
      traceOf: (index: number) => AgentStepTrace | null = () => null,
    ) => {
      const done = calls.map((call, index) => ({
        ...call,
        reply: replyOf(index),
        trace: traceOf(index),
      }))
      updateExchange({ rounds: [...rounds, { ...answered, calls: done }] })
      done.forEach((call, index) => {
        working.push({ role: 'tool', tool_call_id: call.id, content: replyOf(index) })
      })
    }

    if (signal.aborted) {
      answer(() => '已停止，没有执行')
      return finish('stopped', `已停止，这一轮的工具调用没有执行。${KEPT_IN_HISTORY}`)
    }
    // 这一轮的结果没有下一次请求能告诉模型了，执行了也白写
    if (round === AGENT_MAX_ROUNDS) {
      answer(() => `到了 ${AGENT_MAX_ROUNDS} 轮上限，没有执行`)
      return finish(
        'limit',
        `到了 ${AGENT_MAX_ROUNDS} 轮上限：模型还想调工具，这些调用没有执行。可以接着说下一句，让它继续。`,
      )
    }
    // 上一轮有写入放不进重放日志：再运行就和模型知道的对不上了
    const overflowed = runBlocker(state.session, mode)
    if (overflowed) {
      answer(() => '写入放不进重放日志了，没有执行')
      return finish('blocked', overflowed)
    }

    const refusals = turn.toolCalls.map((call) => callRefusal(call, loop))
    const sendable = turn.toolCalls.flatMap((call, index) =>
      refusals[index] ? [] : [{ index, call }],
    )
    if (!sendable.length) {
      answer((index) => refusals[index]!)
      continue
    }
    updateExchange({ phase: 'tools' })
    const outcome = await runSteps(
      sendable.map(({ call }) => toolStep(call)),
      `模型对话的工具调用（${sendable.map(({ call }) => call.name).join('、')}）`,
    )
    // 这一轮发出去的都没有结果，发不出去的照旧说它们自己的原因
    const answerFailed = (why: string) => answer((index) => refusals[index] ?? why)
    if (outcome.kind === 'stale') {
      answerFailed('对话已经作废，没有结果')
      return finish('abandoned', null)
    }
    if (outcome.kind === 'failed') {
      answerFailed(`工具请求失败，没有拿到结果：${outcome.message}`)
      return finish('toolFailed', sentences(`工具请求失败：${outcome.message}`, KEPT_IN_HISTORY))
    }
    const diverged = outcome.result.replayDiverged
    if (diverged) {
      answerFailed('测试台重放之前的写入时报错，这次没有执行')
      return finish('diverged', divergedNotice(state.session, diverged))
    }
    const traceByCall = new Map(sendable.map(({ index }, step) => [index, outcome.traces[step]]))
    answer(
      (index) => {
        const trace = traceByCall.get(index)
        return refusals[index] ?? (trace ? toolReply(trace.step) : '没有执行：服务端没有给结果')
      },
      (index) => traceByCall.get(index) ?? null,
    )
  }

  if (loop === 'chat') {
    const body = turnEndBody(context, text, reply)
    const refusal = signal.aborted
      ? '已停止，没有发 turn.end。'
      : (turnEndRefusal(context, body) ?? runBlocker(state.session, mode))
    if (refusal) {
      updateExchange({ turnEndNote: refusal })
    } else {
      updateExchange({ phase: 'turnEnd' })
      const outcome = await runSteps([{ kind: 'lifecycle', body }], '模型对话的 turn.end')
      if (outcome.kind === 'stale') return finish('abandoned', null)
      if (outcome.kind === 'failed') {
        updateExchange({ turnEndNote: `turn.end 请求失败：${outcome.message}` })
      } else if (outcome.result.replayDiverged) {
        updateExchange({
          turnEndNote: divergedNotice(state.session, outcome.result.replayDiverged),
        })
      } else {
        updateExchange({ turnEnd: outcome.traces[0] ?? null })
      }
    }
  }
  return finish(emptyNotice ? 'empty' : 'done', emptyNotice)
}

// 下面是给界面的：怎么显示

// 结束时的提示用什么颜色：停止是用户自己做的，上限和空的回复是预期之内的
export const noticeColor = (end: AgentEnd | null): 'neutral' | 'warning' | 'error' =>
  end === 'stopped' ? 'neutral' : end === 'limit' || end === 'empty' ? 'warning' : 'error'

export const attachedNote = (loop: BenchAgentLoop) =>
  loop === 'chat'
    ? 'prompt.submit 给的内容只附在这一轮的请求上，不留在历史。'
    : 'prompt.submit 给的内容附在这条消息上，留在历史。'

// 这一步要不要展开：要看的是出了问题的那几步
export const callOpen = (step: BenchStepResult) =>
  step.isError || step.internalError || didNotRun(step)

// 显示用的参数：解析不出来时给模型写的原文
export const argumentsText = (call: AgentToolTrace) =>
  call.arguments ? JSON.stringify(call.arguments, null, 2) : call.rawArguments || '（没有参数）'

const seconds = (ms: number) => (ms / 1000).toFixed(1)

// stop 与 tool_calls 是正常的结束，别的（被截断、内容过滤）要说出来
const NORMAL_FINISHES: ReadonlySet<string | null> = new Set([null, 'stop', 'tool_calls'])

// 一轮的用量。上游没给用量时是 0，不说成用了 0 个
export function roundMeta(round: AgentRound): string {
  const { promptTokens, completionTokens } = round.usage
  return [
    round.model,
    promptTokens || completionTokens
      ? `输入 ${promptTokens}、输出 ${completionTokens} token`
      : '上游没有给用量',
    `${seconds(round.ms)} 秒`,
    ...(NORMAL_FINISHES.has(round.finishReason) ? [] : [`结束原因 ${round.finishReason}`]),
  ].join(' · ')
}

// 这一轮的工具调用放在同一次运行里，运行标记只有一个；没有发出去时是 null
export const roundRun = (round: AgentRound) =>
  round.calls.find((call) => call.trace)?.trace?.run ?? null

export const usageSummary = ({ promptTokens, completionTokens, ms, rounds }: AgentUsage) =>
  `累计请求模型 ${rounds} 次：输入 ${promptTokens}、输出 ${completionTokens} token，模型耗时 ${seconds(ms)} 秒。不计入抽取预算。`

// 下面是存成场景

// 发出去的工具调用，没有执行的（解析失败、停止、上限、请求失败、服务端没有执行）不算：场景的步骤用发出去的参数
export const sentToolCalls = (conversation: AgentConversation) =>
  conversation.exchanges
    .flatMap((exchange) => exchange.rounds.flatMap((round) => round.calls))
    .filter((call) => call.trace !== null && !didNotRun(call.trace.step))

export interface AgentScenarioExport {
  parsed: ParsedScenario
  // 超过场景的步数上限、没有存进去的个数。按顺序留前面的：后面的步骤依赖前面的写入
  dropped: number
}

// 真的存了之后才说少了几个：有明文要确认时，取消了就什么都没存
export const droppedNote = (dropped: number) =>
  dropped
    ? `场景最多 ${BENCH_MAX_STEPS} 步：只存了前面的 ${BENCH_MAX_STEPS} 个工具调用，后面 ${dropped} 个没有存。`
    : null

// 这次对话的工具调用存成场景，按契约校验。没有发出去过工具调用时是 null
export function agentScenario(
  conversation: AgentConversation,
  now: Date,
): AgentScenarioExport | null {
  const calls = sentToolCalls(conversation)
  if (!calls.length) return null
  const kept = calls.slice(0, BENCH_MAX_STEPS)
  return {
    parsed: parseScenario(
      JSON.stringify({
        id: `agent-${now.toISOString().replace(/\D/g, '').slice(0, 14)}`,
        title: '模型对话的工具调用',
        description: '从测试台的模型对话存下来的工具调用，参数是当时发出去的。',
        steps: kept.map((call) => ({
          kind: 'tool',
          tool: call.name,
          arguments: call.arguments ?? {},
        })),
      }),
    ),
    dropped: calls.length - kept.length,
  }
}
