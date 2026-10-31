import { z } from 'zod'

import { Layer, Sensitivity } from './memory'

export const RECALL_VIAS = ['semantic', 'fulltext', 'glossary'] as const
export const RecallVia = z.enum(RECALL_VIAS).meta({ id: 'RecallVia' })
export type RecallVia = z.infer<typeof RecallVia>

export const RecallCandidate = z
  .object({
    uri: z.string(),
    layer: Layer,
    priority: z.number().int(),
    disclosure: z.string().nullable(),
    score: z.number(),
    via: z.array(RecallVia),
    // 命中的 glossary 关键词，展示给模型作为线索
    cues: z.array(z.string()),
  })
  .meta({ id: 'RecallCandidate' })
export type RecallCandidate = z.infer<typeof RecallCandidate>

// 各路的得分，调试台用：相似度与全文都已压到 0–1，关键词与 priority 是加上去的分
export const RecallBreakdown = z.object({
  semantic: z.number(),
  fulltext: z.number(),
  glossary: z.number(),
  priority: z.number(),
})
export type RecallBreakdown = z.infer<typeof RecallBreakdown>

export const DebugCandidate = RecallCandidate.extend({ breakdown: RecallBreakdown })
export type DebugCandidate = z.infer<typeof DebugCandidate>

// 会话上下文：由接入方（插件）上报，只能收紧权限、不能放宽。平台账号原样上报，
// 服务端按平台、种类（人或群）与账号解析成对象，没见过的就新建
export const CHAT_TYPES = ['direct', 'group', 'channel', 'cron', 'subagent'] as const
export const ChatType = z.enum(CHAT_TYPES).meta({ id: 'ChatType' })
export type ChatType = z.infer<typeof ChatType>

export const PlatformRef = z
  .object({
    id: z.string().trim().min(1).max(200),
    // 平台上的显示名，随上报更新；空字符串当作没带。服务端只记前 128 个字，这里只拒绝离谱的长度
    // （上限按 UTF-16 码元算，放得很宽）：名字长导致整个请求被拒的话，插件只能放弃这一轮的召回
    name: z.string().trim().max(4000).optional(),
  })
  .meta({ id: 'PlatformRef' })
export type PlatformRef = z.infer<typeof PlatformRef>

export const SessionContextInput = z
  .object({
    chatType: ChatType,
    // 平台标识，例如 qq、telegram；带了群或发言人时必填。同一个人在不同平台的账号由管理界面合并
    platform: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_.-]{0,31}$/, '平台标识只能包含小写字母、数字和 _.-')
      .optional(),
    // 群聊、频道里必填；别的会话不看
    group: PlatformRef.optional(),
    // 私聊里必填；群聊、频道里是这次发言的人，可以不带；定时任务与子 agent 不看
    sender: PlatformRef.optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.chatType === 'group' || c.chatType === 'channel') && !c.group) {
      ctx.addIssue({ code: 'custom', path: ['group'], message: '群聊与频道须带上群' })
    }
    if (c.chatType === 'direct' && !c.sender) {
      ctx.addIssue({ code: 'custom', path: ['sender'], message: '私聊须带上发言人' })
    }
    if ((c.group || c.sender) && !c.platform) {
      ctx.addIssue({ code: 'custom', path: ['platform'], message: '带群或发言人时须带上平台' })
    }
  })
  .meta({ id: 'SessionContext' })
export type SessionContextInput = z.infer<typeof SessionContextInput>

export const RecallRequest = z
  .object({
    query: z.string().min(1).max(4000),
    limit: z.number().int().min(1).max(50).default(8),
    context: SessionContextInput.optional(),
  })
  .meta({ id: 'RecallRequest' })
export type RecallRequest = z.infer<typeof RecallRequest>

// 对象直连：当前发言人与本群的对象层里抽取的事实，不看查询，直接带正文（抽取的事实没有 URI）。
// 只在带了会话上下文时有；事实来自对话，可能是别人写进来的，只能当参考资料
export const SubjectFacts = z
  .object({
    // sender：当前发言人；group：本群
    role: z.enum(['sender', 'group']),
    // 平台上的名字；不知道时为 null（不拿平台账号凑数）
    name: z.string().nullable(),
    facts: z.array(z.object({ content: z.string(), updatedAt: z.string() })),
  })
  .meta({ id: 'SubjectFacts' })
export type SubjectFacts = z.infer<typeof SubjectFacts>

export const RecallResponse = z
  .object({
    candidates: z.array(RecallCandidate),
    subjects: z.array(SubjectFacts),
  })
  .meta({ id: 'RecallResponse' })
export type RecallResponse = z.infer<typeof RecallResponse>

// 最近更新的策展记忆：只有 URI 与 disclosure，不含正文，会话开始时列给模型
export const RecentMemory = z.object({
  uri: z.string(),
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  updatedAt: z.string(),
})
export type RecentMemory = z.infer<typeof RecentMemory>

export const BootEntry = z
  .object({ uri: z.string(), layer: Layer, content: z.string() })
  .meta({ id: 'BootEntry' })
export const BootResponse = z
  .object({
    entries: z.array(BootEntry),
    // 超出字数预算没放进来的节点，模型可以按需用 kioku_get 读取
    omitted: z.array(z.string()),
  })
  .meta({ id: 'BootResponse' })
export type BootResponse = z.infer<typeof BootResponse>

export const LIFECYCLE_EVENTS = ['session.start', 'prompt.submit', 'turn.end'] as const
export const LifecycleEventName = z.enum(LIFECYCLE_EVENTS)

// 宿主当前所在的项目：目录名与 git 仓库名。会话开始时用它们召回与当前项目相关的记忆
export const LifecycleProject = z
  .object({
    dirName: z.string().max(128).optional(),
    repoName: z.string().max(128).optional(),
  })
  .meta({ id: 'LifecycleProject' })
export type LifecycleProject = z.infer<typeof LifecycleProject>

export const SessionStartEvent = z
  .object({
    event: z.literal('session.start'),
    sessionId: z.string().max(200).optional(),
    context: SessionContextInput.optional(),
    project: LifecycleProject.optional(),
  })
  .meta({ id: 'SessionStartEvent' })

export const PromptSubmitEvent = z
  .object({
    event: z.literal('prompt.submit'),
    sessionId: z.string().max(200).optional(),
    context: SessionContextInput.optional(),
    prompt: z.string().min(1).max(20_000),
  })
  .meta({ id: 'PromptSubmitEvent' })

// 一轮对话结束：用户说的话与 bot 的回复进会话缓冲，攒批之后由后台任务抽取。只缓冲私聊、群聊与频道，
// 群里要带上这一轮的发言人（事实要记到人身上）
export const TurnEndEvent = z
  .object({
    event: z.literal('turn.end'),
    // 缓冲按应用与会话分，插件用宿主的会话标识（例如 AstrBot 的 unified_msg_origin）
    sessionId: z.string().min(1).max(200),
    context: SessionContextInput,
    user: z.string().min(1).max(20_000),
    reply: z.string().max(20_000),
  })
  .superRefine((e, ctx) => {
    if (e.context.chatType === 'cron' || e.context.chatType === 'subagent') {
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'chatType'],
        message: '只缓冲私聊、群聊与频道的对话',
      })
    }
    if ((e.context.chatType === 'group' || e.context.chatType === 'channel') && !e.context.sender) {
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'sender'],
        message: '群聊与频道须带上本轮的发言人',
      })
    }
  })
  .meta({ id: 'TurnEndEvent' })

// 按事件区分字段：prompt.submit 缺 prompt 时直接 400，不让插件的字段错误变成悄无声息的「没有召回」
export const LifecycleEvent = z.discriminatedUnion('event', [
  SessionStartEvent,
  PromptSubmitEvent,
  TurnEndEvent,
])
export type LifecycleEvent = z.infer<typeof LifecycleEvent>
export type TurnEndEvent = z.infer<typeof TurnEndEvent>

export const HostOutput = z
  .object({
    // stdout_json / stdout_text：插件原样写到标准输出；return_value：插件把 value 交给宿主 API
    mode: z.enum(['none', 'stdout_json', 'stdout_text', 'return_value']),
    value: z.unknown(),
  })
  .meta({ id: 'HostOutput' })
export type HostOutput = z.infer<typeof HostOutput>

export const LifecycleResponse = z
  .object({
    hostOutput: HostOutput,
    nodeUris: z.array(z.string()),
  })
  .meta({ id: 'LifecycleResponse' })
export type LifecycleResponse = z.infer<typeof LifecycleResponse>

// 一条记忆这次读不到的原因：deleted、expired 已删除或失效；layer 层不在可读范围；sensitivity 超出最高敏感级；
// secret 只能按 URI 显式读取；origin 来源作用域不在范围；owner 别的成员的画像或私人层；persona 不在人格继承链上；
// app 别的应用的应用层；override 被继承链上更近的人格同一相对路径的节点覆盖
export const READ_DENIALS = [
  'deleted',
  'expired',
  'layer',
  'sensitivity',
  'secret',
  'origin',
  'owner',
  'persona',
  'app',
  'override',
] as const
export const ReadDenial = z.enum(READ_DENIALS)
export type ReadDenial = z.infer<typeof ReadDenial>

export const RecallDebugRequest = z.object({ query: z.string().trim().min(1).max(4000) })
export type RecallDebugRequest = z.infer<typeof RecallDebugRequest>

// 召回调试台：按一把 Key 模拟每轮输入时的召回
export const RecallDebug = z.object({
  // 会注入的：和每轮输入时一样，过了阈值的前几条
  injected: z.array(DebugCandidate),
  // 没注入的：没过阈值或排在后面的
  others: z.array(DebugCandidate),
  minScore: z.number(),
  // 注入的 <recall> 块，原样就是宿主收到的文字
  block: z.string(),
  // 这次有没有走向量这一路（嵌入接口没配、出错或超时时没有）
  semantic: z.boolean(),
  // 管理界面里搜得到、这把 Key 却读不到的记忆，以及原因
  filtered: z.array(
    z.object({ uri: z.string(), layer: Layer, sensitivity: Sensitivity, reason: ReadDenial }),
  ),
})
export type RecallDebug = z.infer<typeof RecallDebug>

export const BootPreviewRequest = z.object({
  project: LifecycleProject.optional(),
  // 会话 id 会写进召回块：不给时用一个随机的 UUID，长度和真实会话差不多，临近字数上限时预览才准
  sessionId: z.string().max(200).optional(),
})
export type BootPreviewRequest = z.infer<typeof BootPreviewRequest>

// 启动预览：按一把 Key 模拟会话开始时注入的内容
export const BootPreview = z.object({
  runtimeFamily: z.string(),
  // 宿主能完整接收的字数；没有限制的宿主为 null
  limit: z.number().int().nullable(),
  // 原样就是宿主收到的文字
  context: z.string(),
  // 展开的启动节点与各自占的字数（含标题）
  entries: z.array(z.object({ uri: z.string(), layer: Layer, chars: z.number().int() })),
  // 超出预算、只列出 URI 的启动节点
  omitted: z.array(z.string()),
  recent: z.array(RecentMemory),
  related: z.array(RecallCandidate),
  // 放不下、没有附上的附加块
  dropped: z.array(z.enum(['recent', 'related'])),
})
export type BootPreview = z.infer<typeof BootPreview>

// 召回事件的来路：会话开始的项目召回、每轮输入的召回、MCP 搜索、REST 召回。管理界面里的搜索与调试不记
export const RECALL_SOURCES = [
  'session.start',
  'prompt.submit',
  'mcp.search',
  'rest.recall',
] as const
export const RecallSource = z.enum(RECALL_SOURCES)
export type RecallSource = z.infer<typeof RecallSource>

// 一条记忆被召回的次数：recent 是保留期内的明细里的次数，total 再加上清理时并入的累计
export const MemoryRecallStat = z.object({
  recent: z.number().int(),
  total: z.number().int(),
  // 最后一次被召回的时间；从没被召回时为 null
  lastRecalledAt: z.string().nullable(),
})
export type MemoryRecallStat = z.infer<typeof MemoryRecallStat>

export const RecalledMemory = MemoryRecallStat.extend({
  id: z.uuid(),
  uri: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
})
export type RecalledMemory = z.infer<typeof RecalledMemory>

export const NeverRecalledMemory = z.object({
  id: z.uuid(),
  uri: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  createdAt: z.string(),
})
export type NeverRecalledMemory = z.infer<typeof NeverRecalledMemory>

// 一个应用在保留期内的召回次数，按来路分；应用已经删掉时 name 为 null
export const AppRecallVolume = z.object({
  appId: z.uuid(),
  name: z.string().nullable(),
  total: z.number().int(),
  sources: z.array(z.object({ source: RecallSource, count: z.number().int() })),
})
export type AppRecallVolume = z.infer<typeof AppRecallVolume>

// 召回分析：记忆按查看者在管理界面里看得到的算，累计次数跟着记忆的可见性走；
// 各应用的调用量只列查看者能管 Key 的应用（应用主人与空间 owner）
export const RecallStats = z.object({
  retentionDays: z.number().int(),
  // 开始记录召回事件的时间；之前的记忆没机会被记下召回，记录满保留天数之后才算「从没被召回」
  recordingSince: z.string(),
  apps: z.array(AppRecallVolume),
  // 被召回次数最多的
  top: z.array(RecalledMemory),
  // 从没被召回的，最早建的在前；neverTotal 是总数。不算 secret（不进召回）、会进启动上下文的节点
  // （每次会话开始都注入），以及建了或开始记录都还不到保留天数的
  never: z.array(NeverRecalledMemory),
  neverTotal: z.number().int(),
})
export type RecallStats = z.infer<typeof RecallStats>

// 召回事件的明细只给事件发生时的应用主人看
export const RecallEventView = z.object({
  id: z.number().int(),
  appId: z.uuid(),
  appName: z.string().nullable(),
  keyName: z.string().nullable(),
  source: RecallSource,
  // 打过码的提示语前 200 字；应用关掉了记录提示语时为 null
  query: z.string().nullable(),
  createdAt: z.string(),
  // 命中的记忆；现在看不到了的（例如被移进别的成员的私人层）uri 为 null
  hits: z.array(
    z.object({
      uri: z.string().nullable(),
      rank: z.number().int(),
      score: z.number(),
      via: z.array(RecallVia),
    }),
  ),
})
export type RecallEventView = z.infer<typeof RecallEventView>

export const RecallEventQuery = z.object({
  appId: z.uuid().optional(),
  // 上一页最后一条的 id
  cursor: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
})
export type RecallEventQuery = z.infer<typeof RecallEventQuery>

export const RecallEventList = z.object({
  items: z.array(RecallEventView),
  // 为 null 表示已经是最后一页
  nextCursor: z.string().nullable(),
})
export type RecallEventList = z.infer<typeof RecallEventList>
