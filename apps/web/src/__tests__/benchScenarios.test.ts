import {
  BENCH_MAX_STEPS,
  BenchRunRequest,
  type BenchRunResult,
  type BenchScenario,
  type BenchStepResult,
  type WhoAmI,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { notExecuted, shownAssertions, stepBadge } from '../benchResult'
import {
  formatScenario,
  parseScenario,
  plaintextIn,
  runSummary,
  runtimeMismatch,
  scenarioEdited,
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
      'id：场景 id 只能包含小写字母、数字和 -',
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

describe('文本框里的场景改过没有', () => {
  it('和上次载入的不同才算', () => {
    expect(scenarioEdited('', '')).toBe(false)
    expect(scenarioEdited('{"a":1}', '{"a":1}')).toBe(false)
    expect(scenarioEdited('{"a":2}', '{"a":1}')).toBe(true)
    expect(scenarioEdited('{"a":1}', '')).toBe(true)
  })

  it('全删掉了不算：没有什么可丢的', () => {
    expect(scenarioEdited('', '{"a":1}')).toBe(false)
    expect(scenarioEdited('  \n', '{"a":1}')).toBe(false)
  })
})

describe('按运行时筛', () => {
  it('不给 runtimes 的都适用', () => {
    expect(runtimeMismatch(scenario([{ kind: 'boot' }]), 'astrbot')).toBeNull()
  })

  it('不适用的说明原因', () => {
    const only = scenario([{ kind: 'boot' }], { runtimes: ['claudecode', 'codex'] })
    expect(runtimeMismatch(only, 'codex')).toBeNull()
    expect(runtimeMismatch(only, 'astrbot')).toBe('仅适用于 claudecode、codex，当前应用是 astrbot')
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
      { step: 1, label: 'kioku_create', what: '机密级正文' },
      { step: 2, label: 'kioku_update', what: '机密级正文' },
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
          tool('kioku_create', { uri: 'a://plain', content: '普通的' }),
          tool('kioku_create', { uri: 'a://private', content: '私密', sensitivity: 'private' }),
          tool('kioku_update', { uri: 'a://meta', sensitivity: 'secret' }),
          tool('kioku_update', { uri: 'a://other', content: '没带敏感级' }),
          tool('kioku_get', { uri: 'a://got', content: 'x', sensitivity: 'secret' }),
          { kind: 'lifecycle', body: { event: 'prompt.submit', prompt: 'x' } },
          { kind: 'boot' },
        ]),
      ),
    ).toEqual([])
  })

  describe('按整个场景看：写的时候没带 sensitivity 也可能是 secret', () => {
    const INFERRED = '机密级正文（此记忆在其他步骤中为机密）'
    const stepsIn = (...steps: BenchScenario['steps']) =>
      plaintextIn(scenario(steps)).map((finding) => finding.step)

    it('先建成 secret，再改正文：两步都算，只带正文的那步说明原因', () => {
      expect(
        plaintextIn(
          scenario([
            tool('kioku_create', { uri: 'a://b', content: '机密', sensitivity: 'secret' }),
            tool('kioku_update', { uri: 'a://b', content: '新的机密' }),
          ]),
        ),
      ).toEqual([
        { step: 1, label: 'kioku_create', what: '机密级正文' },
        { step: 2, label: 'kioku_update', what: INFERRED },
      ])
    })

    it('先写普通级的正文，后面才改成 secret：前面的也算，文件里留着它', () => {
      expect(
        plaintextIn(
          scenario([
            tool('kioku_create', { uri: 'a://b', content: '之后才变成机密' }),
            tool('kioku_update', { uri: 'a://b', sensitivity: 'secret' }),
          ]),
        ),
      ).toEqual([{ step: 1, label: 'kioku_create', what: INFERRED }])
    })

    it('改成 secret 的同时带正文：前后的写入都算', () => {
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://b', content: '之前' }),
          tool('kioku_update', { uri: 'a://b', content: '同时', sensitivity: 'secret' }),
          tool('kioku_update', { uri: 'a://b', content: '之后' }),
        ),
      ).toEqual([1, 2, 3])
    })

    it('敏感级写成变量的步骤也算改成了 secret', () => {
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://b', content: '正文' }),
          tool('kioku_update', { uri: 'a://b', sensitivity: '${level}' }),
        ),
      ).toEqual([1])
    })

    it('别的 URI 不受影响；带正文但不写记忆的工具不算把它改成 secret', () => {
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://secret', content: '机密', sensitivity: 'secret' }),
          tool('kioku_update', { uri: 'a://other', content: '普通的' }),
          tool('kioku_get', { uri: 'a://got', sensitivity: 'secret' }),
          tool('kioku_create', { uri: 'a://got', content: '普通的' }),
        ),
      ).toEqual([1])
    })

    it('移动跟着走：移过去之后写新 URI 的正文也算', () => {
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://b', content: '机密', sensitivity: 'secret' }),
          tool('kioku_move', { from: 'a://b', to: 'a://c' }),
          tool('kioku_update', { uri: 'a://c', content: '新的机密' }),
        ),
      ).toEqual([1, 3])
    })

    it('移动之后才改成 secret：移动之前写的正文也算', () => {
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://b', content: '之后才变成机密' }),
          tool('kioku_move', { from: 'a://b', to: 'a://c' }),
          tool('kioku_update', { uri: 'a://c', sensitivity: 'secret' }),
        ),
      ).toEqual([1])
    })

    it('连续移动：不管先后都顺着找得到', () => {
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://one', content: '之后才变成机密' }),
          tool('kioku_move', { from: 'a://one', to: 'a://two' }),
          tool('kioku_move', { from: 'a://two', to: 'a://three' }),
          tool('kioku_update', { uri: 'a://three', sensitivity: 'secret' }),
        ),
      ).toEqual([1])
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://one', content: '机密', sensitivity: 'secret' }),
          tool('kioku_move', { from: 'a://one', to: 'a://two' }),
          tool('kioku_move', { from: 'a://two', to: 'a://three' }),
          tool('kioku_update', { uri: 'a://three', content: '新的机密' }),
        ),
      ).toEqual([1, 4])
    })

    it('移动的两头都不是 secret 时不算', () => {
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://secret', content: '机密', sensitivity: 'secret' }),
          tool('kioku_create', { uri: 'a://b', content: '普通的' }),
          tool('kioku_move', { from: 'a://b', to: 'a://c' }),
          tool('kioku_update', { uri: 'a://c', content: '普通的' }),
        ),
      ).toEqual([1])
    })

    it('${run} 写法相同就是同一条，写法不同就不是', () => {
      expect(
        stepsIn(
          tool('kioku_create', {
            uri: 'a://${run}/b',
            content: '机密',
            sensitivity: 'secret',
          }),
          tool('kioku_update', { uri: 'a://${run}/b', content: '新的机密' }),
          tool('kioku_update', { uri: 'a://${run}/c', content: '普通的' }),
          tool('kioku_update', { uri: 'a://${expires}/c', content: '普通的' }),
        ),
      ).toEqual([1, 2])
    })

    it('URI 带 capture 的变量时判不出是哪一条：有 secret 就按可能是算', () => {
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://b', content: '机密', sensitivity: 'secret' }),
          tool('kioku_update', { uri: '${target}', content: '可能是它' }),
        ),
      ).toEqual([1, 2])
      expect(
        stepsIn(
          tool('kioku_update', { uri: 'a://${name}/b', sensitivity: 'secret' }),
          tool('kioku_create', { uri: 'a://c', content: '可能是它' }),
        ),
      ).toEqual([2])
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://b', content: '机密', sensitivity: 'secret' }),
          tool('kioku_move', { from: '${target}', to: 'a://c' }),
          tool('kioku_update', { uri: 'a://c', content: '可能是它' }),
        ),
      ).toEqual([1, 3])
    })

    it('没有 secret 时带变量的 URI 也不算', () => {
      expect(stepsIn(tool('kioku_update', { uri: '${target}', content: '普通的' }))).toEqual([])
    })

    it('只看写法、不看执行结果：删掉之后再写同一个 URI 也算，宁可多提示', () => {
      expect(
        stepsIn(
          tool('kioku_create', { uri: 'a://b', content: '机密', sensitivity: 'secret' }),
          tool('kioku_delete', { uri: 'a://b' }),
          tool('kioku_create', { uri: 'a://b', content: '普通的' }),
        ),
      ).toEqual([1, 3])
    })

    it('照提示改掉这些步骤之后不再有明文', () => {
      const before = scenario([
        tool('kioku_create', { uri: 'a://b', content: '之后才变成机密' }),
        tool('kioku_update', { uri: 'a://b', sensitivity: 'secret' }),
        tool('kioku_update', { uri: 'a://b', content: '新的机密' }),
      ])
      expect(plaintextIn(before).map((finding) => finding.step)).toEqual([1, 3])
      expect(plaintextIn(scenario([before.steps[1]!]))).toEqual([])
    })
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

  it('event、chatType 写成变量时展开之前判不出来，算可能写库', () => {
    const count = (...steps: BenchScenario['steps']) => writingSteps(scenario(steps))
    expect(count({ kind: 'lifecycle', body: { event: '${event}' } })).toBe(1)
    expect(count({ kind: 'lifecycle', body: { event: 'turn.${what}' } })).toBe(1)
    expect(
      count({
        kind: 'lifecycle',
        body: { event: 'prompt.submit', prompt: 'x', context: { chatType: '${chat}' } },
      }),
    ).toBe(1)
    expect(count({ kind: 'recall', body: { query: 'x', context: { chatType: '${chat}' } } })).toBe(
      1,
    )
  })

  it('别的地方的变量不算：写库与否只看 event 与 chatType', () => {
    const count = (...steps: BenchScenario['steps']) => writingSteps(scenario(steps))
    expect(
      count(
        { kind: 'lifecycle', body: { event: 'prompt.submit', prompt: '${run}' } },
        { kind: 'lifecycle', body: { event: 'session.start', sessionId: '${run}' } },
        { kind: 'recall', body: { query: '${run}' } },
        // /recall 没有 event：写成变量也不会变成 turn.end
        { kind: 'recall', body: { query: 'x', event: '${event}' } },
        { kind: 'recall', body: { query: 'x', context: { chatType: 'cron' } } },
        tool('kioku_get', { uri: '${uri}' }),
        { kind: 'lifecycle', body: '${body}' },
        { kind: 'lifecycle', body: null },
      ),
    ).toBe(0)
  })

  it('字面值的判定不变：和命令行是同一个', () => {
    const count = (...steps: BenchScenario['steps']) => writingSteps(scenario(steps))
    expect(count({ kind: 'lifecycle', body: { event: 'turn.end' } })).toBe(1)
    expect(count(tool('kioku_credential', { identifier: '${name}' }))).toBe(1)
    expect(count(tool('kioku_credential'))).toBe(0)
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
      title: '有失败：通过 1，失败 2，跳过 3，未执行 4',
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
    expect(summary.title).toContain('未执行 1 步')
    expect(summary.title).toContain('内部错误 1 步')
  })

  describe('权限探测里没发出去、capture 没取到的步骤', () => {
    // 服务端的 runner 给这种步骤的样子：没有响应，失败，原因在断言里
    const unsent = step({
      status: 'failed',
      raw: null,
      assertions: [{ message: '变量 ${version} 没有取到', ok: false }],
    })
    // 工具没报错，结果里却没有 capture 要的内容
    const uncaptured = step({
      status: 'failed',
      assertions: [{ message: 'capture version：结果里没有「版本: 」', ok: false }],
    })
    // 工具报错（被拒绝）：capture 本来就取不到，这是探测的结果
    const refused = step({
      status: 'failed',
      isError: true,
      assertions: [{ message: 'capture version：结果里没有「版本: 」', ok: false }],
    })
    const titleOf = (...steps: BenchStepResult[]) =>
      runSummary(result({ failed: steps.length }, { steps }), 'probe')

    it('依赖的变量没有取到：计入「未执行」，和徽章说的一样', () => {
      const summary = titleOf(unsent)
      expect(summary.color).toBe('warning')
      expect(summary.title).toContain('未执行 1 步')
      expect(stepBadge(unsent, 'probe').label).toBe('未执行')
      expect(notExecuted(unsent)).toBe(true)
    })

    it('和服务端记成 notRun 的加在一起算', () => {
      const summary = runSummary(
        result(
          { failed: 1, notRun: 1 },
          { steps: [unsent, step({ status: 'notRun', raw: null })] },
        ),
        'probe',
      )
      expect(summary.title).toContain('未执行 2 步')
    })

    it('工具没报错、capture 没取到：说出来', () => {
      const summary = titleOf(uncaptured)
      expect(summary.color).toBe('warning')
      expect(summary.title).toContain('capture 未取到 1 步')
      expect(summary.title).not.toContain('未执行')
    })

    it('工具报错（被拒绝）是正常的结果：不算', () => {
      const summary = titleOf(refused, step({ status: 'failed', isError: true }))
      expect(summary.color).toBe('neutral')
      expect(summary.title).toMatch(/共 2 步$/)
    })

    it('expect 不成立不算：权限探测不判通过与失败', () => {
      const summary = titleOf(
        step({ status: 'failed', assertions: [{ message: '应包含「x」', ok: false }] }),
      )
      expect(summary.color).toBe('neutral')
      expect(summary.title).toMatch(/共 1 步$/)
    })

    it('内部错误不重复算成没有执行', () => {
      const summary = titleOf(step({ status: 'failed', internalError: true, raw: null }))
      expect(summary.title).toContain('内部错误 1 步')
      expect(summary.title).not.toContain('未执行')
    })

    it('默认打开，看得到原因', () => {
      expect(stepOpen(unsent, 'probe')).toBe(true)
      expect(shownAssertions(unsent, 'probe')).toEqual(unsent.assertions)
      expect(stepOpen(uncaptured, 'probe')).toBe(true)
      expect(shownAssertions(uncaptured, 'probe')).toEqual(uncaptured.assertions)
    })

    it('正常的探测结果照旧不打开，也不列断言', () => {
      expect(stepOpen(refused, 'probe')).toBe(false)
      expect(shownAssertions(refused, 'probe')).toEqual([])
      const expected = step({
        status: 'failed',
        assertions: [
          { message: '应包含「x」', ok: false },
          { message: '不应报错', ok: true },
        ],
      })
      expect(stepOpen(expected, 'probe')).toBe(false)
      expect(shownAssertions(expected, 'probe')).toEqual([])
    })

    it('capture 没取到的步骤只列这一条：别的断言照旧不判', () => {
      const mixed = step({
        status: 'failed',
        assertions: [
          { message: '应包含「x」', ok: false },
          { message: 'capture version：结果里没有「版本: 」', ok: false },
        ],
      })
      expect(shownAssertions(mixed, 'probe')).toEqual([
        { message: 'capture version：结果里没有「版本: 」', ok: false },
      ])
    })

    it('按断言看的场景不受影响：全部列出', () => {
      expect(shownAssertions(uncaptured, 'judged')).toEqual(uncaptured.assertions)
      expect(shownAssertions(refused, 'judged')).toEqual(refused.assertions)
      expect(shownAssertions(refused, 'call')).toEqual(refused.assertions)
    })

    it('摘要里的「未执行」和徽章对得上', () => {
      const steps = [
        unsent,
        uncaptured,
        refused,
        step(),
        step({ status: 'notRun', raw: null }),
        step({ status: 'skipped', raw: null }),
        step({ status: 'failed', internalError: true, raw: null }),
      ]
      for (const s of steps) {
        expect(notExecuted(s)).toBe(stepBadge(s, 'probe').label === '未执行')
      }
    })
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
      title: '重放的第 1 步报错，本次步骤均未执行',
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
