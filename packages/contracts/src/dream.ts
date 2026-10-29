import { z } from 'zod'

import { MemoryUri } from './memories'
import { Layer, PlainLayer, Provenance, Sensitivity, SubjectKind } from './memory'
import { OriginScope } from './subjects'

// Dream：后台按空间整理记忆，只提建议。建议进待审，成员确认后才按建议执行，Dream 自己不写记忆。
// 四种建议：合并（几条变一条）、提炼（几条抽取的事实变一个策展节点的草稿）、过时（这条可能已经不对了）、
// 审核（不可信的内容建议确认或删除）

export const DREAM_SUGGESTION_KINDS = ['merge', 'distill', 'stale', 'review'] as const
export const DreamSuggestionKind = z.enum(DREAM_SUGGESTION_KINDS)
export type DreamSuggestionKind = z.infer<typeof DreamSuggestionKind>

// 审核建议：确认（来源改成确认的成员）还是删除
export const DREAM_VERDICTS = ['confirm', 'delete'] as const
export const DreamVerdict = z.enum(DREAM_VERDICTS)
export type DreamVerdict = z.infer<typeof DreamVerdict>

// 整理的范围：一次模型调用、一条建议里只有同一个范围的记忆。共享的层按层分开（全局、各人格、各应用），
// 每个成员的画像层与私人层各自一个范围（只有本人看得到），对象层与情节层按来源作用域分（同一个群、同一个人的私聊）
export const DREAM_SCOPE_KINDS = ['base', 'persona', 'app', 'owner', 'private', 'talk'] as const
export const DreamScope = z.object({
  kind: z.enum(DREAM_SCOPE_KINDS),
  // 人格与应用：id 与现在的名字（删掉了的名字为 null）；别的范围为 null
  id: z.uuid().nullable(),
  name: z.string().nullable(),
  // 对象与情节：这些内容是在哪里的对话里记下的
  origin: OriginScope.nullable(),
})
export type DreamScope = z.infer<typeof DreamScope>

// 建议涉及的一条记忆，是现在的样子：生成建议之后改过的建议不再列出，所以和建议生成时看到的是同一版
export const DreamSuggestionMemory = z.object({
  id: z.uuid(),
  // 策展记忆的 URI；抽取的事实与会话摘要没有
  uri: z.string().nullable(),
  layer: Layer,
  sensitivity: Sensitivity,
  provenance: Provenance,
  content: z.string(),
  // 对象层的事实挂在哪个对象上
  subject: z.object({ id: z.uuid(), kind: SubjectKind, displayName: z.string() }).nullable(),
  updatedAt: z.iso.datetime(),
})
export type DreamSuggestionMemory = z.infer<typeof DreamSuggestionMemory>

export const DreamSuggestion = z.object({
  id: z.uuid(),
  kind: DreamSuggestionKind,
  scope: DreamScope,
  // 模型给的理由
  reason: z.string(),
  memories: z.array(DreamSuggestionMemory),
  // 合并：保留哪一条（URI 与层不变，其余几条删掉）
  keepId: z.uuid().nullable(),
  // 合并后的正文；提炼的草稿正文
  content: z.string().nullable(),
  // 提炼：草稿的 URI 与 disclosure；层不填时是执行的成员自己的私人层
  uri: z.string().nullable(),
  disclosure: z.string().nullable(),
  // 审核：建议确认还是删除
  verdict: DreamVerdict.nullable(),
  // 查看者能不能执行、拒绝：viewer，或者写不了其中某条记忆时不能
  actionable: z.boolean(),
  createdAt: z.iso.datetime(),
})
export type DreamSuggestion = z.infer<typeof DreamSuggestion>

// cursor 是上一页返回的 nextCursor
export const DreamSuggestionQuery = z.object({
  cursor: z.string().max(200).optional(),
})
export type DreamSuggestionQuery = z.infer<typeof DreamSuggestionQuery>

export const DreamSuggestionList = z.object({
  items: z.array(DreamSuggestion),
  // 待处理的建议条数，只在第一页（不带 cursor）给
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
})
export type DreamSuggestionList = z.infer<typeof DreamSuggestionList>

// 执行时可以先改：合并只能改正文；提炼能改草稿的 URI、层、正文与 disclosure。
// persona:// 与 app:// 下的层由 URI 决定，不用给层
export const ApplyDreamSuggestion = z.object({
  content: z.string().trim().min(1).max(20_000).optional(),
  uri: MemoryUri.optional(),
  layer: PlainLayer.optional(),
  disclosure: z.string().trim().max(500).nullable().optional(),
})
export type ApplyDreamSuggestion = z.infer<typeof ApplyDreamSuggestion>

// 执行的结果：提炼时新建的策展记忆，别的种类为 null
export const DreamApplied = z.object({
  memory: z.object({ id: z.uuid(), uri: z.string() }).nullable(),
})
export type DreamApplied = z.infer<typeof DreamApplied>

// 一次整理怎么开始的：每天一次的，或者成员点了「现在整理一次」
export const DREAM_TRIGGERS = ['scheduled', 'manual'] as const
export const DreamTrigger = z.enum(DREAM_TRIGGERS)
export type DreamTrigger = z.infer<typeof DreamTrigger>

// 没整理的原因：没配抽取模型、本月的抽取预算用完了、上次以来没有新增或改动的内容；
// opted-out：请求模型期间这一组的主人关掉了 Dream 整理画像层与私人层，这一次的结果没有存（只有本人看得到）
export const DREAM_SKIP_REASONS = ['no-model', 'budget', 'idle', 'opted-out'] as const
export const DreamSkipReason = z.enum(DREAM_SKIP_REASONS)
export type DreamSkipReason = z.infer<typeof DreamSkipReason>

// 一次整理里的一项：整理了一个范围（预算用完、主人关掉了时带上没整理的原因），
// 或者整次没走到范围（scope 为 null，带上没整理的原因）
export const DreamRunEntry = z.object({
  scope: DreamScope.nullable(),
  model: z.string().nullable(),
  tokens: z.number().int(),
  // 给模型看的记忆：上次以来新增或改动的，以及它们的近邻
  changed: z.number().int(),
  considered: z.number().int(),
  // 新提的建议；和已有的建议（包括拒绝过的）一样的；不合规则丢掉的
  suggested: z.number().int(),
  known: z.number().int(),
  dropped: z.number().int(),
  // 这个范围还有没看完的，下次接着整理
  more: z.boolean(),
  skipped: DreamSkipReason.nullable(),
  // 出错的原因。模型接口或数据库报的原文只给实例管理员看，别人看到的是一句概括
  error: z.string().nullable(),
})
export type DreamRunEntry = z.infer<typeof DreamRunEntry>

export const DreamRunInfo = z.object({
  runId: z.uuid(),
  trigger: DreamTrigger,
  at: z.iso.datetime(),
  // 只列查看者看得到的范围：别的成员的画像层与私人层不列
  entries: z.array(DreamRunEntry),
})
export type DreamRunInfo = z.infer<typeof DreamRunInfo>

export const DreamRunList = z.object({ runs: z.array(DreamRunInfo) })
export type DreamRunList = z.infer<typeof DreamRunList>

// 成员自己在一个空间里的 Dream 设置，只有本人能看、能改。includePrivate：让不让 Dream 整理自己的画像层与私人层
// （secret 本来就不读），默认整理。开着时这两层会发给实例配置的抽取模型；关掉之后只整理共享的内容，
// 已经生成的建议留着，再打开时接着整理关掉期间新增与改动的
export const DreamMemberSettings = z.object({ includePrivate: z.boolean() })
export type DreamMemberSettings = z.infer<typeof DreamMemberSettings>

// 「现在整理一次」排进后台任务后的编号：管理界面按它查这一次做得怎么样。
// 这个空间已经有一次排着的整理时，给的是那一次的编号
export const DreamQueued = z.object({ runId: z.uuid() })
export type DreamQueued = z.infer<typeof DreamQueued>

// 一次整理的状态：排着、正在整理、做完了。做完了的结果：整理过了、没整理（原因见 reason）、出错了。
// 结果和运行记录一样按查看者看得到的那部分算：别的成员的画像层与私人层整理了没有、出没出错都不影响
export const DreamRunStatus = z.object({
  state: z.enum(['queued', 'running', 'finished']),
  outcome: z.enum(['done', 'skipped', 'failed']).nullable(),
  reason: DreamSkipReason.nullable(),
})
export type DreamRunStatus = z.infer<typeof DreamRunStatus>
