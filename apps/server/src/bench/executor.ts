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
// 同一份场景在两边跑。这里的文件不碰数据库：命令行只用得到 HTTP 这一边

// ${run} 与 capture 都展开之后的步骤
export type ResolvedStep = BenchStep | BenchReplayStep

export interface StepOutcome {
  isError: boolean
  internalError: boolean
  internalDetail: BenchInternalDetail | null
  httpStatus: number | null
  text: string
  raw: unknown
  uris: string[]
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

// 工具结果里的 URI：kioku_get 等的「URI: …」、kioku_list 的「- …（」、kioku_search 的「0.59 | …」。
// 这个正则是写死的，不接受场景给的模式
const TOOL_URI = /^(?:URI: |- |\d+\.\d+ \| )([a-z][a-z0-9_]*:\/\/[a-z0-9_/-]+)/gm

// 工具的结果：result 是 tools/call 响应里的 result。内部错误按固定文字认，进程内和 HTTP 都能用
export function toolOutcome(result: { content?: unknown; isError?: unknown }): StepOutcome {
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
    uris: [...text.matchAll(TOOL_URI)].map((m) => m[1]!),
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
