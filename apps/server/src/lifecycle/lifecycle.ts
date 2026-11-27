import type { HostOutput, LifecycleEventRequest, LifecycleProject } from '@kioku/contracts'

export const PROMPT_SEMANTIC_TIMEOUT_MS = 2_000
export const HOST_CONTEXT_LIMIT: Record<string, number> = {
  claudecode: 9_500,
  codex: 9_500,
  agy: 11_000,
  gemini: 11_000,
  opencode: 11_000,
  pi: 11_000,
}
export const CONTEXT_RESERVE = 2_000

export const GUIDANCE = [
  'Kioku 是你的长期记忆，会话结束后上下文会消失，Kioku 里的不会。',
  '- 回复前先停一秒：这个话题、项目约定或用户偏好，记忆里有没有可能已有记录？不能只等 <recall> 命中才查——用户未提关键词或不确定历史决定与环境约束时，主动用 kioku_search / kioku_browse 查阅；<recall> 与常驻目录只是线索，引用前先用 kioku_get 读正文（长文可先 view="outline" 再按 section 读取）。',
  '- 遇到值得跨会话保留的用户偏好、用户纠正、架构或部署约定、环境踩坑或稳定结论时，当场用 kioku_create 或先 kioku_get 再 kioku_update 记下来，不要等用户点名。',
  '- 写记忆规范：title 保持简短稳定的主题名（建议 ≤24 字），严禁写入日期、版本号或改动日志；summary 用 1–2 句概括当前结论；content 只维护现行有效状态与长期防踩坑原因，不在首行重复标题，不堆砌历史流水账；disclosure 写何时该想起；短期有效的事填 valid_to。',
  '- 修改记忆优先用 kioku_update 的 patch 局部更新以免误删正文，并在 change_summary 写明本次改了什么及原因；需追溯历史变更或决策脉络时调用 kioku_history。',
  '- 每条记忆拥有不可变短 ID（m-xxxxxx），正文可用 [[m-xxxxxx]] 或 [[m-xxxxxx|关联语境]] 建立双链，用 envs / realms / projects / runtimes 标注适用场景；启动加载支持 boot_mode 三档：full 仅放极简跨会话铁律（全文展开）、index 放长篇参考手册（仅常驻摘要目录）、none 按需召回。',
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
