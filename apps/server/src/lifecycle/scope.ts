import type {
  Layer,
  RecallSource,
  RecentMemory,
  SessionSummary,
  SubjectFacts,
} from '@kioku/contracts'

import type { BootResult } from '../recall/boot'
import type { RecordableCandidate } from '../recall/recall'
import type { EffectiveSettings } from '../settings/advanced'

// 召回与 boot 的执行范围：权限、空间与人格链都已绑定。
// REST、MCP 与生命周期端点都只通过它调用，召回流程只有这一份
export interface ScopeRecallOptions {
  // 不给时用设置里每轮召回的条数
  limit?: number
  // 不给时用设置里的最低分
  minScore?: number
  // false 时不请求嵌入接口，只走全文与关键词：用在不能等外部接口的地方，例如会话开始
  semantic?: boolean
  // 只收受信来源：用在不需要用户提到就会自动注入的地方
  trustedOnly?: boolean
  // 只收这些层
  layers?: Layer[]
  // 等嵌入接口最多这么久（毫秒），超时就只走全文与关键词：用在宿主钩子有时限的地方
  semanticTimeoutMs?: number
}

export interface RecallScope {
  // 这个应用生效的高级设置（实例、空间、应用三级）。同一个 scope 只读一次，之后用读到的那一份：
  // scope 按请求建，一次请求里的各处看到的是同一份设置。召回、启动加载与对象直连在各自的事务里顺带读，
  // 在它们之后调用不再多开事务
  settings(): Promise<EffectiveSettings>
  // 候选在 Symbol 键上带着记忆 id（记召回事件要用），序列化时不会带出去
  recall(query: string, options: ScopeRecallOptions): Promise<RecordableCandidate[]>
  // budget 是正文字数预算，不传时用设置里的字数预算；给函数时按读到的设置算（会话开始要先减去指引的长度）。没展开的节点的标题在 Symbol 键上，序列化时不会带出去
  boot(budget?: number | ((settings: EffectiveSettings) => number)): Promise<BootResult>
  recent(limit: number): Promise<RecentMemory[]>
  // 同一会话最近的会话摘要（新的在前）：只有不带会话上下文的会话有，群聊、私聊的摘要来自未确认来源，不进会话开始
  summaries(limit: number): Promise<SessionSummary[]>
  // 对象直连：当前发言人与本群的事实，每个对象的条数按设置；不带会话上下文时没有。只是附加的线索，读取失败时返回空、不抛错
  subjects(): Promise<SubjectFacts[]>
  // 召回候选的正文（记忆 id → 正文），读权限和召回相同；给读不了正文的宿主直接带上
  contents(ids: readonly string[]): Promise<Map<string, string>>
  // 记一条召回事件，不等它写完。只有接入方真的拿到召回结果的地方调用，管理界面的预览与调试不调用
  record(source: RecallSource, query: string, hits: readonly RecordableCandidate[]): void
}
