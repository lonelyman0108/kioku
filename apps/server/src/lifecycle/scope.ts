import type {
  BootResponse,
  Layer,
  RecallSource,
  RecentMemory,
  SubjectFacts,
} from '@kioku/contracts'

import type { RecordableCandidate } from '../recall/recall'

// 召回与 boot 的执行范围：权限、空间与人格链都已绑定。
// REST、MCP 与生命周期端点都只通过它调用，召回流程只有这一份
export interface ScopeRecallOptions {
  limit: number
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
  // 候选在 Symbol 键上带着记忆 id（记召回事件要用），序列化时不会带出去
  recall(query: string, options: ScopeRecallOptions): Promise<RecordableCandidate[]>
  // budget 是正文字数预算，不传时用默认值
  boot(budget?: number): Promise<BootResponse>
  recent(limit: number): Promise<RecentMemory[]>
  // 对象直连：当前发言人与本群的事实；不带会话上下文时没有
  subjects(): Promise<SubjectFacts[]>
  // 记一条召回事件，不等它写完。只有接入方真的拿到召回结果的地方调用，管理界面的预览与调试不调用
  record(source: RecallSource, query: string, hits: readonly RecordableCandidate[]): void
}
