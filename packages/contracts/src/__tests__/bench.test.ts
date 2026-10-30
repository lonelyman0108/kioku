import { describe, expect, it } from 'vitest'

import {
  BENCH_MAX_REPLAY_BYTES,
  BENCH_MAX_STEPS,
  BenchRunRequest,
  BenchScenario,
  BenchStep,
  isReplayStep,
  mayWrite,
  type BenchReplayStep,
} from '../index'

const step = (input: unknown) => BenchStep.parse(input)
const tool = (name: string, args: Record<string, unknown> = {}) =>
  step({ kind: 'tool', tool: name, arguments: args })
const lifecycle = (body: unknown) => step({ kind: 'lifecycle', body })
const recall = (body: unknown) => step({ kind: 'recall', body })
const group = {
  chatType: 'group',
  platform: 'bench',
  group: { id: 'g' },
  sender: { id: 'u' },
}
const turnEnd = {
  event: 'turn.end',
  sessionId: 's',
  context: group,
  user: '你好',
  reply: '你好呀',
}

describe('步骤的契约', () => {
  it('工具步骤没有 context：带了就拒绝，从类型上杜绝工具带会话上下文', () => {
    const parsed = BenchStep.safeParse({ kind: 'tool', tool: 'kioku_get', context: group })
    expect(parsed.success).toBe(false)
    expect(BenchStep.safeParse({ kind: 'tool', tool: 'kioku_get' }).success).toBe(true)
  })

  it('生命周期事件与 /recall 的请求体这里不校验：不合法的也能进运行，按步骤报错', () => {
    expect(BenchStep.safeParse({ kind: 'lifecycle', body: { event: 'nope' } }).success).toBe(true)
    expect(BenchStep.safeParse({ kind: 'recall', body: 'not an object' }).success).toBe(true)
  })

  it('capture 的变量名不能叫 run，断言没有正则这种写法', () => {
    expect(BenchStep.safeParse({ kind: 'whoami', capture: { run: '版本: ' } }).success).toBe(false)
    expect(BenchStep.safeParse({ kind: 'whoami', capture: { version: '版本: ' } }).success).toBe(
      true,
    )
    expect(BenchStep.safeParse({ kind: 'whoami', expect: { matches: '(a+)+$' } }).success).toBe(
      false,
    )
  })
})

describe('运行请求', () => {
  const steps = [{ kind: 'whoami' }]

  it('默认回滚，重放默认为空', () => {
    const parsed = BenchRunRequest.parse({ steps })
    expect(parsed.mode).toBe('rollback')
    expect(parsed.replay).toEqual([])
  })

  it('步骤数有上限，至少一步', () => {
    expect(BenchRunRequest.safeParse({ steps: [] }).success).toBe(false)
    const many = Array.from({ length: BENCH_MAX_STEPS + 1 }, () => ({ kind: 'whoami' }))
    expect(BenchRunRequest.safeParse({ steps: many }).success).toBe(false)
  })

  it('真实模式没有重放', () => {
    const replay = [{ kind: 'tool', tool: 'kioku_delete', arguments: { uri: 'a://b' } }]
    expect(BenchRunRequest.safeParse({ mode: 'real', steps, replay }).success).toBe(false)
    expect(BenchRunRequest.safeParse({ mode: 'rollback', steps, replay }).success).toBe(true)
  })

  it('重放只收写步骤，有字节上限', () => {
    const replayOf = (entry: unknown) => BenchRunRequest.safeParse({ steps, replay: [entry] })
    expect(replayOf({ kind: 'tool', tool: 'kioku_get', arguments: {} }).success).toBe(false)
    expect(replayOf({ kind: 'lifecycle', body: { event: 'session.start' } }).success).toBe(false)
    expect(replayOf({ kind: 'lifecycle', body: turnEnd }).success).toBe(true)
    const big = { uri: 'a://b', content: '字'.repeat(BENCH_MAX_REPLAY_BYTES / 3) }
    expect(replayOf({ kind: 'tool', tool: 'kioku_create', arguments: big }).success).toBe(false)
  })
})

describe('场景', () => {
  it('校验 id 与步骤', () => {
    const scenario = { id: 'demo', title: '示例', steps: [{ kind: 'whoami' }] }
    expect(BenchScenario.safeParse(scenario).success).toBe(true)
    expect(BenchScenario.safeParse({ ...scenario, id: 'Not Valid' }).success).toBe(false)
    expect(BenchScenario.safeParse({ ...scenario, steps: [] }).success).toBe(false)
  })
})

describe('isReplayStep：只有写工具与 turn.end', () => {
  it.each([
    'kioku_create',
    'kioku_update',
    'kioku_delete',
    'kioku_move',
    'kioku_credential_save',
    'kioku_credential_delete',
  ])('%s 要记', (name) => {
    expect(isReplayStep(tool(name))).toBe(true)
  })

  it.each(['kioku_boot', 'kioku_get', 'kioku_list', 'kioku_search', 'kioku_credential', 'nope'])(
    '%s 不记',
    (name) => {
      expect(isReplayStep(tool(name))).toBe(false)
    },
  )

  it('生命周期事件里只有 turn.end；带上下文的读不重放', () => {
    expect(isReplayStep(lifecycle(turnEnd))).toBe(true)
    expect(isReplayStep(lifecycle({ event: 'prompt.submit', context: group }))).toBe(false)
    expect(isReplayStep(lifecycle({ event: 'session.start' }))).toBe(false)
    expect(isReplayStep(recall({ query: 'x', context: group }))).toBe(false)
    expect(isReplayStep(step({ kind: 'boot' }))).toBe(false)
    expect(isReplayStep(step({ kind: 'whoami' }))).toBe(false)
  })

  it('重放日志里的步骤也认得', () => {
    const entry: BenchReplayStep = { kind: 'tool', tool: 'kioku_move', arguments: {} }
    expect(isReplayStep(entry)).toBe(true)
  })
})

describe('mayWrite：命令行要不要 --allow-writes', () => {
  it('写工具与 turn.end 都算', () => {
    expect(mayWrite(tool('kioku_create'))).toBe(true)
    expect(mayWrite(tool('kioku_credential_delete'))).toBe(true)
    expect(mayWrite(lifecycle(turnEnd))).toBe(true)
  })

  it('只读工具不算，kioku_get 可能记访问事件也不算', () => {
    for (const name of ['kioku_boot', 'kioku_get', 'kioku_list', 'kioku_search']) {
      expect(mayWrite(tool(name))).toBe(false)
    }
  })

  it('kioku_credential 取值算（记访问事件），只列表不算', () => {
    expect(mayWrite(tool('kioku_credential', { identifier: 'nas' }))).toBe(true)
    expect(mayWrite(tool('kioku_credential'))).toBe(false)
  })

  it('不认识的工具按写算', () => {
    expect(mayWrite(tool('kioku_new_tool'))).toBe(true)
  })

  it.each(['direct', 'group', 'channel'])(
    '带 %s 上下文的生命周期事件与 /recall 算：第一次见到的账号会新建对象',
    (chatType) => {
      const context = { chatType, platform: 'bench', sender: { id: 'u' }, group: { id: 'g' } }
      expect(mayWrite(lifecycle({ event: 'prompt.submit', prompt: 'x', context }))).toBe(true)
      expect(mayWrite(lifecycle({ event: 'session.start', context }))).toBe(true)
      expect(mayWrite(recall({ query: 'x', context }))).toBe(true)
    },
  )

  it.each(['cron', 'subagent'])('%s 上下文不带账号，不算', (chatType) => {
    const context = { chatType }
    expect(mayWrite(lifecycle({ event: 'prompt.submit', prompt: 'x', context }))).toBe(false)
    expect(mayWrite(recall({ query: 'x', context }))).toBe(false)
  })

  it('不带上下文的读不算，不合法的请求体也不会抛错', () => {
    expect(mayWrite(lifecycle({ event: 'session.start' }))).toBe(false)
    expect(mayWrite(recall({ query: 'x' }))).toBe(false)
    expect(mayWrite(step({ kind: 'boot' }))).toBe(false)
    expect(mayWrite(step({ kind: 'whoami' }))).toBe(false)
    for (const body of [null, 'text', 3, { context: null }, { context: 'group' }]) {
      expect(mayWrite(lifecycle(body))).toBe(false)
      expect(mayWrite(recall(body))).toBe(false)
    }
  })
})
