import {
  BenchReplayStep,
  isReplayStep,
  SENSITIVITIES,
  type BenchAssertion,
  type BenchCapture,
  type BenchExpect,
  type BenchInternalDetail,
  type BenchMode,
  type BenchRequires,
  type BenchRunResult,
  type BenchStep,
  type BenchStepResult,
  type KeyScopes,
} from '@kioku/contracts'

import type { BenchExecutor, ResolvedStep, StepOutcome } from './executor'

// 跑一串步骤：requires、展开变量、执行、断言、capture、重放日志。执行方式由 executor 决定，这里不碰数据库。
// 断言与 capture 都是字符串的线性操作，不执行场景给的模式（场景可以从别处导入，见 BenchExpect）

// ${expires} 比这次运行开始时晚这么久：写记忆的步骤拿它当 valid_to，真实模式或命令行中途断开时，
// 残留的记忆到时候自己过期，不会一直被真实会话召回。重放存的是展开之后的时间，这么久之内都能接着重放
export const BENCH_EXPIRES_AFTER_MS = 6 * 60 * 60_000

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const WHOLE_VARIABLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
const INTEGER = /^-?\d{1,15}$/

// 字符串里的 ${名字} 换成变量的值，没有这个变量的原样留着（正文里可能真的写着这种文字）。
// 整个字符串就是一个 capture 变量、取到的又是整数时按数字代入：expected_version 这类参数要数字。
// ${run} 总是字符串：它可能刚好全是数字，又常拼在 URI 与标识里
export function expand(value: unknown, vars: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    const name = WHOLE_VARIABLE.exec(value)?.[1]
    const whole = name === undefined ? undefined : vars.get(name)
    if (whole !== undefined) return name !== 'run' && INTEGER.test(whole) ? Number(whole) : whole
    return value.replace(VARIABLE, (all, ref: string) => vars.get(ref) ?? all)
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, vars))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, vars)]))
  }
  return value
}

// 值里引用了哪些变量
export function referencedVars(value: unknown): string[] {
  if (typeof value === 'string') return [...value.matchAll(VARIABLE)].map((m) => m[1]!)
  if (Array.isArray(value)) return value.flatMap(referencedVars)
  if (value && typeof value === 'object') return Object.values(value).flatMap(referencedVars)
  return []
}

export function declaredCaptures(steps: readonly BenchStep[]): Set<string> {
  return new Set(steps.flatMap((step) => Object.keys(step.capture ?? {})))
}

// 步骤里 executor 要用的部分：请求的内容
const requestOf = (step: BenchStep): unknown =>
  step.kind === 'tool'
    ? step.arguments
    : step.kind === 'lifecycle' || step.kind === 'recall'
      ? step.body
      : null

function resolve(step: BenchStep, vars: ReadonlyMap<string, string>): BenchStep {
  switch (step.kind) {
    case 'tool':
      return { ...step, arguments: expand(step.arguments, vars) as Record<string, unknown> }
    case 'lifecycle':
    case 'recall':
      return { ...step, body: expand(step.body, vars) }
    default:
      return step
  }
}

function defaultLabel(step: BenchStep): string {
  switch (step.kind) {
    case 'tool':
      return step.tool
    case 'lifecycle': {
      const event = (step.body as { event?: unknown } | null)?.event
      return typeof event === 'string' ? event : '生命周期事件'
    }
    case 'recall':
      return '/recall'
    case 'boot':
      return '/boot'
    case 'whoami':
      return '/whoami'
  }
}

// 不满足 requires 的原因；满足时为 null
export function unmetRequirement(requires: BenchRequires, scopes: KeyScopes): string | null {
  const unreadable = requires.readLayers?.filter((l) => !scopes.readLayers.includes(l)) ?? []
  if (unreadable.length) return `这把 Key 读不了 ${unreadable.join('、')} 层`
  const unwritable = requires.writeLayers?.filter((l) => !scopes.writeLayers.includes(l)) ?? []
  if (unwritable.length) return `这把 Key 写不了 ${unwritable.join('、')} 层`
  const needed = requires.maxSensitivity
  if (needed && SENSITIVITIES.indexOf(scopes.maxSensitivity) < SENSITIVITIES.indexOf(needed)) {
    return `这把 Key 的最高敏感级不到 ${needed}`
  }
  return null
}

const INTERNAL_MESSAGES: Record<BenchInternalDetail, string> = {
  lock_timeout: '服务内部错误：等锁超时',
  statement_timeout: '服务内部错误：语句超时',
  run_timeout: '服务内部错误：运行超过了总时长',
  aborted: '服务内部错误：根事务已中止',
}

// 断言只写它说的是什么，不带实际结果：命令行默认只打印这些，实际结果可能有明文
function check(
  expected: BenchExpect | undefined,
  outcome: StepOutcome,
  vars: ReadonlyMap<string, string>,
): BenchAssertion[] {
  // 内部错误一律算失败，不算「按预期报错」
  if (outcome.internalError) {
    const message = outcome.internalDetail
      ? INTERNAL_MESSAGES[outcome.internalDetail]
      : '服务内部错误'
    return [{ message, ok: false }]
  }
  if (!expected) return []
  const list = (values: string[] | undefined) =>
    (expand(values ?? [], vars) as unknown[]).map(String)
  const assertions: BenchAssertion[] = []
  if (expected.error !== undefined) {
    assertions.push({
      message: expected.error ? '应当报错' : '不应报错',
      ok: outcome.isError === expected.error,
    })
  }
  for (const text of list(expected.contains)) {
    assertions.push({ message: `应包含「${text}」`, ok: outcome.text.includes(text) })
  }
  for (const text of list(expected.notContains)) {
    assertions.push({ message: `不应包含「${text}」`, ok: !outcome.text.includes(text) })
  }
  for (const uri of list(expected.uris)) {
    assertions.push({ message: `URI 列表应有 ${uri}`, ok: outcome.uris.includes(uri) })
  }
  for (const uri of list(expected.notUris)) {
    assertions.push({ message: `URI 列表不应有 ${uri}`, ok: !outcome.uris.includes(uri) })
  }
  return assertions
}

// 按固定前缀取到行尾。结果里有好几处时取第一处：工具结果的元数据在正文前面
export function captureAfter(text: string, prefix: string): string | null {
  const at = text.indexOf(prefix)
  if (at < 0) return null
  const start = at + prefix.length
  const end = text.indexOf('\n', start)
  return text.slice(start, end < 0 ? undefined : end).trim()
}

function capturedValues(capture: BenchCapture | undefined, text: string) {
  const values: Record<string, string> = {}
  const missing: [string, string][] = []
  for (const [name, prefix] of Object.entries(capture ?? {})) {
    const value = captureAfter(text, prefix)
    if (value === null) missing.push([name, prefix])
    else values[name] = value
  }
  return { values, missing }
}

const NOT_RUN = {
  isError: false,
  internalError: false,
  internalDetail: null,
  httpStatus: null,
  text: '',
  raw: null,
  ms: 0,
  uris: [],
  session: null,
  vectorSkipped: false,
  assertions: [],
  captured: {},
  changes: null,
  replay: null,
} satisfies Partial<BenchStepResult>

const STOP_REASONS = {
  aborted: '根事务出错，这一步没有执行',
  timeout: '运行超过了总时长，这一步没有执行',
} as const

export interface RunInput {
  mode: BenchMode
  steps: readonly BenchStep[]
  replay: readonly BenchReplayStep[]
  // 这次运行的标记，${run} 换成它
  run: string
}

export async function runSteps(
  executor: BenchExecutor,
  { mode, steps, replay, run }: RunInput,
): Promise<BenchRunResult> {
  const whoami = await executor.whoami()
  const results: BenchStepResult[] = []
  const vars = new Map([
    ['run', run],
    ['expires', new Date(Date.now() + BENCH_EXPIRES_AFTER_MS).toISOString()],
  ])
  // 前面的步骤声明了、却没有取到的变量：步骤被跳过的，依赖它的也跳过；没取到的，依赖它的算失败
  const unavailable = new Map<string, 'skipped' | 'failed'>()

  const base = (index: number, step: BenchStep) => ({
    index,
    kind: step.kind,
    label: step.label ? String(expand(step.label, vars)) : defaultLabel(step),
  })
  const markCaptures = (step: BenchStep, state: 'skipped' | 'failed') => {
    for (const name of Object.keys(step.capture ?? {})) unavailable.set(name, state)
  }

  // 重放：有步骤报错就停下，当前步骤都不执行，由界面让用户清空或接受
  let replayDiverged: BenchRunResult['replayDiverged'] = null
  for (const [index, step] of replay.entries()) {
    const stop = await executor.stopReason()
    const outcome = stop ? null : await executor.execute(step)
    if (!outcome || outcome.isError) {
      replayDiverged = {
        index,
        text: outcome ? outcome.text : STOP_REASONS[stop!],
        internalError: outcome ? outcome.internalError : true,
      }
      break
    }
  }

  let stop = replayDiverged ? null : await executor.stopReason()
  for (const [index, step] of steps.entries()) {
    const head = base(index, step)
    if (replayDiverged) {
      results.push({
        ...NOT_RUN,
        ...head,
        status: 'notRun',
        reason: `重放的第 ${replayDiverged.index + 1} 步报错，这一步没有执行`,
      })
      continue
    }
    if (stop) {
      results.push({ ...NOT_RUN, ...head, status: 'notRun', reason: STOP_REASONS[stop] })
      continue
    }
    const unmet = step.requires ? unmetRequirement(step.requires, whoami.scopes) : null
    if (unmet) {
      markCaptures(step, 'skipped')
      results.push({ ...NOT_RUN, ...head, status: 'skipped', reason: unmet })
      continue
    }
    const missing = referencedVars([requestOf(step), step.expect])
      .filter((name) => !vars.has(name) && unavailable.has(name))
      .sort((a, b) => stateRank(unavailable.get(a)!) - stateRank(unavailable.get(b)!))[0]
    if (missing !== undefined) {
      if (unavailable.get(missing) === 'skipped') {
        markCaptures(step, 'skipped')
        results.push({
          ...NOT_RUN,
          ...head,
          status: 'skipped',
          reason: `依赖的步骤被跳过（\${${missing}}）`,
        })
      } else {
        markCaptures(step, 'failed')
        results.push({
          ...NOT_RUN,
          ...head,
          status: 'failed',
          reason: null,
          assertions: [{ message: `变量 \${${missing}} 没有取到`, ok: false }],
        })
      }
      continue
    }

    const resolved = resolve(step, vars)
    const started = performance.now()
    let outcome = await executor.execute(resolved)
    const ms = Math.round(performance.now() - started)
    stop = await executor.stopReason()
    // 直接写在 deps.db 上的语句出错时错误可能被吞掉，这一步看起来是成功的
    if (stop === 'aborted' && !outcome.internalError) {
      outcome = { ...outcome, internalError: true, internalDetail: 'aborted' }
    }

    const assertions = check(step.expect, outcome, vars)
    const { values, missing: uncaptured } = capturedValues(step.capture, outcome.text)
    for (const [name, value] of Object.entries(values)) vars.set(name, value)
    for (const [name, prefix] of uncaptured) {
      unavailable.set(name, 'failed')
      assertions.push({ message: `capture ${name}：结果里没有「${prefix}」`, ok: false })
    }
    const failed = outcome.internalError || assertions.some((a) => !a.ok)
    results.push({
      ...head,
      status: failed ? 'failed' : 'passed',
      reason: null,
      isError: outcome.isError,
      internalError: outcome.internalError,
      internalDetail: outcome.internalDetail,
      httpStatus: outcome.httpStatus,
      text: outcome.text,
      raw: outcome.raw,
      ms,
      uris: outcome.uris,
      session: outcome.session,
      vectorSkipped: outcome.vectorSkipped,
      assertions,
      captured: values,
      changes: outcome.changes,
      replay: mode === 'rollback' && !outcome.isError ? replayEntry(resolved) : null,
    })
  }

  const count = (status: BenchStepResult['status']) =>
    results.filter((r) => r.status === status).length
  const counts = {
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    notRun: count('notRun'),
  }
  return {
    run,
    mode,
    ok: !counts.failed && !counts.notRun && !replayDiverged,
    whoami,
    counts,
    steps: results,
    replayDiverged,
  }
}

// 依赖没取到的（失败）优先于依赖被跳过的
const stateRank = (state: 'skipped' | 'failed') => (state === 'failed' ? 0 : 1)

// 这一步要记进重放日志的样子：只记成功的写步骤，参数已经展开
function replayEntry(step: ResolvedStep): BenchReplayStep | null {
  if (!isReplayStep(step)) return null
  const entry =
    step.kind === 'tool'
      ? { kind: step.kind, tool: step.tool, arguments: step.arguments }
      : { kind: step.kind, body: 'body' in step ? step.body : undefined }
  const parsed = BenchReplayStep.safeParse(entry)
  return parsed.success ? parsed.data : null
}
