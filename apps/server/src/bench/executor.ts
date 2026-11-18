import type {
  BenchChanges,
  BenchInternalDetail,
  BenchReplayStep,
  BenchSessionStart,
  BenchStep,
  BootResponse,
  HostOutput,
  LifecycleResponse,
  RecallResponse,
  WhoAmI,
} from '@kioku/contracts'

import { TOOL_INTERNAL_ERROR } from '../mcp/format'

// 步骤的执行方式：进程内（见 inProcess.ts）与真实 HTTP（见 httpExecutor.ts）共用这个接口，
// 同一份场景在两边跑。这个文件不碰数据库：命令行只用得到 HTTP 这一边，不用加载服务端的那些代码

// ${run} 与 capture 都展开之后的步骤
export type ResolvedStep = BenchStep | BenchReplayStep

export interface StepOutcome {
  isError: boolean
  internalError: boolean
  internalDetail: BenchInternalDetail | null
  httpStatus: number | null
  text: string
  raw: unknown
  // 结果里的短 ID 列表。null 表示这种结果分不清，shortIds 与 notShortIds 断言直接算失败，不能当成「没有」
  shortIds: string[] | null
  session: BenchSessionStart | null
  vectorSkipped: boolean
  changes: BenchChanges | null
}

export interface BenchExecutor {
  whoami(): Promise<WhoAmI>
  // replaying：这一步是重放的，结果不返回，不用列改动
  execute(step: ResolvedStep, options?: { replaying: boolean }): Promise<StepOutcome>
  // 重放全部成功之后调一次：第一个真实步骤的改动不含重放的写入。只有回滚模式有重放
  replayDone(): Promise<void>
  // 后面的步骤还能不能执行：aborted 是根事务已中止，timeout 是超过了总时长。只有回滚模式会停
  stopReason(): Promise<'aborted' | 'timeout' | null>
}

const OUTCOME_DEFAULTS = {
  internalDetail: null,
  session: null,
  vectorSkipped: false,
  changes: null,
} as const

// 工具结果里的结构行（见 mcp/format.ts 与 formatRecallBlock）。正则是写死的，不接受场景给的模式
const ENTRY_ID_LINE = /^ID: (m-[2-9a-hjkmnp-tv-z]{6,8})$/
const BROWSE_ROW =
  /^- (m-[2-9a-hjkmnp-tv-z]{6,8})(?:「[^」\n]*」)?(?:\s+\[[^\n\]]+\])?（(?:entry|fact|episode)，(?:public|internal|private|secret)，priority -?\d+/
const RECALL_ROW =
  /^\d+\.\d+ \| (m-[2-9a-hjkmnp-tv-z]{6,8})(?:「[^」\n]*」)?(?:\s+\[[^\n\]]+\])?(?:\s+\[其他群印象\])?(?: \| |$)/

const shortIdsIn = (lines: readonly string[], row: RegExp) =>
  lines.flatMap((line) => {
    const id = row.exec(line)?.[1]
    return id === undefined ? [] : [id]
  })

// 结果里的短 ID，按工具只看结构行：正文是任意文字，可能写着和结构行一样的内容，扫全文会把它们也算进去
function toolShortIds(tool: string, text: string): string[] | null {
  const lines = text.split('\n')
  switch (tool) {
    // 词条视图：第一行可能是重定向提示，按有没有提示取对应那一行
    case 'kioku_get':
    case 'kioku_create':
    case 'kioku_update':
    case 'kioku_transfer': {
      const idLine = lines[0]?.startsWith('提示: ') ? lines[1] : lines[0]
      return idLine === undefined ? [] : shortIdsIn([idLine], ENTRY_ID_LINE)
    }
    case 'kioku_browse':
      return shortIdsIn(lines, BROWSE_ROW)
    case 'kioku_search':
      return shortIdsIn(lines, RECALL_ROW)
    // 标题（「## …」）和正文写法相同，分不清哪些是词条。要看启动词条用 boot 步骤，它有结构化的 entries
    case 'kioku_boot':
      return null
    default:
      return []
  }
}

// tools/call 响应里的 result
export interface ToolResult {
  content?: unknown
  isError?: unknown
}

// 工具的结果。内部错误按固定文字认，进程内和 HTTP 都能用
export function toolOutcome(tool: string, result: ToolResult): StepOutcome {
  const content = Array.isArray(result.content)
    ? (result.content as { type?: string; text?: string }[])
    : []
  const text = content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n')
  const isError = result.isError === true
  return {
    ...OUTCOME_DEFAULTS,
    isError,
    internalError: isError && text === TOOL_INTERNAL_ERROR,
    httpStatus: null,
    text,
    raw: result,
    shortIds: isError ? [] : toolShortIds(tool, text),
  }
}

// REST 的错误：状态码与 { error }。500 算内部错误
export function restFailure(status: number, message: string): StepOutcome {
  return {
    ...OUTCOME_DEFAULTS,
    isError: true,
    internalError: status >= 500,
    httpStatus: status,
    text: message,
    raw: { error: message },
    shortIds: [],
  }
}

// 宿主拿到的文字，规则和插件一致（stdout_json 支持 additionalContext 与 Antigravity 的 injectSteps），return_value 取 context
export function hostText(output: HostOutput): string {
  const value = output.value as {
    hookSpecificOutput?: { additionalContext?: unknown }
    injectSteps?: { systemMessage?: { systemMessage?: unknown } }[]
    context?: unknown
  } | null
  const text =
    output.mode === 'stdout_json'
      ? (value?.hookSpecificOutput?.additionalContext ??
        value?.injectSteps
          ?.map((step) => step?.systemMessage?.systemMessage)
          .filter((msg): msg is string => typeof msg === 'string' && msg.length > 0)
          .join('\n\n'))
      : output.mode === 'stdout_text'
        ? output.value
        : output.mode === 'return_value'
          ? value?.context
          : ''
  return typeof text === 'string' ? text : ''
}

// REST 成功的结果：生命周期事件的文字是交给宿主的那段，别的是格式化的 JSON
export function restSuccess(kind: ResolvedStep['kind'], raw: unknown): StepOutcome {
  const base = {
    ...OUTCOME_DEFAULTS,
    isError: false,
    internalError: false,
    httpStatus: 200,
    raw,
  }
  const json = JSON.stringify(raw, null, 2)
  switch (kind) {
    case 'lifecycle': {
      // 进程内多带的那几项单独放，原始响应和真实接口的相同
      const { session, ...response } = raw as LifecycleResponse & { session?: BenchSessionStart }
      return {
        ...base,
        raw: response,
        text: hostText(response.hostOutput),
        shortIds: response.shortIds,
        session: session ?? null,
      }
    }
    case 'recall':
      return {
        ...base,
        text: json,
        shortIds: (raw as RecallResponse).candidates.map((c) => c.shortId),
      }
    case 'boot':
      return {
        ...base,
        text: json,
        shortIds: (raw as BootResponse).entries.map((e) => e.shortId),
      }
    default:
      return { ...base, text: json, shortIds: [] }
  }
}
