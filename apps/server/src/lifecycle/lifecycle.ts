import type { HostOutput, LifecycleEventRequest, LifecycleProject } from '@kioku/contracts'

export const PROMPT_SEMANTIC_TIMEOUT_MS = 2_000
export const HOST_CONTEXT_LIMIT: Record<string, number> = { claudecode: 9_500, codex: 9_500 }
export const CONTEXT_RESERVE = 2_000

export const GUIDANCE = [
  'Kioku 是你的长期记忆，会话结束后上下文会消失，Kioku 里的不会。',
  '- 回复前先停一秒：这个话题、项目约定或用户偏好，记忆里有没有可能已有记录？不能只等 <recall> 命中才查——用户未提关键词或不确定历史决定与环境约束时，主动用 kioku_search / kioku_browse 查阅；<recall> 只是线索，引用前先用 kioku_get 读正文。',
  '- 遇到值得跨会话保留的用户偏好、用户纠正、架构或部署约定、环境踩坑或稳定结论时，当场用 kioku_create 或先 kioku_get 再 kioku_update 记下来，不要等用户点名。',
  '- 写记忆时正文写清背景与适用条件，disclosure 写清什么场景下该想起；短期有效的事填 valid_to，到期后自动退出召回。',
  '- 每条记忆拥有不可变短 ID（m-xxxxxx），正文可用 [[m-xxxxxx]] 建立双链，用 envs / realms / projects / runtimes 标注适用场景，用 is_pinned 标记常驻启动加载。',
  '- 严禁把明文密码、API Key 或令牌写进记忆正文；需要引用凭据时先用 kioku_list_credentials 查可用标识，正文只写 {{cred:<标识>}}，执行命令时通过 `kioku run --purpose "<用途>" -e 变量=<标识> -- <命令>` 安全注入环境变量。',
].join('\n')

export function projectQuery(project: LifecycleProject | undefined): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const value of [project?.dirName, project?.repoName]) {
    const text = value?.trim()
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    parts.push(text)
  }
  return parts.join(' ')
}

export function hostOutput(
  runtimeFamily: string,
  event: LifecycleEventRequest['event'],
  context: string,
): HostOutput {
  if (!context.trim()) return { mode: 'none', value: null }
  const hookEventName = event === 'session.start' ? 'SessionStart' : 'UserPromptSubmit'
  switch (runtimeFamily) {
    case 'claudecode':
      return event === 'session.start'
        ? {
            mode: 'stdout_json',
            value: { hookSpecificOutput: { hookEventName, additionalContext: context } },
          }
        : { mode: 'stdout_text', value: context }
    case 'codex':
      return {
        mode: 'stdout_json',
        value: { hookSpecificOutput: { hookEventName, additionalContext: context } },
      }
    case 'gemini':
      return {
        mode: 'stdout_json',
        value: {
          hookSpecificOutput: {
            hookEventName: event === 'session.start' ? 'SessionStart' : 'BeforeAgent',
            additionalContext: context,
          },
        },
      }
    case 'agy':
      return {
        mode: 'stdout_json',
        value: { injectSteps: [{ systemMessage: { systemMessage: context } }] },
      }
    default:
      return { mode: 'return_value', value: { context } }
  }
}
