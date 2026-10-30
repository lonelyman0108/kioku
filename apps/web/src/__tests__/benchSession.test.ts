import {
  BENCH_MAX_REPLAY_BYTES,
  BENCH_MAX_REPLAY_STEPS,
  BenchRunRequest,
  type AppInfo,
  type BenchReplayStep,
  type BenchRunResult,
  type BenchStepResult,
  type KeyInfo,
  type KeyScopes,
  type WhoAmI,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import {
  acceptDivergence,
  BENCH_TIMELINE_MAX,
  divergenceNotice,
  emptySession,
  ownedApps,
  REAL_MODE_CONSEQUENCES,
  recordRun,
  replayEntryOf,
  replayFor,
  replayStepLabel,
  runBlocker,
  runFailureMessage,
  sessionUsage,
  usableKeys,
  type BenchSession,
} from '../benchSession'

const scopes: KeyScopes = {
  readLayers: ['private'],
  writeLayers: ['private'],
  maxSensitivity: 'private',
  admin: false,
}
const whoami = { scopes } as WhoAmI

const write = (uri: string, content = '正文'): BenchReplayStep => ({
  kind: 'tool',
  tool: 'kioku_create',
  arguments: { uri, content },
})
const TURN: BenchReplayStep = {
  kind: 'lifecycle',
  body: {
    event: 'turn.end',
    sessionId: 'bench-session',
    context: { chatType: 'group', platform: 'bench', group: { id: 'g' }, sender: { id: 'u' } },
    user: '问',
    reply: '答',
  },
}

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

const result = (steps: BenchStepResult[], over: Partial<BenchRunResult> = {}): BenchRunResult => ({
  run: 'abcd1234',
  mode: 'rollback',
  ok: true,
  whoami,
  counts: { passed: steps.length, failed: 0, skipped: 0, notRun: 0 },
  steps,
  replayDiverged: null,
  ...over,
})

const recorded = (session: BenchSession, ...replays: BenchReplayStep[]) =>
  replays.reduce((s, replay) => recordRun(s, result([step({ replay })])), session)

describe('谁能用测试台', () => {
  const app = (id: string, ownerAccountId: string) => ({ id, ownerAccountId }) as AppInfo

  it('只列自己是主人的应用：空间 owner 也看不到别人的应用', () => {
    const apps = [app('a', 'me'), app('b', 'other'), app('c', 'me')]
    expect(ownedApps(apps, 'me').map((a) => a.id)).toEqual(['a', 'c'])
    expect(ownedApps(apps, undefined)).toEqual([])
  })

  it('只列还有效的 Key：吊销的与作废的 effectiveScopes 是 null', () => {
    const key = (id: string, effectiveScopes: KeyScopes | null) =>
      ({ id, effectiveScopes }) as KeyInfo
    const keys = [key('live', scopes), key('revoked', null), key('live2', scopes)]
    expect(usableKeys(keys).map((k) => k.id)).toEqual(['live', 'live2'])
  })
})

describe('真实模式的确认文字', () => {
  it('列出写入是真的、对象删不掉、turn.end 排抽取', () => {
    const text = REAL_MODE_CONSEQUENCES.join('\n')
    expect(text).toContain('写入是真的')
    expect(text).toContain('新建的对象没有删除接口，只能合并')
    expect(text).toContain('turn.end')
    expect(text).toContain('排抽取')
  })
})

describe('运行失败的说明', () => {
  it('回滚模式：都回滚了，只说原因', () => {
    expect(runFailureMessage(new ApiError(429, '同时运行的回滚太多'), 'rollback')).toBe(
      '同时运行的回滚太多',
    )
    expect(runFailureMessage(new ApiError(500, '服务内部错误'), 'rollback')).toBe('服务内部错误')
    expect(runFailureMessage(new TypeError('fetch'), 'rollback')).toContain('网络出错了')
  })

  it('真实模式：5xx 与网络错误可能已经写了一部分，要说出来', () => {
    expect(runFailureMessage(new ApiError(502, '网关'), 'real')).toContain('可能已经执行了一部分')
    expect(runFailureMessage(new TypeError('fetch'), 'real')).toContain('可能已经执行了一部分')
  })

  it('真实模式：4xx 是写入之前就拒绝了，不能说可能写了', () => {
    for (const status of [400, 403, 404, 413, 429]) {
      expect(runFailureMessage(new ApiError(status, '拒绝'), 'real')).toBe('拒绝')
    }
  })
})

describe('重放日志只记成功的写步骤', () => {
  it('写工具与 turn.end 进日志，存服务端返回的展开之后的参数', () => {
    const expanded = write('projects://bench/abcd1234/note')
    const session = recordRun(
      emptySession(),
      result([step({ replay: expanded }), step({ replay: TURN })]),
    )
    expect(session.replay).toEqual([expanded, TURN])
    expect(session.timeline.map((e) => e.kept)).toEqual([true, true])
  })

  it('读步骤、报错的写步骤、内部错误的写步骤都不进', () => {
    const session = recordRun(
      emptySession(),
      result([
        step(),
        step({ isError: true, replay: write('a://b') }),
        step({ internalError: true, isError: true, replay: write('a://c') }),
        // 根事务中止时错误可能被吞掉：看起来没报错，也标成内部错误
        step({ internalError: true, replay: write('a://d') }),
      ]),
    )
    expect(session.replay).toEqual([])
    expect(session.timeline.map((e) => e.kept)).toEqual([false, false, false, false])
    expect(session.timeline).toHaveLength(4)
  })

  it('不是写步骤的 replay 不进（按契约的判定再确认一次）', () => {
    const notWrite = {
      kind: 'tool',
      tool: 'kioku_get',
      arguments: {},
    } as unknown as BenchReplayStep
    expect(replayEntryOf(step({ replay: notWrite }))).toBeNull()
    expect(replayEntryOf(step({ replay: write('a://b') }))).toEqual(write('a://b'))
  })

  it('断言不成立但写成功了的也进：它确实写了，后面的调用要读得到', () => {
    const session = recordRun(
      emptySession(),
      result([step({ status: 'failed', replay: write('a://b') })]),
    )
    expect(session.replay).toEqual([write('a://b')])
  })

  it('按做过的顺序累积，下一次运行带上全部，过得了运行请求的契约', () => {
    const session = recorded(emptySession(), write('a://1'), TURN, write('a://2'))
    expect(session.replay).toEqual([write('a://1'), TURN, write('a://2')])
    const replay = replayFor(session, 'rollback')
    const parsed = BenchRunRequest.safeParse({ steps: [{ kind: 'whoami' }], replay })
    expect(parsed.success).toBe(true)
  })
})

describe('真实模式不重放', () => {
  it('不记日志，也不带日志：写入已经生效，时间线照样列出', () => {
    const session = recordRun(
      emptySession(),
      result([step({ replay: write('a://b') })], { mode: 'real' }),
    )
    expect(session.replay).toEqual([])
    expect(session.replayEntryIds).toEqual([])
    expect(session.timeline).toHaveLength(1)
    expect(session.timeline[0]!.kept).toBe(false)
    expect(replayFor(session, 'real')).toEqual([])
  })

  it('就算日志里有东西，真实模式也不带：契约不接受', () => {
    const session = recorded(emptySession(), write('a://b'))
    const replay = replayFor(session, 'real')
    expect(replay).toEqual([])
    expect(
      BenchRunRequest.safeParse({ mode: 'real', steps: [{ kind: 'whoami' }], replay }).success,
    ).toBe(true)
    expect(
      BenchRunRequest.safeParse({
        mode: 'real',
        steps: [{ kind: 'whoami' }],
        replay: session.replay,
      }).success,
    ).toBe(false)
  })

  it('真实模式不会被重放日志的上限挡住', () => {
    expect(runBlocker({ ...emptySession(), overflow: true }, 'real')).toBeNull()
  })
})

describe('重放日志的上限', () => {
  const full = (count: number) =>
    recorded(emptySession(), ...Array.from({ length: count }, (_, i) => write(`a://${i}`)))

  it('到上限为止都能带，发出去的请求过得了契约', () => {
    const session = full(BENCH_MAX_REPLAY_STEPS)
    expect(session.replay).toHaveLength(BENCH_MAX_REPLAY_STEPS)
    expect(session.overflow).toBe(false)
    expect(runBlocker(session, 'rollback')).toBeNull()
    expect(
      BenchRunRequest.safeParse({ steps: [{ kind: 'whoami' }], replay: session.replay }).success,
    ).toBe(true)
  })

  it('超了条数：这一步不进日志，提示清空，不再发请求', () => {
    const session = recorded(full(BENCH_MAX_REPLAY_STEPS), write('a://over'))
    expect(session.replay).toHaveLength(BENCH_MAX_REPLAY_STEPS)
    expect(session.overflow).toBe(true)
    expect(session.timeline.at(-1)!.kept).toBe(false)
    expect(runBlocker(session, 'rollback')).toContain('清空')
  })

  it('超了字节数同样如此，按 UTF-8 算（和服务端校验的一样）', () => {
    // 一个汉字 3 字节：按字符数算只有 17 万，按字节数算超过了 512 KB
    const big = write('a://big', '汉'.repeat(Math.floor(BENCH_MAX_REPLAY_BYTES / 3)))
    const session = recorded(emptySession(), big)
    expect(session.replay).toEqual([])
    expect(session.overflow).toBe(true)
    expect(BenchRunRequest.safeParse({ steps: [{ kind: 'whoami' }], replay: [big] }).success).toBe(
      false,
    )
  })

  it('字节数正好放得下时能带，服务端也接受', () => {
    const empty = JSON.stringify([write('a://x', '')]).length
    const fits = write('a://x', 'a'.repeat(BENCH_MAX_REPLAY_BYTES - empty))
    const session = recorded(emptySession(), fits)
    expect(session.overflow).toBe(false)
    expect(
      BenchRunRequest.safeParse({ steps: [{ kind: 'whoami' }], replay: session.replay }).success,
    ).toBe(true)
  })

  it('放不下之后，后面放得下的也不记：不能跳过一步接着记', () => {
    const big = write('a://big', 'a'.repeat(BENCH_MAX_REPLAY_BYTES))
    const session = recordRun(
      emptySession(),
      result([step({ replay: big }), step({ replay: write('a://small') })]),
    )
    expect(session.replay).toEqual([])
    expect(session.replayEntryIds).toEqual([])
    expect(session.overflow).toBe(true)
    expect(session.timeline.map((e) => e.kept)).toEqual([false, false])
  })

  it('清空之后可以接着来', () => {
    expect(runBlocker(emptySession(), 'rollback')).toBeNull()
  })
})

describe('重放分叉', () => {
  const notRun = step({
    status: 'notRun',
    raw: null,
    reason: '重放的第 2 步报错，这一步没有执行',
  })
  const divergedAt = (index: number, internalError = false) =>
    result([notRun], {
      ok: false,
      counts: { passed: 0, failed: 0, skipped: 0, notRun: 1 },
      replayDiverged: { index, text: '版本已变化', internalError },
    })
  const log = () => recorded(emptySession(), write('a://1'), write('a://2'), write('a://3'))

  it('记下第几步，日志不动，这次的步骤记成没有执行', () => {
    const session = recordRun(log(), divergedAt(1))
    expect(session.diverged).toEqual({ index: 1, text: '版本已变化', internalError: false })
    expect(session.replay).toHaveLength(3)
    expect(session.timeline.at(-1)!.step.status).toBe('notRun')
    expect(session.timeline.at(-1)!.kept).toBe(false)
  })

  it('提示第几步（从 1 算）、哪一步和错误', () => {
    const notice = divergenceNotice(recordRun(log(), divergedAt(1)))!
    expect(notice.title).toContain('第 2 步（kioku_create a://2）')
    expect(notice.title).toContain('没有执行')
    expect(notice.description).toContain('版本已变化')
    expect(notice.description).toContain('清空')
    expect(notice.description).toContain('接受')
    expect(divergenceNotice(log())).toBeNull()
  })

  it('内部错误可能是暂时的（例如等锁超时），可以再试一次', () => {
    const notice = divergenceNotice(recordRun(log(), divergedAt(0, true)))!
    expect(notice.description).toContain('再运行一次')
  })

  it('接受：只去掉报错的那一步，别的留着', () => {
    const accepted = acceptDivergence(recordRun(log(), divergedAt(1)))
    expect(accepted.replay).toEqual([write('a://1'), write('a://3')])
    expect(accepted.diverged).toBeNull()
    expect(accepted.timeline).toHaveLength(4)
  })

  const flags = (session: BenchSession) => session.timeline.map((e) => [e.kept, e.removed])

  it('接受：时间线跟着日志，去掉的那一条不再标着已保留', () => {
    const accepted = acceptDivergence(recordRun(log(), divergedAt(1)))
    expect(flags(accepted)).toEqual([
      [true, false],
      [false, true],
      [true, false],
      // 这次没有执行的步骤
      [false, false],
    ])
    expect(accepted.replayEntryIds).toEqual([1, 3])
  })

  it('没接受之前时间线不变：日志也还没动', () => {
    const session = recordRun(log(), divergedAt(1))
    expect(flags(session).slice(0, 3)).toEqual([
      [true, false],
      [true, false],
      [true, false],
    ])
  })

  it('一次运行里混着读、报错与写：去掉的是报错的那一步对应的条目，不是同样下标的条目', () => {
    const session = recordRun(
      emptySession(),
      result([
        step(),
        step({ replay: write('a://1') }),
        step({ isError: true, replay: write('a://failed') }),
        step({ replay: write('a://2') }),
      ]),
    )
    expect(session.replayEntryIds).toEqual([2, 4])
    const accepted = acceptDivergence(recordRun(session, divergedAt(1)))
    expect(accepted.replay).toEqual([write('a://1')])
    expect(accepted.timeline.filter((e) => e.removed).map((e) => e.step.replay)).toEqual([
      write('a://2'),
    ])
    expect(accepted.timeline.filter((e) => e.kept).map((e) => e.step.replay)).toEqual([
      write('a://1'),
    ])
  })

  it('连续接受：第二次对着的是第一次之后的日志', () => {
    const once = acceptDivergence(recordRun(log(), divergedAt(0)))
    expect(once.replay).toEqual([write('a://2'), write('a://3')])
    const twice = acceptDivergence(recordRun(once, divergedAt(0)))
    expect(twice.replay).toEqual([write('a://3')])
    expect(twice.replayEntryIds).toEqual([3])
    expect(twice.timeline.filter((e) => e.kept).map((e) => e.id)).toEqual([3])
    expect(twice.timeline.filter((e) => e.removed).map((e) => e.id)).toEqual([1, 2])
  })

  it('接受之后还能接着记：新的写入接在后面，再分叉也对得上', () => {
    const accepted = acceptDivergence(recordRun(log(), divergedAt(1)))
    const next = recorded(accepted, write('a://4'))
    expect(next.replay).toEqual([write('a://1'), write('a://3'), write('a://4')])
    const again = acceptDivergence(recordRun(next, divergedAt(2)))
    expect(again.replay).toEqual([write('a://1'), write('a://3')])
    expect(again.timeline.filter((e) => e.removed).map((e) => e.step.replay)).toEqual([
      write('a://2'),
      write('a://4'),
    ])
  })

  it('去掉的那一条已经滚出了时间线：日志照样去掉，别的条目不受影响', () => {
    const first = recorded(emptySession(), write('a://old'))
    const reads = Array.from({ length: BENCH_TIMELINE_MAX }, () => step())
    const session = recordRun(recordRun(first, result(reads)), divergedAt(0))
    expect(session.timeline.some((e) => e.id === session.replayEntryIds[0])).toBe(false)
    const accepted = acceptDivergence(session)
    expect(accepted.replay).toEqual([])
    expect(accepted.replayEntryIds).toEqual([])
    expect(accepted.timeline.some((e) => e.kept || e.removed)).toBe(false)
  })

  it('没有分叉时接受什么都不做', () => {
    const session = log()
    expect(acceptDivergence(session)).toBe(session)
  })

  it('下一次运行成功，分叉的提示就没了', () => {
    const session = recordRun(recordRun(log(), divergedAt(1)), result([step()]))
    expect(session.diverged).toBeNull()
    expect(session.replay).toHaveLength(3)
  })
})

describe('时间线', () => {
  it('记下这次运行的标记与权限，id 不重复', () => {
    const session = recorded(emptySession(), write('a://1'), write('a://2'))
    expect(session.timeline.map((e) => e.id)).toEqual([1, 2])
    expect(session.timeline[0]).toMatchObject({ run: 'abcd1234', whoami })
  })

  it('只留最近的，丢掉的数记下来，重放日志不受影响', () => {
    const steps = Array.from({ length: BENCH_TIMELINE_MAX + 5 }, (_, i) =>
      step({ index: i, replay: write(`a://${i % 3}`) }),
    )
    const session = recordRun(emptySession(), result(steps))
    expect(session.timeline).toHaveLength(BENCH_TIMELINE_MAX)
    expect(session.timeline[0]!.step.index).toBe(5)
    expect(session.dropped).toBe(5)
    expect(session.replay).toHaveLength(BENCH_MAX_REPLAY_STEPS)
  })
})

describe('这次会话的说明', () => {
  it('回滚模式：有没有保留的写入', () => {
    expect(sessionUsage(emptySession(), 'rollback')).toContain('还没有保留的写入')
    const text = sessionUsage(recorded(emptySession(), write('a://1')), 'rollback')
    expect(text).toContain('保留了 1 步写入')
    expect(text).toContain(`上限 ${BENCH_MAX_REPLAY_STEPS} 步`)
    expect(text).toContain('不会落库')
  })

  it('真实模式：不重放', () => {
    expect(sessionUsage(emptySession(), 'real')).toContain('不重放')
  })

  it('重放步骤的名字', () => {
    expect(replayStepLabel(write('a://1'))).toBe('kioku_create a://1')
    expect(replayStepLabel(TURN)).toBe('turn.end bench-session')
    expect(
      replayStepLabel({
        kind: 'tool',
        tool: 'kioku_move',
        arguments: { from: 'a://1', to: 'a://2' },
      }),
    ).toBe('kioku_move a://1')
    expect(
      replayStepLabel({
        kind: 'tool',
        tool: 'kioku_credential_save',
        arguments: { identifier: 'nas' },
      }),
    ).toBe('kioku_credential_save nas')
    expect(replayStepLabel({ kind: 'tool', tool: 'kioku_delete', arguments: {} })).toBe(
      'kioku_delete',
    )
  })
})
