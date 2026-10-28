import type {
  HostOutput,
  LifecycleEvent,
  LifecycleProject,
  LifecycleResponse,
} from '@kioku/contracts'

import { BOOT_LAYERS, formatBootBlock, formatRecentBlock } from '../recall/boot'
import { formatRecallBlock } from '../recall/recall'
import type { RecallScope } from './scope'

const RECENT_LIMIT = 5
const PROJECT_RECALL_LIMIT = 5
// 每轮召回等嵌入接口的上限：插件的钩子 5 秒就放弃，要给全文与关键词留出时间
const PROMPT_SEMANTIC_TIMEOUT_MS = 2_000
// 宿主能完整接收的上下文长度。Claude Code 的钩子输出超过 1 万字时只给模型看开头 2KB 的预览，
// 其余写进文件、要模型自己去读，所以留出余量，boot 按剩下的字数收，后面的附加块放不下就不放
const HOST_CONTEXT_LIMIT: Record<string, number> = { claudecode: 9_500, codex: 9_500 }
// 给近期记忆、项目召回和 boot 的标题、未展开列表留的字数
const CONTEXT_RESERVE = 2_000

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
  '- 正文里的 {{cred:<标识>#<字段>}} 是凭据占位符：用到时才用 kioku_credential 取值，不要把值写回记忆，也不要显示在回复里。',
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
    const limit = HOST_CONTEXT_LIMIT[runtimeFamily]
    const result = await scope.boot(
      limit ? Math.max(limit - GUIDANCE.length - CONTEXT_RESERVE, 1_000) : undefined,
    )
    // 已经在 boot 里展开的节点不再重复列出；多取几条，去掉它们之后仍能凑够
    const booted = new Set(result.entries.map((e) => e.uri))
    const query = projectQuery(input.project)
    // 近期记忆与项目召回只是附加线索，各自失败都不影响 boot。项目召回不等嵌入接口（只走全文与关键词），
    // 过滤也和 boot 一样（受信来源、boot 的那几层）：它不需要用户提到任何东西就会注入
    const [recent, related] = await Promise.allSettled([
      scope.recent(RECENT_LIMIT + booted.size),
      query
        ? scope.recall(query, {
            limit: PROJECT_RECALL_LIMIT + booted.size,
            semantic: false,
            trustedOnly: true,
            layers: BOOT_LAYERS,
          })
        : Promise.resolve([]),
    ])
    for (const r of [recent, related]) {
      if (r.status === 'rejected') console.warn('会话开始时附加的记忆读取失败', r.reason)
    }
    const recentList = (recent.status === 'fulfilled' ? recent.value : [])
      .filter((m) => !booted.has(m.uri))
      .slice(0, RECENT_LIMIT)
    const relatedList = (related.status === 'fulfilled' ? related.value : [])
      .filter((c) => !booted.has(c.uri))
      .slice(0, PROJECT_RECALL_LIMIT)
    const relatedBlock = formatRecallBlock(relatedList, input.sessionId)

    const parts = [formatBootBlock(result, GUIDANCE)]
    const extras = [
      formatRecentBlock(recentList),
      relatedBlock && `与当前项目相关的记忆，需要时用 kioku_get 读取：\n${relatedBlock}`,
    ]
    for (const extra of extras) {
      if (!extra) continue
      if (limit && [...parts, extra].join('\n\n').length > limit) continue
      parts.push(extra)
    }
    return {
      hostOutput: hostOutput(runtimeFamily, input.event, parts.join('\n\n')),
      nodeUris: [...booted, ...relatedList.map((c) => c.uri)],
    }
  }

  const candidates = await scope.recall(input.prompt, {
    limit: 8,
    semanticTimeoutMs: PROMPT_SEMANTIC_TIMEOUT_MS,
  })
  return {
    hostOutput: hostOutput(
      runtimeFamily,
      input.event,
      formatRecallBlock(candidates, input.sessionId),
    ),
    nodeUris: candidates.map((c) => c.uri),
  }
}
