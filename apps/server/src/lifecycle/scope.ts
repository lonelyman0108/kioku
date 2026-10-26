import type { BootResponse, Layer, RecallCandidate, RecentMemory } from '@kioku/contracts'

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
  recall(query: string, options: ScopeRecallOptions): Promise<RecallCandidate[]>
  // budget 是正文字数预算，不传时用默认值
  boot(budget?: number): Promise<BootResponse>
  recent(limit: number): Promise<RecentMemory[]>
}
