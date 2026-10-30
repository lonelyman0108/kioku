import {
  BENCH_MAX_REPLAY_BYTES,
  BENCH_MAX_REQUEST_BYTES,
  BENCH_MAX_STEPS,
  BenchAgentTurnRequest,
  BenchReplayStep,
  BenchRunRequest,
  BenchScenario,
  isReplayStep,
  type BenchAgentLoop,
  type BenchAgentMessage,
  type BenchAgentToolCall,
  type BenchAgentTurnResult,
  type BenchMode,
  type BenchRunResult,
  type BenchStep,
  type BenchStepResult,
  type SessionContextInput,
  type WhoAmI,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import {
  acceptAgentDivergence,
  AGENT_LOOP_NOTES,
  AGENT_MAX_ROUNDS,
  agentScenario,
  argumentsText,
  blockingDivergence,
  callOpen,
  clipText,
  consentNeeded,
  consentText,
  contentText,
  DEFAULT_SYSTEM_PROMPT,
  droppedNote,
  emptyConversation,
  noticeColor,
  roundMeta,
  roundRun,
  sendAgentMessage,
  sentToolCalls,
  systemMessage,
  toolReply,
  turnEndBody,
  turnEndRefusal,
  turnFailureMessage,
  usageSummary,
  type AgentConsent,
  type AgentConversation,
  type AgentIO,
} from '../benchAgent'
import { plaintextIn } from '../benchScenarios'
import { NOT_API_FAILURE, type RunOutcome } from '../benchSession'

const USER_TEXT = '记下我喜欢喝茶'
const SESSION_TEXT = '<启动上下文>'
const RECALL_TEXT = '<recall>线索</recall>'
const MODEL = 'fake-model'
const HOST = 'model.example.com'

const GROUP: SessionContextInput = {
  chatType: 'group',
  platform: 'bench',
  group: { id: 'g1' },
  sender: { id: 'u1', name: '群友' },
}

// 历史合法：每个带 tool_calls 的助手消息后面紧跟着它的每一个 tool_call_id，没有落单的 tool 消息；
// 不带 tool_calls 的助手消息有文字。不合法时上游下一轮就拒绝（有 tool_calls 却没跟 tool 消息时 deepseek 回 400）
function historyProblem(messages: readonly BenchAgentMessage[]): string | null {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role === 'tool') return `第 ${i} 条 tool 消息前面没有对应的 tool_calls`
    const calls = message.tool_calls as { id: string }[] | undefined
    if (!calls) {
      if (message.role === 'assistant' && !contentText(message.content).trim()) {
        return `第 ${i} 条助手消息没有工具调用，也没有文字`
      }
      continue
    }
    const ids = calls.map((call) => call.id)
    const following = messages.slice(i + 1, i + 1 + ids.length)
    const answered = following.map((m) => (m.role === 'tool' ? m.tool_call_id : null))
    if (JSON.stringify(answered) !== JSON.stringify(ids)) {
      return `第 ${i} 条的 tool_calls 是 ${ids.join()}，后面跟的是 ${answered.join()}`
    }
    if (following.some((m) => typeof m.content !== 'string' || !m.content)) {
      return `第 ${i} 条的 tool 消息有空内容`
    }
    i += ids.length
  }
  return null
}

const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown> | null = {},
  parseError: string | null = null,
): BenchAgentToolCall => ({
  id,
  name,
  arguments: args,
  parseError,
  // 和服务端一样：解析失败时才有原文
  ...(args ? {} : { rawArguments: '{坏的' }),
})

// 模型的一次回复。message 和 toolCalls 一一对应，和服务端给的一样
function reply(
  content: unknown,
  calls: BenchAgentToolCall[] = [],
  extra: Record<string, unknown> = {},
): BenchAgentTurnResult {
  return {
    message: {
      role: 'assistant',
      content,
      ...(calls.length
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name || 'unknown_tool',
                // 和服务端一样：放回历史的只有合法的 JSON，解析失败的换成 {}
                arguments: call.arguments ? JSON.stringify(call.arguments) : '{}',
              },
            })),
          }
        : {}),
      ...extra,
    },
    toolCalls: calls,
    finishReason: calls.length ? 'tool_calls' : 'stop',
    usage: { promptTokens: 100, completionTokens: 20 },
    ms: 500,
    model: MODEL,
  }
}

const baseStep = (over: Partial<BenchStepResult> = {}): BenchStepResult => ({
  index: 0,
  label: 'x',
  kind: 'tool',
  status: 'passed',
  reason: null,
  isError: false,
  internalError: false,
  internalDetail: null,
  httpStatus: null,
  text: '结果',
  raw: {},
  ms: 3,
  uris: [],
  session: null,
  vectorSkipped: false,
  assertions: [],
  captured: {},
  changes: null,
  replay: null,
  ...over,
})

const eventOf = (step: BenchStep) =>
  step.kind === 'lifecycle' ? (step.body as { event: string }).event : null

// 一步的默认结果：和服务端一样，只有成功的写步骤（写工具与 turn.end）才给 replay
function defaultStep(step: BenchStep, index: number): BenchStepResult {
  const event = eventOf(step)
  const text =
    event === 'session.start'
      ? SESSION_TEXT
      : event === 'prompt.submit'
        ? RECALL_TEXT
        : event === 'turn.end'
          ? ''
          : `${step.kind === 'tool' ? step.tool : step.kind} 的结果`
  return baseStep({
    index,
    label: step.kind === 'tool' ? step.tool : (event ?? step.kind),
    kind: step.kind,
    text,
    replay: isReplayStep(step) ? BenchReplayStep.parse(step) : null,
  })
}

const runResult = (
  mode: BenchMode,
  steps: BenchStepResult[],
  run = 'run12345',
): BenchRunResult => ({
  run,
  mode,
  ok: true,
  whoami: {} as WhoAmI,
  counts: { passed: steps.length, failed: 0, skipped: 0, notRun: 0 },
  steps,
  replayDiverged: null,
})

// 请求体的字节数，和 api.benchRun 发的一样
const bodyBytes = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).length

type TurnScript =
  | BenchAgentTurnResult
  | Error
  | ((signal: AbortSignal) => BenchAgentTurnResult | Promise<BenchAgentTurnResult>)

interface HarnessOptions {
  loop?: BenchAgentLoop
  mode?: BenchMode
  system?: string
  context?: SessionContextInput
  turns?: TurnScript[]
  run?: (steps: BenchStep[], replay: unknown[]) => RunOutcome | Promise<RunOutcome>
}

// 注入假的模型与运行接口。发出去的请求都按契约校验，并记下来；每次请求模型都核对一遍历史是否合法
function harness(options: HarnessOptions = {}) {
  const { loop = 'hook', mode = 'rollback', system = '基础提示', context, run } = options
  const script = [...(options.turns ?? [])]
  const turnRequests: BenchAgentMessage[][] = []
  const runs: { steps: BenchStep[]; replay: unknown[]; label: string }[] = []
  const changes: AgentConversation[] = []
  const controller = new AbortController()
  let unexpected: string | null = null

  const io: AgentIO = {
    async turn(request, signal) {
      const parsed = BenchAgentTurnRequest.parse(request)
      expect(parsed.model).toBe(MODEL)
      turnRequests.push(structuredClone(parsed.messages))
      const problem = historyProblem(parsed.messages)
      if (problem) unexpected = problem
      const next = script.shift()
      if (!next) throw new Error('模型被多请求了一次')
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(signal) : next
    },
    async run(steps, replay, label) {
      const parsed = BenchRunRequest.parse({ mode, steps, replay })
      // 超过上限时服务端直接 413，整个运行都没有了
      expect(bodyBytes({ mode, steps, replay })).toBeLessThanOrEqual(BENCH_MAX_REQUEST_BYTES)
      runs.push({ steps: parsed.steps, replay: parsed.replay, label })
      if (run) return run(parsed.steps, parsed.replay)
      return { kind: 'done', result: runResult(mode, parsed.steps.map(defaultStep)) }
    },
  }
  const send = async (text: string, from: AgentConversation = emptyConversation()) => {
    const finished = await sendAgentMessage(from, text, {
      loop,
      mode,
      system,
      model: MODEL,
      context,
      signal: controller.signal,
      io,
      onChange: (next) => changes.push(next),
    })
    expect(unexpected).toBeNull()
    expect(historyProblem(finished.messages)).toBeNull()
    expect(changes.at(-1)).toBe(finished)
    return finished
  }
  return { send, turnRequests, runs, changes, controller, script }
}

const last = (conversation: AgentConversation) => conversation.exchanges.at(-1)!
const toolMessages = (messages: readonly BenchAgentMessage[]) =>
  messages.filter((m) => m.role === 'tool')
const contents = (messages: readonly BenchAgentMessage[]) => messages.map((m) => m.content)
const events = (steps: readonly BenchStep[]) => steps.map(eventOf)

// 等被取消才结束的模型请求，和真的 fetch 一样抛 AbortError
const hangUntilAborted = (signal: AbortSignal) =>
  new Promise<BenchAgentTurnResult>((_resolve, reject) => {
    signal.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    )
  })

describe('hook 循环', () => {
  it('session.start 的结果进系统提示；召回块附在这条消息上、留在历史；给工具，不发 turn.end', async () => {
    const h = harness({
      turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply('好了'), reply('第二句')],
    })
    const first = await h.send(USER_TEXT)

    // 第一条消息：session.start 与 prompt.submit 放在同一次运行里，先于模型
    expect(events(h.runs[0]!.steps)).toEqual(['session.start', 'prompt.submit'])
    expect((h.runs[0]!.steps[1] as { body: { prompt: string } }).body.prompt).toBe(USER_TEXT)
    const sent = `${USER_TEXT}\n\n${RECALL_TEXT}`
    expect(h.turnRequests[0]).toEqual([
      { role: 'system', content: `基础提示\n\n${SESSION_TEXT}` },
      { role: 'user', content: sent },
    ])
    // 第二轮：助手消息与 tool 消息接在后面，用户消息还带着召回块
    expect(h.turnRequests[1]!.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(h.turnRequests[1]![1]!.content).toBe(sent)
    // 留在历史
    expect(first.messages[0]).toEqual({ role: 'user', content: sent })
    expect(first.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(last(first).end).toBe('done')
    expect(last(first).inHistory).toBe(true)
    expect(last(first).attached).toBe(RECALL_TEXT)
    expect(last(first).notice).toBeNull()
    expect(h.runs.flatMap((r) => events(r.steps))).not.toContain('turn.end')

    // 第二条消息：不再发 session.start，上一条的召回块还在历史里
    const second = await h.send('第二条', first)
    expect(events(h.runs[2]!.steps)).toEqual(['prompt.submit'])
    expect(h.turnRequests[2]![1]!.content).toBe(sent)
    expect(h.turnRequests[2]![0]!.content).toBe(`基础提示\n\n${SESSION_TEXT}`)
    expect(h.turnRequests[2]!.at(-1)!.content).toBe(`第二条\n\n${RECALL_TEXT}`)
    expect(second.messages).toHaveLength(6)
  })

  it('prompt.submit 没有召回块：这条消息就是用户的话，不多出空行', async () => {
    const h = harness({
      turns: [reply('好')],
      run: (steps) => ({
        kind: 'done',
        result: runResult(
          'rollback',
          steps.map((s, i) => baseStep({ ...defaultStep(s, i), text: '' })),
        ),
      }),
    })
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests[0]).toEqual([
      { role: 'system', content: '基础提示' },
      { role: 'user', content: USER_TEXT },
    ])
    expect(last(done).attached).toBe('')
    // 空的启动上下文也算拿到了，下一条消息不再发
    expect(done.sessionText).toBe('')
    expect(done.sessionContext).not.toBeNull()
  })

  it('其余运行时（approximate）按这个走，界面说明是近似', async () => {
    const h = harness({ loop: 'approximate', turns: [reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(events(h.runs[0]!.steps)).toEqual(['session.start', 'prompt.submit'])
    expect(done.messages[0]!.content).toBe(`${USER_TEXT}\n\n${RECALL_TEXT}`)
    expect(AGENT_LOOP_NOTES.approximate).toContain('近似')
  })

  it('页面上的会话上下文带给生命周期事件，工具步骤不带', async () => {
    const h = harness({
      context: GROUP,
      turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply('好')],
    })
    await h.send(USER_TEXT)
    const [start, submit] = h.runs[0]!.steps as { body: { context: unknown } }[]
    expect(start!.body.context).toEqual(GROUP)
    expect(submit!.body.context).toEqual(GROUP)
    expect(h.runs[1]!.steps[0]).toEqual({ kind: 'tool', tool: 'kioku_list', arguments: {} })
  })

  it.each(['hook', 'approximate', 'tools'] as const)(
    '%s 不发 turn.end：上下文满足时也不发，也不说没发的原因',
    async (loop) => {
      const h = harness({ loop, context: GROUP, turns: [reply('好')] })
      const done = await h.send(USER_TEXT)
      expect(h.runs.flatMap((r) => events(r.steps))).not.toContain('turn.end')
      expect(last(done).turnEnd).toBeNull()
      expect(last(done).turnEndNote).toBeNull()
    },
  )

  it('不带上下文时事件里没有 context 字段', async () => {
    const h = harness({ turns: [reply('好')] })
    await h.send(USER_TEXT)
    for (const step of h.runs[0]!.steps) {
      expect(Object.keys((step as { body: object }).body)).not.toContain('context')
    }
  })

  it('页面上换了上下文：真实的宿主那是另一个会话，session.start 重新发一次', async () => {
    const first = harness({ turns: [reply('好')] })
    const conversation = await first.send(USER_TEXT)
    const second = harness({ context: GROUP, turns: [reply('好')] })
    const done = await second.send('第二条', conversation)
    expect(events(second.runs[0]!.steps)).toEqual(['session.start', 'prompt.submit'])
    expect(done.sessionContext).toBe(JSON.stringify(GROUP))

    const same = harness({ context: GROUP, turns: [reply('好')] })
    await same.send('第三条', done)
    expect(events(same.runs[0]!.steps)).toEqual(['prompt.submit'])
  })

  it('生命周期事件报错不打断对话，和真实的插件一样：不注入，轨迹里看得到；session.start 下一条再发', async () => {
    const failing = (steps: BenchStep[]): RunOutcome => ({
      kind: 'done',
      result: runResult(
        'rollback',
        steps.map((s, i) =>
          baseStep({ ...defaultStep(s, i), isError: true, text: '群聊要带上群' }),
        ),
      ),
    })
    const h = harness({ run: failing, turns: [reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests[0]).toEqual([
      { role: 'system', content: '基础提示' },
      { role: 'user', content: USER_TEXT },
    ])
    expect(last(done).lifecycle.map((t) => t.step.isError)).toEqual([true, true])
    expect(last(done).attached).toBe('')
    expect(done.sessionText).toBeNull()

    const next = harness({ turns: [reply('好')] })
    const again = await next.send('第二条', done)
    expect(events(next.runs[0]!.steps)).toEqual(['session.start', 'prompt.submit'])
    expect(again.sessionText).toBe(SESSION_TEXT)
  })

  it('内部错误与没有执行的生命周期事件同样不注入', async () => {
    const h = harness({
      turns: [reply('好')],
      run: (steps) => ({
        kind: 'done',
        result: runResult('rollback', [
          // 根事务中止时工具本身没报错，只标了内部错误：只看 isError 的话它的文字会被注入
          baseStep({ ...defaultStep(steps[0]!, 0), internalError: true }),
          baseStep({ ...defaultStep(steps[1]!, 1), status: 'notRun', raw: null, text: '不该用' }),
        ]),
      }),
    })
    await h.send(USER_TEXT)
    expect(h.turnRequests[0]).toEqual([
      { role: 'system', content: '基础提示' },
      { role: 'user', content: USER_TEXT },
    ])
  })

  it('生命周期事件的运行请求失败：不请求模型，这条消息不进历史，下一条接得上', async () => {
    const h = harness({
      turns: [reply('好')],
      run: () => ({ kind: 'failed', message: '同时运行的回滚太多', retryable: true }),
    })
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests).toEqual([])
    expect(done.messages).toEqual([])
    expect(last(done).end).toBe('lifecycleFailed')
    expect(last(done).inHistory).toBe(false)
    expect(last(done).notice).toContain('同时运行的回滚太多')
    expect(last(done).notice).toContain('没有请求模型')

    const next = harness({ turns: [reply('好')] })
    const again = await next.send(USER_TEXT, done)
    expect(contents(again.messages)).toEqual([`${USER_TEXT}\n\n${RECALL_TEXT}`, '好'])
  })

  it('生命周期事件的运行请求被确定性地拒绝：只显示原因，不说可以再发', async () => {
    const h = harness({
      turns: [reply('不该到这里')],
      run: () => ({ kind: 'failed', message: '没有这把 Key', retryable: false }),
    })
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests).toEqual([])
    expect(last(done).end).toBe('lifecycleFailed')
    expect(last(done).notice).toBe('没有这把 Key')
    expect(last(done).inHistory).toBe(false)
    expect(done.messages).toEqual([])
  })

  it('生命周期事件的运行请求可能是暂时失败：说可以再发一次', async () => {
    const h = harness({
      turns: [reply('不该到这里')],
      run: () => ({ kind: 'failed', message: '服务内部错误', retryable: true }),
    })
    expect(last(await h.send(USER_TEXT)).notice).toBe('服务内部错误。没有请求模型，可以再发一次。')
  })

  it('系统提示每次请求时才拼：这条消息之前改过的，下一轮就用新的，历史里不留', async () => {
    const first = harness({ system: '旧的', turns: [reply('好')] })
    const conversation = await first.send(USER_TEXT)
    expect(conversation.messages.map((m) => m.role)).not.toContain('system')
    const second = harness({ system: '新的', turns: [reply('好')] })
    await second.send('第二条', conversation)
    expect(second.turnRequests[0]![0]).toEqual({
      role: 'system',
      content: `新的\n\n${SESSION_TEXT}`,
    })
    expect(second.turnRequests[0]!.filter((m) => m.role === 'system')).toHaveLength(1)
  })
})

describe('chat 循环', () => {
  it('session.start 进系统提示；召回块只附在这一轮的请求上、不留在历史；不给工具；回复后发 turn.end', async () => {
    const h = harness({
      loop: 'chat',
      context: GROUP,
      turns: [reply('你好呀'), reply('第二句')],
    })
    const first = await h.send(USER_TEXT)

    expect(events(h.runs[0]!.steps)).toEqual(['session.start', 'prompt.submit'])
    expect(h.turnRequests[0]).toEqual([
      { role: 'system', content: `基础提示\n\n${SESSION_TEXT}` },
      { role: 'user', content: `${USER_TEXT}\n\n${RECALL_TEXT}` },
    ])
    // 历史里只有用户的原话
    expect(contents(first.messages)).toEqual([USER_TEXT, '你好呀'])
    expect(last(first).attached).toBe(RECALL_TEXT)

    // turn.end：用户的原话与回复，不带召回块
    expect(events(h.runs[1]!.steps)).toEqual(['turn.end'])
    expect((h.runs[1]!.steps[0] as { body: unknown }).body).toEqual({
      event: 'turn.end',
      sessionId: 'bench-agent',
      context: GROUP,
      user: USER_TEXT,
      reply: '你好呀',
    })
    expect(last(first).turnEnd?.step.label).toBe('turn.end')
    expect(last(first).turnEndNote).toBeNull()
    expect(last(first).end).toBe('done')

    // 回滚模式下 turn.end 进重放；上一轮的召回块不在下一轮的请求里
    expect(first.session.replay).toHaveLength(1)
    const second = await h.send('第二条', first)
    expect(h.runs[2]!.replay).toEqual(first.session.replay)
    expect(contents(h.turnRequests[1]!)).toEqual([
      `基础提示\n\n${SESSION_TEXT}`,
      USER_TEXT,
      '你好呀',
      `第二条\n\n${RECALL_TEXT}`,
    ])
    expect(contents(second.messages)).toEqual([USER_TEXT, '你好呀', '第二条', '第二句'])
    expect(second.session.replay).toHaveLength(2)
  })

  it('真实模式：turn.end 真实执行，不进重放，也不带重放', async () => {
    const h = harness({ loop: 'chat', mode: 'real', context: GROUP, turns: [reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(events(h.runs[1]!.steps)).toEqual(['turn.end'])
    expect(h.runs.every((run) => run.replay.length === 0)).toBe(true)
    expect(done.session.replay).toEqual([])
    expect(last(done).turnEnd?.run).toBe('run12345')
  })

  it.each([
    ['不带', undefined, '不带'],
    ['定时任务', { chatType: 'cron' }, '只缓冲私聊、群聊与频道'],
    ['子 agent', { chatType: 'subagent' }, '只缓冲私聊、群聊与频道'],
    ['群聊没有发言人', { chatType: 'group', platform: 'bench', group: { id: 'g1' } }, '发言人'],
    ['频道没有发言人', { chatType: 'channel', platform: 'bench', group: { id: 'g1' } }, '发言人'],
    [
      '群聊没有群',
      { chatType: 'group', platform: 'bench', sender: { id: 'u' } },
      '群聊与频道要带上群',
    ],
    ['私聊没有发言人', { chatType: 'direct', platform: 'bench' }, '私聊要带上发言人'],
  ] as [string, SessionContextInput | undefined, string][])(
    '页面的上下文是%s：不发 turn.end，轨迹里说明原因，回复照样留着',
    async (_name, context, reason) => {
      const options = { loop: 'chat', turns: [reply('好')] } as HarnessOptions
      const h = harness(context ? { ...options, context } : options)
      const done = await h.send(USER_TEXT)
      expect(h.runs.flatMap((r) => events(r.steps))).not.toContain('turn.end')
      expect(last(done).turnEndNote).toContain('没有发 turn.end')
      expect(last(done).turnEndNote).toContain(reason)
      expect(last(done).turnEnd).toBeNull()
      expect(last(done).end).toBe('done')
      expect(contents(done.messages)).toEqual([USER_TEXT, '好'])
    },
  )

  it.each([
    ['私聊', { chatType: 'direct', platform: 'bench', sender: { id: 'u' } }],
    ['群聊', GROUP],
    ['频道', { ...GROUP, chatType: 'channel' }],
  ] as [string, SessionContextInput][])('上下文是%s：发 turn.end', (_name, context) => {
    const body = turnEndBody(context, '问', '答')
    expect(turnEndRefusal(context, body)).toBeNull()
  })

  it('turn.end 超长时先截，不切开代理对：超长的话整个事件被拒，这一轮就没了', async () => {
    const long = `${'字'.repeat(19_999)}😀结尾`
    const h = harness({ loop: 'chat', context: GROUP, turns: [reply(long)] })
    await h.send(long)
    const body = (h.runs[1]!.steps[0] as { body: { user: string; reply: string } }).body
    expect(body.user).toBe('字'.repeat(19_999))
    expect(body.reply).toBe('字'.repeat(19_999))
    // 模型拿到的还是全文
    expect(h.turnRequests[0]!.at(-1)!.content).toContain('😀结尾')
  })

  it('turn.end 的运行请求失败：回复留着，轨迹里说明', async () => {
    let calls = 0
    const h = harness({
      loop: 'chat',
      context: GROUP,
      turns: [reply('好')],
      run: (steps) =>
        ++calls === 2
          ? { kind: 'failed', message: '服务内部错误', retryable: true }
          : { kind: 'done', result: runResult('rollback', steps.map(defaultStep)) },
    })
    const done = await h.send(USER_TEXT)
    expect(last(done).turnEndNote).toContain('turn.end 请求失败：服务内部错误')
    expect(last(done).turnEnd).toBeNull()
    expect(contents(done.messages)).toEqual([USER_TEXT, '好'])
    expect(done.session.replay).toEqual([])
  })

  it('turn.end 本身报错：记成这一步的结果，不进重放', async () => {
    let calls = 0
    const h = harness({
      loop: 'chat',
      context: GROUP,
      turns: [reply('好')],
      run: (steps) => ({
        kind: 'done',
        result: runResult(
          'rollback',
          ++calls === 2
            ? [baseStep({ ...defaultStep(steps[0]!, 0), isError: true, replay: null })]
            : steps.map(defaultStep),
        ),
      }),
    })
    const done = await h.send(USER_TEXT)
    expect(last(done).turnEnd?.step.isError).toBe(true)
    expect(done.session.replay).toEqual([])
  })

  it('模型自己编了工具调用：不执行，作为工具错误回给它，它接着说', async () => {
    const h = harness({
      loop: 'chat',
      context: GROUP,
      turns: [reply(null, [toolCall('c1', 'kioku_get', { uri: 'core://x' })]), reply('那算了')],
    })
    const done = await h.send(USER_TEXT)
    const steps = h.runs.flatMap((r) => r.steps)
    expect(steps.some((s) => s.kind === 'tool')).toBe(false)
    expect(toolMessages(done.messages)[0]!.content).toBe('这个运行时不给工具，没有执行')
    expect((h.runs[1]!.steps[0] as { body: { reply: string } }).body.reply).toBe('那算了')
  })

  it('模型什么都没回：这条消息回到发之前，不发 turn.end，不然再发一次这一轮就进两次对话缓冲', async () => {
    const h = harness({ loop: 'chat', context: GROUP, turns: [reply(null)] })
    const done = await h.send(USER_TEXT)
    expect(h.runs.flatMap((r) => events(r.steps))).not.toContain('turn.end')
    expect(last(done).turnEnd).toBeNull()
    expect(last(done).turnEndNote).toContain('没有发 turn.end')
    expect(last(done).inHistory).toBe(false)
    expect(done.session.replay).toEqual([])
  })

  it.each(['real', 'rollback'] as const)(
    '%s：编了工具调用、被拒之后回复是空的：不发带空 reply 的 turn.end，不进对话缓冲；轨迹里说明，这条消息留在历史',
    async (mode) => {
      const h = harness({
        mode,
        loop: 'chat',
        context: GROUP,
        turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply(null)],
      })
      const done = await h.send(USER_TEXT)
      expect(h.runs.flatMap((r) => events(r.steps))).not.toContain('turn.end')
      expect(last(done).turnEnd).toBeNull()
      expect(last(done).turnEndNote).toBe('模型没有回复，没有发 turn.end。')
      expect(last(done).end).toBe('empty')
      expect(last(done).inHistory).toBe(true)
      expect(done.session.replay).toEqual([])
      expect(done.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    },
  )

  it('上下文不满足时回复是空的：说的是模型没有回复，不是上下文的问题', async () => {
    const h = harness({ loop: 'chat', turns: [reply(null)] })
    const done = await h.send(USER_TEXT)
    expect(last(done).turnEndNote).toBe('模型没有回复，没有发 turn.end。')
  })

  it('空回复之后的下一条有文字的回复：turn.end 照发', async () => {
    const first = harness({ loop: 'chat', context: GROUP, turns: [reply(null)] })
    const conversation = await first.send(USER_TEXT)
    const next = harness({ loop: 'chat', context: GROUP, turns: [reply('好')] })
    await next.send(USER_TEXT, conversation)
    expect(next.runs.flatMap((r) => events(r.steps))).toContain('turn.end')
  })
})

describe('tools 循环', () => {
  it('不发 session.start 与 prompt.submit，系统提示只有基础文字，kioku_boot 由模型自己调', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c1', 'kioku_boot')]), reply('读过了'), reply('第二句')],
    })
    const first = await h.send(USER_TEXT)
    expect(h.turnRequests[0]).toEqual([
      { role: 'system', content: '基础提示' },
      { role: 'user', content: USER_TEXT },
    ])
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]!.steps).toEqual([{ kind: 'tool', tool: 'kioku_boot', arguments: {} }])
    expect(toolMessages(first.messages)[0]!.content).toBe('kioku_boot 的结果')
    expect(last(first).lifecycle).toEqual([])
    expect(first.sessionText).toBeNull()

    const second = await h.send('第二条', first)
    expect(h.runs).toHaveLength(1)
    expect(second.messages.at(-2)).toEqual({ role: 'user', content: '第二条' })
  })

  it('基础文字也是空的：不带系统消息', async () => {
    const h = harness({ loop: 'tools', system: '  ', turns: [reply('好')] })
    await h.send(USER_TEXT)
    expect(h.turnRequests[0]).toEqual([{ role: 'user', content: USER_TEXT }])
  })
})

describe('工具调用', () => {
  it('一条消息的全部 tool_calls 放进同一次运行，按顺序执行；tool 消息按原顺序、用 toolCalls[i].id', async () => {
    const calls = [
      toolCall('call_a', 'kioku_create', { uri: 'core://a', content: '甲' }),
      toolCall('call_b', 'kioku_get', { uri: 'core://a' }),
      toolCall('call_c', 'kioku_list', { uri: 'core://' }),
    ]
    const h = harness({ loop: 'tools', turns: [reply(null, calls), reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]!.steps.map((s) => (s as { tool: string }).tool)).toEqual([
      'kioku_create',
      'kioku_get',
      'kioku_list',
    ])
    expect(h.runs[0]!.label).toContain('kioku_create、kioku_get、kioku_list')
    const tools = toolMessages(done.messages)
    expect(tools.map((m) => m.tool_call_id)).toEqual(['call_a', 'call_b', 'call_c'])
    expect(tools.map((m) => m.content)).toEqual([
      'kioku_create 的结果',
      'kioku_get 的结果',
      'kioku_list 的结果',
    ])
    expect(last(done).rounds[0]!.calls.map((c) => c.trace?.step.label)).toEqual([
      'kioku_create',
      'kioku_get',
      'kioku_list',
    ])
    expect(roundRun(last(done).rounds[0]!)).toBe('run12345')
  })

  it('助手消息原样放回历史：reasoning_content 这些字段都不丢', async () => {
    const first = reply(null, [toolCall('c1', 'kioku_list')], {
      reasoning_content: '想一想',
      vendor_field: { a: 1 },
    })
    const h = harness({ loop: 'tools', turns: [first, reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(done.messages[1]).toEqual(first.message)
    expect(h.turnRequests[1]![2]).toEqual(first.message)
    expect(last(done).rounds[0]!.reasoning).toBe('想一想')
  })

  it('arguments 解析失败的不发，直接作为工具错误回给模型；执行的和不执行的按原顺序产生 tool 消息', async () => {
    const calls = [
      toolCall('c1', 'kioku_get', { uri: 'core://a' }),
      toolCall('c2', 'kioku_create', null, '工具参数不是合法的 JSON'),
      toolCall('c3', 'kioku_list'),
      toolCall('c4', '', null, '工具调用没有名字'),
    ]
    const h = harness({ loop: 'tools', turns: [reply(null, calls), reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(h.runs[0]!.steps.map((s) => (s as { tool: string }).tool)).toEqual([
      'kioku_get',
      'kioku_list',
    ])
    const tools = toolMessages(done.messages)
    expect(tools.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(tools.map((m) => m.content)).toEqual([
      'kioku_get 的结果',
      '没有执行：工具参数不是合法的 JSON',
      'kioku_list 的结果',
      '没有执行：工具调用没有名字',
    ])
    const traced = last(done).rounds[0]!.calls
    expect(traced.map((c) => c.trace !== null)).toEqual([true, false, true, false])
    // 显示的是模型写的原文，放回历史的已经换掉了
    expect(traced[1]!.rawArguments).toBe('{坏的')
    expect(argumentsText(traced[1]!)).toBe('{坏的')
    expect(argumentsText(traced[2]!)).toBe('{}')
    expect(JSON.stringify(done.messages)).not.toContain('{坏的')
    expect(argumentsText({ ...traced[1]!, rawArguments: '' })).toBe('（没有参数）')
  })

  it('全部解析失败：不发运行请求，把错误回给模型，它可以重试', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, [toolCall('c1', 'kioku_create', null, '工具参数不是 JSON 对象')]),
        reply('修好了'),
      ],
    })
    const done = await h.send(USER_TEXT)
    expect(h.runs).toEqual([])
    expect(h.turnRequests).toHaveLength(2)
    expect(toolMessages(done.messages)[0]!.content).toBe('没有执行：工具参数不是 JSON 对象')
    expect(last(done).end).toBe('done')
  })

  it('工具名不合契约（太长）：只这一个不发，不让整个运行被拒', async () => {
    const calls = [toolCall('c1', 'x'.repeat(65)), toolCall('c2', 'kioku_list')]
    const h = harness({ loop: 'tools', turns: [reply(null, calls), reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(h.runs[0]!.steps).toHaveLength(1)
    const tools = toolMessages(done.messages)
    expect(tools[0]!.content).toContain('没有执行：工具调用不合法')
    expect(tools[1]!.content).toBe('kioku_list 的结果')
  })

  it('工具报错：原文回给模型，它接着处理；循环不停', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c1', 'kioku_get', { uri: 'core://no' })]), reply('没有这条')],
      run: () => ({
        kind: 'done',
        result: runResult('rollback', [baseStep({ isError: true, text: '记忆不存在' })]),
      }),
    })
    const done = await h.send(USER_TEXT)
    expect(toolMessages(done.messages)[0]!.content).toBe('记忆不存在')
    expect(last(done).end).toBe('done')
    expect(callOpen(last(done).rounds[0]!.calls[0]!.trace!.step)).toBe(true)
  })

  it('还在执行时轨迹上显示要调的工具，结果回来后补上', async () => {
    let seen: AgentConversation | null = null
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply('好')],
      run: (steps) => {
        seen = h.changes.at(-1)!
        return { kind: 'done', result: runResult('rollback', steps.map(defaultStep)) }
      },
    })
    await h.send(USER_TEXT)
    const during = last(seen!)
    expect(during.phase).toBe('tools')
    expect(during.rounds[0]!.calls[0]!.reply).toBeNull()
    expect(during.rounds[0]!.calls[0]!.trace).toBeNull()
  })
})

describe('一轮的工具调用放不进一次运行', () => {
  const OVER_STEPS = `没有执行：一轮最多执行 ${BENCH_MAX_STEPS} 个工具调用，这个超出了，可以下一轮再调`
  const list = (id: string) => toolCall(id, 'kioku_list')
  const create = (id: string, content: string) =>
    toolCall(id, 'kioku_create', { uri: `core://${id}`, content })
  const stepTools = (steps: readonly BenchStep[]) => steps.map((s) => (s as { tool: string }).tool)

  it('60 个调用：前 50 个放进同一次运行，后面的作为工具错误回给模型，顺序不变，循环接着走', async () => {
    const calls = Array.from({ length: 60 }, (_, i) => list(`c${i}`))
    const h = harness({ loop: 'tools', turns: [reply(null, calls), reply('调完了')] })
    const done = await h.send(USER_TEXT)
    expect(BENCH_MAX_STEPS).toBe(50)
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]!.steps).toHaveLength(50)
    expect(h.turnRequests).toHaveLength(2)
    expect(last(done).end).toBe('done')
    const tools = toolMessages(done.messages)
    expect(tools.map((m) => m.tool_call_id)).toEqual(calls.map((c) => c.id))
    expect(tools.slice(0, 50).every((m) => m.content === 'kioku_list 的结果')).toBe(true)
    expect(tools.slice(50).every((m) => m.content === OVER_STEPS)).toBe(true)
    const traced = last(done).rounds[0]!.calls
    expect(traced.slice(0, 50).every((c) => c.trace !== null)).toBe(true)
    expect(traced.slice(50).every((c) => c.trace === null && c.reply === OVER_STEPS)).toBe(true)
    expect(sentToolCalls(done)).toHaveLength(50)
  })

  it('正好 50 个：都执行', async () => {
    const calls = Array.from({ length: 50 }, (_, i) => list(`c${i}`))
    const h = harness({ loop: 'tools', turns: [reply(null, calls), reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(h.runs[0]!.steps).toHaveLength(50)
    expect(toolMessages(done.messages).every((m) => m.content === 'kioku_list 的结果')).toBe(true)
  })

  it('解析失败的不占名额：放得下的还是 50 个', async () => {
    const calls = [
      toolCall('bad', 'kioku_get', null, '工具参数不是合法的 JSON'),
      ...Array.from({ length: 51 }, (_, i) => list(`c${i}`)),
    ]
    const h = harness({ loop: 'tools', turns: [reply(null, calls), reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(h.runs[0]!.steps).toHaveLength(50)
    const tools = toolMessages(done.messages)
    expect(tools[0]!.content).toBe('没有执行：工具参数不是合法的 JSON')
    expect(tools.at(-1)!.content).toBe(OVER_STEPS)
    expect(tools.filter((m) => m.content === 'kioku_list 的结果')).toHaveLength(50)
  })

  it('单个参数把请求体撑过上限：只这一个不发，前后的照样执行，说明上限', async () => {
    const huge = 'x'.repeat(BENCH_MAX_REQUEST_BYTES)
    const calls = [list('a'), create('huge', huge), list('b')]
    const h = harness({ loop: 'tools', turns: [reply(null, calls), reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(stepTools(h.runs[0]!.steps)).toEqual(['kioku_list', 'kioku_list'])
    expect(last(done).end).toBe('done')
    const tools = toolMessages(done.messages)
    expect(tools.map((m) => m.tool_call_id)).toEqual(['a', 'huge', 'b'])
    expect(tools[0]!.content).toBe('kioku_list 的结果')
    expect(tools[1]!.content).toContain('没有执行')
    expect(tools[1]!.content).toContain('请求体上限 2.0 MB')
    expect(tools[2]!.content).toBe('kioku_list 的结果')
    expect(last(done).rounds[0]!.calls.map((c) => c.trace !== null)).toEqual([true, false, true])
  })

  it('一个都放不下：不发运行请求，错误回给模型，它可以改小再调', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [create('huge', 'x'.repeat(BENCH_MAX_REQUEST_BYTES))]), reply('好')],
    })
    const done = await h.send(USER_TEXT)
    expect(h.runs).toEqual([])
    expect(h.turnRequests).toHaveLength(2)
    expect(toolMessages(done.messages)[0]!.content).toContain('没有执行')
    expect(last(done).end).toBe('done')
  })

  it('按字节算，不按字数：中文一个字三个字节', async () => {
    const chars = Math.ceil(BENCH_MAX_REQUEST_BYTES / 3) + 1
    // 前提：按字数算放得下
    expect(chars).toBeLessThan(BENCH_MAX_REQUEST_BYTES)
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [create('huge', '字'.repeat(chars))]), reply('好')],
    })
    const done = await h.send(USER_TEXT)
    expect(h.runs).toEqual([])
    expect(toolMessages(done.messages)[0]!.content).toContain('请求体上限')
  })

  // 让请求体的字节数正好是给定的值：只有一步时
  const sizedCall = (bytes: number, replay: unknown[] = []) => {
    const empty = create('s', '')
    const base = bodyBytes({
      mode: 'rollback',
      steps: [{ kind: 'tool', tool: empty.name, arguments: empty.arguments }],
      replay,
    })
    return create('s', 'x'.repeat(bytes - base))
  }

  it('请求体正好到上限：放得下；多一个字节：放不下', async () => {
    const fits = harness({
      loop: 'tools',
      turns: [reply(null, [sizedCall(BENCH_MAX_REQUEST_BYTES)]), reply('好')],
    })
    await fits.send(USER_TEXT)
    expect(bodyBytes({ mode: 'rollback', steps: fits.runs[0]!.steps, replay: [] })).toBe(
      BENCH_MAX_REQUEST_BYTES,
    )

    const over = harness({
      loop: 'tools',
      turns: [reply(null, [sizedCall(BENCH_MAX_REQUEST_BYTES + 1)]), reply('好')],
    })
    await over.send(USER_TEXT)
    expect(over.runs).toEqual([])
  })

  it('多个步骤时算上它们之间的逗号', async () => {
    const small = list('a')
    const smallBytes = bodyBytes({ kind: 'tool', tool: small.name, arguments: small.arguments })
    const exact = sizedCall(BENCH_MAX_REQUEST_BYTES - smallBytes - 1)
    const fits = harness({ loop: 'tools', turns: [reply(null, [exact, small]), reply('好')] })
    await fits.send(USER_TEXT)
    expect(fits.runs[0]!.steps).toHaveLength(2)

    const longer = sizedCall(BENCH_MAX_REQUEST_BYTES - smallBytes)
    const over = harness({ loop: 'tools', turns: [reply(null, [longer, small]), reply('好')] })
    await over.send(USER_TEXT)
    expect(over.runs[0]!.steps).toHaveLength(1)
  })

  it('请求体算上重放：单独放得下的，带上重放就放不下', async () => {
    const seed = harness({
      loop: 'tools',
      turns: [reply(null, [create('seed', 'x'.repeat(100_000))]), reply('好')],
    })
    const conversation = await seed.send(USER_TEXT)
    expect(conversation.session.replay).toHaveLength(1)
    // 不带重放时正好放得下
    const call = sizedCall(BENCH_MAX_REQUEST_BYTES)
    const h = harness({ loop: 'tools', turns: [reply(null, [call]), reply('好')] })
    const done = await h.send('第二条', conversation)
    expect(h.runs).toEqual([])
    expect(toolMessages(done.messages).at(-1)!.content).toContain('请求体上限')
  })

  it('真实模式没有重放，一样按上限放', async () => {
    const calls = Array.from({ length: 51 }, (_, i) => list(`c${i}`))
    const h = harness({ mode: 'real', loop: 'tools', turns: [reply(null, calls), reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(h.runs[0]!.steps).toHaveLength(50)
    expect(toolMessages(done.messages).at(-1)!.content).toBe(OVER_STEPS)
  })

  it('运行请求失败时，放不下的还说自己的原因', async () => {
    const calls = Array.from({ length: 51 }, (_, i) => list(`c${i}`))
    const h = harness({
      loop: 'tools',
      turns: [reply(null, calls)],
      run: () => ({ kind: 'failed', message: '服务内部错误', retryable: true }),
    })
    const done = await h.send(USER_TEXT)
    const tools = toolMessages(done.messages)
    expect(tools[0]!.content).toContain('工具请求失败')
    expect(tools.at(-1)!.content).toBe(OVER_STEPS)
  })
})

describe('一轮里有调用没有执行之后，后面的写操作不接着做', () => {
  const NOT_CONTINUED = '没有执行：这一轮前面有调用没有执行，这个写操作不接着做，看清前面的结果再调'
  const BROKEN = '没有执行：工具参数不是合法的 JSON'
  const broken = toolCall('new', 'kioku_create', null, '工具参数不是合法的 JSON')
  const remove = toolCall('del', 'kioku_delete', { uri: 'core://old' })
  const get = toolCall('get', 'kioku_get', { uri: 'core://old' })
  const list = toolCall('list', 'kioku_list')
  const sentTools = (h: ReturnType<typeof harness>) =>
    h.runs.flatMap((r) => r.steps.map((s) => (s as { tool: string }).tool))

  it.each(['real', 'rollback'] as const)(
    '%s：新建的参数坏了，删除也不发：旧的不能没了新的又没写；模型看得到两个都没有执行',
    async (mode) => {
      const h = harness({
        mode,
        loop: 'tools',
        turns: [reply(null, [broken, remove]), reply('好')],
      })
      const done = await h.send(USER_TEXT)
      expect(h.runs).toEqual([])
      expect(toolMessages(done.messages).map((m) => [m.tool_call_id, m.content])).toEqual([
        ['new', BROKEN],
        ['del', NOT_CONTINUED],
      ])
      expect(h.turnRequests).toHaveLength(2)
      expect(last(done).end).toBe('done')
      expect(done.mayHaveWritten).toBe(false)
      expect(done.session.replay).toEqual([])
      expect(last(done).rounds[0]!.calls.map((c) => c.reply)).toEqual([BROKEN, NOT_CONTINUED])
      expect(sentToolCalls(done)).toEqual([])
    },
  )

  it.each(['real', 'rollback'] as const)('%s：新建太大被拒，删除一样不发', async (mode) => {
    const huge = toolCall('new', 'kioku_create', {
      uri: 'core://new',
      content: 'x'.repeat(BENCH_MAX_REQUEST_BYTES),
    })
    const h = harness({ mode, loop: 'tools', turns: [reply(null, [huge, remove]), reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(h.runs).toEqual([])
    const [first, second] = toolMessages(done.messages).map((m) => m.content as string)
    expect(first).toContain('请求体上限')
    expect(second).toBe(NOT_CONTINUED)
  })

  it('超过一轮的步数：第 51 个被拒，再后面的写操作说的是不接着做', async () => {
    const lists = Array.from({ length: 51 }, (_, i) => toolCall(`c${i}`, 'kioku_list'))
    const h = harness({
      mode: 'real',
      loop: 'tools',
      turns: [reply(null, [...lists, remove]), reply('好')],
    })
    const done = await h.send(USER_TEXT)
    expect(sentTools(h)).toEqual(Array.from({ length: 50 }, () => 'kioku_list'))
    const tools = toolMessages(done.messages)
    expect(tools.at(-2)!.content).toContain('一轮最多执行 50 个')
    expect(tools.at(-1)!.content).toBe(NOT_CONTINUED)
  })

  it('读操作照常执行，顺序不变；tool 消息按原来的顺序', async () => {
    const h = harness({
      mode: 'real',
      loop: 'tools',
      turns: [reply(null, [broken, get, remove, list]), reply('好')],
    })
    const done = await h.send(USER_TEXT)
    expect(sentTools(h)).toEqual(['kioku_get', 'kioku_list'])
    expect(toolMessages(done.messages).map((m) => [m.tool_call_id, m.content])).toEqual([
      ['new', BROKEN],
      ['get', 'kioku_get 的结果'],
      ['del', NOT_CONTINUED],
      ['list', 'kioku_list 的结果'],
    ])
    expect(done.mayHaveWritten).toBe(false)
  })

  it('被拒的调用前面的写操作照做：模型写的顺序里它没有依赖后面的', async () => {
    const create = toolCall('w', 'kioku_create', { uri: 'core://a', content: '甲' })
    const h = harness({
      mode: 'real',
      loop: 'tools',
      turns: [reply(null, [create, broken, remove]), reply('好')],
    })
    const done = await h.send(USER_TEXT)
    expect(sentTools(h)).toEqual(['kioku_create'])
    expect(toolMessages(done.messages).map((m) => m.content)).toEqual([
      'kioku_create 的结果',
      BROKEN,
      NOT_CONTINUED,
    ])
    expect(done.mayHaveWritten).toBe(true)
  })

  it.each([
    ['kioku_create', { uri: 'core://a', content: '甲' }],
    ['kioku_update', { uri: 'core://a', content: '乙' }],
    ['kioku_delete', { uri: 'core://a' }],
    ['kioku_move', { from: 'core://a', to: 'core://b' }],
    ['kioku_credential_save', { identifier: 'x' }],
    ['kioku_credential_delete', { identifier: 'x' }],
    // 取值记访问事件，契约算写
    ['kioku_credential', { identifier: 'x' }],
    // 不认识的工具按写算
    ['some_other_tool', {}],
  ] as [string, Record<string, unknown>][])('%s 算写操作：不接着做', async (name, args) => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [broken, toolCall('w', name, args)]), reply('好')],
    })
    const done = await h.send(USER_TEXT)
    expect(h.runs).toEqual([])
    expect(toolMessages(done.messages)[1]!.content).toBe(NOT_CONTINUED)
  })

  it.each([
    ['kioku_boot', {}],
    ['kioku_search', { query: '茶' }],
    ['kioku_get', { uri: 'core://a' }],
    ['kioku_list', {}],
    // 不带 identifier 只是列出，契约不算写
    ['kioku_credential', {}],
  ] as [string, Record<string, unknown>][])('%s 算读操作：照常执行', async (name, args) => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [broken, toolCall('r', name, args)]), reply('好')],
    })
    await h.send(USER_TEXT)
    expect(sentTools(h)).toEqual([name])
  })

  it('名字不合法被拒也一样：后面的写操作不接着做', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('long', 'x'.repeat(65)), remove]), reply('好')],
    })
    const done = await h.send(USER_TEXT)
    expect(h.runs).toEqual([])
    expect(toolMessages(done.messages)[1]!.content).toBe(NOT_CONTINUED)
  })

  it('没有调用被拒：写操作都发，顺序不变', async () => {
    const create = toolCall('w', 'kioku_create', { uri: 'core://a', content: '甲' })
    const h = harness({
      mode: 'real',
      loop: 'tools',
      turns: [reply(null, [create, remove]), reply('好')],
    })
    await h.send(USER_TEXT)
    expect(sentTools(h)).toEqual(['kioku_create', 'kioku_delete'])
  })

  it('只管同一轮：上一轮有调用被拒，这一轮的写操作照常', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [broken]), reply(null, [remove]), reply('好')],
    })
    await h.send(USER_TEXT)
    expect(sentTools(h)).toEqual(['kioku_delete'])
  })
})

describe('toolReply：回给模型的文字不能是空的', () => {
  it('正常结果用步骤的 text', () => {
    expect(toolReply(baseStep({ text: '正文' }))).toBe('正文')
  })

  it('工具报错用原文；没有原文时说明', () => {
    expect(toolReply(baseStep({ isError: true, text: '记忆不存在' }))).toBe('记忆不存在')
    expect(toolReply(baseStep({ isError: true, text: '' }))).toBe('工具报错了，没有说明')
  })

  it('没带断言时工具报错也是 passed：看 isError，不看 status', () => {
    const step = baseStep({ status: 'passed', isError: true, text: '' })
    expect(toolReply(step)).toBe('工具报错了，没有说明')
  })

  it('成功但没有文字：也不是空的', () => {
    expect(toolReply(baseStep({ text: '' }))).toBe('（工具没有返回内容）')
  })

  it('内部错误：说是内部错误，带上具体原因；不把这一步的文字当结果', () => {
    const step = baseStep({
      isError: true,
      internalError: true,
      internalDetail: 'lock_timeout',
      text: '不该用',
    })
    expect(toolReply(step)).toContain('服务内部错误')
    expect(toolReply(step)).toContain('等锁超时')
    expect(toolReply(step)).not.toContain('不该用')
    expect(toolReply(baseStep({ internalError: true }))).toContain('服务内部错误')
  })

  it('没有执行与跳过：说明原因', () => {
    const notRun = baseStep({ status: 'notRun', raw: null, reason: '根事务出错，这一步没有执行' })
    expect(toolReply(notRun)).toBe('没有执行：根事务出错，这一步没有执行')
    const skipped = baseStep({ status: 'skipped', raw: null, reason: '这把 Key 写不了 private 层' })
    expect(toolReply(skipped)).toBe('没有执行：这把 Key 写不了 private 层')
    expect(toolReply(baseStep({ status: 'failed', raw: null, text: '' }))).toBe('没有执行')
  })
})

describe('8 轮上限', () => {
  const always = () =>
    Array.from({ length: AGENT_MAX_ROUNDS }, (_, i) =>
      reply(null, [toolCall(`c${i}`, 'kioku_list'), toolCall(`d${i}`, 'kioku_boot')]),
    )

  it('最多请求 8 次模型，第 8 次要的工具不执行：结果没有下一次请求能告诉模型了', async () => {
    const h = harness({ loop: 'tools', turns: always() })
    const done = await h.send(USER_TEXT)
    expect(AGENT_MAX_ROUNDS).toBe(8)
    expect(h.turnRequests).toHaveLength(8)
    expect(h.runs).toHaveLength(7)
    expect(last(done).end).toBe('limit')
    expect(last(done).notice).toContain('8 轮上限')
    expect(noticeColor(last(done).end)).toBe('warning')
    const tools = toolMessages(done.messages)
    expect(tools.slice(-2).map((m) => m.tool_call_id)).toEqual(['c7', 'd7'])
    expect(tools.slice(-2).map((m) => m.content)).toEqual([
      '到了 8 轮上限，没有执行',
      '到了 8 轮上限，没有执行',
    ])
    // 第 7 轮的结果还是真的
    expect(tools.at(-3)!.content).toBe('kioku_boot 的结果')
    expect(last(done).rounds).toHaveLength(8)
    expect(last(done).rounds[7]!.calls.every((c) => c.trace === null)).toBe(true)
  })

  it('到了上限之后还能接着说下一句，轮数重新算', async () => {
    const h = harness({ loop: 'tools', turns: [...always(), reply('继续好了')] })
    const conversation = await h.send(USER_TEXT)
    const next = await h.send('继续', conversation)
    expect(last(next).end).toBe('done')
    expect(h.turnRequests).toHaveLength(9)
    expect(h.turnRequests[8]!.at(-1)).toEqual({ role: 'user', content: '继续' })
  })

  it('全部解析失败的轮也算一轮：模型不能靠写坏参数一直请求下去', async () => {
    const broken = Array.from({ length: AGENT_MAX_ROUNDS }, (_, i) =>
      reply(null, [toolCall(`c${i}`, 'kioku_get', null, '工具参数不是合法的 JSON')]),
    )
    const h = harness({ loop: 'tools', turns: broken })
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests).toHaveLength(8)
    expect(last(done).end).toBe('limit')
  })
})

describe('停止', () => {
  it('等第一次回复时停止：请求被取消，什么都没做，这条消息不进历史，下一句接得上', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        (signal) => {
          setTimeout(() => h.controller.abort())
          return hangUntilAborted(signal)
        },
      ],
    })
    const done = await h.send(USER_TEXT)
    expect(last(done).end).toBe('stopped')
    expect(last(done).inHistory).toBe(false)
    expect(last(done).notice).toContain('可以再发一次')
    expect(noticeColor(last(done).end)).toBe('neutral')
    expect(done.messages).toEqual([])

    const next = harness({ loop: 'tools', turns: [reply('好')] })
    const again = await next.send('换一句', done)
    expect(next.turnRequests[0]!.filter((m) => m.role === 'user')).toEqual([
      { role: 'user', content: '换一句' },
    ])
    expect(again.exchanges).toHaveLength(2)
  })

  it('工具执行时停止：等它回来，结果记下，不再请求模型', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c1', 'kioku_create', { uri: 'core://a', content: '甲' })])],
      run: (steps) => {
        h.controller.abort()
        return { kind: 'done', result: runResult('rollback', steps.map(defaultStep)) }
      },
    })
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests).toHaveLength(1)
    expect(last(done).end).toBe('stopped')
    expect(toolMessages(done.messages)[0]!.content).toBe('kioku_create 的结果')
    // 已经做了的写入还在重放日志里：模型也知道
    expect(done.session.replay).toHaveLength(1)
    expect(last(done).inHistory).toBe(true)
    expect(last(done).notice).toContain('留在历史')
  })

  it('模型的回复和停止撞在一起：要调的工具都不执行，补上 tool 消息', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        () => {
          h.controller.abort()
          return reply('要调工具', [toolCall('c1', 'kioku_list'), toolCall('c2', 'kioku_boot')])
        },
      ],
    })
    const done = await h.send(USER_TEXT)
    expect(h.runs).toEqual([])
    expect(toolMessages(done.messages).map((m) => [m.tool_call_id, m.content])).toEqual([
      ['c1', '已停止，没有执行'],
      ['c2', '已停止，没有执行'],
    ])
    expect(last(done).end).toBe('stopped')
    expect(last(done).rounds[0]!.text).toBe('要调工具')
    expect(last(done).rounds[0]!.calls.map((c) => c.reply)).toEqual([
      '已停止，没有执行',
      '已停止，没有执行',
    ])
  })

  it('第二轮等回复时停止：第一轮的留着，不用再补', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, [toolCall('c1', 'kioku_list')]),
        (signal) => {
          setTimeout(() => h.controller.abort())
          return hangUntilAborted(signal)
        },
      ],
    })
    const done = await h.send(USER_TEXT)
    expect(done.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(last(done).end).toBe('stopped')
    expect(last(done).inHistory).toBe(true)
  })

  it('生命周期事件进行时停止：不请求模型', async () => {
    const h = harness({
      turns: [reply('不该到这里')],
      run: (steps) => {
        h.controller.abort()
        return { kind: 'done', result: runResult('rollback', steps.map(defaultStep)) }
      },
    })
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests).toEqual([])
    expect(last(done).end).toBe('stopped')
    expect(done.messages).toEqual([])
    // 结果照样显示
    expect(last(done).lifecycle).toHaveLength(2)
  })

  it('还没开始就停止：连模型也不请求', async () => {
    const h = harness({ loop: 'tools', turns: [reply('不该到这里')] })
    h.controller.abort()
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests).toEqual([])
    expect(last(done).end).toBe('stopped')
  })

  it('chat：回复回来之后才停止，不再发 turn.end，轨迹里说明', async () => {
    const h = harness({
      loop: 'chat',
      context: GROUP,
      turns: [
        () => {
          h.controller.abort()
          return reply('好')
        },
      ],
    })
    const done = await h.send(USER_TEXT)
    expect(h.runs.flatMap((r) => events(r.steps))).not.toContain('turn.end')
    expect(last(done).turnEndNote).toContain('已停止，没有发 turn.end')
    expect(last(done).end).toBe('done')
    expect(contents(done.messages)).toEqual([USER_TEXT, '好'])
  })
})

describe('工具的运行请求失败', () => {
  const failing = (message = '服务内部错误。可能已经执行了一部分，到活动里确认') => ({
    loop: 'tools' as const,
    turns: [
      reply(null, [
        toolCall('c1', 'kioku_create', { uri: 'core://a', content: '甲' }),
        toolCall('c2', 'kioku_get', null, '工具参数不是合法的 JSON'),
        toolCall('c3', 'kioku_list'),
      ]),
    ],
    run: (): RunOutcome => ({ kind: 'failed', message, retryable: true }),
  })

  it('循环结束，每个 tool_call 都补一条 tool 消息，历史合法，不再请求模型', async () => {
    const h = harness(failing())
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests).toHaveLength(1)
    expect(last(done).end).toBe('toolFailed')
    expect(noticeColor(last(done).end)).toBe('error')
    expect(last(done).notice).toContain('工具请求失败')
    expect(last(done).notice).toContain('可能已经执行了一部分')
    expect(toolMessages(done.messages).map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3'])
    const [first, second, third] = toolMessages(done.messages).map((m) => m.content as string)
    expect(first).toContain('工具请求失败，没有拿到结果')
    // 没发出去的照旧说它自己的原因
    expect(second).toBe('没有执行：工具参数不是合法的 JSON')
    expect(third).toContain('工具请求失败，没有拿到结果')
    expect(last(done).inHistory).toBe(true)
    expect(sentToolCalls(done)).toEqual([])
  })

  it('用户还能接着说下一句：模型看得到上一轮失败了', async () => {
    const h = harness(failing())
    const conversation = await h.send(USER_TEXT)
    const next = harness({ loop: 'tools', turns: [reply('再试试')] })
    const done = await next.send('重试', conversation)
    expect(next.turnRequests[0]!.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
      'tool',
      'user',
    ])
    expect(last(done).end).toBe('done')
  })
})

describe('请求模型失败', () => {
  it('第一轮就失败：回到这条消息之前，错误显示出来，不留半截', async () => {
    const h = harness({ turns: [new ApiError(502, '模型接口返回 HTTP 500：上游的错误原文')] })
    const done = await h.send(USER_TEXT)
    expect(done.messages).toEqual([])
    expect(last(done).end).toBe('modelFailed')
    expect(last(done).inHistory).toBe(false)
    expect(last(done).notice).toContain('上游的错误原文')
    expect(last(done).notice).toContain('可以再发一次')
    expect(noticeColor(last(done).end)).toBe('error')
    // 启动上下文拿到了，下一条不用再发
    expect(done.sessionText).toBe(SESSION_TEXT)

    const next = harness({ turns: [reply('好')] })
    const again = await next.send(USER_TEXT, done)
    expect(events(next.runs[0]!.steps)).toEqual(['prompt.submit'])
    expect(next.turnRequests[0]!.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(again.messages).toHaveLength(2)
  })

  it('之前的消息不受影响', async () => {
    const h = harness({ loop: 'tools', turns: [reply('第一句'), new ApiError(502, '上游挂了')] })
    const first = await h.send('第一条')
    const second = await h.send('第二条', first)
    expect(second.messages).toEqual(first.messages)
    expect(contents(second.messages)).toEqual(['第一条', '第一句'])
  })

  it('工具调用之后才失败：做过的都留着，这时每个 tool_call 都有结果；真实模式下工具已经写了，模型要知道', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, [toolCall('c1', 'kioku_create', { uri: 'core://a', content: '甲' })]),
        new ApiError(502, '上游挂了'),
      ],
    })
    const done = await h.send(USER_TEXT)
    expect(done.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(last(done).end).toBe('modelFailed')
    expect(last(done).inHistory).toBe(true)
    expect(last(done).notice).toContain('上游挂了')
    expect(last(done).notice).toContain('留在历史')
    expect(done.session.replay).toHaveLength(1)

    const next = harness({ loop: 'tools', turns: [reply('接着来')] })
    await next.send('继续', done)
    expect(next.turnRequests[0]!.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ])
    expect(next.runs).toEqual([])
  })

  describe('4xx 是确定性的：只显示服务端的文字，不说可以再发', () => {
    const TOO_LONG = 'messages：对话太长，清空之后再试'

    it.each([
      [400, TOO_LONG, TOO_LONG],
      [400, 'model：模型名太长，最多 128 个字符', 'model：模型名太长，最多 128 个字符'],
      [400, '还没有配模型', '还没有配模型'],
      [403, '只有实例管理员能用模型代理', '只有实例管理员能用模型代理'],
      [404, '没有这把 Key', '没有这把 Key'],
      [413, '对话太长，清空之后再试', '对话太长，清空之后再试'],
      // 反向代理拦下的：没有服务端的那句话，也要提示清空
      [413, '请求失败：HTTP 413', '对话太长，清空之后再试'],
    ])('HTTP %i「%s」：一轮都没回复时', async (status, message, notice) => {
      const h = harness({ turns: [new ApiError(status, message)] })
      const done = await h.send(USER_TEXT)
      expect(last(done).end).toBe('modelFailed')
      expect(last(done).notice).toBe(notice)
      // 文字还是放回输入框：清空之后还要用
      expect(last(done).inHistory).toBe(false)
    })

    it('调过工具之后才 4xx：做过的留着，同样只有服务端的文字', async () => {
      const h = harness({
        loop: 'tools',
        turns: [reply(null, [toolCall('c1', 'kioku_list')]), new ApiError(400, TOO_LONG)],
      })
      const done = await h.send(USER_TEXT)
      expect(last(done).notice).toBe(TOO_LONG)
      expect(last(done).inHistory).toBe(true)
      expect(done.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    })
  })

  it.each([
    ['500', new ApiError(500, '服务内部错误'), '服务内部错误。可以再发一次。'],
    ['502', new ApiError(502, '上游挂了'), '上游挂了。可以再发一次。'],
    [
      '网络错误',
      new TypeError('Failed to fetch'),
      `请求模型失败：${NOT_API_FAILURE}。可以再发一次。`,
    ],
  ] as [string, Error, string][])('%s 可能是暂时的：可以再发一次', async (_name, err, notice) => {
    const h = harness({ loop: 'tools', turns: [err] })
    expect(last(await h.send(USER_TEXT)).notice).toBe(notice)
  })

  it('错误的说明：502 显示上游原文，504 提示反向代理的读超时要大于 120 秒', () => {
    expect(turnFailureMessage(new ApiError(502, '模型接口返回 HTTP 500：原文'))).toBe(
      '模型接口返回 HTTP 500：原文',
    )
    const gateway = turnFailureMessage(new ApiError(504, '请求失败：HTTP 504'))
    expect(gateway).toContain('反向代理')
    expect(gateway).toContain('120 秒')
    expect(turnFailureMessage(new ApiError(400, '还没有配模型'))).toBe('还没有配模型')
    expect(turnFailureMessage(new TypeError('Failed to fetch'))).toContain('网络出错了')
    // 响应对不上契约（ZodError）也不把英文报错给用户
    expect(turnFailureMessage(new Error('Invalid input'))).not.toContain('Invalid')
  })

  it('说明的文字接得上：原文带句号时不多一个', async () => {
    const h = harness({ loop: 'tools', turns: [new ApiError(504, '请求失败：HTTP 504')] })
    const done = await h.send(USER_TEXT)
    expect(last(done).notice).not.toContain('。。')
    const plain = harness({ loop: 'tools', turns: [new ApiError(502, '上游挂了')] })
    expect(last(await plain.send(USER_TEXT)).notice).toContain('上游挂了。可以再发一次')
  })
})

describe('回滚模式的重放', () => {
  const create = (uri: string) => toolCall(`c-${uri}`, 'kioku_create', { uri, content: '正文' })

  it('第二轮带第一轮的写步骤；读步骤不进，失败的不进', async () => {
    const calls = [
      create('core://ok'),
      toolCall('c-read', 'kioku_get', { uri: 'core://ok' }),
      create('core://failed'),
      toolCall('c-internal', 'kioku_update', { uri: 'core://x', content: '乙' }),
    ]
    const h = harness({
      loop: 'tools',
      turns: [reply(null, calls), reply(null, [toolCall('c9', 'kioku_list')]), reply('好')],
      run: (steps) => ({
        kind: 'done',
        result: runResult(
          'rollback',
          steps.map((step, index) => {
            const base = defaultStep(step, index)
            // 服务端对报错的步骤不给 replay；这里故意给上，确认界面也不收
            if (index === 2) return { ...base, isError: true, text: '已存在' }
            if (index === 3) return { ...base, internalError: true, isError: true }
            return base
          }),
        ),
      }),
    })
    const done = await h.send(USER_TEXT)
    expect(h.runs[0]!.replay).toEqual([])
    expect(h.runs[1]!.replay).toEqual([
      { kind: 'tool', tool: 'kioku_create', arguments: { uri: 'core://ok', content: '正文' } },
    ])
    expect(done.session.replay).toHaveLength(1)
    expect(last(done).rounds[0]!.calls.map((c) => c.trace?.kept)).toEqual([
      true,
      false,
      false,
      false,
    ])
  })

  it('重放里存服务端返回的展开之后的参数，不是发出去的', async () => {
    const expanded = {
      kind: 'tool',
      tool: 'kioku_create',
      arguments: { uri: 'core://abcd1234', content: '正文' },
    } as BenchReplayStep
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, [toolCall('c1', 'kioku_create', { uri: 'core://${run}', content: '正文' })]),
        reply(null, [toolCall('c2', 'kioku_list')]),
        reply('好'),
      ],
      run: (steps) => ({
        kind: 'done',
        result: runResult(
          'rollback',
          steps.map((step, index) => ({
            ...defaultStep(step, index),
            replay: (step as { tool: string }).tool === 'kioku_create' ? expanded : null,
          })),
        ),
      }),
    })
    await h.send(USER_TEXT)
    expect(h.runs[1]!.replay).toEqual([expanded])
  })

  it('下一条用户消息也带着：prompt.submit 的召回读得到之前的写入', async () => {
    const h = harness({
      turns: [reply(null, [create('core://a')]), reply('好'), reply('第二句')],
    })
    const first = await h.send(USER_TEXT)
    await h.send('第二条', first)
    expect(h.runs[0]!.replay).toEqual([])
    expect(h.runs[1]!.replay).toEqual([])
    expect(h.runs[2]!.replay).toEqual(first.session.replay)
    expect(first.session.replay).toHaveLength(1)
  })

  it('真实模式不重放：运行接口的契约也不接受', async () => {
    const h = harness({
      mode: 'real',
      loop: 'tools',
      turns: [
        reply(null, [create('core://a')]),
        reply(null, [toolCall('c2', 'kioku_list')]),
        reply('好'),
      ],
    })
    const done = await h.send(USER_TEXT)
    expect(h.runs.map((r) => r.replay)).toEqual([[], []])
    expect(done.session.replay).toEqual([])
    expect(last(done).rounds[0]!.calls[0]!.trace?.kept).toBe(false)
    expect(roundRun(last(done).rounds[0]!)).toBe('run12345')
  })

  it('这个重放日志属于这次对话：传进来的对话没带调用台的写入，也不写到别处', async () => {
    const h = harness({ loop: 'tools', turns: [reply(null, [create('core://a')]), reply('好')] })
    const start = emptyConversation()
    const done = await h.send(USER_TEXT, start)
    expect(start.session.replay).toEqual([])
    expect(done.session.replay).toHaveLength(1)
    expect(emptyConversation().session.replay).toEqual([])
  })

  it('放不下时：这一步的结果照样回给模型，之后的工具不再执行，要清空才能接着来', async () => {
    const big = 'x'.repeat(BENCH_MAX_REPLAY_BYTES)
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, [toolCall('c1', 'kioku_create', { uri: 'core://a', content: big })]),
        reply(null, [toolCall('c2', 'kioku_list')]),
      ],
    })
    const done = await h.send(USER_TEXT)
    expect(done.session.overflow).toBe(true)
    expect(done.session.replay).toEqual([])
    expect(h.runs).toHaveLength(1)
    expect(last(done).end).toBe('blocked')
    expect(last(done).notice).toContain('放不进重放日志')
    expect(toolMessages(done.messages).at(-1)!.content).toBe('写入放不进重放日志了，没有执行')

    // 下一条消息一开始就拦下，不花模型的 token
    const next = harness({ loop: 'tools', turns: [reply('不该到这里')] })
    const blocked = await next.send('第二条', done)
    expect(next.turnRequests).toEqual([])
    expect(last(blocked).end).toBe('blocked')
    expect(last(blocked).inHistory).toBe(false)
  })
})

describe('重放分叉', () => {
  const diverged =
    (internalError = false) =>
    (steps: BenchStep[]): RunOutcome => ({
      kind: 'done',
      result: {
        ...runResult(
          'rollback',
          steps.map((step, index) => ({
            ...defaultStep(step, index),
            status: 'notRun' as const,
            raw: null,
            replay: null,
            reason: '重放的第 1 步报错，这一步没有执行',
          })),
        ),
        ok: false,
        replayDiverged: { index: 0, text: 'URI 已存在', internalError },
      },
    })

  // 有一步写入在重放日志里的对话
  const withWrite = async (loop: BenchAgentLoop = 'tools') => {
    const h = harness({
      loop,
      turns: [
        reply(null, [toolCall('c1', 'kioku_create', { uri: 'core://a', content: '甲' })]),
        reply('好'),
      ],
    })
    return h.send(USER_TEXT)
  }

  it('工具那一轮分叉：按工具失败处理，每个 tool_call 补一条，告诉用户可以清空，不再请求模型', async () => {
    const conversation = await withWrite()
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c2', 'kioku_list')]), reply('不该到这里')],
      run: diverged(),
    })
    const done = await h.send('第二条', conversation)
    expect(h.turnRequests).toHaveLength(1)
    expect(last(done).end).toBe('diverged')
    expect(last(done).notice).toContain('第 1 步（kioku_create core://a）')
    expect(last(done).notice).toContain('URI 已存在')
    expect(last(done).notice).toContain('清空对话')
    expect(noticeColor(last(done).end)).toBe('error')
    expect(toolMessages(done.messages).at(-1)!.tool_call_id).toBe('c2')
    expect(toolMessages(done.messages).at(-1)!.content).toContain('没有执行')
    expect(last(done).rounds[0]!.calls[0]!.trace).toBeNull()
    expect(sentToolCalls(done)).toHaveLength(1)
    // 日志原样留着：清空之前再发还是同样的结果
    expect(done.session.replay).toHaveLength(1)
  })

  // 工具那一轮分叉之后的对话
  const afterDivergence = async (internalError = false) => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c2', 'kioku_list')])],
      run: diverged(internalError),
    })
    return h.send('第二条', await withWrite())
  }

  it('内部错误的分叉多半是暂时的：不拦，这一轮的消息留在历史，说接着说下一句，不说再发一次：重打一遍模型看到的是重复的请求', async () => {
    const conversation = await afterDivergence(true)
    expect(last(conversation).inHistory).toBe(true)
    expect(last(conversation).notice).toContain('可能是暂时的')
    expect(last(conversation).notice).toContain('可以接着说下一句')
    expect(last(conversation).notice).not.toContain('可以再发一次')
    expect(blockingDivergence(conversation.session)).toBeNull()

    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c3', 'kioku_list')]), reply('好')],
    })
    const done = await h.send('再试一次', conversation)
    expect(h.turnRequests).toHaveLength(2)
    expect(last(done).end).toBe('done')
    // 这次重放过去了，分叉就清掉了
    expect(done.session.diverged).toBeNull()
    expect(h.runs[0]!.replay).toEqual(conversation.session.replay)
  })

  it('分叉之后再发（数据对不上）：不请求模型、不运行，白花的 token 省下，这条消息不进历史', async () => {
    const conversation = await afterDivergence()
    expect(blockingDivergence(conversation.session)).toEqual(conversation.session.diverged)
    const h = harness({ loop: 'tools', turns: [reply('不该到这里')] })
    const done = await h.send('第三条', conversation)
    expect(h.turnRequests).toEqual([])
    expect(h.runs).toEqual([])
    expect(last(done).end).toBe('diverged')
    expect(last(done).inHistory).toBe(false)
    expect(last(done).notice).toContain('第 1 步（kioku_create core://a）')
    expect(done.messages).toEqual(conversation.messages)
  })

  describe('接受分叉', () => {
    it('只去掉报错的那一步，别的留着；分叉清掉之后能接着发，重放不再带它', async () => {
      const write = (id: string, uri: string) =>
        toolCall(id, 'kioku_create', { uri, content: '甲' })
      const first = harness({
        loop: 'tools',
        turns: [reply(null, [write('c1', 'core://a'), write('c2', 'core://b')]), reply('好')],
      })
      const conversation = await first.send(USER_TEXT)
      expect(conversation.session.replay).toHaveLength(2)

      const failing = harness({
        loop: 'tools',
        turns: [reply(null, [toolCall('c3', 'kioku_list')])],
        run: (steps) => ({
          kind: 'done',
          result: {
            ...(diverged()(steps) as { result: BenchRunResult }).result,
            replayDiverged: { index: 1, text: 'URI 已存在', internalError: false },
          },
        }),
      })
      const stuck = await failing.send('第二条', conversation)
      expect(blockingDivergence(stuck.session)).not.toBeNull()

      const accepted = acceptAgentDivergence(stuck)
      expect(accepted.session.diverged).toBeNull()
      expect(blockingDivergence(accepted.session)).toBeNull()
      expect(accepted.session.replay).toEqual([
        {
          kind: 'tool',
          tool: 'kioku_create',
          arguments: { uri: 'core://a', content: '甲' },
        },
      ])
      // 历史不动：模型看到的还是原来的
      expect(accepted.messages).toEqual(stuck.messages)

      const next = harness({
        loop: 'tools',
        turns: [reply(null, [toolCall('c4', 'kioku_list')]), reply('好')],
      })
      const done = await next.send('第三条', accepted)
      expect(next.runs[0]!.replay).toEqual(accepted.session.replay)
      expect(last(done).end).toBe('done')
    })

    it('轨迹跟着改：去掉的那一步不再标已保留，别的不动，也不改旧的状态', async () => {
      const write = (id: string, uri: string) =>
        toolCall(id, 'kioku_create', { uri, content: '甲' })
      const first = harness({
        loop: 'tools',
        turns: [reply(null, [write('c1', 'core://a'), write('c2', 'core://b')]), reply('好')],
      })
      const conversation = await first.send(USER_TEXT)
      const failing = harness({
        loop: 'tools',
        turns: [reply(null, [toolCall('c3', 'kioku_list')])],
        run: diverged(),
      })
      const stuck = await failing.send('第二条', conversation)
      const accepted = acceptAgentDivergence(stuck)
      const flags = (state: AgentConversation) =>
        state.exchanges[0]!.rounds[0]!.calls.map((c) => [c.trace?.kept, c.trace?.removed])
      expect(flags(stuck)).toEqual([
        [true, false],
        [true, false],
      ])
      expect(flags(accepted)).toEqual([
        [false, true],
        [true, false],
      ])
    })

    it('存成场景不带去掉的那一步：用户不要了；都去掉了就存不成', async () => {
      const write = (id: string, uri: string) =>
        toolCall(id, 'kioku_create', { uri, content: '甲' })
      const first = harness({
        loop: 'tools',
        turns: [reply(null, [write('c1', 'core://a'), write('c2', 'core://b')]), reply('好')],
      })
      const conversation = await first.send(USER_TEXT)
      const failing = harness({
        loop: 'tools',
        turns: [reply(null, [toolCall('c3', 'kioku_list')])],
        run: diverged(),
      })
      const stuck = await failing.send('第二条', conversation)
      expect(sentToolCalls(stuck).map((c) => c.id)).toEqual(['c1', 'c2'])

      const accepted = acceptAgentDivergence(stuck)
      expect(sentToolCalls(accepted).map((c) => c.id)).toEqual(['c2'])
      const made = agentScenario(accepted, new Date('2026-10-31T01:02:03Z'))!
      if (!made.parsed.ok) throw new Error(made.parsed.errors.join())
      expect(made.parsed.scenario.steps).toEqual([
        { kind: 'tool', tool: 'kioku_create', arguments: { uri: 'core://b', content: '甲' } },
      ])

      const only = harness({
        loop: 'tools',
        turns: [reply(null, [write('c1', 'core://a')]), reply('好')],
      })
      const single = await only.send(USER_TEXT)
      const stuckAgain = await harness({
        loop: 'tools',
        turns: [reply(null, [toolCall('c3', 'kioku_list')])],
        run: diverged(),
      }).send('第二条', single)
      expect(agentScenario(acceptAgentDivergence(stuckAgain), new Date())).toBeNull()
    })

    it('turn.end 也可能是去掉的那一步：轨迹同样改', async () => {
      const h = harness({ loop: 'chat', context: GROUP, turns: [reply('好')] })
      const conversation = await h.send(USER_TEXT)
      expect(last(conversation).turnEnd?.kept).toBe(true)
      const stuck: AgentConversation = {
        ...conversation,
        session: {
          ...conversation.session,
          diverged: { index: 0, text: '不一样了', internalError: false },
        },
      }
      const accepted = acceptAgentDivergence(stuck)
      expect(last(accepted).turnEnd).toMatchObject({ kept: false, removed: true })
      expect(accepted.session.replay).toEqual([])
    })

    it('没有分叉：什么都不动', () => {
      const conversation = emptyConversation()
      expect(acceptAgentDivergence(conversation)).toBe(conversation)
    })
  })

  it('prompt.submit 那里的内部错误分叉：这条消息不进历史、文字放回输入框，说可以再发一次', async () => {
    const conversation = await withWrite('hook')
    const h = harness({ turns: [reply('不该到这里')], run: diverged(true) })
    const done = await h.send('第二条', conversation)
    expect(last(done).inHistory).toBe(false)
    expect(last(done).notice).toContain('可以再发一次')
    expect(last(done).notice).not.toContain('接着说下一句')
  })

  it('turn.end 时的内部错误分叉：回复已经留在历史，说接着说下一句', async () => {
    let calls = 0
    const h = harness({
      loop: 'chat',
      context: GROUP,
      turns: [reply('好')],
      run: (steps) =>
        ++calls === 2
          ? diverged(true)(steps)
          : { kind: 'done', result: runResult('rollback', steps.map(defaultStep)) },
    })
    const done = await h.send(USER_TEXT)
    expect(last(done).inHistory).toBe(true)
    expect(last(done).turnEndNote).toContain('可以接着说下一句')
    expect(last(done).turnEndNote).not.toContain('可以再发一次')
  })

  it('数据对不上的分叉：不说接着来，要清空或接受', async () => {
    const conversation = await afterDivergence()
    expect(last(conversation).notice).not.toContain('可以再发一次')
    expect(last(conversation).notice).not.toContain('接着说下一句')
    expect(last(conversation).notice).toContain('可以清空对话，或者接受')
  })

  it('prompt.submit 那里就分叉：不请求模型，这条消息不进历史', async () => {
    const conversation = await withWrite('hook')
    const h = harness({ turns: [reply('不该到这里')], run: diverged() })
    const done = await h.send('第二条', conversation)
    expect(h.turnRequests).toEqual([])
    expect(last(done).end).toBe('diverged')
    expect(last(done).inHistory).toBe(false)
    expect(done.messages).toEqual(conversation.messages)
    expect(last(done).attached).toBe('')
    // 轨迹上看得到这些步骤没有执行
    expect(last(done).lifecycle.map((t) => t.step.status)).toEqual(['notRun'])
  })

  it('turn.end 时才分叉：回复留着，轨迹里说明', async () => {
    let calls = 0
    const h = harness({
      loop: 'chat',
      context: GROUP,
      turns: [reply('好')],
      run: (steps) =>
        ++calls === 2
          ? diverged()(steps)
          : { kind: 'done', result: runResult('rollback', steps.map(defaultStep)) },
    })
    const done = await h.send(USER_TEXT)
    expect(last(done).turnEndNote).toContain('重放这次对话的写入时')
    expect(last(done).turnEnd).toBeNull()
    expect(contents(done.messages)).toEqual([USER_TEXT, '好'])
  })
})

describe('中途作废（换了应用、Key 或模式）', () => {
  it('工具那一轮作废：不再发任何请求，历史照样合法', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply('不该到这里')],
      run: () => ({ kind: 'stale' }),
    })
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests).toHaveLength(1)
    expect(last(done).end).toBe('abandoned')
    expect(last(done).notice).toBeNull()
  })

  it('生命周期事件作废：不请求模型', async () => {
    const h = harness({ turns: [reply('不该到这里')], run: () => ({ kind: 'stale' }) })
    const done = await h.send(USER_TEXT)
    expect(h.turnRequests).toEqual([])
    expect(last(done).end).toBe('abandoned')
    expect(done.messages).toEqual([])
  })

  it('turn.end 作废：回复已经有了，这一轮结束', async () => {
    let calls = 0
    const h = harness({
      loop: 'chat',
      context: GROUP,
      turns: [reply('好')],
      run: (steps) =>
        ++calls === 2
          ? { kind: 'stale' }
          : { kind: 'done', result: runResult('rollback', steps.map(defaultStep)) },
    })
    const done = await h.send(USER_TEXT)
    expect(last(done).end).toBe('abandoned')
  })
})

describe('消息内容的形状', () => {
  it('content：null、空串、分段数组都取得到文字', () => {
    expect(contentText(null)).toBe('')
    expect(contentText(undefined)).toBe('')
    expect(contentText('')).toBe('')
    expect(contentText('纯文字')).toBe('纯文字')
    expect(
      contentText([
        { type: 'text', text: '第一段' },
        { type: 'image_url', image_url: { url: 'x' } },
        { type: 'text', text: '第二段' },
        '第三段',
        null,
        { type: 'text', text: 42 },
      ]),
    ).toBe('第一段第二段第三段')
    expect(contentText({ text: '不是数组' })).toBe('')
    expect(contentText(42)).toBe('')
  })

  it.each([
    ['分段数组', [{ type: 'text', text: '段' }], '段'],
    ['字符串', '话', '话'],
  ])('轨迹上的文字：%s', async (_name, content, text) => {
    const h = harness({ loop: 'tools', turns: [reply(content)] })
    const done = await h.send(USER_TEXT)
    expect(last(done).rounds[0]!.text).toBe(text)
    // 放回历史的还是原样
    expect(done.messages.at(-1)!.content).toEqual(content)
  })

  it('chat：分段数组的回复，turn.end 里是取出来的文字', async () => {
    const h = harness({
      loop: 'chat',
      context: GROUP,
      turns: [reply([{ type: 'text', text: '段' }])],
    })
    await h.send(USER_TEXT)
    expect((h.runs[1]!.steps[0] as { body: { reply: string } }).body.reply).toBe('段')
  })

  it('reasoning_content：有的话单独留着，不是字符串或空的不算', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        reply('答', [], { reasoning_content: '想一想' }),
        reply('答', [], { reasoning_content: '' }),
        reply('答', [], { reasoning_content: { a: 1 } }),
      ],
    })
    const first = await h.send('一')
    const second = await h.send('二', first)
    const third = await h.send('三', second)
    expect(third.exchanges.map((e) => e.rounds[0]!.reasoning)).toEqual(['想一想', null, null])
  })
})

describe('模型没有文字也没有工具调用', () => {
  // 推理模型把额度都用在思考上：content 是 null，结束原因 length，用量是花了的
  const reasoningOnly = (over: Partial<BenchAgentTurnResult> = {}): BenchAgentTurnResult => ({
    ...reply(null, [], { reasoning_content: '想了很久' }),
    finishReason: 'length',
    ...over,
  })

  it.each([
    ['content 是 null', null],
    ['空串', ''],
    ['只有空白', ' \n'],
    ['空的分段数组', []],
    ['分段里没有文字', [{ type: 'image_url', image_url: { url: 'x' } }]],
    ['分段的文字是空白', [{ type: 'text', text: '  ' }]],
    ['缺 content', undefined],
  ])('%s：不进历史，回到这条消息之前，下一句接得上', async (_name, content) => {
    const h = harness({ loop: 'tools', turns: [reply(content)] })
    const done = await h.send(USER_TEXT)
    expect(done.messages).toEqual([])
    expect(last(done).end).toBe('empty')
    expect(last(done).inHistory).toBe(false)
    expect(last(done).rounds[0]!.text).toBe('')

    const next = harness({ loop: 'tools', turns: [reply('好')] })
    const again = await next.send(USER_TEXT, done)
    expect(next.turnRequests[0]).toEqual([
      { role: 'system', content: '基础提示' },
      { role: 'user', content: USER_TEXT },
    ])
    expect(contents(again.messages)).toEqual([USER_TEXT, '好'])
  })

  it('轨迹里看得到模型没有返回文字与结束原因，思考过程与用量都留着，可以再发一次', async () => {
    const h = harness({ loop: 'tools', turns: [reasoningOnly()] })
    const done = await h.send(USER_TEXT)
    const notice = last(done).notice!
    expect(notice).toContain('模型没有返回文字')
    expect(notice).toContain('结束原因 length')
    expect(notice).toContain('思考')
    expect(notice).toContain('可以再发一次')
    expect(noticeColor(last(done).end)).toBe('warning')
    const round = last(done).rounds[0]!
    expect(round.reasoning).toBe('想了很久')
    expect(round.finishReason).toBe('length')
    expect(roundMeta(round)).toContain('结束原因 length')
    expect(done.usage.rounds).toBe(1)
    expect(done.usage.completionTokens).toBe(20)
  })

  it.each([
    ['stop', '结束原因 stop'],
    ['content_filter', '结束原因 content_filter'],
    [null, '上游没有给结束原因'],
  ])('结束原因是 %s：说出来', async (finishReason, text) => {
    const h = harness({ loop: 'tools', turns: [reasoningOnly({ finishReason })] })
    expect(last(await h.send(USER_TEXT)).notice).toContain(text)
  })

  it('已经调过工具：做过的留着，历史以 tool 消息结束，下一句照常合法；空的那条不在历史里', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, [toolCall('c1', 'kioku_create', { uri: 'core://a', content: '甲' })]),
        reasoningOnly(),
      ],
    })
    const done = await h.send(USER_TEXT)
    expect(done.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(last(done).end).toBe('empty')
    expect(last(done).inHistory).toBe(true)
    expect(last(done).notice).toContain('结束原因 length')
    expect(last(done).notice).toContain('留在历史')
    expect(last(done).rounds).toHaveLength(2)
    expect(done.session.replay).toHaveLength(1)

    const next = harness({ loop: 'tools', turns: [reply('接着来')] })
    const again = await next.send('继续', done)
    expect(next.turnRequests[0]!.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ])
    expect(last(again).end).toBe('done')
  })

  it('带工具调用的助手消息没有文字是正常的：照旧进历史', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply('好')],
    })
    const done = await h.send(USER_TEXT)
    expect(done.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(last(done).end).toBe('done')
  })

  it('hook：prompt.submit 已经发过，这条消息同样回到发之前；启动上下文留着，下一条不用再发', async () => {
    const h = harness({ turns: [reasoningOnly()] })
    const done = await h.send(USER_TEXT)
    expect(done.messages).toEqual([])
    expect(done.sessionText).toBe(SESSION_TEXT)
    const next = harness({ turns: [reply('好')] })
    await next.send(USER_TEXT, done)
    expect(events(next.runs[0]!.steps)).toEqual(['prompt.submit'])
  })
})

describe('用量', () => {
  it('累计 prompt、completion token 与耗时，跨轮跨消息', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply('好'), reply('第二句')],
    })
    const first = await h.send(USER_TEXT)
    expect(first.usage).toEqual({ promptTokens: 200, completionTokens: 40, ms: 1000, rounds: 2 })
    const second = await h.send('第二条', first)
    expect(second.usage).toEqual({ promptTokens: 300, completionTokens: 60, ms: 1500, rounds: 3 })
    expect(usageSummary(second.usage)).toContain('300')
    expect(usageSummary(second.usage)).toContain('60')
    expect(usageSummary(second.usage)).toContain('1.5')
    expect(usageSummary(second.usage)).toContain('不计入抽取预算')
  })

  it('一轮的显示：模型、用量、耗时；上游没给用量时不说成用了 0 个；被截断时说出来', () => {
    const round = {
      text: '',
      reasoning: null,
      finishReason: 'stop',
      model: MODEL,
      usage: { promptTokens: 100, completionTokens: 20 },
      ms: 1500,
      calls: [],
    }
    expect(roundMeta(round)).toBe(`${MODEL} · 输入 100、输出 20 token · 1.5 秒`)
    expect(roundMeta({ ...round, usage: { promptTokens: 0, completionTokens: 0 } })).toContain(
      '上游没有给用量',
    )
    expect(roundMeta({ ...round, finishReason: 'length' })).toContain('结束原因 length')
    expect(roundMeta({ ...round, finishReason: 'tool_calls' })).not.toContain('结束原因')
    expect(roundMeta({ ...round, finishReason: null })).not.toContain('结束原因')
  })
})

describe('状态的更新', () => {
  it('每走一步给一份新的状态，看得到走到哪里，不改旧的', async () => {
    const h = harness({ turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply('好')] })
    const start = emptyConversation()
    const done = await h.send(USER_TEXT, start)
    expect(start.exchanges).toEqual([])
    expect(start.messages).toEqual([])
    const phases = h.changes.map((c) => c.exchanges.at(-1)!.phase).filter(Boolean)
    expect(phases).toEqual(expect.arrayContaining(['lifecycle', 'model', 'tools']))
    expect(h.changes[0]!.exchanges[0]!.user).toBe(USER_TEXT)
    // 旧的一份里没有后来的轮
    expect(h.changes[0]!.exchanges[0]!.rounds).toEqual([])
    expect(done.exchanges[0]!.phase).toBeNull()
    expect(new Set(h.changes).size).toBe(h.changes.length)
  })

  it('history 之外的状态不丢：同意过的留着，序号递增', async () => {
    const h = harness({ loop: 'tools', turns: [reply('好'), reply('好')] })
    const consented = { endpoint: HOST, model: MODEL, loop: 'tools' as const }
    const start = { ...emptyConversation(), consented }
    const first = await h.send(USER_TEXT, start)
    const second = await h.send(USER_TEXT, first)
    expect(second.consented).toEqual(consented)
    expect(second.exchanges.map((e) => e.id)).toEqual([1, 2])
  })
})

describe('开始之前的提示', () => {
  const target = (over: Partial<AgentConsent> = {}): AgentConsent => ({
    endpoint: HOST,
    model: 'm',
    loop: 'hook',
    ...over,
  })
  const text = (loop: BenchAgentLoop, mode: BenchMode = 'rollback') =>
    consentText(target({ loop }), mode)

  it('没同意过要问；三样都一样不再问', () => {
    expect(consentNeeded(emptyConversation(), target())).toBe(true)
    const agreed = { ...emptyConversation(), consented: target() }
    expect(consentNeeded(agreed, target())).toBe(false)
    // 新的一段对话要重新问
    expect(consentNeeded(emptyConversation(), target())).toBe(true)
  })

  it.each([
    ['接口换了：内容发给另一家', { endpoint: 'other.example.com' }],
    ['接口没有了', { endpoint: null }],
    ['模型名换了', { model: 'n' }],
    ['循环换了：从只发工具结果变成也发启动上下文', { loop: 'tools' }],
    ['循环换了：有工具变成没工具', { loop: 'chat' }],
  ] as [string, Partial<AgentConsent>][])('%s：再问', (_name, over) => {
    const agreed = { ...emptyConversation(), consented: target() }
    expect(consentNeeded(agreed, target(over))).toBe(true)
  })

  it('反过来也一样：从同意过的循环换到只发工具结果也再问', () => {
    const agreed = { ...emptyConversation(), consented: target({ loop: 'tools' }) }
    expect(consentNeeded(agreed, target({ loop: 'hook' }))).toBe(true)
  })

  it('说清楚发给哪台主机的哪个模型', () => {
    const shown = consentText(
      target({ endpoint: 'model.example.com:8443', model: 'deep-x' }),
      'rollback',
    )
    expect(shown).toContain('主机 model.example.com:8443 上的模型「deep-x」')
    // 服务端没有给主机名时不写半句
    const none = consentText(target({ endpoint: null, model: 'deep-x' }), 'rollback')
    expect(none).toContain('模型「deep-x」')
    expect(none).not.toContain('主机')
  })

  it('说清楚发什么内容：按循环', () => {
    expect(text('hook')).toContain('启动上下文、召回块与工具结果')
    expect(text('approximate')).toContain('启动上下文、召回块与工具结果')
    expect(text('chat')).toContain('启动上下文与召回块')
    expect(text('chat')).not.toContain('工具结果')
    expect(text('tools')).toContain('工具结果')
    expect(text('tools')).not.toContain('启动上下文')
  })

  it('打码：回滚模式都打码；真实模式下外部凭据源照常返回，要说', () => {
    expect(text('hook')).toContain('打码')
    expect(text('hook')).not.toContain('外部凭据源')
    expect(text('hook', 'real')).toContain('外部凭据源')
    expect(text('tools', 'real')).toContain('外部凭据源')
    // 不给工具，取不到凭据
    expect(text('chat', 'real')).not.toContain('外部凭据源')
  })
})

describe('系统提示', () => {
  it('基础文字加 session.start 的结果；只有一边时只用一边；都空时不带', () => {
    expect(systemMessage('基础', '启动')).toEqual({ role: 'system', content: '基础\n\n启动' })
    expect(systemMessage(' 基础 ', null)).toEqual({ role: 'system', content: '基础' })
    expect(systemMessage('', '启动')).toEqual({ role: 'system', content: '启动' })
    expect(systemMessage('   ', null)).toBeNull()
    expect(systemMessage('', '')).toBeNull()
  })

  it('有默认文字', () => {
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(0)
  })
})

describe('截断', () => {
  it('不超长时原样', () => {
    expect(clipText('abc', 3)).toBe('abc')
  })

  it('超长时截到上限，不切开代理对', () => {
    expect(clipText('abcd', 3)).toBe('abc')
    expect(clipText('ab😀', 3)).toBe('ab')
    expect(clipText('a😀b', 3)).toBe('a😀')
  })

  it('prompt.submit 的 prompt 超长时先截：模型拿到的还是全文', async () => {
    const long = '字'.repeat(20_001)
    const h = harness({ turns: [reply('好')] })
    await h.send(long)
    const body = (h.runs[0]!.steps[1] as { body: { prompt: string } }).body
    expect(body.prompt).toHaveLength(20_000)
    expect(h.turnRequests[0]!.at(-1)!.content).toContain(long)
  })
})

describe('存成场景', () => {
  const NOW = new Date('2026-10-31T01:02:03.456Z')

  it('步骤用发出去的参数，按顺序；没有执行的不算；按契约校验', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, [
          toolCall('c1', 'kioku_create', { uri: 'core://${run}', content: '甲' }),
          toolCall('c2', 'kioku_get', null, '工具参数不是合法的 JSON'),
        ]),
        reply(null, [toolCall('c3', 'kioku_get', { uri: 'core://a' })]),
        reply('好'),
      ],
    })
    const done = await h.send(USER_TEXT)
    const made = agentScenario(done, NOW)!
    expect(made.dropped).toBe(0)
    if (!made.parsed.ok) throw new Error(made.parsed.errors.join())
    expect(BenchScenario.safeParse(made.parsed.scenario).success).toBe(true)
    expect(made.parsed.scenario.id).toBe('agent-20261031010203')
    expect(made.parsed.scenario.steps).toEqual([
      { kind: 'tool', tool: 'kioku_create', arguments: { uri: 'core://${run}', content: '甲' } },
      { kind: 'tool', tool: 'kioku_get', arguments: { uri: 'core://a' } },
    ])
  })

  it('生命周期事件不算，只有工具调用：没有工具调用时存不成', async () => {
    const h = harness({ turns: [reply('好')] })
    const done = await h.send(USER_TEXT)
    expect(sentToolCalls(done)).toEqual([])
    expect(agentScenario(done, NOW)).toBeNull()
    expect(agentScenario(emptyConversation(), NOW)).toBeNull()
  })

  it('停止、到上限、请求失败时没有发出去的不算', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        () => {
          h.controller.abort()
          return reply(null, [toolCall('c1', 'kioku_list')])
        },
      ],
    })
    expect(sentToolCalls(await h.send(USER_TEXT))).toEqual([])
  })

  it('服务端没有执行的步骤不算：根事务出错之后的 notRun、被跳过的', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, [
          toolCall('c1', 'kioku_create', { uri: 'core://a', content: '甲' }),
          toolCall('c2', 'kioku_get', { uri: 'core://a' }),
          toolCall('c3', 'kioku_list'),
          toolCall('c4', 'kioku_boot'),
        ]),
        reply('好'),
      ],
      run: (steps) => ({
        kind: 'done',
        result: runResult('rollback', [
          defaultStep(steps[0]!, 0),
          // 内部错误是执行过的：场景里留着，重跑时才看得到
          baseStep({ ...defaultStep(steps[1]!, 1), internalError: true, isError: true }),
          baseStep({
            ...defaultStep(steps[2]!, 2),
            status: 'notRun',
            raw: null,
            reason: '根事务出错',
          }),
          baseStep({
            ...defaultStep(steps[3]!, 3),
            status: 'skipped',
            raw: null,
            reason: '不满足',
          }),
        ]),
      }),
    })
    const done = await h.send(USER_TEXT)
    expect(sentToolCalls(done).map((c) => c.name)).toEqual(['kioku_create', 'kioku_get'])
    const made = agentScenario(done, NOW)!
    if (!made.parsed.ok) throw new Error(made.parsed.errors.join())
    expect(made.parsed.scenario.steps.map((s) => (s as { tool: string }).tool)).toEqual([
      'kioku_create',
      'kioku_get',
    ])
    // 轨迹上还看得到它们，只是不进场景
    expect(last(done).rounds[0]!.calls.every((c) => c.trace !== null)).toBe(true)
  })

  it('都没有执行：存不成', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply('好')],
      run: (steps) => ({
        kind: 'done',
        result: runResult('rollback', [
          baseStep({ ...defaultStep(steps[0]!, 0), status: 'notRun', raw: null }),
        ]),
      }),
    })
    const done = await h.send(USER_TEXT)
    expect(sentToolCalls(done)).toEqual([])
    expect(agentScenario(done, NOW)).toBeNull()
  })

  it('少了几个的说明：有才说', () => {
    expect(droppedNote(0)).toBeNull()
    expect(droppedNote(2)).toContain(`场景最多 ${BENCH_MAX_STEPS} 步`)
    expect(droppedNote(2)).toContain('后面 2 个没有存')
  })

  it('跨消息的都算；超过场景的步数上限时留前面的，说明少了几个', async () => {
    const many = Array.from({ length: BENCH_MAX_STEPS }, (_, i) =>
      toolCall(`c${i}`, 'kioku_get', { uri: `core://n${i}` }),
    )
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, many),
        reply('好'),
        reply(null, [toolCall('d1', 'kioku_list'), toolCall('d2', 'kioku_boot')]),
        reply('好'),
      ],
    })
    const first = await h.send('一')
    const second = await h.send('二', first)
    const made = agentScenario(second, NOW)!
    expect(made.dropped).toBe(2)
    if (!made.parsed.ok) throw new Error(made.parsed.errors.join())
    expect(made.parsed.scenario.steps).toHaveLength(BENCH_MAX_STEPS)
    expect(made.parsed.scenario.steps[0]).toMatchObject({ arguments: { uri: 'core://n0' } })
  })

  it('导出前检测明文：secret 级的正文、凭据的值', async () => {
    const h = harness({
      loop: 'tools',
      turns: [
        reply(null, [
          toolCall('c1', 'kioku_create', {
            uri: 'core://s',
            content: '机密',
            sensitivity: 'secret',
          }),
          toolCall('c2', 'kioku_credential_save', {
            identifier: 'x',
            values: { password: 'hunter2' },
          }),
          toolCall('c3', 'kioku_create', { uri: 'core://plain', content: '普通' }),
        ]),
        reply('好'),
      ],
    })
    const made = agentScenario(await h.send(USER_TEXT), NOW)!
    if (!made.parsed.ok) throw new Error(made.parsed.errors.join())
    const findings = plaintextIn(made.parsed.scenario)
    expect(findings.map((f) => f.step)).toEqual([1, 2])
    expect(findings[0]!.what).toContain('secret')
    expect(findings[1]!.what).toContain('password')
  })

  it('没有明文时没有提示', async () => {
    const h = harness({
      loop: 'tools',
      turns: [reply(null, [toolCall('c1', 'kioku_list')]), reply('好')],
    })
    const made = agentScenario(await h.send(USER_TEXT), NOW)!
    if (!made.parsed.ok) throw new Error(made.parsed.errors.join())
    expect(plaintextIn(made.parsed.scenario)).toEqual([])
  })
})

describe('真实模式下可能写过库', () => {
  const readCall = toolCall('r', 'kioku_get', { uri: 'core://a' })
  const writeCall = toolCall('w', 'kioku_create', { uri: 'core://a', content: '甲' })

  it('一开始没有', () => {
    expect(emptyConversation().mayHaveWritten).toBe(false)
  })

  it('写工具：算，留到下一条消息', async () => {
    const h = harness({
      mode: 'real',
      loop: 'tools',
      turns: [reply(null, [writeCall]), reply('好'), reply('好')],
    })
    const first = await h.send(USER_TEXT)
    expect(first.mayHaveWritten).toBe(true)
    expect((await h.send('第二条', first)).mayHaveWritten).toBe(true)
  })

  it('只读工具、不带上下文的生命周期事件：不算', async () => {
    const h = harness({ mode: 'real', turns: [reply(null, [readCall]), reply('好')] })
    expect((await h.send(USER_TEXT)).mayHaveWritten).toBe(false)
  })

  it('带聊天上下文的生命周期事件：第一次见到的账号会新建对象，算', async () => {
    const h = harness({ mode: 'real', context: GROUP, turns: [reply('好')] })
    expect((await h.send(USER_TEXT)).mayHaveWritten).toBe(true)
  })

  it('turn.end：算', async () => {
    const h = harness({ mode: 'real', loop: 'chat', context: GROUP, turns: [reply('好')] })
    expect((await h.send(USER_TEXT)).mayHaveWritten).toBe(true)
  })

  it.each([
    [
      '请求失败',
      { kind: 'failed', message: '服务内部错误。可能已经执行了一部分', retryable: true },
    ],
    ['中途作废', { kind: 'stale' }],
  ] as [string, RunOutcome][])('%s：发出去了就算，可能已经写了一部分', async (_name, outcome) => {
    const h = harness({
      mode: 'real',
      loop: 'tools',
      turns: [reply(null, [writeCall])],
      run: () => outcome,
    })
    expect((await h.send(USER_TEXT)).mayHaveWritten).toBe(true)
  })

  it('没有发出去的不算：解析失败、停止', async () => {
    const parsed = harness({
      mode: 'real',
      loop: 'tools',
      turns: [
        reply(null, [toolCall('w', 'kioku_create', null, '工具参数不是合法的 JSON')]),
        reply('好'),
      ],
    })
    expect((await parsed.send(USER_TEXT)).mayHaveWritten).toBe(false)
    const stopped = harness({ mode: 'real', loop: 'tools', turns: [reply('不该到这里')] })
    stopped.controller.abort()
    expect((await stopped.send(USER_TEXT)).mayHaveWritten).toBe(false)
  })

  it('回滚模式：什么都不算，写了也都回滚', async () => {
    const h = harness({ context: GROUP, turns: [reply(null, [writeCall]), reply('好')] })
    expect((await h.send(USER_TEXT)).mayHaveWritten).toBe(false)
  })
})

describe('校验函数本身', () => {
  const assistant = (...ids: string[]): BenchAgentMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => ({ id })),
  })
  const tool = (id: string, content = '有内容'): BenchAgentMessage => ({
    role: 'tool',
    tool_call_id: id,
    content,
  })

  it.each([
    ['少一条', [assistant('a', 'b'), tool('a')]],
    ['顺序不对', [assistant('a', 'b'), tool('b'), tool('a')]],
    ['中间插了用户消息', [assistant('a'), { role: 'user', content: 'x' }, tool('a')]],
    ['落单的 tool 消息', [tool('a')]],
    ['多一条', [assistant('a'), tool('a'), tool('b')]],
    ['内容是空的', [assistant('a'), tool('a', '')]],
    ['助手消息没有工具调用，content 是 null', [{ role: 'assistant', content: null }]],
    ['助手消息没有工具调用，文字是空串', [{ role: 'assistant', content: '' }]],
    ['助手消息没有工具调用，文字是空白', [{ role: 'assistant', content: ' \n' }]],
    ['助手消息没有工具调用，分段里没有文字', [{ role: 'assistant', content: [] }]],
  ] as [string, BenchAgentMessage[]][])('%s：不合法', (_name, messages) => {
    expect(historyProblem(messages)).not.toBeNull()
  })

  it('跟齐了：合法', () => {
    expect(
      historyProblem([
        { role: 'user', content: 'x' },
        assistant('a', 'b'),
        tool('a'),
        tool('b'),
        { role: 'user', content: 'y' },
        { role: 'assistant', content: '好' },
      ]),
    ).toBeNull()
  })
})
