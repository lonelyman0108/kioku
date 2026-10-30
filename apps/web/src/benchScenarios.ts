import {
  BenchScenario,
  mayWrite,
  type BenchRunResult,
  type BenchStep,
  type BenchStepResult,
} from '@kioku/contracts'

import type { StepView } from './benchResult'

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

const hasVariable = (value: string) => value.includes('${')

function plaintextOf(step: BenchStep): string | null {
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
  if (step.tool !== 'kioku_create' && step.tool !== 'kioku_update') return null
  const { sensitivity, content } = args
  // 敏感级写成变量时展开之前判不出来，按 secret 算：多提示一次没有坏处
  const secret =
    sensitivity === 'secret' || (typeof sensitivity === 'string' && hasVariable(sensitivity))
  return secret && content !== undefined ? 'secret 级的正文' : null
}

// 导出前检测：kioku_credential_save 的 values 与 secret 级写入的 content
export function plaintextIn(scenario: BenchScenario): PlaintextFinding[] {
  return scenario.steps.flatMap((step, index) => {
    const what = plaintextOf(step)
    if (!what) return []
    const label = step.label ?? (step.kind === 'tool' ? step.tool : step.kind)
    return [{ step: index + 1, label, what }]
  })
}

// 真实模式下运行之前，说清楚有几步可能写库（判定和命令行的 --allow-writes 是同一个）
export const writingSteps = (scenario: BenchScenario) => scenario.steps.filter(mayWrite).length

export const scenarioView = (scenario: Pick<BenchScenario, 'probe'>): StepView =>
  scenario.probe ? 'probe' : 'judged'

// 打开哪些步骤：要看的是出了问题的那几步
export function stepOpen(step: BenchStepResult, view: StepView): boolean {
  if (view === 'probe') return step.internalError
  return step.status === 'failed' || step.status === 'notRun'
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
    const internal = result.steps.filter((s) => s.internalError).length
    const notes = [
      `共 ${result.steps.length} 步`,
      ...(skipped ? [`跳过 ${skipped} 步`] : []),
      ...(notRun ? [`没有执行 ${notRun} 步`] : []),
      ...(internal ? [`内部错误 ${internal} 步`] : []),
    ]
    return {
      color: notRun || internal ? 'warning' : 'neutral',
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
