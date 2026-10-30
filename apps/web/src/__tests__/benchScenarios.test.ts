import {
  BENCH_MAX_STEPS,
  BenchRunRequest,
  type BenchRunResult,
  type BenchScenario,
  type BenchStepResult,
  type WhoAmI,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  formatScenario,
  parseScenario,
  plaintextIn,
  runSummary,
  runtimeMismatch,
  scenarioView,
  stepOpen,
  writingSteps,
} from '../benchScenarios'

const tool = (name: string, args: Record<string, unknown> = {}, extra: object = {}) => ({
  kind: 'tool' as const,
  tool: name,
  arguments: args,
  ...extra,
})

const scenario = (steps: BenchScenario['steps'], over: Partial<BenchScenario> = {}) =>
  ({ id: 'mine', title: '我的场景', steps, ...over }) as BenchScenario

const step = (over: Partial<BenchStepResult> = {}): BenchStepResult => ({
  index: 0,
  label: 'kioku_get',
  kind: 'tool',
  status: 'passed',
  reason: null,
  isError: false,
  internalError: false,
  internalDetail: null,
  httpStatus: null,
  text: '',
  raw: {},
  ms: 1,
  uris: [],
  session: null,
  vectorSkipped: false,
  assertions: [],
  captured: {},
  changes: null,
  replay: null,
  ...over,
})

const result = (
  counts: Partial<BenchRunResult['counts']>,
  over: Partial<BenchRunResult> = {},
): BenchRunResult => {
  const all = { passed: 0, failed: 0, skipped: 0, notRun: 0, ...counts }
  return {
    run: 'abcd1234',
    mode: 'rollback',
    ok: !all.failed && !all.notRun,
    whoami: {} as WhoAmI,
    counts: all,
    steps: [],
    replayDiverged: null,
    ...over,
  }
}

describe('校验场景', () => {
  it('合法的场景，默认值补齐，导出之后再读回来相同', () => {
    const parsed = parseScenario(
      JSON.stringify({ id: 'mine', title: '标题', steps: [{ kind: 'tool', tool: 'kioku_list' }] }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.scenario.steps[0]).toEqual({ kind: 'tool', tool: 'kioku_list', arguments: {} })
    expect(parseScenario(formatScenario(parsed.scenario))).toEqual(parsed)
    // 运行时发的是校验过的步骤，过得了运行请求的契约
    expect(BenchRunRequest.safeParse({ steps: parsed.scenario.steps }).success).toBe(true)
  })

  it('不是 JSON', () => {
    const parsed = parseScenario('{oops')
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.errors[0]).toContain('不是合法的 JSON')
  })

  it('字段的错误说清楚是第几步的哪个字段', () => {
    const parsed = parseScenario(
      JSON.stringify({
        id: 'mine',
        title: '标题',
        steps: [
          { kind: 'whoami' },
          { kind: 'tool', tool: 'kioku_list', expect: { contains: ['x'], regex: 'a+' } },
        ],
      }),
    )
    expect(parsed.ok).toBe(false)
    const text = !parsed.ok ? parsed.errors.join('\n') : ''
    expect(text).toContain('第 2 步 expect')
    expect(text).toContain('regex')
  })

  it('顶层的错误：id 的写法，缺步骤，多余的字段', () => {
    const errorsOf = (raw: unknown) => {
      const parsed = parseScenario(JSON.stringify(raw))
      return !parsed.ok ? parsed.errors.join('\n') : ''
    }
    expect(errorsOf({ id: 'Bad Id', title: '标题', steps: [{ kind: 'boot' }] })).toContain(
      'id：场景 id 只用小写字母、数字和 -',
    )
    expect(errorsOf({ id: 'mine', title: '标题' })).toContain('steps')
    expect(errorsOf({ id: 'mine', title: '标题', steps: [{ kind: 'boot' }], x: 1 })).toContain('x')
    expect(errorsOf('一段文字')).toContain('场景')
  })

  it('步骤超过上限拒绝', () => {
    const steps = Array.from({ length: BENCH_MAX_STEPS + 1 }, () => ({ kind: 'boot' }))
    expect(parseScenario(JSON.stringify({ id: 'mine', title: '标题', steps })).ok).toBe(false)
  })

  it('错误太多时只列前面的', () => {
    const steps = Array.from({ length: 30 }, () => ({ kind: 'nope' }))
    const parsed = parseScenario(JSON.stringify({ id: 'mine', title: '标题', steps }))
    expect(!parsed.ok && parsed.errors).toHaveLength(21)
    expect(!parsed.ok && parsed.errors.at(-1)).toContain('还有 10 处')
  })
})

describe('按运行时筛', () => {
  it('不给 runtimes 的都适用', () => {
    expect(runtimeMismatch(scenario([{ kind: 'boot' }]), 'astrbot')).toBeNull()
  })

  it('不适用的说明原因', () => {
    const only = scenario([{ kind: 'boot' }], { runtimes: ['claudecode', 'codex'] })
    expect(runtimeMismatch(only, 'codex')).toBeNull()
    expect(runtimeMismatch(only, 'astrbot')).toBe('只适用于 claudecode、codex，这个应用是 astrbot')
  })
})

describe('导出前检测明文', () => {
  it('凭据的 values：列出字段名，不带值', () => {
    const [finding] = plaintextIn(
      scenario([
        { kind: 'whoami' },
        tool(
          'kioku_credential_save',
          { identifier: 'nas', values: { password: 'hunter-value', token: 'x' } },
          { label: '存凭据' },
        ),
      ]),
    )
    expect(finding).toEqual({ step: 2, label: '存凭据', what: '凭据的值（字段 password、token）' })
    expect(JSON.stringify(finding)).not.toContain('hunter-value')
  })

  it('values 的值都是 null（删字段）或者没有 values：没有明文', () => {
    expect(
      plaintextIn(
        scenario([
          tool('kioku_credential_save', { identifier: 'nas', values: { password: null } }),
          tool('kioku_credential_save', { identifier: 'nas', description: '说明' }),
        ]),
      ),
    ).toEqual([])
  })

  it('secret 级的 kioku_create 与 kioku_update 的正文', () => {
    const findings = plaintextIn(
      scenario([
        tool('kioku_create', { uri: 'a://b', content: '机密', sensitivity: 'secret' }),
        tool('kioku_update', { uri: 'a://b', content: '机密', sensitivity: 'secret' }),
      ]),
    )
    expect(findings).toEqual([
      { step: 1, label: 'kioku_create', what: 'secret 级的正文' },
      { step: 2, label: 'kioku_update', what: 'secret 级的正文' },
    ])
  })

  it('敏感级写成变量时展开之前判不出来，按 secret 算', () => {
    const findings = plaintextIn(
      scenario([tool('kioku_create', { uri: 'a://b', content: 'x', sensitivity: '${level}' })]),
    )
    expect(findings).toHaveLength(1)
  })

  it('别的都不算：普通级的正文、只改敏感级不带正文、别的工具', () => {
    expect(
      plaintextIn(
        scenario([
          tool('kioku_create', { uri: 'a://b', content: '普通的' }),
          tool('kioku_create', { uri: 'a://b', content: '私密', sensitivity: 'private' }),
          tool('kioku_update', { uri: 'a://b', sensitivity: 'secret' }),
          tool('kioku_update', { uri: 'a://b', content: '没带敏感级' }),
          tool('kioku_get', { uri: 'a://b', content: 'x', sensitivity: 'secret' }),
          { kind: 'lifecycle', body: { event: 'prompt.submit', prompt: 'x' } },
          { kind: 'boot' },
        ]),
      ),
    ).toEqual([])
  })
})

describe('真实模式确认里的写步骤个数', () => {
  it('写工具、取值与带上下文的调用都算', () => {
    const group = { chatType: 'group' }
    expect(
      writingSteps(
        scenario([
          tool('kioku_create', { uri: 'a://b', content: 'x' }),
          tool('kioku_get', { uri: 'a://b' }),
          tool('kioku_credential', { identifier: 'nas' }),
          { kind: 'recall', body: { query: 'x', context: group } },
          { kind: 'recall', body: { query: 'x' } },
          { kind: 'lifecycle', body: { event: 'turn.end', context: group } },
          { kind: 'whoami' },
        ]),
      ),
    ).toBe(4)
  })
})

describe('运行结果怎么说', () => {
  it('全部通过', () => {
    expect(runSummary(result({ passed: 3 }), 'judged')).toEqual({
      color: 'success',
      title: '全部通过：通过 3',
    })
    expect(runSummary(result({ passed: 3, skipped: 2 }), 'judged').title).toBe(
      '全部通过：通过 3，跳过 2',
    )
  })

  it('全部跳过不能说成通过', () => {
    const summary = runSummary(result({ skipped: 3 }), 'judged')
    expect(summary.color).toBe('neutral')
    expect(summary.title).toContain('全部跳过')
    expect(summary.title).not.toContain('通过')
  })

  it('有失败或没有执行的算失败，四个数都列出来', () => {
    expect(runSummary(result({ passed: 1, failed: 2, skipped: 3, notRun: 4 }), 'judged')).toEqual({
      color: 'error',
      title: '有失败：通过 1，失败 2，跳过 3，没有执行 4',
    })
    expect(runSummary(result({ passed: 1, notRun: 1 }), 'judged').color).toBe('error')
  })

  it('权限探测不判通过与失败', () => {
    const summary = runSummary(
      result({ passed: 2, failed: 1 }, { steps: [step(), step(), step({ status: 'failed' })] }),
      'probe',
    )
    expect(summary.color).toBe('neutral')
    expect(summary.title).toContain('只列结果')
    expect(summary.title).toContain('共 3 步')
    expect(summary.title).not.toContain('失败 1')
  })

  it('权限探测里内部错误与没有执行的还是要说', () => {
    const summary = runSummary(
      result({ notRun: 1 }, { steps: [step({ internalError: true }), step({ status: 'notRun' })] }),
      'probe',
    )
    expect(summary.color).toBe('warning')
    expect(summary.title).toContain('没有执行 1 步')
    expect(summary.title).toContain('内部错误 1 步')
  })

  it('重放分叉', () => {
    const summary = runSummary(
      result(
        { notRun: 1 },
        { replayDiverged: { index: 0, text: '报错', internalError: false }, ok: false },
      ),
      'judged',
    )
    expect(summary).toEqual({
      color: 'error',
      title: '重放的第 1 步报错，这次的步骤都没有执行',
    })
  })

  it('场景的看法与默认打开的步骤', () => {
    expect(scenarioView({ probe: true })).toBe('probe')
    expect(scenarioView({})).toBe('judged')
    expect(stepOpen(step({ status: 'failed' }), 'judged')).toBe(true)
    expect(stepOpen(step({ status: 'notRun' }), 'judged')).toBe(true)
    expect(stepOpen(step(), 'judged')).toBe(false)
    // 跳过的原因要看得到，不用再点开
    expect(stepOpen(step({ status: 'skipped' }), 'judged')).toBe(true)
    expect(stepOpen(step({ status: 'skipped' }), 'probe')).toBe(true)
    expect(stepOpen(step({ status: 'notRun' }), 'probe')).toBe(true)
    expect(stepOpen(step({ status: 'failed', internalError: true }), 'probe')).toBe(true)
    expect(stepOpen(step({ status: 'failed' }), 'probe')).toBe(false)
    expect(stepOpen(step(), 'probe')).toBe(false)
  })
})
