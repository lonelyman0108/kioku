import {
  BenchScenario,
  mayWrite,
  type BenchRunResult,
  type BenchStep,
  type BenchStepResult,
} from '@kioku/contracts'

import { captureMissed, notExecuted, type StepView } from './benchResult'

// 测试台的场景：JSON 的校验与导出、预设按运行时筛、导出前检测明文、运行结果怎么说

export type ParsedScenario = { ok: true; scenario: BenchScenario } | { ok: false; errors: string[] }

// 错误太多时只列前面这些，改完再看后面的
const MAX_ERRORS = 20

function issuePath(path: readonly PropertyKey[]): string {
  const [head, index, ...rest] = path
  if (head === 'steps' && typeof index === 'number') {
    const tail = rest.map(String).join('.')
    return tail ? `第 ${index + 1} 步 ${tail}` : `第 ${index + 1} 步`
  }
  return path.map(String).join('.') || '场景'
}

// 按契约校验文本框或文件里的内容。错误都说清楚在哪：不执行里面的任何东西
export function parseScenario(text: string): ParsedScenario {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`不是合法的 JSON：${(err as Error).message}`] }
  }
  const parsed = BenchScenario.safeParse(raw)
  if (parsed.success) return { ok: true, scenario: parsed.data }
  const errors = parsed.error.issues
    .slice(0, MAX_ERRORS)
    .map((issue) => `${issuePath(issue.path)}：${issue.message}`)
  const more = parsed.error.issues.length - errors.length
  return { ok: false, errors: more > 0 ? [...errors, `还有 ${more} 处，先改上面这些`] : errors }
}

export const formatScenario = (scenario: BenchScenario) => JSON.stringify(scenario, null, 2)

// 文本框里的场景改过：和上次载入的不同。空的没有什么可丢的。只在内存里，换掉或离开页面之前要先问一声
export const scenarioEdited = (text: string, loaded: string) =>
  Boolean(text.trim()) && text !== loaded

// 这个场景不适用于这个运行时的原因；适用时为 null。不给 runtimes 的所有运行时都适用
export function runtimeMismatch(scenario: BenchScenario, runtime: string): string | null {
  const { runtimes } = scenario
  if (!runtimes || runtimes.includes(runtime)) return null
  return `只适用于 ${runtimes.join('、')}，这个应用是 ${runtime}`
}

// 场景里的明文：只看输入，服务端的打码管不到这里。导出的文件是拿来回归的，容易被提交进仓库
export interface PlaintextFinding {
  // 第几步，从 1 算
  step: number
  label: string
  what: string
}

const writesMemory = (tool: string) => tool === 'kioku_create' || tool === 'kioku_update'

const hasVariable = (value: unknown) => typeof value === 'string' && value.includes('${')

// 敏感级写成变量时展开之前判不出来，按 secret 算：多提示一次没有坏处
const secretLevel = (sensitivity: unknown) => sensitivity === 'secret' || hasVariable(sensitivity)

// ${run} 与 ${expires} 一次运行里不变，写法相同就是同一个 URI；capture 的变量展开之前判不出是哪一条
const hasCapture = (uri: string) => /\$\{(?!(?:run|expires)\})/.test(uri)

// 这个场景里哪些 URI 变成过 secret。只看写法、不看执行结果，宁可多提示：移动可能失败，
// 删掉之后可能又建了一条，这里都不区分。kioku_move 的两头算同一条记忆，先移动再改成 secret 也算
function secretUriCheck(steps: readonly BenchStep[]): (uri: string) => boolean {
  const secret = new Set<string>()
  const moves: [string, string][] = []
  for (const step of steps) {
    if (step.kind !== 'tool') continue
    const { uri, sensitivity, from, to } = step.arguments
    if (writesMemory(step.tool) && secretLevel(sensitivity) && typeof uri === 'string') {
      secret.add(uri)
    }
    if (step.tool === 'kioku_move' && typeof from === 'string' && typeof to === 'string') {
      moves.push([from, to])
    }
  }
  const isSecret = (uri: string) =>
    secret.has(uri) || (hasCapture(uri) && secret.size > 0) || [...secret].some(hasCapture)
  // 连续移动时一遍传不完，传到不再变为止
  let grew = true
  while (grew) {
    grew = false
    for (const [from, to] of moves) {
      if (isSecret(from) !== isSecret(to)) {
        secret.add(from)
        secret.add(to)
        grew = true
      }
    }
  }
  return isSecret
}

function plaintextOf(step: BenchStep, isSecret: (uri: string) => boolean): string | null {
  if (step.kind !== 'tool') return null
  const args = step.arguments
  if (step.tool === 'kioku_credential_save') {
    // 值是 null 表示删掉这个字段，里面没有值
    const { values } = args
    if (typeof values !== 'object' || values === null) return null
    const names = Object.entries(values)
      .filter(([, value]) => value !== null)
      .map(([name]) => name)
    return names.length ? `凭据的值（字段 ${names.join('、')}）` : null
  }
  if (!writesMemory(step.tool) || args.content === undefined) return null
  if (secretLevel(args.sensitivity)) return 'secret 级的正文'
  return typeof args.uri === 'string' && isSecret(args.uri)
    ? 'secret 级的正文（这条记忆在别的步骤里是 secret）'
    : null
}

// 导出前检测：kioku_credential_save 的 values 与 secret 级写入的 content。
// 一条记忆变成过 secret，写它的正文都算，不管写在变成 secret 之前还是之后：文件里留着的是每一步的参数
export function plaintextIn(scenario: BenchScenario): PlaintextFinding[] {
  const isSecret = secretUriCheck(scenario.steps)
  return scenario.steps.flatMap((step, index) => {
    const what = plaintextOf(step, isSecret)
    if (!what) return []
    const label = step.label ?? (step.kind === 'tool' ? step.tool : step.kind)
    return [{ step: index + 1, label, what }]
  })
}

// mayWrite 只看字面值：event、chatType 写成变量时展开之前判不出来。命令行执行时按展开后的步骤再判一次，
// 这个确认框是界面上唯一的一次，从严算（event 可能是 turn.end，chatType 可能是私聊、群聊、频道）
function mayWriteOnceExpanded(step: BenchStep): boolean {
  if (mayWrite(step)) return true
  if (step.kind !== 'lifecycle' && step.kind !== 'recall') return false
  const body = step.body as { event?: unknown; context?: { chatType?: unknown } } | null | undefined
  return (
    (step.kind === 'lifecycle' && hasVariable(body?.event)) || hasVariable(body?.context?.chatType)
  )
}

// 真实模式下运行之前，说清楚有几步可能写库
export const writingSteps = (scenario: BenchScenario) =>
  scenario.steps.filter(mayWriteOnceExpanded).length

// 场景这一页显示的那次运行
export interface ScenarioOutcome {
  title: string
  probe: boolean
  result: BenchRunResult
}

export const scenarioView = (scenario: Pick<BenchScenario, 'probe'>): StepView =>
  scenario.probe ? 'probe' : 'judged'

// 打开哪些步骤：要看的是出了问题的那几步。跳过与没有执行的只有一行原因，打开也不占地方。
// 权限探测不判通过与失败，工具报错（被拒绝）是正常的结果，不用打开
export function stepOpen(step: BenchStepResult, view: StepView): boolean {
  if (step.status === 'skipped' || notExecuted(step)) return true
  return view === 'probe' ? step.internalError || captureMissed(step) : step.status === 'failed'
}

export interface RunSummary {
  color: 'success' | 'error' | 'warning' | 'neutral'
  title: string
}

// 一次运行的结论。权限探测不判通过与失败；全部跳过不能说成通过
export function runSummary(result: BenchRunResult, view: StepView): RunSummary {
  const { passed, failed, skipped, notRun } = result.counts
  if (result.replayDiverged) {
    return {
      color: 'error',
      title: `重放的第 ${result.replayDiverged.index + 1} 步报错，这次的步骤都没有执行`,
    }
  }
  if (view === 'probe') {
    const count = (matches: (step: BenchStepResult) => boolean) =>
      result.steps.filter(matches).length
    const internal = count((s) => s.internalError)
    const unsent = count(notExecuted)
    const uncaptured = count(captureMissed)
    const notes = [
      `共 ${result.steps.length} 步`,
      ...(skipped ? [`跳过 ${skipped} 步`] : []),
      ...(unsent ? [`没有执行 ${unsent} 步`] : []),
      ...(uncaptured ? [`capture 没取到 ${uncaptured} 步`] : []),
      ...(internal ? [`内部错误 ${internal} 步`] : []),
    ]
    return {
      color: unsent || uncaptured || internal ? 'warning' : 'neutral',
      title: `只列结果，不判通过与失败：每把 Key 的正确结果都不同。${notes.join('，')}`,
    }
  }
  if (!result.ok) {
    return {
      color: 'error',
      title: `有失败：通过 ${passed}，失败 ${failed}，跳过 ${skipped}，没有执行 ${notRun}`,
    }
  }
  if (!passed && skipped) {
    return { color: 'neutral', title: `全部跳过（${skipped} 步）：这把 Key 不满足这个场景要的权限` }
  }
  return {
    color: 'success',
    title: skipped ? `全部通过：通过 ${passed}，跳过 ${skipped}` : `全部通过：通过 ${passed}`,
  }
}
