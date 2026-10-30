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
  // 结果里的 URI 列表。null 表示这种结果分不清，uris 与 notUris 断言直接算失败，不能当成「没有」
  uris: string[] | null
  session: BenchSessionStart | null
  vectorSkipped: boolean
  changes: BenchChanges | null
}

export interface BenchExecutor {
  whoami(): Promise<WhoAmI>
  execute(step: ResolvedStep): Promise<StepOutcome>
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
const MEMORY_URI_LINE = /^URI: ([a-z][a-z0-9_]*:\/\/[a-z0-9_/-]+)$/
const CHILD_ROW =
  /^- ([a-z][a-z0-9_]*:\/\/[a-z0-9_/-]+)（(?:路径本身没有记忆|[a-z]+，priority -?\d+)(?:，\d+ 个子节点)?）/
const RECALL_ROW = /^\d+\.\d+ \| ([a-z][a-z0-9_]*:\/\/[a-z0-9_/-]+)(?: \| |$)/

const urisIn = (lines: readonly string[], row: RegExp) =>
  lines.flatMap((line) => {
    const uri = row.exec(line)?.[1]
    return uri === undefined ? [] : [uri]
  })

// 结果里的 URI，按工具只看结构行：正文是任意文字，可能写着和结构行一样的内容，扫全文会把它们也算进去
function toolUris(tool: string, text: string): string[] | null {
  const lines = text.split('\n')
  switch (tool) {
    // 记忆视图：元数据在正文前面，第一行就是 URI
    case 'kioku_get':
    case 'kioku_create':
    case 'kioku_update':
    case 'kioku_move':
      return urisIn(lines.slice(0, 1), MEMORY_URI_LINE)
    // 父节点的视图在列表前面，正文里也可能写着「子节点：」，所以从最后一个算起。
    // 子节点的 disclosure 可以多行，里面写成这些行的样子时分不出来
    case 'kioku_list': {
      const head = lines.findLastIndex((line) => line === '子节点：' || line === '子节点：无')
      return head < 0 ? [] : urisIn(lines.slice(head + 1), CHILD_ROW)
    }
    // 整个结果就是 <recall> 块，线索都压成了单行
    case 'kioku_search':
      return urisIn(lines, RECALL_ROW)
    // 标题（「## …」）和正文写法相同，分不清哪些是节点。要看启动节点用 /boot 步骤，它有结构化的 entries
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
    uris: isError ? [] : toolUris(tool, text),
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
    uris: [],
  }
}

// 宿主拿到的文字，规则和插件一样（plugins/claude-code/hooks/forward.mjs），return_value 取 context
export function hostText(output: HostOutput): string {
  const value = output.value as {
    hookSpecificOutput?: { additionalContext?: unknown }
    context?: unknown
  } | null
  const text =
    output.mode === 'stdout_json'
      ? value?.hookSpecificOutput?.additionalContext
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
        uris: response.nodeUris,
        session: session ?? null,
      }
    }
    case 'recall':
      return { ...base, text: json, uris: (raw as RecallResponse).candidates.map((c) => c.uri) }
    case 'boot':
      return { ...base, text: json, uris: (raw as BootResponse).entries.map((e) => e.uri) }
    default:
      return { ...base, text: json, uris: [] }
  }
}
