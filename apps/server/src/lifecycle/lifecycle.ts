import type {
  HostOutput,
  LifecycleEvent,
  LifecycleProject,
  LifecycleResponse,
} from '@kioku/contracts'

import { formatBootBlock, formatRecentBlock } from '../recall/boot'
import { formatRecallBlock } from '../recall/recall'
import type { RecallScope } from './scope'

const RECENT_LIMIT = 5
const PROJECT_RECALL_LIMIT = 5

// 目录名与仓库名去重后拼成一句查询，用来召回与当前项目相关的记忆
function projectQuery(project: LifecycleProject | undefined): string {
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

// 服务端下发的使用指引：插件里不放任何提示词，服务端改了指引所有接入方立即生效
export const GUIDANCE = [
  'Kioku 是你的长期记忆，会话结束后上下文会消失，Kioku 里的不会。',
  '- 每轮回复前留意 <recall> 候选：它只是线索，引用前先用 kioku_get 读正文。',
  '- 用户透露了重要的新信息、纠正了你、或你得出了值得长期保留的结论时，用 kioku_create / kioku_update 记下来，正文写清背景和适用条件，disclosure 写清什么场景下该想起。',
  '- 记忆之间冲突时，以 priority 数字更小的为准，同时考虑适用范围、时间与用户当前的指令。',
].join('\n')

// 每种宿主期望的输出形状不同，由服务端决定，插件原样转交
function hostOutput(
  runtimeFamily: string,
  event: LifecycleEvent['event'],
  context: string,
): HostOutput {
  if (!context.trim()) return { mode: 'none', value: null }
  const hookEventName = event === 'session.start' ? 'SessionStart' : 'UserPromptSubmit'
  switch (runtimeFamily) {
    case 'claudecode':
      // Claude Code 的 UserPromptSubmit 钩子把标准输出的纯文本直接当作附加上下文
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
    default:
      return { mode: 'return_value', value: { context } }
  }
}

export async function handleLifecycle(
  scope: RecallScope,
  runtimeFamily: string,
  input: LifecycleEvent,
): Promise<LifecycleResponse> {
  if (input.event === 'session.start') {
    const query = projectQuery(input.project)
    const [result, recent, related] = await Promise.all([
      scope.boot(),
      scope.recent(RECENT_LIMIT),
      query ? scope.recall(query, { limit: PROJECT_RECALL_LIMIT }) : Promise.resolve([]),
    ])
    // 已经在 boot 里展开的节点不再重复列出
    const booted = new Set(result.entries.map((e) => e.uri))
    const relatedNew = related.filter((c) => !booted.has(c.uri))
    const relatedBlock = formatRecallBlock(relatedNew, input.sessionId)
    const context = [
      formatBootBlock(result, GUIDANCE),
      formatRecentBlock(recent.filter((m) => !booted.has(m.uri))),
      relatedBlock && `与当前项目相关的记忆，需要时用 kioku_get 读取：\n${relatedBlock}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    return {
      hostOutput: hostOutput(runtimeFamily, input.event, context),
      nodeUris: [...booted, ...relatedNew.map((c) => c.uri)],
    }
  }

  const candidates = await scope.recall(input.prompt, { limit: 8 })
  return {
    hostOutput: hostOutput(
      runtimeFamily,
      input.event,
      formatRecallBlock(candidates, input.sessionId),
    ),
    nodeUris: candidates.map((c) => c.uri),
  }
}
